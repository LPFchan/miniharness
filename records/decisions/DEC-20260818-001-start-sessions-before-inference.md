# DEC-20260818-001: Start Sessions Before Inference

Opened: 2026-08-18 14-00-37 KST
Recorded by agent: codex

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: DEC-20260808-001, DEC-20260809-001, DEC-20260814-001

## Decision

For every session-enabled summon, Miniharness creates or opens the Pi JSONL
session before provider setup and inference. It then emits a versioned
`session_started` lifecycle record carrying the Miniharness-owned session id
and whether the session was resumed.

A supplied system prompt may contain `{session_id}`. Miniharness replaces that
token with the opened session's id before constructing the agent. Using the
token with `--no-session` is a bad invocation. The final stdout envelope keeps
reporting the same id on success.

## Context

Creating a session only after a successful answer made the session timestamp
describe completion rather than the user's request. A hung or failed first
turn left no session identity for the caller to correlate or resume, and a
model could not accurately report its own id during that first turn.

## Options Considered

### Let The Caller Create Pi Session Files

- Upside: no Miniharness change.
- Downside: makes every caller own Pi's JSONL format and id rules.

### Let The Caller Assign The Miniharness Session Id

- Upside: the caller knows the id before starting the process.
- Downside: moves identity authority out of Miniharness and complicates
  collision and retry handling.

### Create Early And Report Through Lifecycle (Chosen)

- Upside: Miniharness remains the sole session-id and persistence authority.
- Upside: callers receive the id before inference and can resume an idle or
  failed attempt.
- Upside: `{session_id}` lets the first system prompt name the real id without
  a caller-owned placeholder session.
- Downside: failed first turns leave a valid header-only session as durable
  evidence.

## Rationale

Session identity belongs to the harness that owns the session format. Creating
the header before inference makes the durable record match the actual start of
the conversation, while the lifecycle stream is already the established path
for early, content-free orchestration data.

## Consequences

- A first-turn failure still has a stable session id and JSONL header.
- Callers may retry by resuming the id from `session_started`.
- The model can report its id on the first turn when the caller uses the
  `{session_id}` system-prompt token.
- `--silent` continues to suppress non-failure lifecycle records, including
  `session_started`; the final success envelope remains unchanged.
