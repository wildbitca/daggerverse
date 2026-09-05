/**
 * guards — the CI gates that used to be ~900 lines of bash and python in each repo.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 * Four scripts, three repos, and only a convention keeping them equal:
 * `check-shared-pins.sh` (257 lines) was byte-identical in `pacha/app`,
 * `pacha/services` and `pacha/web` — verified 2026-09-05, md5
 * f17371d3d80689412da67952d5ca8fec in all three. `check-toolchain.sh` was NOT:
 * app's copy is 217 lines and the other three are 93-96, and some of that gap is
 * a per-repo fact while the rest is drift nobody chose (§ "WHAT DIVERGED" below).
 *
 * Every one of these guards encodes a failure that cost a red run to learn. The
 * comments carry those measurements, because a guard whose reason is lost is a
 * guard the next person deletes.
 *
 * ── THE RULE THESE WERE PORTED UNDER ────────────────────────────────────────
 * Written from the ORIGINALS' documented behaviour, and verified by BREAKING a
 * fixture and watching each one go red — never by reading the new code back.
 * A guard written from its own implementation cannot fail it; that mistake has
 * been made four times in this codebase in one night, and once it shipped a
 * guard that passed while the thing it guarded was broken.
 *
 * ── WHAT DIVERGED BETWEEN THE FOUR `check-toolchain.sh` COPIES ──────────────
 * PER-REPO FACTS (data, and they cross the boundary as the `checks` argument):
 *   · which files hold a literal, which literal, and how many copies of it.
 *     app asserts 15 things across a Dagger module, a workflow, `codemagic.yaml`
 *     and `dagger.json`; ops asserts 3, one of them a Crossplane field.
 *   · which keys exist at all — ops has `kustomize`/`gitleaks`/
 *     `otel_reconciler_node` and no `node`, because it builds nothing.
 *   · the Darwin-only block in app: it is the only repo with an iOS lane.
 * DRIFT (mechanism that one copy grew and the others never got, and which this
 * module therefore gives to ALL of them):
 *   · `forbid` — only app has it. It exists because a count check cannot see a
 *     FIFTH Codemagic lane added with `flutter: stable`: the four pinned copies
 *     are still there and the count still passes. Nothing about that reasoning
 *     is app-specific.
 *   · the `::error title=…::` annotation on failure — only app has it, added
 *     after run 33837097643 (2026-09-04): a job's logs cannot be downloaded
 *     while the run is still going, and that run included a ~110-minute `ci`,
 *     so a failure here left "Process completed with exit code 1" as the only
 *     clue for nearly two hours. Annotations are readable the moment the step
 *     ends. That is true in every repo.
 *   · Spanish vs English messages, ✅ vs OK — cosmetic drift. English wins; it
 *     is the house rule for every written artefact.
 * NOT PORTED: `--local`. See the note on `toolchainPins`.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 * `check-engine-parity.sh`. It exists ONLY because the Slack engine is vendored
 * three times and the sole thing keeping the copies equal was an md5 written in
 * `.engine-parity` — which on 2026-09-04 caught a real divergence months old.
 * This repository removes the vendoring: the engine is `slack/`, consumed as a
 * pinned dependency, and `dagger.json` records the version AND the resolved
 * commit. There is no second copy left to compare against, so porting it would
 * ship a guard whose subject does not exist — which is a guard that can only
 * ever report green. Contract §2.3 says the same: "the pin replaces
 * `.engine-parity` and `scripts/check-engine-parity.sh` entirely".
 *
 * ── COMPLEX ARGUMENTS TRAVEL AS JSON STRINGS ────────────────────────────────
 * Dagger's TypeScript SDK exposes structural types poorly across a module
 * boundary and a shape mismatch fails at call time with an unreadable error, so
 * every non-scalar crosses as a JSON string, documented on the function, parsed
 * and validated on entry. `Directory` and `Secret` cross natively.
 *
 * ── AND THE NAMING RULE ─────────────────────────────────────────────────────
 * No public parameter here has a digit followed by a letter. `e2eThing` comes
 * back from Dagger's kebab↔camel round-trip as `e2EThing` and makes the WHOLE
 * function uninvokable — invisible to `tsc`, and re-measured while writing
 * `daggerFlags` (see the transcript in that function's header). It is the exact
 * trap that guard exists to catch, so this module must not walk into it.
 */
import { dag, Directory, Secret, Container, object, func, ReturnType } from "@dagger.io/dagger"

/** curl for the GitHub API reads. Same image family the slack module uses. */
const CURL_IMG = "curlimages/curl:8.21.0"
/** bash + node, for `bash -n` and esbuild. */
const NODE_IMG = "node:24.20.0-alpine3.24"
/** The probe container: needs a shell, curl to install the CLI, and git. */
const PROBE_IMG = "alpine:3.22"

// ── report ────────────────────────────────────────────────────────────────────
/**
 * Accumulates ok/fail lines and decides the verdict ONCE, at the end.
 *
 * The originals all work this way (`FAIL=1` and carry on, `exit "$FAIL"`) and it
 * matters: a guard that threw on the first mismatch would report one broken pin
 * per run, and a version bump touches six literals at a time. You want the whole
 * list in one pass, not six pushes.
 */
class Report {
  private lines: string[] = []
  private failures: string[] = []

  constructor(private readonly name: string, private readonly annotate: boolean) {}

  private verdicts = 0

  head(msg: string): void { this.lines.push(msg) }
  ok(msg: string): void { this.verdicts++; this.lines.push(`  OK   ${msg}`) }
  note(msg: string): void { this.lines.push(`  ..   ${msg}`) }

  /**
   * Something was NOT checked, and the line has to say so.
   *
   * It is not a verdict, so it does not satisfy the backstop in `finish`, and
   * the wording is chosen for where it is actually read: a folded log or a
   * Slack checklist, at a glance, by someone scanning for the absence of red.
   * `OK   0 pairing(s) satisfied` passes that scan while being false — a
   * sentence about the members of an empty set is vacuously true and reads as
   * an assurance. `SKIP … NOTHING WAS CHECKED` cannot be misread that way.
   */
  skip(msg: string): void { this.lines.push(`  SKIP ${msg}`) }

  /**
   * A failure. Also emits a GitHub annotation when asked, because a job's logs
   * are not downloadable while the run is still in flight (see the header).
   */
  bad(msg: string, title = "Guard failed"): void {
    this.lines.push(`  FAIL ${msg}`)
    this.failures.push(msg)
    if (this.annotate) this.lines.push(`::error title=${title}::${msg}`)
  }

  get failed(): boolean { return this.failures.length > 0 }

  /**
   * Print the whole report, then fail closed if anything failed.
   *
   * The full report goes into the thrown error too, not just the summary: a
   * Dagger failure surfaces the error message far more reliably than it
   * surfaces a function's stdout, and a guard whose diagnosis is only in the
   * part that got swallowed is a guard nobody can act on.
   */
  finish(hint: string): string {
    const out = this.lines.join("\n")
    console.log(out)
    // ── THE BACKSTOP ────────────────────────────────────────────────────
    // Reaching the end having reported neither a pass nor a failure means the
    // guard looked at nothing, and returning here would report that as
    // success. Every function above is written so this cannot happen — but
    // that was also true of the pairings tick until somebody read it. This is
    // the structural version of that fix rather than the enumerated one, so a
    // function added later cannot reintroduce the shape by omission.
    if (this.verdicts === 0 && !this.failed) {
      throw new Error(`${this.name}: finished without checking anything — no pass and no failure was recorded, so this run proves nothing. That is a bug in the guard, not a green build.\n${out}`)
    }
    if (this.failed) {
      throw new Error(`${this.name}: ${this.failures.length} failure(s)\n${out}\n\n${hint}`)
    }
    return out
  }
}

// ── small shared helpers ──────────────────────────────────────────────────────

/** Parse a JSON argument, naming the parameter in the error (slack's `parse`). */
function parseJson<T>(raw: string, what: string): T | undefined {
  const t = (raw ?? "").trim()
  if (!t) return undefined
  try {
    return JSON.parse(t) as T
  } catch (e) {
    throw new Error(`guards: '${what}' is not valid JSON (${(e as Error).message}). It travels as a JSON string; the caller does JSON.stringify.`)
  }
}

/**
 * Read a file, or `null` when it is not there.
 *
 * `null` is a real answer here and never a silent one: every caller turns it
 * into a FAILURE, exactly as `need()` does with `bad "$what: $file does not
 * exist"`. A guard that cannot read what it is checking must not report green —
 * that is the whole failure class these exist to close.
 */
async function readMaybe(dir: Directory, path: string): Promise<string | null> {
  try {
    return await dir.file(path).contents()
  } catch {
    return null
  }
}

/** Lines, without the trailing empty one a final newline produces. */
function lines(text: string): string[] {
  const l = text.split("\n")
  if (l.length && l[l.length - 1] === "") l.pop()
  return l
}

/** `grep -cF` counts LINES that contain the literal, not occurrences. */
function countLinesContaining(text: string, literal: string): number {
  return lines(text).filter((l) => l.includes(literal)).length
}

// POSIX character classes, for the ERE→JS translation `forbid` needs. JS has no
// `[[:space:]]`, and the one pattern in service today uses it three times:
//   ^[[:space:]]*flutter:[[:space:]]*(stable|beta|master)[[:space:]]*$
// Left untranslated that compiles to a JS regex that means something else
// entirely (a character class of `[`, `:`, `s`, `p`…), still matches nothing,
// and reports a cheerful green. A wrong translation here is a guard that
// silently stops looking.
const POSIX_CLASS: Record<string, string> = {
  alpha: "A-Za-z",
  digit: "0-9",
  alnum: "A-Za-z0-9",
  space: " \\t\\n\\r\\f\\v",
  blank: " \\t",
  upper: "A-Z",
  lower: "a-z",
  punct: "!-\\/:-@\\[-`{-~",
  xdigit: "0-9A-Fa-f",
  word: "A-Za-z0-9_",
  cntrl: "\\x00-\\x1f\\x7f",
  print: "\\x20-\\x7e",
  graph: "\\x21-\\x7e",
}

