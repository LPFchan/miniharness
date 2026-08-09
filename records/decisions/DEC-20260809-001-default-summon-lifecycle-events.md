# DEC-20260809-001: Default Summon Lifecycle Events

Opened: 2026-08-09 22-08-17 KST
Recorded by agent: codex-sol

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: RSH-20260809-001, DEC-20260808-001
- Supersedes: DEC-20260808-001 only where it requires human-readable-only and
  empty-on-success stderr

## Decision

Miniharness emits a versioned NDJSON lifecycle stream on stderr by default for
every summon. Stdout remains exactly one final JSON envelope on success and
empty on failure.

`--silent` suppresses lifecycle and progress events. It restores empty stderr
for successful summons but never suppresses failure diagnostics.

Miniharness-authored stderr records use the lifecycle protocol, including
failures. Each record contains `protocol`, `version`, `seq`, `event`, an ISO
timestamp, and monotonic `elapsed_ms`, plus event-specific safe metadata.
Callers must tolerate unstructured stderr from failures below miniharness.

The initial event vocabulary is:

- `started`
- `request_started`
- `response_started`
- `streaming_started`
- `progress`
- `tool_call`
- `tool_started`
- `tool_finished`
- `finalizing`
- `done`
- `failed`

`done` is emitted after the final envelope has been synchronously written to
stdout. It means miniharness completed finalization and handed the envelope to
the operating-system pipe; it does not claim the caller consumed it.

Progress records contain counters only and are coalesced to bound volume. They
may be dropped under stderr backpressure. State transitions must not be
dropped. No lifecycle record contains prompt text, assistant or reasoning
deltas, tool arguments or results, credentials, or provider response headers.

The caller continues to own deadlines. A quiet `awaiting_response` state is not
labeled `retrying`: explicit retry events require a future callback from Pi's
provider-retry layer.

## Context

Heatmap can run 8–16 recap summons concurrently but currently sees each child
as spawn, wait, and one final envelope. It cannot tell whether a worker is
waiting for the provider, actively generating, running a tool, finalizing a
session, or stalled until the 600-second caller deadline expires.

RSH-20260809-001 established that the pinned Pi agent core already exposes most
required state through `Agent.subscribe()`. The missing retry signal sits below
that layer in `pi-ai`; recreating retry in miniharness would violate the
project's thin-wrapper boundary.

Default observability is preferable to an opt-in because miniharness is a
headless orchestration harness. Every caller should receive enough state to
diagnose a summon without remembering an additional flag. The project is still
pre-1.0, so this is the appropriate point to revise the stderr contract.

## Options Considered

### Default stderr NDJSON With `--silent` (chosen)

- Upside: every headless caller receives lifecycle state automatically.
- Upside: reuses the stderr pipe already owned by each parent process.
- Upside: `--silent` supports callers that require empty success stderr.
- Downside: revises DEC-20260808-001 and requires callers to drain stderr.

### Opt-in stderr Events

- Upside: preserves empty success stderr for existing invocations.
- Downside: observability is absent unless every caller remembers to enable it.
- Downside: a missed flag recreates the black-box failure mode this feature is
  intended to remove.

### TTY-sensitive Automatic Behavior

- Upside: avoids lifecycle output when invoked from a terminal.
- Downside: the same command has different observable behavior depending on
  its environment, complicating tests and orchestration.

### Dedicated File Descriptor Or Sidecar Socket

- Upside: separates lifecycle records from diagnostics and can support
  non-parent observers.
- Downside: adds descriptor wiring or socket discovery, permissions,
  correlation, reconnect, and cleanup without a current need.

## Rationale

Lifecycle state is part of the value of a headless harness, not optional debug
decoration. Default stderr NDJSON makes the safe path automatic while
preserving the one-envelope stdout contract. `--silent` provides the narrow
compatibility escape hatch without weakening failure visibility.

The event vocabulary projects Pi's existing lifecycle rather than exposing Pi
types directly. This keeps the miniharness protocol stable across library
upgrades and leaves provider retry policy in its canonical owner.

## Consequences

- DEC-20260808-001 remains canonical for the summon envelope, exit codes,
  inputs, sessions, configuration, timeouts, and concurrency. This decision
  replaces only its stderr behavior.
- The conformance suite must expect lifecycle NDJSON on successful default
  summons and retain an empty-success-stderr assertion under `--silent`.
- Heatmap must drain and parse each child's stderr concurrently, while
  tolerating unstructured runtime failure output.
- README and status documentation change only when implementation lands.
- Retry visibility remains separate upstream work in `pi-ai`.
