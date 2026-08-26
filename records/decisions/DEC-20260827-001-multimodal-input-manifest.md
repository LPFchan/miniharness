# DEC-20260827-001: Add A Strict Local Multimodal Input Manifest

Opened: 2026-08-27 05-19-43 KST
Recorded by agent: codex

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: DEC-20260808-001, DEC-20260818-001

## Decision

Add an additive `--input-manifest <path>` invocation form. The manifest is
protocol version 1 and contains a non-empty ordered `parts` array. A text part
is `{ "type": "text", "text": "..." }`. An image part is
`{ "type": "image", "path": "/absolute/local/file", "media_type":
"image/png"|"image/jpeg", "sha256": "<lowercase hex>" }`.

The parser rejects unknown fields, malformed JSON, unsupported versions,
empty parts or text, URLs and data URIs, symlinks and non-regular files,
empty images, media/signature mismatches, and digest mismatches. It reads and
validates every part before session or provider setup. Valid image bytes are
base64-encoded into Pi's ordered user `AgentMessage`; the existing stdout
envelope, lifecycle protocol, session ownership, and provider routing remain
unchanged.

The manifest is mutually exclusive with both positional and stdin prompt
sources. A system prompt remains independently selectable through the existing
system-prompt flags.

## Context

Artmu-bench needs to send reference images as model inputs through the shared
headless harness. A description of an image is not equivalent to image content,
and a provider-specific wrapper would duplicate routing and retry behavior that
belongs to Pi. Pi's Agent API accepts a complete `AgentMessage`, which carries
mixed text/image content in order.

## Options Considered

### Add A Separate Image-Only CLI Flag

- Downside: it cannot represent a stable ordered multimodal message and would
  require ad-hoc prompt assembly.

### Accept A Strict Local Manifest (chosen)

- Upside: one versioned input contract represents ordered text and images.
- Upside: local files, signatures, media types, and digests are checked before
  any side effect that could create a session or contact a provider.
- Upside: Pi receives actual bytes while retaining ownership of model routing.

### Embed Remote URLs Or Data URIs

- Downside: input would leave the local boundary or bypass the file digest
  check, making reproducibility and authorization unclear.

## Rationale

The manifest is the smallest additive protocol that supplies exact multimodal
content while preserving the existing prompt and output contracts. Strict
local validation makes malformed or mutable inputs fail before invocation
state is created. Passing the complete AgentMessage preserves arbitrary part
ordering without an additional transport abstraction.

## Consequences

- Artmu-bench can provide canonical ordered text/image inputs through
  miniharness.
- Session JSONL may retain the resulting Pi message, including image content,
  as part of the existing transcript format.
- Model capability and reasoning preflight remain caller-owned; miniharness
  only transports the validated message.
- Future manifest versions require an explicit protocol decision and should
  remain additive to this version.
