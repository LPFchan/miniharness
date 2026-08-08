# miniharness Status

This document tracks current operational truth.
Update it when the project's real state changes.
Do not use it as a transcript or a scratchpad.

## Snapshot

- Last updated: 2026-08-08
- Overall posture: `active`
- Current focus: wave 1 landed (skeleton + conformance suite); wave 2 ready to fan out.
- Highest-priority blocker: none.
- Next operator decision needed: none blocking — wave 2 (slices C/D/E) is unblocked.
- Related decisions: DEC-20260808-001 (CLI summon contract)
- Origin research: heatmap `records/research/RSH-20260808-001-miniharness-opencode-replacement.md`

## Current State Summary

The repository operating scaffold is adopted from `LPFchan/repo-template`
version 1.1.5. The canonical product specification is `records/SPEC.md`;
current operational truth is this file; accepted future direction is
`records/PLANS.md`. No implementation exists yet. The build/fork/adopt
question that motivated the project is settled by prior research (heatmap
RSH-20260808-001): build a CLI-only thin harness on Pi's agent libraries
(`@earendil-works/pi-agent-core` + `pi-ai`), sessions on as JSONL, JSON in/out,
concurrency capped in the low teens; adopt nothing, fork nothing.

## Active Phases Or Tracks

### Repository Bootstrap

- Goal: adopt the repo-template scaffold and seed canonical records.
- Status: `done`
- Why this matters now: the research is settled; the project needs a canonical
  home before implementation begins.
- Current work: scaffold copied, records seeded, hooks wired, pushed to
  `LPFchan/miniharness` (private). `upstream-intake/` enabled, scoped to the
  Pi agent libraries.
- Exit criteria: scaffold present, truth docs seeded, hooks enabled, remote set.
- Dependencies: `LPFchan/repo-template` 1.1.5.
- Risks: none.
- Related ids: none yet.

### Upstream Intake (Pi libraries)

- Goal: recurring review of upstream Pi releases against the pinned version,
  so contract changes (loop API, session JSONL, `models.json` schema) are
  caught deliberately rather than by breakage.
- Status: `not started`
- Why this matters now: the harness rides Pi's weekly release cadence without
  forking; that only works if upstream is actually watched.
- Current work: module enabled, scope declared in
  `records/upstream-intake/SCOPE.md`.
- Exit criteria: first weekly intake reviewed once the harness pins a version.
- Dependencies: a pinned `@earendil-works/pi-*` version (post-implementation).
- Risks: none before implementation; the module is dormant until then.
- Related ids: heatmap RSH-20260808-001.

### CLI Summon Contract

- Goal: a headless summon that takes argv/env and returns one JSON document
  with a meaningful exit code, on `pi-agent-core`'s agent loop.
- Status: `skeleton landed; flag wiring (D/E) pending`
- Why this matters now: it is the core capability heatmap's recap path needs.
- Current work: wave 1 merged — `src/cli.ts` performs a headless summon on
  `pi-agent-core`/`pi-ai` 0.84.1 and emits the DEC envelope (verified live:
  exit 0 with tokens/cost/duration); the conformance suite
  (`tests/contract.test.mjs`) gates remaining work with 3 red exit-2 tests
  for the unimplemented flags.
- Exit criteria: a single summon emits the DEC-20260808-001 envelope with
  `--provider`/`--model`/`--effort` resolution and sessions on, in place of
  `opencode run`.
- Dependencies: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`;
  generated `models.json` from setup's registry.
- Risks: Node memory tax at concurrency (low-teens cap).
- Related ids: none yet.

## Recent Changes To Project Reality

- Date: 2026-08-08
  - Change: Wave 1 fanned out to two parallel subagents (opencodex,
    crofai/deepseek-v4-flash-0731 on the codex leg) and merged: CLI skeleton
    (slice A) + conformance suite (slice B). One review finding: slice B's
    test script needed a glob for Node 22.23 (its reported result was not
    reproducible as shipped); fixed at integration.
  - Why it matters: the DEC envelope is proven against a live provider; the
    conformance gate now measures wave-2 progress automatically.
  - Related ids: DEC-20260808-001, LOG-20260808-152831-odexk3,
    LOG-20260808-153054-odexk3
- Date: 2026-08-08
  - Change: Summon contract fixed across sixteen surfaces (DEC-20260808-001).
  - Why it matters: removes the last blocking decision; all near-term build
    slices (CLI skeleton, session persistence, models.json consumer,
    conformance test) are now unblocked and parallelizable.
  - Related ids: DEC-20260808-001, heatmap RSH-20260808-001
- Date: 2026-08-08
  - Change: Repository created from repo-template 1.1.5; records seeded.
  - Why it matters: establishes the canonical home for the settled
    opencode-replacement work.
  - Related ids: heatmap RSH-20260808-001

## Active Blockers And Risks

- Blocker or risk: Node/V8 memory tax at 8–16 concurrent instances.
  - Effect: caps usable concurrency in the low teens on the current host.
  - Owner: operator/orchestrator.
  - Mitigation: `--max-old-space-size` tuning + a real load test once the thin
    harness exists; escape hatch is a Rust thin harness on `rig`.
  - Related ids: heatmap RSH-20260808-001 (Q2)

## Immediate Next Steps

- Next: fan out wave 2 — slice C (JSONL session persistence +
  adoption-join probe), slice D (models.json consumer +
  provider/model/effort resolution), slice E (CLI flag wiring).
  - Owner: worker agents (parallel).
  - Trigger: none — wave 1 merged.
  - Related ids: DEC-20260808-001.
- Next: provide a fault-injection hook so the exit-1 conformance test can
  leave todo (flagged by slice B).
  - Owner: wave-2 worker (slice E).
  - Trigger: slice E implementation.
  - Related ids: DEC-20260808-001.
