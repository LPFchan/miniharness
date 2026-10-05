# Upstream Intake Scope

This module is **enabled**. The tracked upstream is the Pi agent libraries this
harness builds on, consumed as npm packages — not a fork's source repo.

## Tracked Upstream

- Packages: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`
  (and `@earendil-works/pi-coding-agent` if `createAgentSession()` is used).
- Source repo: `earendil-works/pi` (GitHub), releases weekly.
- Review unit: an upstream release tag against the version this repo pins,
  per `intake-method.md` (candidate decisions, not per-commit changelogs).

## Compatibility-Sensitive Seams (standing, feeds the watchlist)

These are the Pi contracts miniharness depends on; any change here is a
candidate decision, never a silent upgrade:

- **Agent loop API** — `agentLoop()` and its `AgentLoopConfig` / `AgentEvent`
  shapes.
- **Session/session-manager JSONL layout** — the append-only session file
  format and `~/.pi/agent/sessions/` path convention. Heatmap's adoption/
  recovery join parses this; a schema change breaks the safety net.
- **`createAgentSession()` options** — `cwd`, `agentDir`, `model`,
  `thinkingLevel`, tool selection.
- **`Model` / `thinkingLevelMap` schema** — the per-model capability catalogue
  consumed via generated `models.json`.
- **Provider/retry behaviour** — the multi-provider retry set and
  `retry-after` handling.
- **Env-var contract** — `PI_CODING_AGENT_DIR` and related config paths.

## Posture

miniharness does not fork Pi and carries no local patches to merge. Intake is
therefore about **when to bump the pinned version and what to adapt**, not
about resolving fork/upstream conflicts. `known-local-overrides.md` stays
nearly empty by design; it records only intentional divergences from a Pi
default (e.g. sessions kept on, a non-default `agentDir`).
