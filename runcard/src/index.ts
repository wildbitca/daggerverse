/**
 * One live Slack card per workflow run — the orchestration `slack` deliberately
 * does not own.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 * `slack` is a client: it renders and posts a card, and its header says the
 * loop that keeps the card current belongs to each repo. That held while every
 * pipeline was ONE `dagger call` that could carry the loop inside it. It stopped
 * holding once pipelines became many jobs on many runners: no dagger call spans
 * them, so each repo would need the same ~200-line watcher. `pacha/app` wrote it
 * first (`pipelineCardLive`, 2026-09-16); this is that prototype, shared.
 *
 * ── THREE SHAPES, ONE CARD LOOK ─────────────────────────────────────────────
 *   · `watch`   multi-job workflows. A job with no `needs` polls the run's jobs
 *               through the GitHub API and rewrites the card as rows change.
 *   · `report`  single-job workflows, as the job's last step. One post at the
 *               end; the steps are the rows. No second runner is paid for.
 *   · `thread`  post detail under an existing card, found by its metadata. A
 *               Dagger call that used to open its own card posts here instead.
 *
 * ── IT NEVER WAITS FOR A HUMAN ──────────────────────────────────────────────
 * When all that is left of a run is jobs parked on an environment approval,
 * `watch` renders them as "awaiting approval", closes the card as `waiting` and
 * EXITS. Polling an approval held a runner for up to thirty minutes and was
 * retired on 2026-08-22 (ADR-0003 §2.3); approvals are the `deploy-gate` service's
 * job, and it threads its request under this card by the commit sha in the
 * card's metadata.
 *
 * ── THE CARD'S METADATA IS API ──────────────────────────────────────────────
 * `event_type` = the caller's `eventType`; `event_payload` carries `repo`, `sha`,
 * `run_id`, `run_attempt` and `status`. `thread` finds cards by the first three
 * of (event_type, run_id, run_attempt); `deploy-gate` finds them by `sha`;
 * `slack.readTrend` reads `repo` and the numbers. See `slack`'s `EventPayload`.
 *
 * ── NOTIFICATION IS BEST-EFFORT ─────────────────────────────────────────────
 * No function here fails a build because Slack or the API was slow. They throw
 * only on MISCONFIGURATION (bad JSON, a `selfJob` that matches nothing, a token
 * that cannot read the run) — the failures that would otherwise hold a runner
 * until the deadline and render a card that lies.
 */
import { dag, Secret, object, func } from "@dagger.io/dagger"

type ItemState = "pending" | "running" | "ok" | "fail" | "skip"
/** One card row, the shape `slack.render` takes. */
type Item = { name: string; st: ItemState; ms?: number; t0?: number; note?: string }

/** A job (or a step, adapted) as `github.runJobs` returns it. Only what rows read. */
type GhJob = {
  id?: number; name: string; status: string; conclusion: string | null; html_url?: string
  created_at?: string; started_at: string | null; completed_at: string | null
  labels?: string[]; runner_name?: string | null
  steps?: { number: number; name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null }[]
}

/** One row definition. `mode` defaults to `prefix`. */
type RowDef = { row: string; match: string; mode: "prefix" | "exact" }

const BAD = ["failure", "timed_out", "cancelled", "startup_failure"]
/** List prices per minute (USD) applied before the caller's map. Globs use `*`. */
const DEFAULT_PRICES: Record<string, number> = { "ubuntu-latest": 0.006, "macos-*": 0.062 }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fmtMin = (ms: number) => { const t = Math.round(Math.max(0, ms) / 1000); return `${Math.floor(t / 60)}m${String(t % 60).padStart(2, "0")}s` }

function parse<T>(raw: string, what: string): T | undefined {
  const t = (raw ?? "").trim()
  if (!t) return undefined
  try {
    return JSON.parse(t) as T
  } catch (e) {
    throw new Error(`runcard: '${what}' is not valid JSON (${(e as Error).message}). It travels as a JSON string; the caller does JSON.stringify.`)
  }
}

