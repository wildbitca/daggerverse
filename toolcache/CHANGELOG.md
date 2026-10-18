# toolcache changelog

Newest first. Format and rules: [Versioning](../README.md#versioning).

## v0.1.2 — 2026-10-18
Both embedded scripts used `set -o pipefail`, a bash-only option. On a Debian
base (`node:*-bookworm*`, used by 4 of the 5 repos that adopted this module in
its first round), `/bin/sh` is `dash`, which rejects it outright: `sh: set:
Illegal option -o pipefail`. Alpine's busybox `ash` (this module's own
`EXPORT_IMG`, and the one base image used in initial testing) silently
tolerates it, which is why this was not caught before v0.1.1 shipped. Neither
script actually pipes anything, so `pipefail` was never doing anything;
dropped to plain `set -u` / `set -eu`.

Breaking: none.

## v0.1.1 — 2026-10-18
`npmCache`'s `warmTools` is now REQUIRED, not optional. Measured: an optional
`Directory` parameter on a function in a dependency module crashes the generated
TypeScript client ("Cannot read properties of undefined (reading 'replace')") the
moment a caller actually supplies a value — which every real caller does, since a
GHA workflow always runs `mkdir -p` before `--warm-tools=$DIR`. Pass
`dag.directory()` (empty) on a cache miss instead of omitting the argument.

Breaking: yes. Every caller of `npmCache` must update the call site to pass a
`Directory` unconditionally (e.g. `warmTools ?? dag.directory()`), not an optional
one. `exportNpm` is unaffected (no `Directory` input parameter).

## v0.1.0 — 2026-10-18
Initial release: `npmCache` and `exportNpm`, extracting the npm-download-cache +
`node_modules` round-trip `pacha`/`pacha-api`/`pacha-site` already hand-roll
identically, for other Node/TypeScript pipelines to adopt instead of running with
Dagger's own GHA cache exporter (which stored nothing measurable anywhere it was
checked) or no cache at all.

Breaking: none (first release).
