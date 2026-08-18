import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STUB_PATH = join(REPO_ROOT, 'tests', 'gen-params-stub.mjs');
const STUB_MODEL = 'stub-generation-params';

function harnessCommand() {
  return (process.env.MINIHARNESS_BIN ?? 'node dist/cli.js').split(/\s+/).filter(Boolean);
}

function runHarness(args, { input, env = process.env } = {}) {
  const cmd = harnessCommand();
  const result = spawnSync(cmd[0], [...cmd.slice(1), ...args], {
    cwd: REPO_ROOT,
    input,
    encoding: 'utf8',
    env,
  });
  if (result.status === null) throw result.error ?? new Error('harness did not exit');
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function fixtureConfig({ provider = 'stub', model = STUB_MODEL, apiModel = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-gen-params-config-'));
  writeFileSync(join(dir, 'models.json'), JSON.stringify({
    version: 1,
    providers: {
      [provider]: {
        base_url: 'http://stub.local/v1',
        default_model: model,
        ...(apiModel ? { models: [{ id: model, name: model, reasoning: false, contextWindow: 128000, maxTokens: 8192 }] } : {}),
      },
    },
  }));
  return dir;
}

function capturePath() {
  return join(mkdtempSync(join(tmpdir(), 'miniharness-gen-params-capture-')), 'capture.json');
}

function stubEnv(capture, extra = {}) {
  return {
    ...process.env,
    MINIHARNESS_EXTRA_PROVIDER: STUB_PATH,
    MINIHARNESS_GEN_PARAMS_CAPTURE: capture,
    ...extra,
  };
}

function runStub(args, { capture = capturePath(), config = fixtureConfig(), env = {} } = {}) {
  const result = runHarness([
    '--config-dir', config,
    '--provider', 'stub',
    '--model', STUB_MODEL,
    '--no-session',
    ...args,
  ], { env: stubEnv(capture, env) });
  return { ...result, capture, config };
}

function captured(path) {
  assert.ok(existsSync(path), `stub did not capture a request at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function lifecycle(stderr) {
  return stderr.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function assertBad(args, { env = process.env } = {}) {
  const result = runHarness(args, { env });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  return result;
}

test('--version exits before config, sessions, lifecycle, or provider loading', () => {
  const sessionDir = join(mkdtempSync(join(tmpdir(), 'miniharness-version-')), 'sessions');
  const result = runHarness(['--version'], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: join(sessionDir, 'missing-config'),
      MINIHARNESS_SESSION_DIR: sessionDir,
      MINIHARNESS_EXTRA_PROVIDER: join(sessionDir, 'provider-that-must-not-load.mjs'),
    },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version}\n`);
  assert.equal(result.stderr, '');
  assert.equal(existsSync(sessionDir), false);
  assert.equal(existsSync(join(sessionDir, 'sessions')), false);
});

test('system prompt has default, supplied, and explicitly absent states', () => {
  const defaultRun = runStub(['hello']);
  assert.equal(defaultRun.status, 0, defaultRun.stderr);
  assert.equal(captured(defaultRun.capture).context.systemPrompt,
    'You are miniharness, a minimal headless assistant. Reply concisely and directly.');

  const suppliedRun = runStub(['--system-prompt', 'Only answer in JSON.', 'hello']);
  assert.equal(suppliedRun.status, 0, suppliedRun.stderr);
  assert.equal(captured(suppliedRun.capture).context.systemPrompt, 'Only answer in JSON.');

  const emptyFile = join(suppliedRun.config, 'empty-prompt.txt');
  writeFileSync(emptyFile, '');
  const emptyFileRun = runStub(['--system-prompt-file', emptyFile, 'hello'], { config: suppliedRun.config });
  assert.equal(emptyFileRun.status, 0, emptyFileRun.stderr);
  assert.equal(captured(emptyFileRun.capture).context.systemPrompt, '');

  const absentRun = runStub(['--no-system-prompt', 'hello']);
  assert.equal(absentRun.status, 0, absentRun.stderr);
  assert.equal(captured(absentRun.capture).context.systemPrompt, '');
});

test('{session_id} in the system prompt resolves before provider inference', () => {
  const capture = capturePath();
  const config = fixtureConfig();
  const sessionDir = mkdtempSync(join(tmpdir(), 'miniharness-prompt-session-'));
  const result = runHarness([
    '--config-dir', config,
    '--provider', 'stub',
    '--model', STUB_MODEL,
    '--session-dir', sessionDir,
    '--system-prompt', 'current session: {session_id}',
    'hello',
  ], { env: stubEnv(capture) });
  assert.equal(result.status, 0, result.stderr);
  const records = lifecycle(result.stderr);
  const sessionId = records.find((record) => record.event === 'session_started')?.session_id;
  assert.equal(typeof sessionId, 'string');
  assert.equal(captured(capture).context.systemPrompt, `current session: ${sessionId}`);
});

test('{session_id} requires sessions to be enabled', () => {
  const result = runStub([
    '--system-prompt', 'current session: {session_id}',
    'hello',
  ]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /requires session persistence/);
});

test('--no-system-prompt is mutually exclusive with supplied prompt forms', () => {
  const config = fixtureConfig();
  const file = join(config, 'prompt.txt');
  writeFileSync(file, 'supplied');
  for (const args of [
    ['--no-system-prompt', '--system-prompt', 'supplied', 'hello'],
    ['--no-system-prompt', '--system-prompt-file', file, 'hello'],
  ]) {
    const result = assertBad(['--config-dir', config, ...args]);
    assert.match(result.stderr, /cannot be combined/);
  }
});

test('--gen-params maps all five fields through the main stream function', () => {
  const raw = JSON.stringify({ temperature: 0.7, max_tokens: 123, seed: 42, top_p: 0.55, stop: ['END', 'STOP'] });
  const result = runStub(['--gen-params', raw, 'hello']);
  assert.equal(result.status, 0, result.stderr);
  const request = captured(result.capture);
  assert.equal(request.options.temperature, 0.7);
  assert.equal(request.options.maxTokens, 123);
  assert.deepEqual(request.options.samplingParams, { seed: 42, top_p: 0.55, stop: ['END', 'STOP'] });
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(envelope).sort(), [
    'cost_microdollars', 'duration_ms', 'model', 'output', 'provider', 'session_id', 'tokens',
  ]);
  const events = lifecycle(result.stderr);
  assert.equal(events[0].event, 'started');
  assert.equal(events.at(-1).event, 'done');
  assert.equal(existsSync(join(result.config, 'sessions')), false);
});

