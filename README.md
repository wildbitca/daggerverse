# daggerverse

Shared Dagger modules for `wildbitca`. CI/CD logic written once and consumed by every
pipeline in the organisation.

## Why

Until this repository existed, the same code lived vendored byte-for-byte in several
modules. The Slack progress engine alone was 363 lines copied into `pacha`, `pacha-api`
and `pacha-site`, and the only thing keeping the three copies equal was an md5 recorded in
a `.engine-parity` file. On 2026-09-04 that guard found a real divergence which had been
there for months.

The same was true of the guard scripts: `check-shared-pins.sh` (257 lines) and
`check-engine-parity.sh` (132) were byte-identical in three repos by convention alone.

## Modules

| Module | What it owns | Status |
|---|---|---|
| `slack/` | Progress card, thread detail, breakdown, trend (Slack is the trend store), card lookup by metadata | **published** |
| `runcard/` | One live Slack card per workflow run: multi-job watcher, single-job report, thread under a run's card | **published** |
| `identity/` | OIDC→STS for GCP, GitHub App JWT, Secret Manager reads | **published** |
| `guards/` | Toolchain pins, shared pins across repos, Dagger flag probe, embedded-bash syntax | **published** |
| `scan/` | gitleaks and Trivy, with the exact invocations ADR-0003 §2.2 pins | **published** |
| `github/` | check-runs queries, releases, reruns, step summaries, annotations, run/job/artifact reads for live cards | **published** |
| `testing/` | Native test-report parsers and the org-wide `wildbit.test-report/v1`: flutter, vitest, JUnit (Maestro, Cypress), Stryker, lcov, istanbul; merge, feature mapping, step summary | **published** |

## Consuming a module

```sh
dagger install https://github.com/wildbitca/daggerverse/slack@slack/v0.1.0
```

**Write the `https://` scheme.** The scheme-less form — `github.com/wildbitca/…` — makes
the resolver try SSH first. Both forms work now that the repository is public, but the
explicit one is deterministic: it never probes a transport that may or may not be there.

**No credentials are needed.** Verified 2026-09-05 with SSH disabled and a scratch `HOME`
holding nothing but a `.gitconfig`: both forms install and load.

This repository was private for its first day, and the two numbers that ended that are
worth keeping, because they are the argument if anyone proposes going back:

- **The bootstrap cost more than the refactor saved.** Measured on `pacha-api`: writing a
  token into `.git-credentials` and enabling the credential helper, once per job, was 10
  of the 10 added steps and 131 of the added lines. Stripped, that workflow is 25 steps —
  three fewer than the 28 it started from. Across the four consumers it was roughly 20
  steps and 260 lines of pure ceremony.
- **It broke two things silently.** The organisation's Dependabot secret store is empty,
  so every Dependabot PR would have become permanently unmergeable — `ci` is a required
  status check and the module cannot load without the token. And `guards.daggerFlags`
  went inert: it probes in a NESTED Dagger session, which does not inherit the host's
  credential helper, so it died at module load and its classifier read the absence of a
  known error as success. Measured: an injected flag named `--esto-no-existe-jamas` was
  reported OK.

What made public safe was checking rather than assuming: zero GCP project ids, zero Slack
channels, zero approvers, zero service-account emails and zero hostnames appear in the
module code — the four near-hits are examples inside error strings and a User-Agent. The
deployment topology lives in the callers, which is where it was designed to live. All six
commits were scanned with this repo's own `scan.gitleaks` before the flip: no findings.

⚠️ **Secret scanning is `disabled` and cannot be turned on from here.** An enterprise
policy blocks modifying it over the API — it returns 422 and, because the provider sends
it in the same PATCH as `visibility`, it takes the visibility change down with it. That is
why nothing in this repo may carry a credential, and why `scan.gitleaks` is the thing that
has to catch one.

## Live run cards (`runcard`)

Every pipeline reports to Slack with **one card per run**. Three shapes, one look:

