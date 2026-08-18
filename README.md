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

**Status:** summon envelope, OAuth reuse, lifecycle, persisted sessions, and
explicit remote MCP tools are implemented (`npm install && npm run build && npm
test`); see
`records/STATUS.md`.

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
`--no-system-prompt` (send no system prompt; Miniharness fails closed for Pi
adapters that inject their own instruction when the prompt is empty),
`--gen-params '<inline JSON object>'` (supported fields only:
`temperature`, `max_tokens`, `seed`, `top_p`, and `stop`),
`--cwd <path>` (must exist and be a directory), `--session-dir <path>`,
`--resume <session-id>`, `--purpose <identifier>`, repeatable
`--mcp-server <label>=<url>`, repeatable `--mcp-tool <name>`, `--no-session`,
`--compaction <off|auto>` (default `auto`: when a completed transcript would
overflow the model's context window, the library's compaction summarizes the
history and records the compaction entry in the session JSONL; the envelope is
unchanged), `--config-dir <path>` (override for the directory holding
`models.json`; default is `PI_CODING_AGENT_DIR` or `~/.pi/agent/`), `--silent`
(suppress lifecycle/progress events; failures remain), and `--help`.

`--version` prints the package version and exits before reading config or
opening a session. `--no-system-prompt` is mutually exclusive with the two
supplied system-prompt forms. `--gen-params` is one inline JSON object (not a
file, stdin, or `@` reference), capped at 16 KiB UTF-8. Its numbers must be
finite and in their API-defined ranges: `temperature >= 0`, positive safe
integer `max_tokens`, non-negative safe integer `seed`, and `0 < top_p <= 1`.
`stop` may be one string up to 256 UTF-8 bytes or up to 16 strings (2 KiB total,
each at most 256 bytes). `seed`, `top_p`, and `stop` require a resolved Pi API
that forwards sampling parameters (`openai-completions`, `openai-responses`, or
`azure-openai-responses`). These options affect only the current invocation;
they are not persisted or inherited by `--resume`.

Sessions are saved as Pi JSONL files by default. Pass `--resume <session-id>`
with the same session directory to continue an existing conversation. The
session is opened and its existing branch is reconstructed by Pi, then the
new user/assistant turn is appended to that same file; the success envelope
reports the same `session_id`. Resuming an unknown, malformed, or unsafe id is
a usage error (exit 2). `--resume` cannot be combined with `--no-session`.
New sessions are created before provider setup and reported immediately as a
`session_started` lifecycle event. A supplied system prompt may contain
`{session_id}`; Miniharness replaces it with the opened id before inference.
The token requires session persistence.

### Remote MCP tools

Attach an explicit, read-only Streamable HTTP MCP server and allow only the
Heatmap tools needed by the caller:

```sh
miniharness \
  --provider "$PROVIDER" --model "$MODEL" --effort low \
  --purpose chat_sidebar \
  --mcp-server heatmap=http://127.0.0.1:8777/mcp \
  --mcp-tool query_activity \
  --mcp-tool query_cost \
  "How did my activity change this week?"
```

`--mcp-server` and `--mcp-tool` may be repeated. The explicit tool list is a
complete allowlist across all configured servers: every requested name must be
available, and duplicate exposed names are rejected before the model starts.
Plain HTTP MCP URLs are allowed only for loopback hosts; use HTTPS for a
non-loopback endpoint. MCP URLs must not contain username or password
credentials. `--purpose` is stored in the session metadata and therefore
requires a session; it cannot be combined with `--no-session`.

```sh
node dist/cli.js "say hi"
printf 'say hi' | node dist/cli.js
```

On success it prints one JSON envelope to stdout (see
`records/decisions/DEC-20260808-001-cli-summon-contract.md` for the contract);
stderr emits versioned lifecycle NDJSON by default (DEC-20260809-001):
`started`, request/response/streaming transitions, content-free coalesced
`progress`, tool transitions, `finalizing`, `compaction_started`,
`compaction_finished` (with only `outcome: completed|failed`), then `done`.
The compaction pair appears only around an actual compaction model call. Every
record carries `protocol`, `version`, `seq`, `timestamp`, and `elapsed_ms`.
`--silent` restores empty stderr on success; structured `failed` records remain
visible.
Callers should drain stderr concurrently and must not expect prompt, response,
reasoning, tool payload, credential, or provider-header content there.

Provider credentials: providers Pi ships as builtins use the ambient
environment (e.g. `ANTHROPIC_API_KEY`);
registry providers Pi does not ship (crofai, grimoire, kimicode, …) are
registered as OpenAI-compatible endpoints whose keys resolve from the
operator's auth store (`~/.local/share/opencode/auth.json`, the same seam
setup writes for opencode auth; `MINIHARNESS_AUTH_FILE` overrides for tests).
Cloudflare's OpenAI-compatible endpoint is read as a completed response and
adapted into Pi's event stream. This avoids stalled post-tool SSE responses
without changing Miniharness's stdout envelope or the behavior of other
providers.
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
structured `failed` record and exit code 1. This exercises the DEC's exit-1
path without credentials or a network. It is a test-only hook, not part of the
invocation contract; the conformance suite and `tests/cli.test.mjs` rely on it.
