/**
 * Conformance suite for DEC-20260808-001 (CLI Summon Contract).
 *
 * Asserts the invocation contract — argv/stdin in, one JSON envelope out,
 * exit codes 0-3 — against ANY miniharness binary. Written against the
 * contract, not against the implementation: the binary is spawned from
 * `MINIHARNESS_BIN` (default `node dist/cli.js` at the repo root) and these
 * tests go green as the build slices land.
 *
 * Gating:
 *  - `MINIHARNESS_LIVE` unset -> success/input-path tests skip (a live
 *    provider is required, and no network may be touched otherwise).
 *  - Bad-invocation (exit 2) tests always run; they fail until the CLI
 *    skeleton (slice A/E) lands, which is the intended gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const liveRaw = process.env.MINIHARNESS_LIVE;
const LIVE = liveRaw !== undefined && !['', '0', 'false', 'no'].includes(liveRaw.toLowerCase());
const LIVE_SKIP = 'requires a live provider - set MINIHARNESS_LIVE=1 to run (kept off to avoid network calls)';

/** The command that launches the harness, run with cwd = repo root. */
function harnessCommand() {
  const raw = process.env.MINIHARNESS_BIN ?? 'node dist/cli.js';
  return raw.split(/\s+/).filter(Boolean);
}

/** Spawn the harness under test; returns { status, stdout, stderr }. */
function runHarness(args, { input, cwd = REPO_ROOT, env } = {}) {
  const cmd = harnessCommand();
  const res = spawnSync(cmd[0], [...cmd.slice(1), ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: env ?? process.env,
  });
  if (res.status === null) {
    if (res.error.code === 'ENOENT') {
      throw new Error(
        `harness binary not found (${cmd.join(' ')} in ${cwd}) - expected until the CLI skeleton (slice A/E) lands`,
      );
    }
    throw res.error ?? new Error(`harness failed to launch (${cmd.join(' ')} in ${cwd})`);
  }
  if (res.signal) {
    throw new Error(`harness was killed by signal ${res.signal}`);
  }
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Parse stdout as exactly one JSON object envelope (whitespace tolerated, garbage not). */
function parseEnvelope(stdout) {
  let env;
  try {
    env = JSON.parse(stdout);
  } catch (err) {
    assert.fail(`stdout is not a single JSON document: ${err.message}\n--- stdout ---\n${stdout}\n---`);
  }
  assert.equal(typeof env, 'object', 'envelope must be a JSON object');
  assert.ok(!Array.isArray(env), 'envelope must be a JSON object, not an array');
  return env;
}

const ENVELOPE_KEYS = ['session_id', 'model', 'provider', 'tokens', 'cost_microdollars', 'duration_ms'];
const TOKEN_KEYS = ['input', 'output', 'cache_read', 'cache_write', 'reasoning'];

/** Assert the DEC success envelope shape; returns the parsed envelope. */
function assertEnvelope(stdout, stderr) {
  const env = parseEnvelope(stdout);
  assert.equal(typeof env.output, 'string', 'output must be a string - the only guaranteed field');
  for (const key of ENVELOPE_KEYS) {
    assert.ok(key in env, `envelope must carry "${key}" (present, may be null)`);
  }
  if (env.tokens !== null) {
    assert.equal(typeof env.tokens, 'object', 'tokens must be an object or null');
    assert.ok(!Array.isArray(env.tokens), 'tokens must be an object or null');
    for (const key of TOKEN_KEYS) {
      assert.ok(key in env.tokens, `tokens must carry "${key}" (TokenCounts shape)`);
    }
  }
  assert.equal(stderr, '', 'stderr must be empty on success - diagnostics only');
  return env;
}

/** Assert a bad invocation: exit 2, stdout machine-clean and empty. */
function assertBadInvocation(args) {
  const { status, stdout, stderr } = runHarness(args);
  assert.equal(status, 2, `bad invocation must exit 2 (got ${status}); stderr: ${stderr}`);
  assert.equal(stdout, '', 'stdout must be machine-clean and empty unless exit 0');
  return { status, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Exit 2 - bad invocation (ungated; red until slice A/E lands)
// ---------------------------------------------------------------------------

test('exit 2 on unknown flag with empty stdout and a stderr diagnostic [DEC Exit Codes: 2 - unparseable flags; DEC Output: stdout machine-clean]', () => {
  const { stderr } = assertBadInvocation(['--definitely-not-a-miniharness-flag']);
  assert.ok(stderr.length > 0, 'stderr must carry a human-readable error for a bad invocation');
});

test('exit 2 on unresolvable --provider with empty stdout [DEC Exit Codes: 2 - unresolvable provider; DEC Input: model selection]', () => {
  assertBadInvocation(['--provider', 'nope']);
});

test('exit 2 on unresolvable --model with empty stdout [DEC Exit Codes: 2 - unresolvable model; DEC Input: model selection]', () => {
  assertBadInvocation(['--model', 'nope']);
});

test('exit 2 on missing config dir with empty stdout [DEC Exit Codes: 2 - missing/invalid config; DEC Sessions And Config: --config-dir]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-config-'));
  assertBadInvocation(['--config-dir', dir]);
});

