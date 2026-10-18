# toolcache changelog

Newest first. Format and rules: [Versioning](../README.md#versioning).

## v0.1.0 — 2026-10-18
Initial release: `npmCache` and `exportNpm`, extracting the npm-download-cache +
`node_modules` round-trip `pacha`/`pacha-api`/`pacha-site` already hand-roll
identically, for other Node/TypeScript pipelines to adopt instead of running with
Dagger's own GHA cache exporter (which stored nothing measurable anywhere it was
checked) or no cache at all.

Breaking: none (first release).
