/**
 * Slack progress engine — shared across every pipeline in the organisation.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 * This code used to live vendored byte-for-byte in three modules (`pacha`,
 * `pacha-api`, `pacha-site`), 363 lines each, and the only thing keeping the
 * copies equal was an md5 recorded in `.engine-parity`. On 2026-09-04 that guard
 * found a real divergence that had been there for months: `pacha` carried one
 * extra line nobody had mirrored. Twelve months of a convention held up by a note.
 *
 * ── WHY IT IS A CLIENT AND NOT AN ORCHESTRATOR ──────────────────────────────
 * The vendored version exposed one `run(title, meta, items, …, body)` that took
 * the whole pipeline as an async CALLBACK. That shape cannot cross a module
 * boundary: a Dagger function is a GraphQL call, and a TypeScript closure is not
 * serialisable. So the split is:
 *
 *   · here            everything that is genuinely the same everywhere — Block Kit
 *                     rendering, the trend read, the breakdown, the HTTP calls.
 *   · in each repo    a ~40-line loop holding `items`, `startedAt`, `metrics` and
 *                     `ts`, which is where the orchestration actually differs.
 *
 * Duplication therefore drops from 363 lines to ~40, not to zero. Claiming zero
 * would be claiming something this interface cannot deliver.
 *
 * The one loop that turned out to be the same everywhere — a watcher that keeps
 * one card per multi-job workflow run — lives in the `runcard` module, which
 * depends on this one. This module stays a client.
 *
 * ── WHAT IS DELIBERATELY NOT PORTED ─────────────────────────────────────────
 * `approveProd` — the production approval gate that used to poll Slack from
 * inside Dagger. It was retired on 2026-08-22 (ADR-0003 §2.3) and replaced by a
 * GitHub deployment protection rule served by the `deploy-gate` service, because
 * polling held a self-hosted runner busy for up to 30 minutes waiting for a
 * click. Verified on 2026-09-05: `ctx.gate` is called by NO pipeline in any of
 * the three repos, so it is dead code in all of them.
 *
 * Porting it here would take that retired second path to production and make it
 * freshly callable by four repos at once — which is exactly the debt ADR-0003
 * §7.1 named and the 2026-08-22 migration closed. ONE PATH TO PRODUCTION.
 *
 * ── COMPLEX ARGUMENTS TRAVEL AS JSON STRINGS ────────────────────────────────
 * Dagger's TypeScript SDK exposes structural types poorly across a module
 * boundary, and a shape mismatch there fails at call time with an unreadable
 * error. Every non-scalar crosses as a JSON string, and the shapes are documented
 * on each function. The caller does `JSON.stringify`; this module parses and
 * validates.
 */
import { dag, Secret, Container, object, func } from "@dagger.io/dagger"

const CURL_IMG = "curlimages/curl:8.21.0"
const POLL_IMG = "alpine:3.24" // curl+jq (via apk) to read history/replies from Slack

type ItemState = "pending" | "running" | "ok" | "fail" | "skip"
const EMOJI: Record<ItemState, string> = { pending: "⏳", running: "🔄", ok: "✅", fail: "❌", skip: "⏭️" }
const COLOR = { running: "#dbab09", waiting: "#1d9bd1", ok: "#2eb67d", fail: "#e01e5a" } as const

/** One checklist row. `ms` measured duration, `note` the per-item detail line. */
type Item = { name: string; st: ItemState; ms?: number; t0?: number; note?: string }

/**
 * Build context. `server` is the GitHub server URL, `msg` the commit message.
 * `runAttempt` is optional for callers written against v0.1.0; without it the
 * card's metadata cannot tell a re-run's card from the first attempt's.
 */
type Meta = {
  repo: string; ref: string; sha: string; actor: string; event: string
  runId: string; runNumber: string; server: string; msg: string; runAttempt?: string
}

/** Test totals, from each runner's NATIVE reporter — never parsed from human output. */
type TestMetrics = {
  total: number; passed: number; failed: number; skipped: number; suites: number
  perFile: { file: string; pass: number; fail: number }[]; failedNames: string[]
}

type Trend = { total_ms: number; scenarios: number; passed: number; failed: number; gates_ok: number; gates_total: number }
/**
 * The card's `metadata.event_payload`. It is read by three parties, so it is API:
 *   · `readTrend` on the next run (`repo`, the numbers),
 *   · `findCard` / `runcard.thread` to locate a run's card (`run_id`, `run_attempt`),
 *   · the `deploy-gate` service, which threads its approval request under the
 *     newest top-level message whose `sha` matches the deployment's commit.
 * Renaming or dropping any of these fields breaks one of them silently.
 */
