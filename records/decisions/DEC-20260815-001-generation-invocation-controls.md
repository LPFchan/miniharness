# DEC-20260815-001: Add Bounded Generation Invocation Controls

Opened: 2026-08-15 20-55-49 KST
Recorded by agent: codex-root

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: DEC-20260808-001

## Decision

Extend the headless summon contract with three small CLI features:

- `--version` prints only the package semantic version and exits before configuration, session, lifecycle, or provider work.
- `--no-system-prompt` explicitly requests a user-only invocation and fails closed for adapters that inject their own instruction.
- `--gen-params '<JSON object>'` accepts one bounded inline object containing only `temperature`, `max_tokens`, `seed`, `top_p`, and `stop`.

`temperature` and `max_tokens` map to Pi's portable stream options. `seed`,
`top_p`, and `stop` use Pi's sampling-parameter seam only for adapters proven
to forward it. Unsupported adapters and unknown fields fail before provider
contact. The success envelope and session format remain unchanged; generation
parameters apply only to the current invocation and are not inherited on
resume.

## Context

Eastself needs deterministic, bounded calls through one globally installed
Miniharness executable. The existing contract could not express a seed or
remove Miniharness's default system prompt, and it had no machine-readable
version identity for a sealed caller to bind.

## Options Considered

### Add Separate Flags For Every Sampler

- Upside: familiar scalar CLI syntax
- Downside: expands the public surface for provider-specific behavior

### Accept A Generation-Parameter File

- Upside: directly hashable input
- Downside: adds file ownership, symlink, size, and stdin questions to a small invocation wrapper

### Accept One Bounded Inline Object

- Upside: keeps one cohesive generation surface and needs no file lifecycle
- Upside: allows a caller to canonicalize and seal the normalized object
- Downside: callers must pass valid inline JSON

### Persist Invocation Parameters In Session JSONL

- Upside: adds per-turn audit metadata
- Downside: changes session failure, ordering, adoption, and compatibility semantics without serving no-session evaluation calls

## Rationale

One inline allowlisted object is the smallest general seam that supports
deterministic local/OpenAI-compatible evaluation without turning Miniharness
into an evaluation framework or raw request proxy. Explicit version and
system-prompt states close independent gaps in the invocation contract.

## Consequences

- Callers may bind Miniharness's version and normalized requested generation parameters.
- Miniharness promises requested parameters, not bit-identical provider behavior.
- Session persistence, arbitrary provider options, raw token IDs, batching, scoring, and model-registry projection remain outside this decision.
- New generation keys require deliberate allowlist expansion and adapter review.
