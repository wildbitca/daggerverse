# runcard changelog

Newest first. Format and rules: [Versioning](../README.md#versioning). Releases older than
the first entry: `git tag -l 'runcard/v*'` and `git log --oneline -- runcard/`.

## v0.3.0 — 2026-09-17

`watch`, `report` and `runReports` take `--test-reports-file`, the file form of
`--test-reports`, for reports past the ~128 kB argv limit. Bundles slack and testing as of
the same commit: `slack.render`/`breakdown`/`breakdownText` take `reportFile`, the thread
gains a section listing scenario ids taken from a test title only, and testing is
v0.3.0 (see its changelog).

Breaking: none
