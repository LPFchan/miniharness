# miniharness Plans

This document contains accepted future direction only.
Do not put raw brainstorms or untriaged intake here.

## Planning Rules

- Only accepted future direction belongs here.
- Plans should be specific enough to guide execution later.
- Product or architecture rationale should link to `DEC-*` records when relevant.
- When a plan becomes current truth, reflect it into `records/SPEC.md` or `records/STATUS.md` and update this file.

## Approved Directions

### Thin CLI harness on Pi agent libraries

- Outcome: a CLI-only harness that summons a model headlessly and returns one
  JSON document, replacing `opencode run` in heatmap's recap path.
- Why this is accepted: settled by heatmap RSH-20260808-001 (Updates 2–3).
  Building thin on `@earendil-works/pi-agent-core` + `pi-ai` keeps the
  multi-provider retry layer and per-model capability/effort catalogue from a
  maintained upstream, while the loop invocation contract stays owned.
- Expected value: off opencode for headless summons; owned output contract;
  no TUI/database to maintain.
- Preconditions: generated `models.json` from setup's registry; npm deps
  available.
- Earliest likely start: 2026-08.
- Related ids: heatmap RSH-20260808-001.

### Registry → models.json projection

- Outcome: setup's canonical registry (`~/.config/providers/registry.json`)
  generates the `models.json` this harness consumes.
- Why this is accepted: RSH-20260808-001 Q1 — the two registries answer
  different questions; setup stays canonical for enrollment, Pi's file is a
  generated projection (the same writer/reader pattern setup already uses for
  opencode auth).
- Expected value: single source of truth for providers; no hand-edited
  duplicate registry.
- Preconditions: a generator in the setup repo (separate task, not this repo).
- Earliest likely start: 2026-08.
- Related ids: heatmap RSH-20260808-001 (Q1).

## Sequencing

### Near Term

- Initiative: build slices against the fixed contract (DEC-20260808-001),
  fanned out to parallel workers in two waves.
  - Why now: the contract is fixed; the slices below are independent once
    the package skeleton exists.
  - Wave 1 (parallel):
    - Slice A — package skeleton + pinned `@earendil-works/pi-agent-core` /
      `pi-ai` + one headless summon smoke spike (owns `package.json`,
      tsconfig, `src/`; pins the version everything else builds on).
    - Slice B — contract conformance test harness asserting argv-in /
      envelope-out / exit codes 0–3 from DEC-20260808-001 (owns `tests/`;
      gates every later change).
  - Wave 2 (parallel, after wave 1 merges):
    - Slice C — JSONL session persistence at the harness-owned path
      (`~/.local/share/miniharness/sessions/`, `--session-dir`,
      `--no-session`) plus a read-only adoption-join probe against fixture
      JSONL.
    - Slice D — `models.json` consumer + `--provider`/`--model`/`--effort`
      resolution against setup's registry and the generated
      `thinkingLevelMap`, using a fixture projection until the setup-side
      generator lands.
    - Slice E — CLI wiring: argv/stdin parsing, `--system-prompt`,
      `--cwd`, envelope emission, exit-code mapping.
  - Dependencies: npm deps (registry reachable, current 0.84.1); generated
    `models.json` (fixture acceptable until the setup generator lands).
  - Related ids: DEC-20260808-001, heatmap RSH-20260808-001.

### Mid Term

- Initiative: heatmap integration — point the recap summon at miniharness.
  - Why later: requires the summon contract to exist and match heatmap's
    expected output shape.
  - Dependencies: CLI summon contract; heatmap config change.
  - Related ids: heatmap `src/recap/mod.rs`.
- Initiative: first upstream intake review of the pinned Pi version.
  - Why later: meaningful only once a `@earendil-works/pi-*` version is pinned;
    then runs weekly against new releases.
  - Dependencies: implementation pins a version; `upstream-intake/SCOPE.md`.
  - Related ids: `records/upstream-intake/SCOPE.md`.
- Initiative: concurrency load test on the real host.
  - Why later: measures the Node tax at the actual burst; gates the
    low-teens cap.
  - Dependencies: working thin harness; real transcripts.
  - Related ids: heatmap RSH-20260808-001 (Q2).

### Deferred But Accepted

- Initiative: Rust thin harness on `rig` (escape hatch).
  - Why deferred: only needed if the Node memory tax fails the load test at
    the required concurrency.
  - Revisit trigger: load test shows the low-teens cap is insufficient.
  - Related ids: heatmap RSH-20260808-001 (Q4).
