/**
 * The organisation's two security gates — gitleaks and Trivy — with the exact
 * invocations ADR-0003 §2.2 pins.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 * The same two gates were written five times by hand: `pacha` (a `dagger -c`
 * shell pipeline), `pacha-api`, `pacha-site` and `pacha-ops` (three `docker run`
 * blocks), and the Trivy step inside `pacha-api`'s Dagger module. Measured
 * 2026-09-05, the five copies had already drifted in two ways that no CI could
 * see, because every one of them was green:
 *
 *   · `pacha` and `pacha-api` pass `--config /repo/.gitleaks.toml`; `pacha-site`
 *     and `pacha-ops` do not — and only the first two HAVE that file. So the
 *     flag was not a divergence, but nothing anywhere enforced the pairing: add
 *     the file to `pacha-site` and its gate would silently keep ignoring it.
 *   · `pacha-ops` pins the image through a `GITLEAKS_VERSION` env var and the
 *     other three write `v8.21.2` as a literal. Four places to change a pin the
 *     ADR requires to be identical in all of them.
 *
 * ── THE INVOCATIONS ARE NOT PARAMETERS ──────────────────────────────────────
 * `--severity`, `--pkg-types`, `--ignore-unfixed` and gitleaks' flags are
 * deliberately NOT exposed as arguments. ADR-0003 §2.2: *"que el gate sea
 * idéntico es lo que lo hace comparable entre proyectos: si se cambia en uno, se
 * cambia en todos"*. A knob here turns that invariant into a convention, and a
 * convention is what the drift above already came from. Changing a threshold
 * means editing this file and cutting a tag, which is exactly the ceremony the
 * ADR asks for.
 *
 * ── WHY RUNNING THIS IN DAGGER IS NOT A DEVIATION ───────────────────────────
 * ADR-0003 §4.4 says gitleaks lives in GHA and not in Dagger, because it scans
 * the git HISTORY, which lives in the runner's checkout and not in the build
 * context. That reason is about WHERE THE `.git` COMES FROM, not about who
 * launches the container: the contract
 * (`org-gitops/docs/daggerverse-ci-contract.md` §4, invariant 3) settles it —
 * *"running that same image inside a Dagger container satisfies this; it is not
 * a deviation, and this line exists so nobody reads it as one"*. `pacha` has
 * been doing exactly this since 2026-08-21, because `arc-bithome` has no Docker
 * daemon and `docker run` cannot work there at all.
 *
 * The constraint the ADR really names survives, and this module ENFORCES it
 * instead of documenting it: `gitleaks` refuses to run on a directory whose
 * `.git` is missing or shallow. See the guard on that function.
 */
import { dag, Container, Directory, File, object, func } from "@dagger.io/dagger"

/**
 * ADR-0003 §2.2, pinned. The OFFICIAL binary image and never
 * `gitleaks-action@v2`: these are ORGANISATION repos and the marketplace action
 * requires a licence (`GITLEAKS_LICENSE`). The image is Alpine-based and ships
 * `/usr/bin/git`, which is what lets the history guard below run in the same
 * container instead of pulling a second image.
 */
const GITLEAKS_IMG = "ghcr.io/gitleaks/gitleaks:v8.21.2"

/** ADR-0003 §2.2, pinned. Same version in every pipeline, on purpose. */
const TRIVY_IMG = "aquasec/trivy:0.58.0"

/** Where the scanned repository is mounted. Flags below reference this path. */
const REPO = "/repo"

/** Where the image tarball is mounted. `--input` references this path. */
const IMAGE_TAR = "/image.tar"

/** The config filename gitleaks conventionally reads from a repository root. */
const CONFIG_FILE = ".gitleaks.toml"

/**
 * Re-throw an exec failure with the tool's own output attached.
 *
 * Dagger's ExecError renders a truncated tail, and for these two tools the tail
 * is the least useful part: Trivy's finding TABLE and gitleaks' finding list are
 * the entire reason a human opens a red run. Losing them turns "the gate found
 * something" into "the gate exited 1", which sends the reader back to run the
 * scan by hand to learn what it already knew.
 */
function failWith(gate: string, e: unknown): never {
  const x = e as { stdout?: string; stderr?: string; message?: string }
  const body = [x.stdout, x.stderr].map((s) => (s ?? "").trim()).filter(Boolean).join("\n")
  throw new Error(`${gate}\n${body || x.message || String(e)}`)
}

