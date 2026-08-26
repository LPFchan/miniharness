import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputManifestError, readInputManifest } from '../dist/input-manifest.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STUB_PATH = join(REPO_ROOT, 'tests', 'gen-params-stub.mjs');
const STUB_MODEL = 'stub-generation-params';
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x01, 0x02, 0x03, 0x04,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);

function writeImage(dir, name, bytes) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

function manifest(dir, parts) {
  const path = join(dir, 'input.json');
  writeFileSync(path, JSON.stringify({ version: 1, parts }));
  return path;
}

function imagePart(path, bytes, media_type = 'image/png') {
  return {
    type: 'image',
    path,
    media_type,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function assertManifestError(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof InputManifestError, `expected InputManifestError, got ${error}`);
    assert.match(error.message, pattern);
    return true;
  });
}

function harnessCommand() {
  return (process.env.MINIHARNESS_BIN ?? 'node dist/cli.js').split(/\s+/).filter(Boolean);
}

function runHarness(args, { input, env = process.env } = {}) {
  const command = harnessCommand();
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd: REPO_ROOT,
    input,
    encoding: 'utf8',
    env,
  });
  if (result.status === null) throw result.error ?? new Error('harness did not exit');
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function fixtureConfig(dir) {
  writeFileSync(join(dir, 'models.json'), JSON.stringify({
    version: 1,
    providers: {
      stub: {
        base_url: 'http://stub.local/v1',
        default_model: STUB_MODEL,
        models: [{ id: STUB_MODEL, name: STUB_MODEL, reasoning: false, contextWindow: 128000, maxTokens: 8192 }],
      },
    },
  }));
}

test('manifest materialization preserves ordered text/image parts and exact image bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-manifest-unit-'));
  const image = writeImage(dir, 'sample.png', PNG);
  const message = readInputManifest(manifest(dir, [
    { type: 'text', text: 'before' },
    imagePart(image, PNG),
    { type: 'text', text: 'after' },
  ]));
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content.map((part) => part.type), ['text', 'image', 'text']);
  assert.equal(message.content[0].text, 'before');
  assert.equal(message.content[2].text, 'after');
  assert.equal(message.content[1].mimeType, 'image/png');
  assert.equal(Buffer.from(message.content[1].data, 'base64').equals(PNG), true);
});

test('manifest rejects unknown fields, empty parts, empty text, and missing required image fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-manifest-schema-'));
  const image = writeImage(dir, 'sample.png', PNG);
  const rootWithUnknown = join(dir, 'root-unknown.json');
  writeFileSync(rootWithUnknown, JSON.stringify({ version: 1, parts: [{ type: 'text', text: 'ok' }], extra: true }));
  assertManifestError(() => readInputManifest(rootWithUnknown), /unknown field/);
  const wrongVersion = join(dir, 'wrong-version.json');
  writeFileSync(wrongVersion, JSON.stringify({ version: 2, parts: [{ type: 'text', text: 'ok' }] }));
  assertManifestError(() => readInputManifest(wrongVersion), /version must be 1/);
  assertManifestError(() => readInputManifest(manifest(dir, [{ type: 'text', text: 'ok', extra: true }])), /unknown field/);
  assertManifestError(() => readInputManifest(manifest(dir, [])), /non-empty array/);
  assertManifestError(() => readInputManifest(manifest(dir, [{ type: 'text', text: '' }])), /non-empty string/);
  assertManifestError(() => readInputManifest(manifest(dir, [{ type: 'image', path: image }])), /media_type/);
  assertManifestError(() => readInputManifest(manifest(dir, [{ type: 'wat', text: 'x' }])), /text or image/);
});

