/**
 * Built-in bash tool (DEC-20260921-001): opt-in exposure, real execution
 * through Pi's agent loop, --cwd, and fail-closed name collision with MCP.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STUB_PATH = join(REPO_ROOT, 'tests', 'bash-tool-stub.mjs');
const STUB_MODEL = 'stub-bash-tool';

function harnessCommand() {
  return (process.env.MINIHARNESS_BIN ?? 'node dist/cli.js').split(/\s+/).filter(Boolean);
}

function fixtureConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-bash-config-'));
  writeFileSync(join(dir, 'models.json'), JSON.stringify({
    version: 1,
    providers: {
      stub: {
        base_url: 'http://stub.local/v1',
        default_model: STUB_MODEL,
        models: [{
          id: STUB_MODEL,
          name: STUB_MODEL,
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 8192,
        }],
      },
    },
  }));
  return dir;
}

/**
 * Run one summon against the stub provider, returning the recorded turns.
 *
 * Asynchronous on purpose: the MCP fixtures below serve from this process, so a
 * blocking spawn would deadlock the event loop until miniharness's 30s request
 * timeout fired.
 */
async function runStub(args, { command, cwd } = {}) {
  const capture = join(mkdtempSync(join(tmpdir(), 'miniharness-bash-capture-')), 'turns.json');
  const sessionDir = mkdtempSync(join(tmpdir(), 'miniharness-bash-sessions-'));
  const cmd = harnessCommand();
  const child = spawn(cmd[0], [
    ...cmd.slice(1),
    '--config-dir', fixtureConfig(),
    '--provider', 'stub',
    '--model', STUB_MODEL,
    '--session-dir', sessionDir,
    '--silent',
    ...(cwd === undefined ? [] : ['--cwd', cwd]),
    ...args,
    'do the thing',
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MINIHARNESS_EXTRA_PROVIDER: STUB_PATH,
      MINIHARNESS_BASH_CAPTURE: capture,
      ...(command === undefined ? {} : { MINIHARNESS_BASH_COMMAND: command }),
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  let turns = [];
  try {
    turns = JSON.parse(readFileSync(capture, 'utf8'));
  } catch {
    turns = [];
  }
  return { status, stdout, stderr, turns };
}

/** Minimal MCP endpoint exposing one named tool, mirroring tests/mcp.test.mjs. */
function mcpFixture(name) {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    const result = message.method === 'server/discover'
      ? { resultType: 'complete', capabilities: { tools: {} } }
      : message.method === 'tools/list'
        ? {
            tools: [{
              name,
              description: `fixture ${name}`,
              inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
            }],
          }
        : { content: [{ type: 'text', text: 'fixture result' }], isError: false };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, url: `http://127.0.0.1:${server.address().port}/mcp` });
  }));
}

test('no tools are exposed without --allow-bash', async () => {
  const run = await runStub([]);
  assert.equal(run.status, 0);
  assert.ok(run.turns.length > 0, 'the provider stub was never called');
  assert.deepEqual(run.turns[0].tools, []);
});

test('--allow-bash exposes exactly one tool named bash', async () => {
  const run = await runStub(['--allow-bash']);
  assert.equal(run.status, 0);
  assert.deepEqual(run.turns[0].tools, ['bash']);
});

test('the model can run a command and receives its output', async () => {
  const run = await runStub(['--allow-bash'], { command: 'echo hello-from-bash' });
  assert.equal(run.status, 0);
  assert.ok(run.turns.length >= 2, 'the loop never fed a tool result back');
  assert.match(run.turns[1].messages, /hello-from-bash/);
});

test('commands run in --cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-bash-cwd-'));
  const run = await runStub(['--allow-bash'], { command: 'pwd', cwd: dir });
  assert.equal(run.status, 0);
  assert.ok(run.turns.length >= 2, 'the loop never fed a tool result back');
  // macOS resolves /var -> /private/var, so match the unique suffix.
  assert.match(run.turns[1].messages, new RegExp(dir.split('/').pop()));
});

test('a nonzero exit is reported to the model rather than failing the summon', async () => {
  const run = await runStub(['--allow-bash'], { command: 'exit 3' });
  assert.equal(run.status, 0);
  assert.ok(run.turns.length >= 2, 'the loop never fed a tool result back');
});

test('--allow-bash fails closed against an MCP tool named bash', async () => {
  const fixture = await mcpFixture('bash');
  try {
    const run = await runStub(['--allow-bash', '--mcp-server', `host=${fixture.url}`, '--mcp-tool', 'bash']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /conflicts with an MCP tool named bash/);
  } finally {
    fixture.server.close();
  }
});

test('--allow-bash coexists with unrelated MCP tools', async () => {
  const fixture = await mcpFixture('query_activity');
  try {
    const run = await runStub([
      '--allow-bash',
      '--mcp-server', `host=${fixture.url}`,
      '--mcp-tool', 'query_activity',
    ]);
    assert.equal(run.status, 0);
    assert.deepEqual(run.turns[0].tools, ['query_activity', 'bash']);
  } finally {
    fixture.server.close();
  }
});