type EventPayload = { repo: string; sha: string; run_id: string; run_attempt: string; status: string; total_ms: number; scenarios: number; passed: number; failed: number; gates_ok: number; gates_total: number }
/**
 * `waiting` is a run parked on a human (an environment approval): nothing has
 * failed, nothing is running, and the watcher has left. Rendering that as
 * `running` leaves a spinner that never stops; as `ok` it claims a deploy that
 * has not happened.
 */
type Status = "running" | "waiting" | "ok" | "fail"

function fmt(ms?: number): string {
  if (ms === undefined) return ""
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, "0")}s`
}

function statsLine(items: Item[], m: TestMetrics | undefined, trend: Trend | undefined, elapsedMs: number): string {
  const gatesTotal = items.length
  const gatesOk = items.filter((i) => i.st === "ok").length
  const parts = [`⏱️ ${fmt(elapsedMs)}`]
  if (trend) {
    const d = elapsedMs - trend.total_ms
    parts.push(`${d === 0 ? "±" : d < 0 ? "↓" : "↑"}${fmt(Math.abs(d))} vs previous`)
    if (m) { const ds = m.total - trend.scenarios; if (ds !== 0) parts.push(`${ds > 0 ? "+" : ""}${ds} scen`) }
  }
  parts.push(`🚦 ${gatesOk}/${gatesTotal} gates`)
  if (m) parts.push(`🧪 ${m.passed}/${m.total} scenarios`)
  return parts.join("  ·  ")
}

/**
 * Parse a JSON argument, naming the parameter in the error.
 *
 * A silent `{}` on a malformed payload would render an empty card and report
 * nothing wrong — the failure mode this whole engine exists to avoid. An empty
 * string is the documented "absent" value and is the only thing that yields
 * `undefined`.
 */
function parse<T>(raw: string, what: string): T | undefined {
  const t = (raw ?? "").trim()
  if (!t) return undefined
  try {
    return JSON.parse(t) as T
  } catch (e) {
    throw new Error(`slack: '${what}' is not valid JSON (${(e as Error).message}). It travels as a JSON string; the caller does JSON.stringify.`)
  }
}

function asStatus(s: string): Status {
  if (s === "running" || s === "waiting" || s === "ok" || s === "fail") return s
  throw new Error(`slack: status '${s}' is not one of running|waiting|ok|fail`)
}

@object()
export class Slack {
  /**
   * Post or edit the progress card. Returns the message `ts`.
   *
   * With an empty `ts` it posts (`chat.postMessage`); with one it edits in place
   * (`chat.update`). ONE message per run, edited — not a thread of new messages.
   *
   * Best-effort by contract: a Slack outage logs and returns the `ts` it was
   * given, and NEVER brings the pipeline down. A notification channel that can
   * fail the build is a notification channel that gets removed.
   *
   * @param body JSON of the Slack message body — what `render` returns.
   * @param ts   message to edit; empty posts a new one.
   */
  @func({ cache: "never" })
  async post(token: Secret, channel: string, body: string, ts = ""): Promise<string> {
    const parsed = parse<Record<string, unknown>>(body, "body")
    if (!parsed) return ts
    const method = ts ? "chat.update" : "chat.postMessage"
    const payload: Record<string, unknown> = { channel, ...parsed }
    if (ts) payload.ts = ts
    try {
      const out = await dag
        .container()
        .from(CURL_IMG)
        .withSecretVariable("TOK", token)
        .withNewFile("/body.json", JSON.stringify(payload))
        .withExec(["sh", "-c", `curl -sS -X POST https://slack.com/api/${method} -H "Authorization: Bearer $TOK" -H 'Content-type: application/json; charset=utf-8' --data @/body.json`])
        .stdout()
      const j = JSON.parse(out) as { ok?: boolean; ts?: string; error?: string }
      if (!j.ok) console.error(`slack ${method} error: ${j.error}`)
      return j.ts || ts
    } catch (e) {
      console.error("slack call failed:", e)
      return ts
    }
  }

  /**
   * Render the progress card. Pure — no container, no network.
   *
   * The returned JSON carries `metadata.event_type` + `event_payload`, which is
   * what `readTrend` reads on the NEXT run: Slack itself is the trend store, so
   * there is no database to run.
   *
   * @param status    running | waiting | ok | fail
   * @param meta      JSON Meta
   * @param items     JSON Item[]
   * @param metrics   JSON TestMetrics, or "" when the suite has not reported yet
   * @param trend     JSON Trend from the previous run, or ""
   * @param elapsedMs milliseconds since the run started, measured by the caller
   * @param eventType trend series key — MUST match /^[a-z0-9_]+$/ (Slack rejects the rest)
   */
  @func()
  render(
    title: string,
    status: string,
    meta: string,
    items: string,
    elapsedMs: number,
    eventType: string,
    metrics = "",
    trend = "",
  ): string {
    const st = asStatus(status)
    const m = parse<Meta>(meta, "meta") ?? { repo: "", ref: "", sha: "", actor: "", event: "", runId: "", runNumber: "", server: "https://github.com", msg: "" }
    const its = parse<Item[]>(items, "items") ?? []
    const tm = parse<TestMetrics>(metrics, "metrics")
    const tr = parse<Trend>(trend, "trend")
    // Validated here and not left to Slack: an event_type outside this class is
    // accepted by chat.postMessage and then silently absent from the metadata,
    // so the trend goes quiet with no error anywhere (Gotcha 9).
    if (!/^[a-z0-9_]+$/.test(eventType)) {
      throw new Error(`slack: eventType '${eventType}' must match ^[a-z0-9_]+$ — Slack drops metadata that does not, and the trend then goes silently missing`)
    }
    const payload: EventPayload = {
      repo: m.repo, sha: m.sha ?? "", run_id: m.runId ?? "", run_attempt: m.runAttempt ?? "", status: st,
      total_ms: elapsedMs,
      scenarios: tm?.total ?? 0, passed: tm?.passed ?? 0, failed: tm?.failed ?? 0,
      gates_ok: its.filter((i) => i.st === "ok").length, gates_total: its.length,
    }
    const label = st === "ok" ? "OK" : st === "fail" ? "FAILED" : st === "waiting" ? "awaiting approval" : "running"
    const emoji = st === "ok" ? "🟢" : st === "fail" ? "🔴" : st === "waiting" ? "⏸️" : "🔄"
    const checklist = its
      .map((i) => `${EMOJI[i.st]} ${i.name}${i.ms !== undefined ? `  ·  ${fmt(i.ms)}` : ""}${i.note ? `  —  ${i.note}` : ""}`)
      .join("\n")
    const short = m.sha ? m.sha.slice(0, 7) : "?"
    const subject = (m.msg || "").split("\n")[0]
    const repoUrl = `${m.server}/${m.repo}`
    const fields = [
      { type: "mrkdwn", text: `*Repo:*\n<${repoUrl}|${m.repo || "?"}>` },
      { type: "mrkdwn", text: `*Branch:*\n<${repoUrl}/tree/${m.ref}|\`${m.ref || "?"}\`>` },
      { type: "mrkdwn", text: `*Commit:*\n<${repoUrl}/commit/${m.sha}|\`${short}\`>${subject ? `  ${subject}` : ""}` },
      { type: "mrkdwn", text: `*Author:*\n<${m.server}/${m.actor}|${m.actor || "?"}>` },
    ]
    const blocks: unknown[] = [
      { type: "header", text: { type: "plain_text", text: `${emoji} ${title} — ${label}`, emoji: true } },
      { type: "section", fields },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: checklist } },
      { type: "context", elements: [{ type: "mrkdwn", text: statsLine(its, tm, tr, elapsedMs) }] },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Trigger: \`${m.event || "?"}\`${m.runNumber ? `  ·  run #${m.runNumber}${m.runAttempt && m.runAttempt !== "1" ? ` (attempt ${m.runAttempt})` : ""}` : ""}  ·  <${repoUrl}/actions/runs/${m.runId}|View run ↗>` }],
      },
    ]
    return JSON.stringify({
      text: `${title} — ${label}  (${m.repo}@${m.ref})`,
      attachments: [{ color: COLOR[st], blocks }],
      metadata: { event_type: eventType, event_payload: payload },
    })
  }

  /**
   * Read the previous run's metrics from Slack — the trend store is Slack itself.
   *
   * Matches on `event_type` AND `repo`: `event_type` alone was not enough once
   * two lanes of the same repo shared a series, and the comparison silently
   * compared a five-emulator e2e against a Simulator build and printed a
   * perfectly plausible, false "↑12m vs previous".
   *
   * `cacheBust` MUST vary per run (use the run id). Without it Dagger serves the
   * previous exec from cache and every run reads the same stale trend — a network
   * read cached is a network read that did not happen (Gotcha 2).
   *
   * Best-effort: returns "" on any failure. No trend is a missing line on a card;
   * a hard failure here would be a pipeline down because a chat app was slow.
   */
  @func({ cache: "never" })
  async readTrend(token: Secret, channel: string, eventType: string, repo: string, cacheBust: string): Promise<string> {
    const script = `
curl -sS "https://slack.com/api/conversations.history?channel=$CHANNEL&limit=40&include_all_metadata=true" -H "Authorization: Bearer $TOK" \\
 | jq -c --arg et "$EVENT_TYPE" --arg repo "$REPO" 'first((.messages // [])[] | select(.metadata.event_type == $et) | select(((.metadata.event_payload.repo) // "") == $repo) | .metadata.event_payload) // empty'
`
    try {
      const out = await this.pollBase()
        .withSecretVariable("TOK", token)
        .withEnvVariable("CHANNEL", channel)
        .withEnvVariable("EVENT_TYPE", eventType)
        .withEnvVariable("REPO", repo)
        .withEnvVariable("CACHE_BUST", cacheBust)
        .withExec(["sh", "-c", script])
        .stdout()
      const t = out.trim()
      if (!t) return ""
      const p = JSON.parse(t) as Record<string, unknown>
      const n = (x: unknown) => Number(x) || 0
      const trend: Trend = { total_ms: n(p.total_ms), scenarios: n(p.scenarios), passed: n(p.passed), failed: n(p.failed), gates_ok: n(p.gates_ok), gates_total: n(p.gates_total) }
      return JSON.stringify(trend)
    } catch (e) {
      console.error("readTrend failed:", e)
      return ""
    }
  }

  /**
   * Find the `ts` of the card a given run posted, by its metadata. Returns ""
   * when there is none.
   *
   * A card is identified by `event_type` + `run_id` + `run_attempt`, never by
   * `run_id` alone: a re-run keeps the run id, and matching on it alone threads
   * attempt 2's detail under attempt 1's card, which already says "FAILED".
   * An empty `runAttempt` matches any attempt and takes the newest, which is what
   * a caller that does not know its attempt wants.
   *
   * Only TOP-LEVEL messages are searched (`conversations.history`), because that
   * is where a card lives; replies are not cards. `include_all_metadata=true` is
   * not optional: without it Slack omits `metadata` and nothing ever matches.
   *
   * ⚠️ `channel` must be the channel ID (`C…`), not its name. `chat.postMessage`
   * accepts a name, `conversations.history` does not, and answers
   * `channel_not_found`, which this function reports as "no card".
   *
   * @param cacheBust MUST change on every call that must see new messages. A
   *   lookup served from Dagger's cache returns the ts it found last time — or
   *   the "" it found before the card existed.
   * @param limit how many recent top-level messages to scan (Slack caps at 999).
   */
  @func({ cache: "never" })
  async findCard(
    token: Secret, channel: string, eventType: string, runId: string, cacheBust: string,
    runAttempt = "", limit = 200,
  ): Promise<string> {
    if (!channel || !runId) return ""
    const script = `
curl -sS "https://slack.com/api/conversations.history?channel=$CHANNEL&limit=$LIMIT&include_all_metadata=true" -H "Authorization: Bearer $TOK" \\
 | jq -r --arg et "$EVENT_TYPE" --arg run "$RUN_ID" --arg att "$RUN_ATTEMPT" '
   if .ok != true then "ERROR:" + (.error // "unknown") else
   first((.messages // [])[]
     | select(.metadata.event_type == $et)
     | select(((.metadata.event_payload.run_id // "") | tostring) == $run)
     | select($att == "" or (((.metadata.event_payload.run_attempt // "") | tostring) == $att))
     | .ts) // "" end'
`
    try {
      const out = (await this.pollBase()
        .withSecretVariable("TOK", token)
        .withEnvVariable("CHANNEL", channel)
        .withEnvVariable("LIMIT", String(Math.max(1, Math.min(999, limit))))
        .withEnvVariable("EVENT_TYPE", eventType)
        .withEnvVariable("RUN_ID", runId)
        .withEnvVariable("RUN_ATTEMPT", runAttempt)
        .withEnvVariable("CACHE_BUST", cacheBust)
        .withExec(["sh", "-c", script])
        .stdout()).trim()
      if (out.startsWith("ERROR:")) {
        console.error(`slack findCard: conversations.history answered ${out.slice(6)}`)
        return ""
      }
      return out
    } catch (e) {
      console.error("findCard failed:", e)
      return ""
    }
  }

  /**
   * The closing detail, in the card's THREAD: duration per step, the test table
   * and the trend. Posted on ok AND on fail — a run that failed is the one whose
   * detail somebody actually needs.
   *
   * In the thread and not as a second channel message: the card is already where
   * this run is being watched, and a loose message forces pairing them by eye.
   */
  @func({ cache: "never" })
  async breakdown(
    token: Secret,
    channel: string,
    threadTs: string,
    status: string,
    items: string,
    elapsedMs: number,
    metrics = "",
    trend = "",
  ): Promise<string> {
    if (!threadTs) return ""
    const st = status === "ok" || status === "waiting" ? status : "fail"
    const its = parse<Item[]>(items, "items") ?? []
    const tm = parse<TestMetrics>(metrics, "metrics")
    const tr = parse<Trend>(trend, "trend")
    try {
      const cap = (s: string) => (s.length > 2900 ? s.slice(0, 2900) + "…" : s)
      const dur = its.filter((i) => i.ms !== undefined).map((i) => `${EMOJI[i.st]} ${i.name} · ${fmt(i.ms)}`).join("\n") || "—"
      const sections: string[] = [`*Duration per step*\n${dur}`]
      if (tm) {
        const rows = [...tm.perFile].sort((a, b) => b.fail - a.fail).slice(0, 20)
          .map((r) => `${r.fail > 0 ? "✗" : "✓"} \`${r.file}\`  ${r.pass}✓ ${r.fail}✗`).join("\n")
        sections.push(`*Tests* — ${tm.passed}/${tm.total} ok · ${tm.failed} fail · ${tm.skipped} skip · ${tm.suites} suites\n${rows || "—"}`)
        if (tm.failedNames.length) {
          const extra = tm.failedNames.length > 25 ? `\n…(+${tm.failedNames.length - 25})` : ""
          sections.push(`*Failed scenarios*\n${tm.failedNames.slice(0, 25).map((n) => `• ${n}`).join("\n")}${extra}`)
        }
      }
      if (tr) {
        const d = elapsedMs - tr.total_ms
        const scen = tm?.total ?? 0
        const ds = scen - tr.scenarios
        sections.push(`*Trend vs previous*\n⏱️ ${fmt(elapsedMs)} (${d < 0 ? "↓" : "↑"}${fmt(Math.abs(d))}) · 🧪 ${scen} scenarios (${ds >= 0 ? "+" : ""}${ds})`)
      }
      return await this.post(token, channel, JSON.stringify({
        text: `Breakdown (${st})`, thread_ts: threadTs,
        blocks: sections.map((t) => ({ type: "section", text: { type: "mrkdwn", text: cap(t) } })),
      }))
    } catch (e) {
      console.error("breakdown failed:", e)
      return ""
    }
  }

  /**
   * Reply in the card's thread. The per-repo detail (which flows are red, which
   * .dart file broke) is posted with this — the engine knows nothing about flows.
   *
   * @param blocks JSON of a Block Kit array, or "" for a plain-text reply.
   */
  @func({ cache: "never" })
  async threadReply(token: Secret, channel: string, threadTs: string, text: string, blocks = ""): Promise<string> {
    if (!threadTs) return ""
    const b = parse<unknown[]>(blocks, "blocks")
    return await this.post(token, channel, JSON.stringify({
      text, thread_ts: threadTs,
      ...(b && b.length ? { blocks: b } : {}),
    }))
  }

  /**
   * The error block a failed run posts in its thread before the breakdown.
   *
   * Truncates from the END: the last 2600 characters of a stack trace are the
   * ones that say what broke; the first 2600 are the ones that say the build
   * started.
   */
  @func({ cache: "never" })
  async failureDetail(token: Secret, channel: string, threadTs: string, stage: string, detail: string): Promise<string> {
    if (!threadTs) return ""
    let d = detail
    if (d.length > 2600) d = "…(truncated)…\n" + d.slice(-2600)
    return await this.post(token, channel, JSON.stringify({
      text: `Failed at ${stage}`,
      thread_ts: threadTs,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `:x: Failed at *${stage}*` } },
        { type: "section", text: { type: "mrkdwn", text: "```" + d + "```" } },
      ],
    }))
  }

  /** curl+jq container for reading Slack history/replies (cached by Dagger). */
  private pollBase(): Container {
    return dag.container().from(POLL_IMG).withExec(["apk", "add", "--no-cache", "curl", "jq"])
  }
}