/** Parse and validate `rows`. An empty list is an error: a card with no rows reports nothing. */
function parseRows(raw: string, what = "rows"): RowDef[] {
  const v = parse<unknown>(raw, what)
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`runcard: '${what}' must be a non-empty JSON array of {row, match, mode}`)
  }
  return v.map((d, i) => {
    const o = d as Partial<RowDef>
    const row = String(o?.row ?? "").trim()
    const match = String(o?.match ?? row).trim()
    const mode = (o?.mode ?? "prefix") as string
    if (!row) throw new Error(`runcard: ${what}[${i}] has no 'row'`)
    if (!match) throw new Error(`runcard: ${what}[${i}] ('${row}') has an empty 'match' — it would claim every job`)
    if (mode !== "prefix" && mode !== "exact") throw new Error(`runcard: ${what}[${i}] ('${row}') mode '${mode}' is not prefix|exact`)
    return { row, match, mode }
  })
}

/** `name` is this job's name, or a reusable-workflow job's `caller / name`. */
function isNamed(jobName: string, name: string): boolean {
  return jobName === name || jobName.endsWith(` / ${name}`)
}

/**
 * Which row a job belongs to, or -1. THE MOST SPECIFIC ROW WINS: an exact match
 * beats any prefix, and a longer prefix beats a shorter one; ties go to the
 * earlier row. Without this a job matched by two rows is counted twice — `Build`
 * and `Build — iOS` both claiming the iOS build — and a failure paints two rows red.
 */
function rowIndexFor(defs: RowDef[], jobName: string): number {
  let best = -1
  let bestScore = -1
  defs.forEach((d, i) => {
    let score = -1
    if (d.mode === "exact" && jobName === d.match) score = 1_000_000
    else if (d.mode === "prefix" && jobName.startsWith(d.match)) score = d.match.length
    if (score > bestScore) { best = i; bestScore = score }
  })
  return best
}

/**
 * Fold the jobs behind one row (one job, or every leg of a matrix) into that row.
 *
 *   · nothing listed yet        → pending (a job whose `needs` are running is not listed)
 *   · all completed             → fail if any leg failed/timed out/was cancelled/never
 *                                 started; skip if every leg was skipped; else ok
 *   · only completed + waiting  → pending, "awaiting approval"
 *   · one in progress           → running, with the step for a single job
 *   · otherwise                 → pending "queued" (or fail if a leg already failed)
 */
function rowFromJobs(name: string, js: GhJob[]): Item {
  if (js.length === 0) return { name, st: "pending" }
  const done = js.filter((j) => j.status === "completed")
  const bad = done.filter((j) => BAD.includes(j.conclusion ?? ""))
  const starts = js.map((j) => Date.parse(j.started_at ?? "")).filter((x) => x > 0)
  const ends = done.map((j) => Date.parse(j.completed_at ?? "")).filter((x) => x > 0)
  const ms = starts.length && done.length === js.length && ends.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : undefined
  const legs = js.length > 1 ? `${done.length}/${js.length}` : ""
  if (done.length === js.length) {
    if (bad.length) {
      const cancelledOnly = bad.every((j) => j.conclusion === "cancelled")
      const why = bad.some((j) => j.conclusion === "startup_failure") ? "startup failure" : cancelledOnly ? "cancelled" : ""
      const note = [legs ? `${bad.length} of ${js.length} failed` : "", why].filter(Boolean).join(" · ")
      return { name, st: "fail", ms, note: note || undefined }
    }
    if (done.every((j) => j.conclusion === "skipped")) return { name, st: "skip" }
    return { name, st: "ok", ms, note: legs || undefined }
  }
  if (js.every((j) => j.status === "completed" || j.status === "waiting")) {
    return { name, st: bad.length ? "fail" : "pending", note: bad.length ? `${bad.length} failed · awaiting approval` : "awaiting approval" }
  }
  const running = js.find((j) => j.status === "in_progress")
  if (!running) return { name, st: bad.length ? "fail" : "pending", note: [legs, bad.length ? `${bad.length} failed` : "queued"].filter(Boolean).join(" · ") }
  const step = (running.steps ?? []).find((s) => s.status === "in_progress")
  const note = [legs, js.length === 1 && step ? step.name : "", bad.length ? `${bad.length} failed` : ""].filter(Boolean).join(" · ")
  return { name, st: "running", t0: starts.length ? Math.min(...starts) : undefined, note: note || undefined }
}

