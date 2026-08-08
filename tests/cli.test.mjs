/**
 * Slice E parser tests: the argv/stdin interface of DEC-20260808-001.
 *
 * Ungated by design — every case below fails during invocation validation,
 * before any network or credentials are touched:
 *   - unknown flags, missing values, duplicated flags, too many positionals
 *   - stdin conflicts (prompt AND --system-prompt-file -)
 *   - --cwd validation (nonexistent / not a directory)
 *   - provider/model/effort resolution against a fixture config dir
 *   - --help exit 0, -- terminator, exit-1 fault-injection hook
 *
 * The binary is spawned from `MINIHARNESS_BIN` (default `node dist/cli.js`
 * at the repo root), same as the conformance suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The command that launches the harness, run with cwd = repo root. */
function harnessCommand() {
  const raw = process.env.MINIHARNESS_BIN ?? 'node dist/cli.js';
  return raw.split(/\s+/).filter(Boolean);
}

/** Spawn the harness; returns { status, stdout, stderr }. */
function runHarness(args, { input, cwd = REPO_ROOT, env } = {}) {
  const cmd = harnessCommand();
  const res = spawnSync(cmd[0], [...cmd.slice(1), ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: env ?? process.env,
  });
  if (res.status === null) {
    throw res.error ?? new Error(`harness failed to launch (${cmd.join(' ')} in ${cwd})`);
  }
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Assert a bad invocation: exit 2, stdout machine-clean and empty. */
function assertBadInvocation(args, { input, env } = {}) {
  const { status, stdout, stderr } = runHarness(args, { input, env });
  assert.equal(status, 2, `bad invocation must exit 2 (got ${status}); stderr: ${stderr}`);
  assert.equal(stdout, '', 'stdout must be machine-clean and empty unless exit 0');
  return { status, stdout, stderr };
}

/** A fresh tmp config dir holding the fixture models.json. */
function fixtureConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-cli-config-'));
  writeFileSync(
    join(dir, 'models.json'),
    readFileSync(join(REPO_ROOT, 'tests', 'fixture-models.json'), 'utf8'),
  );
  return dir;
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

test('unknown long flag exits 2 with a one-line stderr diagnostic and empty stdout', () => {
  const { stderr } = assertBadInvocation(['--definitely-not-a-miniharness-flag']);
  assert.match(stderr, /unknown flag: --definitely-not-a-miniharness-flag/);
});

test('unknown short flag exits 2', () => {
  assertBadInvocation(['-x']);
});

test('flag missing its value exits 2', () => {
  assertBadInvocation(['--provider']);
  assertBadInvocation(['--cwd']);
});

test('empty flag value exits 2', () => {
  assertBadInvocation(['--provider=']);
});

test('duplicated scalar flag exits 2', () => {
  assertBadInvocation(['--provider', 'a', '--provider', 'b', 'hi']);
});

test('more than one positional prompt exits 2', () => {
  assertBadInvocation(['one', 'two']);
});

test('-- terminator makes following dashes positional; two positionals still exit 2', () => {
  assertBadInvocation(['--', 'one', 'two']);
});

test('--help prints usage on stdout and exits 0', () => {
  const { status, stdout, stderr } = runHarness(['--help']);
  assert.equal(status, 0, `--help must exit 0 (got ${status}); stderr: ${stderr}`);
  assert.match(stdout, /Usage: miniharness/);
  assert.match(stdout, /--system-prompt/);
  assert.match(stdout, /--config-dir/);
  assert.equal(stderr, '', 'stderr must be empty on --help');
});

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

test('--system-prompt and --system-prompt-file together exit 2', () => {
  assertBadInvocation(['--system-prompt', 'a', '--system-prompt-file', 'b', 'hi']);
});

test('stdin serving both prompt and --system-prompt-file - exits 2', () => {
  assertBadInvocation(['--system-prompt-file', '-'], { input: 'both' });
});

test('--system-prompt-file pointing at a missing file exits 2', () => {
  assertBadInvocation(['--system-prompt-file', '/nonexistent/nowhere.txt', 'hi']);
});

// ---------------------------------------------------------------------------
// --cwd
// ---------------------------------------------------------------------------

test('--cwd nonexistent exits 2', () => {
  const { stderr } = assertBadInvocation(['--cwd', '/nonexistent/miniharness-dir', 'hi']);
  assert.match(stderr, /--cwd does not exist/);
});

test('--cwd pointing at a file (not a directory) exits 2', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'miniharness-cwd-')), 'not-a-dir');
  writeFileSync(file, 'x');
  const { stderr } = assertBadInvocation(['--cwd', file, 'hi']);
  assert.match(stderr, /--cwd is not a directory/);
});

