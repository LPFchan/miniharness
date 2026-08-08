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

**Status:** scaffold adopted (repo-template 1.1.5); implementation not started.

## Build & smoke

```sh
npm install        # installs the pinned @earendil-works/pi-* dependencies (0.84.1)
npm run build      # compiles src/ -> dist/ with strict TypeScript
npm run smoke      # runs a one-shot summon through the built CLI
```

The CLI reads the prompt from the first positional argument, or from stdin when
no positional argument is given and stdin is not a TTY:

```sh
node dist/cli.js "say hi"
printf 'say hi' | node dist/cli.js
```

On success it prints one JSON envelope to stdout (see
`records/decisions/DEC-20260808-001-cli-summon-contract.md` for the contract);
stderr carries human-readable errors only. Provider credentials come from the
ambient environment (e.g. `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`). When no
provider is configured, the CLI exits 2 with a clear message and the smoke
script skips.
