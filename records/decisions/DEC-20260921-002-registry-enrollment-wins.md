# DEC-20260921-002: Registry Enrollment Beats Pi's Bundled Providers

Opened: 2026-09-21 13-10-00 KST
Recorded by agent: claude

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: DEC-20260808-001, DEC-20260808-002, DEC-20260921-001

## Decision

A provider enrolled in setup's registry is registered from that enrollment,
even when Pi ships a builtin with the same id.

- `registerCustomProviders` no longer skips ids Pi bundles. Every enrolled
  provider gets its `base_url`, credential, and transport from the projection.
- The credential name is the registry's declared `auth_key` when present,
  falling back to the provider name.
- A provider the registry types `OpenAICompatible` resolves its models with
  `api: "openai-completions"`, overriding a transport inherited from Pi's
  bundled catalogue entry.
- Registry-declared `headers` are projected onto the resolved model, with
  `{session_id}` substituted from the summon's session. A session-templated
  header is dropped, not sent empty, when the summon has no session.
- The two CLI OAuth aliases (`anthropic`, `codex`) are applied after this and
  still win. Their credential is a CLI login, not a stored key.

## Context

`records/SPEC.md` states that setup's registry is the source of truth for
provider enrollment. The implementation contradicted it: any registry provider
whose name matched a Pi builtin was skipped entirely, and Pi's bundled
definition served the summon instead.

That was invisible until a provider needed both. Enrolling OpenCode Go
surfaced three failures at once:

- Pi's builtin `opencode-go` resolves its key from `OPENCODE_API_KEY`, while
  setup's providers module exports `OPENCODE_GO_API_KEY` and stores the
  credential in its own auth store. The builtin could never authenticate.
- Pi's bundled catalogue for `opencode-go` carried 18 models. The live
  endpoint serves 30, including the `deepseek-v4.1-flash` the operator asked
  for. The bundled snapshot silently hid it.
- OpenCode Go rejects any request without an `x-opencode-session` header, and
  pi-ai 0.84.1 does not send one.

Two further defects shared the same root. `opencode-zen` declares
`auth.key: "opencode-go"` because Go and Zen are separate services sharing one
key; credential lookup by provider name never found it, so that provider had
never worked here. And `kimicode` failed with "no API implementation for
anthropic-messages": Pi bundles kimi models on that transport, while the
registry enrolls kimicode as an OpenAI-compatible endpoint and
`registerCustomProviders` wires only `openai-completions`.

## Options Considered

### Rename The Enrollment To Dodge The Collision

- Upside: no library-facing change; works immediately.
- Downside: credential lookup keys on the provider name, so it also requires
  duplicating the stored key under a second name. Papers over the precedence
  bug and leaves the next bundled-id collision to fail the same way.

### Serve Setup's Stored Keys To Pi's Builtins

- Upside: smallest change; unblocks auth without touching precedence.
- Downside: the bundled catalogue still decides which models exist, so
  `deepseek-v4.1-flash` stays invisible, and `opencode-zen` stays broken.
  Treats the symptom.

### Registry Enrollment Wins (Chosen)

- Upside: makes the code match the stated invariant. Fixes `opencode-zen` and
  `kimicode` as a consequence rather than as separate patches, and means a
  provider Pi bundles later cannot silently take over an enrollment.
- Downside: miniharness now owns the transport decision for enrolled
  providers, so a registry entry typed `OpenAICompatible` that genuinely needs
  another transport would need the registry to say so. No such entry exists.

## Rationale

The registry already carries every fact needed to reach a provider — endpoint,
credential name, model inventory, and now required headers — and setup's
providers module refreshes it against the live endpoint. Pi's bundled
definitions are a snapshot with different auth assumptions. Where the two
disagree about an enrolled provider, the registry is by definition more
current, and the spec already said so.

Keeping provider quirks in the registry rather than in this harness matters
for the same reason: `x-opencode-session` is a property of the OpenCode Go
enrollment, not of miniharness, so it is declared as data and substituted
generically.

## Consequences

- `files/provider-registry.json` in LPFchan/setup gains an `opencode-go`
  enrollment with its `headers` block, and the providers module projects
  `auth_key` and `headers` into `models.json`.
- Verified live on grimoire: `opencode-go` summons succeed for
  `deepseek-v4.1-flash`, `mimo-v2.5`, `glm-5.3-flash`, and `qwen3.8-flash`,
  including a `--allow-bash` tool round trip.
- `kimicode` no longer fails on transport; it now surfaces a separate provider
  complaint about the `developer` role, which is out of scope here.
- `crofai` returns the same 405 it returned before this change; unrelated and
  pre-existing.
- `builtinProviderIds()` is removed — the skip it existed for is gone.
- `tests/provider-resolution.test.mjs` covers precedence, `auth_key`, header
  substitution and omission, and the transport override.
- Enrolling a provider whose endpoint needs a transport other than
  `openai-completions` now requires a registry-side type for it.
