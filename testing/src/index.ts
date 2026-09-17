/**
 * Native test-report parsers — shared across every pipeline in the organisation.
 *
 * ── THE RULE THIS MODULE EXISTS TO ENFORCE ──────────────────────────────────
 * Metrics come from the runner's OWN machine-readable reporter, never scraped
 * from the human-readable console output. A console format is presentation: it
 * changes with a runner upgrade, with `--verbose`, with terminal width, and it
 * changes without a version bump. A regex over it does not fail when it breaks —
 * it returns zero, and a card that says "0 tests" reads exactly like a card for a
 * lane that has no tests. That is the one kind of green this pipeline cannot tell
 * from success (contract §4.7: the floors are part of the gate, not a statistic).
 *
 * So: `flutter test --machine` (NDJSON, one event per line) and
 * `vitest run --reporter=json` (a Jest-shaped object). Both are documented
 * protocols with stable field names. The same holds for the report-only inputs
 * added with `TestReport`: JUnit XML, Stryker's `mutation.json`, lcov and
 * istanbul's `coverage-summary.json` are all machine formats with a schema.
 *
 * ── TWO SHAPES, SIDE BY SIDE ────────────────────────────────────────────────
 * `TestMetrics` is the original wire contract with `slack` and does not move.
 * `TestReport` (`wildbit.test-report/v1`) is the richer org-wide standard —
 * durations, suites, slowest, flaky, scenarios, features, coverage, mutation,
 * perf — and travels ALONGSIDE it. `toMetrics` turns one into the other, so a
 * caller pinned to an older `slack` keeps working.
 *
 * ── WHERE THIS CODE COMES FROM ──────────────────────────────────────────────
 * Ported verbatim in behaviour from `pacha/app` (`parseFlutterMachine`,
 * `parseFlutterFailures`, `firstFrameIn`) and from `pacha-api` + `pacha-site`
 * (`parseVitestJson`, byte-identical in both). Every measured behaviour those
 * carried is preserved and the measurement is recorded next to it; a couple of
 * them look like bugs until you read why, and deleting one costs a red run or,
 * worse, a green one.
 *
 * ── COMPLEX VALUES TRAVEL AS JSON STRINGS ───────────────────────────────────
 * Dagger's TypeScript SDK exposes structural types poorly across a module
 * boundary, and a shape mismatch there fails at call time with an unreadable
 * error. Everything non-scalar crosses as a JSON string. The consumer does
 * `JSON.parse` and hands the same string straight to `slack.render` and
 * `slack.breakdown`.
 */
import { Directory, File, object, func } from "@dagger.io/dagger"

/**
 * Test totals, from each runner's NATIVE reporter.
 *
 * ⚠️ THIS SHAPE IS A WIRE CONTRACT, NOT AN INTERNAL TYPE. `slack.render` and
 * `slack.breakdown` declare the same six fields and parse this JSON on the way
 * in; `render` also copies `total`/`passed`/`failed` into the Slack message
 * metadata, which is the trend store the NEXT run reads. A field renamed here is
 * a field that arrives `undefined` there, renders as `0`, and poisons the trend
 * of every following run — with no error anywhere. Add fields alongside (see
 * `FlutterReport`), never inside.
 *
 * `total = passed + failed`, deliberately EXCLUDING `skipped`. Both runners
 * count skips in their own totals (vitest 3 reported `numTotalTests: 7` for the
 * probe where this module reports 5) and both parsers have always excluded them,
 * because the card's "🧪 passed/total" is meant to read as "of the tests that
 * ran". Changing it would silently move every historical trend comparison.
 */
type TestMetrics = {
  total: number; passed: number; failed: number; skipped: number; suites: number
  perFile: { file: string; pass: number; fail: number }[]; failedNames: string[]
}

/**
 * One red Flutter test, with the WHY that `TestMetrics` throws away.
 *
 * `TestMetrics.failedNames` says which test went red; that is all the card needs.
 * But `flutter test --machine` also emits `type:"error"` events carrying `error`
 * and `stackTrace`, and before this was parsed the thread said WHAT failed and
 * nothing about what happened — whoever read it had to re-run the suite locally
 * to see a message the runner had already printed.
 *
 * ── WHY `declLine` AND `failLine` ARE TWO FIELDS ────────────────────────────
 * MEASURED, not read in a doc. `test.line` on the `testStart` event is the line
 * of the `test(` DECLARATION, not of the assertion that blew up. Re-measured for
 * this module on 2026-09-05 (Flutter 3.47.1) against a probe whose failing test
 * is declared on line 7 and fails on line 9: the event reports 7, the stack
 * reports 9. Collapsing the two sends the reader to the line that says
 * `test('compares two strings', () {` — which is never where the bug is.
 *
 * `failLine` is therefore dug out of the stack and kept separate. It can be
 * `null` (no `error` event, or no frame inside the suite); the consumer falls
 * back to `declLine` and must LABEL it as the declaration line when it does. The
 * fallback silently pretending to be the failure line is the same lie as having
 * one field.
 */
type UnitFailure = {
  name: string; file: string
  declLine: number | null; failLine: number | null; failCol: number | null
  kind: "failure" | "error"; message: string
}

/**
 * What `flutterMachine` returns: the wire-contract metrics plus the failure
 * detail, as ONE object.
 *
 * ── WHY `failures` RIDES ALONGSIDE AND NOT INSIDE `TestMetrics` ─────────────
 * In `pacha/app` this key was smuggled in with a spread (`{...m, failures}`) and
 * an apologetic comment, for a reason that NO LONGER EXISTS: `TestMetrics` lived
 * inside a byte-identical vendored block mirrored into `pacha-api` and
 * `pacha-site` and guarded by an md5, so adding one field there meant editing two
 * other repos for a datum only one of them used. This module deletes that
 * constraint — the type is declared once, here.
 *
 * It still stays OUTSIDE `TestMetrics`, and now for the honest reason: that type
 * is the wire contract with `slack` (see above), consumed by four pipelines whose
 * pinned `slack` version does not move in lockstep with this one. Extra keys are
 * ignored by `slack`'s `JSON.parse(...) as TestMetrics`, so the composition is
 * safe in the direction that matters.
 *
 * The difference from the old arrangement is that this is now DECLARED and
 * always present — `failures: []` on a green run — instead of an optional key a
 * consumer had to know about from a comment.
 */
type FlutterReport = TestMetrics & { failures: UnitFailure[] }

/** A fresh, zeroed metrics object. Never share one: the parsers mutate it. */
function empty(): TestMetrics {
  return { total: 0, passed: 0, failed: 0, skipped: 0, suites: 0, perFile: [], failedNames: [] }
}

/**
 * Fold the suite's REAL exit code into the metrics.
 *
 * ── WHY THE EXIT CODE ARRIVES SEPARATELY AT ALL ─────────────────────────────
 * Every consumer wraps its runner to exit 0 unconditionally and persists the real
 * status next to the report:
 *
 *   set +e; flutter test --machine > /tmp/report.json; echo $? > /tmp/exit; set -e
 *
 * Without the wrapper, Dagger aborts the exec the moment the suite goes red and
 * the report file is never read back — so a failing run produced a breakdown with
 * NO failing tests in it, which is precisely when somebody needs one. With it,
 * the detail is always available and the GATE reads the real exit, never the
 * parse.
 *
 * ── WHY NON-ZERO WITH ZERO FAILURES FOLDS TO ONE ────────────────────────────
 * A compile error, a crash in `main()`, an OOM: the process dies before emitting
 * a single test event, so there is nothing to parse and the metrics come back a
 * perfect, plausible zero. Reporting that as "0 failed" would turn a build that
 * never ran into a green card. It folds to `failed = 1` — one synthetic red
 * standing for "the suite did not survive", and `total` is recomputed so the
 * card's ratio stays arithmetic.
 *
 * The comparison is against the STRING "0" on purpose: the value is `cat` of a
 * file, and an ABSENT or empty file (the wrapper itself died) must count as
 * non-zero. A numeric parameter would turn that case into `0` and fail OPEN.
 */
function foldExit(m: TestMetrics, exitCode: string): TestMetrics {
  if (exitCode.trim() !== "0" && m.failed === 0) {
    m.failed = 1
    m.total = m.passed + m.failed
  }
  return m
}

/**
 * Parser for `flutter test --machine` — the package:test JSON reporter protocol,
 * one JSON object per line.
 *
 * Events read: `suite` (id → path), `testStart` (id → name, suiteID),
 * `testDone` (result, skipped). Everything else — `start`, `group`, `allSuites`,
 * `print`, `done` — is ignored, and unparseable lines are skipped rather than
 * fatal: the stream is line-oriented and a truncated last line on a killed run
 * must not throw away the 4000 events before it.
 *
 * `skipped` is checked BEFORE `result`: a skipped test reports
 * `result: "success"`, so reading `result` first would count every skip as a
 * pass.
 *
 * Tests whose name starts with `loading ` are the loader's synthetic per-suite
 * tests. They are dropped at `testStart`, which is also why `testDone` bails when
 * the id is unknown — otherwise every suite would contribute one phantom pass.
 */