/**
 * Translate a POSIX ERE (what `grep -E` speaks) into a JS RegExp.
 *
 * Only the bracket classes need translating; the rest of ERE that these guards
 * use — anchors, alternation, groups, quantifiers, classes — is spelled the same
 * in both. An unknown `[:name:]` is a HARD failure rather than a passthrough:
 * silently leaving it in place produces a regex that compiles, matches nothing,
 * and turns the check into a no-op.
 */
function posixEreToRegExp(re: string, what: string): RegExp {
  const translated = re.replace(/\[:([a-z]+):\]/g, (_m, name: string) => {
    const cls = POSIX_CLASS[name]
    if (!cls) {
      throw new Error(`guards: ${what}: POSIX class '[:${name}:]' is not one this module knows how to translate to a JS regex. Left as-is it would compile to a pattern that matches nothing and the check would silently stop checking.`)
    }
    return cls
  })
  try {
    return new RegExp(translated)
  } catch (e) {
    throw new Error(`guards: ${what}: '${re}' is not a regex this module can compile (${(e as Error).message})`)
  }
}

@object()
export class Guards {
  /**
   * Assert that every version literal in the repo still equals the number
   * written in `.toolchain-pins`.
   *
   * ── WHY THIS IS A GREP AND NOT A GENERATOR ──────────────────────────────
   * Deliberately. Templating the pins into the files at build time would make
   * the Dagger module and the workflow depend on a generator, and both of them
   * have to stay readable and runnable on their own. So the version lives
   * literally where the tool is installed, and this compares the literals
   * against one declared number.
   *
   * ── WHAT IT COST NOT TO HAVE IT ─────────────────────────────────────────
   * 2026-08-20: the same pipeline compiled one `pubspec.lock` with Flutter
   * 3.44.0 (Android, Dagger image) and 3.44.9 (iOS, macOS job) while the
   * developer machine ran 3.44.7; Maestro was cli-2.6.1 in CI and 2.7.0
   * locally; sops 3.13.3 vs 3.13.2; and the Node install resolved
   * `latest-v24.x` AT BUILD TIME — a floating pin dressed up as a pinned one.
   * Every one of those was invisible until someone went looking.
   *
   * ── WHY `--local` IS NOT PORTED ─────────────────────────────────────────
   * `--local` answers "do the binaries on THIS MACHINE match the pins". Inside
   * a container the answer is always "the binaries in this image", which is not
   * the question and cannot be made into it: the module never sees the host.
   * Porting it would produce a check that passes on a machine it never looked
   * at, which is worse than not having one. It stays a host-side script — and
   * the app repo runs it as the FIRST step of the macOS `ios` job, which is
   * precisely where it has to run, since Xcode and CocoaPods live on that host
   * and nowhere else.
   *
   * @param source    repo root — the directory holding `.toolchain-pins`
   * @param checks    JSON array of assertions. Each is one of
   *                  {kind:"present", file, literal, what}    — literal appears at least once
   *                  {kind:"count",   file, literal, count, what}
   *                                                           — literal appears on exactly
   *                                                             `count` LINES (`grep -cF`
   *                                                             counts lines, not hits)
   *                  {kind:"absent",  file, regex, what}      — POSIX ERE matches no line
   *                  `literal` and `regex` may carry `{pin_key}` placeholders, which are
   *                  substituted from `.toolchain-pins`. An undeclared key is a HARD
   *                  failure, exactly as the original's `pin()` exits 1 on one.
   * @param pinsFile  path to the pins file, relative to `source`
   * @param annotate  emit `::error::` annotations (pass true from GitHub Actions)
   */
  @func()
  async toolchainPins(source: Directory, checks: string, pinsFile = ".toolchain-pins", annotate = false): Promise<string> {
    const r = new Report("toolchainPins", annotate)
    const specs = parseJson<ToolchainCheck[]>(checks, "checks")
    if (!specs || !Array.isArray(specs) || specs.length === 0) {
      // An empty check list is the shape of a guard that checks nothing, and it
      // would report green forever. Same reasoning as check-shared-pins.sh on an
      // empty shared block: "an empty shared set is not an agreement".
      throw new Error("guards: 'checks' is empty — a toolchain guard with no assertions passes every run without looking at anything. Pass the repo's assertions as a JSON array.")
    }

    const pinsRaw = await readMaybe(source, pinsFile)
    if (pinsRaw === null) {
      throw new Error(`guards: cannot find ${pinsFile} in the source directory — this guard has nothing to compare against`)
    }
    const pins = readPins(pinsRaw)

    r.head(`Repo pins (source: ${pinsFile})`)
    // The file cache exists so a repo asserting six literals in one file reads it
    // once. It also guarantees every assertion in a run judges the same bytes.
    const cache = new Map<string, string | null>()
    const read = async (p: string): Promise<string | null> => {
      if (!cache.has(p)) cache.set(p, await readMaybe(source, p))
      return cache.get(p) ?? null
    }

    for (const spec of specs) {
      // The label is substituted too, so a failure line reads "flutter 3.47.2:
      // '…' does NOT appear" and not "flutter {flutter}". The number IS the
      // diagnosis; a message that hides it makes the reader go and look it up.
      const label = spec.what || describe(spec)
      const what = substitute(label, pins, label)
      const body = await read(spec.file)
      if (body === null) {
        r.bad(`${what}: ${spec.file} does not exist`, "Toolchain misaligned")
        continue
      }
      if (spec.kind === "absent") {
        const re = posixEreToRegExp(substitute(spec.regex, pins, what), what)
        const hits = lines(body).filter((l) => re.test(l)).length
        if (hits > 0) r.bad(`${what}: ${spec.file} has ${hits} line(s) matching /${spec.regex}/ and should have none`, "Toolchain misaligned")
        else r.ok(`${what} -> ${spec.file}`)
        continue
      }
      const literal = substitute(spec.literal, pins, what)
      if (spec.kind === "count") {
        const got = countLinesContaining(body, literal)
        if (got === spec.count) r.ok(`${what} -> ${spec.file} (x${spec.count})`)
        else r.bad(`${what}: expected ${spec.count} copies of '${literal}' in ${spec.file}, found ${got}`, "Toolchain misaligned")
        continue
      }
      if (body.includes(literal)) r.ok(`${what} -> ${spec.file}`)
      else r.bad(`${what}: '${literal}' does NOT appear in ${spec.file} (did the pin move without updating ${pinsFile}, or the other way round?)`, "Toolchain misaligned")
    }

    return r.finish(`Fix the pin in ${pinsFile} and move it in EVERY place listed above.`)
  }

