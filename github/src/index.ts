/**
 * GitHub API logic shared by every pipeline in the organisation.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 * All of this lived as bash + `gh` + `jq` heredocs inside `.github/workflows`.
 * That is the worst place for it: it cannot be run from a laptop, it cannot be
 * tested without a push, and `jq` filters spanning eight lines were reviewed by
 * nobody because a YAML diff hides them. Every function here is a straight port
 * of a block that is currently a `run:` step, and the reasoning in the comments
 * is load-bearing — each paragraph is a measured failure, not a preference.
 *
 * ── WHAT STAYS IN YAML, AND WHY ─────────────────────────────────────────────
 * Per `org-gitops/docs/daggerverse-ci-contract.md` §1, a step survives in YAML
 * only for approval gates, runner topology, the trigger surface (`on:`, `if:`,
 * `permissions`, `concurrency`) or the runner's own API. So the `if:` guards of
 * `rerun-on-runner-loss.yml` — `conclusion == 'failure'`, `run_attempt == 1`,
 * `event == 'push'`, `head_branch == 'main'` — stay there: they are the trigger
 * surface, and `run_attempt == 1` is what bounds the retry to ONE (the rerun
 * creates attempt 2, the workflow fires again, and the condition no longer
 * holds). This module owns the decision, never the trigger.
 *
 * ── EVERY READ IS CACHE-BUSTED, AND THIS IS NOT OPTIONAL ────────────────────
 * Dagger caches an exec by its command and environment. A network read whose
 * arguments did not change is therefore served from the previous run's cache:
 * the container never starts, the API is never called, and the gate reports the
 * verdict of a run that happened yesterday. A check that is cached is a check
 * that did not happen. Every function that touches the network takes a
 * `cacheBust` that MUST vary per run — use the GitHub run id — and it is a
 * required parameter on purpose, because a default would be a default that
 * silently disables the gate.
 *
 * ── COMPLEX ARGUMENTS TRAVEL AS JSON STRINGS ────────────────────────────────
 * Structural types cross a Dagger module boundary poorly and a shape mismatch
 * fails at call time with an unreadable error. Non-scalars cross as JSON
 * strings, documented on each function, parsed and validated on entry.
 *
 * ── PARSING HAPPENS IN TYPESCRIPT, NOT IN `jq` ──────────────────────────────
 * The ported bash piped `gh api` into `jq`. Here the container only runs
 * `curl` and the JSON is parsed in the SDK. That is not a style choice: it
 * removes an `apk add jq` from every call, and a shared apt/apk cache mount is
 * a measured source of concurrent-build failures (the lock lives inside the
 * cached directory, so parallel containers fight over it). It also lets a
 * malformed response name itself in the error instead of becoming an empty
 * `jq` string that reads as "nothing found".
 */
import { dag, Secret, File, Container, object, func } from "@dagger.io/dagger"

const CURL_IMG = "curlimages/curl:8.21.0"
const API = "https://api.github.com"

/** One raw API response. `status` is the HTTP code; `body` the raw payload. */
type Response = { status: number; body: string }

/** A job of a workflow run, reduced to what the lost-runner signature needs. */
type Job = {
  name: string
  conclusion: string | null
  steps?: { name: string; conclusion: string | null }[]
}

/**
 * Parse a JSON argument, naming the parameter in the error.
 *
 * A silent default on a malformed argument is the failure these gates exist to
 * prevent: it would let the build through for the wrong reason. An empty string
 * is the documented "absent" value and the only thing that yields `undefined`.
 */
function parse<T>(raw: string, what: string): T | undefined {
  const t = (raw ?? "").trim()
  if (!t) return undefined
  try {
    return JSON.parse(t) as T
  } catch (e) {
    throw new Error(`github: '${what}' is not valid JSON (${(e as Error).message}). It travels as a JSON string; the caller does JSON.stringify.`)
  }
}

/** Reject an empty required string, naming what the argument protects. */
function required(value: string, what: string, protects: string): string {
  const v = (value ?? "").trim()
  if (!v) throw new Error(`github: '${what}' is empty — ${protects}`)
  return v
}

/**
 * Escape the DATA half of a workflow command.
 *
 * `%`, CR and LF are the three characters that terminate or corrupt the command
 * line. A raw newline in a message does not produce a two-line annotation: it
 * ends the command, and everything after it is printed as plain log text that
 * nobody sees as a warning. Encoding is what makes a multi-line diagnostic
 * survive as ONE annotation.
 */
function escData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
}

/**
 * Escape a PROPERTY value of a workflow command.
 *
 * Properties are `key=value` pairs separated by commas and closed by `::`, so on
 * top of the data escaping a `,` or a `:` inside a title silently truncates the
 * title and can swallow the message. Ported titles like `Gate without data`
 * never hit this; a title built from a commit message would.
 */
function escProp(s: string): string {
  return escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C")
}

@object()
export class Github {
  // ── The tag gate ──────────────────────────────────────────────────────────

