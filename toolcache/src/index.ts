/**
 * The npm download cache + `node_modules` round-trip that `pacha`, `pacha-api` and
 * `pacha-site` already hand-roll identically, extracted so the rest of the
 * organisation's Node/TypeScript pipelines can adopt it instead of running with no
 * cache at all.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 * Dagger's own GHA cache exporter (`_EXPERIMENTAL_DAGGER_CACHE_CONFIG: type=gha`)
 * never stored anything measurable in any repo that carried it — `GET
 * /repos/<org>/<repo>/actions/caches` returned 0 entries in every case checked —
 * and `pacha-site` (commit dbc86e8, 2026-09-05) found it is also a race: with more
 * than one Dagger session per job, the exporter flushes on EACH session's close,
 * which can collide with the next session's local filesync parent snapshot.
 *
 * The alternative `pacha`/`pacha-api`/`pacha-site` already use is userland: a plain
 * tarball of the npm download cache and `node_modules`, carried across runs by
 * `actions/cache/restore`+`save` steps the WORKFLOW controls directly, not by a
 * Dagger-internal exporter. It has no session-end export and nothing for a
 * mid-session race to corrupt. This module is that pattern, generalised.
 *
 * ── THE SHAPE, UNCHANGED FROM THE THREE HAND-ROLLED COPIES ──────────────────
 * Two Dagger `cacheVolume`s per caller, shared by name within ONE Dagger engine —
 * which is exactly the lifetime of a single GitHub Actions job. `npmCache` mounts
 * both onto a container the caller has already prepared (source mounted, workdir
 * set) and seeds them from a previous run's `exportNpm` output when the caller has
 * one. `exportNpm` reads the SAME two volumes back out as a `Directory` the
 * workflow can hand to `actions/cache/save`. Both calls must happen within the
 * SAME job: a `cacheVolume` is engine-internal state, and a Dagger engine does not
 * survive past the job that started it — it is not a cross-job handoff channel
 * (see this repository's README, "A cache volume is NOT a handoff channel",
 * measured on `elinvo-site`).
 *
 * ── CACHEVOLUME NAMESPACING: WHY THE VOLUMES ARE PASSED IN, NOT KEYED BY STRING ──
 * Dagger namespaces a `dag.cacheVolume(key)` call by the MODULE that makes the
 * call, not just by the key string (see `docs/cache-investigation-2026-10-19.md`
 * in `org-gitops` for the full trace evidence). A v0.1.x caller that mounted
 * `dag.cacheVolume('<repo>-npm')` in its own `base()` and then called this
 * module's `npmCache(cacheKey: '<repo>-npm', ...)` was never touching the same
 * volume: its own call landed in `mod(<repo>-ci.)`, while this module's internal
 * `dag.cacheVolume()` call for the identical string landed in
 * `mod(toolcache...)` — two disjoint volumes that only ever shared a label, so
 * the `actions/cache` round-trip seeded and exported a volume `npm ci` never read
 * from (confirmed: every restore showed ~336 bytes, i.e. two empty tars).
 *
 * The fix is for the CALLER to create the `CacheVolume`s (so they are namespaced
 * to the caller's own module, matching whatever `base()` already mounts) and hand
 * the resulting objects to `npmCache`/`exportNpm`, which now only mount whatever
 * `CacheVolume` they are given — they never call `dag.cacheVolume()` themselves.
 * Passing an already-constructed `CacheVolume` across the module boundary carries
 * its resolved identity with it, so there is no second, toolcache-internal
 * namespace left to diverge from.
 *
 * `warmTools` IS REQUIRED, not optional, and that is deliberate (v0.1.1). An
 * OPTIONAL `Directory` parameter on a function in a dependency module crashes the
 * generated TypeScript client with "Cannot read properties of undefined (reading
 * 'replace')" the moment a caller actually supplies a value — but works with no
 * error when the caller omits the flag entirely. Measured with a two-line probe
 * function doing nothing but returning its input: identical signature, `Directory`
 * required — works; optional — crashes, in BOTH cases with a value actually
 * passed. Every real caller (a GHA workflow that always runs `mkdir -p` before
 * `--warm-tools=$DIR`, cache hit or not) always supplies a value, so an optional
 * parameter here would crash on every single real invocation. Callers pass
 * `dag.directory()` (empty) when they have nothing to seed from; this function's
 * own cache-miss handling (the `-s` test below) already treats an empty directory
 * exactly like a true miss.
 */
import { dag, Container, Directory, CacheVolume, object, func } from "@dagger.io/dagger"

/**
 * Minimal image for `exportNpm`'s throwaway container. It only needs `tar` to read
 * the two cacheVolumes back out — not Node, not the caller's own build image — so
 * it does not couple this module to any caller's Node version.
 */
const EXPORT_IMG = "alpine:3.21"

/** Filenames inside the `Directory` `exportNpm` returns and `npmCache` consumes. */
const NPM_TAR = "npm.tar"
const NODE_MODULES_TAR = "node-modules.tar"

