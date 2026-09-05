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
 * protocols with stable field names.
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
import { File, object, func } from "@dagger.io/dagger"

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
}
