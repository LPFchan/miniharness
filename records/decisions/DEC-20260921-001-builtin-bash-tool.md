# DEC-20260921-001: Opt-In Built-In Bash Tool

Opened: 2026-09-21 12-30-00 KST
Recorded by agent: claude

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: DEC-20260808-001, DEC-20260809-001

## Decision

Add `--allow-bash`, which exposes Pi's built-in `bash` tool
(`createBashTool()` from `@earendil-works/pi-agent-core`) to the summon.

- **Off by default.** The tool is present only when the caller passes the flag,
  matching how MCP capabilities appear only with `--mcp-server`.
- **Bash only.** Pi also ships `read`, `write`, and `edit`. None are exposed;
  there is no caller for them, and a model with a shell can already reach the
  filesystem.
- **Not an MCP tool.** `--allow-bash` is independent of `--mcp-tool`: the bash
  tool is neither required in that allowlist nor validated against it, and it
  is appended after the MCP merge.
- **Fail closed on collision.** Tool names are the model's lookup key, so a
  configured MCP server already exposing a tool named `bash` is a usage error
  (exit 2), the same discipline `mergeRemoteMcpTools` applies to duplicate MCP
  names.
- **`--cwd` becomes load-bearing.** Commands run in the summon's working
  directory, and that directory is now also what the session header records.

The invocation contract is otherwise unchanged: one envelope on stdout, the
same exit codes, and no tool payload on stderr.

## Context

miniharness has always run Pi's tool-calling loop, but the only way to reach a
tool was an explicit remote Streamable HTTP MCP server. That left a gap for
callers that need the model to inspect the machine it is running on rather than
query a service.

The driving case is LPFchan/setup's `system-updates` module. Its 07:00 reboot
check decided occupancy from `loginctl` alone, so a training run, a serving
process, or anything started by a systemd unit was invisible and got rebooted
out from under. Replacing that rule with a model that investigates the host
needs a shell, not a fixed set of remote queries.

The first design for it put a loopback MCP server in `system-updates`, exposing
one `shell` tool for miniharness to dial. That works, and needs no change here,
but it hand-builds a capability Pi already ships — which is what the "own only
the invocation contract" invariant exists to prevent.

## Options Considered

### Caller-Hosted Loopback MCP Shell Server

- Upside: no change to miniharness at all; the capability stays outside the
  harness, and each caller decides its own tool surface.
- Downside: every caller reimplements JSON-RPC framing, truncation, and
  timeouts for a tool the library already provides. Hand-building an agent
  capability is precisely what the invariants rule out, and the duplication
  would have landed in a Bash module with no test surface for it.

### Built-In Bash Tool, Always On

- Upside: nothing to configure; the tool is simply available.
- Downside: silently grants shell access to every existing caller, including
  heatmap's recap summons, which have no use for it and should not carry the
  risk. Capability-by-default contradicts how MCP attachment already works.

### Built-In Bash Tool, Opt-In (Chosen)

- Upside: uses the maintained library implementation, including its truncation
  and `prepare` seam; leaves every current caller untouched; reads the same way
  as the existing MCP opt-in.
- Downside: moves the harness one step toward a general-purpose agent, which
  the non-goals warn against. Bounded by exposing one tool behind one flag
  rather than a tool framework.

### Exposing read/write/edit Alongside

- Upside: better file handling than shell heredocs for future callers.
- Downside: three tools with no caller, each needing spec coverage and tests.

## Rationale

`createBashTool` is a first-party export of a dependency already pinned and
already imported here; `NodeExecutionEnv` — the `ExecutionEnv` the tool needs —
was likewise already constructed for session I/O. The adaptation is a closure
binding the tool context, because `AgentHarnessTool` is `AgentTool` with a
fifth `context` parameter on `execute`. Nothing about the loop, the envelope,
or the lifecycle vocabulary changes.

Keeping it off by default means the capability is a property of the
invocation, not of the harness, which is the same shape the MCP surface
already has.

## Consequences

- `records/SPEC.md` scope gains built-in tool exposure alongside remote MCP.
- `--cwd` was previously validated and then discarded: all three
  `NodeExecutionEnv` constructions hardcoded `process.cwd()`, and the session
  header recorded the process cwd. Harmless while nothing consumed a working
  directory, wrong as soon as a shell tool exists. `--cwd` now feeds both the
  tool's execution environment and the recorded session cwd.
- The commands a model runs are **not** emitted to stderr: DEC-20260809-001
  keeps tool payloads off the lifecycle stream. The session JSONL is the audit
  trail, so callers that need to know what ran must not pass `--no-session`.
- `tests/bash-tool.test.mjs` covers exposure, a real tool round trip through
  the loop, `--cwd`, nonzero exit handling, and the MCP name collision.
- Exposing further Pi built-ins later is a new DEC, not an extension of this
  one.