| Workflow shape | Function | Where it runs |
|---|---|---|
| many jobs | `watch` | its own job with **no `needs`**, `continue-on-error: true`, `timeout-minutes` above `deadlineMinutes` |
| one job | `report` | the job's last step, `if: always()`, `--job-status=${{ job.status }}` |
| detail from inside a Dagger call | `thread` (or `cardTs` + `slack.*`) | anywhere in the run |

`watch` polls `github.runJobs` every `pollSeconds`, maps jobs to rows (`[{row, match,
mode}]`; `prefix` aggregates a matrix as n/m, the most specific row wins), rewrites the card
on change, posts each failed job once to the thread (failing step, annotations, cleaned log
tail) and closes with statistics. It **never waits on a human**: when only
environment-approval jobs (`status: waiting`) remain it marks them "awaiting approval",
closes the card as `waiting` and exits. With no Slack token or channel (Dependabot, fork
PRs) every function returns at once.

**Permissions.** The token needs `actions: read` (jobs, logs, workflow runs) and
`checks: read` (annotations). A job-level `permissions:` block **replaces** the
workflow-level one, so a watcher job that declares its own must list both.

**The card's metadata is API.** `event_type` is the caller's `eventType`;
`event_payload` carries `repo`, `sha`, `run_id`, `run_attempt`, `status` and the trend
numbers. Readers:

- `slack.readTrend` — `event_type` + `repo`, for "vs previous".
- `slack.findCard` / `runcard.thread` — `event_type` + `run_id` (+ `run_attempt`).
- `deploy-gate` — `findBuildCard(channel, sha)` in `src/slack.ts`.

**deploy-gate compatibility** (read from `deploy-gate` at `03cdc85`). On a
`deployment_protection_rule` webhook it scans the newest **30** top-level messages of the
repo's channel (`SLACK_CHANNELS`, `include_all_metadata=true`) and threads its approval card
under the first one whose `metadata.event_payload.sha` equals the deployment's commit. It
does **not** filter on `event_type` or `run_id`. Consequences:

- `watch` posts its card as soon as it starts, so the card exists long before a gated job
  reaches its environment; the approval request lands in the card's thread.
