# DEC-20260808-001: CLI Summon Contract

Opened: 2026-08-08 14-36-01 KST
Recorded by agent: codex-k3

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: heatmap RSH-20260808-001

## Decision

The miniharness invocation contract, fixed across sixteen surfaces. This is
the contract the harness owns; everything else comes from the Pi libraries.

### Output

On success, stdout carries exactly one JSON envelope:

```json
{
  "output": "<assistant text, passed through unvalidated>",
  "session_id": "<session id>",
  "model": "<raw model name as routed>",
  "provider": "<registry provider name>",
  "tokens": {
    "input": 0, "output": 0,
    "cache_read": null, "cache_write": null, "reasoning": null
  },
  "cost_microdollars": null,
  "duration_ms": 0
}
```

`output` is the only guaranteed field; every other field is present but may
be null when the provider does not report it. The token-count field set
matches heatmap's canonical `TokenCounts` shape (input / output /
cache_read / cache_write / reasoning), so the harness's sessions and the
envelope can feed heatmap's accounting layer without a mapping step.

The model's reply is passed through unvalidated. Callers that require a bare
JSON object (heatmap recaps) validate it themselves, as they do today.

stderr carries human-readable errors and diagnostics only. stdout is
machine-clean and empty unless exit 0.

### Exit Codes

- `0` — summon completed; envelope on stdout.
- `1` — summon failed in flight: provider error after retries, refusal,
  truncation, tool failure.
- `2` — bad invocation: unparseable flags, unresolvable provider/model/effort,
  missing or invalid config, missing auth.
- `3` — harness internal failure: crash, session-write failure, invariant
  violation.

### Input

- Prompt: positional argument, or stdin when no positional argument is given
  and stdin is not a TTY (heatmap's day/week prompts are long; argv size is
  not a concern because transcripts are staged to files, but long prompts
  should still be stdin-able).
- System prompt: `--system-prompt <text>` or `--system-prompt-file <path>`,
  with `-` reading stdin. Replaces heatmap's current practice of gluing the
  system prompt onto the front of the user prompt.
- Model selection: three flags matching the opencodex summon shape —
  `--provider <name>`, `--model <name-or-tier>`, `--effort <level>`.
  `--provider` names a provider enrolled in setup's registry
  (`~/.config/providers/registry.json`); `--model` names an explicit model
  id or a registry tier (`haiku`/`sonnet`/`opus`) resolved through that
  provider's tier-map; `--effort` takes a thinking level validated against
  the model's `thinkingLevelMap` in the generated `models.json`
  (off/minimal/low/medium/high/xhigh/max per model; the generated catalogue
  is the authority on what each model supports). Defaults come from the
  provider's `default_model` when flags are omitted.
- Working directory: process cwd by default; `--cwd <path>` overrides
  (heatmap stages transcripts under its work directory and summons there).

### Sessions And Config

- Sessions persist as JSONL at `~/.local/share/miniharness/sessions/` by
  default; `--session-dir <path>` overrides per summon. Sessions are **on by
  default** because heatmap's adoption/recovery join reads them back;
  `--no-session` opts out for one-off summons.
- `models.json` is consumed from `PI_CODING_AGENT_DIR` (setup-managed,
  generated from the canonical registry); `--config-dir <path>` overrides.
- opencode's `--title` is dropped: it was a display label in opencode's
  database that heatmap never reads back; the adoption join keys on the
  staged-transcript path inside the prompt text, which the JSONL session
  preserves.

### Boundaries (What The Harness Does Not Do)

- No harness-side timeout: the caller owns the deadline (heatmap already
  enforces `harness_timeout_seconds` and kills the process).
- No harness-side concurrency cap: the low-teens cap is operating guidance
  for callers, not enforced code.
- No interactive surface, no MCP server, no sub-agents by default (spec
  invariants, restated here for completeness).

## Context

The spec names the invocation contract as the one thing miniharness owns, but
until this record the contract existed only implicitly, encoded in heatmap's
`HarnessCommand` construction (`heatmap/src/recap/mod.rs`). Probing heatmap
for this decision established two facts that shaped the envelope: the recap
path today collects nothing about the summon beyond the assistant text, and
the accounting layer's `TokenCounts` is the fleet's canonical per-summon
usage shape (ingested from claude/codex/opencode session logs). Aligning the
envelope to that shape keeps miniharness a first-class heatmap data source
from day one.

## Options Considered

### Bare Reply Passthrough (No Envelope)

- Upside: the smallest possible contract; heatmap's extraction code
  simplifies to "read stdout".
- Downside: no room for session id or usage without polluting the reply
  itself; every future metadata need becomes a breaking change; sessions
  become the only usage source, which forces a log walk for data the harness
  already had in memory.

### Envelope With Required Metadata

- Upside: guarantees accounting data on every summon.
- Downside: providers differ in what they report; requiring fields the
  provider cannot produce would turn provider gaps into harness failures.

### Envelope, `output` Required, Metadata Optional (Chosen)

- Upside: room for session/usage/timing from the start; nulls absorb
  provider gaps without changing the shape; matches how heatmap's
  `TokenCounts` already treats every count as optional.
- Downside: callers must tolerate nulls — they already do, since heatmap's
  `Option<u64>` counts are the same discipline.

### Provider/Model/Effort Flag Alternatives

- `--profile <name>`: names the registry profile concept directly, but adds
  indirection heatmap does not need and diverges from the summon shape the
  operator already uses in opencodex.
- `--model provider/model` micro-syntax: compact, but invents a syntax setup
  does not use and makes tier resolution ambiguous.

## Rationale

Every choice above either preserves something heatmap already depends on
(prompt-staging adoption join, caller-owned timeout, bare-JSON reply
contract, opencodex provider/model/effort summon shape) or adopts a shape
heatmap's accounting layer already defines as canonical (`TokenCounts`,
reported-cost optionality). The contract is therefore a consolidation of
proven seams, not a new design. The one deliberate improvement is the
first-class `--system-prompt`, which Pi's agent core supports natively and
which removes the prompt-gluing hack from heatmap's summon path.

## Consequences

- `records/SPEC.md` gains a summon-contract section summarizing this record;
  this file remains the canonical statement.
- The build slices (CLI skeleton, session persistence, models.json consumer,
  conformance test) all implement against this contract; the conformance
  test asserts argv-in / envelope-out / exit-code directly from it.
- Heatmap's cutover diff becomes mechanical: swap `opencode run --dir …
  --model … --format json --title heatmap-recap <glued prompt>` for
  `miniharness --provider … --model … --effort … --cwd … --system-prompt-file
  … <prompt>`, and parse one envelope instead of an event stream.
- The setup-side `registry.json → models.json` generator must emit
  `thinkingLevelMap` data good enough to validate `--effort`; until it
  exists, a hand-generated projection from the registry serves as the
  fixture.
- If the contract changes later, a new `DEC-*` supersedes this one; the
  envelope's all-optional-except-`output` rule means additive fields are
  non-breaking.
