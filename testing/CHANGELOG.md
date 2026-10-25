# testing changelog

Newest first. Format and rules: [Versioning](../README.md#versioning). Releases older than
the first entry: `git tag -l 'testing/v*'` and `git log --oneline -- testing/`.

## v0.4.0 — 2026-10-25

Moved to the Dagger v1 module format: `dagger-module.toml` replaces `dagger.json`, and the
generated clients are committed. Function signatures and behaviour are unchanged.

Breaking: requires a Dagger engine 1.0.0-beta.21 or newer to load; consumers on v0.21 stay
on the previous tag.

## v0.3.0 — 2026-09-17

Every function that takes report JSON has a `*File` twin (`mergeFile`, `featuresFile`,
`toMetricsFile`, `withPerfFile`, `summaryMarkdownFile`), for reports past the ~128 kB argv
limit. `junitReport`/`junitReportFile` resolve stable scenario ids (a `scenarioId`
property, a one-test file's basename, then an id like `TS-E2E-012` in the title; new
optional `idProperty`/`idPattern`), record the rule used in `scenario.idSource` and list
title-only ids in `unanchoredScenarios`.

Breaking: without any new argument, a JUnit testcase is now keyed differently than before
in three cases: it has a `scenarioId` property; its title matches the default id pattern
(e.g. `TS-E2E-012`); or it is the only testcase in its `file` (previously this applied only
when `runner == "maestro"` — now it applies to any runner, so a non-Maestro single-test
file is also affected). A `coverage.tsv` row naming such a scenario by its old id (usually
the title) must be renamed to the new one. New optional output fields (`idSource`,
`unanchoredScenarios`) and the new `summaryMarkdown` rendering (an "Id from" column, an
unanchored-ids warning) are additive and not breaking on their own.