test('manifest rejects bad hashes, MIME/signature mismatches, and empty images', () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-manifest-bytes-'));
  const image = writeImage(dir, 'sample.png', PNG);
  const part = imagePart(image, PNG);
  assertManifestError(() => readInputManifest(manifest(dir, [{ ...part, sha256: part.sha256.toUpperCase() }])), /lowercase hex/);
  assertManifestError(() => readInputManifest(manifest(dir, [{ ...part, sha256: '0'.repeat(64) }])), /sha256 mismatch/);
  assertManifestError(() => readInputManifest(manifest(dir, [{ ...part, media_type: 'image/jpeg' }])), /signature/);
  const empty = writeImage(dir, 'empty.png', Buffer.alloc(0));
  assertManifestError(() => readInputManifest(manifest(dir, [imagePart(empty, Buffer.alloc(0))])), /empty/);
  const jpeg = writeImage(dir, 'sample.jpg', JPEG);
  const jpegMessage = readInputManifest(manifest(dir, [imagePart(jpeg, JPEG, 'image/jpeg')]));
  assert.equal(jpegMessage.content[0].mimeType, 'image/jpeg');
});

test('manifest rejects URLs, data URIs, relative paths, and symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-manifest-paths-'));
  assertManifestError(() => readInputManifest(manifest(dir, [imagePart('https://example.test/a.png', PNG)])), /URL or data URI/);
  assertManifestError(() => readInputManifest(manifest(dir, [imagePart('data:image/png;base64,AA==', PNG)])), /URL or data URI/);
  assertManifestError(() => readInputManifest(manifest(dir, [imagePart('sample.png', PNG)])), /absolute/);
  const image = writeImage(dir, 'sample.png', PNG);
  const link = join(dir, 'link.png');
  symlinkSync(image, link);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assertManifestError(() => readInputManifest(manifest(dir, [imagePart(link, PNG)])), /symlink/);
  assertManifestError(() => readInputManifest(manifest(dir, [imagePart(dir, PNG)])), /regular file/);
});

test('invalid manifest is rejected before session or provider contact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-manifest-preflight-'));
  const bad = manifest(dir, [{ type: 'image', path: join(dir, 'missing.png'), media_type: 'image/png', sha256: '0'.repeat(64) }]);
  const sessionDir = join(dir, 'sessions');
  const missingProvider = join(dir, 'provider-that-must-not-load.mjs');
  const result = runHarness([
    '--config-dir', dir,
    '--provider', 'stub',
    '--model', STUB_MODEL,
    '--session-dir', sessionDir,
    '--input-manifest', bad,
  ], {
    env: { ...process.env, MINIHARNESS_EXTRA_PROVIDER: missingProvider },
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /cannot read image/);
  assert.equal(existsSync(sessionDir), false);
});

test('manifest cannot be combined with positional or stdin prompt sources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-manifest-conflicts-'));
  const input = manifest(dir, [{ type: 'text', text: 'manifest prompt' }]);
  const positional = runHarness(['--input-manifest', input, 'also positional']);
  assert.equal(positional.status, 2);
  assert.match(positional.stderr, /positional prompt/);
  const stdin = runHarness(['--input-manifest', input], { input: 'stdin prompt' });
  assert.equal(stdin.status, 2);
  assert.match(stdin.stderr, /stdin prompt/);
});

test('summon sends materialized manifest content through Pi in order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-manifest-transport-'));
  fixtureConfig(dir);
  const image = writeImage(dir, 'sample.png', PNG);
  const input = manifest(dir, [
    { type: 'text', text: 'before' },
    imagePart(image, PNG),
    { type: 'text', text: 'after' },
  ]);
  const capture = join(dir, 'capture.json');
  const result = runHarness([
    '--config-dir', dir,
    '--provider', 'stub',
    '--model', STUB_MODEL,
    '--no-session',
    '--input-manifest', input,
  ], {
    env: {
      ...process.env,
      MINIHARNESS_EXTRA_PROVIDER: STUB_PATH,
      MINIHARNESS_GEN_PARAMS_CAPTURE: capture,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const request = JSON.parse(readFileSync(capture, 'utf8'));
  const user = request.context.messages.find((message) => message.role === 'user');
  assert.ok(user);
  assert.deepEqual(user.content.map((part) => part.type), ['text', 'image', 'text']);
  assert.equal(user.content[0].text, 'before');
  assert.equal(user.content[2].text, 'after');
  assert.equal(Buffer.from(user.content[1].data, 'base64').equals(PNG), true);
});