test('seed accepts zero and the maximum safe integer but rejects negative values', () => {
  for (const seed of [0, Number.MAX_SAFE_INTEGER]) {
    const result = runStub(['--gen-params', JSON.stringify({ seed }), 'hello']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(captured(result.capture).options.samplingParams.seed, seed);
  }
  const result = assertBad(['--gen-params', '{"seed":-1}', 'hello']);
  assert.match(result.stderr, /--gen-params must be a bounded JSON object/);
});

test('unsupported sampling API fails before provider-contact path', () => {
  const config = fixtureConfig({ provider: 'codex', model: 'gpt-5.6-luna' });
  const env = { ...process.env, MINIHARNESS_FAIL_AFTER: 'provider-connect' };
  const result = assertBad([
    '--config-dir', config,
    '--provider', 'codex',
    '--model', 'gpt-5.6-luna',
    '--no-session',
    '--gen-params', '{"seed":1}',
    'hello',
  ], { env });
  assert.match(result.stderr, /sampling fields are unsupported/);
  assert.doesNotMatch(result.stderr, /MINIHARNESS_FAIL_AFTER/);

  const noSystem = assertBad([
    '--config-dir', config,
    '--provider', 'codex',
    '--model', 'gpt-5.6-luna',
    '--no-session',
    '--no-system-prompt',
    'hello',
  ], { env });
  assert.match(noSystem.stderr, /--no-system-prompt is unsupported/);
  assert.doesNotMatch(noSystem.stderr, /MINIHARNESS_FAIL_AFTER/);
});

test('invalid generation params are redacted and exit 2', () => {
  const badValues = [
    'not-json',
    '[]',
    '{"temperature":"hot"}',
    '{"temperature":-1}',
    '{"max_tokens":0}',
    '{"seed":1.5}',
    '{"top_p":0}',
    '{"top_p":1.1}',
    '{"stop":42}',
    '{"unknown":1}',
    '{"__proto__":1}',
    JSON.stringify({ stop: 'x'.repeat(257) }),
    JSON.stringify({ stop: Array.from({ length: 17 }, () => 'x') }),
    `{"stop":"${'x'.repeat(16 * 1024)}"}`,
  ];
  for (const raw of badValues) {
    const result = assertBad(['--gen-params', raw, 'hello']);
    assert.match(result.stderr, /--gen-params must be a bounded JSON object/);
    assert.doesNotMatch(result.stderr, /not-json|hot|unknown|x{20}/);
  }
});

test('--resume does not inherit generation parameters or system prompt', () => {
  const capture = capturePath();
  const config = fixtureConfig();
  const first = runHarness([
    '--config-dir', config, '--provider', 'stub', '--model', STUB_MODEL,
    '--session-dir', config, '--system-prompt', 'First prompt',
    '--gen-params', '{"temperature":0.2,"seed":7}', 'first',
  ], { env: stubEnv(capture) });
  assert.equal(first.status, 0, first.stderr);
  const firstEnvelope = JSON.parse(first.stdout);
  assert.equal(typeof firstEnvelope.session_id, 'string');

  const second = runHarness([
    '--config-dir', config, '--provider', 'stub', '--model', STUB_MODEL,
    '--session-dir', config, '--resume', firstEnvelope.session_id,
    '--no-system-prompt', 'second',
  ], { env: stubEnv(capture) });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).session_id, firstEnvelope.session_id);
  const request = captured(capture);
  assert.equal(request.context.systemPrompt, '');
  assert.equal(request.options.temperature, undefined);
  assert.equal(request.options.samplingParams, undefined);
});
