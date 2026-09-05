/**
 * Identity — a pipeline mints its own credentials, so GitHub Actions stops being
 * the identity provider.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 * Across the four repos, identity is 18 native GitHub Actions steps:
 * `google-github-actions/auth` ×9, `actions/create-github-app-token` ×8 and
 * `google-github-actions/get-secretmanager-secrets` ×1, plus ~40 lines of bash
 * adapting the credential file into something a container can consume. None of
 * those 18 steps is one of the four legitimate reasons for a YAML step
 * (approval, runner topology, trigger surface, the runner's own API — see
 * `org-gitops/docs/daggerverse-ci-contract.md` §1): they are all HTTP calls that
 * happen to run outside the container that needs the result.
 *
 * ── WHY IT REMOVES THE `credential_source.file` PROBLEM ─────────────────────
 * `google-github-actions/auth` does not hand back a token by default. It writes
 * an `external_account` credential JSON and exports its path, and that JSON comes
 * in two shapes:
 *
 *   · the `url` form   — the endpoint and its bearer are INSIDE the JSON, so
 *                        passing the JSON by value is enough;
 *   · the `file` form  — it points at a path on the RUNNER, which a container
 *                        does not have, so the JSON by value is a credential
 *                        that resolves to nothing.
 *
 * `pacha/app` pays for that ambiguity with a "Adapt GCP credentials for the
 * Dagger container" step whose only job is to `jq` the credential, refuse the
 * `file` form outright, and copy the file somewhere the container can mount
 * (see `withSopsAuth` in `app/.github/dagger/src/index.ts`, which then has to
 * choose between `GOOGLE_CREDENTIALS` and `GOOGLE_APPLICATION_CREDENTIALS`
 * because `buildAndroid` already owns the latter for Firebase).
 *
 * Going straight to an OAuth access token deletes the whole problem: there is no
 * credential file, no `credential_source`, no shape to detect, and no auth
 * library needed inside the container — the token is one HTTP header.
 *
 * ── THE THREE LEGS, AND WHY THEY ARE NAMED IN EVERY ERROR ───────────────────
 * `gcpAccessToken` is three chained HTTP calls:
 *
 *   1. OIDC  — GET the runner's token endpoint for a JWT with the right audience
 *   2. STS   — POST `sts.googleapis.com/v1/token` to exchange that JWT for a
 *              federated token (this is where Workload Identity Federation
 *              actually decides whether to trust the repo)
 *   3. IAM   — POST `iamcredentials.googleapis.com` `generateAccessToken` to
 *              impersonate the service account
 *
 * All three can fail with "permission denied", and they fail for completely
 * different reasons: a missing `id-token: write`, an attribute condition that
 * does not match the repo, and a missing `roles/iam.workloadIdentityUser` on the
 * service account, in that order. An error that does not say WHICH leg failed is
 * why people give up and go back to the official action, so every error here
 * names its leg and what to check.
 *
 * ── SECRETS NEVER BECOME OUTPUT ─────────────────────────────────────────────
 * No token is ever written to stdout, to an error message, or to a file that gets
 * exported. Every network call runs inside a container that writes its result to
 * `/out/token`, and only that file crosses back — straight into `dag.setSecret`.
 * The three legs of `gcpAccessToken` run in ONE exec, so the intermediate OIDC
 * JWT and federated token never leave the container at all.
 *
 * The exec's own argv IS visible in Dagger's logs, so no secret is ever
 * interpolated into a script: they arrive as `withSecretVariable` /
 * `withMountedSecret` and are read at runtime. Where a token has to become a
 * request header, it goes through a `curl -K` config file rather than argv.
 *
 * When something must be shown for diagnosis, this module shows the token's
 * SHAPE (length, prefix class, which JSON keys came back) or the OIDC token's
 * `aud`/`sub` claims — never a value. `oidcClaims` exists precisely so that
 * debugging a Workload Identity attribute condition never needs the token
 * itself.
 *
 * ── COMPLEX ARGUMENTS TRAVEL AS JSON STRINGS ────────────────────────────────
 * Same convention as every module here: structural types cross a Dagger module
 * boundary poorly, so non-scalars are JSON strings, documented on the function,
 * parsed and validated on entry. Lists that are genuinely flat (scopes,
 * repositories, secret names) travel as comma-separated strings instead, because
 * that is what the YAML they replace already used.
 *
 * ── WHY THE SECRET MANAGER FUNCTIONS ARE `gcpSecret` AND NOT `secret` ───────
 * MEASURED, not styled. A `@func()` named `secret` shadows the CLI's resolution
 * of `Address.secret`, which is what `--flag=env:NAME` and `--flag=file:PATH`
 * go through. With it present, EVERY Secret-typed argument in the whole module
 * became uninvokable:
 *
 *     $ dagger call github-app-jwt --private-key=file:/tmp/key.pem …
 *     ✘ address(value: "file:/tmp/key.pem"): Address!
 *     ✘  .secret: Secret!  ERROR
 *     Error: missing required argument: "accessToken"
 *
 * — the CLI resolved `.secret` to `Identity.secret(accessToken, …)` and asked for
 * ITS arguments. `tsc` is happy, `dagger functions` lists everything, and the
 * failure names a parameter that belongs to a function the caller never
 * mentioned. Same family as the org-wide "no public parameter with a digit
 * followed by a letter" rule (contract §4.6): a name that compiles, lists, and
 * cannot be called. Do not name a function after a core Dagger type's field.
 *
 * ── CACHE ───────────────────────────────────────────────────────────────────
 * Every function that talks to the network takes a REQUIRED `cacheBust`. Without
 * it Dagger serves the previous exec and hands back a token that was never
 * requested — which, for a credential with an expiry, means a run authenticating
 * with something that expired during a previous run. Use the run id.
 */
import { dag, Secret, Container, object, func } from "@dagger.io/dagger"

/** curl + jq + openssl. Same Alpine pin the other modules in this repo use. */
const IMG = "alpine:3.24"

/** The default scope for an impersonated token: everything the SA itself can do. */
const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform"

/**
 * A Workload Identity provider resource name.
 * `projects/<number>/locations/<loc>/workloadIdentityPools/<pool>/providers/<prov>`
 *
 * Validated here rather than left to STS: a typo comes back from Google as a
 * flat `INVALID_ARGUMENT`, and the audience is not echoed in the response, so
 * there is nothing in the failure that points at the string that was wrong.
 */
const WIF_RE =
  /^projects\/[0-9]+\/locations\/[A-Za-z0-9-]+\/workloadIdentityPools\/[A-Za-z0-9_-]+\/providers\/[A-Za-z0-9_-]+$/

/** `name@project.iam.gserviceaccount.com` — the only form `generateAccessToken` accepts. */
const SA_RE = /^[a-z0-9-]{1,64}@[a-z0-9-]{1,63}\.iam\.gserviceaccount\.com$/

/** A Secret Manager secret id. Google's own rule: letters, digits, `_` and `-`. */
const SECRET_NAME_RE = /^[A-Za-z0-9_-]{1,255}$/

/** A GCP project id, or the `projects/<number>` numeric form spelled bare. */
const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$|^[0-9]{1,20}$/

