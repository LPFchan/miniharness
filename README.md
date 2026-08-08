# miniharness

A minimal coding-agent harness for **agent CLI invocation only** — no interactive
surface. It summons a model for headless work (heatmap's recap generation is the
driving case) and returns a single structured JSON result.

Thin on purpose: it sits on Pi's agent libraries
(`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`) and owns only the
invocation contract — argv/env in, one JSON document out, meaningful exit code.

See `records/SPEC.md` for the canonical spec and `records/REPO.md` for how this
repo operates. Origin research: heatmap
`records/research/RSH-20260808-001-miniharness-opencode-replacement.md`.

**Status:** DEC-20260808-001 summon contract implemented and live-verified
(`npm install && npm run build && npm test`); see `records/STATUS.md`.

## Install & prerequisite

```sh
npm install -g miniharness
miniharness --help
```

The CLI consumes a generated `models.json` (provider enrollment, tiers, and
per-model capability data) from `--config-dir`, else `PI_CODING_AGENT_DIR`,
else `~/.pi/agent/`. That file is a projection of the operator's canonical
provider registry (LPFchan/setup); on a machine without it the CLI installs
fine but exits 2 until a config exists.

## Build & smoke

```sh
npm install        # installs the pinned @earendil-works/pi-* dependencies (0.84.1)
npm run build      # compiles src/ -> dist/ with strict TypeScript
npm run smoke      # runs a one-shot summon through the built CLI
```

The CLI reads the prompt from the first positional argument, or from stdin when
no positional argument is given and stdin is not a TTY. The full invocation
surface is fixed by `records/decisions/DEC-20260808-001-cli-summon-contract.md`:

```sh
node dist/cli.js --provider kimicode --model sonnet --effort low "say hi"
node dist/cli.js --system-prompt "You are terse." "say hi"
printf 'say hi' | node dist/cli.js
```

Flags: `--provider <name>`, `--model <id-or-tier>` (`haiku`/`sonnet`/`opus`),
`--effort <level>`, `--system-prompt <text>`, `--system-prompt-file <path>`
(`-` = stdin; stdin serves either the prompt or the system prompt, not both),
`--cwd <path>` (must exist and be a directory), `--session-dir <path>`,
`--no-session`, `--compaction <off|auto>` (default `auto`: when a completed
transcript would overflow the model's context window, the library's compaction
summarizes the history and records the compaction entry in the session
JSONL; the envelope is unchanged), `--config-dir <path>` (override for the
directory holding `models.json`; default is `PI_CODING_AGENT_DIR` or
`~/.pi/agent/`), and `--help`.

```sh
node dist/cli.js "say hi"
printf 'say hi' | node dist/cli.js
```

On success it prints one JSON envelope to stdout (see
`records/decisions/DEC-20260808-001-cli-summon-contract.md` for the contract);
stderr carries human-readable errors only. Provider credentials: providers Pi
ships as builtins use the ambient environment (e.g. `ANTHROPIC_API_KEY`);
registry providers Pi does not ship (crofai, grimoire, kimicode, …) are
registered as OpenAI-compatible endpoints whose keys resolve from the
operator's auth store (`~/.local/share/opencode/auth.json`, the same seam
setup writes for opencode auth; `MINIHARNESS_AUTH_FILE` overrides for tests).
The `anthropic` and `codex` providers can instead run on the operator's
existing CLI subscription logins (DEC-20260808-002): when
`~/.claude/.credentials.json` or `~/.codex/auth.json` holds OAuth tokens,
miniharness reuses them, refreshes through pi-ai, and writes rotated tokens
back to the same files (`MINIHARNESS_CLAUDE_CREDENTIALS_FILE` /
`MINIHARNESS_CODEX_AUTH_FILE` override for tests).
When no provider is configured, the CLI exits 2 with a clear message and the
smoke script skips.

### Test-only fault-injection hook

`MINIHARNESS_FAIL_AFTER=provider-connect` makes a summon fail mid-flight —
after invocation validation, before the provider is contacted — with a marked
stderr diagnostic and exit code 1. This exercises the DEC's exit-1 path without
credentials or a network. It is a test-only hook, not part of the invocation
contract; the conformance suite and `tests/cli.test.mjs` rely on it.
