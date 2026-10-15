# testing changelog

Newest first. Format and rules: [Versioning](../README.md#versioning). Releases older than
the first entry: `git tag -l 'testing/v*'` and `git log --oneline -- testing/`.

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