  /**
   * Assert that the pins this repo shares with its siblings still equal THEIRS.
   *
   * ── WHY THIS IS SEPARATE FROM `toolchainPins` ───────────────────────────
   * `toolchainPins` only ever compares a repo against itself, and so does the
   * guard in every other repo. Each one can be perfectly self-consistent,
   * disagree with the others about a shared number, and keep every CI green
   * while doing it. That is the one skew nobody could see. This is the other
   * half.
   *
   * ── WHY IT READS THE API AND NOT A CHECKOUT ─────────────────────────────
   * Comparing against a sibling directory answers "do these two directories
   * agree", which is not the question: a checkout can be on another branch, or
   * stale, and then the guard passes GREEN against a number nobody is running.
   * Naming the ref answers "do these two REPOS agree", and it means the same
   * thing on a laptop as in CI.
   *
   * ── WHY BLOCK AGAINST BLOCK, AND SYMMETRIC ──────────────────────────────
   * An earlier version took the sibling's value by grepping its whole file for
   * `key=`. That passed while a sibling had DROPPED the key from its shared
   * block and kept pinning it locally: their contract had stopped saying the
   * number was shared, and this check went on saying the two agreed. So the
   * comparison is block to block, and it is symmetric — a key one side calls
   * shared and the other does not is reported, in both directions.
   *
   * ── IT FAILS ON WHAT IT COULD NOT READ ──────────────────────────────────
   * No token, an unreadable sibling, a sibling with no matching block, a
   * delimiter carrying no membership, an empty block, a padded marker: all
   * failures, never skips. The workflow decides WHETHER to run it (the `if:` on
   * the step); once it runs, silence is not an outcome.
   *
   * ── THE ONE THING THAT COULD NOT BE PORTED AS-IS ────────────────────────
   * The original works out which repo it is from `$GITHUB_REPOSITORY` or the
   * `origin` remote. A module function has neither: it sees a `Directory`, not
   * a checkout with a `.git`, and not the runner's environment. So `repo` is a
   * parameter. It is the only per-repo fact this guard takes, it is the same
   * one the original derived, and an empty value fails loudly rather than
   * comparing nothing.
   *
   * @param source    repo root — the directory holding the pins file
   * @param repo      this repo's `owner/name` slug (pacha-app is `wildbitca/pacha`;
   *                  there is no `wildbitca/pacha-app`)
   * @param token     a token that can read the SIBLINGS' pins file
   * @param ref       the sibling ref to read — `main`, the only long-lived branch
   * @param pinsFile  path to the pins file, relative to `source`
   * @param cacheBust MUST vary per run. Empty means "generate one", never "reuse":
   *                  without it Dagger serves the previous exec from cache and the
   *                  guard compares against whatever the siblings said the first
   *                  time it ever ran. A network read that is cached is a network
   *                  read that did not happen.
   * @param annotate  emit `::error::` annotations (pass true from GitHub Actions)
   */
  @func()
  async sharedPins(
    source: Directory,
    repo: string,
    token: Secret,
    ref = "main",
    pinsFile = ".toolchain-pins",
    cacheBust = "",
    annotate = false,
  ): Promise<string> {
    const r = new Report("sharedPins", annotate)

    const self = (repo ?? "").trim()
    if (!self) {
      throw new Error("guards: 'repo' is empty: this guard cannot tell which repo it is looking at, and a group it cannot place itself in cannot bind it. Pass owner/name — from ${{ github.repository }} in CI.")
    }
    assertSlug(self, "repo")

    const ownRaw = await readMaybe(source, pinsFile)
    if (ownRaw === null) throw new Error(`guards: cannot find ${pinsFile} in the source directory`)

    const own = parseSections(ownRaw)
    if (!own.ok) {
      throw new Error(`guards: ${pinsFile} ${parseReason(own.code)}${own.where ? ` [${own.where}]` : ""}`)
    }

    r.head(`This repo: ${self}`)
    const fetched = new Map<string, string | null>()
    const bust = cacheBust || String(Date.now())

    for (const block of own.blocks) {
      const mkey = memberKey(block.members)
      r.head("")
      r.head(`Group [${mkey}]`)

      // An empty shared set is not an agreement, it is a guard that checks
      // nothing. Leaving the markers behind around an emptied block was tried in
      // pacha-ops when `redis` was retired (2026-09-02) and this is what rejected
      // it: a group with no pins does not preserve the cross-repo check, it only
      // makes the build red until somebody removes the markers too.
      if (block.keys.length === 0) {
        r.bad(`our block for [${mkey}] has no pins in it — an empty shared set is not an agreement, it is a guard that checks nothing`, "Shared pins")
        continue
      }
      if (!mkey.split(" ").includes(self)) {
        r.bad(`our block for [${mkey}] does not list this repo (${self}) as a member — a group we are not in cannot bind us, and a copy-pasted block checks somebody else's edge`, "Shared pins")
        continue
      }
      const siblings = mkey.split(" ").filter((m) => m !== self)
      if (siblings.length === 0) {
        r.bad(`our block for [${mkey}] names no repo other than ourselves — nothing is being compared`, "Shared pins")
        continue
      }
      r.note(`members to check: ${siblings.join(" ")}`)

      for (const sib of siblings) {
        // Fetched once per repo even when a repo is in several groups: two reads
        // of the same file could disagree, and a guard comparing against two
        // different truths is worse than one.
        if (!fetched.has(sib)) fetched.set(sib, await this.fetchPins(sib, token, ref, pinsFile, bust))
        const raw = fetched.get(sib) ?? null
        if (raw === null) {
          r.bad(`${sib}: could not read ${pinsFile}@${ref} (no access, no such file, or a bad token)`, "Shared pins")
          continue
        }
        const theirs = parseSections(raw)
        if (!theirs.ok) {
          r.bad(`${sib}@${ref} ${pinsFile} ${parseReason(theirs.code)}${theirs.where ? ` [${theirs.where}]` : ""}`, "Shared pins")
          continue
        }
        // Membership IS the identity of a group, so blocks are matched by their
        // member set and never by position or by name.
        const theirBlock = theirs.blocks.find((b) => memberKey(b.members) === mkey)
        if (!theirBlock) {
          r.bad(`${sib}@${ref} declares no shared block whose members are exactly [${mkey}] — the two repos disagree about who is in the group, which is a divergence before any number is compared`, "Shared pins")
          continue
        }

        const allKeys = [...new Set([...block.keys, ...theirBlock.keys].map(keyOf))].sort()
        for (const key of allKeys) {
          const mine = pinOf(key, block.keys)
          const yours = pinOf(key, theirBlock.keys)
          if (mine === undefined) {
            r.bad(`${key}: ${sib}@${ref} calls it shared with us, our block does not declare it`, "Shared pins")
          } else if (yours === undefined) {
            r.bad(`${key}: we call it shared, ${sib}@${ref}'s block does not declare it`, "Shared pins")
          } else if (mine === yours) {
            r.ok(`${key} ${mine} == ${sib}@${ref}`)
          } else {
            r.bad(`${key}: we pin ${mine}, ${sib}@${ref} pins ${yours} — one repo moved alone`, "Shared pins")
          }
        }
      }
    }

    return r.finish(
      "A number diverged, a group disagrees about its members, or a sibling could not be read\n" +
      "(which proves nothing, so it fails too). A shared pin moves in every member of its\n" +
      "group together, or not at all.",
    )
  }