/** Rows for a set of jobs, in `defs` order. `selfJob` is excluded. */
function computeRows(defs: RowDef[], jobs: GhJob[], selfJob = ""): Item[] {
  const buckets: GhJob[][] = defs.map(() => [])
  for (const j of jobs) {
    if (selfJob && isNamed(j.name, selfJob)) continue
    const i = rowIndexFor(defs, j.name)
    if (i >= 0) buckets[i].push(j)
  }
  return defs.map((d, i) => rowFromJobs(d.row, buckets[i]))
}

/** Price per minute for a runner label: exact entry first, then the first matching glob. */
function priceFor(prices: Record<string, number>, label: string): number | undefined {
  if (prices[label] !== undefined) return prices[label]
  for (const [k, v] of Object.entries(prices)) {
    if (!k.includes("*")) continue
    const re = new RegExp("^" + k.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$")
    if (re.test(label)) return v
  }
  return undefined
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function refName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "").replace(/^refs\/pull\/(\d+)\/merge$/, "PR #$1")
}

/** Treat an absent OR empty Secret as absent (see the daggerverse README). */
async function present(s?: Secret): Promise<boolean> {
  if (!s) return false
  try {
    return (await s.plaintext()).trim() !== ""
  } catch {
    return false
  }
}

function assertEventType(eventType: string): void {
  if (!/^[a-z0-9_]+$/.test(eventType)) {
    throw new Error(`runcard: eventType '${eventType}' must match ^[a-z0-9_]+$ — Slack drops metadata that does not, and the card can then never be found again`)
  }
}