@object()
export class Scan {
  /**
   * Secret scan over the FULL git history. Fails the build on any finding.
   *
   * `gitleaks detect --source /repo --redact --exit-code 1`, plus
   * `--config /repo/.gitleaks.toml` when there is one. `--redact` keeps the
   * secret out of the logs — a gate that prints what it found publishes it to
   * everyone with read access to the run. `--exit-code 1` is what makes it a
   * gate and not a report.
   *
   * ── THE `source` MUST CARRY A COMPLETE `.git` ───────────────────────────────
   * This scans commits, not the working tree. The caller must hand over a
   * directory taken from a `fetch-depth: 0` checkout, with `.git` included (do
   * not add it to a Dagger exclude, and note that `actions/checkout` inside a
   * job-level `container:` without git falls back to the API tarball and has no
   * history at all).
   *
   * A shallow checkout does not fail: gitleaks finds nothing in one commit and
   * exits 0. **The gate goes green without having looked at anything**, which is
   * strictly worse than not having the gate, because now there is a green tick
   * claiming otherwise. So this function refuses to scan a shallow or
   * git-less directory instead of reporting success on it — that check is the
   * part of ADR-0003 §2.2 that a YAML comment could only ask for politely.
   *
   * False positives are retired by FINGERPRINT in `.gitleaksignore`
   * (`commit:file:rule:line`), which gitleaks reads from the scanned root — so a
   * NEW secret in the same file gets a different fingerprint and still stops the
   * pipeline. Path allowlists in `.gitleaks.toml` are reserved for
   * machine-generated files (`pbxproj`, lockfiles) whose fingerprints would need
   * regenerating every week.
   *
   * @param source          repository to scan, `.git` included, from a `fetch-depth: 0` checkout.
   * @param config          path to a gitleaks config RELATIVE TO `source`. Empty = auto:
   *                        use `.gitleaks.toml` if the repo has one, otherwise the built-in
   *                        rules. An explicit path that does not exist is an error, never a
   *                        silent fallback to the weaker default ruleset.
   * @param minHistoryDepth minimum number of commits the history must contain. 0 only
   *                        requires that the clone is not shallow, which is the check that
   *                        actually protects the gate; a positive value is a second belt for
   *                        a repo whose real history is known to be much longer.
   */
  @func()
  async gitleaks(source: Directory, config = "", minHistoryDepth = 0): Promise<string> {
    const base = dag.container().from(GITLEAKS_IMG).withDirectory(REPO, source)

    // The guard runs in the SAME image as the scan: the gitleaks image is Alpine
    // with git in it, so this costs one exec on a layer that is already there,
    // not a second pull. It reports instead of failing, so the error the caller
    // sees names the parameter rather than being a raw non-zero exit.
    const probe = await base
      .withExec([
        "sh",
        "-c",
        `cd ${REPO} || exit 0
git config --global --add safe.directory ${REPO} >/dev/null 2>&1 || true
git rev-parse --git-dir >/dev/null 2>&1 || { echo "nogit unknown 0"; exit 0; }
echo "git $(git rev-parse --is-shallow-repository 2>/dev/null || echo unknown) $(git rev-list --count HEAD 2>/dev/null || echo 0)"`,
      ])
      .stdout()
    const [hasGit, shallow, countRaw] = probe.trim().split(/\s+/)
    const commits = Number(countRaw) || 0

    if (hasGit !== "git") {
      throw new Error(
        `gitleaks: 'source' has no .git, so there is no history to scan and this gate would pass without looking at anything. Pass a directory from a 'fetch-depth: 0' checkout and do not exclude .git from the Dagger context.`,
      )
    }
    if (shallow === "true") {
      throw new Error(
        `gitleaks: 'source' is a SHALLOW clone. gitleaks would scan one commit, find nothing and exit 0 — a green gate that read no history. Check out with 'fetch-depth: 0' (ADR-0003 §2.2).`,
      )
    }
    if (minHistoryDepth > 0 && commits < minHistoryDepth) {
      throw new Error(
        `gitleaks: 'source' has ${commits} commits and 'minHistoryDepth' requires at least ${minHistoryDepth}. Either the checkout is truncated or the floor is wrong; both are worth knowing before trusting the result.`,
      )
    }

    // Auto vs explicit. Auto exists because the four repos this replaces
    // disagree about the flag purely because two of them have the file and two
    // do not; with auto, the SAME call is correct in all four and stays correct
    // the day one of them gains a config. Explicit fails closed: a typo in the
    // path would otherwise make gitleaks fall back to its built-in rules and
    // report a perfectly plausible green from a weaker gate than the caller
    // asked for.
    let configPath = ""
    if (config) {
      if (!(await source.exists(config))) {
        throw new Error(`gitleaks: 'config' points at '${config}', which is not in 'source'. Refusing to fall back to the built-in ruleset silently — that would be a weaker gate reported as the one you asked for.`)
      }
      configPath = config
    } else if (await source.exists(CONFIG_FILE)) {
      configPath = CONFIG_FILE
    }

    const args = ["gitleaks", "detect", "--source", REPO]
    if (configPath) args.push("--config", `${REPO}/${configPath}`)
    args.push("--redact", "--exit-code", "1")

    try {
      const c = base.withExec(args)
      // gitleaks writes its report to STDERR and leaves stdout empty on a clean
      // run, so returning only stdout would return "" from a gate that did work.
      const [out, err] = [await c.stdout(), await c.stderr()]
      return [out.trim(), err.trim()].filter(Boolean).join("\n")
    } catch (e) {
      failWith(`gitleaks: leaks found over ${commits} commits (secrets redacted). Retire a reviewed false positive by FINGERPRINT in .gitleaksignore, never by path.`, e)
    }
  }

