# DEC-20260819-001: Add Compaction Lifecycle Events

Opened: 2026-08-19 00-36-54 KST
Recorded by agent: codex

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: DEC-20260809-001, DEC-20260808-001

## Decision

Extend lifecycle v1 with exactly two content-free events around the actual
compaction model call:

- `compaction_started` immediately before the call
- `compaction_finished` after it settles, carrying only
  `outcome: completed|failed`

The pair is emitted only when compaction is enabled, needed, and successfully
prepared to run. A returned failure and a thrown exception both produce the
failed outcome; thrown exceptions continue through the existing internal
failure path after the finish event. `--silent` suppresses both events through
the existing lifecycle emitter.

## Context

Callers need a truthful live indication while the compaction model request is
running. Preparation and threshold checks can take place without that state,
and disabled, unnecessary, or unprepared compaction must not appear as an
active model call.

## Options Considered

### Add Only The Two Call-Boundary Events (chosen)

- Upside: reports the exact interval callers need without exposing content.
- Upside: preserves the existing envelope, session JSONL, thresholds, and
  failure policy.
- Downside: preparation, retry, and persistence remain unreported.

### Add Preparation, Retry, Or Persistence Events

- Upside: offers more internal detail.
- Downside: expands lifecycle v1 beyond the accepted caller need and risks
  implying guarantees the current provider/library boundaries cannot make.

## Rationale

The lifecycle stream should describe the model call that can keep a summon
alive, not internal setup work. Bracketing the existing `compact()` await gives
callers a precise interval while keeping the event payload free of summaries,
prompts, model output, exceptions, credentials, URLs, and tool data.

## Consequences

- Successful overflowing summons order `finalizing`,
  `compaction_started`, `compaction_finished` with `completed`, and `done`.
- Failed compaction keeps the existing success/failure behavior while exposing
  only the failed outcome in the new finish event.
- Existing stdout and session JSONL contracts do not change.
- No persistence, MCP, retry, heartbeat, preparation, or additional lifecycle
  events are introduced.