  /**
   * Probe the Dagger CLI to prove every `--flag` the workflow passes EXISTS.
   *
   * ── WHY IT EXISTS ───────────────────────────────────────────────────────
   * 2026-09-04, first run of the unified pipeline, on `main`:
   *
   *     Error: set call inputs: find arg "e2EParallelism"
   *
   * The workflow passed `--e2e-parallelism=5` and the module declared
   * `e2eParallelism`. What breaks is Dagger's kebab↔camel round-trip when a
   * digit is followed by a letter: the flag is accepted, converted to
   * `e2EParallelism`, and then no argument by that name exists.
   * `keystoreBase64` survives because its digit is last.
   *
   * The bug is not the point. What did NOT see it is: that run passed `tsc
   * --strict`, the embedded-bash guard, 15/15 toolchain pins, and the YAML
   * parsed. None of them lie — both sides are correct SEPARATELY. Nobody was
   * looking at the seam, which is where the YAML names something the module has
   * to have.
   *
   * ── WHY IT PROBES THE CLI AND NEVER PARSES `--help` ─────────────────────
   * The first version of this guard parsed `dagger call <fn> --help`. That is
   * WRONG, and it was measured — re-measured here on 2026-09-05 against a probe
   * module on dagger v0.21.9:
   *
   *     --help prints            CLI accepts       CLI accepts
   *                              that spelling     the workflow's
   *     --keystore-base-64       yes               yes (--keystore-base64)
   *     --e-2-e-parallelism      no                no
   *
   * So `--help` renders a PRESENTATION name that is not necessarily the one
   * pflag accepts, in both directions. A guard built on it gives a false
   * positive on `--keystore-base64`, which has been green for months, and sends
   * someone to "fix" something that works. The only source of truth is asking
   * the CLI whether it accepts THAT string.
   *
   *     unknown flag: X       the flag does not exist
   *     find arg "Y"          the flag exists but matches no argument — the
   *                           digit trap, and the exact failure above
   *     anything else         the flag exists (it died on what the rest lacks)
   *
   * ── THE BLIND SPOT, MEASURED, AND WHY IT IS NOT CLOSED HERE ─────────────
   * The probe passes ONE flag and nothing else, so on a function with REQUIRED
   * arguments the CLI stops at `required flag(s) "…" not set`, which is stage 2
   * of 4, and never reaches `set call inputs` at stage 3 where `find arg` is
   * raised. Measured 2026-09-05 on a probe module:
   *
   *     call optional --e2e-parallelism=env:X   -> find arg "e2EParallelism"   (caught)
   *     call ci       --e2e-parallelism=env:X   -> required flag(s) … not set  (green)
   *     call ci  --e2e-parallelism=env:X --source=. --platform=x
   *                                             -> find arg "e2EParallelism"   (caught)
   *
   * So satisfying the required flags WOULD close it — and that is exactly what
   * must not be done. Measured on the same module in the same session: with the
   * required flags satisfied and no unresolvable input left, the CLI proceeds
   * past stage 3 and EXECUTES the function. A guard that ran `ci` would boot the
   * emulators it exists to save. Anything that fails earlier (a missing path, an
   * unset `env:` secret) fails at stage 3a, before `set call inputs`, and masks
   * the very error being looked for. The blind spot is intrinsic to a safe
   * probe; it is documented rather than papered over, and `unknown flag`
   * detection is unaffected because pflag raises that at stage 1.
   *
   * ── THE SHADOWED-ACCESSOR TRAP, AND THE SWEEP THAT BOUNDED IT ───────────
   * Third member of the same family, measured 2026-09-05. A `@func()` named
   * `secret` shadows the CLI's `Address.secret`, which is the path every
   * `--flag=env:X` and `--flag=file:X` goes through, and so it makes EVERY
   * `Secret` argument in that module uninvokable — including in functions that
   * have nothing to do with the offending one. `tsc` is clean and
   * `dagger functions` lists everything normally. The plain-progress output
   * shows the whole mechanism:
   *
   *     Address.secret: Secret!
   *     ┆ Probefix.secret(name: ""): String!     <- the module's func, not the core one
   *     Address.secret ERROR
   *     ! … cannot set field of type dagql.ObjectResult[…core.Secret] with dagql.String
   *
   * Detected on the assign error and NOT on the function's name. A name-based
   * check would flag legitimate code and would still miss the next member of
   * this family; keying on the failure means anything that shadows an accessor
   * is caught whatever it is called. It also costs nothing: the probe already
   * passes `env:<unset>` to every flag, so this is a third classification of
   * output that was already being collected.
   *
   * WHICH NAMES ARE ACTUALLY POISONED — swept, not assumed. Ten accessors exist
   * on `Address` (`container`, `directory`, `file`, `gitRef`, `gitRepository`,
   * `id`, `secret`, `service`, `socket`, `value`). One fixture module per name,
   * each probed with a RESOLVABLE value for Secret, Directory, File and
   * Container so a value error could not mask a shadowing:
   *
   *     secret          POISONS every Secret argument
   *     id              module does not load at all ("resolving module") — loud,
   *                     not silent, and therefore not this class of bug
   *     the other 8     no effect measured on any of the four argument types
   *
   * So `secret` is the only silent one today. The list is worth more than the
   * single case, and the detection does not depend on it.
   *
   * ── WHAT IT DOES NOT CHECK, ON PURPOSE ──────────────────────────────────
   * Only the flags of the MODULE's function. In a chain like
   * `dagger call end-to-end-artifacts --source=. … export --path=e2e-artifacts`,
   * `export` is a core function on the returned Directory, not ours. The check
   * stops at the first token that is not a flag and the output SAYS so, so
   * nobody reads the green as "the whole line was checked". Values are not
   * checked either (that `env:FOO` exists, that the file is there) — the run
   * says that, and asserting it here would be a guard that believes more than it
   * measures.
   *
   * @param source        repo root
   * @param workflowPath  the workflow to read, relative to `source`
   * @param modulePath    the Dagger module to probe, relative to `source`
   * @param pairings      JSON array of CONDITIONAL rules — see `pairings` below.
   *                      "" means this repo declares none.
   * @param daggerVersion the CLI to install in the probe container. LEAVE IT EMPTY:
   *                      it is then read from the module's own `dagger.json`
   *                      `engineVersion`, which is the version this module is
   *                      actually run with. Pass one only to deliberately probe
   *                      with a different CLI than the pipeline uses.
   * @param token         a token that can read the private `daggerverse` repo. The
   *                      nested probe session has no git credentials of its own —
   *                      without this, a consumer with a private dependency never
   *                      loads its module and NOTHING is verified. Omit it only for
   *                      a module with no private dependencies; if one is needed and
   *                      missing, the guard fails and says so.
   * @param timeoutSeconds deadline for the probe phase. This step carried
   *                      `timeout-minutes: 5` in YAML, and fusing steps into one
   *                      `dagger call` would have deleted it and left only the
   *                      150-minute job ceiling (contract invariant 5). Measured
   *                      2026-09-05 against pacha-app: 84 flags over 7 calls,
   *                      1m50s. The error names what expired.
   * @param annotate      emit `::error::` annotations (pass true from GitHub Actions)
   */
  @func()
  async daggerFlags(
    source: Directory,
    workflowPath = ".github/workflows/pipeline.yml",
    modulePath = ".github/dagger",
    pairings = "",
    daggerVersion = "",
    token?: Secret,
    timeoutSeconds = 300,
    annotate = false,
  ): Promise<string> {
    const r = new Report("daggerFlags", annotate)

    const raw = await readMaybe(source, workflowPath)
    if (raw === null) throw new Error(`guards: cannot read ${workflowPath} — this guard has no workflow to check`)
    const rules = parseJson<Pairing[]>(pairings, "pairings") ?? []

    r.head(`Flags ${workflowPath} passes to ${modulePath}`)
    const scanned = scanWorkflow(raw)
    const calls: { step: string; fn: string; flags: string[]; truncated: string | null }[] = []
    for (const row of scanned) {
      const found = invocation(row.line)
      if (found && found.flags.length) calls.push({ step: row.step ?? "(unnamed)", ...found })
    }
    if (calls.length === 0) {
      // Nothing to probe means either the workflow stopped calling Dagger or the
      // scanner stopped seeing it. The second is a guard that quietly went
      // blind, and it is indistinguishable from the first from in here, so this
      // fails rather than printing a green "0 flags".
      throw new Error(`guards: found no 'dagger … call <fn> --flag' invocation in ${workflowPath}. Either the workflow no longer calls Dagger, or this scanner stopped recognising the shape — and a guard that checks nothing must not report green.`)
    }

    const cli = daggerVersion || await engineVersionOf(source, modulePath)
    const base = this.probeBase(source, modulePath, cli, token)
    const cache = new Map<string, FlagVerdict | null>()
    let broken = 0

    const probeAll = async (): Promise<void> => {
      for (const call of calls) {
        const bad: { flag: string; verdict: FlagVerdict }[] = []
        for (const flag of call.flags) {
          const key = `${call.fn} ${flag}`
          if (!cache.has(key)) cache.set(key, await this.probe(base, call.fn, flag))
          const v = cache.get(key) ?? null
          if (v) bad.push({ flag, verdict: v })
        }
        if (bad.length) {
          broken++
          for (const { flag, verdict } of bad) {
            const tail = verdict.lookedFor ? ` (it looked for \`${verdict.lookedFor}\`)` : ""
            r.bad(
              `dagger call ${call.fn} ${flag} in step «${call.step}»: ${verdict.reason}${tail}. ` +
              `Check it with \`dagger -m ${modulePath} call ${call.fn} ${flag}=env:X\` — and note that ` +
              `\`--help\` is NOT a reference: it prints names the CLI does not always accept, and accepts names it does not print.`,
              "Nonexistent Dagger flag",
            )
          }
        } else {
          const extra = call.truncated ? ` (up to \`${call.truncated}\`)` : ""
          r.ok(`${call.fn}: ${call.flags.length} flags${extra}`)
        }
      }
    }
    // The deadline the YAML step used to carry. A guard whose only ceiling is the
    // job's 150 minutes is a guard that can eat the run it exists to save.
    await withDeadline(
      probeAll(),
      timeoutSeconds,
      `daggerFlags: the CLI probe phase did not finish within ${timeoutSeconds}s. ` +
      `${calls.length} call(s), ${calls.reduce((n, c) => n + c.flags.length, 0)} flag(s) to probe; ` +
      `${cache.size} completed. Raise --timeout-seconds if the workflow really grew, or look for an engine that is not answering.`,
    )

    // ── The second question, and it is a different one ────────────────────
    // Above: "does what you pass exist?". Here: "do you pass what is needed?",
    // but ONLY in the conditional form. It probes nothing — it is a read of the
    // file, so it costs milliseconds and runs even with the engine down.
    r.head("")
    r.head("Pairings (if you pass X, Y is needed)")
    const { seen, problems } = checkPairings(scanned, rules)
    for (const p of problems) {
      r.bad(`${p.rule} — ${p.where}: ${p.why}`, "Broken flag pairing")
    }
    // Two ways to print a tick over an empty set, and both used to. `pairings`
    // is genuinely optional in a way `checks` is not — the flag-existence half
    // above is this guard's actual job, and pacha-site and pacha-api really do
    // have no conditional couplings — so an empty list is reported as SKIPPED
    // rather than refused. What it must never do is claim the rules passed.
    //
    // The second case is subtler and was not reported: rules GIVEN but none
    // applicable, because the flag a rule keys on is absent from the workflow.
    // That is by design ("if X disappears the rule stops applying by itself"),
    // so it is not a failure either — but `0 pairing(s) satisfied` is the same
    // false sentence, and it is the one that would appear the day somebody
    // renames the flag a rule watches.
    if (rules.length === 0) {
      r.skip("no pairing rules were given — NOTHING WAS CHECKED in this direction. This is fine for a repo with no conditional couplings; pass --pairings if it has any.")
    } else if (seen === 0) {
      r.skip(`${rules.length} pairing rule(s) were given and NONE APPLIED — no call in this workflow passes the flags they key on, so NOTHING WAS CHECKED in this direction. Fine if those flags are genuinely gone; a defect if one was renamed.`)
    } else if (problems.length === 0) {
      r.ok(`${seen} pairing(s) satisfied`)
    }

    return r.finish(
      broken > 0
        ? "The workflow names flags the module does not have — the run would die before executing a single test."
        : "Flags are passed half-way: the bundle-seal gate would be inert, or the lane red on every run.",
    )
  }

