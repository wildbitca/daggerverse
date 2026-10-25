# scan changelog

Newest first. Format and rules: [Versioning](../README.md#versioning). Releases older than
the first entry: `git tag -l 'scan/v*'` and `git log --oneline -- scan/`.

## v0.2.0 — 2026-10-25

Moved to the Dagger v1 module format: `dagger-module.toml` replaces `dagger.json`, and the
generated clients are committed. Function signatures and behaviour are unchanged.

Breaking: requires a Dagger engine 1.0.0-beta.21 or newer to load; consumers on v0.21 stay
on the previous tag.
