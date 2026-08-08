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