  /**
   * Syntax-check the bash that lives inside a TypeScript template literal, and
   * check that the file containing it is still TypeScript.
   *
   * ── WHY ─────────────────────────────────────────────────────────────────
   * The Dagger module embeds a ~580-line bash script in a JS template literal,
   * and the template literal EATS BACKSLASHES: `find … \\( -name x \\)` reaches
   * bash as `find … ( -name x )` and dies with "syntax error near unexpected
   * token". esbuild does not catch it, because `\(` is perfectly valid
   * JavaScript — it is the wrong syntax to be checking. This checks the right
   * one: it reproduces JS's escape handling, substitutes the `${…}`
   * interpolations, and runs `bash -n`.
   *
   * Cost of not having it: a full CI run — three emulators, ~20 minutes — that
   * fails before the first flow, on a script that "compiled" fine.
   *
   * ── AND THE HOLE THAT THE SPAN CHECK CLOSES (run 33827086621) ───────────
   * An UNESCAPED BACKTICK inside the literal — written in a bash comment, where
   * it looks harmless — CLOSES the TS string. esbuild dies with "Expected ';'",
   * the whole module stops compiling, and `dagger call ci` blows up in 53s.
   * The bash check did not see it, and not by an oversight: the extraction
   * regex looks for literals between UNESCAPED backticks, so when one is loose
   * it simply finds OTHER literals — shorter, and perfectly valid bash. It
   * printed a tick over a file esbuild rejects. The usual pattern: a guard
   * answering a different question from the one that matters — here "is this
   * valid bash?" instead of "is it still in one piece?". So the two `span`
   * marks, which live on the script's first and last line, must appear in ONE
   * literal.
   *
   * ── AND WHY IT ALSO PARSES THE TYPESCRIPT ───────────────────────────────
   * The symmetry is real and bit twice in one night, in two shapes of the same
   * hole — constructs bash understands that break the TS string:
   *   an unescaped backtick in a comment  -> closes the template literal
   *   "${2:-}" unescaped                  -> invalid TS interpolation
   *                                          (Expected "}" but found ":")
   * Both passed `bash -n` without blinking, because the extracted bash IS
   * correct. What breaks is the file containing it.
   *
   * ── ONE DELIBERATE STRENGTHENING ────────────────────────────────────────
   * The original WARNS and returns 0 when esbuild is not installed, so on a
   * machine without it the TypeScript half silently did not run. In here the
   * container carries a pinned esbuild, so that path cannot happen; if the
   * install fails, the exec fails and so does the guard. A guard that cannot
   * check what it is checking fails.
   *
   * @param source         repo root
   * @param filePath       the TypeScript file holding the embedded bash
   * @param marks          JSON array of substrings identifying the literals to check.
   *                       Default is pacha-app's; a repo with a different script names
   *                       its own.
   * @param span           JSON array of exactly two substrings that live on the FIRST
   *                       and LAST line of the big script. Both must land in ONE literal.
   * @param esbuildVersion pinned esbuild used for the TypeScript parse
   * @param annotate       emit `::error::` annotations (pass true from GitHub Actions)
   */
  @func()
  async daggerBash(
    source: Directory,
    filePath = ".github/dagger/src/index.ts",
    marks = "",
    span = "",
    esbuildVersion = "0.25.9",
    annotate = false,
  ): Promise<string> {
    const r = new Report("daggerBash", annotate)
    const markList = parseJson<string[]>(marks, "marks") ?? ["run_device", "boot_emu"]
    const spanList = parseJson<string[]>(span, "span") ?? ["set -uo pipefail", "exit $FAIL"]
    if (markList.length === 0) {
      throw new Error("guards: 'marks' is empty — with nothing to identify the embedded script by, this guard selects no literals and checks no bash. Same shape as an empty 'checks': it would report on a set it never populated.")
    }
    if (spanList.length !== 2) {
      throw new Error(`guards: 'span' must be exactly two marks — the first and last line of the embedded script. Got ${spanList.length}.`)
    }

    const src = await readMaybe(source, filePath)
    if (src === null) throw new Error(`guards: cannot read ${filePath} — this guard has no file to check`)

    // Template literals, by their contents: backticks that are NOT escaped
    // delimit them. Non-greedy, and `\\.` keeps an escaped backtick inside.
    const lits = [...src.matchAll(/`((?:[^`\\]|\\[\s\S])*?)`/g)].map((m) => m[1])
    const targets = lits.filter((l) => markList.some((m) => l.includes(m)))

    // THE SPAN CHECK COMES FIRST and, when it fails, the per-literal bash checks
    // are skipped: with the literal cut in half those verdicts are about the
    // wrong text. The TypeScript parse still runs, exactly as the original does,
    // because it is the half that names the offending LINE.
    //
    // ── AND THE HALF OF THIS THE SPAN CHECK CANNOT DO ──────────────────────
    // The span check catches an ODD number of stray backticks: the marks end up
    // in different fragments and no single literal holds both. An EVEN number
    // does not trip it. A PAIR re-opens the literal further down, one fragment
    // can still contain both marks, and the span check passes. Measured
    // 2026-09-05 by inserting one pair into the real file:
    //
    //     OK   bash syntax OK (1242 lines)      <- of a 1355-line script
    //     FAIL … does NOT parse as TypeScript
    //
    // `bash -n` silently ate 113 lines and reported success on the remainder,
    // because a fragment of a correct script is usually still correct bash. Only
    // the esbuild parse saw it. So the TypeScript half is NOT redundant with the
    // bash half and must never be dropped as "the compiler already does that":
    // for an even number of stray backticks it is the ONLY thing that fires, and
    // a line count in a green tick is not something anyone reads.
    const whole = targets.some((l) => spanList.every((m) => l.includes(m)))
    if (!whole) {
      r.bad(
        `the big script did NOT arrive whole in a single literal — there is an UNESCAPED BACKTICK inside the template literal in ${filePath}. ` +
        "Inside the script they are written \\` . " +
        `(Looked for a literal containing both '${spanList[0]}' and '${spanList[1]}'; ${targets.length} literal(s) matched the marks ${JSON.stringify(markList)}.)`,
        "Embedded bash",
      )
    }

    const ctr = dag.container().from(NODE_IMG)
      .withExec(["apk", "add", "--no-cache", "bash"])
      .withExec(["npm", "install", "-g", `esbuild@${esbuildVersion}`])
      .withMountedDirectory("/w", source)
      .withWorkdir("/w")

    // ── THE COMMENT-SPLITTING ESCAPE, and why `bash -n` cannot see it ─────
    // A `\n` written inside the literal is not two characters reaching bash: JS
    // turns it into a REAL line break. On a line that is a bash COMMENT, the
    // comment therefore ends early and whatever followed becomes a COMMAND.
    // Measured 2026-09-05:
    //
    //     # comment that ends early\nINSIDE: this became a real command
    //   ->  bash -n  exit 0          (it is syntactically valid: `INSIDE:` is a
    //                                 command name with an argument)
    //   ->  bash     line 2: INSIDE:: command not found
    //
    // So `bash -n` answers "is this valid bash", and the answer is yes. This is
    // the third time in this file that a guard was asking a different question
    // from the one that mattered, and it is checked here rather than there.
    // `mod-identity` hit it on a path only the network reached, exit 127.
    //
    // The rule is narrow ON PURPOSE: a `\n` escape on a line that IS a comment.
    // Measured against the real 1371-line script before adopting it — the file
    // has ONE `\n` escape, inside `printf '…\n'`, where a real line break is
    // exactly what is wanted, and 17 `\<newline>` continuations, both legitimate
    // and both green. A blanket "no `\n` escapes" rule would have failed the
    // repo on day one. Across all 522 literals of that file this rule matches
    // zero lines.
    //
    // What it deliberately does NOT try to catch: a `\n` after a TRAILING `#`
    // (`echo hi  # note\nBAD`). Deciding that needs quote and heredoc state,
    // i.e. a bash lexer, and a lexer that is subtly wrong turns four pipelines
    // red over correct code. Missing that shape is the cheaper mistake.
    for (const [i, lit] of whole ? targets.entries() : []) {
      lit.split("\n").forEach((line, n) => {
        if (/^\s*#/.test(line) && /(?<!\\)\\n/.test(line)) {
          const born = line.split(/(?<!\\)\\n/).slice(1).join(" ").trim()
          r.bad(
            `${filePath} literal #${i + 1} line ${n + 1}: a \`\\n\` escape inside a bash COMMENT ends the comment early, and \`${born.slice(0, 80)}\` becomes a real command at runtime. ` +
            "`bash -n` cannot see this — the result is valid bash, it just is not what was written. Write a real line break, or `\\\\n` if bash is meant to receive the two characters.",
            "Embedded bash",
          )
        }
      })
      const body = jsUnescape(lit).replace(/\$\{[^}]*\}/g, "XINTERPX")
      const p = `/probe/lit${i}.sh`
      const run = ctr.withNewFile(p, body).withExec(["bash", "-n", p], { expect: ReturnType.Any })
      const code = await run.exitCode()
      if (code !== 0) {
        const err = (await run.stderr()).trim().split("\n")[0] ?? ""
        r.bad(`${filePath} literal #${i + 1}: ${err.slice(0, 160)}`, "Embedded bash")
      } else {
        r.ok(`bash syntax OK (${lines(body).length} lines)`)
      }
    }

    // The loader is deduced from the .ts extension; nothing is emitted.
    const ts = ctr.withExec(["esbuild", filePath, "--outfile=/dev/null"], { expect: ReturnType.Any })
    if ((await ts.exitCode()) !== 0) {
      const err = (await ts.stderr()).trim().split("\n").slice(0, 6).map((l) => l.slice(0, 160)).join(" | ")
      r.bad(`${filePath} does NOT parse as TypeScript: ${err} (an unescaped backtick, or a \${…} inside the literal)`, "Embedded bash")
    } else {
      r.ok("TypeScript parses")
    }

    return r.finish("The bash inside the module is what the run executes; a file that does not compile never gets that far.")
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Read a sibling's pins file over the GitHub API. `null` on any failure —
   * every caller turns that into a FAILURE, never a skip.
   */
  private async fetchPins(repo: string, token: Secret, ref: string, pinsFile: string, cacheBust: string): Promise<string | null> {
    // Validated before it reaches a shell: the slug comes from a file this guard
    // read, and a `repo` carrying a quote would otherwise be a command in the
    // curl line rather than a path in the URL.
    if (!isSlug(repo)) return null
    try {
      const c = dag.container().from(CURL_IMG)
        .withSecretVariable("GH_TOKEN", token)
        .withEnvVariable("CACHE_BUST", cacheBust)
        .withExec(["sh", "-c",
          `curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github.raw" ` +
          `-H "X-GitHub-Api-Version: 2022-11-28" ` +
          `"https://api.github.com/repos/${repo}/contents/${pinsFile}?ref=${ref}"`,
        ], { expect: ReturnType.Any })
      if ((await c.exitCode()) !== 0) return null
      return await c.stdout()
    } catch {
      return null
    }
  }

  /**
   * The container the flag probes run in: the pinned CLI, the repo mounted, and
   * `experimentalPrivilegedNesting` on every exec so the inner `dagger` talks to
   * the engine that is already running this function.
   *
   * ── WHY IT NEEDS A TOKEN ────────────────────────────────────────────────
   * The nested session has NO git credentials. The helper lives on the host and
   * only the OUTER CLI session forwards it, so a consumer whose `dagger.json`
   * names a private `daggerverse` dependency — which is now every one of them —
   * dies at module load with `failed to load git dep`, long before flag
   * parsing. See the inertness note on `daggerFlags`.
   *
   * The credential helper is a COMMAND that reads the token from the
   * environment, not a `~/.git-credentials` file and not
   * `url.…insteadOf` with the token inlined. Both of those write the secret
   * into a layer that Dagger then caches. What gets written here is the helper
   * script; the token itself only ever exists as a `withSecretVariable` at exec
   * time.
   */
  private probeBase(source: Directory, modulePath: string, daggerVersion: string, token?: Secret): Container {
    let c = dag.container().from(PROBE_IMG)
      .withExec(["apk", "add", "--no-cache", "curl", "bash", "git"])
      .withEnvVariable("DAGGER_VERSION", daggerVersion)
      .withExec(["sh", "-c", "curl -fsSL https://dl.dagger.io/dagger/install.sh | BIN_DIR=/usr/local/bin sh"])
    if (token) {
      c = c
        .withSecretVariable("GH_TOKEN", token)
        .withExec(["git", "config", "--global", "credential.helper",
          `!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f`])
    }
    return c
      .withMountedDirectory("/w", source)
      .withWorkdir("/w")
      .withEnvVariable("DAGGER_MODULE_PATH", modulePath)
  }

  /**
   * Does the CLI accept this flag on this function? `null` when it does.
   *
   * The value passed is deliberately rubbish and deliberately an UNSET `env:` —
   * only the way it dies is interesting. If the flag exists, the error is about
   * something else (a missing required argument, an unresolvable value), and
   * that is exactly what we want to read as success. It also keeps the probe
   * from ever reaching execution: see the blind-spot note on `daggerFlags`.
   */
  private async probe(base: Container, fn: string, flag: string): Promise<FlagVerdict | null> {
    // Through `sh -c` so `$DAGGER_MODULE_PATH` expands: `withExec` passes argv
    // verbatim and would hand the CLI the literal string. The two interpolated
    // values are a function name and a flag name read out of a workflow file, so
    // they are quoted rather than trusted.
    const run = base.withExec(
      ["sh", "-c", `dagger --progress plain -m "$DAGGER_MODULE_PATH" call ${shq(fn)} ${shq(`${flag}=env:DAGGER_FLAG_PROBE_UNSET`)}`],
      { expect: ReturnType.Any, experimentalPrivilegedNesting: true },
    )
    const out = stripAnsi((await run.stdout()) + (await run.stderr()))

    // ── THE DEFAULT IS FAILURE, AND THIS IS WHY ─────────────────────────
    // Everything below classifies an ERROR. Until 2026-09-05 anything that
    // matched no classification was read as "the flag exists" — so a probe that
    // never ran at all came back green. It did: the nested session has no git
    // credentials, every consumer now has a private `daggerverse` dependency,
    // and so EVERY probe died at module load and EVERY flag passed. Measured
    // against pacha-site's real workflow with a flag that cannot exist:
    //
    //     OK   ci: 15 flags        <- it counted `--esto-no-existe-jamas` and passed it
    //
    // That is the seventh guard in this project to report green because it
    // never ran, and the most pointed one, since this guard's own header
    // explains that this class of trap is invisible to every static check.
    //
    // Enumerating the known load failures (`git authentication failed`,
    // `failed to load git dep`, `resolving module source`) would be the SAME
    // MISTAKE one level up: a list of the failures somebody has already seen,
    // silent on the next one. So the test is inverted. A flag is reported OK
    // only when the output carries POSITIVE EVIDENCE that flag parsing was
    // actually reached — the CLI's own `parsing command line arguments` stage,
    // which appears if and only if the module loaded. Absence of a known error
    // is not evidence of success.
    //
    //   module loaded    load workspace DONE / parsing command line arguments
    //   module did not   load workspace ERROR, and that stage never appears
    //
    // If a future Dagger renames that vertex, every probe becomes "no evidence"
    // and this guard goes loudly red instead of quietly green. That is the
    // correct direction for the failure to point, and the message below says so.
    if (!PARSED.test(out)) {
      const tail = out.trim().split("\n").slice(-6).join("\n")
      throw new Error(
        `guards: the flag probe never reached flag parsing, so NOTHING about this workflow's flags was verified. ` +
        `\`dagger call ${fn} ${flag}\` produced no '${PARSE_STAGE}' stage, which means the module did not load.\n\n` +
        `The usual cause is a private \`daggerverse\` dependency in the consumer's dagger.json: the nested session has no git ` +
        `credentials of its own, so pass --token with one that can read the daggerverse repo.\n\n` +
        `If the module loads fine by hand, the CLI may have renamed that stage; this guard fails rather than assuming success.\n\n` +
        `Last lines of the probe:\n${tail}`,
      )
    }

    const unknown = /unknown flag: (--[a-z0-9-]+)/.exec(out)
    if (unknown && unknown[1] === flag) {
      return { reason: "it does not exist", lookedFor: null }
    }
    const noArg = /find arg "([^"]+)"/.exec(out)
    if (noArg) {
      return { reason: "the CLI accepts it but it matches no argument in the module", lookedFor: noArg[1] }
    }
    // ── THE SHADOWED-ACCESSOR TRAP ──────────────────────────────────────
    // Third member of the same family as the digit trap: invisible to `tsc`,
    // invisible to `dagger functions`, and the error names a type the caller
    // never mentioned. See the note on `daggerFlags`. Detected on output this
    // probe was already collecting — it costs nothing extra and it cannot
    // weaken the two rules above, because it only fires on a string neither of
    // them matches.
    const shadowed = SHADOWED.exec(out)
    if (shadowed) {
      const accessor = /Address\.([A-Za-z]+)\s+ERROR/.exec(out)?.[1]
      const culprit = accessor ? `a \`@func()\` named \`${accessor}\`` : "a `@func()` whose name collides with a core address accessor"
      return {
        reason:
          `the module shadows the CLI's \`Address.${accessor ?? "<accessor>"}\` resolution, so a \`${shadowed[2]}\` arrives where a ` +
          `\`${shadowed[1]}\` is required and EVERY ${shadowed[1]} argument in the module is uninvokable. ` +
          `Rename ${culprit}`,
        lookedFor: null,
      }
    }
    return null
  }
}

