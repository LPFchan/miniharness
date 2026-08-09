# RSH-20260809-001: Summon Lifecycle Observability

Opened: 2026-08-09 07-26-42 KST
Recorded by agent: codex-sol

## Question

Can miniharness expose enough live state for heatmap to distinguish a slow,
active summon from a stalled one before the caller's 600-second deadline, while
preserving the one-envelope summon contract?

Source pressure: operator-relayed agent feedback described the current summon
as a black box and proposed lifecycle events such as `started`,
`model_connected`, `tokens_streaming`, `tool_call`, and `done`, emitted on
stderr or a sidecar socket.

## Conclusion

The request is well-founded and mostly cheap. The pinned Pi agent library
already emits the model- and tool-loop events miniharness needs through
`Agent.subscribe()`. Miniharness can project those events into a small,
versioned lifecycle protocol without owning a second agent loop or changing
the final stdout envelope.

Two limits matter:

1. Lifecycle events improve diagnosis but do not prove liveness. A summon can
   remain in `awaiting_response` because the provider is legitimately slow or
   because the request is stuck. Time-to-first-output, last-activity time, and
   the caller's existing deadline remain necessary.
2. Pi's provider retries are currently invisible at the `Agent` event layer.
   Miniharness can truthfully expose `awaiting_response` and `streaming`, but it
   cannot expose `retrying` without a new retry callback in `pi-ai` or a less
   desirable harness-owned retry implementation.

The smallest useful first iteration is a **default NDJSON lifecycle stream on
stderr**, with `--silent` suppressing lifecycle and progress events for callers
that require empty success stderr. Use state transitions rather than forwarding
raw token content, and defer a sidecar socket until a real multi-process
transport need appears.

## Existing Seams

The current summon creates one `Agent`, calls `agent.prompt()`, waits for idle,
then inspects the final assistant message and writes one JSON envelope to
stdout. It does not subscribe to the agent.

In `@earendil-works/pi-agent-core` 0.84.1, `Agent.subscribe()` exposes:

- `agent_start` / `agent_end`
- `turn_start` / `turn_end`
- `message_start` / `message_update` / `message_end`
- `tool_execution_start` / `tool_execution_update` /
  `tool_execution_end`

Each `message_update` contains Pi's underlying assistant-message event,
including `text_delta`, `thinking_delta`, `toolcall_start`, `toolcall_delta`,
`toolcall_end`, `done`, and `error`. This is enough to identify the first
response activity, the first streamed output, tool-call receipt, tool
execution, and agent completion. Miniharness currently supplies no tools, so
tool events are dormant today but would make the protocol forward-compatible
with the explicit tool extension already allowed by the spec.

Pi also accepts `onResponse`, called after an HTTP response arrives and before
its body is consumed. That hook is useful as optional transport evidence, but
it should not define a provider-neutral `model_connected` state: it is
HTTP-specific, transport implementations differ, and receipt of response
headers is not the same thing as a durable model connection. Provider-neutral
names such as `request_started`, `response_started`, and `streaming_started`
are more accurate.

The lower-level `retryProviderRequest()` implements 408/409/429/5xx and
transport-error retries, including `retry-after`, but its public options expose
no retry callbacks. Failed attempts and backoff sleeps therefore happen before
the successful stream reaches `Agent.subscribe()`.

## Recommended Lifecycle Model

Heatmap needs a state model, not a mirror of every Pi event. A useful projection
is:

| Event | Source | Meaning |
| --- | --- | --- |
| `started` | miniharness CLI | Event mode is active and the summon entered the harness. |
| `request_started` | Pi `turn_start` | An agent turn is beginning and a provider response is awaited. |
| `response_started` | first Pi assistant stream event | The provider stream has produced protocol activity; this is the portable replacement for `model_connected`. |
| `streaming_started` | first non-empty text or thinking delta | The model is producing content. Emit once per turn. |
| `progress` | throttled text/thinking/tool deltas | Activity continues; report counts only, never prompt, reasoning, or output content. |
| `tool_call` | Pi `toolcall_end` | A complete tool request was received. Include tool name and call id, but omit arguments by default. |
| `tool_started` | Pi `tool_execution_start` | The requested tool began executing. |
| `tool_finished` | Pi `tool_execution_end` | The tool finished; include success/error state but not result content. |
| `finalizing` | miniharness CLI | The agent ended; compaction, session persistence, and envelope construction remain. |
| `done` | miniharness CLI | Finalization succeeded and the success envelope is ready. |
| `failed` | miniharness CLI | The summon is terminating unsuccessfully; include the existing exit-code class and a safe error summary. |

`progress` should be coalesced (for example, at most once per second) and carry
monotonic counters such as delta count and generated text/reasoning bytes.
Forwarding every token delta would increase pipe traffic across 8–16 workers,
leak model content into orchestration logs, and give heatmap detail it does not
need. A transition-only stream is also insufficient: a long generation could
otherwise show no new activity after `streaming_started`.

Each event should carry at least:

```json
{"protocol":"miniharness.lifecycle","version":1,"seq":3,"event":"streaming_started","timestamp":"2026-08-09T07:30:00.000+09:00","elapsed_ms":842}
```

