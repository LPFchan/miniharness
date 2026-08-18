/**
 * Compaction behavior tests (SPEC "Compaction support", DEC-20260808-001
 * contract unchanged).
 *
 * The summon path compacts through pi-agent-core's compaction module
 * (shouldCompact / prepareCompaction / compact with
 * DEFAULT_COMPACTION_SETTINGS) when the transcript would overflow the
 * model's context window. This file exercises that path end-to-end with a
 * stub provider - no network, no credentials:
 *
 *   - the fixture config names a model id absent from the pi catalogue, so
 *     resolveModel() constructs it from the fixture fields including a tiny
 *     contextWindow;
 *   - the stub provider answers streamSimple() with a pre-built event
 *     stream (the same stream contract pi-ai's streamSimple returns);
 *   - a large prompt pushes estimateContextTokens() over the context
 *     window, so --compaction auto runs compact() and persists a truthful
 *     compaction entry; --compaction off skips compaction entirely.
 *
 * The harness binary is spawned the same way as the other suites, with
 * MINIHARNESS_SESSION_DIR pointing at a writable temp dir (the harness
 * probes the session dir before contacting any provider).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createModels } from '@earendil-works/pi-ai';
import {
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  prepareCompaction,
} from '@earendil-works/pi-agent-core';
import { registerTestProvider, STUB_MODEL } from './compaction-stub.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Config-dir name; the test writes models.json into it. */
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'compaction-fixture');

/** Prompt text long enough to overflow the stub model's context window. */
const LONG_PROMPT = 'summon me a recap '.repeat(4000);

/** Short prompt that stays well under the context window. */
const SHORT_PROMPT = 'hi';

/**
 * Write the fixture config. `models: []` (as the generated registry
 * projection ships) plus a catalogue-absent model id makes resolveModel()
 * construct the model from the fixture fields - including the tiny
 * contextWindow - so the stub provider serves the summon.
 *
 * The stub model is intentionally absent from the pi catalogue, so the
 * fixture entry (with a tiny contextWindow) is the only source of the
 * model's capability fields; a small context window makes the LONG_PROMPT
 * overflow so compaction actually runs.
 */
function writeFixtureConfig(dir) {
  writeFileSync(
    join(dir, 'models.json'),
    JSON.stringify({
      providers: {
        stub: {
          base_url: 'http://stub.local/v1',
          provider_type: 'OpenAICompatible',
          models: [
            {
              id: STUB_MODEL,
              name: 'stub overflow model',
              contextWindow: 512,
              maxTokens: 128,
              reasoning: false,
            },
          ],
          default_model: STUB_MODEL,
        },
      },
    }),
  );
}

/** Build the fixture config dir once (used by every test). */
const fixtureDir = mkdtempSync(join(tmpdir(), 'miniharness-compaction-config-'));
writeFixtureConfig(fixtureDir);

/** The command that launches the harness (same convention as cli.test.mjs). */
function harnessCommand() {
  const raw = process.env.MINIHARNESS_BIN ?? 'node dist/cli.js';
  return raw.split(/\s+/).filter(Boolean);
}

/**
 * Run the harness with the stub provider registered on its Models instance
 * via MINIHARNESS_EXTRA_PROVIDER (a test-only seam; the normal summon path
 * never sets it). The stub module's path is resolved against the repo root.
 */
function runHarness(args, { input, cwd = REPO_ROOT, env } = {}) {
  const cmd = harnessCommand();
  const stubPath = join(REPO_ROOT, 'tests', 'compaction-stub.mjs');
  const res = spawnSync(cmd[0], [...cmd.slice(1), ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...(env ?? process.env), MINIHARNESS_EXTRA_PROVIDER: stubPath },
  });
  if (res.status === null) {
    throw res.error ?? new Error(`harness failed to launch (${cmd.join(' ')} in ${cwd})`);
  }
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Parse miniharness-authored lifecycle stderr. */
function parseLifecycle(stderr) {
  return stderr
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        assert.fail(`stderr line is not lifecycle JSON: ${error.message}\n${line}`);
      }
    });
}

/** A fresh temp session dir for one summon. */
function freshSessionDir() {
  return mkdtempSync(join(tmpdir(), 'miniharness-compaction-session-'));
}