// ── toolchain pins: types and parsing ────────────────────────────────────────

type ToolchainCheck =
  | { kind: "present"; file: string; literal: string; what?: string }
  | { kind: "count"; file: string; literal: string; count: number; what?: string }
  | { kind: "absent"; file: string; regex: string; what?: string }

function describe(spec: ToolchainCheck): string {
  return spec.kind === "absent" ? `absent /${spec.regex}/` : `'${spec.literal}'`
}

/**
 * `key=value` lines, first occurrence wins — the original's
 * `sed -n "s/^key=\(.*\)$/\1/p" | head -1`.
 *
 * An EMPTY value counts as undeclared, because `[[ -n "$v" ]]` treats it that
 * way and exits 1. That is not a quirk to smooth over: `node=` in a pins file is
 * a key someone half-edited, and quietly matching the empty string against every
 * file in the repo would turn the whole guard green.
 */
function readPins(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of lines(text)) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line)
    if (m && !out.has(m[1]) && m[2] !== "") out.set(m[1], m[2])
  }
  return out
}

/**
 * Substitute `{pin_key}` placeholders from the pins file.
 *
 * An undeclared key is a HARD failure, mirroring `pin()`'s `exit 1`: a check
 * whose literal silently became `const NODE_VERSION = ""` would match nothing,
 * report a mismatch, and send someone hunting a version bug that is really a
 * typo in the check.
 *
 * A placeholder must start with a letter or underscore. That is not cosmetic:
 * every pins key does (`node`, `flutter_sha256`, `android_system_image`), and
 * requiring it keeps a regex quantifier like `{2}` in an `absent` pattern from
 * being read as a placeholder named `2`.
 */
function substitute(template: string, pins: Map<string, string>, what: string): string {
  return template.replace(/\{([a-z_][a-z0-9_]*)\}/g, (_m, key: string) => {
    const v = pins.get(key)
    if (v === undefined) {
      throw new Error(`guards: the check for ${what} references pin '${key}', which the pins file does not declare (or declares empty). Add it there first — a pin nobody checks is a pin that drifts, and a check referencing a pin nobody declared checks nothing.`)
    }
    return v
  })
}

// ── shared pins: block parsing ───────────────────────────────────────────────

type Block = { members: string; keys: string[] }
type ParseOk = { ok: true; blocks: Block[] }
type ParseErr = { ok: false; code: number; where?: string }

/**
 * Flatten a pins file into its shared blocks.
 *
 * BLOCK SYNTAX (the contract, spelled out in `.toolchain-pins` itself):
 *   opening    ^# BEGIN shared pins: [^ ]+( [^ ]+)*$    — membership rides on it
 *   closing    ^# END shared pins$
 * Both matched ANCHORED and WHOLE, never by substring, so a comment quoting one
 * is prose and not a delimiter — an earlier draft delimited by substring and the
 * file's own warning paragraph closed the block early, hiding the key it was
 * written to protect. And the opening pattern REQUIRES its slug payload, so a
 * padded marker (`# ═══ BEGIN shared pins ═══`) holding the right words cannot
 * pass for one; that is the most dangerous shape there is, because it looks
 * compliant on sight.
 *
 * Inside a block: pins, `#` comments, blank lines. ANYTHING ELSE IS REJECTED,
 * loudly. Skipping a line a parser does not understand is how a block quietly
 * shrinks to fewer keys than it appears to have while the guard reports green
 * over the ones it dropped.
 *
 * Keys are matched at the START of the line. Blocks carry per-key comments by
 * house style, so a reader that assumed every line between the delimiters was a
 * pin would split a comment on `=` and invent a key — and would do it when a
 * block is READ, in the sibling's file, not when it is written.
 *
 * Codes match the original's awk exit codes so `parseReason` reads the same.
 */