/** A GitHub owner (org or user) and a repository name. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/

/**
 * A short, stable, NON-reversible discriminator for a `dag.setSecret` name.
 *
 * `setSecret` keys by name inside a session, so two different tokens minted under
 * the same name would collide and the second caller would silently get the
 * first's credential. The name is derived from the REQUEST (provider, service
 * account, cacheBust) and never from the value, so nothing about the secret is
 * recoverable from a name that appears in logs.
 */
function tag(...parts: string[]): string {
  let h = 0x811c9dc5
  const s = parts.join("\u0000")
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/**
 * Split a comma-separated argument, naming the parameter in the error.
 *
 * An empty entry is an error and not a skipped element: `--repositories=a,,b`
 * silently becoming two repositories is the kind of quiet difference that makes
 * a scoped token look right in review and be wrong in production.
 */
function list(raw: string, what: string): string[] {
  const parts = (raw ?? "").split(",").map((p) => p.trim())
  if (parts.some((p) => p === "")) {
    throw new Error(
      `identity: '${what}' has an empty entry ("${raw}"). It is a comma-separated list; an empty element is a typo, not an omission.`,
    )
  }
  return parts
}

/**
 * Parse a JSON argument, naming the parameter in the error.
 *
 * An empty string is the documented "absent" value and is the only thing that
 * yields `undefined`. A malformed payload throws: a silent `{}` on a
 * `permissions` argument would mint a token with the installation's FULL
 * permissions while the caller believed it had narrowed them.
 */
function parse<T>(raw: string, what: string): T | undefined {
  const t = (raw ?? "").trim()
  if (!t) return undefined
  try {
    return JSON.parse(t) as T
  } catch (e) {
    throw new Error(
      `identity: '${what}' is not valid JSON (${(e as Error).message}). It travels as a JSON string; the caller does JSON.stringify.`,
    )
  }
}

/**
 * The shape of a token, for a diagnostic that must not be the token.
 *
 * Length plus the issuer-assigned prefix is enough to tell "GitHub gave me an
 * installation token" from "GitHub gave me a JWT" from "I am holding an empty
 * string", which is every question a caller actually has at this point.
 */
function shape(v: string): string {
  const n = v.length
  if (n === 0) return "empty"
  const dots = v.split(".").length - 1
  if (dots === 2) return `JWT-shaped, ${n} chars, 3 dot-separated segments`
  const known = ["ghs_", "ghu_", "gho_", "ya29."]
  const p = known.find((k) => v.startsWith(k))
  return `${n} chars${p ? `, prefix '${p}'` : ", no recognised prefix"}, ${dots} dots`
}

/**
 * `Buffer` exists at runtime — the TypeScript SDK's runtime is Node — but nothing
 * in this module's tsconfig declares it. There is no `lib` setting, so `target:
 * ES2022` supplies no DOM either, which rules out `atob` for the same reason.
 *
 * Declared here rather than pulling in `@types/node`, so this module stays
 * dependency-free like the other five, and so the assumption is written down at
 * the one place that makes it: `identity` is the ONLY module in this repository
 * that touches a Node global.
 *
 * Found by this repo's own CI (run 33987124905), not locally. It typechecked on
 * every developer machine because `@types/node` was lying around from some other
 * install — a local pass resting on exactly what a fresh checkout lacks, which is
 * the third time in one day that shape has bitten this project.
 */
declare const Buffer: {
  from(input: string, encoding: string): { toString(encoding: string): string }
}

/** base64url → utf-8, tolerant of missing padding (JWT segments never carry it). */
function b64urlDecode(seg: string): string {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/")
  return Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf8")
}

@object()
export class Identity {
  // ── 1. GCP ────────────────────────────────────────────────────────────────

  /**
   * GitHub OIDC → GCP STS → an impersonated service-account access token.
   *
   * Replaces `google-github-actions/auth` with `token_format: access_token`, and
   * removes the credential-file adaptation that `token_format` omitted forces
   * (see the module header). Returns a `Secret` holding the raw OAuth token: pass
   * it to `withSecretVariable("GCP_TOKEN", …)` and it becomes one
   * `Authorization: Bearer` header. No auth library is needed in the container.
   *
   * The three legs run in a SINGLE exec, so the OIDC JWT and the federated token
   * never cross back into the module — only the final access token does.
   *
   * ── WHAT THE CALLER MUST HAVE ─────────────────────────────────────────────
   * The job needs `permissions: id-token: write`. GitHub then exports
   * `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` into
   * THAT job only, which is why they are arguments and not something this module
   * can discover:
   *
   *   dagger call gcp-access-token \
   *     --request-url=env:ACTIONS_ID_TOKEN_REQUEST_URL \
   *     --request-token=env:ACTIONS_ID_TOKEN_REQUEST_TOKEN \
   *     --workload-identity-provider=projects/945676640602/locations/global/workloadIdentityPools/ghactions/providers/ghactions \
   *     --service-account=sops-decrypt@wildbit-pacha-dev.iam.gserviceaccount.com \
   *     --cache-bust="$GITHUB_RUN_ID"
   *
   * @param requestUrl               `ACTIONS_ID_TOKEN_REQUEST_URL`, as a Secret. Not
   *                                 secret in the cryptographic sense, but it is paired
   *                                 with the request token and there is no reason for it
   *                                 to be the one value that lands in a log.
   * @param requestToken             `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, as a Secret. This
   *                                 one genuinely is a bearer credential.
   * @param workloadIdentityProvider `projects/<number>/locations/<loc>/workloadIdentityPools/<pool>/providers/<provider>`
   * @param serviceAccount           the service account to impersonate, `…@….iam.gserviceaccount.com`
   * @param cacheBust                MUST vary per run — use `$GITHUB_RUN_ID`. Without it
   *                                 Dagger replays a previous exec and returns a token
   *                                 minted for a run that already finished.
   * @param scopes                   comma-separated OAuth scopes for the FINAL token.
   *                                 Default `cloud-platform`, which is what the SA can do
   *                                 and nothing more — narrowing here does not add a
   *                                 permission, it only removes one.
   * @param lifetime                 `<seconds>s`, max `3600s` unless the org policy
   *                                 `constraints/iam.allowServiceAccountCredentialLifetimeExtension`
   *                                 allows more. Default `3600s`.
   * @param audience                 override the OIDC audience. Empty derives
   *                                 `https://iam.googleapis.com/<provider>`, which is the
   *                                 default `google-github-actions/auth` uses and what the
   *                                 provider accepts unless `allowedAudiences` was set.
   */
  @func()
  async gcpAccessToken(
    requestUrl: Secret,
    requestToken: Secret,
    workloadIdentityProvider: string,
    serviceAccount: string,
    cacheBust: string,
    scopes = "",
    lifetime = "3600s",
    audience = "",
  ): Promise<Secret> {
    const provider = (workloadIdentityProvider ?? "").trim()
    if (!provider) {
      throw new Error(
        "identity: 'workloadIdentityProvider' is empty. It is the full resource name, e.g. projects/945676640602/locations/global/workloadIdentityPools/ghactions/providers/ghactions",
      )
    }
    if (!WIF_RE.test(provider)) {
      throw new Error(
        `identity: 'workloadIdentityProvider' is not a provider resource name: '${provider}'. Expected projects/<number>/locations/<location>/workloadIdentityPools/<pool>/providers/<provider>. A pool path without /providers/<name> is the usual mistake, and STS answers it with a bare INVALID_ARGUMENT that does not echo the audience.`,
      )
    }
    const sa = (serviceAccount ?? "").trim()
    if (!sa) {
      throw new Error(
        "identity: 'serviceAccount' is empty. Impersonation has no default and MUST NOT have one: falling back to the federated identity would hand the caller whatever the pool grants directly.",
      )
    }
    if (!SA_RE.test(sa)) {
      throw new Error(
        `identity: 'serviceAccount' is not a service-account email: '${sa}'. Expected <name>@<project>.iam.gserviceaccount.com`,
      )
    }
    const bust = (cacheBust ?? "").trim()
    if (!bust) {
      throw new Error(
        "identity: 'cacheBust' is empty. It MUST vary per run (use $GITHUB_RUN_ID): without it Dagger replays the previous exec and returns a token minted for a run that has already finished.",
      )
    }
    const scopeList = scopes.trim() ? list(scopes, "scopes") : [CLOUD_PLATFORM]
    for (const s of scopeList) {
      if (/\s/.test(s)) throw new Error(`identity: scope '${s}' contains whitespace; scopes are comma-separated, not space-separated.`)
    }
    const life = (lifetime ?? "").trim() || "3600s"
    const m = /^([0-9]{1,6})s$/.exec(life)
    if (!m) {
      throw new Error(`identity: 'lifetime' must be '<seconds>s', got '${life}'.`)
    }
    if (Number(m[1]) < 1 || Number(m[1]) > 43200) {
      throw new Error(
        `identity: 'lifetime' ${life} is outside 1s..43200s. Anything over 3600s also needs the org policy constraints/iam.allowServiceAccountCredentialLifetimeExtension, or IAM answers with a flat INVALID_ARGUMENT.`,
      )
    }
    const aud = audience.trim() || `https://iam.googleapis.com/${provider}`
    const stsAudience = `//iam.googleapis.com/${provider}`

    // ── The three legs, in one exec ────────────────────────────────────────
    //
    // Each leg writes `fail:<leg>` into /out/status and a body into /out/diag,
    // then stops. The exec ALWAYS exits 0 — a non-zero exit would make the files
    // unreadable and leave the caller with Dagger's own "process exited 1", which
    // is the exact opaque failure this module exists to replace.
    const script = `
set -eu
umask 077
mkdir -p /out /w
: > /out/diag
printf 'fail:setup' > /out/status

hdr() { printf 'header = "Authorization: Bearer %s"\\n' "$1" > /w/curlrc; }

# ── Leg 1: OIDC ─────────────────────────────────────────────────────────────
hdr "$REQ_TOKEN"
code=$(curl -sS --get -K /w/curlrc \\
  --data-urlencode "audience=$AUDIENCE" \\
  -o /w/oidc.json -w '%{http_code}' --url "$REQ_URL" 2>/w/curl.err) || code=000
if [ "$code" != "200" ]; then
  printf 'fail:oidc' > /out/status
  { printf 'HTTP %s from the runner OIDC endpoint\\n' "$code"; head -c 800 /w/curl.err; head -c 800 /w/oidc.json; } > /out/diag 2>/dev/null || true
  exit 0
fi
jq -er '.value' < /w/oidc.json > /w/oidc.raw 2>/dev/null || {
  printf 'fail:oidc' > /out/status
  jq -r 'keys | join(",")' < /w/oidc.json > /out/diag 2>/dev/null || printf 'response was not JSON' > /out/diag
  exit 0
}
# tr -d removes jq -r's trailing newline; the JWT must be byte-exact.
tr -d '\\n' < /w/oidc.raw > /w/oidc
rm -f /w/oidc.raw

# ── Leg 2: STS token exchange ───────────────────────────────────────────────
jq -n --arg aud "$STS_AUDIENCE" --rawfile subj /w/oidc '{
  audience: $aud,
  grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
  requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
  scope: "${CLOUD_PLATFORM}",
  subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
  subjectToken: $subj
}' > /w/sts.json
code=$(curl -sS -X POST https://sts.googleapis.com/v1/token \\
  -H 'Content-Type: application/json' --data @/w/sts.json \\
  -o /w/sts.out -w '%{http_code}' 2>/w/curl.err) || code=000
rm -f /w/sts.json
if [ "$code" != "200" ]; then
  printf 'fail:sts' > /out/status
  { printf 'HTTP %s from sts.googleapis.com\\n' "$code"; head -c 1200 /w/sts.out; head -c 400 /w/curl.err; } > /out/diag 2>/dev/null || true
  exit 0
fi
jq -er '.access_token' < /w/sts.out > /w/fed.raw 2>/dev/null || {
  printf 'fail:sts' > /out/status
  jq -r 'keys | join(",")' < /w/sts.out > /out/diag 2>/dev/null || printf 'response was not JSON' > /out/diag
  exit 0
}
tr -d '\\n' < /w/fed.raw > /w/fed
rm -f /w/fed.raw /w/sts.out

# ── Leg 3: service-account impersonation ────────────────────────────────────
hdr "$(cat /w/fed)"
jq -n --argjson scope "$SCOPE_JSON" --arg lifetime "$LIFETIME" \\
  '{scope: $scope, lifetime: $lifetime}' > /w/imp.json
code=$(curl -sS -X POST -K /w/curlrc \\
  -H 'Content-Type: application/json' --data @/w/imp.json \\
  -o /w/imp.out -w '%{http_code}' \\
  "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/$SA:generateAccessToken" 2>/w/curl.err) || code=000
rm -f /w/curlrc /w/fed
if [ "$code" != "200" ]; then
  printf 'fail:impersonate' > /out/status
  { printf 'HTTP %s from iamcredentials.googleapis.com\\n' "$code"; head -c 1200 /w/imp.out; head -c 400 /w/curl.err; } > /out/diag 2>/dev/null || true
  exit 0
fi
jq -er '.accessToken' < /w/imp.out > /w/tok.raw 2>/dev/null || {
  printf 'fail:impersonate' > /out/status
  jq -r 'keys | join(",")' < /w/imp.out > /out/diag 2>/dev/null || printf 'response was not JSON' > /out/diag
  exit 0
}
tr -d '\\n' < /w/tok.raw > /out/token
jq -r '.expireTime // "unknown"' < /w/imp.out > /out/diag
rm -rf /w
printf 'ok' > /out/status
`
    const ctr = this.base()
      .withSecretVariable("REQ_URL", requestUrl)
      .withSecretVariable("REQ_TOKEN", requestToken)
      .withEnvVariable("AUDIENCE", aud)
      .withEnvVariable("STS_AUDIENCE", stsAudience)
      .withEnvVariable("SA", sa)
      .withEnvVariable("SCOPE_JSON", JSON.stringify(scopeList))
      .withEnvVariable("LIFETIME", life)
      .withEnvVariable("CACHE_BUST", bust)
      .withExec(["sh", "-c", script])

    const status = (await ctr.file("/out/status").contents()).trim()
    const diag = (await ctr.file("/out/diag").contents()).trim()
    if (status !== "ok") this.throwLeg(status, diag, { provider, sa, aud })
    const token = await ctr.file("/out/token").contents()
    if (token.length < 16) {
      throw new Error(
        `identity: the impersonation leg reported success but the token for ${sa} is ${shape(token)}. An empty or truncated credential is a failure, never an anonymous call — a request carrying it would come back as "permission denied" and send the next person looking at IAM.`,
      )
    }
    // After the check, not before: a line saying a token was minted is a lie if
    // the next statement throws. A timestamp, not a credential — worth saying out
    // loud because "the token expired mid-run" is otherwise indistinguishable
    // from "the token was never valid".
    console.error(`identity: impersonated ${sa}, token expires ${diag}`)
    return dag.setSecret(`identity-gcp-${tag(provider, sa, bust, scopeList.join(","))}`, token)
  }

  /**
   * The claims of the runner's OIDC token — for debugging, never a credential.
   *
   * Returns JSON with `iss`, `aud`, `sub`, `exp`, `iat` and the GitHub-specific
   * claims a Workload Identity attribute condition is usually written against
   * (`repository`, `repository_owner`, `ref`, `workflow`, `environment`,
   * `job_workflow_ref`, `actor`). The token itself is NEVER returned and never
   * leaves the container.
   *
   * This exists because a WIF attribute condition that does not match fails at
   * the STS leg with a message that does not say which claim disagreed. With
   * this you can read the claim and compare it to the condition, without ever
   * printing a bearer token to a CI log where it lives for 90 days.
   *
   * @param audience  the audience to request. Empty asks for the runner's default,
   *                  which is the repository URL and is NOT what GCP expects — pass
   *                  `https://iam.googleapis.com/<provider>` to see the real thing.
   * @param cacheBust MUST vary per run — see `gcpAccessToken`.
   */
  @func()
  async oidcClaims(requestUrl: Secret, requestToken: Secret, cacheBust: string, audience = ""): Promise<string> {
    const bust = (cacheBust ?? "").trim()
    if (!bust) {
      throw new Error(
        "identity: 'cacheBust' is empty. It MUST vary per run (use $GITHUB_RUN_ID): without it Dagger replays the previous exec and you read the claims of an older run's token.",
      )
    }
    const aud = audience.trim()
    const script = `
set -eu
umask 077
mkdir -p /out /w
: > /out/diag
printf 'fail:oidc' > /out/status
printf 'header = "Authorization: Bearer %s"\\n' "$REQ_TOKEN" > /w/curlrc
if [ -n "$AUDIENCE" ]; then
  code=$(curl -sS --get -K /w/curlrc --data-urlencode "audience=$AUDIENCE" -o /w/oidc.json -w '%{http_code}' --url "$REQ_URL" 2>/w/curl.err) || code=000
else
  code=$(curl -sS --get -K /w/curlrc -o /w/oidc.json -w '%{http_code}' --url "$REQ_URL" 2>/w/curl.err) || code=000
fi
rm -f /w/curlrc
if [ "$code" != "200" ]; then
  { printf 'HTTP %s from the runner OIDC endpoint\\n' "$code"; head -c 800 /w/curl.err; head -c 800 /w/oidc.json; } > /out/diag 2>/dev/null || true
  exit 0
fi
# Only the PAYLOAD segment leaves this container. The signature stays behind, so
# what comes back describes the token and cannot be replayed as one.
jq -er '.value | split(".") | .[1]' < /w/oidc.json > /out/payload 2>/dev/null || {
  jq -r 'keys | join(",")' < /w/oidc.json > /out/diag 2>/dev/null || printf 'response was not JSON' > /out/diag
  exit 0
}
rm -rf /w
printf 'ok' > /out/status
`
    const ctr = this.base()
      .withSecretVariable("REQ_URL", requestUrl)
      .withSecretVariable("REQ_TOKEN", requestToken)
      .withEnvVariable("AUDIENCE", aud)
      .withEnvVariable("CACHE_BUST", bust)
      .withExec(["sh", "-c", script])

    const status = (await ctr.file("/out/status").contents()).trim()
    if (status !== "ok") this.throwLeg(status, (await ctr.file("/out/diag").contents()).trim(), { aud: aud || "(runner default)" })
    const payload = (await ctr.file("/out/payload").contents()).trim()
    let claims: Record<string, unknown>
    try {
      claims = JSON.parse(b64urlDecode(payload)) as Record<string, unknown>
    } catch (e) {
      throw new Error(`identity: the OIDC token's payload segment is not JSON (${(e as Error).message}). ${payload.length} base64url chars came back.`)
    }
    const keep = [
      "iss", "aud", "sub", "exp", "iat", "nbf", "jti",
      "repository", "repository_owner", "repository_id", "repository_visibility",
      "ref", "ref_type", "sha", "workflow", "workflow_ref", "job_workflow_ref",
      "environment", "actor", "actor_id", "event_name", "runner_environment",
    ]
    const out: Record<string, unknown> = {}
    for (const k of keep) if (k in claims) out[k] = claims[k]
    return JSON.stringify(out)
  }

  // ── 2. GitHub App ─────────────────────────────────────────────────────────

  /**
   * A GitHub App installation access token, scoped to named repositories.
   *
   * Replaces `actions/create-github-app-token@v1`. Three calls in one exec:
   * sign an RS256 JWT with the App private key, resolve the installation for
   * `owner`, then POST for an installation token narrowed to `repositories`.
   *
   * ── BOTH AXES ARE REQUIRED, AND NEITHER HAS A DEFAULT ────────────────────
   * An installation token is scoped on TWO independent axes, and leaving either
   * one out widens it:
   *
   *   · WHICH REPOSITORIES  — `repositories`, already passed by all eight call
   *     sites today. Omitted, the token covers every repository the App is
   *     installed on.
   *   · WHICH PERMISSIONS   — `permissions`. Omitted, the token carries the
   *     App's ENTIRE permission set on those repositories. GitHub's REST
   *     reference, verbatim: "If permissions is not specified, the installation
   *     access token will have all of the permissions that were granted to the
   *     app." Scoping to a SUBSET is the documented purpose of the parameter,
   *     bounded by "the installation access token cannot be granted permissions
   *     that the app was not granted".
   *
   * The second is the one that has no counterpart in the YAML being replaced.
   * ADR-0003 §4.5 (org-gitops, decided 2026-08-21) measured its consequence and
   * accepted it at that scope: `wildbit-ci-cd` holds `Deployments: Read and
   * write` so that it can BE the custom deployment protection rule that replaced
   * the Slack gate, and `actions/create-github-app-token` mints tokens with all
   * of the App's permissions unless narrowed with `permission-*`. Stated in the
   * ADR without hedging: any of the pipelines can call the review endpoint with
   * the token it already mints and release its own deployment — GitHub's "Apps
   * can only review their own custom deployment protection rules" does not stop
   * it, because the App IS the gate. The ADR counted 12 call sites in 8 repos:
   * one direct self-approval (`avasambench`, a monorepo) and three cross-
   * approvals inside pacha. Narrowing all of them was written down as outcome 1
   * and deferred as "hygiene, not protection", with the reason it was deferred
   * being that "a future omission silently reopens the hole".
   *
   * So `permissions` is REQUIRED here, with no default at all — not even a narrow
   * one. A default is precisely the future omission the ADR named: it would be a
   * choice nobody makes, appearing in no diff and no review. Required means every
   * call site states its own permission set, and `deployments` can only ever
   * appear because somebody typed it.
   *
   * Verified 2026-09-05 across the four repos: **eight of eight call sites pass
   * no `permission-*` today**, so all eight currently carry the full App set,
   * `Deployments: Read and write` included. What they actually need:
   *
   *   {"contents":"read"}   `check-shared-pins.sh` (app, services, web) and the
   *                         two sibling `actions/checkout` of pacha-api (app)
   *   {"contents":"write"}  the pacha-ops digest bump (services ×2, web ×1),
   *                         which is `git clone` + `git push origin HEAD:main`
   *                         — a direct push, so no `pull_requests`
   *
   * None of the eight needs `deployments`. Porting them therefore closes ADR-0003
   * outcome 1 as a side effect, at no extra cost, because these call sites are
   * being rewritten anyway. This module does not BAN `deployments` — an org-wide
   * module cannot know that no future caller is a legitimate gate — but asking
   * for it is now a visible word in a diff instead of silent inheritance, and it
   * is called out on stderr when requested.
   *
   * The JWT is `iat = now - 60`, `exp = now + 480` — a 540-second span. Backdated
   * because a runner clock a few seconds ahead of GitHub's makes an `iat` in the
   * future, and GitHub answers that with a 401 whose whole text is "'Issued at'
   * claim ('iat') is in the future". Not the obvious `exp = now + 540`, which
   * lands `exp - iat` on exactly 600 and therefore exactly on GitHub's limit:
   * whether a 600-second span is inside or outside "maximum 10 minutes" is a
   * boundary nobody should be discovering from a 401 in CI.
   *
   * @param appId        the App ID (`vars.WILDBIT_CI_APP_ID`). The App's client id
   *                     also works as `iss`; the numeric id is what the pipelines use.
   * @param privateKey   the App private key, PEM. Mounted as a file, never an env
   *                     var and never interpolated into the script.
   * @param owner        the organisation (or user) the App is installed on, e.g. `wildbitca`.
   * @param repositories comma-separated repository NAMES without the owner, e.g.
   *                     `pacha-api` or `pacha,pacha-site`. Required; `*` is rejected.
   * @param permissions  REQUIRED JSON object, e.g. `{"contents":"read"}`. Keys are
   *                     GitHub's permission names, values `read`, `write` or `admin`.
   *                     `{}` is rejected — it reads as "no opinion" and is the one
   *                     thing this argument exists to prevent. What GitHub does with
   *                     an OVER-request (a permission the App was never granted) is
   *                     not documented and is unverified here: do not rely on it
   *                     erroring, and do not rely on it being dropped. The direction
   *                     that matters is documented and is the other one — see above.
   * @param cacheBust    MUST vary per run — see `gcpAccessToken`.
   */
  @func()
  async githubAppToken(
    appId: string,
    privateKey: Secret,
    owner: string,
    repositories: string,
    permissions: string,
    cacheBust: string,
  ): Promise<Secret> {
    const id = (appId ?? "").trim()
    if (!id) {
      throw new Error("identity: 'appId' is empty. It is the App ID that goes in the JWT's 'iss' claim (vars.WILDBIT_CI_APP_ID).")
    }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      throw new Error(`identity: 'appId' contains characters an App ID never has: '${id}'.`)
    }
    const org = (owner ?? "").trim()
    if (!org) {
      throw new Error("identity: 'owner' is empty. It is the organisation or user the App is installed on, e.g. wildbitca.")
    }
    if (!OWNER_RE.test(org)) {
      throw new Error(`identity: 'owner' is not a GitHub login: '${org}'. Pass the owner alone, not owner/repo.`)
    }
    const raw = (repositories ?? "").trim()
    if (!raw) {
      throw new Error(
        "identity: 'repositories' is empty and has NO default. An unscoped installation token carries the App's permissions on every repository the App is installed on; the four pipelines this replaces all scope theirs, and a shared module must not be the thing that widens them.",
      )
    }
    if (raw === "*") {
      throw new Error(
        "identity: 'repositories' does not accept '*'. Name the repositories, e.g. --repositories=pacha-api or --repositories=pacha,pacha-site.",
      )
    }
    const repos = list(raw, "repositories")
    for (const r of repos) {
      if (r.includes("/")) {
        throw new Error(`identity: repository '${r}' includes an owner. Pass names only ('pacha-api'), the owner comes from --owner.`)
      }
      if (!REPO_RE.test(r)) {
        throw new Error(`identity: '${r}' is not a repository name.`)
      }
    }
    const bust = (cacheBust ?? "").trim()
    if (!bust) {
      throw new Error(
        "identity: 'cacheBust' is empty. It MUST vary per run (use $GITHUB_RUN_ID): without it Dagger replays the previous exec and hands back an installation token that has already expired — installation tokens live one hour.",
      )
    }
    if (!(permissions ?? "").trim()) {
      throw new Error(
        'identity: \'permissions\' is empty and has NO default. An installation token minted without one carries the App\'s ENTIRE permission set on the named repositories — for wildbit-ci-cd that includes `Deployments: Read and write`, which is what lets a pipeline release its own deployment (ADR-0003 §4.5). Pass what this call site actually needs, e.g. --permissions=\'{"contents":"read"}\' to read a sibling repo, or \'{"contents":"write"}\' to push a digest bump.',
      )
    }
    const perms = parse<Record<string, string>>(permissions, "permissions")
    if (perms === undefined || typeof perms !== "object" || Array.isArray(perms) || perms === null) {
      throw new Error(
        `identity: 'permissions' must be a JSON OBJECT like {"contents":"read"}, not ${Array.isArray(perms) ? "an array" : typeof perms}.`,
      )
    }
    const permKeys = Object.keys(perms)
    if (permKeys.length === 0) {
      throw new Error(
        'identity: \'permissions\' is {} — an empty object. GitHub does not read that as "no permissions"; it is an argument that states nothing, which is the same silent inheritance the required argument exists to prevent. Name the permissions this call site needs.',
      )
    }
    for (const k of permKeys) {
      if (!/^[a-z][a-z_]*$/.test(k)) {
        throw new Error(`identity: permission name '${k}' is not a GitHub permission key (lowercase and underscores, e.g. 'contents', 'pull_requests').`)
      }
      if (!["read", "write", "admin"].includes(perms[k])) {
        throw new Error(`identity: permission '${k}' is '${perms[k]}'; GitHub accepts only 'read', 'write' or 'admin'. Caught here because a bad value reaching GitHub does not come back naming the key.`)
      }
    }
    // Named on stderr, not blocked. An org-wide module cannot know that no future
    // caller is itself a legitimate deployment gate, but ADR-0003 §4.5 exists
    // because this permission is the one that lets a pipeline approve its own
    // release — so it does not get to pass unremarked.
    if ("deployments" in perms) {
      console.error(
        `identity: NOTE — this token requests deployments:${perms.deployments} on ${repositories}. That is the permission ADR-0003 §4.5 measured: an App that holds it can review its own custom deployment protection rule. None of the eight pacha call sites needs it.`,
      )
    }

    const ctr = this.appContainer(id, privateKey, bust, { owner: org, repositories: repos, permissions: perms })

    const status = (await ctr.file("/out/status").contents()).trim()
    const diag = (await ctr.file("/out/diag").contents()).trim()
    if (status !== "ok") this.throwLeg(status, diag, { appId: id, owner: org, repositories: repos.join(",") })
    if (diag.includes("scoping was not applied")) {
      throw new Error(
        `identity: GitHub returned an installation token for ${org} that is NOT scoped to ${repos.join(",")} — the response listed no repositories. Refusing to hand back a token wider than the one that was asked for.`,
      )
    }
    console.error(`identity: installation token for ${org} (${diag})`)
    const token = await ctr.file("/out/token").contents()
    if (token.length < 16) {
      throw new Error(
        `identity: the installation-token leg reported success but the token for ${org} is ${shape(token)}. An installation token is a 'ghs_' string of about forty characters; anything shorter is truncation, not a credential.`,
      )
    }
    return dag.setSecret(`identity-gh-${tag(id, org, repos.join(","), permissions, bust)}`, token)
  }

  /**
   * Sign the App JWT and stop — the first leg of `githubAppToken` on its own.
   *
   * Nothing is called over the network, so this works with any RSA key pair and
   * is how the signing path is tested without an App. Returns the JWT as a
   * `Secret`: it is a bearer credential for the App itself, not a debugging
   * string, and it is not returned in plaintext for the same reason
   * `gcpAccessToken` does not return one.
   *
   * To inspect it, export the secret and decode the first two segments — the
   * header and the payload are not the signature.
   */
  @func()
  async githubAppJwt(appId: string, privateKey: Secret, cacheBust: string): Promise<Secret> {
    const id = (appId ?? "").trim()
    if (!id) throw new Error("identity: 'appId' is empty. It is the App ID that goes in the JWT's 'iss' claim.")
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      throw new Error(`identity: 'appId' contains characters an App ID never has: '${id}'.`)
    }
    const bust = (cacheBust ?? "").trim()
    if (!bust) {
      throw new Error(
        "identity: 'cacheBust' is empty. It MUST vary per run (use $GITHUB_RUN_ID): an App JWT is valid for nine minutes and a replayed one is an expired one.",
      )
    }
    const ctr = this.appContainer(id, privateKey, bust, null)
    const status = (await ctr.file("/out/status").contents()).trim()
    const diag = (await ctr.file("/out/diag").contents()).trim()
    if (status !== "ok") this.throwLeg(status, diag, { appId: id })
    console.error(`identity: ${diag}`)
    const jwt = await ctr.file("/out/token").contents()
    if (jwt.split(".").length !== 3 || jwt.length < 16) {
      throw new Error(
        `identity: the signing leg reported success but produced ${shape(jwt)} for app ${id}. A signed App JWT is three dot-separated base64url segments.`,
      )
    }
    return dag.setSecret(`identity-gh-jwt-${tag(id, bust)}`, jwt)
  }

  // ── 3. Secret Manager ─────────────────────────────────────────────────────

  /**
   * One secret out of GCP Secret Manager, as a Dagger `Secret`.
   *
   * Replaces `google-github-actions/get-secretmanager-secrets`. The value never
   * becomes a step output, never reaches `GITHUB_OUTPUT` and never depends on
   * Actions' `add-mask` having been called in time.
   *
   * Takes the access token from `gcpAccessToken`, which must carry the
   * `cloud-platform` scope and whose service account needs
   * `roles/secretmanager.secretAccessor` on the secret — a project-level grant
   * where a per-secret one would do is a finding, not a shortcut.
   *
   * TEXT secrets only. The payload comes back base64 and is decoded byte-exact
   * inside the container, but it crosses back into the module as a UTF-8 string,
   * so a binary payload (a keystore, a .p12) would be mangled. Mount those as a
   * file from a bucket instead.
   *
   * @param project   project id or number that OWNS the secret — not necessarily the
   *                  project the service account lives in.
   * @param name      the secret id, e.g. `internal-api-secret`.
   * @param cacheBust MUST vary per run — see `gcpAccessToken`. A rotated secret read
   *                  from cache is a run authenticating with the previous value.
   * @param version   `latest` (default) or a numeric version. Pinning a version is
   *                  the only way a rotation cannot change what a run does.
   */
  @func()
  async gcpSecret(accessToken: Secret, project: string, name: string, cacheBust: string, version = "latest"): Promise<Secret> {
    const values = await this.readSecrets(accessToken, project, [{ name, version }], cacheBust)
    return values[0]
  }

  /**
   * Several secrets from GCP Secret Manager in one exec, in the ORDER requested.
   *
   * The returned list matches `names` element for element — that is the contract,
   * and it is why an empty entry in `names` throws instead of being skipped: a
   * list that silently loses an element shifts every secret after it by one, and
   * every one of them is still a perfectly valid `Secret`.
   *
   * @param names comma-separated, each `name` or `name/version`, mirroring the
   *              `key:project/secret/version` syntax of the action this replaces.
   *              e.g. `internal-api-secret,stream-key/4`
   */
  @func()
  async gcpSecrets(accessToken: Secret, project: string, names: string, cacheBust: string, version = "latest"): Promise<Secret[]> {
    const raw = (names ?? "").trim()
    if (!raw) {
      throw new Error("identity: 'names' is empty. It is a comma-separated list of secret ids, each optionally 'name/version'.")
    }
    const wanted = list(raw, "names").map((entry) => {
      const parts = entry.split("/")
      if (parts.length > 2) {
        throw new Error(`identity: '${entry}' is not 'name' or 'name/version'. The project comes from --project, so 'project/name' is not the form here.`)
      }
      return { name: parts[0], version: parts[1] ?? version }
    })
    return await this.readSecrets(accessToken, project, wanted, cacheBust)
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** curl + jq + openssl, on the Alpine pin this repo shares. Cached by Dagger. */
  private base(): Container {
    return dag
      .container()
      .from(IMG)
      .withExec(["apk", "add", "--no-cache", "curl", "jq", "openssl", "ca-certificates"])
  }

  /**
   * Turn a `fail:<leg>` status into an error that names the leg and what to check.
   *
   * The whole point of the module: three calls that all answer "permission
   * denied" for reasons that live in three different places, and an error that
   * does not say which one is why people go back to the official action.
   */
  private throwLeg(status: string, diag: string, ctx: Record<string, string>): never {
    const leg = status.startsWith("fail:") ? status.slice(5) : status
    const where: Record<string, string> = {
      oidc:
        "the OIDC leg — GitHub's own token endpoint. Check that the JOB declares `permissions: id-token: write` (it is per-job, not per-workflow, and a workflow-level block does not reach a job that redeclares `permissions`), and that ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN were read in that same job. A 403 here never reaches Google at all.",
      sts:
        "the STS leg — sts.googleapis.com decided whether to trust this repository. Check the provider's attribute condition against the token's real claims (`dagger call oidc-claims` prints them without printing the token), the provider's allowed audiences, and that the pool and provider ids in the resource name exist. Nothing has been impersonated yet at this point.",
      impersonate:
        "the impersonation leg — iamcredentials.googleapis.com. Federation SUCCEEDED; what failed is becoming the service account. Check `roles/iam.workloadIdentityUser` on THAT service account for the pool principal, that the IAM Service Account Credentials API is enabled on the project, and that the requested lifetime is allowed.",
      key: "reading the App private key. It is not a PEM.",
      keytype: "loading the App private key as RSA.",
      sign: "signing the App JWT. The key loaded but would not sign — usually an encrypted key, or an EC/Ed25519 key where GitHub requires RSA.",
      installation:
        "resolving the App installation. Check that the App is installed on this owner and that `appId` is the App's id and not the installation's — GitHub answers a wrong app id with a 401 on the JWT, and a right app id with no installation with a 404.",
      "installation-token":
        "minting the scoped installation token. A 422 here usually means a repository is named that this installation does not cover, or a permission was requested that the App does not have — though GitHub's handling of an over-requested permission is not documented, so read the response body rather than assuming which of the two it is.",
      unscoped:
        "building the installation-token request. The container refused to ask for a token with no permissions object — see ADR-0003 §4.5. This is a guard that should be unreachable; reaching it means the argument validation was bypassed.",
      secretmanager:
        "reading Secret Manager. A 401 is the ACCESS TOKEN, not the secret: it expired, or it was minted without the cloud-platform scope. A 403 is the secret: the impersonated service account needs roles/secretmanager.secretAccessor on it. A 404 means the secret, or that version, does not exist in THIS project — and the project that owns a secret is not always the project the service account lives in.",
      setup: "before the first request — the container itself.",
    }
    const hint = where[leg] ?? `an unrecognised leg ('${leg}')`
    const context = Object.entries(ctx)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n")
    // The provider's own message is often multi-line; every line of it is indented
    // so the response stays visibly one block and does not read as though the
    // error ended and something else started.
    const body = (diag || "(empty)").split("\n").join("\n            ")
    throw new Error(`identity: FAILED at ${hint}\n${context}\n  response: ${body}`)
  }

  /**
   * The container that runs `APP_SCRIPT` — the ONE place the App legs are built.
   *
   * `scoped: null` sets `JWT_ONLY` and stops after signing, which is what
   * `githubAppJwt` calls and what makes the signing path testable with a
   * throwaway key pair and no App installation anywhere. Two builders would mean
   * the tested signing code is not the one production runs, which is the same
   * mistake `.engine-parity` existed to catch.
   */
  private appContainer(
    appId: string,
    privateKey: Secret,
    cacheBust: string,
    scoped: { owner: string; repositories: string[]; permissions: Record<string, string> | null } | null,
  ): Container {
    let c = this.base()
      .withMountedSecret("/run/secrets/app-key.pem", privateKey)
      .withEnvVariable("APP_ID", appId)
      .withEnvVariable("API", "https://api.github.com")
      .withEnvVariable("OWNER", scoped?.owner ?? "")
      .withEnvVariable("REPOS_JSON", JSON.stringify(scoped?.repositories ?? []))
      .withEnvVariable("PERMS_JSON", JSON.stringify(scoped?.permissions ?? null))
      .withEnvVariable("CACHE_BUST", cacheBust)
    if (scoped === null) c = c.withEnvVariable("JWT_ONLY", "1")
    return c.withExec(["sh", "-c", APP_SCRIPT])
  }

  /**
   * The Secret Manager read. One exec for the whole batch: N secrets are N HTTP
   * calls, and doing them in N containers would pay for the image N times.
   */
  private async readSecrets(
    accessToken: Secret,
    project: string,
    wanted: { name: string; version: string }[],
    cacheBust: string,
  ): Promise<Secret[]> {
    const proj = (project ?? "").trim()
    if (!proj) {
      throw new Error("identity: 'project' is empty. It is the project that OWNS the secret, which is not necessarily the project the service account lives in.")
    }
    if (!PROJECT_RE.test(proj)) {
      throw new Error(`identity: 'project' is not a project id or number: '${proj}'.`)
    }
    const bust = (cacheBust ?? "").trim()
    if (!bust) {
      throw new Error(
        "identity: 'cacheBust' is empty. It MUST vary per run (use $GITHUB_RUN_ID): a rotated secret served from a cached exec is a run authenticating with the previous value, and nothing about that run looks wrong.",
      )
    }
    for (const w of wanted) {
      if (!SECRET_NAME_RE.test(w.name)) {
        throw new Error(`identity: '${w.name}' is not a Secret Manager secret id (letters, digits, '_' and '-').`)
      }
      if (!/^(latest|[0-9]{1,10})$/.test(w.version)) {
        throw new Error(`identity: version '${w.version}' for secret '${w.name}' must be 'latest' or a number.`)
      }
    }

    const script = `
set -eu
umask 077
mkdir -p /out /w
: > /out/diag
printf 'fail:setup' > /out/status
printf 'header = "Authorization: Bearer %s"\\n' "$GCP_TOKEN" > /w/curlrc
i=0
echo "$WANTED" | jq -c '.[]' | while read -r item; do
  n=$(printf '%s' "$item" | jq -r '.name')
  v=$(printf '%s' "$item" | jq -r '.version')
  code=$(curl -sS -K /w/curlrc -o "/w/r.$i" -w '%{http_code}' \\
    "https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/$n/versions/$v:access" 2>/w/curl.err) || code=000
  if [ "$code" != "200" ]; then
    printf 'fail:secretmanager' > /out/status
    { printf 'HTTP %s reading projects/%s/secrets/%s/versions/%s\\n' "$code" "$PROJECT" "$n" "$v"
      jq -r '.error.message // empty' < "/w/r.$i" 2>/dev/null || head -c 400 "/w/r.$i"; } > /out/diag 2>/dev/null || true
    exit 0
  fi
  # base64 -d, not jq -r: the payload is bytes and must come back byte-exact,
  # trailing newline included or excluded exactly as it was stored. A secret that
  # differs from the stored value by one character fails at the far end with an
  # error about the far end.
  if ! jq -er '.payload.data' < "/w/r.$i" | base64 -d > "/out/secret.$i" 2>/dev/null; then
    printf 'fail:secretmanager' > /out/status
    printf 'projects/%s/secrets/%s/versions/%s answered 200 but with no payload.data (keys: %s)' \\
      "$PROJECT" "$n" "$v" "$(jq -r 'keys | join(",")' < "/w/r.$i" 2>/dev/null || echo 'not JSON')" > /out/diag
    exit 0
  fi
  rm -f "/w/r.$i"
  i=$((i + 1))
done
# The loop runs in a subshell (a pipe), so its 'exit 0' cannot set the status
# here: the presence of every expected file is what decides.
n=0
while [ "$n" -lt "$COUNT" ]; do
  [ -f "/out/secret.$n" ] || exit 0
  n=$((n + 1))
done
rm -rf /w
printf 'ok' > /out/status
`
    const ctr = this.base()
      .withSecretVariable("GCP_TOKEN", accessToken)
      .withEnvVariable("PROJECT", proj)
      .withEnvVariable("WANTED", JSON.stringify(wanted))
      .withEnvVariable("COUNT", String(wanted.length))
      .withEnvVariable("CACHE_BUST", bust)
      .withExec(["sh", "-c", script])

    const status = (await ctr.file("/out/status").contents()).trim()
    if (status !== "ok") {
      this.throwLeg(status, (await ctr.file("/out/diag").contents()).trim(), {
        project: proj,
        secrets: wanted.map((w) => `${w.name}/${w.version}`).join(","),
      })
    }
    const out: Secret[] = []
    for (let i = 0; i < wanted.length; i++) {
      const value = await ctr.file(`/out/secret.${i}`).contents()
      if (!value) {
        throw new Error(
          `identity: projects/${proj}/secrets/${wanted[i].name}/versions/${wanted[i].version} returned an EMPTY value. An empty secret is almost always a secret whose version was destroyed or disabled, and handing one back as if it were a credential is how an empty password reaches production.`,
        )
      }
      out.push(dag.setSecret(`identity-sm-${tag(proj, wanted[i].name, wanted[i].version, bust)}`, value))
    }
    return out
  }
}

