# Upstream Intake Scope

This module is **enabled**. The tracked upstream is the Pi agent libraries this
harness builds on, consumed as npm packages — not a fork's source repo.

## Tracked Upstream

- Packages: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`.
- Source repo: `earendil-works/pi` (GitHub).
- Review unit: an upstream release tag against the version this repo pins,
  per `intake-method.md` (candidate decisions, not per-commit changelogs).

## Compatibility-Sensitive Seams (standing, feeds the watchlist)

These are the Pi contracts miniharness depends on; any change here is a
candidate decision, never a silent upgrade:

- **Agent API** — `Agent` construction, `subscribe()` / `AgentEvent` shapes,
  `prompt()`, `waitForIdle()`, `abort()`, and `state.messages`, as consumed by
  `src/cli.ts`; `AgentMessage` shapes, including multimodal input prepared by
  `src/input-manifest.ts`.
- **Session JSONL layout** — `JsonlSessionRepo`'s persisted format under the
  harness-configured session root: `--session-dir`, then
  `MINIHARNESS_SESSION_DIR`, then `~/.local/share/miniharness/sessions/`.
  Heatmap's adoption/recovery join depends on these durable sessions.
- **Node/session APIs** — `JsonlSessionRepo`, `Session`, `NodeExecutionEnv`,
  and `buildSessionContext`: session creation, discovery, resumption,
  metadata, message/entry append, log reads, and filesystem cleanup in
  `src/cli.ts`.
- **Compaction and tool contracts** — `estimateContextTokens`,
  `shouldCompact`, `prepareCompaction`, `compact`, `Entry` / `CompactionEntry`, and
  `DEFAULT_COMPACTION_SETTINGS`; `createBashTool` and the `AgentTool` /
  `AgentToolResult` / `BashToolInput` shapes consumed by `src/cli.ts` and
  `src/mcp.ts`.
- **Model catalogue and reasoning schema** — Pi's `Model` fields and
  `ModelThinkingLevel` / `ThinkingLevelMap`, plus `getSupportedThinkingLevels`;
  merging the built-in catalogue with generated `models.json`, including
  `thinkingLevelMap`, in `src/config.ts`, and native reasoning-payload
  adaptation in `src/grimoire.ts`.
- **Output and usage accounting** — `contentText()`, the `Usage` token/cost
  fields, and `calculateCost()` used by `src/cli.ts` to construct the public
  success envelope's output, token counts, and microdollar cost.
- **Provider transport and credentials** — Pi's model/provider registration,
  `Models` / `MutableModels` / `Api`, streaming and `FetchFunction` contracts,
  and `CredentialStore` credential/operation shapes for CLI OAuth reuse in
  `src/config.ts`, `src/cli-oauth.ts`, and `src/cli.ts`; review upstream retry
  changes against these call sites and the completed-response adapter in
  `src/cloudflare.ts`, plus `createAssistantMessageEventStream` in the
  provider test stubs.
- **Config-path contract** — generated `models.json` from `--config-dir`,
  then `PI_CODING_AGENT_DIR`, then `~/.pi/agent/`, as resolved by
  `src/config.ts`.

## Posture

miniharness does not fork Pi and carries no local patches to merge. Intake is
therefore about **when to bump the pinned version and what to adapt**, not
about resolving fork/upstream conflicts. `known-local-overrides.md` stays
nearly empty by design; it records only intentional divergences from a Pi
default (e.g. sessions kept on, a harness-owned session root).