// ---------------------------------------------------------------------------
// Provider / model / effort against a fixture config dir
// ---------------------------------------------------------------------------

test('unknown provider exits 2 naming the enrolled set', () => {
  const dir = fixtureConfigDir();
  const { stderr } = assertBadInvocation(['--config-dir', dir, '--provider', 'nope', 'hi']);
  assert.match(stderr, /provider "nope" is not enrolled/);
  assert.match(stderr, /crofai/);
});

test('unknown model exits 2', () => {
  const dir = fixtureConfigDir();
  const { stderr } = assertBadInvocation(['--config-dir', dir, '--model', 'nope', 'hi']);
  assert.match(stderr, /unknown model "nope"/);
});

test('tier on a tierless provider exits 2', () => {
  const dir = fixtureConfigDir();
  const { stderr } = assertBadInvocation(['--config-dir', dir, '--provider', 'crofai', '--model', 'sonnet', 'hi']);
  assert.match(stderr, /no tier map/);
});

test('unsupported effort exits 2 naming the supported set', () => {
  const dir = fixtureConfigDir();
  const { stderr } = assertBadInvocation(['--config-dir', dir, '--provider', 'kimicode', '--model', 'k3', '--effort', 'bogus', 'hi']);
  assert.match(stderr, /effort "bogus" is not a thinking level/);
});

test('missing config dir exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-config-empty-'));
  const { stderr } = assertBadInvocation(['--config-dir', dir, 'hi']);
  assert.match(stderr, /config: cannot read/);
});

test('provider/model/effort resolve against a fixture config dir and reach the fault-injection hook', () => {
  // kimicode carries a tier map (sonnet -> k3) and k3 supports effort low,
  // so validation passes and the summon fails at the injected
  // provider-connect step (exit 1), proving resolution happened first.
  const dir = fixtureConfigDir();
  const { status, stdout, stderr } = runHarness(
    ['--config-dir', dir, '--provider', 'kimicode', '--model', 'sonnet', '--effort', 'low', 'hi'],
    { env: { ...process.env, MINIHARNESS_FAIL_AFTER: 'provider-connect' } },
  );
  assert.equal(status, 1, `expected injected in-flight failure (got ${status}); stderr: ${stderr}`);
  assert.equal(stdout, '', 'stdout must be empty on failure');
  assert.match(stderr, /MINIHARNESS_FAIL_AFTER/);
});

// ---------------------------------------------------------------------------
// Exit 1 fault-injection hook
// ---------------------------------------------------------------------------

test('MINIHARNESS_FAIL_AFTER=provider-connect exits 1 with marked stderr and empty stdout', () => {
  const dir = fixtureConfigDir();
  // No default_model on the first enrolled provider (grimoire), so resolve
  // explicitly: kimicode sonnet -> k3, effort low (supported by k3).
  const { status, stdout, stderr } = runHarness(
    ['--provider', 'kimicode', '--model', 'sonnet', '--effort', 'low', 'hi'],
    {
      env: {
        ...process.env,
        MINIHARNESS_FAIL_AFTER: 'provider-connect',
        PI_CODING_AGENT_DIR: dir,
      },
    },
  );
  assert.equal(status, 1, `injected failure must exit 1 (got ${status}); stderr: ${stderr}`);
  assert.equal(stdout, '', 'stdout must be empty on failure');
  assert.match(stderr, /MINIHARNESS_FAIL_AFTER=provider-connect injected failure/);
});
