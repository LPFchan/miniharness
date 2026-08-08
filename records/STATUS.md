# miniharness Status

This document tracks current operational truth.
Update it when the project's real state changes.
Do not use it as a transcript or a scratchpad.

## Snapshot

- Last updated: 2026-08-08
- Overall posture: `active`
- Current focus: 0.1.0 released on npm (`npm install -g miniharness`); DEC-20260808-001 fully implemented and proven live on a routed provider.
- Highest-priority blocker: none.
- Next operator decision needed: heatmap cutover timing (mid-term track); setup-side registry→models.json generator (setup-repo task).
- Related decisions: DEC-20260808-001 (CLI summon contract)
- Origin research: heatmap `records/research/RSH-20260808-001-miniharness-opencode-replacement.md`

## Current State Summary

The repository operating scaffold is adopted from `LPFchan/repo-template`
version 1.1.5. The canonical product specification is `records/SPEC.md`;
current operational truth is this file; accepted future direction is
`records/PLANS.md`. The implementation fixed by DEC-20260808-001 exists and
is live-verified: a CLI-only thin harness on Pi's agent libraries
(`@earendil-works/pi-agent-core` + `pi-ai` 0.84.1), sessions on as JSONL,
one JSON envelope out, meaningful exit codes, registry-driven
provider/model/effort resolution including custom OpenAI-compatible
providers. Nothing forked, nothing adopted beyond the two pinned libraries.

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
- Status: `ready to start`
- Why this matters now: the harness rides Pi's weekly release cadence without
  forking; that only works if upstream is actually watched.
- Current work: module enabled, scope declared in
  `records/upstream-intake/SCOPE.md`; `@earendil-works/pi-*` pinned at 0.84.1.
- Exit criteria: first weekly intake reviewed against the 0.84.1 pin.
- Dependencies: none — the pin exists.
- Risks: none.
- Related ids: heatmap RSH-20260808-001.

### CLI Summon Contract

- Goal: a headless summon that takes argv/env and returns one JSON document
  with a meaningful exit code, on `pi-agent-core`'s agent loop.
- Status: `done — full DEC contract implemented and live-verified`
- Why this matters now: it is the core capability heatmap's recap path needs.
- Current work: waves 1–2 merged. `miniharness` implements the complete
  DEC-20260808-001 surface: envelope with tokens/cost/duration/session_id,
  exit codes 0/1/2/3, full flag set (provider/model/effort incl. registry
  tiers, system-prompt via flag/file/stdin, cwd, session-dir, no-session,
  config-dir, help), JSONL sessions on by default, adoption-join probe,
  registry custom providers (crofai et al. as OpenAI-compatible endpoints
  keyed from setup's auth store), and a fault-injection hook for the exit-1
  path. Compaction (SPEC core capability) is wired in: `--compaction
  off|auto` (default auto) runs pi-agent-core's compaction on a completed
  transcript that would overflow the context window and persists the
  compaction entry to the session JSONL; the DEC envelope is unchanged.
  Suite: 64 tests, 59 pass, 0 fail, 5 live skips, 0 todo. Live-verified
  on crofai (deepseek-v4-flash-0731): exit 0 envelope + session JSONL +
  stage-key probe recovery.
- Exit criteria: met pending heatmap cutover.
- Dependencies: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`;
  generated `models.json` from setup's registry.
- Risks: Node memory tax at concurrency (low-teens cap).
- Related ids: none yet.

## Recent Changes To Project Reality

- Date: 2026-08-08
  - Change: 0.1.0 published to npmjs as `miniharness` (public, maintainer
    lpfchan). Packaging: `files: [dist]` whitelist (6-file, ~20 kB tarball),
    `prepublishOnly` build+test gate, README install/prerequisite and
    credentials sections corrected. Verified post-publish: clean-room
    `npm install miniharness` resolves and the `miniharness` bin runs.
  - Why it matters: the harness is now consumable fleet-wide without a git
    checkout; heatmap cutover can depend on the npm artifact.
  - Related ids: DEC-20260808-001, LOG-20260808-185917-odexk3, tag v0.1.0
- Date: 2026-08-08
  - Change: Compaction wired into the summon path (mutual-agreement
    delegation, crofai/deepseek-v4-flash-0731 codex-leg subagent
    implemented, parent reviewed and committed). Known boundary recorded by
    the implementer: `--compaction auto` compacts completed transcripts; it
    does not rescue a summon that overflows in flight (that would be a
    pre-prompt check — a separate decision if ever needed). Chunk-and-merge
    for monster sessions is heatmap's orchestration concern, not the
    harness's: miniharness is summoned once per chunk and once for the
    merge, keeping the no-subagents invariant intact.
  - Why it matters: closes the last SPEC core-capability gap; settles where
    large-transcript handling lives ahead of the heatmap cutover.
  - Related ids: DEC-20260808-001, LOG-20260808-184530-odexk3
- Date: 2026-08-08
  - Change: Wave 2 fanned out (slices C/D/E) and merged with live-fire
    integration fixes: custom-provider registration, fixture regeneration
    (profile-enabled providers), adoption-probe recursion + pi JSONL v4
    shape. Slice C's child hung post-completion and was killed; its complete
    work was adopted from the worktree. systemd-tmpfiles-clean wiped the
    wave-2 /tmp run-state mid-flight; worktrees and repo were unaffected.
  - Why it matters: the summon contract is no longer theoretical — it ran
    live against a routed provider and round-tripped the adoption join.
  - Related ids: DEC-20260808-001, LOG-20260808-165116-odexk3,
    LOG-20260808-165341-odexk3, LOG-20260808-172623-odexk3,
    LOG-20260808-174749-odexk3
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

- Next: concurrency load test on the real host (mid-term track; gates the
  low-teens cap and the Rust escape hatch decision).
  - Owner: orchestrator.
  - Trigger: operator schedules.
  - Related ids: heatmap RSH-20260808-001 (Q2).
- Next: heatmap integration — point the recap summon at miniharness.
  - Owner: operator decision → heatmap worker.
  - Trigger: operator schedules cutover.
  - Related ids: heatmap `src/recap/mod.rs`, DEC-20260808-001.
- Next: setup-side registry→models.json generator replaces the hand fixture.
  - Owner: setup repo.
  - Trigger: operator schedules in setup.
  - Related ids: heatmap RSH-20260808-001 (Q1).