@object()
export class Runcard {
  /**
   * Keep one card live for a multi-job run. Returns `ok`, `fail`, `waiting`, or
   * `skipped` when there is no Slack token/channel (Dependabot, fork PRs).
   *
   * Run it in a job with NO `needs`, `continue-on-error: true`, and a
   * `timeout-minutes` above `deadlineMinutes`. It polls every `pollSeconds`,
   * posts each failed job once to the thread (failing step, annotations, log
   * tail), and closes with statistics. It exits — never waits — once only
   * approval-gated jobs remain.
   *
   * @param rows JSON `[{row, match, mode}]` in card order. `match` is a job name
   *   (`exact`) or its prefix (`prefix`, the default, which aggregates a matrix
   *   as n/m). When two rows match one job the most specific wins.
   * @param selfJob the exact `name:` of the job running this watcher. Required:
   *   a watcher that counts itself never sees the run finish and holds its
   *   runner to the deadline, so a name that matches no job is an error.
   * @param eventType Slack metadata `event_type`, ^[a-z0-9_]+$, e.g. `pipeline_app`.
   *   Also the trend series `readTrend` compares against.
   * @param workflowFile file name for the median (`pipeline.yml`); empty skips it.
   * @param branch branch the median is taken on; empty means all branches.
   * @param runnerPrices JSON `{label: usdPerMinute}` merged over the defaults
   *   (`ubuntu-latest` 0.006, `macos-*` 0.062). `*` globs are allowed.
   * @param githubToken needs `actions: read` and `checks: read` on `repo`.
   * @param slackToken omit the flag when there is no token; an empty one is treated the same.
   */
  @func({ cache: "never" })
  async watch(
    repo: string, ref: string, sha: string, actor: string, event: string,
    runId: string, runNumber: string, runAttempt: string, server: string,
    rows: string, selfJob: string, eventType: string,
    githubToken: Secret, slackChannel: string,
    slackToken?: Secret,
    workflowFile = "", branch = "", msg = "", title = "", runnerPrices = "",
    pollSeconds = 30, deadlineMinutes = 100,
  ): Promise<string> {
    if (!slackChannel.trim() || !(await present(slackToken))) return "skipped"
    const token = slackToken as Secret
    const defs = parseRows(rows)
    assertEventType(eventType)
    if (!selfJob.trim()) throw new Error("runcard: 'selfJob' is empty — the watcher would count itself and never see the run finish")
    const prices = { ...DEFAULT_PRICES, ...(parse<Record<string, number>>(runnerPrices, "runnerPrices") ?? {}) }
    const meta = { repo, ref, sha, actor, event, runId, runNumber, runAttempt, server, msg: msg || sha.slice(0, 12) }
    const cardTitle = title || `${repo} · ${refName(ref)}`
    const slack = dag.slack()
    const gh = dag.github()
    let polls = 0
    const bust = () => `${runId}:${runAttempt}:${++polls}:${Date.now()}`

    const trend = await slack.readTrend(token, slackChannel, eventType, repo, bust())
    const t0 = Date.now()
    let runStart = t0
    const render = (status: string, items: Item[]) => slack.render(
      cardTitle, status, JSON.stringify(meta), JSON.stringify(items), Math.max(0, Date.now() - runStart), eventType, { metrics: "", trend },
    )
    let items: Item[] = defs.map((d) => ({ name: d.row, st: "pending" }))
    let ts = await slack.post(token, slackChannel, await render("running", items))

    const reported = new Set<number>()
    const deadline = t0 + deadlineMinutes * 60_000
    let lastKey = ""
    let idlePolls = 0
    let errors = 0
    let seenOnce = false
    let outcome: "done" | "approval" | "deadline" | "blind" = "deadline"
    let all: GhJob[] = []

    while (Date.now() < deadline) {
      let fresh: GhJob[] | undefined
      try {
        fresh = JSON.parse(await gh.runJobs(githubToken, repo, runId, runAttempt, bust())) as GhJob[]
        errors = 0
      } catch (e) {
        errors++
        console.error(`runcard: poll ${polls} failed:`, e)
        // Never read the run at all: a permission or a wrong repo, not a blip.
        // Holding the runner to the deadline would hide it for 100 minutes.
        if (!seenOnce || errors >= 5) { outcome = "blind"; break }
      }
      if (fresh) {
        all = fresh
        if (!seenOnce) {
          seenOnce = true
          if (!all.some((j) => isNamed(j.name, selfJob))) {
            const names = all.map((j) => j.name).join(", ")
            await slack.threadReply(token, slackChannel, ts, `runcard misconfigured: selfJob '${selfJob}' matches no job of this run (${names}).`)
            await slack.post(token, slackChannel, await render("fail", items.map((i) => ({ ...i, note: "watcher misconfigured" }))), { ts })
            throw new Error(`runcard: selfJob '${selfJob}' matches no job in run ${runId} (jobs: ${names}) — the watcher would wait on itself until the deadline`)
          }
          const self = all.find((j) => isNamed(j.name, selfJob))
          // The run's start is the earliest job creation the API reports; it
          // includes the queue time a person waiting for the run experienced.
          const created = all.map((j) => Date.parse(j.created_at ?? "")).filter((x) => x > 0)
          if (created.length) runStart = Math.min(runStart, ...created)
          if (self?.started_at) runStart = Math.min(runStart, Date.parse(self.started_at) || runStart)
        }
      }
      const jobs = all.filter((j) => !isNamed(j.name, selfJob))
      items = computeRows(defs, jobs)

      if (!ts) ts = await slack.post(token, slackChannel, await render("running", items))
      for (const j of jobs) {
        if (j.id && j.status === "completed" && BAD.includes(j.conclusion ?? "") && j.conclusion !== "cancelled" && !reported.has(j.id)) {
          reported.add(j.id)
          await this.postJobFailure(githubToken, token, slackChannel, ts, repo, j, bust())
        }
      }

      const key = JSON.stringify(items.map((i) => [i.st, i.note]))
      if (key !== lastKey && ts) {
        lastKey = key
        await slack.post(token, slackChannel, await render("running", items), { ts })
      }

      const open = jobs.filter((j) => j.status !== "completed")
      if (fresh && open.length === 0) {
        idlePolls++
        // A job whose `needs` are still running is not listed yet, so "nothing
        // open" is final only once every row has a job, or after three quiet
        // polls (a row whose job is never created: an `if:` on a tag-only job).
        const allRowsSeen = defs.every((_, i) => jobs.some((j) => rowIndexFor(defs, j.name) === i))
        if (allRowsSeen || idlePolls >= 3) { outcome = "done"; break }
      } else if (open.length > 0) {
        idlePolls = 0
        if (open.every((j) => j.status === "waiting")) { outcome = "approval"; break }
      }
      await sleep(pollSeconds * 1000)
    }

    items = items.map((i): Item => {
      if (i.st !== "pending" && i.st !== "running") return i
      switch (outcome) {
        case "done": return { ...i, st: "skip", note: i.note === "queued" ? "not run" : i.note }
        // Rows downstream of the gate were never created. They are not failures:
        // they have simply not been decided yet.
        case "approval": return i.note === "awaiting approval" ? i : { name: i.name, st: "pending", note: "after approval" }
        case "blind": return { ...i, st: "fail", note: "watcher could not read the run" }
        default: return { ...i, st: "fail", note: "watcher deadline" }
      }
    })
    const failed = items.some((i) => i.st === "fail")
    const status = failed ? "fail" : outcome === "approval" ? "waiting" : "ok"
    const elapsed = Math.max(0, Date.now() - runStart)
    if (ts) {
      await slack.post(token, slackChannel, await render(status, items), { ts })
    } else {
      ts = await slack.post(token, slackChannel, await render(status, items))
    }
    await slack.breakdown(token, slackChannel, ts, status, JSON.stringify(items), elapsed, { metrics: "", trend })
    const stats = await this.runStats(githubToken, repo, runId, all, selfJob, runStart, outcome, prices, workflowFile, branch, bust())
    await slack.threadReply(token, slackChannel, ts, stats)
    return status
  }

