# DEC-20260814-001: Resume Persisted Sessions

Opened: 2026-08-14 13-49-03 KST
Recorded by agent: codex-root

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: DEC-20260808-001, heatmap DEC-20260814-001

## Decision

Add `--resume <session-id>` to the summon contract. Miniharness opens the
matching JSONL session through Pi's session repository, reconstructs its
current conversation branch, runs one new user turn, appends only that new
turn to the same file, and reports the same session id in the success envelope.

Session ids must use a safe filename-compatible shape and must already exist
in the selected session directory. Unknown, malformed, or unsafe ids are bad
invocations with exit code 2. `--resume` and `--no-session` are mutually
exclusive.

## Context

Heatmap's Hermes classifier needs to tell a model that its project choice was
invalid without losing the session evidence and reasoning that produced the
choice. Miniharness already persists Pi JSONL sessions and returns their ids,
but previously exposed no way for a later invocation to continue one.

## Options Considered

### Start A Fresh Summon With The Original Prompt Repeated

- Upside: no CLI change.
- Downside: duplicates context and does not preserve the actual conversation.

### Let Callers Edit JSONL Directly

- Upside: keeps miniharness smaller.
- Downside: makes callers own Pi's session format and branch reconstruction.

### Resume Through Pi's Session Repository (Chosen)

- Upside: Pi remains responsible for decoding and rebuilding its own session
  history.
- Upside: callers need only the stable id already returned in the envelope.
- Downside: the session directory and JSONL file must remain available between
  turns.

## Rationale

Resumption is part of the invocation boundary because callers cannot safely
reconstruct Pi state themselves. The additive flag keeps normal summons
unchanged while providing the smallest durable primitive needed for correction
loops.

## Consequences

- Callers can continue a saved conversation without an interactive UI.
- A resumed success appends to one existing JSONL file rather than creating a
  second session.
- The existing stdout envelope and exit-code meanings remain unchanged.
- This adds no autonomous retry policy; callers decide whether and how often
  to resume.