  /**
   * Assert that the CODE a tag points at has passed CI on the default branch.
   *
   * Ported from `pacha/app/.github/workflows/pipeline.yml`, job `release`, step
   * «verificar que el código del tag pasó CI en main». Without it any commit
   * could be tagged and shipped to the stores; it is a query, never a rebuild.
   *
   * THE INVARIANT IS "THE PUBLISHED CODE PASSED CI", NOT "THIS COMMIT HAS A
   * RUN". With `paths-ignore`, a docs-only commit legitimately has no run of its
   * own and a literal check would reject it while nothing is wrong. So: if the
   * tag's commit is green, done. If not, walk up to `maxCommits` ancestors for
   * the nearest green one and demand that EVERYTHING changed since then matches
   * `ignoredRe`. One line of code without CI fails — which is the case the gate
   * exists to catch.
   *
   * ⚠️ "GREEN" IS THE CONCLUSION OF A CHECK-RUN, NEVER OF THE RUN. The earlier
   * version asked `gh run list --json conclusion`, which is the verdict of the
   * WHOLE run and therefore red as soon as ANY job is. On 2026-09-03 the
   * `ios-e2e` lane started running on every push, and overnight NO commit in the
   * repo could satisfy this gate — not even through the ancestor path, which
   * read the same list. The code was perfectly validated and tags were
   * impossible. Asking for one named check-run also aligns the release gate with
   * the merge gate: `ci` is the single context the `branch-ci-required` ruleset
   * requires, so a new and still unstable lane can go red without blocking
   * releases — which is exactly the property that makes adding lanes possible.
   *
   * ⚠️ FAILING TO *READ* CHECK-RUNS IS NOT "NOT GREEN". The ported bash ended
   * its query with `|| echo 0`, so a 404 from a missing `checks: read`
   * permission counted as zero green runs and rejected the tag for the wrong
   * reason — worse than having no gate, because it looks like a verdict. Here
   * every non-200 throws and names the permission. See the note on the first
   * `checkGreen` call below for why that also deletes the bash's preflight
   * probe, and `checkGreen` itself for how far that claim has been proven.
   *
   * @param repo      `owner/name`.
   * @param sha       Anything the commits API resolves: a commit sha, a branch,
   *                  or a TAG NAME. Pass `github.ref_name`, not `github.sha`:
   *                  for an ANNOTATED tag the ref points at a tag object, and
   *                  the commits API answers 422 «No commit found for SHA» for
   *                  it (measured 2026-09-05 against `wildbitca/pacha` `v3.8.2`,
   *                  whose ref object is `8eda9c76`, not the commit `bb08c4af`).
   *                  This is the same reason the bash ran `git rev-list -n1`.
   * @param checkName The check-run name that must be green, e.g. `ci`.
   * @param ignoredRe POSIX/JS regex of paths allowed to change without CI, e.g.
   *                  `^(specs/|docs/)|\.md$`. Required, never defaulted: a
   *                  default here would be a silent policy for repos that never
   *                  chose it.
   * @param cacheBust MUST vary per run (the run id). See the module header.
   * @param maxCommits How far to walk. 50 is generous: above that the tag does
   *                  not hang off anything this CI has seen and rejecting is the
   *                  correct answer.
   */
  @func()
  async verifyTagCi(
    token: Secret,
    repo: string,
    sha: string,
    checkName: string,
    ignoredRe: string,
    cacheBust: string,
    maxCommits = 50,
  ): Promise<string> {
    required(repo, "repo", "without it the gate would query nothing and pass by accident")
    required(sha, "sha", "it is the commit whose CI is being verified")
    required(checkName, "checkName", "an empty name matches no check-run and every tag would be rejected")
    required(ignoredRe, "ignoredRe", "it decides which paths may change without CI; there is no safe default")
    required(cacheBust, "cacheBust", "without it Dagger serves a cached exec and the gate silently does not run")
    if (maxCommits < 1) throw new Error(`github: 'maxCommits' must be >= 1, got ${maxCommits}`)

    let re: RegExp
    try {
      re = new RegExp(ignoredRe)
    } catch (e) {
      throw new Error(`github: 'ignoredRe' is not a valid regex (${(e as Error).message}) — it decides which paths may change without CI`)
    }

    // Resolve first: everything downstream compares commit shas, and a tag name
    // or an annotated tag would otherwise fail much later with a 422 that names
    // no cause.
    const head = await this.resolveCommit(token, repo, sha, cacheBust)
    const lines: string[] = [`${sha} -> ${head}`]

    // ⚠️ DO NOT ADD A PREFLIGHT PROBE HERE. The ported bash opened this step
    // with one — a throwaway `check-runs?per_page=1` before it looked at any
    // commit — and removing it looks like a regression until you see what it was
    // compensating for.
    //
    // The bash's per-commit query ended in `|| echo 0`. A failed read was
    // therefore INDISTINGUISHABLE from "not green", so it did not stop: it
    // walked all 50 ancestors, got 50 identically wrong answers, and produced a
    // confident verdict out of them. The preflight was the only thing standing
    // between a missing `checks: read` and a rejected tag.
    //
    // `checkGreen` throws on any non-200, so THIS call — the tag's own sha,
    // before a single ancestor is walked — already dies with the `checks: read`
    // message. The preflight is not belt-and-braces any more; it is a duplicate
    // of a guarantee the control flow now gives, and its only remaining effect
    // would be one more API call that can go stale in a different way from the
    // one next to it. If you are about to restore it, the thing to restore is
    // the `|| echo 0` it existed for, and that is not coming back.
    if (await this.checkGreen(token, repo, head, checkName, cacheBust)) {
      lines.push(`OK the tagged commit has '${checkName}' green`)
      return lines.join("\n")
    }

    // One call per commit instead of listing the last 100 runs: it stops at the
    // first green — 1 to 3 calls in practice — and does not depend on the run
    // still being inside a 100-run window.
    const ancestors = await this.ancestors(token, repo, head, maxCommits, cacheBust)
    let base = ""
    for (const c of ancestors) {
      if (await this.checkGreen(token, repo, c, checkName, cacheBust)) {
        base = c
        break
      }
    }
    if (!base) {
      const msg = `no ancestor of ${head} (${ancestors.length} commits walked, max ${maxCommits}) has the '${checkName}' check-run green`
      console.error(this.annotation("error", msg, "Tag without green CI"))
      throw new Error(`github: ${msg}`)
    }
    lines.push(`nearest green ancestor: ${base}`)

    const changed = await this.changedFiles(token, repo, base, head, cacheBust)
    const offending = changed.filter((f) => !re.test(f))
    if (offending.length) {
      const msg = `files outside the ignored paths changed since ${base}:\n${offending.join("\n")}`
      console.error(this.annotation("error", msg, "Code without CI"))
      throw new Error(`github: ${msg}`)
    }
    lines.push(`OK only ignored paths changed since ${base}:`, ...changed.map((f) => `  ${f}`))
    return lines.join("\n")
  }