@object()
export class Toolcache {
  /**
   * Mounts an npm download cache (`/root/.npm`) and a `node_modules` cache onto
   * `base`, seeded from a previous run's `exportNpm` output when `warmTools` is
   * given. A miss is not an error: `base` comes back with the two cacheVolumes
   * mounted but empty, and the caller's own install step runs cold exactly as it
   * would with no cache at all.
   *
   * `base` must already have its source directory mounted and its workdir set to
   * where `node_modules` should live — this only adds the two mounts and, on a
   * warm run, untars into them; it does not run `npm ci` or any install step.
   *
   * @param base             container with the repository mounted and workdir set.
   * @param npmCacheVolume   the `CacheVolume` to mount at `/root/.npm`. Create it in
   *                         the CALLING repository's own module with
   *                         `dag.cacheVolume('<repo>-npm')` — the same call the
   *                         caller's own `base()` already makes — and pass the
   *                         resulting object here and to `exportNpm`. Do not let
   *                         this module mint its own from a string: a `CacheVolume`
   *                         created inside `toolcache` is namespaced to `toolcache`,
   *                         not to the caller, and lands in a different volume
   *                         entirely even with an identical key (see module header).
   * @param nodeModulesCacheVolume same as `npmCacheVolume`, for `node_modules`.
   * @param nodeModulesPath  absolute path where `node_modules` lives under `base`'s
   *                         workdir, e.g. "/src/node_modules".
   * @param warmTools        the `Directory` a previous run's `exportNpm` returned,
   *                         round-tripped through `actions/cache` by the caller's
   *                         workflow. Pass `dag.directory()` (empty) on a cache miss
   *                         — see the module header on why this cannot be optional.
   */
  @func()
  npmCache(
    base: Container,
    npmCacheVolume: CacheVolume,
    nodeModulesCacheVolume: CacheVolume,
    nodeModulesPath: string,
    warmTools: Directory,
  ): Container {
    if (!nodeModulesPath.startsWith("/")) {
      throw new Error(`npmCache: 'nodeModulesPath' must be an absolute path, got "${nodeModulesPath}".`)
    }

    const mounted = base
      .withMountedCache("/root/.npm", npmCacheVolume)
      .withMountedCache(nodeModulesPath, nodeModulesCacheVolume)

    return mounted.withMountedDirectory("/warm-tools-in", warmTools).withExec(["sh", "-c", `set -u
echo "restoring the npm cache"
mkdir -p /root/.npm
[ -s /warm-tools-in/${NPM_TAR} ] && tar -xf /warm-tools-in/${NPM_TAR} -C /root/.npm --skip-old-files 2>/dev/null || true
echo "restoring the node_modules cache"
mkdir -p "${nodeModulesPath}"
[ -s /warm-tools-in/${NODE_MODULES_TAR} ] && tar -xf /warm-tools-in/${NODE_MODULES_TAR} -C "${nodeModulesPath}" --skip-old-files 2>/dev/null || true
du -sh /root/.npm "${nodeModulesPath}" 2>/dev/null || true`])
  }

  /**
   * The npm + `node_modules` caches `npmCache` mounted, as a `Directory` the
   * workflow can hand to `actions/cache/save`. Call AFTER the build/test call in
   * the SAME job, passing the IDENTICAL `CacheVolume` objects given to `npmCache`
   * — this picks up whatever that call's containers wrote into them.
   *
   * @param npmCacheVolume         the identical `CacheVolume` passed to `npmCache`
   *                               for this job.
   * @param nodeModulesCacheVolume the identical `CacheVolume` passed to `npmCache`
   *                               for this job.
   * @param cacheBust varies the call so the engine does not serve a stale result
   *                  from a previous invocation in the same run; the GitHub run id
   *                  is the usual value. Unused beyond that — present only to defeat
   *                  caching of this function's own result.
   */
  @func()
  async exportNpm(npmCacheVolume: CacheVolume, nodeModulesCacheVolume: CacheVolume, cacheBust: string): Promise<Directory> {
    const script = `set -eu
echo "bust: ${cacheBust}" > /dev/null
mkdir -p /warm-tools
tar -cf /warm-tools/${NPM_TAR} -C /root/.npm . 2>/dev/null || rm -f /warm-tools/${NPM_TAR}
tar -cf /warm-tools/${NODE_MODULES_TAR} -C /node-modules-src . 2>/dev/null || rm -f /warm-tools/${NODE_MODULES_TAR}
echo "===== npm + node_modules cache being carried to the next run ====="
du -sh /warm-tools/${NPM_TAR} /warm-tools/${NODE_MODULES_TAR} 2>/dev/null || true
`
    return dag
      .container()
      .from(EXPORT_IMG)
      .withMountedCache("/root/.npm", npmCacheVolume)
      .withMountedCache("/node-modules-src", nodeModulesCacheVolume)
      .withExec(["sh", "-c", script])
      .directory("/warm-tools")
  }
}
