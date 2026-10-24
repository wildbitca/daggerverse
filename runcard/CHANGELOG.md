# runcard changelog

Newest first. Format and rules: [Versioning](../README.md#versioning). Releases older than
the first entry: `git tag -l 'runcard/v*'` and `git log --oneline -- runcard/`.

## v0.4.0 — 2026-10-24

New `refresh`: one event-driven pass that brings the run's card up to date and returns, so
a workflow no longer needs a job that polls for the whole run (`watch` holds a runner for
the run's duration). Jobs call it as they finish (`needs` + `if: always()`); it finds the
card by (eventType, runId, runAttempt), posts one only when none exists, renders the same
rows as `watch`, and closes the card through the same path (final status, test reports from
artifacts, feature map, trend, breakdown and statistics) once every job except `selfJob` is
done, or when `final` is set. Approval-parked jobs render "awaiting approval" without a
close. Concurrent refreshes are last-writer-wins; two first refreshes can rarely both post a
card. Failed jobs are threaded once, at close. Also new: `refreshPlan`, the pure decision,
tested by `test/run-refresh-fixtures.sh` (wired into CI). `watch` is unchanged; its closing
path moved into a shared private helper.

Breaking: none

## v0.3.0 — 2026-09-17

`watch`, `report` and `runReports` take `--test-reports-file`, the file form of
`--test-reports`, for reports past the ~128 kB argv limit. Bundles slack and testing as of
the same commit: `slack.render`/`breakdown`/`breakdownText` take `reportFile`, the thread
gains a section listing scenario ids taken from a test title only, and testing is
v0.3.0 (see its changelog).

Breaking: none