  /**
   * Vulnerability scan of a container image, fail-closed BEFORE it is published.
   *
   * `trivy image --input /image.tar --severity CRITICAL,HIGH --ignore-unfixed
   * --pkg-types library --exit-code 1 --format table` — the invocation ADR-0003
   * §2.2 pins, character for character, on `aquasec/trivy:0.58.0`.
   *
   * ⚠️ The binary is named explicitly in the exec. **Dagger's `withExec` does not
   * use the container's ENTRYPOINT**, so `["image", "--input", …]` would run
   * `image` as a command and fail with something that reads like a Trivy usage
   * error rather than a Dagger one. This is already how `pacha-api`'s module
   * does it, and the comment there exists for the same reason.
   *
   * ── WHY THE INVOCATION IS SHAPED LIKE THAT ──────────────────────────────────
   * `--pkg-types library` scopes the gate to OUR dependencies, the ones a bump
   * in this repo can actually fix. Base-image OS CVEs (distroless/debian) are
   * only closed by Google bumping the base, so gating on them is a build stuck
   * red on something nobody here can move; they are covered post-publish by
   * Artifact Registry's Artifact Analysis, which is enabled on both pacha
   * projects and produces live findings. `--ignore-unfixed` is the same idea for
   * the rest: a CVE with no fix available is not an action.
   *
   * It runs BEFORE the push, against the local tarball, because an image with a
   * critical CVE that already reached the registry can be deployed by anyone.
   *
   * ⚠️ A run is cached on the CONTENT of the image. Scanning the same digest two
   * weeks later replays the old verdict without re-downloading the vulnerability
   * DB, so this gate answers "was this image clean when it was built", not "is it
   * clean today". Rescanning what is already published is Artifact Analysis'
   * job, by design (ADR-0003 §7.2) — no cache-buster is offered here, because a
   * knob the caller must remember to set is a gate that fails open by omission.
   *
   * @param image   container to scan; its tarball is produced here.
   * @param tarball a docker-archive tarball, when the caller already has one.
   *                Exactly one of `image` or `tarball` must be given.
   */
  @func()
  async trivy(image?: Container, tarball?: File): Promise<string> {
    // Fail closed on both mistakes. Silently preferring one over the other would
    // let a caller who passed the wrong argument watch a DIFFERENT image go
    // green, and neither of them is the one about to be published.
    if (image && tarball) {
      throw new Error("trivy: pass EITHER 'image' OR 'tarball', not both — with two sources there is no way to tell which one the green verdict is about.")
    }
    if (!image && !tarball) {
      throw new Error("trivy: needs 'image' (a Container) or 'tarball' (a docker-archive File). A scan with nothing to scan would exit 0 and look exactly like a pass.")
    }

    const tar = tarball ?? (image as Container).asTarball()
    try {
      const out = await dag
        .container()
        .from(TRIVY_IMG)
        .withMountedFile(IMAGE_TAR, tar)
        .withExec([
          "trivy", "image", "--input", IMAGE_TAR,
          "--severity", "CRITICAL,HIGH",
          "--ignore-unfixed",
          "--pkg-types", "library",
          "--exit-code", "1",
          "--format", "table",
        ])
        .stdout()
      // `--format table` prints NOTHING to stdout on a clean image (its logs go to
      // stderr, and the stderr of a passing run is 100 MB of DB-download progress
      // bar, which is why it is not returned). Returning "" would make a caller
      // that echoes this value show a blank where the gate's verdict should be —
      // indistinguishable from the gate not having run.
      return out.trim() || "trivy: no CRITICAL/HIGH with a fix in the libraries shipped by this image."
    } catch (e) {
      failWith("trivy: CRITICAL/HIGH with a fix available, in a library we ship. Do not publish this image; bump the dependency.", e)
    }
  }
}