function parseSections(text: string): ParseOk | ParseErr {
  const blocks: Block[] = []
  let inside = false
  let n = 0
  let ln = 0
  for (const line of lines(text)) {
    ln++
    const where = `line ${ln}: ${line}`
    if (/^# BEGIN shared pins: [^ ]+( [^ ]+)*$/.test(line)) {
      if (inside) return { ok: false, code: 4, where }
      inside = true
      n++
      blocks.push({ members: line.replace(/^# BEGIN shared pins: /, ""), keys: [] })
      continue
    }
    if (/^# END shared pins$/.test(line)) {
      if (!inside) return { ok: false, code: 5, where }
      inside = false
      continue
    }
    // A line that opens with the delimiter words but carries no slugs is a
    // marker someone MEANT to write. Treating it as a comment is how a whole
    // block disappears.
    if (/^# BEGIN shared pins$/.test(line)) return { ok: false, code: 7, where }
    if (/^# BEGIN shared pins:[^ ]/.test(line)) return { ok: false, code: 7, where }
    if (!inside) continue
    if (/^[A-Za-z0-9_]+=/.test(line)) { blocks[n - 1].keys.push(line); continue }
    if (/^\s*$/.test(line)) continue
    if (/^#/.test(line)) continue
    return { ok: false, code: 9, where }
  }
  if (n === 0) return { ok: false, code: 3 }
  if (inside) return { ok: false, code: 6 }
  return { ok: true, blocks }
}

/** Turns a parse code into something a human can act on. */
function parseReason(code: number): string {
  switch (code) {
    case 3: return "has no opening delimiter matching '^# BEGIN shared pins: <slug> [<slug> ...]' (a padded or reworded marker does not count, and neither does one with no slugs on it)"
    case 4: return "opens a shared block while another is still open"
    case 5: return "has a '# END shared pins' line with no block open"
    case 6: return "opens a shared block and never closes it with '# END shared pins'"
    case 7: return "has an opening delimiter with no membership on it — a group that does not say who it binds is not an agreement (expected: '# BEGIN shared pins: owner/repo owner/repo …')"
    case 9: return "has a line inside a shared block that is neither a pin, a '#' comment nor blank"
    default: return `could not be parsed (code ${code})`
  }
}

/**
 * Members sorted and space-joined. The identity of a group IS its membership, so
 * this is what matches our block against the sibling's — never the order the
 * slugs happen to be written in.
 */
function memberKey(members: string): string {
  return [...new Set(members.split(" ").filter((s) => s !== ""))].sort().join(" ")
}

function keyOf(kv: string): string {
  return /^([A-Za-z0-9_]*)=/.exec(kv)?.[1] ?? ""
}

function pinOf(key: string, kvs: string[]): string | undefined {
  for (const kv of kvs) {
    if (kv.startsWith(`${key}=`)) {
      const v = kv.slice(key.length + 1)
      // The original's `pin_of` pipes through `[[ -z ]]`, so an empty value is
      // "not declared" — and here that becomes "the sibling does not declare it",
      // which is a failure, not a silent equal-to-nothing match.
      return v === "" ? undefined : v
    }
  }
  return undefined
}

function isSlug(s: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s)
}

function assertSlug(s: string, what: string): void {
  if (!isSlug(s)) throw new Error(`guards: '${what}' is '${s}', which is not an owner/name slug`)
}

// ── dagger flags: workflow scanning ──────────────────────────────────────────

type ScanRow = { job: string | null; step: string | null; env: Set<string>; line: string }
type FlagVerdict = { reason: string; lookedFor: string | null }

// `${{ github.run_id }}` carries spaces: splitting the line on whitespace breaks
// it into three tokens and the second, bare, reads as "a chained function
// starts here" — so the check used to stop at the first flag holding a GitHub
// expression and the ~8 following flags of `ci` (--run-id, --ref, --sha,
// --actor…) were NOT looked at. It printed green and said "20 flags", which is
// the worst shape of a hole: the output itself gives it away and nobody reads it.
// Collapsed to one opaque token BEFORE splitting, over the whole file.
const GH_EXPR = /\$\{\{[\s\S]*?\}\}/g
const ENV_KEY = /^([A-Z][A-Z0-9_]*):/
const JOB_KEY = /^ {2}([a-z][a-z0-9._-]*):\s*$/
const STEP_NAME = /^\s*-?\s*name:\s*(.+?)\s*$/

/**
 * (job, step, env VISIBLE at this point, line) for every line with content.
 *
 * An INDENTATION SCANNER, and NOT a YAML parser. The first version used
 * `yaml.safe_load`: it was more correct and it died on its first run with
 * `ModuleNotFoundError: No module named 'yaml'`. The equivalent here would be an
 * npm dependency in a guard that runs before everything else; the shape of the
 * mistake is the same, so this needs nothing but string handling. The files use
 * two spaces per level consistently, which identifies the four places that
 * actually matter:
 *
 *     2   the job key           `  ci-ios:`
 *     4   the job's `env:`      ->  keys at 6
 *     6   a step starting       `      - name: …`
 *     8   the step's `env:`     ->  keys at 10
 *
 * "VISIBLE" is the important word and the reason the two levels are kept apart
 * instead of asking "does this variable appear in the job?". An env defined in
 * ANOTHER step's `env:` is not visible to this step, and that is exactly the
 * failure that got through on 2026-09-04: `E2E_RUN_TOKEN` sat in the native
 * script's step and the `dagger call ci` two steps below expanded it to the
 * empty string. A guard that only looked at the whole job would have approved
 * that state — i.e. it would be written from the implementation and unable to
 * fail it, which is the class this repo has already paid for four times.
 */
function scanWorkflow(text: string): ScanRow[] {
  const rows: ScanRow[] = []
  const raw = text.replace(GH_EXPR, "GHEXPR").replace(/\\\n/g, " ")

  let job: string | null = null
  let step: string | null = null
  let jobEnv = new Set<string>()
  let stepEnv = new Set<string>()
  let envAt: number | null = null

  for (const chunk of raw.split("\n")) {
    const stripped = chunk.trim()
    if (!stripped || stripped.startsWith("#")) continue
    const indent = chunk.length - chunk.replace(/^ +/, "").length

    if (envAt !== null && indent <= envAt) envAt = null
    if (envAt !== null) {
      const m = ENV_KEY.exec(stripped)
      if (m) (envAt === 4 ? jobEnv : stepEnv).add(m[1])
      continue
    }

    const jm = JOB_KEY.exec(chunk)
    if (jm && indent === 2) {
      job = jm[1]; jobEnv = new Set(); step = null; stepEnv = new Set()
      continue
    }
    if (indent === 6 && stripped.startsWith("- ")) {
      step = "(unnamed)"; stepEnv = new Set()
    }
    const sm = STEP_NAME.exec(chunk)
    if (sm) { step = sm[1]; continue }
    if (stripped === "env:" && (indent === 4 || indent === 8)) { envAt = indent; continue }

    rows.push({ job, step, env: new Set([...jobEnv, ...stepEnv]), line: chunk })
  }
  return rows
}

/**
 * (function, flags, the token that cut it short) when the line invokes
 * `dagger … call <fn> …`, else null.
 */
function invocation(line: string): { fn: string; flags: string[]; truncated: string | null } | null {
  if (!line.includes("dagger") || !line.includes(" call ")) return null
  // A QUOTED invocation inside a message is not an invocation. These workflows
  // say things like «check the log of "dagger call ci --platform=ios"», and
  // probing that prose measures the wrong thing: today it only dirties the
  // output with a phantom `ci: 1 flags`, but the day a message names a RETIRED
  // flag — to say precisely that it no longer exists — the guard would go red
  // over a sentence.
  if (/^\s*(echo|printf)\b/.test(line)) return null
  const tokens = line.trim().split(/\s+/)
  const head = tokens.indexOf("call")
  if (head === -1) return null
  const fn = tokens[head + 1]
  if (fn === undefined) return null
  if (!/^[a-z0-9][a-z0-9-]*$/.test(fn)) return null

  const flags: string[] = []
  let truncated: string | null = null
  for (const tok of tokens.slice(head + 2)) {
    // `${VAR:+--flag=value}` — the workflow's conditional flag. The inner one is
    // what matters: if it does not exist, the run dies just the same whenever
    // the env is set.
    const inner = /\$\{[A-Za-z_][A-Za-z0-9_]*:\+(--[a-z0-9-]+)/.exec(tok)
    if (inner) { flags.push(inner[1]); continue }
    if (tok.startsWith("--")) { flags.push(tok.split("=", 1)[0]); continue }
    if (tok.startsWith("$") || tok.startsWith('"') || tok.startsWith("'")) continue
    // A bare token: a chained function starts here (`export`, `stdout`…).
    truncated = tok
    break
  }
  return { fn, flags, truncated }
}

// ── dagger flags: pairings ───────────────────────────────────────────────────

/**
 * The OTHER direction of the seam, and only in the CONDITIONAL form.
 *
 * Rules of the shape "if you pass X, Y is needed". There is deliberately NO list
 * of mandatory flags: that list goes stale on the first change — which flags are
 * needed depends on the platform and on which gates are armed — and from then on
 * it lies with exactly the confidence with which it tells the truth today. A
 * conditional rule does not rot: it is still true the day a `--platform=web`
 * appears, and if X goes away the rule stops applying by itself.
 *
 * Which means: a `--run-attempt` missing next to a `--run-id` is no longer
 * green. What IS still green is everything else in that direction — a flag that
 * is needed and has no declared partner is seen by nobody. That is what the
 * module's own `requireSecret()` and the run itself are for.
 *
 * `exceptFunctions` is an EXCLUSION list on purpose. With an inclusion list — a
 * "check only these three functions" — a NEW function composing the same thing
 * would go unchecked and green, which is the failure direction this exists not
 * to have. As an exclusion, anything new is checked by default: if some other
 * function ever uses the flag differently it comes out red — noisy, visible, and
 * forcing somebody to add it here WITH its reason written down.
 *
 * And the limit that teaches, worth keeping next to the rule: conditional
 * pairings do not rot when a NEW flag appears, but they DO when an existing flag
 * acquires a second meaning. The shape of the rule does not fix that; someone
 * has to look again. It happened on 2026-09-04, the same day they were written.
 */
type Pairing =
  | { kind: "flagNeedsFlag"; flag: string; needs: string; exceptFunctions?: string[]; why: string }
  | { kind: "flagNeedsEnv"; flag: string; env: string; why: string }
  | { kind: "envNeedsFlag"; env: string; flag: string; onFunction: string; why: string }

function checkPairings(rows: ScanRow[], rules: Pairing[]): { seen: number; problems: { rule: string; where: string; why: string }[] } {
  const problems: { rule: string; where: string; why: string }[] = []
  let seen = 0
  // Per job, for the symmetric rule, which can only be decided once the whole
  // job has been seen.
  const perJob = new Map<string, Map<string, { env: boolean; call: boolean }>>()

  for (const row of rows) {
    const jobName = row.job ?? "(no job)"
    for (const rule of rules) {
      if (rule.kind !== "envNeedsFlag") continue
      const byEnv = perJob.get(rule.env) ?? new Map()
      perJob.set(rule.env, byEnv)
      const st = byEnv.get(jobName) ?? { env: false, call: false }
      // The env is recorded HERE, in the single pass: `scanWorkflow` already
      // brings it resolved for this point of the file, so a second pass would
      // only add the chance of the two disagreeing.
      st.env = st.env || row.env.has(rule.env)
      byEnv.set(jobName, st)
    }

    const found = invocation(row.line)
    if (!found) continue
    const { fn, flags } = found
    const where = `${jobName} · ${row.step ?? "(unnamed)"} · call ${fn}`

    for (const rule of rules) {
      if (rule.kind === "flagNeedsFlag") {
        if (!flags.includes(rule.flag)) continue
        if ((rule.exceptFunctions ?? []).includes(fn)) continue
        seen++
        if (!flags.includes(rule.needs)) {
          problems.push({ rule: `${rule.flag} ⇒ ${rule.needs}`, where, why: rule.why })
        }
      } else if (rule.kind === "flagNeedsEnv") {
        if (!flags.includes(rule.flag)) continue
        seen++
        if (!row.env.has(rule.env)) {
          problems.push({ rule: `${rule.flag} ⇒ ${rule.env} visible`, where, why: rule.why })
        }
      } else {
        if (!flags.includes(rule.flag)) continue
        if (fn !== rule.onFunction) continue
        const byEnv = perJob.get(rule.env) ?? new Map()
        perJob.set(rule.env, byEnv)
        const st = byEnv.get(jobName) ?? { env: false, call: false }
        st.call = true
        byEnv.set(jobName, st)
      }
    }
  }

  for (const rule of rules) {
    if (rule.kind !== "envNeedsFlag") continue
    for (const [jobName, st] of perJob.get(rule.env) ?? new Map()) {
      if (!st.env) continue
      seen++
      if (!st.call) {
        problems.push({ rule: `${rule.env} ⇒ ${rule.flag}`, where: jobName, why: rule.why })
      }
    }
  }
  return { seen, problems }
}

// ── embedded bash ────────────────────────────────────────────────────────────

const SIMPLE_ESCAPE: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0",
  "\\": "\\", "`": "`", "'": "'", '"': '"', $: "$", "\n": "",
}

/**
 * What JS ACTUALLY does with a template literal: an UNKNOWN escape (`\(`, `\)`,
 * `\[` …) LOSES the backslash.
 *
 * This is the whole point of the guard. A naive simulation that keeps the
 * backslash (Python's `unicode_escape` does, and so does anything that just
 * unescapes the sequences it knows) reports OK over a script bash rejects with
 * "syntax error near unexpected token".
 */
function jsUnescape(s: string): string {
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c !== "\\" || i + 1 >= s.length) { out.push(c); i++; continue }
    const nxt = s[i + 1]
    if (nxt in SIMPLE_ESCAPE) { out.push(SIMPLE_ESCAPE[nxt]); i += 2; continue }
    if (nxt === "u" || nxt === "x") {
      const len = nxt === "u" ? 4 : 2
      const hex = s.slice(i + 2, i + 2 + len)
      const code = /^[0-9a-fA-F]+$/.test(hex) && hex.length === len ? parseInt(hex, 16) : NaN
      if (Number.isNaN(code)) { out.push(nxt); i += 2 } else { out.push(String.fromCharCode(code)); i += 2 + len }
      continue
    }
    out.push(nxt); i += 2 // ← THE CASE THAT MATTERS
  }
  return out.join("")
}

// ── misc ─────────────────────────────────────────────────────────────────────

/**
 * Race a stage against a deadline, with an error that names WHAT expired.
 *
 * Contract invariant 5: the per-stage `timeout-minutes` that lived on the YAML
 * steps has to be reimplemented in TypeScript, because fusing steps into one
 * `dagger call` deletes them and leaves only the 150-minute job ceiling. A
 * generic "timed out" would be as useless as that ceiling, so the message says
 * which stage and how far it got.
 */
async function withDeadline<T>(work: Promise<T>, seconds: number, message: string): Promise<T> {
  // `cancel` rather than a typed timer handle: `ReturnType` in this file is
  // Dagger's enum, not TypeScript's built-in generic, so `ReturnType<typeof
  // setTimeout>` does not mean here what it means anywhere else.
  let cancel: (() => void) | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), seconds * 1000)
    cancel = () => clearTimeout(t)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    cancel?.()
  }
}