  /**
   * One final card for a SINGLE-JOB workflow, from that job's last step.
   * Returns `ok`, `fail` or `skipped`.
   *
   * Call it with `if: always()` and `--job-status=${{ job.status }}`. The rows
   * are the job's steps as the API reports them at that moment: completed steps
   * only, without the runner's own `Set up job` / `Post …` / `Complete job`. The
   * log is not published until the job completes, so a failure's thread carries
   * the failing step and annotations plus a link, not a log tail.
   *
   * @param jobStatus `${{ job.status }}`: success | failure | cancelled.
   * @param jobName the job's `name:`; empty works when the run has exactly one job.
   * @param rows optional JSON `[{row, match, mode}]` matched against STEP names,
   *   to group or rename steps. Empty means one row per step.
   */
  @func({ cache: "never" })
  async report(
    repo: string, ref: string, sha: string, actor: string, event: string,
    runId: string, runNumber: string, runAttempt: string, server: string,
    jobStatus: string, eventType: string,
    githubToken: Secret, slackChannel: string,
    slackToken?: Secret,
    jobName = "", rows = "", msg = "", title = "",
  ): Promise<string> {
    if (!slackChannel.trim() || !(await present(slackToken))) return "skipped"
    const token = slackToken as Secret
    assertEventType(eventType)
    if (!["success", "failure", "cancelled"].includes(jobStatus)) {
      throw new Error(`runcard: jobStatus '${jobStatus}' is not success|failure|cancelled — pass \${{ job.status }}`)
    }
    const defs = rows.trim() ? parseRows(rows) : undefined
    const slack = dag.slack()
    const bust = `${runId}:${runAttempt}:report:${Date.now()}`

    let jobs: GhJob[] = []
    try {
      jobs = JSON.parse(await dag.github().runJobs(githubToken, repo, runId, runAttempt, bust)) as GhJob[]
    } catch (e) {
      console.error("runcard: report could not read the run; posting without steps:", e)
    }
    let job: GhJob | undefined
    if (jobName.trim()) job = jobs.find((j) => isNamed(j.name, jobName.trim()))
    else if (jobs.length === 1) job = jobs[0]
    if (jobs.length && !job) {
      throw new Error(`runcard: cannot tell which job is reporting — ${jobName ? `'${jobName}' matches none of` : "pass jobName; the run has"} ${jobs.map((j) => j.name).join(", ")}`)
    }

    const runnerStep = /^(Set up job|Complete job|Post .*)$/
    const steps: GhJob[] = (job?.steps ?? [])
      .filter((s) => s.status === "completed" && !runnerStep.test(s.name))
      .map((s) => ({ name: s.name, status: s.status, conclusion: s.conclusion, started_at: s.started_at, completed_at: s.completed_at }))
    const stepDefs: RowDef[] = defs ?? steps.map((s) => ({ row: s.name, match: s.name, mode: "exact" as const }))
    let items = stepDefs.length ? computeRows(stepDefs, steps) : []
    // A step matched by no job-status row is invisible; the job status is the truth.
    const status = jobStatus === "success" ? "ok" : "fail"
    if (status === "fail" && !items.some((i) => i.st === "fail")) {
      items = [...items, { name: job?.name ?? "job", st: "fail", note: jobStatus }]
    }
    items = items.map((i) => (i.st === "pending" || i.st === "running" ? { ...i, st: "skip" as ItemState, note: "not run" } : i))

    const started = Date.parse(job?.started_at ?? "") || Date.now()
    const meta = { repo, ref, sha, actor, event, runId, runNumber, runAttempt, server, msg: msg || sha.slice(0, 12) }
    const trend = await slack.readTrend(token, slackChannel, eventType, repo, bust)
    const body = await slack.render(title || `${repo} · ${refName(ref)}`, status, JSON.stringify(meta), JSON.stringify(items), Math.max(0, Date.now() - started), eventType, { metrics: "", trend })
    const ts = await slack.post(token, slackChannel, body)
    if (status === "fail" && ts && job?.id) {
      await this.postJobFailure(githubToken, token, slackChannel, ts, repo, job, bust, false)
    }
    return status
  }