- `protocol` and `version` prevent diagnostics or future formats from being
  mistaken for lifecycle data.
- `seq` provides per-process ordering independent of wall-clock adjustments.
- `timestamp` permits cross-worker aggregation.
- `elapsed_ms` makes phase timing cheap and monotonic.
- Provider, model, turn, tool-call id, counters, and failure class are optional
  event-specific fields.
- Prompt text, assistant deltas, reasoning text, tool arguments/results,
  credentials, and provider response headers should not be emitted.

The child process already supplies correlation: heatmap owns the process handle
and its stderr pipe. If events are later aggregated outside that relationship,
add a caller-provided correlation id rather than treating the PID as durable
identity.

## Transport Options

### Default stderr NDJSON (recommended first)

Lifecycle records are one JSON object per stderr line by default. `--silent`
suppresses lifecycle and progress events but never suppresses failure
diagnostics. Stdout continues to contain exactly one success envelope.

Advantages:

- heatmap already captures each child's stderr;
- no socket lifecycle, permissions, naming, reconnect, or cleanup;
- natural backpressure and ownership per summon;
- easy to exercise in the existing subprocess conformance tests.

Costs and contract effect:

- DEC-20260808-001 says stderr carries human-readable diagnostics only, and the
  conformance suite asserts empty stderr on success. Default lifecycle output
  therefore requires an explicit contract revision.
- Miniharness-authored stderr lines should be structured protocol records,
  including `failed`; callers should still tolerate unstructured runtime output
  from failures below miniharness. Under `--silent`, failure records remain
  visible.
- Heatmap must drain stderr concurrently with stdout/process waiting so a busy
  pipe cannot block the child.
- Coalesced `progress` records may be dropped under stderr backpressure. State
  transitions are small and must not be dropped.

### Dedicated inherited file descriptor

An event fd would keep stderr human-readable and the event stream mechanically
pure. It is attractive in isolation, but passing and managing an extra fd from
Rust is more work than using the already-captured stderr pipe. It is a sensible
second transport if mixed stderr proves operationally awkward.

### Unix sidecar socket

A socket can multiplex many summons into one observer and decouple observation
from the spawning process. For heatmap's current parent-child topology it also
introduces socket discovery, permissions, correlation ids, connect races,
buffering, stale socket cleanup, and behavior when the observer disappears.
Those costs are not justified for the first implementation.

### Rewriting stdout as an event stream

Rejected. Heatmap and DEC-20260808-001 depend on stdout containing exactly one
success envelope. Turning it into NDJSON would break the invocation contract
for every caller and blur progress events with the result.

## Retry Visibility Gap

The desired dashboard example includes workers shown as `retrying`. That state
cannot be derived reliably from elapsed time or repeated `turn_start` events:
provider-request retries occur inside one Pi stream request, below the agent
loop.

Preferred route: add retry lifecycle callbacks to the maintained `pi-ai`
provider-retry seam and have provider adapters propagate attempt number,
backoff duration, and a sanitized reason. Miniharness could then map those to
`retry_scheduled` and `retry_started` without owning retry policy. This follows
the project invariant that Pi, not miniharness, owns resilient retry.

Rejected route: disable Pi retries and recreate them around the miniharness
stream function. That duplicates provider-specific behavior, risks changing
abort and `retry-after` semantics, and makes the invocation wrapper responsible
for a library concern the spec explicitly delegates upstream.

Until the upstream seam exists, heatmap should display `awaiting_response`
rather than infer `retrying`. An honest coarse state is more useful than a
precise-looking false one.

## What Heatmap Could Diagnose

With the first iteration, a 16-worker run could report, for example:

- 10 `streaming` with recent progress;
- 3 `awaiting_response` with their time-to-first-byte clocks visible;
- 1 `tool_running`;
- 2 `finalizing` session output.

It could identify a process that never emitted `started`, compare
time-to-response across providers/models, and show which workers continue to
make output progress. After retry callbacks land, it could separately show
provider backoff.

It still could not prove that a quiet `awaiting_response` request is hung.
Heatmap should retain the 600-second hard deadline and may add a softer
"suspected stall" threshold based on phase and last activity. Miniharness
should not acquire a harness-side timeout; caller deadline ownership remains
the right boundary.

## Follow-up Route

1. Implement the lifecycle contract fixed by DEC-20260809-001.
2. Prototype the Pi-event projection with an offline stub stream and test
   transition ordering, progress throttling, failure paths, pipe draining, and
   that `--silent` invocations have empty success stderr.
3. Add heatmap consumption as a separate integration change: continuously
   parse the child's lifecycle stderr and maintain one state/timestamp record
   per summon.
4. Pursue retry callbacks upstream in `pi-ai`; do not label workers `retrying`
   until there is a truthful signal.
5. Revisit an event fd or sidecar socket only if stderr mixing or a non-parent
   observer becomes a demonstrated requirement.

## Remaining Open Questions

- Will the Pi maintainers accept retry callbacks in the shared provider-retry
  helper and propagate them across every provider transport heatmap uses?
- Will a non-parent observer eventually require a caller-provided correlation
  id or sidecar transport?
