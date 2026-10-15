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

Breaking: without any new argument, a JUnit testcase with a `scenarioId` property or an id
like `TS-E2E-012` in its title is now keyed by that id instead of its title. A
`coverage.tsv` row naming such a scenario by its title must be renamed to the id.