  /**
   * Reply in the thread of a run's card. Returns the reply's `ts`, or "" when
   * no card was found in time (best-effort: never throws on Slack errors).
   *
   * The card is found by metadata — `eventType` + `runId` (+ `runAttempt`) — so
   * a Dagger call in any job of the run can post its inner detail (a test
   * breakdown, a failing flow) under the watcher's card instead of opening a
   * second one. It retries for `waitSeconds`, because the job calling it may
   * start before the watcher has posted.
   *
   * @param blocks optional JSON Block Kit array; `text` is then the notification fallback.
   * @param runAttempt empty matches the newest card of any attempt.
   * @param slackChannel the channel ID (`C…`); history lookups reject names.
   */
  @func({ cache: "never" })
  async thread(
    slackChannel: string, eventType: string, runId: string, text: string,
    slackToken?: Secret, runAttempt = "", blocks = "", waitSeconds = 60,
  ): Promise<string> {
    if (!slackChannel.trim() || !(await present(slackToken))) return ""
    const ts = await this.cardTs(slackChannel, eventType, runId, slackToken, runAttempt, waitSeconds)
    if (!ts) {
      console.error(`runcard: no '${eventType}' card for run ${runId}${runAttempt ? ` attempt ${runAttempt}` : ""} — detail not posted`)
      return ""
    }
    return await dag.slack().threadReply(slackToken as Secret, slackChannel, ts, text, { blocks })
  }

  /**
   * The `ts` of a run's card, or "". For callers that want `slack.breakdown` or
   * `slack.failureDetail` under the card rather than a plain reply.
   */
  @func({ cache: "never" })
  async cardTs(
    slackChannel: string, eventType: string, runId: string,
    slackToken?: Secret, runAttempt = "", waitSeconds = 60,
  ): Promise<string> {
    if (!slackChannel.trim() || !(await present(slackToken))) return ""
    assertEventType(eventType)
    const until = Date.now() + Math.max(0, waitSeconds) * 1000
    for (let i = 0; ; i++) {
      const ts = await dag.slack().findCard(slackToken as Secret, slackChannel, eventType, runId, `${runId}:${runAttempt}:find:${i}:${Date.now()}`, { runAttempt, limit: 200 })
      if (ts || Date.now() >= until) return ts
      await sleep(10_000)
    }
  }

  /**
   * The row logic, exposed pure so it can be tested on fixtures. Returns JSON `Item[]`.
   *
   * @param jobs JSON `GhJob[]` — `github.runJobs` output or a fixture.
   * @param rows JSON `[{row, match, mode}]`.
   * @param selfJob a job name to exclude, as `watch` does.
   */
  @func()
  cardRows(jobs: string, rows: string, selfJob = ""): string {
    const js = parse<GhJob[]>(jobs, "jobs")
    if (!Array.isArray(js)) throw new Error("runcard: 'jobs' must be a JSON array")
    return JSON.stringify(computeRows(parseRows(rows), js, selfJob))
  }