  // ── The lost-runner heuristic ─────────────────────────────────────────────

  /**
   * Decide whether a finished run has the signature of a runner that vanished.
   *
   * Ported from `pacha/app/.github/workflows/rerun-on-runner-loss.yml`. The
   * `bithome` node — the k3s hosting the ARC runners and the shared Dagger
   * engine — restarts its containers with nothing scheduling it. Measured on
   * 2026-09-04: 73 pods terminated at once at 02:28:59 with `reason=Unknown` and
   * came back at 02:29:30, and the cumulative counters confirm it recurs
   * (local-path-provisioner 56 restarts in 69 days, metrics-server 43, coredns
   * 27, dagger-engine 15). When that happens inside a ~95-minute `ci`, GitHub
   * marks the job `failure`, the running step stays `in_progress` with no
   * conclusion, and the logs are NOT EVEN ARCHIVED (`log not found`): the run
   * and its evidence are both lost, and the red is indistinguishable from a
   * broken test to anyone glancing at it.
   *
   * THE DISCRIMINATOR:
   *   lost runner   → job `failure` and NOT ONE step with `conclusion == failure`
   *                   (the step in flight was left `in_progress` / null)
   *   real failure  → the step that broke carries `conclusion == failure`
   *
   * Checked against the two real samples that existed:
   *   33822966475  `ci` failure at 49 min, `dagger call ci` in_progress → rerun
   *   33827086621  `ci` failure at 53 s,   `dagger call ci` failure     → do not
   *                (a compilation error of the module: a legitimate failure)
   *
   * ⚠️ THIS HEURISTIC SURVIVES THE PIPELINE CONSOLIDATION. Fusing steps into one
   * `dagger call` does not weaken it: a real failure still leaves exactly one
   * step in `failure` (the fused one), and a lost runner still leaves zero. What
   * would break it is a job whose only step cannot fail — and there is none.
   *
   * ⚠️ EVERY NAMED JOB IS EVALUATED SEPARATELY, and that is not a style detail.
   * The earlier version picked ONE job — the first with `conclusion == failure`
   * — and looked only at it. With a single lane that worked. After the pipeline
   * was unified there were two, and on 2026-09-04 run 33909173457 showed what
   * that does: the API returned `ci (iOS)` first (red with 1 step in failure, a
   * REAL failure of the Mac toolchain guard), the selector kept it, concluded
   * "real failure, no rerun" — and NEVER LOOKED at job `ci`, which was precisely
   * the one that had lost its runner (OOMKilled, 0 steps in failure). While one
   * lane is red for a legitimate reason the other could lose its runner and
   * never be rerun, and that condition is not rare: it is EVERY run while the
   * Mac carries its own red. The question is not "which job", it is "does ANY
   * job have the signature".
   *
   * Returns JSON: `{lost, job, stuckStep, reason, diagnostic}`. The diagnostic
   * covers ALL named jobs, not just the chosen one — if this ever decides wrong,
   * the log has to show why without calling the API again. It is also written to
   * stderr so it lands in the Dagger log even when the caller drops the return.
   *
   * @param runId     The workflow run id (`github.event.workflow_run.id`).
   * @param jobNames  JSON `string[]` of job names to consider, e.g.
   *                  `["ci","ci (iOS)"]`. REQUIRED and never defaulted to "all
   *                  jobs": an unfiltered match would let any job in the run
   *                  trigger a rerun of the whole thing.
   * @param cacheBust MUST vary per run. See the module header.
   */
  @func()
  async lostRunnerVerdict(
    token: Secret,
    repo: string,
    runId: string,
    jobNames: string,
    cacheBust: string,
  ): Promise<string> {
    required(repo, "repo", "without it there is no run to inspect")
    required(runId, "runId", "it identifies the run whose jobs are inspected")
    required(cacheBust, "cacheBust", "without it Dagger serves a cached exec and the verdict is a previous run's")
    const names = parse<string[]>(jobNames, "jobNames")
    if (!names || !names.length) {
      throw new Error("github: 'jobNames' is empty — it bounds which jobs may trigger a rerun; unfiltered, any job in the run would match the signature")
    }

    const r = await this.request(token, `${API}/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, cacheBust)
    if (r.status !== 200) {
      throw new Error(`github: could not read the jobs of run ${runId} in ${repo} (HTTP ${r.status}) — is 'actions: read' missing from permissions? Body: ${r.body.slice(0, 400)}`)
    }
    const jobs = (JSON.parse(r.body) as { jobs?: Job[] }).jobs ?? []
    const mine = jobs.filter((j) => names.includes(j.name))

    const diagnostic = mine
      .map((j) => {
        const failed = (j.steps ?? []).filter((s) => s.conclusion === "failure").length
        const stuck = (j.steps ?? []).find((s) => s.conclusion === null)?.name ?? "-"
        return `  ${j.name}: conclusion=${j.conclusion ?? "null"}  steps in failure=${failed}  first unfinished step=${stuck}`
      })
      .join("\n")
    if (diagnostic) console.error(diagnostic)

    const lost = mine.find(
      (j) => j.conclusion === "failure" && (j.steps ?? []).filter((s) => s.conclusion === "failure").length === 0,
    )
    if (!lost) {
      // Two different "no", and the ported line only covered one. In YAML the
      // `if:` guarantees the run ended in failure, so "it is a real failure" was
      // always true there. Called directly — from a laptop, or by a caller with
      // a looser trigger — the same sentence about a GREEN run is simply false,
      // and a wrong explanation of a correct verdict is what gets a correct gate
      // reverted by the next person to read it.
      const anyRed = mine.some((j) => j.conclusion === "failure")
      return JSON.stringify({
        lost: false,
        job: "",
        stuckStep: "",
        reason: anyRed
          ? "no CI job has the signature (red with zero steps in failure): this is a real failure, not a rerun"
          : "no named CI job ended in failure: there is nothing to relaunch",
        diagnostic,
      })
    }
    const stuckStep = (lost.steps ?? []).find((s) => s.conclusion === null)?.name ?? "-"
    return JSON.stringify({
      lost: true,
      job: lost.name,
      stuckStep,
      reason: `'${lost.name}' has the signature of a lost runner: red without a single step in failure`,
      diagnostic,
    })
  }

  /**
   * Rerun the failed jobs of a run — `POST /actions/runs/{id}/rerun-failed-jobs`,
   * which is what `gh run rerun --failed` calls.
   *
   * DELIBERATELY SEPARATE FROM THE VERDICT. Deciding and acting are different
   * privileges: reading jobs needs `actions: read`, this needs `actions: write`,
   * and a caller must be able to ask "is this a lost runner?" from a laptop
   * without relaunching anything. Bounding it to ONE retry is the caller's job
   * and stays in YAML as `run_attempt == 1` — this function will happily rerun
   * anything it is pointed at, so a caller that drops that guard builds a loop.
   *
   * @param cacheBust MUST vary per run. A POST exec is cached exactly like a GET
   *                  one, so without it a second call for the same run returns
   *                  the first call's output and no rerun is ever requested.
   */
  @func()
  async rerunFailedJobs(token: Secret, repo: string, runId: string, cacheBust: string): Promise<string> {
    required(repo, "repo", "without it there is no run to relaunch")
    required(runId, "runId", "it identifies the run to relaunch")
    required(cacheBust, "cacheBust", "without it Dagger serves the previous call's exec and no rerun is requested")
    const r = await this.request(token, `${API}/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`, cacheBust, "POST", "{}")
    // 201 is the documented success. 403 with "cannot be rerun" is what a run
    // whose logs already expired answers, and it is a real failure of the
    // mitigation, not a no-op: swallowing it would leave a lost run looking
    // relaunched.
    if (r.status !== 201) {
      throw new Error(`github: rerun of run ${runId} in ${repo} failed (HTTP ${r.status}) — is 'actions: write' missing from permissions? Body: ${r.body.slice(0, 400)}`)
    }
    return `rerun requested for the failed jobs of run ${runId}`
  }

  // ── Releases ──────────────────────────────────────────────────────────────

  /**
   * Whether a release already exists for `tag`.
   *
   * Public on purpose rather than folded into `createRelease`: it is the
   * read-only half of the idempotency check, so it can be exercised against a
   * live repository without creating anything. A 404 is the only "no"; any other
   * non-200 throws, because "the API did not answer" must never be read as "the
   * release is not there" — that is how an idempotent create turns into a
   * duplicate.
   *
   * ⚠️ 404 IS AMBIGUOUS AND CANNOT BE MADE OTHERWISE HERE. GitHub answers 404
   * both for "no release with that tag" and for "this token cannot see this
   * repository" — it will not confirm a private repo's existence to a token
   * without access. Measured 2026-09-05: `wildbitca/does-not-exist-abc` returns
   * `false`, not an error. That is safe in the only place it is used:
   * `createRelease` then tries the POST, which fails with its own error naming
   * the repository. It would NOT be safe as the premise of a "skip the release"
   * decision, so do not use it as one.
   *
   * @param cacheBust MUST vary per run. See the module header.
   */
  @func()
  async releaseExists(token: Secret, repo: string, tag: string, cacheBust: string): Promise<boolean> {
    required(repo, "repo", "without it there is nothing to look the release up in")
    required(tag, "tag", "it is the release being looked up")
    required(cacheBust, "cacheBust", "without it Dagger serves a cached exec and the answer is a previous run's")
    const r = await this.request(token, `${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, cacheBust)
    if (r.status === 200) return true
    if (r.status === 404) return false
    throw new Error(`github: could not read release '${tag}' in ${repo} (HTTP ${r.status}) — a non-404 error is not the same as "no release". Body: ${r.body.slice(0, 400)}`)
  }

  /**
   * Create the GitHub Release for a tag. Idempotent.
   *
   * Ported from the `release` job of `pipeline.yml` («crear GitHub Release») and
   * from the private `githubRelease` of `app/.github/dagger`. Dagger used to
   * create it inside `ci` when `ci` ran on tags; once CI was taken off tags that
   * step became unreachable and the workflow redid it in bash. Both copies land
   * here.
   *
   * IDEMPOTENT BY SKIPPING, NOT BY OVERWRITING. An existing release is left
   * exactly as it is, which is what the live workflow does («el release ya
   * existe, no se recrea»). It matters because the `release` job can be replayed
   * — GitHub re-dispatches on approval, and the lost-runner mitigation reruns
   * failed jobs — and a release whose notes a human has edited must not be
   * silently rewritten by a replay. `updateExisting` restores the PATCH
   * behaviour of the private `githubRelease` for callers that want the notes
   * regenerated; it is off by default because only one of the two copies did it
   * and it is the destructive one.
   *
   * PRERELEASE COMES FROM THE TAG, by the same semver convention that picks the
   * store channel: a tag with a hyphen (`v4.0.0-rc.1`) is internal QA and must
   * not appear as a stable release.
   *
   * @param notes     Release body. Empty asks GitHub to generate the notes,
   *                  which is what `gh release create --generate-notes` did.
   * @param changelog Optional CHANGELOG.md; when `notes` is empty its section
   *                  for this tag is used. See `changelogNotes`.
   * @param cacheBust MUST vary per run. A POST is cached like a GET.
   */
  @func()
  async createRelease(
    token: Secret,
    repo: string,
    tag: string,
    cacheBust: string,
    notes = "",
    changelog?: File,
    updateExisting = false,
  ): Promise<string> {
    required(repo, "repo", "without it there is nowhere to create the release")
    required(tag, "tag", "it is both the release name and the git ref it points at")
    required(cacheBust, "cacheBust", "without it Dagger serves the previous call's exec and the release is never created")

    let body = notes.trim()
    if (!body && changelog) body = await this.changelogNotes(changelog, tag)

    const prerelease = this.isPrerelease(tag)
    const common: Record<string, unknown> = {
      name: tag,
      prerelease,
      // A prerelease that is also "latest" is the contradiction the store
      // channel convention exists to avoid: the private githubRelease sent
      // make_latest:"true" unconditionally because it never set `prerelease` at
      // all, and merging the two copies makes that inconsistency visible.
      make_latest: prerelease ? "false" : "true",
      ...(body ? { body } : { generate_release_notes: true }),
    }

    if (await this.releaseExists(token, repo, tag, cacheBust)) {
      if (!updateExisting) return `release ${tag} already exists, not recreated`
      const found = await this.request(token, `${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, cacheBust)
      const id = (JSON.parse(found.body) as { id?: number }).id
      if (!id) throw new Error(`github: release '${tag}' exists but its payload carries no id — refusing to guess which release to update`)
      const upd = await this.request(token, `${API}/repos/${repo}/releases/${id}`, cacheBust, "PATCH", JSON.stringify(common))
      if (upd.status !== 200) {
        throw new Error(`github: could not update release '${tag}' in ${repo} (HTTP ${upd.status}). Body: ${upd.body.slice(0, 400)}`)
      }
      return `GitHub Release ${tag} updated${prerelease ? " (prerelease)" : ""}`
    }

    const r = await this.request(token, `${API}/repos/${repo}/releases`, cacheBust, "POST", JSON.stringify({ tag_name: tag, ...common }))
    if (r.status !== 201) {
      const hint = r.status === 404
        ? `a 404 here means the token does not see ${repo} at all — GitHub does not confirm a private repository to a token without access, so the existence probe above answered "no release" for the same reason`
        : "is 'contents: write' missing from permissions?"
      throw new Error(`github: could not create release '${tag}' in ${repo} (HTTP ${r.status}) — ${hint} Body: ${r.body.slice(0, 400)}`)
    }
    return `GitHub Release ${tag} created${prerelease ? " (prerelease)" : ""}`
  }

  /**
   * Whether a tag is a prerelease, by the semver convention this organisation
   * releases with: a hyphen means internal QA. Pure.
   *
   * Public and separate so the rule can be asserted without creating anything —
   * `createRelease` cannot be exercised live without publishing a release, and
   * an untested rule that decides what appears in the stores is not a rule. It
   * is also the SAME predicate the workflow evaluates in four other places
   * (`contains(github.ref_name, '-')` picks the job name, the `environment:`,
   * the Codemagic channel and this flag), and per the contract §3.1 a routing
   * decision belongs in one testable place rather than in four `if:` strings.
   */
  @func()
  isPrerelease(tag: string): boolean {
    required(tag, "tag", "it is what decides between the store channel and internal QA")
    return tag.includes("-")
  }

  /**
   * Extract the `## [VERSION]` section of a CHANGELOG for a tag. Pure.
   *
   * Ported verbatim from the private `githubRelease`. The leading `v` is
   * stripped and the version is regex-escaped before it is used as a pattern:
   * a version is full of dots, and an unescaped `4.0.0` would also match
   * `4x0y0`, quietly picking the wrong section.
   *
   * Returns "" when there is no such section, which is the caller's signal to
   * let GitHub generate the notes — the same fallback the private helper had.
   */
  @func()
  async changelogNotes(changelog: File, tag: string): Promise<string> {
    required(tag, "tag", "it selects which CHANGELOG section becomes the release notes")
    let contents = ""
    try {
      contents = await changelog.contents()
    } catch {
      return "" // no readable CHANGELOG → auto-generated notes
    }
    const version = tag.replace(/^v/, "")
    const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const head = new RegExp(`^## \\[${esc}\\]`)
    const anyHead = /^## \[/
    const out: string[] = []
    let grab = false
    for (const line of contents.split("\n")) {
      if (head.test(line)) {
        grab = true
        continue
      }
      if (grab && anyHead.test(line)) break
      if (grab) out.push(line)
    }
    return out.join("\n").trim()
  }

  // ── Annotations and step summaries ────────────────────────────────────────

  /**
   * Render a workflow command — `::error title=…::message`. Pure.
   *
   * WHY IT LIVES HERE AT ALL: the diagnostic prose in these pipelines is long,
   * carefully worded, and it is the only thing a person reads when a run goes
   * red. Kept in YAML it is unreviewable and untestable; kept here it is a
   * string a test can assert on.
   *
   * HOW A CALLER EMITS IT: the runner parses workflow commands out of the step
   * log, whatever writes them — this is already relied upon by the existing
   * modules, which emit `console.error("::error:: …")` from inside a Dagger
   * session and get real annotations. So either let a function print it, or
   * capture the return and echo it:
   *
   *   dagger call annotation --level=warning --message=… > /tmp/a && cat /tmp/a
   *
   * The level is validated because GitHub does not complain about an unknown
   * one: `::warn::` is printed as ordinary log text and the annotation simply
   * never appears — the exact class of failure where the check silently did not
   * happen.
   *
   * @param level warning | error | notice | debug
   * @param title Optional annotation title.
   * @param file  Optional path to attach the annotation to.
   * @param line  Optional line; 0 means absent.
   */
  @func()
  annotation(level: string, message: string, title = "", file = "", line = 0): string {
    const allowed = ["warning", "error", "notice", "debug"]
    if (!allowed.includes(level)) {
      throw new Error(`github: 'level' must be one of ${allowed.join("|")}, got '${level}' — GitHub prints an unknown level as plain text and the annotation never appears`)
    }
    const props: string[] = []
    if (title) props.push(`title=${escProp(title)}`)
    if (file) props.push(`file=${escProp(file)}`)
    if (line > 0) props.push(`line=${line}`)
    return `::${level}${props.length ? " " + props.join(",") : ""}::${escData(message)}`
  }

  /**
   * Render a `$GITHUB_STEP_SUMMARY` section. Pure.
   *
   * @param bullets JSON `string[]`; each becomes a `- ` item. Empty for none.
   * @param body    Free markdown appended after the bullets.
   */
  @func()
  summarySection(heading: string, bullets = "", body = ""): string {
    required(heading, "heading", "a summary section without a heading merges into the previous one and reads as its continuation")
    const items = parse<string[]>(bullets, "bullets") ?? []
    const parts = [`### ${heading}`, ""]
    if (items.length) parts.push(...items.map((b) => `- ${b}`), "")
    if (body.trim()) parts.push(body.trim(), "")
    return parts.join("\n")
  }

  /**
   * The same markdown as a File, for callers that would rather redirect than
   * quote: `dagger call … export --path=s.md && cat s.md >> "$GITHUB_STEP_SUMMARY"`.
   *
   * Shell-quoting a multi-line markdown blob through `$(…)` is where the ported
   * heredocs lost their blank lines, and a summary without blank lines renders
   * as one run-on paragraph.
   */
  @func()
  summaryFile(markdown: string): File {
    return dag.directory().withNewFile("summary.md", markdown).file("summary.md")
  }

  /**
   * The `::warning::` the rerun mitigation emits. Pure.
   *
   * NOISY ON PURPOSE. This mitigation does not fix the node, and it was chosen
   * knowing the cause is still there: diagnosing it needs `journalctl -u k3s` on
   * the host, which is not reachable from the cluster. A silent retry would turn
   * an infrastructure problem into a slightly slower CI and nobody would look at
   * it again. Hence a warning naming the suspicion, and `warning` rather than
   * `error`: the run being annotated did not fail because of this.
   */
  @func()
  lostRunnerWarning(runId: string, stuckStep: string): string {
    return this.annotation(
      "warning",
      `the ci job of run ${runId} died without a single step concluding (last: ${stuckStep}). Relaunched once. If it repeats, look at the bithome host (journalctl -u k3s), not at the pipeline.`,
      "Runner lost mid-run",
    )
  }

  /** The `$GITHUB_STEP_SUMMARY` block of the rerun mitigation. Pure. */
  @func()
  lostRunnerSummary(runId: string, runUrl: string, stuckStep: string): string {
    return this.summarySection(
      "Run relaunched after a runner loss",
      JSON.stringify([
        `original run: [${runId}](${runUrl})`,
        `step left unfinished: \`${stuckStep}\``,
        "not one step reported `failure`, so it was not a broken test",
      ]),
      [
        "The `bithome` node restarts its containers with nothing scheduling it",
        "(73 pods at once on 2026-09-04 at 02:28:59; 56 cumulative restarts in",
        "`local-path-provisioner`). This retry covers the symptom; the cause is",
        "still open and needs `journalctl -u k3s` on the host.",
      ].join("\n"),
    )
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * True when `sha` carries a check-run named `checkName` concluded `success`.
   *
   * THE LOAD-BEARING PROPERTY OF THE WHOLE GATE IS THE `if` BELOW: there is no
   * path from a non-200 to `return false`. `false` is reachable only from a
   * parsed 200 body, so "I could not READ check-runs" can never be mistaken for
   * "there is no green check-run". That is precisely what the ported bash could
   * not promise, and it is what lets the preflight go (see `verifyTagCi`).
   *
   * ⚠️ PROVEN BY INSPECTION, NOT LIVE — and stated here so nobody upgrades that
   * to "tested". As of 2026-09-05 the 403/404 branch has never been executed
   * against GitHub. It cannot be, with any credential this repo holds: the two
   * endpoints only diverge for a token whose PERMISSIONS diverge. Measured while
   * trying to build that asymmetry without one — on a public repo both
   * `/commits/{sha}` and `/commits/{sha}/check-runs` answer 200 even fully
   * unauthenticated (`octocat/Hello-World`, `total_count: 3`), and an empty
   * bearer answers 401 to BOTH. A bad token dies in `resolveCommit`, one call
   * earlier, so it never reaches this line.
   *
   * WHAT WOULD PROVE IT: one `verifyTagCi` call with a token holding
   * `contents: read` and NOT `checks: read` — a fine-grained PAT with Contents
   * Read / Checks none, or an installation token of the `wildbit-ci-cd` App
   * minted with that set. The assertion is exact: it must get PAST resolution
   * and then die here with `::error title=Gate without data::… is 'checks: read'
   * missing from permissions?`. Any other outcome — above all a green verdict —
   * means this invariant was lost and the gate is decorative.
   */
  private async checkGreen(token: Secret, repo: string, sha: string, checkName: string, cacheBust: string): Promise<boolean> {
    const r = await this.request(token, `${API}/repos/${repo}/commits/${sha}/check-runs?per_page=100`, cacheBust)
    if (r.status !== 200) {
      const msg = `could not read check-runs of ${repo}@${sha} (HTTP ${r.status}) — is 'checks: read' missing from permissions?`
      console.error(this.annotation("error", msg, "Gate without data"))
      throw new Error(`github: ${msg} Body: ${r.body.slice(0, 400)}`)
    }
    const runs = (JSON.parse(r.body) as { check_runs?: { name: string; conclusion: string | null }[] }).check_runs ?? []
    return runs.some((c) => c.name === checkName && c.conclusion === "success")
  }

  /** Resolve a sha, branch or TAG NAME to a commit sha. */
  private async resolveCommit(token: Secret, repo: string, ref: string, cacheBust: string): Promise<string> {
    const r = await this.request(token, `${API}/repos/${repo}/commits/${encodeURIComponent(ref)}`, cacheBust)
    if (r.status !== 200) {
      throw new Error(`github: could not resolve '${ref}' to a commit in ${repo} (HTTP ${r.status}). For an ANNOTATED tag pass the tag NAME, not the object sha the ref points at — the commits API answers 422 for the latter. Body: ${r.body.slice(0, 300)}`)
    }
    const sha = (JSON.parse(r.body) as { sha?: string }).sha
    if (!sha) throw new Error(`github: the commits API answered 200 for '${ref}' in ${repo} without a sha — refusing to walk from an unknown commit`)
    return sha
  }

  /**
   * Ancestors of `sha`, newest first, `sha` included.
   *
   * Replaces the `git rev-list --max-count=N` of the ported bash. Both return
   * the reachable history in reverse-chronological order, so the walk visits the
   * same commits in the same order — but the API version needs no checkout, so
   * the gate no longer depends on the consumer remembering `fetch-depth: 0`.
   */
  private async ancestors(token: Secret, repo: string, sha: string, maxCommits: number, cacheBust: string): Promise<string[]> {
    const out: string[] = []
    for (let page = 1; out.length < maxCommits; page++) {
      const per = Math.min(100, maxCommits - out.length)
      const r = await this.request(token, `${API}/repos/${repo}/commits?sha=${sha}&per_page=${per}&page=${page}`, cacheBust)
      if (r.status !== 200) {
        throw new Error(`github: could not list the ancestors of ${repo}@${sha} (HTTP ${r.status}) — is 'contents: read' missing from permissions? Body: ${r.body.slice(0, 400)}`)
      }
      const batch = (JSON.parse(r.body) as { sha: string }[]).map((c) => c.sha)
      out.push(...batch)
      if (batch.length < per) break // history exhausted
    }
    return out.slice(0, maxCommits)
  }

  /**
   * Files changed between two commits, `base` exclusive.
   *
   * Replaces `git diff --name-only BASE SHA`. `compare/a...b` is a THREE-dot
   * diff (against the merge base) while `git diff a b` is a two-dot one, but
   * `base` here is by construction an ancestor of `head`, so the merge base IS
   * `base` and the two are the same set. Stated because the difference is real
   * and would matter if this were ever called with an unrelated base.
   *
   * The endpoint returns at most 300 files per page. Hitting the cap without
   * paging would silently hide the very file that has no CI, so it pages — and
   * a diff too large to enumerate fails closed rather than being declared
   * docs-only.
   */
  private async changedFiles(token: Secret, repo: string, base: string, head: string, cacheBust: string): Promise<string[]> {
    const files: string[] = []
    const maxPages = 10
    for (let page = 1; page <= maxPages; page++) {
      const r = await this.request(token, `${API}/repos/${repo}/compare/${base}...${head}?per_page=300&page=${page}`, cacheBust)
      if (r.status !== 200) {
        throw new Error(`github: could not compare ${base}...${head} in ${repo} (HTTP ${r.status}). Body: ${r.body.slice(0, 400)}`)
      }
      const batch = (JSON.parse(r.body) as { files?: { filename: string }[] }).files ?? []
      files.push(...batch.map((f) => f.filename))
      if (batch.length < 300) return files
    }
    throw new Error(`github: ${base}...${head} in ${repo} changed more than ${maxPages * 300} files, more than this gate can enumerate — failing closed rather than declaring an unenumerable diff docs-only`)
  }

  /**
   * One GitHub API call. Returns the status and the raw body; it does NOT judge
   * them, because what a 404 means differs per endpoint and only the caller
   * knows.
   *
   * `curl` writes the status with `-w` and the body to a file, and the script
   * prints the status on the first line: `--fail` would discard exactly the
   * error body that says which permission is missing.
   */
  private async request(token: Secret, url: string, cacheBust: string, method = "GET", bodyJson = ""): Promise<Response> {
    let c: Container = dag
      .container()
      .from(CURL_IMG)
      .withSecretVariable("GH_TOK", token)
      .withEnvVariable("URL", url)
      .withEnvVariable("METHOD", method)
      // Part of the exec's cache key and nothing else. See the module header:
      // without it Dagger replays a previous run's response and the call never
      // reaches GitHub.
      .withEnvVariable("CACHE_BUST", cacheBust)
    let data = ""
    if (bodyJson) {
      c = c.withNewFile("/tmp/body.json", bodyJson)
      data = "--data @/tmp/body.json"
    }
    const script =
      `set -e; ` +
      `code=$(curl -sS -o /tmp/out.json -w '%{http_code}' -X "$METHOD" ` +
      `-H "Authorization: Bearer $GH_TOK" ` +
      `-H 'Accept: application/vnd.github+json' ` +
      `-H 'X-GitHub-Api-Version: 2022-11-28' ${data} "$URL"); ` +
      `printf '%s\\n' "$code"; cat /tmp/out.json`
    let out: string
    try {
      out = await c.withExec(["sh", "-c", script]).stdout()
    } catch (e) {
      // A transport failure is not a verdict. Naming the URL here is what turns
      // "exec failed with exit code 1" into something actionable.
      throw new Error(`github: the call to ${url} could not be made (${(e as Error).message})`)
    }
    const nl = out.indexOf("\n")
    const status = Number(nl < 0 ? out.trim() : out.slice(0, nl).trim())
    if (!Number.isFinite(status) || status === 0) {
      throw new Error(`github: no HTTP status came back from ${url} — curl printed: ${out.slice(0, 200)}`)
    }
    return { status, body: nl < 0 ? "" : out.slice(nl + 1) }
  }
}
