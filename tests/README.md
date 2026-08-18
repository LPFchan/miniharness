# Conformance tests

This suite asserts the miniharness invocation contracts fixed in
DEC-20260808-001, DEC-20260809-001, and DEC-20260819-001 against **any**
`miniharness` binary:
argv/stdin in, one JSON envelope on stdout, lifecycle NDJSON on stderr, and
exit codes 0–3. The binary is spawned from `MINIHARNESS_BIN`.

## Run

```sh
npm test
```

(`node --test tests/*.test.mjs` through the package script.)

## Environment

| Variable | Meaning | Default |
| --- | --- | --- |
| `MINIHARNESS_BIN` | Whitespace-separated command that launches the harness, run with cwd = repo root. | `node dist/cli.js` |
| `MINIHARNESS_LIVE` | When set to anything but `0`/`false`/`no`/empty, live-provider tests run. When unset they skip. | unset |

No live network calls happen while `MINIHARNESS_LIVE` is unset. Validation and
fault-injection tests stop before provider access; lifecycle and compaction
success paths use an offline streaming stub; real-provider input/session tests
skip.

## Contract mapping

| Test | DEC bullet asserted |
| --- | --- |
| default stub success | One stdout envelope; ordered/versioned lifecycle stderr; content-free progress; `done` terminal record |
| overflowing compaction | `finalizing`, content-free compaction start/finish with outcome, then `done`; `--compaction off` emits neither compaction event |
| `--silent` stub success | One stdout envelope; empty success stderr |
| failure under `--silent` | Empty stdout; structured `failed` stderr remains visible |
| unknown flag → exit 2 | Exit code 2; empty stdout; structured usage failure |
| `--provider nope` → exit 2 | Exit codes — 2 (unresolvable provider); Input — model selection |
| `--model nope` → exit 2 | Exit codes — 2 (unresolvable model); Input — model selection |
| missing `--config-dir` → exit 2 | Exit codes — 2 (missing/invalid config); Sessions And Config — `models.json`/`--config-dir` |
| positional vs stdin prompt | Input — prompt (positional, or stdin when no positional and stdin not a TTY) |
| `--system-prompt` / `--system-prompt-file -` | Input — system prompt |
| injected in-flight failure | Exit code 1; empty stdout; structured summon failure |
