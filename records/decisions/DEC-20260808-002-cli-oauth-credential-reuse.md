# DEC-20260808-002: Reuse Claude Code And Codex CLI OAuth Credentials As Providers

Opened: 2026-08-08 23-13-20 KST
Recorded by agent: codex-k3

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: DEC-20260808-001

## Decision

miniharness reads the OAuth credentials that the operator's existing Claude
Code (`~/.claude/.credentials.json`) and Codex CLI (`~/.codex/auth.json`)
logins already maintain, and uses them to serve the registry's `anthropic`
and `codex` providers — the same reuse pattern opencodex applies to the
Codex CLI login.

Mechanics:

- A small `CredentialStore` (pi-ai's four-method contract) translates the
  CLI file shapes into pi-ai's `{ type: "oauth", access, refresh, expires }`
  credential shape and hands it to `createModels({ credentials: store })`.
- Refreshed tokens are written back to the CLI files, so miniharness and
  the CLIs share one token lineage instead of drifting into parallel
  refresh races.
- The registry's `codex` provider routes through pi-ai's builtin
  `openai-codex` provider (its Responses API targets
  `chatgpt.com/backend-api` and sends the `chatgpt-account-id` header),
  not the generic OpenAI-compatible registration.
- The registry's `anthropic` provider keeps pi-ai's builtin `anthropic`
  provider; the store supplies the credential Claude Code maintains.

## Context

The operator holds Claude Pro/Max and ChatGPT Plus/Pro subscriptions, both
already logged in on this host through the first-party CLIs. pi-ai ships
builtin OAuth machinery for both providers: it stores credentials as
`{ type: "oauth", access, refresh, expires, accountId? }`, refreshes
expired tokens under the credential-store lock (the public OAuth client
IDs are the same ones the CLIs use), and derives request auth from the
stored credential. The CLI file shapes are a direct field rename of that
shape:

- Claude Code: `claudeAiOauth.{accessToken, refreshToken, expiresAt}`
- Codex CLI: `tokens.{access_token, refresh_token, account_id}`

Before this decision, miniharness only resolved static API keys (env vars
for builtins, setup's opencode auth store for registry providers), so
neither subscription was reachable from a summon.

## Options Considered

### Export The Access Token Into An Env Var Per Summon

- Upside: zero new code paths; pi-ai already honours
  `ANTHROPIC_OAUTH_TOKEN`
- Downside: no refresh — the token dies in hours and the summon fails;
  does not transfer to Codex, which needs the account-id header machinery
  anyway

### Vendor A Separate OAuth Flow For miniharness

- Upside: miniharness owns its token lifecycle end to end
- Downside: forces a second login per subscription per machine, duplicates
  state the CLIs already maintain, and contradicts "build thin on the
  library" — pi-ai's store seam exists precisely for this

### Reuse The CLI Credential Files Via A CredentialStore (Chosen)

- Upside: no new logins; refresh automatic and race-safe across processes
  because refreshed tokens land back in the files the CLIs read
- Upside: opencodex already proves the Codex leg of this pattern on the
  same host
- Downside: miniharness becomes a co-writer of CLI-owned files; a format
  change in either CLI must be caught by reading defensively (absent or
  malformed fields resolve as "no credential", never a crash)

## Rationale

The store seam is the library's intended injection point for exactly this
reuse, the field translation is a pure rename, and write-back keeps one
token lineage per subscription — the property that makes concurrent
miniharness/CLI use safe against double-refresh invalidation.

## Consequences

- `--provider anthropic` and `--provider codex` work from the subscription
  logins with no API keys and no new auth enrolment step in setup.
- miniharness writes to `~/.claude/.credentials.json` and
  `~/.codex/auth.json` (refresh write-back only, preserving all other
  fields); writes must be atomic (temp file + rename) and best-effort —
  a failed write-back degrades the next refresh, never the in-flight
  summon.
- Reading is defensive: a missing file, malformed JSON, or missing token
  fields resolves as "no credential" and surfaces the provider's ordinary
  auth error, not a config-layer crash.
- Env overrides: `MINIHARNESS_CLAUDE_CREDENTIALS_FILE` and
  `MINIHARNESS_CODEX_AUTH_FILE` point the readers at alternate files, for
  tests and non-standard homes.
- Subscription terms of service are the operator's accepted risk, stated
  at decision time; the harness does not gate on them.
