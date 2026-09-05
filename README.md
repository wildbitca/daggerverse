# daggerverse

Shared Dagger modules for `wildbitca`. CI/CD logic written once and consumed by every
pipeline in the organisation.

## Why

Until this repository existed, the same code lived vendored byte-for-byte in several
modules. The Slack progress engine alone was 363 lines copied into `pacha`, `pacha-api`
and `pacha-site`, and the only thing keeping the three copies equal was an md5 recorded in
a `.engine-parity` file. On 2026-09-04 that guard found a real divergence which had been
there for months.

The same was true of the guard scripts: `check-shared-pins.sh` (257 lines) and
`check-engine-parity.sh` (132) were byte-identical in three repos by convention alone.

## Modules

| Module | What it owns | Status |
|---|---|---|
| `slack/` | Progress card, thread detail, breakdown, trend (Slack is the trend store) | **published** |
| `identity/` | OIDC→STS for GCP, GitHub App JWT, Secret Manager reads | planned |
| `guards/` | Toolchain pins, shared pins across repos, Dagger flag probe, embedded-bash syntax | planned |
| `scan/` | gitleaks and Trivy, with the exact invocations ADR-0003 §2.2 pins | planned |
| `github/` | check-runs queries, releases, reruns, step summaries, annotations | planned |
| `testing/` | Native test-report parsers (`flutter test --machine`, `vitest --reporter=json`) | planned |

## Consuming a module

```sh
dagger install github.com/wildbitca/daggerverse/slack@slack/v0.1.0
```

The repository is **private**, so resolving the dependency needs git credentials on the
runner. Pipelines pay for this with the `wildbit-ci-cd` App token they already mint:

```sh
git config --global url."https://x-access-token:${TOKEN}@github.com/".insteadOf "https://github.com/"
```

## Versioning

Per-module semver tags, `<module>/vX.Y.Z` — the Go submodule convention, which is what
Dagger's resolver follows for modules in a subdirectory. Consumers pin a **tag, never
`@main`**: a bug in a shared module must not be able to turn four pipelines red at once
without anyone having chosen it. `dagger.json` records both the version and the resolved
commit.

## Conventions

- **Complex arguments travel as JSON strings.** Structural types cross a Dagger module
  boundary poorly and a shape mismatch fails at call time with an unreadable error. Every
  non-scalar is a JSON string, documented on the function, parsed and validated on entry.
- **Never a public parameter with a digit followed by a letter.** `e2eThing` comes back
  from Dagger's kebab↔camel round-trip as `e2EThing` and makes the **entire function**
  uninvokable — measured with a probe module, invisible to `tsc`, and it cost a red run.
  `--help` cannot be used to check this: it prints a presentation name that is not the
  only accepted spelling.
- **Fail closed with an error that names the parameter.** A silent default on a malformed
  argument renders an empty card and reports nothing wrong, which is the failure these
  modules exist to prevent.
- **Notification is best-effort; gates are not.** A Slack outage logs and returns. A
  guard that cannot read what it is checking fails the build.

The full contract, including what deliberately does NOT live here, is in
[`org-gitops/docs/daggerverse-ci-contract.md`](https://github.com/wildbitca/org-gitops/blob/main/docs/daggerverse-ci-contract.md).