/**
 * The GitHub App exec, shared by `githubAppToken` and `githubAppJwt`.
 *
 * ONE script for both, because two signing implementations would be one more
 * than the number that can be tested without a real App — and the tested one
 * would not be the one production runs. `JWT_ONLY` stops after leg 1.
 *
 * It lives at module scope and not inside the class so both callers reference
 * the same string rather than a copy: `.engine-parity` existed for exactly the
 * failure mode of two copies drifting.
 */
const APP_SCRIPT = `
set -eu
umask 077
mkdir -p /out /w
: > /out/diag
printf 'fail:setup' > /out/status

if ! head -n 1 /run/secrets/app-key.pem | tr -d '\\r' | grep -qE '^-----BEGIN [A-Z ]*PRIVATE KEY-----$'; then
  printf 'fail:key' > /out/status
  printf 'the private key does not start with a PEM banner (-----BEGIN … PRIVATE KEY-----). If it is stored base64-encoded, decode it before passing it. Its first line is deliberately not shown: if the value is not a PEM, that line IS the key.' > /out/diag
  exit 0
fi
# RSA, and checked BEFORE signing. openssl signs happily with an EC or Ed25519
# key and produces a token whose header says RS256 over a signature that is not
# RSA at all — measured: a prime256v1 key yielded a well-formed JWT with a DER
# ECDSA signature. GitHub rejects that with a flat 401, and nothing in the JWT
# says why. '-passin pass:' is not decoration: without it an encrypted key makes
# openssl PROMPT, and a prompt in a container is a hang, not a failure.
if ! openssl rsa -in /run/secrets/app-key.pem -noout -passin pass: >/dev/null 2>/w/ossl.err; then
  printf 'fail:keytype' > /out/status
  printf 'the key is a PEM but openssl will not load it as RSA. GitHub App keys are RSA; an EC or Ed25519 key would still SIGN here and produce a token whose header claims RS256, so it is refused instead. An encrypted key lands here too (no passphrase is ever supplied).' > /out/diag
  exit 0
fi

b64u() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now=$(date -u +%s)
iat=$((now - 60))
exp=$((now + 480))
head=$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | b64u)
# tr -d before b64u: jq -c still ends its output with a newline, and base64url-ing
# that puts a literal newline INSIDE the JWT payload segment. It still decodes to
# valid JSON, so every local check passes and only a strict parser at the far
# end objects. Measured: the payload segment ended '...fQo', which is '}\\n'.
body=$(jq -cn --argjson iat "$iat" --argjson exp "$exp" --arg iss "$APP_ID" '{iat:$iat, exp:$exp, iss:$iss}' | tr -d '\\n' | b64u)
signed="$head.$body"
if ! printf '%s' "$signed" | openssl dgst -sha256 -sign /run/secrets/app-key.pem -binary > /w/sig 2>/w/ossl.err; then
  printf 'fail:sign' > /out/status
  { printf 'openssl could not sign with the App private key\\n'; head -c 600 /w/ossl.err; } > /out/diag
  exit 0
fi
printf '%s.%s' "$signed" "$(b64u < /w/sig)" > /w/jwt
rm -f /w/sig

if [ -n "\${JWT_ONLY:-}" ]; then
  mv /w/jwt /out/token
  printf 'jwt-only (alg RS256, iss %s, iat %s, exp %s)' "$APP_ID" "$iat" "$exp" > /out/diag
  rm -rf /w
  printf 'ok' > /out/status
  exit 0
fi

printf 'header = "Authorization: Bearer %s"\\n' "$(cat /w/jwt)" > /w/curlrc
printf 'header = "Accept: application/vnd.github+json"\\n' >> /w/curlrc
printf 'header = "X-GitHub-Api-Version: 2022-11-28"\\n' >> /w/curlrc
printf 'header = "User-Agent: wildbitca-daggerverse-identity"\\n' >> /w/curlrc

code=$(curl -sS -K /w/curlrc -o /w/inst.json -w '%{http_code}' "$API/orgs/$OWNER/installation" 2>/w/curl.err) || code=000
if [ "$code" = "404" ]; then
  code=$(curl -sS -K /w/curlrc -o /w/inst.json -w '%{http_code}' "$API/users/$OWNER/installation" 2>/w/curl.err) || code=000
fi
if [ "$code" != "200" ]; then
  printf 'fail:installation' > /out/status
  { printf 'HTTP %s looking up the installation of app %s on %s (tried /orgs then /users)\\n' "$code" "$APP_ID" "$OWNER"
    jq -r '.message // empty' < /w/inst.json 2>/dev/null || head -c 400 /w/inst.json; } > /out/diag 2>/dev/null || true
  exit 0
fi
inst=$(jq -er '.id' < /w/inst.json 2>/dev/null) || {
  printf 'fail:installation' > /out/status
  jq -r 'keys | join(",")' < /w/inst.json > /out/diag 2>/dev/null || printf 'response was not JSON' > /out/diag
  exit 0
}

# Belt and braces. githubAppToken validates that permissions is a non-empty
# object before it ever builds this container, so PERMS_JSON is never "null" on
# this path — but if a refactor ever made it so, the request would go out WITHOUT
# a permissions object and GitHub would answer with a token carrying the App's
# entire set. That failure has no symptom: a 201, a valid token, a green run, and
# Deployments:Read-and-write (ADR-0003 4.5) quietly back in the pipeline's
# hand. So the container refuses rather than trusting the caller validated.
if [ "$PERMS_JSON" = "null" ] || [ "$PERMS_JSON" = "{}" ]; then
  printf 'fail:unscoped' > /out/status
  printf 'refused to request an installation token with no permissions object: GitHub would return one carrying every permission the App has.' > /out/diag
  exit 0
fi
jq -n --argjson repos "$REPOS_JSON" --argjson perms "$PERMS_JSON" \\
  '{repositories: $repos, permissions: $perms}' > /w/req.json
code=$(curl -sS -X POST -K /w/curlrc -H 'Content-Type: application/json' --data @/w/req.json \\
  -o /w/tok.json -w '%{http_code}' "$API/app/installations/$inst/access_tokens" 2>/w/curl.err) || code=000
rm -f /w/curlrc /w/jwt /w/req.json
if [ "$code" != "201" ] && [ "$code" != "200" ]; then
  printf 'fail:installation-token' > /out/status
  { printf 'HTTP %s minting a token for installation %s scoped to %s\\n' "$code" "$inst" "$REPOS_JSON"
    jq -r '[.message, ((.errors // []) | tostring)] | join(" ")' < /w/tok.json 2>/dev/null || head -c 400 /w/tok.json; } > /out/diag 2>/dev/null || true
  exit 0
fi
jq -er '.token' < /w/tok.json > /w/tok.raw 2>/dev/null || {
  printf 'fail:installation-token' > /out/status
  jq -r 'keys | join(",")' < /w/tok.json > /out/diag 2>/dev/null || printf 'response was not JSON' > /out/diag
  exit 0
}
tr -d '\\n' < /w/tok.raw > /out/token
jq -r '"expires " + (.expires_at // "unknown") + " · repos " + ((.repositories // []) | map(.name) | join(",") | if . == "" then "ALL (scoping was not applied — treat as a failure)" else . end)' < /w/tok.json > /out/diag
rm -rf /w
printf 'ok' > /out/status
`