function parseFlutterMachine(ndjson: string): TestMetrics {
  const m = empty()
  const tests = new Map<number, { name: string; suite: number }>()
  const suites = new Map<number, string>()
  const agg = new Map<string, { pass: number; fail: number }>()
  for (const line of ndjson.split("\n")) {
    const s = line.trim()
    if (!s || s[0] !== "{") continue
    let ev: Record<string, any>
    try { ev = JSON.parse(s) } catch { continue }
    if (ev.type === "suite" && ev.suite) suites.set(ev.suite.id, ev.suite.path || "?")
    else if (ev.type === "testStart" && ev.test) {
      const n: string = ev.test.name || ""
      if (n.startsWith("loading ")) continue // loader's synthetic test
      tests.set(ev.test.id, { name: n, suite: ev.test.suiteID })
    } else if (ev.type === "testDone") {
      const t = tests.get(ev.testID)
      if (!t) continue // testDone of the synthetic loader test
      const file = suites.get(t.suite) || "?"
      const a = agg.get(file) || { pass: 0, fail: 0 }
      if (ev.skipped) m.skipped++
      else if (ev.result === "success") { m.passed++; a.pass++ }
      else { m.failed++; a.fail++; m.failedNames.push(t.name) }
      agg.set(file, a)
    }
  }
  m.total = m.passed + m.failed
  m.suites = suites.size
  m.perFile = [...agg.entries()].map(([file, v]) => ({ file: file.replace(/^.*\/test\//, "test/"), pass: v.pass, fail: v.fail }))
  return m
}

/**
 * The failure detail `parseFlutterMachine` throws away.
 *
 * A test can emit several `error` events; the FIRST wins. The one that broke the
 * execution is the first, and the ones after it are usually teardown noise
 * complaining about the state the first error left behind.
 *
 * `testDone` with `skipped` is excluded before `result` is even consulted — see
 * the note in `parseFlutterMachine`: a skip reports `result: "success"` anyway,
 * but being explicit here keeps the two parsers reading the same way.
 */
function parseFlutterFailures(ndjson: string): UnitFailure[] {
  const suites = new Map<number, string>()
  const tests = new Map<number, { name: string; suite: number; line: number | null; col: number | null }>()
  const errs = new Map<number, { error: string; stack: string }>()
  const dones = new Map<number, string>()
  for (const line of ndjson.split("\n")) {
    const s = line.trim()
    if (!s || s[0] !== "{") continue
    let ev: Record<string, any>
    try { ev = JSON.parse(s) } catch { continue }
    if (ev.type === "suite" && ev.suite) suites.set(ev.suite.id, ev.suite.path || "?")
    else if (ev.type === "testStart" && ev.test) {
      const n: string = ev.test.name || ""
      if (n.startsWith("loading ")) continue // loader's synthetic test
      tests.set(ev.test.id, { name: n, suite: ev.test.suiteID, line: ev.test.line ?? null, col: ev.test.column ?? null })
    } else if (ev.type === "error" && ev.testID !== undefined) {
      // FIRST wins — see the note above.
      if (!errs.has(ev.testID)) errs.set(ev.testID, { error: String(ev.error ?? ""), stack: String(ev.stackTrace ?? "") })
    } else if (ev.type === "testDone" && !ev.skipped && ev.result !== "success") {
      dones.set(ev.testID, String(ev.result))
    }
  }
  const out: UnitFailure[] = []
  for (const [id, result] of dones) {
    const t = tests.get(id); if (!t) continue
    const abs = suites.get(t.suite) || "?"
    const e = errs.get(id)
    const at = e ? firstFrameIn(e.stack, abs) : null
    out.push({
      name: t.name, file: abs.replace(/^.*\/test\//, "test/"),
      declLine: t.line, failLine: at?.line ?? null, failCol: at?.col ?? null,
      // `error` means an exception escaped the code under test; `failure` means an
      // expectation was not met. They send the reader to different places, so the
      // distinction is carried rather than flattened to "red".
      kind: result === "error" ? "error" : "failure", message: (e?.error ?? "").trim(),
    })
  }
  return out
}

/**
 * The first stack frame that belongs to the SUITE — where `failLine` comes from.
 *
 * The first frame of the stack is almost never the useful one. For any failed
 * `expect` it is `package:matcher expect`, which carries no line at all; the
 * frame that names a line in the test file is further down. So the frame is
 * SEARCHED for, not read off the top.
 *
 * ── WHY THE COMPARISON CANNOT BE `===` ──────────────────────────────────────
 * MEASURED. The suite path and the frame path do not arrive in the same form.
 * Measured originally on 2026-09-04 with `dart test` against a probe package:
 *
 *   dart test                            suite='test/x_test.dart'   frame='test/x_test.dart'
 *   dart test test/x_test.dart           suite='test/x_test.dart'   frame='test/x_test.dart'
 *   dart test /abs/…/test/x_test.dart    suite='/abs/…/x_test.dart' frame='test/x_test.dart'
 *
 * The frame is ALWAYS relative to the package; the suite is not. With `===` the
 * third row matches no frame at all and `failLine` comes back `null` for every
 * red test — no error, no warning, just a missing line that reads like "the
 * runner stopped giving stacks".
 *
 * ⚠️ RE-MEASURED 2026-09-05 (Flutter 3.47.1), and the old note filed this as the
 * exotic case. It is not. `flutter test --machine` with NO arguments — exactly
 * how every consumer invokes it — emits ABSOLUTE suite paths and RELATIVE
 * frames:
 *
 *   suite='/tmp/…/flutter-probe/test/alpha_test.dart'   frame='test/alpha_test.dart 9:5'
 *
 * So under `flutter` (unlike `dart`) row three is the DEFAULT and this
 * comparison is load-bearing on every single run, not a guard against a future
 * invocation. Anyone "simplifying" it back to `===` loses every failure line at
 * once.
 *
 * The comparison is by path SUFFIX in both directions: it covers all four
 * combinations, and it cannot match a different file, because being a suffix
 * with the leading "/" means sharing the entire tail of the path.
 */
function firstFrameIn(stack: string, suitePath: string): { line: number; col: number } | null {
  const samePath = (a: string, b: string) =>
    a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
  for (const raw of stack.split("\n")) {
    const m = raw.trim().match(/^(\S+) (\d+):(\d+)\s/)
    if (!m || !samePath(m[1], suitePath)) continue
    return { line: Number(m[2]), col: Number(m[3]) }
  }
  return null
}

/**
 * Parser for `vitest run --reporter=json` — a Jest-shaped object:
 * `{ testResults: [{ name, assertionResults: [{ status, fullName, title }] }] }`.
 *
 * `suites` is the number of FILES, which is what the Jest shape gives; it is not
 * the number of `describe` blocks. The Flutter side counts files too, so the
 * column means the same thing on both cards.
 *
 * Anything that is neither `passed` nor `failed` counts as skipped — `pending`,
 * `skipped` and `todo` all appear in real output (vitest 3 emits `todo` for
 * `it.todo` and `skipped` for `it.skip`) and an allow-list of the two known ones
 * would silently drop whatever status the next vitest adds.
 *
 * ── WHY A MALFORMED REPORT DOES NOT THROW ───────────────────────────────────
 * Deliberate, and carried over verbatim. The consumer reads the report with
 * `.contents().catch(() => "")`, because a runner that dies before writing
 * `--outputFile` leaves no file at all — and that is exactly the crash case
 * `foldExit` exists to catch. Throwing here would replace a reported
 * "1 failed (suite did not survive)" with an unreadable Dagger error at the point
 * where the pipeline is trying to explain itself. The fail-closed guarantee lives
 * in the exit code, which is the only thing that can be trusted when the report
 * is gone.
 */
function parseVitestJson(json: string): TestMetrics {
  const m = empty()
  let r: Record<string, any>
  try { r = JSON.parse(json) } catch { return m }
  const files: any[] = Array.isArray(r.testResults) ? r.testResults : []
  m.suites = files.length
  for (const f of files) {
    const file = String(f.name || f.testFilePath || "?").replace(/^.*\/(test|src)\//, "$1/")
    let pass = 0, fail = 0
    for (const a of (f.assertionResults || [])) {
      if (a.status === "passed") { m.passed++; pass++ }
      else if (a.status === "failed") { m.failed++; fail++; m.failedNames.push(a.fullName || a.title || "?") }
      else m.skipped++ // pending / skipped / todo
    }
    m.perFile.push({ file, pass, fail })
  }
  m.total = m.passed + m.failed
  return m
}

// ════════════════════════════════════════════════════════════════════════════
// TestReport — wildbit.test-report/v1
// ════════════════════════════════════════════════════════════════════════════

const SCHEMA = "wildbit.test-report/v1" as const

/**
 * The org-wide test report. One per lane (unit, e2e, mutation, …), merged across
 * shards and lanes by `merge`.
 *
 * ⚠️ THIS IS A WIRE CONTRACT TOO. `slack.render`/`slack.breakdown` read it, and
 * the report artifacts jobs upload (`test-report-*`) are read back by
 * `runcard.watch` through a DIFFERENT pinned version of this module. Add optional
 * fields; never rename, retype or drop one. A breaking change is `v2` in `schema`.
 *
 * Invariants every builder keeps:
 *   · `totals.passed + totals.failed` is the number of tests that RAN — skips
 *     are excluded, exactly as in `TestMetrics.total` (see the note there).
 *   · a flaky test is counted in `passed` AND in `flaky`: it failed, was retried
 *     within the same run, and passed. Flaky is a property of a pass.
 *   · durations are milliseconds. `totals.durationMs` is the runner's own wall
 *     clock when it reports one, else the sum of the tests.
 *   · `failures` has one entry per red test; a non-zero exit with no red test
 *     adds ONE synthetic entry (`foldReportExit`) so the thread says why.
 */
type TestReport = {
  schema: typeof SCHEMA
  lane: string; runner: string; exitCode: string
  totals: { passed: number; failed: number; skipped: number; flaky: number; durationMs: number }
  /** Per test file. `lane` is set only on a report merged from several lanes. */
  suites: { file: string; pass: number; fail: number; skip: number; durationMs: number; lane?: string }[]
  /** Top 10 by duration, slowest first. */
  slowest: { name: string; file: string; durationMs: number }[]
  failures: UnitFailure[]
  /** The tests behind `totals.flaky`, so the thread can name them. */
  flakyTests?: { name: string; file: string }[]
  /** End-to-end scenarios (a Maestro flow, a Cypress spec). `id` is what `coverage.tsv` rows name. */
  scenarios?: Scenario[]
  /** Filled by `features`, never by a parser. Dropped by `merge` — map after merging. */
  features?: FeatureRow[]
  coverage?: Coverage
  mutation?: Mutation
  perf?: PerfEntry[]
  /** Present only on a merge of DIFFERENT lanes: each lane's own summary. */
  lanes?: LaneSummary[]
  /** Scenario ids that are only a test title (`idSource: "name"`): a rename drops their coverage row. */
  unanchoredScenarios?: string[]
}

/**
 * `idSource` says WHERE the id came from, and it is the difference between a
 * coverage row that survives an edit and one that silently disappears:
 *
 *   · `property` a `<property name="scenarioId">` in the JUnit — declared, stable
 *   · `file`     the flow/spec FILE's basename — stable while the file is not moved
 *   · `pattern`  a declared id inside the test title (`TS-E2E-012 …`) — stable
 *     while the id stays in the title
 *   · `name`     nothing to anchor to, so the id IS the test title: renaming the
 *     title renames the scenario, its `coverage.tsv` row stops matching and the
 *     feature quietly loses its coverage. These are counted in
 *     `unanchoredScenarios` and named on the card's thread and the step summary.
 */
type Scenario = {
  id: string; name: string; tags: string[]; status: "pass" | "fail" | "skip"
  durationMs: number; attempts: number; file?: string; idSource?: "property" | "file" | "pattern" | "name"
}
/**
 * `covered` = at least one unit test or scenario is assigned to the feature.
 * `e2e` says what `coverage.tsv` declares for it: a `flow` row names it, an
 * `uncovered` row does, or nothing does (`undeclared`, which is a problem).
 */
type FeatureRow = { id: string; tests: number; failed: number; scenarios: number; covered: boolean; e2e: "flow" | "uncovered" | "undeclared" }
/**
 * Percentages 0–100, two decimals. `linesFound`/`linesHit` are carried when the
 * source has them, so `merge` can weight instead of averaging percentages.
 */
type Coverage = { lines: number; branches?: number; source: "lcov" | "istanbul-summary"; linesFound?: number; linesHit?: number }
/** Stryker's score: detected (killed + timeout) over valid (detected + survived + noCoverage). */
type Mutation = { score: number; survived: number; noCoverage: number; killed: number; timeout: number }
type PerfEntry = { name: string; value: number; unit: "ms" | "bytes" | "pct"; baseline?: number; budget?: number }
type LaneSummary = { lane: string; runner: string; exitCode: string; totals: TestReport["totals"]; coverage?: Coverage; mutation?: Mutation }

const round2 = (x: number) => Math.round(x * 100) / 100
/** Separates the parts of a composite map key; cannot occur in a path or a test name. */
const SEP = "␟"

function emptyReport(lane: string, runner: string, exitCode = "0"): TestReport {
  return {
    schema: SCHEMA, lane, runner, exitCode,
    totals: { passed: 0, failed: 0, skipped: 0, flaky: 0, durationMs: 0 },
    suites: [], slowest: [], failures: [],
  }
}

function topSlowest(xs: TestReport["slowest"]): TestReport["slowest"] {
  return [...xs].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10)
}

/**
 * `foldExit` for a `TestReport`: same rule, same reason (a suite that died
 * before emitting a test reads as a green zero). It also adds a synthetic
 * failure, because a thread that says "1 failed" and lists nothing is the
 * question without the answer.
 */
function foldReportExit(r: TestReport): TestReport {
  if (r.exitCode.trim() !== "0" && r.totals.failed === 0) {
    r.totals.failed = 1
    r.failures.push({
      name: "(the suite did not survive)", file: "", declLine: null, failLine: null, failCol: null, kind: "error",
      message: `${r.runner} exited ${r.exitCode.trim() || "(no exit code recorded)"} with no failing test in its report — a compile error, a crash or an OOM before the first test`,
    })
  }
  return r
}

/**
 * `flutter test --machine` → TestReport. Same event reading as
 * `parseFlutterMachine`, plus what that one discards.
 *
 * ── DURATIONS ───────────────────────────────────────────────────────────────
 * Every event carries `time`: milliseconds since the runner started. A test's
 * duration is `testDone.time - testStart.time`; the run's is the `done` event's
 * `time`. Loader pseudo-tests (`loading …`) are excluded from both.
 *
 * ── FLAKY, MEASURED ─────────────────────────────────────────────────────────
 * Measured 2026-09-17 (package:test 1.32.0, Dart 3.13.3) with `retry: 2` on a
 * test that fails its first attempt: the runner emits, for the SAME testID, an
 * `error` event, then a `print` with `message: "Retry: <name>"`, then ONE
 * `testDone` with `result: "success"`. There is no second `testStart`. So a
 * test is flaky when its `testDone` is a non-skipped success AND it produced an
 * `error` event or a `Retry:` print. Reading only `testDone` — as
 * `parseFlutterMachine` does — reports it as an ordinary pass.
 */
function flutterToReport(ndjson: string, lane: string, exitCode: string): TestReport {
  const r = emptyReport(lane, "flutter", exitCode)
  const suites = new Map<number, string>()
  const tests = new Map<number, { name: string; suite: number; t0: number }>()
  const troubled = new Set<number>()
  const agg = new Map<string, { pass: number; fail: number; skip: number; durationMs: number }>()
  const slow: TestReport["slowest"] = []
  const flaky: { name: string; file: string }[] = []
  let doneTime = -1
  let lastTime = 0
  for (const line of ndjson.split("\n")) {
    const s = line.trim()
    if (!s || s[0] !== "{") continue
    let ev: Record<string, any>
    try { ev = JSON.parse(s) } catch { continue }
    if (typeof ev.time === "number") lastTime = Math.max(lastTime, ev.time)
    if (ev.type === "suite" && ev.suite) suites.set(ev.suite.id, ev.suite.path || "?")
    else if (ev.type === "testStart" && ev.test) {
      const n: string = ev.test.name || ""
      if (n.startsWith("loading ")) continue // loader's synthetic test
      tests.set(ev.test.id, { name: n, suite: ev.test.suiteID, t0: Number(ev.time) || 0 })
    } else if (ev.type === "error" && ev.testID !== undefined) troubled.add(ev.testID)
    else if (ev.type === "print" && ev.testID !== undefined && String(ev.message ?? "").startsWith("Retry: ")) troubled.add(ev.testID)
    else if (ev.type === "done") doneTime = Number(ev.time) || 0
    else if (ev.type === "testDone") {
      const t = tests.get(ev.testID)
      if (!t) continue // testDone of the synthetic loader test
      const file = (suites.get(t.suite) || "?").replace(/^.*\/test\//, "test/")
      const ms = Math.max(0, (Number(ev.time) || 0) - t.t0)
      const a = agg.get(file) || { pass: 0, fail: 0, skip: 0, durationMs: 0 }
      a.durationMs += ms
      if (ev.skipped) { r.totals.skipped++; a.skip++ }
      else if (ev.result === "success") {
        r.totals.passed++; a.pass++
        if (troubled.has(ev.testID)) { r.totals.flaky++; flaky.push({ name: t.name, file }) }
      } else { r.totals.failed++; a.fail++ }
      if (!ev.skipped) slow.push({ name: t.name, file, durationMs: ms })
      agg.set(file, a)
    }
  }
  r.totals.durationMs = doneTime >= 0 ? doneTime : lastTime
  r.suites = [...agg.entries()].map(([file, v]) => ({ file, ...v }))
  r.slowest = topSlowest(slow)
  r.failures = parseFlutterFailures(ndjson)
  if (flaky.length) r.flakyTests = flaky
  return foldReportExit(r)
}

/**
 * `vitest run --reporter=json` → TestReport. Same counting as `parseVitestJson`
 * (anything not passed/failed is a skip), plus durations and flaky.
 *
 * ── FLAKY, MEASURED ─────────────────────────────────────────────────────────
 * Measured 2026-09-17 (vitest 4.1.11) with `{ retry: 2 }` on a test that fails
 * its first attempt: the assertion comes back `status: "passed"` with the first
 * attempt's error still in `failureMessages`. There is no retry counter in the
 * JSON. So flaky = passed with a non-empty `failureMessages`.
 *
 * Durations: `assertionResults[].duration` per test (absent on skips), and
 * `endTime - startTime` per file. The run's is the latest `endTime` minus the
 * top-level `startTime`.
 *
 * `failLine` is dug out of the first stack frame that names the test's own file
 * (`…/sighting.test.ts:6:95`); `declLine` is `location.line`, which vitest only
 * fills with `includeTaskLocation` — `null` otherwise.
 */
function vitestToReport(json: string, lane: string, exitCode: string): TestReport {
  const r = emptyReport(lane, "vitest", exitCode)
  let j: Record<string, any>
  try { j = JSON.parse(json) } catch { return foldReportExit(r) }
  const files: any[] = Array.isArray(j.testResults) ? j.testResults : []
  const slow: TestReport["slowest"] = []
  const flaky: { name: string; file: string }[] = []
  let lastEnd = 0
  for (const f of files) {
    const abs = String(f.name || f.testFilePath || "?")
    const file = abs.replace(/^.*\/(test|src)\//, "$1/")
    const s = { file, pass: 0, fail: 0, skip: 0, durationMs: 0 }
    const st = Number(f.startTime) || 0
    const en = Number(f.endTime) || 0
    if (st && en >= st) s.durationMs = Math.round(en - st)
    lastEnd = Math.max(lastEnd, en)
    for (const a of (f.assertionResults || [])) {
      const name = String(a.fullName || a.title || "?")
      const ms = Math.round(Number(a.duration) || 0)
      const msgs: string[] = Array.isArray(a.failureMessages) ? a.failureMessages.map(String) : []
      if (a.status === "passed") {
        r.totals.passed++; s.pass++
        if (msgs.length) { r.totals.flaky++; flaky.push({ name, file }) }
        slow.push({ name, file, durationMs: ms })
      } else if (a.status === "failed") {
        r.totals.failed++; s.fail++
        slow.push({ name, file, durationMs: ms })
        const first = msgs[0] ?? ""
        const at = vitestFrame(first, abs)
        r.failures.push({
          name, file, declLine: a.location?.line ?? null, failLine: at?.line ?? null, failCol: at?.col ?? null,
          kind: /^AssertionError\b/.test(first) ? "failure" : "error",
          message: first.split(/\n\s+at /)[0].trim(),
        })
      } else { r.totals.skipped++; s.skip++ }
    }
    r.suites.push(s)
  }
  const t0 = Number(j.startTime) || 0
  r.totals.durationMs = t0 && lastEnd >= t0 ? Math.round(lastEnd - t0) : r.suites.reduce((x, s) => x + s.durationMs, 0)
  r.slowest = topSlowest(slow)
  if (flaky.length) r.flakyTests = flaky
  return foldReportExit(r)
}

/** The `line:col` of the first stack frame inside `abs` (the test file). */
function vitestFrame(stack: string, abs: string): { line: number; col: number } | null {
  const tail = abs.replace(/^.*\/(test|src)\//, "$1/")
  for (const raw of stack.split("\n")) {
    const m = raw.match(/(?:\(|\s|file:\/\/)(\/?[^\s()]+):(\d+):(\d+)\)?\s*$/)
    if (!m) continue
    const p = m[1]
    if (p === abs || p === tail || p.endsWith(`/${tail}`)) return { line: Number(m[2]), col: Number(m[3]) }
  }
  return null
}

// ── JUnit XML ───────────────────────────────────────────────────────────────

const XML_ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }
function xmlDecode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : XML_ENT[e])
}
function xmlAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = xmlDecode(m[3] ?? m[4] ?? "")
  return out
}

/** The value of `<property name="X" value="…"/>` inside a testcase body, or "". */
function propValue(inner: string, name: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = new RegExp(`<property\\b[^>]*\\bname\\s*=\\s*["']${esc}["'][^>]*>`).exec(inner)
  return m ? (xmlAttrs(m[0]).value || "").trim() : ""
}

/**
 * JUnit XML → TestReport. Covers the producers the organisation has:
 *
 *   · Maestro `--format junit`. Shape taken from Maestro v2.10.0's own golden
 *     test (`JUnitTestSuiteReporterTest.kt`), NOT from a device run:
 *     `<testcase id name classname file time status>`, `status` one of
 *     SUCCESS | WARNING | ERROR | CANCELED | STOPPED, a `<failure>` child on
 *     ERROR, and flow tags as `<property name="tags" value="a, b"/>`.
 *   · vitest `--reporter=junit` — measured 2026-09-17 (4.1.11): `classname` is
 *     the file, `<skipped/>` for skip AND todo, `time` in seconds.
 *   · Cypress and anything else: the same elements, read the same way.
 *
 * A regex tokenizer and not an XML library: the module has no dependencies and
 * JUnit is flat. Comments are stripped first so a commented-out `<testcase>`
 * cannot count; CDATA is unwrapped.
 *
 * ── SCENARIO ID: STABLE, OR LOUDLY NOT ──────────────────────────────────────
 * A scenario id is what a `coverage.tsv` row names, so an id that moves when
 * somebody edits a test title deletes that feature's coverage with nothing
 * turning red. Resolution order, most stable first:
 *
 *   1. `<property name="scenarioId" value="…"/>` inside the testcase
 *      (`idProperty` names the property; "" disables this step).
 *   2. the testcase's `file` attribute, basename without extension — but ONLY
 *      when that file holds exactly one testcase. A Maestro flow is one file and
 *      one test; a Cypress spec with twelve tests is not, and collapsing twelve
 *      scenarios into one id would be worse than a fragile id.
 *   3. a declared id inside the test title, matched by `idPattern` — by default
 *      `TS-E2E-012`, `TS-ATS8-020`: capitals and digits ending in a number.
 *   4. the test title itself. FRAGILE, and said so: these ids are listed in
 *      `unanchoredScenarios`, counted on the card's thread and in the step
 *      summary, so a repository sees what a rename would cost before it costs it.
 *
 * Cypress (mocha-junit-reporter) emits no `file` attribute, so a Cypress repo
 * gets stable ids by putting a declared id in each test title, or by configuring
 * the reporter to write `<property name="scenarioId">`.
 *
 * ── RETRIES ─────────────────────────────────────────────────────────────────
 * A testcase that appears more than once is one test with several attempts,
 * read in document order: the LAST attempt decides the status, and a final pass
 * after an earlier failure is flaky. Across separate files `merge` applies the
 * equivalent rule.
 */
function junitToReport(xml: string, lane: string, runner: string, exitCode: string, asScenarios: boolean, idProperty: string, idPattern: string): TestReport {
  const r = emptyReport(lane, runner, exitCode)
  const src = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;"))
  type Case = { key: string; id: string; idSource: NonNullable<Scenario["idSource"]>; name: string; file: string; ms: number; status: "pass" | "fail" | "skip"; tags: string[]; kind: "failure" | "error"; message: string; detail: string }
  let idRe: RegExp | undefined
  if (idPattern.trim()) {
    try {
      idRe = new RegExp(idPattern)
    } catch (e) {
      throw new Error(`testing: 'idPattern' is not a valid regular expression (${(e as Error).message})`)
    }
  }
  const cases: Case[] = []
  const bodies: { attrs: Record<string, string>; body: string }[] = []
  for (const sm of src.matchAll(/<testsuite\b([^>]*?)(\/>|>([\s\S]*?)<\/testsuite>)/g)) bodies.push({ attrs: xmlAttrs(sm[1]), body: sm[3] ?? "" })
  if (!bodies.length) bodies.push({ attrs: {}, body: src }) // a bare list of <testcase>
  // A `file` attribute identifies a scenario only when the file holds ONE test —
  // a Maestro flow, a one-scenario spec. A Cypress spec with twelve tests would
  // otherwise collapse all twelve into one id.
  const perFile = new Map<string, number>()
  for (const { body } of bodies) {
    for (const cm of body.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const f = xmlAttrs(cm[1]).file
      if (f) perFile.set(f, (perFile.get(f) ?? 0) + 1)
    }
  }
  let suiteTime = 0
  for (const { attrs: sa, body } of bodies) {
    suiteTime += Math.round((Number(sa.time) || 0) * 1000)
    for (const cm of body.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const a = xmlAttrs(cm[1])
      const inner = cm[3] ?? ""
      const name = a.name || a.id || "?"
      // `classname` LAST: vitest and Maestro make it the file, but mocha/Cypress
      // make it the test title, and a title as a "file" would put one suite row
      // per test and send the feature mapper looking for a path that is a sentence.
      const file = a.file || sa.file || sa.name || a.classname || "?"
      const fail = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(inner)
      const st = (a.status || "").toUpperCase()
      let status: Case["status"] = "pass"
      if (fail || ["ERROR", "CANCELED", "STOPPED", "FAILURE", "FAILED"].includes(st)) status = "fail"
      else if (/<skipped\b/.test(inner) || st === "SKIPPED") status = "skip"
      const tagProp = /<property\b[^>]*\bname\s*=\s*["']tags["'][^>]*>/.exec(inner)
      const tags = tagProp ? (xmlAttrs(tagProp[0]).value || "").split(",").map((t) => t.trim()).filter(Boolean) : []
      const fa = fail ? xmlAttrs(fail[2]) : {}
      const text = fail ? xmlDecode((fail[4] ?? "").trim()) : ""
      // Id resolution, most stable first. See `Scenario.idSource`.
      const declared = idProperty.trim() ? propValue(inner, idProperty.trim()) : ""
      const byPattern = idRe ? (idRe.exec(name)?.[1] ?? idRe.exec(name)?.[0] ?? "") : ""
      let id = name
      let idSource: Case["idSource"] = "name"
      if (declared) { id = declared; idSource = "property" }
      else if (a.file && perFile.get(a.file) === 1) { id = a.file.replace(/^.*\//, "").replace(/\.[^.]+$/, ""); idSource = "file" }
      else if (byPattern) { id = byPattern; idSource = "pattern" }
      cases.push({
        key: idSource === "name" ? `${file}${SEP}${name}` : id, id, idSource, name, file,
        ms: Math.round((Number(a.time) || 0) * 1000), status, tags,
        kind: fail?.[1] === "error" ? "error" : "failure",
        message: (fa.message || text.split("\n")[0] || (status === "fail" ? `status ${st || "failed"}` : "")).trim(),
        detail: text,
      })
    }
  }
  const byKey = new Map<string, { last: Case; attempts: number; sawFail: boolean }>()
  for (const c of cases) {
    const prev = byKey.get(c.key)
    byKey.set(c.key, { last: c, attempts: (prev?.attempts ?? 0) + 1, sawFail: (prev?.sawFail ?? false) || c.status === "fail" })
  }
  const agg = new Map<string, { pass: number; fail: number; skip: number; durationMs: number }>()
  const slow: TestReport["slowest"] = []
  const flaky: { name: string; file: string }[] = []
  const scenarios: Scenario[] = []
  for (const { last: c, attempts, sawFail } of byKey.values()) {
    const s = agg.get(c.file) || { pass: 0, fail: 0, skip: 0, durationMs: 0 }
    s.durationMs += c.ms
    if (c.status === "pass") {
      r.totals.passed++; s.pass++
      if (sawFail) { r.totals.flaky++; flaky.push({ name: c.name, file: c.file }) }
    } else if (c.status === "fail") {
      r.totals.failed++; s.fail++
      const at = junitFrame(`${c.message}\n${c.detail}`, c.file)
      r.failures.push({ name: c.name, file: c.file, declLine: null, failLine: at?.line ?? null, failCol: at?.col ?? null, kind: c.kind, message: c.message })
    } else { r.totals.skipped++; s.skip++ }
    if (c.status !== "skip") slow.push({ name: c.name, file: c.file, durationMs: c.ms })
    agg.set(c.file, s)
    // `sawFail` with a final pass is only expressible through `attempts` here;
    // `merge` reads "pass with attempts > 1" as flaky, which is the same fact.
    if (asScenarios) scenarios.push({ id: c.id, name: c.name, tags: c.tags, status: c.status, durationMs: c.ms, attempts: c.status === "pass" && !sawFail ? 1 : attempts, file: c.file, idSource: c.idSource })
  }
  r.suites = [...agg.entries()].map(([file, v]) => ({ file, ...v }))
  r.totals.durationMs = suiteTime || r.suites.reduce((x, s) => x + s.durationMs, 0)
  r.slowest = topSlowest(slow)
  if (flaky.length) r.flakyTests = flaky
  if (asScenarios) {
    r.scenarios = scenarios
    const loose = scenarios.filter((x) => x.idSource === "name").map((x) => x.id)
    if (loose.length) r.unanchoredScenarios = loose
  }
  return foldReportExit(r)
}

/**
 * The `line:col` of the first `path:line:col` in a JUnit failure body whose
 * path is the test's own file — vitest writes `❯ test/x.test.ts:6:95`, Cypress
 * a webpack URL. A location in another file (a helper, node_modules) is not the
 * test's line, so it is not taken.
 */
function junitFrame(text: string, file: string): { line: number; col: number } | null {
  for (const m of text.matchAll(/([^\s()'"❯]+):(\d+):(\d+)/g)) {
    const p = m[1].replace(/^file:\/\//, "")
    if (p === file || p.endsWith(`/${file}`) || file.endsWith(`/${p}`)) return { line: Number(m[2]), col: Number(m[3]) }
  }
  return null
}

// ── Mutation and coverage (report-only) ─────────────────────────────────────

/**
 * Stryker `mutation.json` (mutation-testing-report-schema) → TestReport with
 * `mutation` only. The schema carries no score, so it is recomputed with
 * Stryker's definition — detected / valid, detected = Killed + Timeout, valid =
 * detected + Survived + NoCoverage. `CompileError`, `RuntimeError`, `Ignored`
 * and `Pending` are not valid mutants and count nowhere.
 *
 * Throws on a report that is not JSON or has no `files`: nothing here crashes
 * half-way like a unit suite can, so a missing report is a wiring error.
 */
function strykerToReport(json: string, lane: string): TestReport {
  let j: Record<string, any>
  try { j = JSON.parse(json) } catch (e) { throw new Error(`testing: stryker report is not JSON (${(e as Error).message})`) }
  if (!j || typeof j.files !== "object") throw new Error("testing: stryker report has no 'files' — is this a mutation-testing-report-schema mutation.json?")
  const c: Record<string, number> = {}
  for (const f of Object.values<any>(j.files)) for (const m of (f.mutants || [])) c[m.status] = (c[m.status] ?? 0) + 1
  const killed = c.Killed ?? 0, timeout = c.Timeout ?? 0, survived = c.Survived ?? 0, noCoverage = c.NoCoverage ?? 0
  const valid = killed + timeout + survived + noCoverage
  const r = emptyReport(lane, "stryker")
  r.mutation = { score: valid ? round2(((killed + timeout) / valid) * 100) : 0, survived, noCoverage, killed, timeout }
  return r
}

/**
 * lcov → TestReport with `coverage` only.
 *
 * Accepts SEVERAL tracefiles concatenated (`cat shard-*` of each lcov.info), and
 * that is why records are parsed instead of summing `LF`/`LH`: shards cover the
 * same source file from several places, and summing their totals counts a line
 * twice. Records are unioned per `SF` — a line is hit if any shard hit it, a
 * branch likewise. `DA` is authoritative; `LF`/`LH` are used only for a record
 * with no `DA`. `flutter test --coverage` writes no `BRDA`, so Flutter coverage
 * has no `branches` (absent, not 0).
 */
function lcovToReport(text: string, lane: string): TestReport {
  const lines = new Map<string, Map<number, boolean>>()
  const branches = new Map<string, Map<string, boolean>>()
  const fallback = new Map<string, { lf: number; lh: number }>()
  let sf = ""
  for (const raw of text.split("\n")) {
    const l = raw.trim()
    if (l.startsWith("SF:")) { sf = l.slice(3); if (!lines.has(sf)) lines.set(sf, new Map()) }
    else if (l.startsWith("DA:") && sf) {
      const [ln, hits] = l.slice(3).split(",")
      const m = lines.get(sf)!
      m.set(Number(ln), (m.get(Number(ln)) ?? false) || Number(hits) > 0)
    } else if (l.startsWith("BRDA:") && sf) {
      const [ln, block, br, taken] = l.slice(5).split(",")
      const m = branches.get(sf) ?? new Map<string, boolean>()
      const k = `${ln},${block},${br}`
      m.set(k, (m.get(k) ?? false) || (taken !== "-" && Number(taken) > 0))
      branches.set(sf, m)
    } else if ((l.startsWith("LF:") || l.startsWith("LH:")) && sf) {
      const e = fallback.get(sf) ?? { lf: 0, lh: 0 }
      if (l.startsWith("LF:")) e.lf = Math.max(e.lf, Number(l.slice(3)) || 0)
      else e.lh = Math.max(e.lh, Number(l.slice(3)) || 0)
      fallback.set(sf, e)
    }
  }
  if (!lines.size) throw new Error("testing: lcov report has no SF records — empty, or not an lcov tracefile")
  let found = 0, hit = 0, bFound = 0, bHit = 0
  for (const [file, m] of lines) {
    if (m.size) { found += m.size; hit += [...m.values()].filter(Boolean).length }
    else { const e = fallback.get(file); if (e) { found += e.lf; hit += e.lh } }
  }
  for (const m of branches.values()) { bFound += m.size; bHit += [...m.values()].filter(Boolean).length }
  const r = emptyReport(lane, "lcov")
  r.coverage = { lines: found ? round2((hit / found) * 100) : 0, source: "lcov", linesFound: found, linesHit: hit }
  if (bFound) r.coverage.branches = round2((bHit / bFound) * 100)
  return r
}

/** istanbul `coverage-summary.json` (the `json-summary` reporter) → TestReport with `coverage` only. Reads `total`. */
function istanbulToReport(json: string, lane: string): TestReport {
  let j: Record<string, any>
  try { j = JSON.parse(json) } catch (e) { throw new Error(`testing: coverage-summary is not JSON (${(e as Error).message})`) }
  const t = j?.total
  if (!t?.lines) throw new Error("testing: coverage-summary has no 'total.lines' — is this istanbul's json-summary output?")
  const pct = (x: any) => (typeof x?.pct === "number" ? round2(x.pct) : Number(x?.total) > 0 ? round2((Number(x.covered) / Number(x.total)) * 100) : 0)
  const r = emptyReport(lane, "istanbul")
  r.coverage = { lines: pct(t.lines), source: "istanbul-summary", linesFound: Number(t.lines.total) || 0, linesHit: Number(t.lines.covered) || 0 }
  if (Number(t.branches?.total) > 0) r.coverage.branches = pct(t.branches)
  return r
}

// ── Validation, merge, legacy view ──────────────────────────────────────────

/** Parse one report or an array of them, rejecting anything without the schema tag. */
function parseReports(raw: string, what: string): TestReport[] {
  const t = (raw ?? "").trim()
  if (!t) return []
  let v: unknown
  try { v = JSON.parse(t) } catch (e) { throw new Error(`testing: '${what}' is not valid JSON (${(e as Error).message}). It travels as a JSON string.`) }
  const arr = Array.isArray(v) ? v : [v]
  return arr.map((x, i) => {
    const o = x as Partial<TestReport>
    if (!o || o.schema !== SCHEMA) throw new Error(`testing: ${what}[${i}] is not a ${SCHEMA} report (schema: ${JSON.stringify(o?.schema)})`)
    if (!o.totals || !Array.isArray(o.suites)) throw new Error(`testing: ${what}[${i}] (lane '${o.lane}') has no totals/suites`)
    return { ...o, slowest: o.slowest ?? [], failures: o.failures ?? [], exitCode: String(o.exitCode ?? "0") } as TestReport
  })
}

/** A report that only carries coverage/mutation/perf: it has no say in runner or exit code. */
function isAttachment(r: TestReport): boolean {
  const t = r.totals
  return t.passed + t.failed + t.skipped === 0 && r.suites.length === 0 && !(r.scenarios?.length) && r.exitCode.trim() === "0"
}

function mergeCoverage(cs: Coverage[]): Coverage | undefined {
  if (!cs.length) return undefined
  if (cs.length === 1) return cs[0]
  const brs = cs.map((c) => c.branches).filter((b): b is number => typeof b === "number")
  let out: Coverage
  if (cs.every((c) => typeof c.linesFound === "number" && typeof c.linesHit === "number")) {
    const found = cs.reduce((a, c) => a + (c.linesFound ?? 0), 0)
    const hit = cs.reduce((a, c) => a + (c.linesHit ?? 0), 0)
    out = { lines: found ? round2((hit / found) * 100) : 0, source: cs[0].source, linesFound: found, linesHit: hit }
  } else {
    out = { lines: round2(cs.reduce((a, c) => a + c.lines, 0) / cs.length), source: cs[0].source }
  }
  if (brs.length) out.branches = round2(brs.reduce((a, b) => a + b, 0) / brs.length)
  return out
}

function mergeMutation(ms: Mutation[]): Mutation | undefined {
  if (!ms.length) return undefined
  const s = ms.reduce((a, m) => ({ killed: a.killed + m.killed, timeout: a.timeout + (m.timeout ?? 0), survived: a.survived + m.survived, noCoverage: a.noCoverage + m.noCoverage }), { killed: 0, timeout: 0, survived: 0, noCoverage: 0 })
  const valid = s.killed + s.timeout + s.survived + s.noCoverage
  return { score: valid ? round2(((s.killed + s.timeout) / valid) * 100) : 0, ...s }
}

/**
 * Merge reports into one. The rules, each for a reason:
 *
 *   · totals, suites, slowest, failures, flaky, perf, mutation counts: summed or
 *     concatenated. Shards run disjoint files, so nothing is counted twice.
 *   · scenarios with the same `id` are ONE scenario retried: attempts add up,
 *     it passed if any attempt passed (a retry only runs after a failure), and
 *     a pass with more than one attempt is flaky. Totals are recounted from the
 *     folded scenarios, so a flow that failed in one file and passed on its
 *     retry in another counts 1 passed + 1 flaky, not 1 passed + 1 failed, and
 *     its failure entry is dropped.
 *   · coverage: weighted by `linesFound`/`linesHit` when every part has them;
 *     otherwise a plain mean. ⚠️ Shards covering the SAME source files are
 *     over-counted by weighting — feed their concatenated lcov to `lcov`
 *     instead, which unions per line.
 *   · lane: one lane in → that lane. Several → `lane` is `a+b`, `lanes` keeps
 *     each lane's own totals/coverage/mutation, and each suite carries its lane.
 *     The card shows the combined line; the thread and the summary show lanes.
 *   · exitCode: the first non-"0" of any report that ran tests, else "0".
 *     Attachments (coverage/mutation/perf only) never set it or the runner.
 *   · features are DROPPED: they depend on suites and scenarios the merge just
 *     changed. Run `features` on the merged report.
 */
function mergeReports(rs: TestReport[]): TestReport {
  if (!rs.length) throw new Error("testing: merge needs at least one report")
  const laneNames = [...new Set(rs.map((r) => r.lane))]
  const tested = rs.filter((r) => !isAttachment(r))
  const runners = [...new Set((tested.length ? tested : rs).map((r) => r.runner))]
  const flatLanes = [...new Set(rs.flatMap((r) => (r.lanes?.length ? r.lanes.map((l) => l.lane) : [r.lane])))]
  const out = emptyReport(flatLanes.join("+"), runners.join("+"), tested.find((r) => r.exitCode.trim() !== "0")?.exitCode ?? "0")
  // An already-merged report (it has `lanes`) keeps its lanes when merged again.
  const multi = laneNames.length > 1 || rs.some((r) => r.lanes?.length)
  const suites = new Map<string, TestReport["suites"][number]>()
  const scen = new Map<string, Scenario>()
  const scenLane = new Map<string, string>()
  const scenFailures: UnitFailure[] = []
  let flaky: { name: string; file: string }[] = []
  for (const r of rs) {
    const residual = { ...r.totals }
    const own = new Set<string>()
    for (const s of r.scenarios ?? []) {
      own.add(s.name)
      if (s.status === "pass") { residual.passed--; if (s.attempts > 1) residual.flaky-- }
      else if (s.status === "fail") residual.failed--
      else residual.skipped--
      const prev = scen.get(s.id)
      if (!prev) { scen.set(s.id, { ...s, tags: [...s.tags] }); scenLane.set(s.id, r.suites.find((x) => x.file === s.file)?.lane ?? r.lane); continue }
      prev.attempts += s.attempts
      prev.tags = [...new Set([...prev.tags, ...s.tags])]
      if (s.status === "pass") { prev.status = "pass"; prev.durationMs = s.durationMs }
      else if (prev.status !== "pass" && s.status === "fail") prev.status = "fail"
    }
    out.totals.passed += Math.max(0, residual.passed)
    out.totals.failed += Math.max(0, residual.failed)
    out.totals.skipped += Math.max(0, residual.skipped)
    out.totals.flaky += Math.max(0, residual.flaky)
    out.totals.durationMs += r.totals.durationMs
    const scenFiles = new Set((r.scenarios ?? []).map((x) => x.file).filter(Boolean))
    for (const s of r.suites) {
      if (scenFiles.has(s.file)) continue // rebuilt from the folded scenarios below
      const lane = s.lane ?? r.lane
      const key = `${multi ? lane : ""}${SEP}${s.file}`
      const e = suites.get(key)
      if (e) { e.pass += s.pass; e.fail += s.fail; e.skip += s.skip; e.durationMs += s.durationMs }
      else suites.set(key, { file: s.file, pass: s.pass, fail: s.fail, skip: s.skip, durationMs: s.durationMs, ...(multi ? { lane } : {}) })
    }
    out.slowest.push(...r.slowest)
    for (const f of r.failures) (own.has(f.name) ? scenFailures : out.failures).push(f)
    flaky.push(...(r.flakyTests ?? []))
    if (r.perf?.length) out.perf = [...(out.perf ?? []), ...r.perf]
  }
  if (scen.size) {
    out.scenarios = [...scen.values()]
    const loose = out.scenarios.filter((x) => x.idSource === "name").map((x) => x.id)
    if (loose.length) out.unanchoredScenarios = loose
    const passed = new Set<string>()
    for (const s of out.scenarios) {
      if (s.status === "pass") {
        out.totals.passed++; passed.add(s.name)
        if (s.attempts > 1) { out.totals.flaky++; if (!flaky.some((f) => f.name === s.name)) flaky.push({ name: s.name, file: s.file ?? "" }) }
      } else if (s.status === "fail") out.totals.failed++
      else out.totals.skipped++
    }
    // Scenario files' suite rows come from the FOLDED scenarios: summing the
    // attempts would show a flow that passed on retry as 1 pass + 1 fail.
    for (const sc of out.scenarios) {
      if (!sc.file) continue
      const lane = scenLane.get(sc.id) ?? ""
      const key = `${multi ? lane : ""}${SEP}${sc.file}`
      const e = suites.get(key) ?? { file: sc.file, pass: 0, fail: 0, skip: 0, durationMs: 0, ...(multi ? { lane } : {}) }
      if (sc.status === "pass") e.pass++; else if (sc.status === "fail") e.fail++; else e.skip++
      e.durationMs += sc.durationMs
      suites.set(key, e)
    }
    // A scenario failure whose retry passed is not a failure of this run; one
    // entry per scenario that is still red.
    const seen = new Set<string>()
    for (const f of scenFailures) if (!passed.has(f.name) && !seen.has(f.name)) { seen.add(f.name); out.failures.push(f) }
    flaky = flaky.filter((f, i) => flaky.findIndex((g) => g.name === f.name && g.file === f.file) === i)
  }
  out.suites = [...suites.values()]
  out.slowest = topSlowest(out.slowest)
  if (flaky.length) out.flakyTests = flaky
  const cov = mergeCoverage(rs.map((r) => r.coverage).filter((c): c is Coverage => !!c))
  const mut = mergeMutation(rs.map((r) => r.mutation).filter((m): m is Mutation => !!m))
  if (cov) out.coverage = cov
  if (mut) out.mutation = mut
  if (multi) {
    const parts: LaneSummary[] = []
    for (const lane of laneNames) {
      const group = rs.filter((r) => r.lane === lane)
      for (const r of group) if (r.lanes?.length) parts.push(...r.lanes)
      const plain = group.filter((r) => !r.lanes?.length)
      if (!plain.length) continue
      const part = mergeReports(plain)
      const l: LaneSummary = { lane, runner: part.runner, exitCode: part.exitCode, totals: part.totals }
      if (part.coverage) l.coverage = part.coverage
      if (part.mutation) l.mutation = part.mutation
      parts.push(l)
    }
    out.lanes = foldLanes(parts)
  }
  return out
}

/** Lane summaries with the same name folded into one, first-seen order. */
function foldLanes(ls: LaneSummary[]): LaneSummary[] {
  const by = new Map<string, LaneSummary[]>()
  for (const l of ls) by.set(l.lane, [...(by.get(l.lane) ?? []), l])
  return [...by.entries()].map(([lane, g]) => {
    if (g.length === 1) return g[0]
    const t = g.reduce((a, l) => ({ passed: a.passed + l.totals.passed, failed: a.failed + l.totals.failed, skipped: a.skipped + l.totals.skipped, flaky: a.flaky + l.totals.flaky, durationMs: a.durationMs + l.totals.durationMs }), { passed: 0, failed: 0, skipped: 0, flaky: 0, durationMs: 0 })
    const tested = g.filter((l) => l.totals.passed + l.totals.failed + l.totals.skipped > 0)
    const out: LaneSummary = {
      lane, totals: t,
      runner: [...new Set((tested.length ? tested : g).map((l) => l.runner))].join("+"),
      exitCode: g.find((l) => l.exitCode.trim() !== "0")?.exitCode ?? "0",
    }
    const cov = mergeCoverage(g.map((l) => l.coverage).filter((c): c is Coverage => !!c))
    const mut = mergeMutation(g.map((l) => l.mutation).filter((m): m is Mutation => !!m))
    if (cov) out.coverage = cov
    if (mut) out.mutation = mut
    return out
  })
}

/** TestReport → the legacy `TestMetrics` wire shape, for callers pinned to an older `slack`. */
function reportToMetrics(r: TestReport): TestMetrics {
  return {
    total: r.totals.passed + r.totals.failed, passed: r.totals.passed, failed: r.totals.failed, skipped: r.totals.skipped,
    suites: r.suites.length,
    perFile: r.suites.map((s) => ({ file: s.file, pass: s.pass, fail: s.fail })),
    failedNames: r.failures.map((f) => f.name),
  }
}

// ── Features ────────────────────────────────────────────────────────────────

/**
 * What `features` returns. `problems` is the guard's input: one line per class
 * of drift, empty when the mapping is sound. `unassignedTests` is information,
 * not a problem — plenty of tests (core, shared, helpers) belong to no feature.
 */
type FeatureMapResult = {
  report: TestReport; ok: boolean; problems: string[]
  unassignedTests: string[]; unknownFeatures: string[]; unmappedScenarios: string[]; undeclaredFeatures: string[]
}

/**
 * `specs/features/coverage.tsv`, generalised from `pacha/app`'s
 * `test/e2e/coverage.tsv` — a file in that format is valid here unchanged.
 * Tab-separated, `#` comments, an optional `flow` header row:
 *
 *   <scenario id>  TAB  feature,feature | -  TAB  note    an e2e flow → features
 *   UNCOVERED      TAB  feature              TAB  note    no e2e flow, said out loud
 *   path:<prefix>  TAB  feature,feature | -  TAB  note    a unit-test path exception
 *
 * `-` means "not a product feature" (a harness smoke, a shared test directory).
 */
type CoverageMap = { flows: Map<string, string[]>; uncovered: Set<string>; paths: { prefix: string; features: string[] }[]; problems: string[] }

function parseCoverageMap(text: string): CoverageMap {
  const out: CoverageMap = { flows: new Map(), uncovered: new Set(), paths: [], problems: [] }
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "")
    if (!line.trim() || line.trimStart().startsWith("#")) return
    const cols = line.split("\t")
    if (cols.length < 2) { out.problems.push(`coverage map line ${i + 1} is not tab-separated: ${JSON.stringify(line.slice(0, 80))}`); return }
    const left = cols[0].trim(), mid = cols[1].trim()
    const list = mid === "-" ? [] : mid.split(",").map((f) => f.trim()).filter(Boolean)
    if (left === "flow") return
    if (left === "UNCOVERED") { out.uncovered.add(mid); return }
    if (left.startsWith("path:")) { out.paths.push({ prefix: left.slice(5), features: list }); return }
    if (out.flows.has(left)) out.problems.push(`coverage map names flow '${left}' more than once`)
    out.flows.set(left, list)
  })
  out.paths.sort((a, b) => b.prefix.length - a.prefix.length)
  return out
}

/**
 * The features a test file belongs to. A `path:` row wins, longest prefix
 * first; otherwise the convention: the path segment right after a `features`
 * segment, underscores turned into hyphens (`test/features/lost_pet/x_test.dart`
 * → `lost-pet`). `null` = no feature by either rule; `[]` = declared not-a-feature.
 */
function featuresForPath(file: string, map: CoverageMap): string[] | null {
  const row = map.paths.find((p) => file.startsWith(p.prefix))
  if (row) return row.features
  const segs = file.split("/")
  const i = segs.indexOf("features")
  if (i < 0 || i + 1 >= segs.length - 1) return null
  return [segs[i + 1].replace(/_/g, "-")]
}

/**
 * Decision 1 of the test-report standard, as code. Features are the entries of
 * `specs/features/` (directories, and `.md` files for single-page specs — the
 * `pacha/app` precedent). Unit tests are assigned by path (above); scenarios
 * ONLY through a `coverage.tsv` flow row, never by resembling names: flow tag
 * `adopt` and feature `adoption`, tag `like` and feature `likes`, are different
 * strings, and a fuzzy match would claim coverage that does not exist.
 *
 * Problems (each makes `ok` false):
 *   · a spec feature no row names — not a flow row, not UNCOVERED, not `path:`;
 *   · a feature named by a row or by a test path that is not in specs;
 *   · a scenario in the report with no flow row;
 *   · a feature declared covered by a flow AND UNCOVERED.
 */
function mapFeatures(report: TestReport, specFeatures: string[], mapText: string): FeatureMapResult {
  const map = parseCoverageMap(mapText)
  const specs = new Set(specFeatures)
  const rows = new Map<string, FeatureRow>()
  for (const id of [...specs].sort()) rows.set(id, { id, tests: 0, failed: 0, scenarios: 0, covered: false, e2e: "undeclared" })
  const unknown = new Map<string, string>()
  const unassigned: string[] = []
  const scenarioFiles = new Set((report.scenarios ?? []).map((s) => s.file).filter((f): f is string => !!f))
  for (const s of report.suites) {
    if (scenarioFiles.has(s.file)) continue
    const fs = featuresForPath(s.file, map)
    if (fs === null) { unassigned.push(s.file); continue }
    for (const f of fs) {
      const row = rows.get(f)
      if (!row) { if (!unknown.has(f)) unknown.set(f, s.file); continue }
      row.tests += s.pass + s.fail
      row.failed += s.fail
    }
  }
  const unmapped: string[] = []
  for (const sc of report.scenarios ?? []) {
    const fs = map.flows.get(sc.id)
    if (!fs) { unmapped.push(sc.id); continue }
    for (const f of fs) {
      const row = rows.get(f)
      if (!row) continue // reported below, from the map itself
      if (sc.status !== "skip") row.scenarios++
      if (sc.status === "fail") row.failed++
    }
  }
  const declared = new Set<string>()
  const problems = [...map.problems]
  for (const [flow, fs] of map.flows) for (const f of fs) {
    declared.add(f)
    const row = rows.get(f)
    if (row) row.e2e = "flow"
    else if (!unknown.has(f)) unknown.set(f, `flow row ${flow}`)
  }
  for (const f of map.uncovered) {
    declared.add(f)
    const row = rows.get(f)
    if (row?.e2e === "flow") problems.push(`feature '${f}' is declared both covered by a flow and UNCOVERED`)
    else if (row) row.e2e = "uncovered"
    else if (!unknown.has(f)) unknown.set(f, "an UNCOVERED row")
  }
  for (const p of map.paths) for (const f of p.features) {
    declared.add(f)
    if (!specs.has(f) && !unknown.has(f)) unknown.set(f, `the path:${p.prefix} row`)
  }
  for (const row of rows.values()) row.covered = row.tests + row.scenarios > 0
  const undeclared = [...specs].filter((f) => !declared.has(f)).sort()
  const unknownList = [...unknown.entries()].map(([f, from]) => `${f} (from ${from})`).sort()
  if (undeclared.length) problems.push(`features in specs that coverage.tsv says nothing about — declare each against a flow, as UNCOVERED, or on a path: row, because a feature nobody tested must not simply be missing from the report: ${undeclared.join(", ")}`)
  if (unknownList.length) problems.push(`features that are not in specs/features (a rename or a typo attributes coverage to nothing; a test directory named differently needs a path: row): ${unknownList.join(", ")}`)
  if (unmapped.length) problems.push(`scenarios with no flow row in coverage.tsv, so their result is attributed to no feature: ${unmapped.sort().join(", ")}`)
  const { features: _dropped, ...rest } = report
  return {
    report: { ...rest, features: [...rows.values()] },
    ok: problems.length === 0, problems,
    unassignedTests: unassigned.sort(), unknownFeatures: unknownList, unmappedScenarios: unmapped.sort(), undeclaredFeatures: undeclared,
  }
}

// ── Step summary ────────────────────────────────────────────────────────────

const mdCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ")
function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, "0")}s`
}

/**
 * Markdown for `$GITHUB_STEP_SUMMARY`. Coverage, mutation and perf budgets are
 * REPORT-ONLY: printed, never judged, and the wording says "over budget", not
 * "failed", so nobody reads a gate into them.
 */
function reportMarkdown(rs: TestReport[]): string {
  const out: string[] = []
  for (const r of rs) {
    const t = r.totals
    out.push(`### 🧪 Tests — ${mdCell(r.lane)} (${mdCell(r.runner)})`, "")
    out.push(`**${t.passed}/${t.passed + t.failed} passed** · ${t.failed} failed · ${t.skipped} skipped · ${t.flaky} flaky · ${fmtMs(t.durationMs)}${r.exitCode.trim() !== "0" ? ` · exit ${mdCell(r.exitCode.trim() || "?")}` : ""}`, "")
    if (r.lanes?.length) {
      out.push("| Lane | Runner | Passed | Failed | Skipped | Flaky | Time | Coverage | Mutation |", "|---|---|---:|---:|---:|---:|---:|---:|---:|")
      for (const l of r.lanes) out.push(`| ${mdCell(l.lane)} | ${mdCell(l.runner)} | ${l.totals.passed} | ${l.totals.failed} | ${l.totals.skipped} | ${l.totals.flaky} | ${fmtMs(l.totals.durationMs)} | ${l.coverage ? `${l.coverage.lines}%` : "—"} | ${l.mutation ? `${l.mutation.score}%` : "—"} |`)
      out.push("")
    }
    if (r.failures.length) {
      out.push(`<details open><summary>❌ ${r.failures.length} failure(s)</summary>`, "")
      for (const f of r.failures.slice(0, 30)) {
        const where = f.failLine !== null ? `${f.file}:${f.failLine}` : f.declLine !== null ? `${f.file}:${f.declLine} (declaration)` : f.file
        out.push(`- **${mdCell(f.name)}**${where ? ` \`${mdCell(where)}\`` : ""} — ${mdCell(f.message.slice(0, 300))}`)
      }
      if (r.failures.length > 30) out.push(`- …and ${r.failures.length - 30} more`)
      out.push("", "</details>", "")
    }
    if (r.flakyTests?.length) out.push(`**Flaky (passed on retry):** ${r.flakyTests.slice(0, 20).map((f) => `\`${mdCell(f.name)}\``).join(", ")}`, "")
    if (r.slowest.length) {
      out.push("<details><summary>🐢 Slowest 10</summary>", "", "| Test | File | Time |", "|---|---|---:|")
      for (const s of r.slowest) out.push(`| ${mdCell(s.name)} | \`${mdCell(s.file)}\` | ${fmtMs(s.durationMs)} |`)
      out.push("", "</details>", "")
    }
    if (r.suites.length) {
      out.push(`<details><summary>📁 Suites (${r.suites.length})</summary>`, "", "| File | Pass | Fail | Skip | Time |", "|---|---:|---:|---:|---:|")
      for (const s of [...r.suites].sort((a, b) => b.fail - a.fail || b.durationMs - a.durationMs).slice(0, 100)) {
        out.push(`| \`${mdCell((s.lane ? `${s.lane}: ` : "") + s.file)}\` | ${s.pass} | ${s.fail} | ${s.skip} | ${fmtMs(s.durationMs)} |`)
      }
      if (r.suites.length > 100) out.push(`| …${r.suites.length - 100} more | | | | |`)
      out.push("", "</details>", "")
    }
    if (r.scenarios?.length) {
      out.push("<details><summary>🎬 Scenarios</summary>", "", "| Scenario | Id from | Status | Attempts | Time | Tags |", "|---|---|---|---:|---:|---|")
      for (const s of r.scenarios) out.push(`| ${mdCell(s.id)} | ${s.idSource === "name" ? "⚠️ title" : s.idSource ?? "—"} | ${s.status === "pass" ? (s.attempts > 1 ? "✅ flaky" : "✅") : s.status === "fail" ? "❌" : "skipped"} | ${s.attempts} | ${fmtMs(s.durationMs)} | ${mdCell(s.tags.join(", "))} |`)
      out.push("", "</details>", "")
      if (r.unanchoredScenarios?.length) {
        out.push(`⚠️ **${r.unanchoredScenarios.length} scenario id(s) come from the test title only** — renaming the title renames the scenario and its \`coverage.tsv\` row stops matching, so the feature loses its coverage with nothing turning red. Give each a \`<property name="scenarioId">\`, a one-test spec file, or a declared id in the title: ${r.unanchoredScenarios.slice(0, 20).map((x) => `\`${mdCell(x)}\``).join(", ")}${r.unanchoredScenarios.length > 20 ? ` …(+${r.unanchoredScenarios.length - 20})` : ""}`, "")
      }
    }
    if (r.features?.length) {
      const cov = r.features.filter((f) => f.covered).length
      out.push(`**Features:** ${cov}/${r.features.length} with tests`, "", "| Feature | Unit tests | Scenarios | Failed | E2E |", "|---|---:|---:|---:|---|")
      for (const f of r.features) out.push(`| ${f.failed ? "❌ " : ""}${mdCell(f.id)} | ${f.tests} | ${f.scenarios} | ${f.failed} | ${f.e2e === "flow" ? "flow" : f.e2e === "uncovered" ? "UNCOVERED" : "⚠️ undeclared"} |`)
      out.push("")
    }
    const extra: string[] = []
    if (r.coverage) extra.push(`📊 coverage ${r.coverage.lines}% lines${r.coverage.branches !== undefined ? ` · ${r.coverage.branches}% branches` : ""} (${r.coverage.source}, report-only)`)
    if (r.mutation) extra.push(`🧬 mutation score ${r.mutation.score}% — ${r.mutation.killed} killed · ${r.mutation.timeout} timeout · ${r.mutation.survived} survived · ${r.mutation.noCoverage} no coverage (report-only)`)
    if (extra.length) out.push(extra.join("  \n"), "")
    if (r.perf?.length) {
      out.push("| Perf | Value | Baseline | Budget |", "|---|---:|---:|---:|")
      for (const p of r.perf) {
        const over = p.budget !== undefined && p.value > p.budget
        out.push(`| ${over ? "⚠️ " : ""}${mdCell(p.name)} | ${p.value} ${p.unit} | ${p.baseline ?? "—"} | ${p.budget ?? "—"}${over ? " (over budget, report-only)" : ""} |`)
      }
      out.push("")
    }
  }
  return out.join("\n")
}

/** A lane names a report in merges, cards and trends; an empty one would merge into anything. */
function requiredLane(lane: string): string {
  const l = (lane ?? "").trim()
  if (!l) throw new Error("testing: 'lane' is empty — name the run (unit, e2e, mutation…); merge and the card group by it")
  return l
}

@object()
export class Testing {
  /**
   * Parse a `flutter test --machine` report into metrics plus failure detail.
   *
   * Returns the JSON of a `FlutterReport`: the six `TestMetrics` fields that
   * `slack.render` and `slack.breakdown` consume, plus `failures` with the file,
   * line, kind and message of every red test. Extra keys are ignored by `slack`,
   * so the same string goes to both without stripping anything.
   *
   * @param report   the raw NDJSON, one event per line. An unparseable line is
   *                 skipped, not fatal — a truncated tail on a killed run must
   *                 not discard the events before it.
   * @param exitCode the suite's REAL exit status, as the wrapper wrote it
   *                 (`echo $? > /tmp/test-exit`). Anything other than "0" with
   *                 zero parsed failures folds to `failed = 1`: a compile error
   *                 emits no test events and would otherwise report a plausible,
   *                 green zero. Defaults to "0", which parses the report as given
   *                 and applies no fold — pass the real value in a gate.
   */
  @func()
  flutterMachine(report: string, exitCode = "0"): string {
    const m = foldExit(parseFlutterMachine(report), exitCode)
    const out: FlutterReport = { ...m, failures: parseFlutterFailures(report) }
    return JSON.stringify(out)
  }

  /**
   * `flutterMachine`, reading the report from a `File`.
   *
   * Not sugar: `pacha/app` collects 4576 tests and its NDJSON runs to several
   * megabytes. A `File` stays in the engine and is read once here, instead of
   * crossing the module boundary as a multi-megabyte GraphQL string argument that
   * the orchestrator also has to hold in memory.
   *
   * @param report   the report file, e.g. `container.file("/tmp/test-report.json")`
   * @param exitCode see `flutterMachine`
   */
  @func()
  async flutterMachineFile(report: File, exitCode = "0"): Promise<string> {
    return this.flutterMachine(await report.contents(), exitCode)
  }

  /**
   * Parse a `vitest run --reporter=json` report into metrics.
   *
   * Returns the JSON of a `TestMetrics` — exactly the shape `slack.render` and
   * `slack.breakdown` consume.
   *
   * @param report   the raw JSON. An empty or malformed report yields zeroed
   *                 metrics rather than an error, on purpose: a runner that died
   *                 before writing `--outputFile` leaves nothing to parse, and
   *                 `exitCode` is what turns that into a reported failure.
   * @param exitCode the suite's REAL exit status, as the wrapper wrote it
   *                 (`echo $? > /tmp/vitest-exit`). Anything other than "0" with
   *                 zero parsed failures folds to `failed = 1`. Defaults to "0",
   *                 which applies no fold — pass the real value in a gate.
   */
  @func()
  vitestJson(report: string, exitCode = "0"): string {
    return JSON.stringify(foldExit(parseVitestJson(report), exitCode))
  }

  /**
   * `vitestJson`, reading the report from a `File`.
   *
   * @param report   the report file, e.g. `container.file("/tmp/vitest.json")`
   * @param exitCode see `vitestJson`
   */
  @func()
  async vitestJsonFile(report: File, exitCode = "0"): Promise<string> {
    return this.vitestJson(await report.contents(), exitCode)
  }


  // ── TestReport (wildbit.test-report/v1) ───────────────────────────────────
  // Every function below returns or takes JSON of a `TestReport`. The legacy
  // functions above are untouched; `toMetrics` bridges the two.

  /**
   * `flutter test --machine` → TestReport: suites with durations, the 10
   * slowest tests, failures with lines, and flaky tests (failed, retried and
   * passed within the run).
   *
   * @param report   the raw NDJSON (see `flutterMachine`)
   * @param lane     what this run is, e.g. `unit`. Reports of the same lane are
   *                 summed by `merge`; different lanes are kept side by side.
   * @param exitCode the suite's REAL exit status (see `flutterMachine`)
   */
  @func()
  flutterReport(report: string, lane: string, exitCode = "0"): string {
    return JSON.stringify(flutterToReport(report, requiredLane(lane), exitCode))
  }

  /** `flutterReport`, reading the report from a `File` (the NDJSON of a large suite runs to megabytes). */
  @func()
  async flutterReportFile(report: File, lane: string, exitCode = "0"): Promise<string> {
    return this.flutterReport(await report.contents(), lane, exitCode)
  }

  /**
   * `vitest run --reporter=json` → TestReport. Also the Angular path: `ng test`
   * with `@angular/build:unit-test` runs vitest and takes `--reporters=json`.
   *
   * @param report   the raw JSON. Empty or malformed yields a zero report, and
   *                 `exitCode` turns that into a failure (see `vitestJson`).
   * @param lane     see `flutterReport`
   * @param exitCode the suite's REAL exit status
   */
  @func()
  vitestReport(report: string, lane: string, exitCode = "0"): string {
    return JSON.stringify(vitestToReport(report, requiredLane(lane), exitCode))
  }

  /** `vitestReport`, reading the report from a `File`. */
  @func()
  async vitestReportFile(report: File, lane: string, exitCode = "0"): Promise<string> {
    return this.vitestReport(await report.contents().catch(() => ""), lane, exitCode)
  }

  /**
   * JUnit XML → TestReport: Maestro `--format junit`, Cypress, vitest's junit
   * reporter, or any other producer.
   *
   * @param runner      `maestro` makes each flow's FILE basename its scenario id,
   *                    which is what `coverage.tsv` rows name. Anything else is
   *                    only a label and the id is the test name.
   * @param asScenarios true (default) fills `scenarios` — right for end-to-end
   *                    flows. false for a unit suite that happens to speak JUnit.
   * @param exitCode    the runner's REAL exit status. Maestro exits non-zero when
   *                    a flow fails and also when it never reached a device.
   */
  @func()
  junitReport(
    report: string, lane: string, runner = "junit", exitCode = "0", asScenarios = true,
    idProperty = "scenarioId", idPattern = "([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\\d+)",
  ): string {
    return JSON.stringify(junitToReport(report, requiredLane(lane), runner, exitCode, asScenarios, idProperty, idPattern))
  }

  /** `junitReport`, reading the report from a `File`. A missing file is an empty report, folded by `exitCode`. */
  @func()
  async junitReportFile(
    report: File, lane: string, runner = "junit", exitCode = "0", asScenarios = true,
    idProperty = "scenarioId", idPattern = "([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\\d+)",
  ): Promise<string> {
    return this.junitReport(await report.contents().catch(() => ""), lane, runner, exitCode, asScenarios, idProperty, idPattern)
  }

  /**
   * Stryker `mutation.json` → TestReport carrying only `mutation`. REPORT-ONLY:
   * nothing here fails a build on a score.
   */
  @func()
  strykerReport(report: string, lane: string): string {
    return JSON.stringify(strykerToReport(report, requiredLane(lane)))
  }

  /** `strykerReport`, reading the report from a `File`. */
  @func()
  async strykerReportFile(report: File, lane: string): Promise<string> {
    return this.strykerReport(await report.contents(), lane)
  }

  /**
   * lcov tracefile(s) → TestReport carrying only `coverage`. Several shards'
   * files may be concatenated into one string: records are unioned per line,
   * so a line covered by two shards counts once. Give it the SAME lane as the
   * suite it measured and `merge` folds it in without touching the counts.
   */
  @func()
  lcovReport(report: string, lane: string): string {
    return JSON.stringify(lcovToReport(report, requiredLane(lane)))
  }

  /** `lcovReport`, reading the tracefile from a `File`. */
  @func()
  async lcovReportFile(report: File, lane: string): Promise<string> {
    return this.lcovReport(await report.contents(), lane)
  }

  /** istanbul `coverage-summary.json` (reporter `json-summary`) → TestReport carrying only `coverage`. */
  @func()
  istanbulReport(report: string, lane: string): string {
    return JSON.stringify(istanbulToReport(report, requiredLane(lane)))
  }

  /** `istanbulReport`, reading the summary from a `File`. */
  @func()
  async istanbulReportFile(report: File, lane: string): Promise<string> {
    return this.istanbulReport(await report.contents(), lane)
  }

  /**
   * Attach perf measurements to a report. REPORT-ONLY: a value over its
   * `budget` is printed as over budget and fails nothing.
   *
   * @param report JSON TestReport
   * @param perf   JSON `[{name, value, unit: ms|bytes|pct, baseline?, budget?}]`,
   *               appended to any perf the report already has
   */
  @func()
  withPerf(report: string, perf: string): string {
    const [r] = parseReports(report, "report")
    if (!r) throw new Error("testing: 'report' is empty")
    let entries: unknown
    try { entries = JSON.parse(perf) } catch (e) { throw new Error(`testing: 'perf' is not valid JSON (${(e as Error).message})`) }
    if (!Array.isArray(entries)) throw new Error("testing: 'perf' must be a JSON array of {name, value, unit}")
    const checked = entries.map((x, i): PerfEntry => {
      const p = x as Partial<PerfEntry>
      if (!p?.name || typeof p.value !== "number" || !Number.isFinite(p.value)) throw new Error(`testing: perf[${i}] needs a name and a finite numeric value`)
      if (p.unit !== "ms" && p.unit !== "bytes" && p.unit !== "pct") throw new Error(`testing: perf[${i}] ('${p.name}') unit '${p.unit}' is not ms|bytes|pct`)
      const e: PerfEntry = { name: p.name, value: p.value, unit: p.unit }
      if (typeof p.baseline === "number") e.baseline = p.baseline
      if (typeof p.budget === "number") e.budget = p.budget
      return e
    })
    return JSON.stringify({ ...r, perf: [...(r.perf ?? []), ...checked] })
  }

  /**
   * `merge`, reading the reports from a `File` holding the JSON array.
   *
   * ⚠️ USE THIS ONE FROM A WORKFLOW. A report of a real suite is hundreds of
   * kilobytes (measured: 195 kB for one Angular repo) and `--reports="$(cat …)"`
   * dies at the ~128 kB argv limit with an `Argument list too long` that names
   * nothing. Every function here that takes report JSON has a `*File` twin for
   * that reason.
   */
  @func()
  async mergeFile(reports: File): Promise<string> {
    return this.merge(await reports.contents())
  }

  /**
   * Merge reports — shards of one lane, or several lanes — into one.
   * The rules (scenario retries, coverage weighting, lanes) are documented on
   * `mergeReports`; the short version: same lane sums, different lanes are
   * summed into the top line AND kept per lane in `lanes`.
   *
   * @param reports JSON array of TestReports (a single object is accepted too)
   */
  @func()
  merge(reports: string): string {
    return JSON.stringify(mergeReports(parseReports(reports, "reports")))
  }

  /**
   * Assign tests and scenarios to features and report where the mapping drifts.
   * Returns JSON `{report, ok, problems, unassignedTests, unknownFeatures,
   * unmappedScenarios, undeclaredFeatures}`; `report.features` is filled.
   *
   * Report-only by default: drift is RETURNED, and the consumer's guard decides.
   * Run it after `merge` — the feature rows are computed from the final suites.
   *
   * @param report   JSON TestReport
   * @param specsDir the `specs/features` directory. Each subdirectory and each
   *                 `.md` file is a feature; `coverage.tsv` in it is the map.
   * @param map      a coverage map elsewhere (e.g. `test/e2e/coverage.tsv`);
   *                 overrides `specsDir/coverage.tsv`
   * @param strict   throw with the problems instead of returning `ok: false`
   */
  @func()
  async features(report: string, specsDir: Directory, map?: File, strict = false): Promise<string> {
    const entries = await specsDir.entries()
    const ids: string[] = []
    for (const e of entries) {
      if (e.startsWith(".")) continue
      if (e.endsWith("/")) ids.push(e.slice(0, -1))
      else if (e.endsWith(".md")) ids.push(e.slice(0, -3))
    }
    let text = ""
    if (map) text = await map.contents()
    else if (entries.includes("coverage.tsv")) text = await specsDir.file("coverage.tsv").contents()
    return this.featureMap(report, JSON.stringify(ids.sort()), text, strict)
  }

  /** `features`, reading the report from a `File` — see `mergeFile` for why. */
  @func()
  async featuresFile(report: File, specsDir: Directory, map?: File, strict = false): Promise<string> {
    return await this.features(await report.contents(), specsDir, map, strict)
  }

  /**
   * `features` without the filesystem: the feature ids and the map text given
   * directly. Pure, so the mapping is testable on fixtures.
   *
   * @param featureIds JSON string array, e.g. `["adoption","lost-pet"]`
   * @param map        the coverage.tsv text; empty means no rows at all
   */
  @func()
  featureMap(report: string, featureIds: string, map = "", strict = false): string {
    const [r] = parseReports(report, "report")
    if (!r) throw new Error("testing: 'report' is empty")
    let ids: unknown
    try { ids = JSON.parse(featureIds) } catch (e) { throw new Error(`testing: 'featureIds' is not valid JSON (${(e as Error).message})`) }
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw new Error("testing: 'featureIds' must be a JSON array of strings")
    const out = mapFeatures(r, ids as string[], map)
    if (strict && !out.ok) throw new Error(`testing: feature map drift:\n- ${out.problems.join("\n- ")}`)
    return JSON.stringify(out)
  }

  /**
   * TestReport → legacy `TestMetrics`, for a caller whose pinned `slack` only
   * reads `metrics`. `failedNames` also lists red scenarios.
   */
  @func()
  toMetrics(report: string): string {
    const [r] = parseReports(report, "report")
    if (!r) throw new Error("testing: 'report' is empty")
    return JSON.stringify(reportToMetrics(r))
  }

  /** `toMetrics`, reading the report from a `File` — see `mergeFile` for why. */
  @func()
  async toMetricsFile(report: File): Promise<string> {
    return this.toMetrics(await report.contents())
  }

  /** `withPerf`, reading the report from a `File` — see `mergeFile` for why. */
  @func()
  async withPerfFile(report: File, perf: string): Promise<string> {
    return this.withPerf(await report.contents(), perf)
  }

  /**
   * Markdown for `$GITHUB_STEP_SUMMARY`: totals, lanes, failures, flaky, the 10
   * slowest, suites, scenarios, the feature matrix, coverage, mutation and perf.
   *
   * @param reports JSON array of TestReports (or one object); one section each.
   *                Pass the merged report for one combined section.
   */
  @func()
  summaryMarkdown(reports: string): string {
    return reportMarkdown(parseReports(reports, "reports"))
  }

  /**
   * `summaryMarkdown`, reading the reports from a `File`.
   *
   * ⚠️ THE ONE TO CALL FROM A WORKFLOW. `--reports="$(cat report.json)"` breaks
   * at the ~128 kB argv limit, and a real report passes it easily — which is how
   * a consumer ended up vendoring its own summary renderer, the duplication these
   * modules exist to remove.
   */
  @func()
  async summaryMarkdownFile(reports: File): Promise<string> {
    return this.summaryMarkdown(await reports.contents())
  }
}