/** Recursively find the session JSONL file(s) under a session dir. */
function sessionFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Read every JSONL line in a session dir as parsed objects. */
function readSessionLines(dir) {
  const files = sessionFiles(dir);
  assert.ok(files.length >= 1, `expected at least one session file, got: ${files.join(', ')}`);
  const lines = [];
  for (const file of files) {
    lines.push(
      ...readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Compaction decision behavior (auto vs off)
// ---------------------------------------------------------------------------

test('--compaction auto compacts an overflowing transcript and persists the compaction entry', () => {
  const sessionDir = freshSessionDir();
  const { status, stdout, stderr } = runHarness(
    [
      '--config-dir', fixtureDir,
      '--provider', 'stub',
      '--model', STUB_MODEL,
      '--compaction', 'auto',
      LONG_PROMPT,
    ],
    { env: { ...process.env, MINIHARNESS_SESSION_DIR: sessionDir } },
  );
  assert.equal(status, 0, `summon must succeed (got ${status}); stderr: ${stderr}`);
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.output, 'stub reply');
  assert.ok(envelope.session_id, 'session id must be present');

  const lifecycle = parseLifecycle(stderr);
  const finalizing = lifecycle.findIndex((record) => record.event === 'finalizing');
  const compactionStarted = lifecycle.findIndex((record) => record.event === 'compaction_started');
  const compactionFinished = lifecycle.findIndex((record) => record.event === 'compaction_finished');
  const done = lifecycle.findIndex((record) => record.event === 'done');
  assert.ok(finalizing >= 0, 'finalizing lifecycle record must be present');
  assert.equal(compactionStarted, finalizing + 1);
  assert.equal(compactionFinished, compactionStarted + 1);
  assert.equal(done, compactionFinished + 1);
  assert.deepEqual(
    Object.keys(lifecycle[compactionStarted]).sort(),
    ['elapsed_ms', 'event', 'protocol', 'seq', 'timestamp', 'version'],
  );
  assert.deepEqual(
    Object.keys(lifecycle[compactionFinished]).sort(),
    ['elapsed_ms', 'event', 'outcome', 'protocol', 'seq', 'timestamp', 'version'],
  );
  assert.equal(lifecycle[compactionFinished].outcome, 'completed');

  // The envelope keeps the DEC shape: no compaction field.
  assert.equal('compacted' in envelope, false);

  // The session JSONL records the compaction entry after the messages.
  const lines = readSessionLines(sessionDir);
  const entry = lines.find((item) => item.type === 'compaction');
  assert.ok(entry, 'session must contain a compaction entry');
  assert.ok(entry.summary.length > 0, 'compaction entry must carry a summary');
  assert.ok(entry.tokensBefore > 0, 'compaction entry must carry tokensBefore');
});

test('--compaction off skips compaction even on overflow', () => {
  const sessionDir = freshSessionDir();
  const { status, stdout, stderr } = runHarness(
    [
      '--config-dir', fixtureDir,
      '--provider', 'stub',
      '--model', STUB_MODEL,
      '--compaction', 'off',
      LONG_PROMPT,
    ],
    { env: { ...process.env, MINIHARNESS_SESSION_DIR: sessionDir } },
  );
  assert.equal(status, 0, `summon must succeed (got ${status}); stderr: ${stderr}`);
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.output, 'stub reply');

  const lifecycle = parseLifecycle(stderr);
  assert.equal(lifecycle.some((record) => record.event === 'compaction_started'), false);
  assert.equal(lifecycle.some((record) => record.event === 'compaction_finished'), false);

  const lines = readSessionLines(sessionDir);
  const entry = lines.find((item) => item.type === 'compaction');
  assert.equal(entry, undefined, 'session must not contain a compaction entry');
});

test('--silent suppresses compaction lifecycle records on overflow', () => {
  const sessionDir = freshSessionDir();
  const { status, stdout, stderr } = runHarness(
    [
      '--config-dir', fixtureDir,
      '--provider', 'stub',
      '--model', STUB_MODEL,
      '--compaction', 'auto',
      '--silent',
      LONG_PROMPT,
    ],
    { env: { ...process.env, MINIHARNESS_SESSION_DIR: sessionDir } },
  );
  assert.equal(status, 0, `summon must succeed (got ${status}); stderr: ${stderr}`);
  assert.equal(JSON.parse(stdout).output, 'stub reply');
  assert.equal(stderr, '');
});

test('failed compaction emits a paired content-free failure outcome', () => {
  const sessionDir = freshSessionDir();
  const { status, stdout, stderr } = runHarness(
    [
      '--config-dir', fixtureDir,
      '--provider', 'stub',
      '--model', STUB_MODEL,
      '--compaction', 'auto',
      LONG_PROMPT,
    ],
    {
      env: {
        ...process.env,
        MINIHARNESS_SESSION_DIR: sessionDir,
        MINIHARNESS_COMPACTION_FAILURE: 'returned',
      },
    },
  );
  assert.equal(status, 0, `summon must keep its existing success status (got ${status}); stderr: ${stderr}`);
  assert.equal(JSON.parse(stdout).output, 'stub reply');

  const lifecycle = parseLifecycle(stderr);
  const finalizing = lifecycle.findIndex((record) => record.event === 'finalizing');
  const compactionStarted = lifecycle.findIndex((record) => record.event === 'compaction_started');
  const compactionFinished = lifecycle.findIndex((record) => record.event === 'compaction_finished');
  const done = lifecycle.findIndex((record) => record.event === 'done');
  assert.ok(finalizing >= 0, 'finalizing lifecycle record must be present');
  assert.equal(compactionStarted, finalizing + 1);
  assert.equal(compactionFinished, compactionStarted + 1);
  assert.equal(done, compactionFinished + 1);
  assert.deepEqual(
    Object.keys(lifecycle[compactionFinished]).sort(),
    ['elapsed_ms', 'event', 'outcome', 'protocol', 'seq', 'timestamp', 'version'],
  );
  assert.equal(lifecycle[compactionFinished].outcome, 'failed');
});

test('--resume appends a correction turn to the existing session and keeps its id', () => {
  const sessionDir = freshSessionDir();
  const first = runHarness(
    [
      '--config-dir', fixtureDir,
      '--provider', 'stub',
      '--model', STUB_MODEL,
      '--compaction', 'off',
      SHORT_PROMPT,
    ],
    { env: { ...process.env, MINIHARNESS_SESSION_DIR: sessionDir } },
  );
  assert.equal(first.status, 0, `initial summon failed: ${first.stderr}`);
  const firstEnvelope = JSON.parse(first.stdout);
  assert.ok(firstEnvelope.session_id);
  const firstFiles = sessionFiles(sessionDir);
  assert.equal(firstFiles.length, 1);

  const resumed = runHarness(
    [
      '--compaction',
      'off',
      '--config-dir',
      fixtureDir,
      '--provider',
      'stub',
      '--model',
      STUB_MODEL,
      '--resume',
      firstEnvelope.session_id,
      'please correct your previous answer',
    ],
    { env: { ...process.env, MINIHARNESS_SESSION_DIR: sessionDir } },
  );
  assert.equal(resumed.status, 0, `resumed summon failed: ${resumed.stderr}`);
  const resumedEnvelope = JSON.parse(resumed.stdout);
  assert.equal(resumedEnvelope.session_id, firstEnvelope.session_id);
  assert.deepEqual(sessionFiles(sessionDir), firstFiles);

  const lines = readSessionLines(sessionDir);
  const userTexts = lines
    .filter((entry) => entry.type === 'message' && entry.message?.role === 'user')
    .map((entry) => entry.message.content?.[0]?.text);
  assert.deepEqual(userTexts, [SHORT_PROMPT, 'please correct your previous answer']);
});

// ---------------------------------------------------------------------------
// Direct compaction module exercise (library seam, no harness spawn)
// ---------------------------------------------------------------------------

test('compact() produces a summary and retained tail from a prepared history', async () => {
  const models = createModels();
  registerTestProvider(models);
  const model = models.getModel('stub', STUB_MODEL);
  assert.ok(model, 'stub model must resolve');

  const messages = [
    { role: 'user', content: LONG_PROMPT, timestamp: Date.now() },
    { role: 'assistant', content: [{ type: 'text', text: 'stub reply' }], timestamp: Date.now() },
  ];
  const pathEntries = messages.map((message, index) => ({
    type: 'message',
    id: `msg-${index}`,
    seq: index,
    parentId: index === 0 ? null : `msg-${index - 1}`,
    timestamp: message.timestamp,
    message,
  }));

  const preparation = prepareCompaction(pathEntries, DEFAULT_COMPACTION_SETTINGS);
  assert.ok(preparation.ok, 'preparation must succeed');
  assert.ok(preparation.value, 'preparation must return a preparation');
  const result = await compact(preparation.value, models, model);
  assert.ok(result.ok, `compact must succeed (got ${JSON.stringify(result.error)})`);
  assert.ok(result.value.summary.length > 0, 'summary must be non-empty');
  assert.equal(result.value.tokensBefore, preparation.value.tokensBefore);
});
