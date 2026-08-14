# miniharness Spec

This file is the canonical statement of what the project is supposed to be.
Keep it durable. Do not use it as a changelog, inbox, or weekly narrative.

## Seed Fields

- Project: miniharness
- Canonical repo: `LPFchan/miniharness` (private)
- Project id: `miniharness`
- Operator: LPFchan
- Last updated: 2026-08-14
- Related decisions: DEC-20260808-001, DEC-20260808-002,
  DEC-20260809-001, DEC-20260814-001
- Origin research: heatmap `records/research/RSH-20260808-001-miniharness-opencode-replacement.md`

## Project Thesis

A minimal coding-agent harness for **agent CLI invocation only** — no
interactive surface. It summons a model for headless work (heatmap's recap
generation is the driving case) and returns a single structured result.

The build is thin on purpose: it sits on Pi's agent libraries and owns only
the invocation contract. The expensive, boring parts — multi-provider routing,
per-model capability/effort catalogue, resilient retry — come from the
library, not from hand-rolled code.

## Primary Operator Context

One operator, many agents. Heatmap summons a recap generator per session/day/
week scope. The harness replaces `opencode run` in that path
(`heatmap/src/recap/mod.rs`) and any other headless CLI call.

## Core Capabilities

- Headless summon: argv/env in, one JSON envelope out, meaningful exit code
  (contract fixed by DEC-20260808-001).
- Default summon lifecycle: versioned NDJSON state transitions and coalesced
  progress on stderr, with `--silent` suppressing lifecycle output while
  preserving failure diagnostics (DEC-20260809-001).
- Provider/model/effort selection driven by a generated `models.json`,
  projected from the operator's canonical registry
  (`~/.config/providers/registry.json`, LPFchan/setup).
- Subscription OAuth reuse: the `anthropic` and `codex` providers run on
  the operator's existing Claude Code / Codex CLI logins, with refresh
  write-back to the CLI files (DEC-20260808-002).
- Resilient retry (408/409/429/5xx, honour `retry-after`).
- Tool and MCP support, but **no MCP server and no sub-agents by default**;
  both reachable only through explicit extension.
- Absolutely minimal system prompt and resource footprint.
- 8–16 concurrent instances, concurrency capped in the low teens.
- Session persistence as JSONL at a harness-owned path, so heatmap's
  adoption/recovery join survives without a database.
- Same-file session resumption by stable session id for bounded caller-driven
  correction workflows.
- Compaction support.

## Invariants

- **No interactive surface.** No TUI, themes, slash-commands, or REPL. CLI
  invocation only.
- **No database.** Durable state is JSONL session files plus generated config.
  A very ephemeral store only, if ever, for audit.
- **Own only the invocation contract.** The agent loop, model catalogue, and
  retry layer are library dependencies (`@earendil-works/pi-agent-core`,
  `@earendil-works/pi-ai`), not hand-built.
- **Setup's registry is the source of truth** for provider enrollment;
  `models.json` is generated from it, never hand-edited as canonical.
- **Build on maintained libraries; fork nothing.** Adopt only code with an
  active upstream and a real contributor base.

## Non-goals

- Interactive daily runtime (separate, already settled — the operator's
  existing harnesses).
- Recap latency optimization (rejected 2026-08-05: model tokens dominate
  wall-clock, the wrapper is noise).
- Being a fork of opencode, pi, or pi_agent_rust.
- A general-purpose agent platform.

## Main Surfaces

- CLI entrypoint (the summon contract, see below).
- Generated `models.json` (consumed, not authored here).
- JSONL session directory (recovery/audit surface for heatmap `adopt`).
- Distribution: the `miniharness` package on npmjs (`npm install -g
  miniharness`), published from this repo with a `files: [dist]` whitelist
  and a `prepublishOnly` build+test gate.

## Summon Contract

Fixed by `records/decisions/DEC-20260808-001-cli-summon-contract.md`; that
record is canonical. Summary:

- **Output**: one JSON envelope on stdout — `output` (assistant text,
  passed through unvalidated) plus optional `session_id`, `model`,
  `provider`, `tokens` (heatmap's `TokenCounts` shape), `cost_microdollars`,
  `duration_ms`. stderr carries versioned NDJSON lifecycle events by default;
  `--silent` suppresses lifecycle/progress events but not failures.
- **Exit codes**: 0 success / 1 summon failed in flight / 2 bad invocation /
  3 harness internal. stdout empty unless 0.
- **Input**: prompt positional or via stdin; `--system-prompt` /
  `--system-prompt-file` (first-class, replacing heatmap's prompt-gluing);
  `--provider` / `--model` / `--effort` selection resolved through setup's
  registry and the generated `thinkingLevelMap`; cwd defaults to the process
  cwd with a `--cwd` override.
- **Sessions**: JSONL at `~/.local/share/miniharness/sessions/` by default,
  on by default (heatmap's adoption join reads them), `--no-session` opts
  out, `--session-dir` overrides. `--resume <session-id>` reconstructs an
  existing Pi conversation from that directory, appends one new turn to the
  same JSONL file, and returns the same id; unknown or unsafe ids are usage
  errors, and resumption cannot be combined with `--no-session`.
- **Config**: `models.json` consumed from `PI_CODING_AGENT_DIR`
  (setup-managed), `--config-dir` override.
- **Boundaries**: no harness-side timeout (caller owns the deadline), no
  harness-side concurrency cap (low-teens is operating guidance), opencode's
  unread `--title` label dropped.

## Success Criteria

- A heatmap recap summon runs end-to-end through miniharness instead of
  `opencode run`, emitting the same single-JSON-object contract.
- 16 concurrent summons stay within the host's memory envelope (see research:
  Node tax ~150–184 MB/instance; low-teens cap).
- Failed/truncated summons remain recoverable via the JSONL adoption path.