// ---------------------------------------------------------------------------
// Success and input paths - live-gated (needs a real provider + binary)
// ---------------------------------------------------------------------------

test('success: trivial prompt exits 0 with exactly one JSON envelope and empty stderr [DEC Output: success envelope; DEC Exit Codes: 0]', { skip: LIVE_SKIP }, () => {
  const { status, stdout, stderr } = runHarness(['Reply with the single word ok.']);
  assert.equal(status, 0, `summon must exit 0 (got ${status}); stderr: ${stderr}`);
  assertEnvelope(stdout, stderr);
});

test('input: positional prompt and stdin prompt produce equivalent envelopes [DEC Input: prompt]', { skip: LIVE_SKIP }, () => {
  const prompt = 'Reply with the single word ok.';
  const positional = runHarness([prompt]);
  const viaStdin = runHarness([], { input: prompt });
  assert.equal(positional.status, 0, `positional summon failed (${positional.status}): ${positional.stderr}`);
  assert.equal(viaStdin.status, 0, `stdin summon failed (${viaStdin.status}): ${viaStdin.stderr}`);
  const a = assertEnvelope(positional.stdout, positional.stderr);
  const b = assertEnvelope(viaStdin.stdout, viaStdin.stderr);
  // Equivalence is asserted at the contract level: identical envelope shape
  // and a non-empty reply from both paths. The reply text itself is not
  // compared - provider output is not guaranteed deterministic.
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.notEqual(a.output, '', 'positional summon must return a reply');
  assert.notEqual(b.output, '', 'stdin summon must return a reply');
});

test('input: --system-prompt and --system-prompt-file - are accepted [DEC Input: system prompt]', { skip: LIVE_SKIP }, () => {
  const prompt = 'Reply with the single word ok.';
  const inline = runHarness(['--system-prompt', 'You are a terse assistant.', prompt]);
  const fileDash = runHarness(['--system-prompt-file', '-', prompt], { input: 'You are a terse assistant.' });
  assert.equal(inline.status, 0, `--system-prompt summon failed (${inline.status}): ${inline.stderr}`);
  assert.equal(fileDash.status, 0, `--system-prompt-file - summon failed (${fileDash.status}): ${fileDash.stderr}`);
  assertEnvelope(inline.stdout, inline.stderr);
  assertEnvelope(fileDash.stdout, fileDash.stderr);
});

// ---------------------------------------------------------------------------
// Failure semantics - exit 1
// ---------------------------------------------------------------------------

test('failure semantics: in-flight failure exits 1 with empty stdout [DEC Exit Codes: 1]', () => {
  // The fault-injection hook fires after invocation validation, which needs
  // a readable models.json: point PI_CODING_AGENT_DIR at the fixture and
  // resolve provider/model explicitly (the default provider has no
  // default_model).
  const configDir = mkdtempSync(join(tmpdir(), 'miniharness-fail-config-'));
  writeFileSync(
    join(configDir, 'models.json'),
    readFileSync(join(REPO_ROOT, 'tests', 'fixture-models.json'), 'utf8'),
  );
  const { status, stdout, stderr } = runHarness(
    ['--provider', 'kimicode', '--model', 'sonnet', '--effort', 'low', 'Reply with the single word ok.'],
    {
      env: { ...process.env, MINIHARNESS_FAIL_AFTER: 'provider-connect', PI_CODING_AGENT_DIR: configDir },
    },
  );
  assert.equal(status, 1, `in-flight failure must exit 1 (got ${status}); stderr: ${stderr}`);
  assert.equal(stdout, '', 'stdout must be machine-clean and empty unless exit 0');
  assert.ok(/MINIHARNESS_FAIL_AFTER/.test(stderr), 'stderr must carry the injected-failure marker');
});
