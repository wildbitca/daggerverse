# guards changelog

Newest first. Format and rules: [Versioning](../README.md#versioning). Releases older than
the first entry: `git tag -l 'guards/v*'` and `git log --oneline -- guards/`.

## v0.2.1 — 2026-10-25

Fix: `daggerFlags` without `daggerVersion` on a v1 module dropped the engine's build
metadata (`+a7a2e64e`) only after the `v`, so the nested CLI install asked dl.dagger.io for
a release that does not exist and every probe failed with HTTP 403. The suffix is stripped.

## v0.2.0 — 2026-10-25

Moved to the Dagger v1 module format: `dagger-module.toml` replaces `dagger.json`, and the
generated clients are committed. Function signatures and behaviour are unchanged.
`daggerFlags` with an empty `daggerVersion` now probes with the running engine's version
when the consumer module has no `dagger.json` (a v1 module records none).

Breaking: requires a Dagger engine 1.0.0-beta.21 or newer to load; consumers on v0.21 stay
on the previous tag.
