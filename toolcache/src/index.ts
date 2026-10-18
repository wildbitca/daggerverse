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
 * Two Dagger `cacheVolume`s per caller (`<cacheKey>-npm`, `<cacheKey>-node-modules`),
 * shared by name within ONE Dagger engine — which is exactly the lifetime of a
 * single GitHub Actions job. `npmCache` mounts both onto a container the caller has
 * already prepared (source mounted, workdir set) and seeds them from a previous
 * run's `exportNpm` output when the caller has one. `exportNpm` reads the SAME two
 * volumes back out as a `Directory` the workflow can hand to `actions/cache/save`.
 * Both calls must happen within the SAME job: a `cacheVolume` is engine-internal
 * state, and a Dagger engine does not survive past the job that started it — it is
 * not a cross-job handoff channel (see this repository's README, "A cache volume is
 * NOT a handoff channel", measured on `elinvo-site`).
 *
 * `cacheKey` is NOT optional and is not defaulted to anything derived from the
 * caller: every repository adopting this module must pick its own, matching the
 * existing convention (`pacha-app-*`, `pacha-api-*`, `pacha-site-*`) — a shared
 * default would let two callers collide on the same cacheVolume names the moment
 * either forgot to override it.
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
import { dag, Container, Directory, object, func } from "@dagger.io/dagger"

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
   * @param base            container with the repository mounted and workdir set.
   * @param cacheKey        namespaces the two cacheVolumes (`<cacheKey>-npm`,
   *                        `<cacheKey>-node-modules`). Pick one unique to the calling
   *                        repository (the existing convention is the repo name,
   *                        e.g. "pacha-site") and pass the IDENTICAL value to
   *                        `exportNpm`. Two callers that share a value share a cache,
   *                        which is never what a second caller actually wants.
   * @param nodeModulesPath absolute path where `node_modules` lives under `base`'s
   *                        workdir, e.g. "/src/node_modules".
   * @param warmTools       the `Directory` a previous run's `exportNpm` returned,
   *                        round-tripped through `actions/cache` by the caller's
   *                        workflow. Pass `dag.directory()` (empty) on a cache miss
   *                        — see the module header on why this cannot be optional.
   */
  @func()
  npmCache(base: Container, cacheKey: string, nodeModulesPath: string, warmTools: Directory): Container {
    if (!cacheKey) {
      throw new Error("npmCache: 'cacheKey' is empty. A shared default would let two callers collide on the same cacheVolume names; pick one unique to this repository.")
    }
    if (!nodeModulesPath.startsWith("/")) {
      throw new Error(`npmCache: 'nodeModulesPath' must be an absolute path, got "${nodeModulesPath}".`)
    }

    const mounted = base
      .withMountedCache("/root/.npm", dag.cacheVolume(`${cacheKey}-npm`))
      .withMountedCache(nodeModulesPath, dag.cacheVolume(`${cacheKey}-node-modules`))

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
   * the SAME job: the two `cacheVolume`s are shared by name within one Dagger
   * engine, so this picks up whatever that call's containers wrote into them.
   *
   * @param cacheKey  the IDENTICAL value passed to `npmCache` for this job.
   * @param cacheBust varies the call so the engine does not serve a stale result
   *                  from a previous invocation in the same run; the GitHub run id
   *                  is the usual value. Unused beyond that — present only to defeat
   *                  caching of this function's own result.
   */
  @func()
  async exportNpm(cacheKey: string, cacheBust: string): Promise<Directory> {
    if (!cacheKey) {
      throw new Error("exportNpm: 'cacheKey' is empty. It must be the identical value passed to 'npmCache' for this job, or this reads back empty cacheVolumes under a different name.")
    }
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
      .withMountedCache("/root/.npm", dag.cacheVolume(`${cacheKey}-npm`))
      .withMountedCache("/node-modules-src", dag.cacheVolume(`${cacheKey}-node-modules`))
      .withExec(["sh", "-c", script])
      .directory("/warm-tools")
  }
}