/**
 * The engine's assign error when a module function has shadowed a core address
 * accessor. Measured on v0.21.9 (see `daggerFlags`):
 *
 *   cannot set field of type dagql.ObjectResult[*github.com/dagger/dagger/core.Secret]
 *   with dagql.String
 *
 * Group 1 is the core type that was required, group 2 the one that arrived. The
 * match is on the ASSIGN error rather than on a function name, because a
 * name-based check would flag legitimate code and would not see the next member
 * of this family — whatever it turns out to be named.
 */
const SHADOWED = /cannot set field of type dagql\.\w+\[\*?[^\]]*?core\.(\w+)\] with dagql\.(\w+)/

/**
 * The engine version the module under test declares, from its own `dagger.json`.
 *
 * ── WHY IT IS DERIVED AND NOT DEFAULTED ─────────────────────────────────────
 * A probe running a different CLI from the pipeline measures the wrong thing —
 * `repo-web` was right about that. But the value belongs in neither place it was
 * proposed. A constant in THIS module is right on the day it is written and
 * silently wrong after the next engine bump, in every consumer at once, which is
 * the floating-pin-dressed-as-a-pin shape `toolchainPins` exists to kill. A
 * constant in each CONSUMER is one more copy of a number that already exists two
 * lines away.
 *
 * It already lives in `<modulePath>/dagger.json` as `engineVersion` — the version
 * this very module is run with, so it cannot disagree with itself — and
 * `toolchainPins` ALREADY asserts that literal against `.toolchain-pins`
 * (`"engineVersion": "v{dagger}"`, a check every consumer carries). So reading it
 * needs no new pin, no new flag, and no new place to drift.
 *
 * Unreadable or absent is a HARD failure: guessing a CLI version would make the
 * probe measure something nobody asked for.
 */
async function engineVersionOf(source: Directory, modulePath: string): Promise<string> {
  const path = `${modulePath.replace(/\/+$/, "")}/dagger.json`
  const raw = await readMaybe(source, path)
  if (raw === null) {
    throw new Error(`guards: cannot read ${path}, so the probe cannot know which Dagger CLI the module under test is run with. A probe on a different CLI than the pipeline measures the wrong thing. Fix the path, or pass --dagger-version deliberately.`)
  }
  let v: unknown
  try {
    v = (JSON.parse(raw) as { engineVersion?: unknown }).engineVersion
  } catch (e) {
    throw new Error(`guards: ${path} is not valid JSON (${(e as Error).message})`)
  }
  if (typeof v !== "string" || !/^v?\d+\.\d+\.\d+/.test(v)) {
    throw new Error(`guards: ${path} declares no usable 'engineVersion' (got ${JSON.stringify(v)}). The probe will not guess which CLI to install.`)
  }
  return v.replace(/^v/, "")
}

/**
 * The CLI stage that proves the module LOADED and the command line actually got
 * parsed. Present if and only if `load workspace` succeeded — measured on
 * v0.21.9 against both a resolvable module and one whose private git dependency
 * cannot be fetched. This is the positive evidence `probe()` requires before it
 * will call any flag OK; see the note there for why it is not a list of known
 * failures.
 */
const PARSE_STAGE = "parsing command line arguments"
const PARSED = /parsing command line arguments/

const ANSI = /\x1b\[[0-9;]*m/g
function stripAnsi(s: string): string { return s.replace(ANSI, "") }

/** Single-quote for `sh -c`. The values are function and flag names read from a workflow. */
function shq(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'` }