- Any other card for the same commit posted later in that channel (a `report` card from a
  second workflow, a re-run's card) is newer and wins. Keep one card-posting workflow per
  commit per channel, or teach deploy-gate to match `run_id` — the callback URL it already
  receives contains the run id.
- If a gated job has no `needs` and the webhook arrives before the watcher posts (module
  load takes ~1–2 min on a cold runner), the request goes to the channel unthreaded.
- A card closed as `waiting` is picked up again by a second watcher job placed after
  the gate (`runcard/v0.1.1`+). Without one it stays `waiting` and the verdict lives only
  in the thread:

```yaml
slack-card-release:
  name: Slack — release card
  needs: [deploy-prod]            # the approval-gated job
  if: always() && startsWith(github.ref, 'refs/tags/')
  continue-on-error: true
  # same call as the first watcher, plus:
  #   --self-job="Slack — release card" --resume-after="Slack — live card"
```

  It edits the same card (found by `event_type` + `run_id` + `run_attempt`), skips the
  failures the first watcher already threaded, and exits again at a further gate.

## Test reports (`wildbit.test-report/v1`)

One report format for every test lane in the organisation, built by `testing`, rendered
by `slack`, collected across jobs by `runcard`. **Coverage, mutation and perf are
report-only**: printed on the card and in the thread, never a gate.

### The contract

`TestMetrics` (the original six fields `slack` reads as `metrics`) does not change.
`TestReport` travels **alongside** it, as a JSON string; `testing.toMetrics` converts one
into the other for callers pinned to an older `slack`.

```ts
type TestReport = {
  schema: "wildbit.test-report/v1"
  lane: string; runner: string; exitCode: string          // exitCode: the runner's REAL exit, as a string
  totals: { passed: number; failed: number; skipped: number; flaky: number; durationMs: number }
  suites: { file: string; pass: number; fail: number; skip: number; durationMs: number; lane?: string }[]
  slowest: { name: string; file: string; durationMs: number }[]     // top 10
  failures: { name: string; file: string; declLine: number | null; failLine: number | null;
              failCol: number | null; kind: "failure" | "error"; message: string }[]
  flakyTests?: { name: string; file: string }[]
  scenarios?: { id: string; name: string; tags: string[]; status: "pass" | "fail" | "skip";
                durationMs: number; attempts: number; file?: string }[]
  features?: { id: string; tests: number; failed: number; scenarios: number; covered: boolean;
               e2e: "flow" | "uncovered" | "undeclared" }[]            // filled by testing.features only
  coverage?: { lines: number; branches?: number; source: "lcov" | "istanbul-summary"; linesFound?: number; linesHit?: number }
  mutation?: { score: number; survived: number; noCoverage: number; killed: number; timeout: number }
  perf?: { name: string; value: number; unit: "ms" | "bytes" | "pct"; baseline?: number; budget?: number }[]
  lanes?: { lane: string; runner: string; exitCode: string; totals: …; coverage?: …; mutation?: … }[]  // merges of several lanes
}
```

Invariants: `passed + failed` is what **ran** (skips excluded, as in `TestMetrics.total`);
a **flaky** test failed and then passed on a retry within the same run, and counts in both
`passed` and `flaky`; a non-zero `exitCode` with no red test folds to one synthetic failure.
Fields are only ever added; a breaking change is `v2` in `schema`.

| Input | Function (`*File` variant takes a `File`) | Measured on |
|---|---|---|
| `flutter test --machine` / `dart test --reporter json` | `flutterReport` | package:test 1.32.0 — retry = `error` + `Retry:` print + one success `testDone` |
| `vitest run --reporter=json` (also `ng test` with `@angular/build:unit-test`) | `vitestReport` | vitest 4.1.11 — retry = `passed` with non-empty `failureMessages` |
| JUnit XML: Maestro `--format junit`, Cypress, vitest junit | `junitReport` (see **Scenario ids**) | vitest 4.1.11; Maestro from its v2.10.0 golden test, **not a device run** |
| Stryker `mutation.json` | `strykerReport` | a real nightly artifact |
| lcov (several tracefiles may be concatenated; unioned per line) | `lcovReport` | v8 via vitest 4.1.11 |
| istanbul `coverage-summary.json` | `istanbulReport` | v8 via vitest 4.1.11 |

No Karma/Jasmine parser: no repository in the organisation runs Karma (Angular projects use
`@angular/build:unit-test` with the vitest runner, whose JSON is vitest's).

**Pass big reports as FILES.** Every function that takes report JSON has a `*File` twin —
`mergeFile`, `featuresFile`, `toMetricsFile`, `withPerfFile`, `summaryMarkdownFile`, and
`--report-file` on `slack.render`/`slack.breakdown`, `--test-reports-file` on
`runcard.report`/`watch`/`runReports`. `--reports="$(cat report.json)"` dies past the ~128 kB
argv limit with an `Argument list too long` that names nothing, and a real report passes it
easily (measured: 195 kB for one Angular repo). From a workflow, always the `*File` form;
between modules the string form is fine, because that crosses GraphQL and not a command line.

**`merge`** folds reports: the same lane sums (shards); different lanes sum into the top
line and stay itemised in `lanes`; a scenario id seen in several reports is one scenario
retried (passed if any attempt passed, flaky if it needed more than one); coverage is
weighted by lines when every part carries counts; features are dropped — map after merging.
Merging a merged report is idempotent. `summaryMarkdown` renders any report for
`$GITHUB_STEP_SUMMARY`. `withPerf` attaches perf entries.

Every case is a fixture in `testing/test/cases.json` (run by `test/run-cases.sh testing`,
wired in CI) with the reason it exists.

### Scenario ids

A scenario id is what a `coverage.tsv` row names, so an id that moves when someone edits a
test title silently deletes that feature's coverage. `junitReport` resolves it, most stable
first, and says which rule it used in `scenario.idSource`:

1. `<property name="scenarioId" value="…"/>` inside the testcase (`--id-property` names it).
2. the testcase's `file` attribute, basename without extension — **only when that file holds
   exactly one testcase** (a Maestro flow). A Cypress spec with twelve tests would otherwise
   collapse twelve scenarios into one id.
3. a declared id in the test title, matched by `--id-pattern` (default `TS-E2E-012`,
   `TS-ATS8-020`: capitals and digits ending in a number).
4. the test title itself — **fragile**. These are listed in `unanchoredScenarios`, counted in
   the step summary and in the card's thread, so a repository sees what a rename would cost.

**Cypress**: mocha-junit-reporter writes no `file` attribute, so a Cypress repo gets stable
ids by putting a declared id in every test title (`it('TS-E2E-012 pays with a saved card', …)`)
or by configuring the reporter to emit `<property name="scenarioId">`. Without either, every
Cypress scenario is unanchored and the report says so on every run.

### Features

Features are the entries of `specs/features/` — each directory, and each `.md` file.

- **Unit tests** are assigned by path: the segment after a `features` segment, underscores
  to hyphens (`test/features/lost_pet/…` → `lost-pet`).
- **E2E scenarios** are assigned **only** by a declared row, never by similar names (flow
  tag `adopt` is not feature `adoption`).
- The declaration is `specs/features/coverage.tsv` — the `pacha/app` `test/e2e/coverage.tsv`
  format, extended with `path:` rows; a file in the old format is valid unchanged:

  ```
  flow	features	note
  like	likes	like, persisted across a cold restart
  record_smoke	-	harness smoke, not a product feature
  UNCOVERED	chat	no flow opens a conversation
  path:test/features/pet/	pet-management	test dir named differently from the spec
  path:test/core/	-	shared tests, no feature
  ```

`testing.features(report, specsDir, map?)` returns the report with `features` filled plus
`problems` (`ok: false`) for: a spec feature no row names (flow, `UNCOVERED` or `path:`), a
feature named by a row or a test path that is not in specs, a scenario with no row, and a
feature declared both covered and `UNCOVERED`. `unassignedTests` (tests belonging to no
feature) is information, not a problem. The consumer's guard decides what fails; `runcard`
only posts drift to the thread.

### The card and the trend

With a `report`, `slack.render` prints `🧪 passed/total · N skip · N flaky · cov X% · mut Y%
· Δ +N tests, cov +x.x vs previous`, and `slack.breakdown` adds per-file results, failures
with their line, flaky tests, the 5 slowest, lanes, failing/UNCOVERED/undeclared features and
perf over budget (worded report-only). `slack.breakdownText` returns the same sections
without posting. The metadata gains flat keys — `t_skipped`, `t_flaky`, `t_ms`, `cov`,
`cov_br`, `mut`, `feat_cov` (% of features with tests) — only when a report is given;
`scenarios`/`passed`/`failed`/`total_ms`/`gates_*` keep their meaning, and `readTrend`
returns the new keys only when the previous card has them, so an old baseline never
produces a delta against a fabricated zero. A caller that passes only `metrics` gets the
previous release's card byte for byte (asserted in CI).

### Handing reports across jobs

**Each job uploads its report as a GitHub artifact whose name starts with `test-report-`;
`runcard.watch --report-artifacts=test-report-` reads them back when it closes.** Jobs run
on different runners with no shared disk, and the watcher already holds `actions: read`,
which is all `github.runArtifactFiles` needs. The rejected alternative — each job posting its
report into the card's thread — would push multi-kilobyte JSON through Slack metadata, race
the watcher's first post, need a Slack token in every job (Dependabot has none) and leave
nothing durable. The artifact is also the file a later Grafana import reads.

- Upload with `overwrite: true`: v4 refuses a duplicate name on a re-run, and with it the
  newest artifact per name is exactly the run's current state (the reader keeps the newest).
- Name the file anything but a dotfile — `upload-artifact` drops hidden files.
- `runcard.runReports` returns what the watcher would render (`{report, notes}`), for a
  step summary or a check. The CI of this repository uploads two artifacts and asserts the
  merge through it on every run.

**A cache volume is NOT a handoff channel.** Writing the report into a `cacheVolume` in one
`dagger call` and reading it back in another is engine-internal state, and nothing here
supports it: measured on `elinvo-site` (runs 35250686596 and 35252896937), the write ran and
the read came back EMPTY on a GitHub runner while the same code worked against a local
engine — with the same volume key AND the same namespace in both calls
(`cacheVolume(key: "elinvo-site-test-reports", namespace: "mod(elinvo-site-ci.)")`), and
still empty with the GHA cache backend unset for the read. The two supported shapes are:
**one `dagger call` that RETURNS the report** (`-o report.json` writes it to the host), and
**an artifact** for another job. Both are files; neither depends on what the engine kept.

### Consumer snippets

**(a) Sharded Flutter unit tests + Maestro, many jobs (`pacha/app`).** Module side — the
suite is wrapped to exit 0 and the report is RETURNED; opts pass every optional field (the
generated `*Opts` mark defaulted fields required):

```ts
// shard job
const exit = (await c.file("/tmp/test-exit").contents()).trim()
return dag.testing().flutterReportFile(c.file("/tmp/test-report.json"), "unit", { exitCode: exit })

// e2e job: maestro test --format junit --output /tmp/maestro.xml … ; echo $? > /tmp/e2e-exit
return dag.testing().junitReportFile(c.file("/tmp/maestro.xml"), "e2e", { runner: "maestro", exitCode: exit, asScenarios: true })
```

```yaml
  test-unit:
    strategy: { matrix: { shard: [0, 1, 2, 3, 4, 5, 6, 7] } }
    steps:
      # …checkout, dagger CLI…
      - name: Unit tests (report)
        run: |
          dagger --progress plain -m "$DAGGER_MODULE" call test-unit-report --source=. \
            --shard-index=${{ matrix.shard }} --total-shards=8 -o "$RUNNER_TEMP/test-report.json"
      - name: Upload the test report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-report-unit-${{ matrix.shard }}
          path: ${{ runner.temp }}/test-report.json
          overwrite: true
          if-no-files-found: ignore
      - name: Gate on the suite's real exit
        run: jq -e '.exitCode == "0"' "$RUNNER_TEMP/test-report.json" >/dev/null
  # e2e: the same three steps, artifact name test-report-e2e

  slack-live:
    name: Slack — live card
    runs-on: ubuntu-latest
    timeout-minutes: 110
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
        with: { sparse-checkout: specs/features }
      # …dagger CLI…
      - name: Keep the card live until the run is done
        env: { GH_API_TOKEN: "${{ github.token }}", SLACK_BOT_TOKEN: "${{ secrets.SLACK_BOT_TOKEN }}" }
        run: |
          dagger --progress plain -m https://github.com/wildbitca/daggerverse/runcard@runcard/v0.3.0 call watch \
            --repo="${{ github.repository }}" --ref="${{ github.ref }}" --sha="${{ github.sha }}" \
            --actor="${{ github.actor }}" --event="${{ github.event_name }}" \
            --run-id="${{ github.run_id }}" --run-number="${{ github.run_number }}" \
            --run-attempt="${{ github.run_attempt }}" --server="${{ github.server_url }}" \
            --rows="$ROWS" --event-type=pipeline_app --github-token=env:GH_API_TOKEN \
            --slack-token=env:SLACK_BOT_TOKEN --slack-channel="${{ vars.SLACK_CHANNEL_ID }}" \
            --report-artifacts=test-report- --specs=specs/features \
            --self-job="Slack — live card"
```

Sharded coverage: upload each shard's `coverage/lcov.info` (`lcov-unit-<shard>`), and in one
job after the shards `cat` them into `testing.lcovReport --lane=unit` and upload the result as
`test-report-coverage`: the concatenation is unioned per line, where merging eight per-shard
percentages would count shared source lines several times.

**(b) One job, vitest (`elinvo/api` shape).** `--coverage.reportOnFailure` is not optional:
measured, vitest writes no coverage at all on a red run without it.

```ts
const c = base.withExec(["sh", "-c",
  "set +e; npx vitest run --reporter=json --outputFile=/tmp/vitest.json --coverage.enabled --coverage.reporter=json-summary --coverage.reportOnFailure > /tmp/test.log 2>&1; echo $? > /tmp/vitest-exit"])
const exit = (await c.file("/tmp/vitest-exit").contents()).trim()
const t = dag.testing()
const unit = await t.vitestReportFile(c.file("/tmp/vitest.json"), "unit", { exitCode: exit })
const cov = await t.istanbulReportFile(c.file("/src/coverage/coverage-summary.json"), "unit")
return t.merge(`[${unit},${cov}]`)
```

```yaml
      - run: dagger --progress plain -m "$DAGGER_MODULE" call test-report --source=. -o test-report.json
      - name: Step summary (optional)
        if: always()
        run: |
          { dagger --progress plain -m https://github.com/wildbitca/daggerverse/testing@testing/v0.3.0 \
              call summary-markdown-file --reports=./test-report.json; echo; } >> "$GITHUB_STEP_SUMMARY"
      - name: Gate on the suite's real exit
        run: jq -e '.exitCode == "0"' test-report.json >/dev/null
      - name: Slack card
        if: always()
        env: { GH_API_TOKEN: "${{ github.token }}", SLACK_BOT_TOKEN: "${{ secrets.SLACK_BOT_TOKEN }}" }
        run: |
          dagger --progress plain -m https://github.com/wildbitca/daggerverse/runcard@runcard/v0.3.0 call report \
            --repo="${{ github.repository }}" --ref="${{ github.ref }}" --sha="${{ github.sha }}" \
            --actor="${{ github.actor }}" --event="${{ github.event_name }}" \
            --run-id="${{ github.run_id }}" --run-number="${{ github.run_number }}" \
            --run-attempt="${{ github.run_attempt }}" --server="${{ github.server_url }}" \
            --job-status="${{ job.status }}" --event-type=ci_api --github-token=env:GH_API_TOKEN \
            --slack-token=env:SLACK_BOT_TOKEN --slack-channel="${{ vars.SLACK_CHANNEL_ID }}" \
            --test-reports-file=./test-report.json --specs=specs/features
```

**(c) Angular (`pacha/web` shape).** Identical to (b); only the runner line changes, because
`ng test` on `@angular/build:unit-test` runs vitest and writes vitest's JSON:

```ts
"set +e; CI=true npx ng test --no-watch --reporters=json --output-file=/tmp/vitest.json > /tmp/test.log 2>&1; echo $? > /tmp/vitest-exit"
// then t.vitestReportFile(c.file("/tmp/vitest.json"), "unit", { exitCode: exit }) as in (b)
```

## Versioning

Per-module semver tags, `<module>/vX.Y.Z` — the Go submodule convention, which is what
Dagger's resolver follows for modules in a subdirectory. Consumers pin a **tag, never
`@main`**: a bug in a shared module must not be able to turn four pipelines red at once
without anyone having chosen it. `dagger.json` records both the version and the resolved
commit.

## Conventions

- **Complex arguments travel as JSON strings.** Structural types cross a Dagger module
  boundary poorly and a shape mismatch fails at call time with an unreadable error. Every
  non-scalar is a JSON string, documented on the function, parsed and validated on entry.
- **Never a public parameter with a digit followed by a letter.** `e2eThing` comes back
  from Dagger's kebab↔camel round-trip as `e2EThing` and makes the **entire function**
  uninvokable — measured with a probe module, invisible to `tsc`, and it cost a red run.
  `--help` cannot be used to check this: it prints a presentation name that is not the
  only accepted spelling.
- **Never a public function named `secret`.** It makes **every `Secret` argument in that
  module uninvokable**: it shadows the CLI's resolution of `Address.secret`, which is the
  path `--flag=env:X` and `--flag=file:X` go through. Measured 2026-09-05 while building
  `identity`:

  ```
  $ dagger call github-app-jwt --private-key=file:/tmp/key.pem …
  ✘ address(value: "file:/tmp/key.pem"): Address!
  ✘  .secret: Secret!  ERROR
  Error: missing required argument: "accessToken"
  ```

  Note the failure's shape, because it is what makes it dangerous: `tsc` is clean,
  `dagger functions` lists everything, and the error names a parameter of a function the
  caller never mentioned. Like the digit rule, it is invisible to every static check and
  only a CLI probe finds it. Prefix such names (`gcpSecret`, not `secret`).

  **The rest of the family was swept, not assumed** — one fixture module per accessor,
  each probed with a resolvable value so a value error could not mask a shadowing:

  | `@func()` name | effect |
  |---|---|
  | `secret` | poisons every `Secret` argument in the module — **silent** |
  | `id` | the module does not load at all; `dagger functions` fails too. Loud, so not this class of bug |
  | `container`, `directory`, `file`, `gitRef`, `gitRepository`, `service`, `socket`, `value` | no effect measured on `Secret`, `Directory`, `File` or `Container` arguments |

  So `secret` is the only silent one today, and the rule is that name and not a general
  ban. `guards.daggerFlags` detects it as a classification rule on output it already
  collects, keyed on the assign error rather than on the name — so whatever shadows an
  accessor next is caught regardless of what it is called.

  **Known blind spot, shared with the digit rule:** the probe reaches value resolution
  only when a function has no *unsatisfied required* flags, because pflag stops earlier.
  On a function with required arguments (`ci` needs `source`, `backend`, `platform`) both
  traps are invisible. There is no module-independent probe that sidesteps this: `dagger
  core` does not accept `-m`, so it never loads the module's schema at all.

- **An absent env var becomes a PRESENT, EMPTY `Secret`.** `--flag=env:UNSET` resolves
  without error, so a module cannot tell "the caller had no token" from "the caller had an
  empty one" — it takes its token-present branch and fails closed on exactly the run that
  was meant to skip. Measured 2026-09-05 on `guards.sharedPins`: a skipped token mint plus
  an unconditional flag turned every Dependabot run red, at a line that looked handled.

  The flag must be **omitted**, not emptied:

  ```bash
  SIBLINGS=()
  if [ -n "${SIBLINGS_TOKEN:-}" ]; then SIBLINGS=(--siblings-token=env:SIBLINGS_TOKEN); fi
  dagger … "${SIBLINGS[@]}" …
  ```

  The `if` block and not `[ -n … ] && SIBLINGS=(…)`: the `&&` form returns 1 when the test
  is false and fails the step under GitHub Actions' default `bash -e`. That is a second
  trap inside the fix for the first.

  Module side: an optional `Secret` that arrives empty should be treated as absent, so the
  two sides of this cannot disagree.

- **No numeric separators in a parameter default.** `maxBytes = 5_000_000` registers as a
  default of **5**: measured 2026-09-17 on `github.runArtifactFiles`, which then skipped a
  5 MB file as "over maxBytes 5". `tsc` is clean and the value is right in TypeScript; the
  schema Dagger derives from the source is not. Write `5000000`.
- **Fail closed with an error that names the parameter.** A silent default on a malformed
  argument renders an empty card and reports nothing wrong, which is the failure these
  modules exist to prevent.
- **Notification is best-effort; gates are not.** A Slack outage logs and returns. A
  guard that cannot read what it is checking fails the build.

The full contract, including what deliberately does NOT live here, is in
[`org-gitops/docs/daggerverse-ci-contract.md`](https://github.com/wildbitca/org-gitops/blob/main/docs/daggerverse-ci-contract.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