  /** Posts one failed job to the thread: failing step, annotations and (when published) the log tail. */
  private async postJobFailure(
    githubToken: Secret, slackToken: Secret, channel: string, ts: string, repo: string, j: GhJob, bust: string, withLog = true,
  ): Promise<void> {
    try {
      let step = (j.steps ?? []).find((s) => s.conclusion === "failure")?.name ?? ""
      let ann = ""
      let tail = ""
      let note = ""
      if (j.conclusion !== "startup_failure") {
        const f = JSON.parse(await dag.github().jobFailure(githubToken, repo, String(j.id), `${bust}:${j.id}`)) as {
          failedStep: string; annotations: { level: string; title: string; message: string }[]; logTail: string; logNote: string
        }
        step = f.failedStep || step
        ann = f.annotations.slice(0, 5).map((a) => `• ${a.title ? `${a.title}: ` : ""}${a.message}`.slice(0, 400)).join("\n")
        tail = withLog ? f.logTail : ""
        note = withLog ? f.logNote : ""
      }
      const text = [
        `*${j.name}* ${j.conclusion === "timed_out" ? "timed out" : j.conclusion === "startup_failure" ? "failed to start" : "failed"}${step ? ` at step *${step}*` : ""} — ${j.html_url ?? ""}`,
        ann,
        tail ? "```" + tail + "```" : "",
        note ? `_${note}_` : "",
      ].filter(Boolean).join("\n")
      await dag.slack().threadReply(slackToken, channel, ts, text)
    } catch (e) {
      console.error("runcard: posting a job failure failed:", e)
    }
  }

  /** The closing statistics: wall clock vs the median, queue time, runner minutes and cost. */
  private async runStats(
    githubToken: Secret, repo: string, runId: string, jobs: GhJob[], selfJob: string, runStart: number,
    outcome: string, prices: Record<string, number>, workflowFile: string, branch: string, bust: string,
  ): Promise<string> {
    const now = Date.now()
    const wall = now - runStart
    let queue = 0
    const byRunner: Record<string, { mins: number; cost?: number }> = {}
    for (const j of jobs) {
      if (!j.started_at || j.conclusion === "skipped") continue
      const s = Date.parse(j.started_at)
      // The watcher is still running when it counts itself; it bills too.
      const c = j.completed_at ? Date.parse(j.completed_at) : isNamed(j.name, selfJob) ? now : NaN
      if (!s || !Number.isFinite(c)) continue
      const q = Date.parse(j.created_at ?? "")
      if (q && s > q) queue += s - q
      const labels = j.labels ?? []
      const label = labels.find((l) => priceFor(prices, l) !== undefined) ?? labels[0] ?? "unknown"
      // GitHub bills each job rounded up to the minute, so round per job, not per label.
      const mins = Math.ceil(Math.max(0, c - s) / 60_000)
      const p = priceFor(prices, label)
      const e = byRunner[label] ?? { mins: 0 }
      e.mins += mins
      if (p !== undefined) e.cost = (e.cost ?? 0) + mins * p
      byRunner[label] = e
    }
    const cost = Object.values(byRunner).reduce((a, e) => a + (e.cost ?? 0), 0)
    const runnerLines = Object.entries(byRunner).map(([label, e]) => `  ${label}: ${e.mins} min${e.cost !== undefined ? ` (~$${e.cost.toFixed(2)})` : " (no price)"}`)

    let medianLine = ""
    if (workflowFile) {
      try {
        const runs = JSON.parse(await dag.github().workflowRunDurations(githubToken, repo, workflowFile, branch, 10, `${bust}:durations`)) as { id: number; ms: number }[]
        const durs = runs.filter((r) => String(r.id) !== runId).map((r) => r.ms)
        const m = median(durs)
        if (m !== undefined) medianLine = ` — median of the last ${durs.length} green runs${branch ? ` on ${branch}` : ""}: ${fmtMin(m)}`
      } catch (e) {
        console.error("runcard: median unavailable:", e)
      }
    }
    return [
      `*Run statistics* (${outcome === "approval" ? "stopped at an approval gate" : outcome === "deadline" ? "watcher deadline reached" : outcome === "blind" ? "watcher could not read the run" : "complete"})`,
      `wall clock: ${fmtMin(wall)}${medianLine}`,
      `queued: ${fmtMin(queue)} summed over jobs`,
      `runner time:`,
      ...runnerLines,
      `estimated cost at list price: ~$${cost.toFixed(2)} (included minutes and public repositories are not deducted)`,
    ].join("\n")
  }
}
