/**
 * DEC-20260809-001 lifecycle protocol tests. A local stub provider exercises
 * the complete success stream without credentials or network access.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STUB_MODEL } from './compaction-stub.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STUB_PATH = join(REPO_ROOT, 'tests', 'compaction-stub.mjs');

function harnessCommand() {
  const raw = process.env.MINIHARNESS_BIN ?? 'node dist/cli.js';
  return raw.split(/\s+/).filter(Boolean);
}

function fixtureConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-lifecycle-config-'));
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
              contextWindow: 4096,
              maxTokens: 128,
              reasoning: false,
            },
          ],
          default_model: STUB_MODEL,
        },
      },
    }),
  );
  return dir;
}

function runHarness(args, { env } = {}) {
  const cmd = harnessCommand();
  const result = spawnSync(cmd[0], [...cmd.slice(1), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      MINIHARNESS_EXTRA_PROVIDER: STUB_PATH,
      ...(env ?? {}),
    },
  });
  if (result.status === null) {
    throw result.error ?? new Error(`harness failed to launch: ${cmd.join(' ')}`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

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

function summonArgs(extra = []) {
  return [
    '--config-dir', fixtureConfigDir(),
    '--provider', 'stub',
    '--model', STUB_MODEL,
    '--no-session',
    ...extra,
    'say hi',
  ];
}

test('default success emits ordered, versioned lifecycle NDJSON and one stdout envelope', () => {
  const { status, stdout, stderr } = runHarness(summonArgs());
  assert.equal(status, 0, `stub summon failed: ${stderr}`);
  assert.equal(JSON.parse(stdout).output, 'stub reply');

  const records = parseLifecycle(stderr);
  assert.deepEqual(
    records.map((record) => record.event),
    [
      'started',
      'request_started',
      'response_started',
      'streaming_started',
      'progress',
      'finalizing',
      'done',
    ],
  );

  for (const [index, record] of records.entries()) {
    assert.equal(record.protocol, 'miniharness.lifecycle');
    assert.equal(record.version, 1);
    assert.equal(record.seq, index + 1);
    assert.equal(typeof record.timestamp, 'string');
    assert.equal(Number.isFinite(Date.parse(record.timestamp)), true);
    assert.equal(typeof record.elapsed_ms, 'number');
    assert.ok(record.elapsed_ms >= 0);
  }

  const progress = records.find((record) => record.event === 'progress');
  assert.equal(progress.delta_count, 1);
  assert.equal(progress.text_bytes, Buffer.byteLength('stub reply'));
  assert.equal('output' in progress, false);
  assert.equal('delta' in progress, false);
  assert.equal('prompt' in progress, false);
});

test('--silent suppresses all lifecycle records on success', () => {
  const { status, stdout, stderr } = runHarness(summonArgs(['--silent']));
  assert.equal(status, 0, `silent stub summon failed: ${stderr}`);
  assert.equal(JSON.parse(stdout).output, 'stub reply');
  assert.equal(stderr, '');
});

test('failures remain structured and visible with --silent', () => {
  const { status, stdout, stderr } = runHarness(summonArgs(['--silent']), {
    env: { MINIHARNESS_FAIL_AFTER: 'provider-connect' },
  });
  assert.equal(status, 1);
  assert.equal(stdout, '');
  const records = parseLifecycle(stderr);
  assert.deepEqual(records.map((record) => record.event), ['failed']);
  assert.equal(records[0].exit_code, 1);
  assert.equal(records[0].failure_class, 'summon');
  assert.match(records[0].message, /MINIHARNESS_FAIL_AFTER/);
});

test('--help documents --silent without emitting lifecycle records', () => {
  const { status, stdout, stderr } = runHarness(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /--silent/);
  assert.equal(stderr, '');
});

test('purpose marker is stored in the JSONL header without changing the prompt', () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'miniharness-purpose-'));
  const { status, stdout, stderr } = runHarness([
    '--config-dir', fixtureConfigDir(),
    '--provider', 'stub',
    '--model', STUB_MODEL,
    '--session-dir', sessionDir,
    '--purpose', 'chat_sidebar',
    'ordinary question',
  ]);
  assert.equal(status, 0, `purpose summon failed: ${stderr}`);
  const envelope = JSON.parse(stdout);
  assert.ok(envelope.session_id);
  const session = readdirSync(sessionDir, { recursive: true })
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => join(sessionDir, file))
    .find((file) => readFileSync(file, 'utf8').includes(envelope.session_id));
  assert.ok(session);
  const header = JSON.parse(readFileSync(session, 'utf8').split('\n')[0]);
  assert.equal(header.metadata.purpose, 'chat_sidebar');
  assert.ok(!readFileSync(session, 'utf8').includes('purpose: chat_sidebar'));
});
