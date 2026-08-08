# Conformance tests

This suite asserts the miniharness invocation contract fixed in
`records/decisions/DEC-20260808-001-cli-summon-contract.md` against **any**
`miniharness` binary: argv/stdin in, one JSON envelope out, exit codes 0-3.
It is written against the contract, not against the implementation — the
binary is spawned from `MINIHARNESS_BIN` and the tests go green as the build
slices land.

## Run

```sh
npm test
```

(`node --test tests/` — Node's built-in test runner; no dependencies, no
install step.)

## Environment

| Variable | Meaning | Default |
| --- | --- | --- |
| `MINIHARNESS_BIN` | Whitespace-separated command that launches the harness, run with cwd = repo root. | `node dist/cli.js` |
| `MINIHARNESS_LIVE` | When set to anything but `0`/`false`/`no`/empty, live-provider tests run. When unset they skip. | unset |

No live network calls happen while `MINIHARNESS_LIVE` is unset: every exit-2
test fails before any summon happens (unparseable flag, unresolvable
provider/model, missing config), and the success/input-path tests skip.

## Expected state before the CLI skeleton lands

The implementation does not exist yet. In a clean checkout:

- success / input-path tests **skip** (no `MINIHARNESS_LIVE`);
- the exit-2 (bad invocation) tests **fail** — `dist/cli.js` does not exist,
  so the spawned command cannot produce the contract behavior; that failure
  is the gate for slices A/E and is expected until they land;
- the exit-1 test is **todo** (see below).

`npm test` therefore exits non-zero until the CLI skeleton lands.

## Exit-1 note (todo)

The contract's exit 1 is "summon failed in flight" (provider error after
retries, refusal, truncation, tool failure). There is no contract-defined
way to force that from the CLI today: an unresolvable model is rejected
before the summon (exit 2), and the DEC defines no fault-injection hook. The
test is `todo` with that explanation rather than faked; it becomes a normal
test when the contract (or a test hook) offers a clean way to force exit 1.

## Test → DEC-20260808-001 mapping

| Test | DEC bullet asserted |
| --- | --- |
| success: trivial prompt → envelope | Output — success envelope (`output` required, metadata nullable, `tokens` = TokenCounts shape); Exit codes — 0; stderr empty on success |
| unknown flag → exit 2 | Exit codes — 2 (unparseable flags); Output — stdout machine-clean; stderr carries the error |
| `--provider nope` → exit 2 | Exit codes — 2 (unresolvable provider); Input — model selection |
| `--model nope` → exit 2 | Exit codes — 2 (unresolvable model); Input — model selection |
| missing `--config-dir` → exit 2 | Exit codes — 2 (missing/invalid config); Sessions And Config — `models.json`/`--config-dir` |
| positional vs stdin prompt | Input — prompt (positional, or stdin when no positional and stdin not a TTY) |
| `--system-prompt` / `--system-prompt-file -` | Input — system prompt |
| in-flight failure → exit 1 (todo) | Exit codes — 1 (in-flight failure) |
