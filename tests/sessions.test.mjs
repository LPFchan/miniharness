/**
 * Session persistence tests for DEC-20260808-001 (Sessions And Config).
 *
 * The ungated tests exercise the session seam without any provider:
 *  - an unwritable session dir is a harness-internal failure (exit 3, empty
 *    stdout), failing before any network is touched;
 *  - the adoption-probe stage-key extraction against a fixture JSONL.
 *
 * The summon-with-session tests need a live provider and are gated on
 * `MINIHARNESS_LIVE`, the same pattern as contract.test.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stageKey } from "../scripts/adoption-probe.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

const liveRaw = process.env.MINIHARNESS_LIVE;
const LIVE = liveRaw !== undefined && !["", "0", "false", "no"].includes(liveRaw.toLowerCase());
const LIVE_SKIP = "requires a live provider - set MINIHARNESS_LIVE=1 to run (kept off to avoid network calls)";

/** The command that launches the harness, run with cwd = repo root. */
function harnessCommand() {
  const raw = process.env.MINIHARNESS_BIN ?? "node dist/cli.js";
  return raw.split(/\s+/).filter(Boolean);
}

/** Spawn the harness under test; returns { status, stdout, stderr }. */
function runHarness(args, { input, cwd = REPO_ROOT, env } = {}) {
  const cmd = harnessCommand();
  const res = spawnSync(cmd[0], [...cmd.slice(1), ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: env ?? process.env,
  });
  if (res.status === null) {
    if (res.error?.code === "ENOENT") {
      throw new Error(`harness binary not found (${cmd.join(" ")} in ${cwd})`);
    }
    throw res.error ?? new Error(`harness failed to launch (${cmd.join(" ")} in ${cwd})`);
  }
  if (res.signal) {
    throw new Error(`harness was killed by signal ${res.signal}`);
  }
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function assertSuccessLifecycle(stderr) {
  const records = stderr.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(records[0]?.event, "started");
  assert.equal(records.at(-1)?.event, "done");
}

/** Session files directly under a session dir (the repo layout nests one
 *  cwd-encoded directory per cwd; `--session-dir` becomes the root). */
function sessionFiles(dir) {
  const direct = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => join(dir, e.name));
  const nested = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) =>
      readdirSync(join(dir, e.name), { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith(".jsonl"))
        .map((f) => join(dir, e.name, f.name)),
    );
  return [...direct, ...nested];
}

// ---------------------------------------------------------------------------
// Exit 3 - session-write failure (ungated; must fail before any network)
// ---------------------------------------------------------------------------

test("unwritable session dir exits 3 with empty stdout [DEC Exit Codes: 3 - session-write failure]", () => {
  const { status, stdout, stderr } = runHarness([
    "--session-dir",
    "/proc/self",
    "Reply with the single word ok.",
  ]);
  assert.equal(status, 3, `session-write failure must exit 3 (got ${status}); stderr: ${stderr}`);
  assert.equal(stdout, "", "stdout must be machine-clean and empty unless exit 0");
  const failed = JSON.parse(stderr.trim().split("\n").at(-1));
  assert.equal(failed.event, "failed");
  assert.equal(failed.exit_code, 3);
});

// ---------------------------------------------------------------------------
// Adoption-probe stage-key extraction (ungated; fixture-driven)
// ---------------------------------------------------------------------------

test("adoption probe extracts the 64-hex stage key from a session prompt", () => {
  const prompt =
    "You are a recap generator. Read the staged transcript at " +
    "/home/yeowool/heatmap/work/2026-08-08/session/" +
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789/transcript.txt " +
    "and produce a JSON recap.";
  assert.equal(
    stageKey(prompt),
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "must extract the 64-hex blake3 stage key",
  );
  assert.equal(stageKey("read the file please"), null, "no staged path -> null");
  assert.equal(
    stageKey("read /x/session/nothex/transcript.txt please"),
    null,
    "non-hex key -> null (adopt.rs requires 64 hex digits)",
  );
});

// ---------------------------------------------------------------------------
// Summon session persistence - live-gated (needs a real provider)
// ---------------------------------------------------------------------------

test(
  "summon with --session-dir writes a JSONL session and reports a non-null session_id",
  { skip: LIVE_SKIP },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "miniharness-sessions-"));
    const { status, stdout, stderr } = runHarness([
      "--session-dir",
      dir,
      "Reply with the single word ok.",
    ]);
    assert.equal(status, 0, `summon must exit 0 (got ${status}); stderr: ${stderr}`);
    assertSuccessLifecycle(stderr);
    const env = JSON.parse(stdout);
    assert.equal(typeof env.output, "string");
    assert.ok(env.session_id !== null && typeof env.session_id === "string" && env.session_id.length > 0,
      "session_id must be a non-empty string when sessions are on");
    const files = sessionFiles(dir);
    assert.ok(files.length >= 1, `expected at least one .jsonl session file in ${dir}`);
    const contents = files.map((f) => readFileSync(f, "utf8"));
    assert.ok(
      contents.some((c) => c.includes(env.session_id)),
      "session file must carry the envelope session_id",
    );
  },
);

test("summon with --no-session writes nothing and reports a null session_id", { skip: LIVE_SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), "miniharness-nosession-"));
  const { status, stdout, stderr } = runHarness(
    ["--no-session", "Reply with the single word ok."],
    { env: { ...process.env, MINIHARNESS_SESSION_DIR: dir } },
  );
  assert.equal(status, 0, `summon must exit 0 (got ${status}); stderr: ${stderr}`);
  assertSuccessLifecycle(stderr);
  const env = JSON.parse(stdout);
  assert.equal(env.session_id, null, "session_id must be null with --no-session");
  assert.deepEqual(sessionFiles(dir), [], "--no-session must not write any session file");
});
