/**
 * DEC-20260921-002: registry enrollment beats Pi's bundled provider
 * definitions, credentials resolve by declared auth_key, and registry headers
 * reach the model.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { loadConfig, registerCustomProviders, resolveConfig } from '../dist/config.js';

function configDir(providers) {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-resolution-'));
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ version: 1, providers }));
  return dir;
}

function authFile(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'miniharness-resolution-auth-'));
  const path = join(dir, 'auth.json');
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

function register(providers, auth) {
  const models = createModels({});
  for (const provider of builtinProviders()) models.setProvider(provider);
  registerCustomProviders(models, loadConfig(configDir(providers)), auth);
  return models;
}

const OPENAI_COMPATIBLE = { provider_type: 'OpenAICompatible' };

test('a registry provider overrides a Pi builtin of the same id', () => {
  const builtinIds = builtinProviders().map((p) => p.id);
  assert.ok(builtinIds.includes('openrouter'), 'fixture assumes openrouter is a Pi builtin');

  const models = register(
    { openrouter: { ...OPENAI_COMPATIBLE, base_url: 'https://registry.example/v1' } },
    authFile({ openrouter: { key: 'from-setup-store' } }),
  );
  assert.equal(models.getProvider('openrouter').baseUrl, 'https://registry.example/v1');
});

test('a provider Pi does not ship is still registered', () => {
  const models = register(
    { crofai: { ...OPENAI_COMPATIBLE, base_url: 'https://crof.example/v1' } },
    authFile({ crofai: { key: 'k' } }),
  );
  assert.equal(models.getProvider('crofai').baseUrl, 'https://crof.example/v1');
});

test('credentials resolve by declared auth_key, not provider name', async () => {
  // Two enrollments, one shared stored key — the OpenCode Go/Zen shape.
  const auth = authFile({ 'opencode-go': { key: 'shared-secret' } });
  const models = register(
    {
      'opencode-zen': {
        ...OPENAI_COMPATIBLE,
        base_url: 'https://opencode.example/zen/v1',
        auth_key: 'opencode-go',
      },
    },
    auth,
  );
  const resolution = await models.getAuth('opencode-zen');
  assert.ok(resolution, 'auth did not resolve through auth_key');
  assert.equal(resolution.auth.apiKey, 'shared-secret');
});

test('without auth_key the provider name is the credential name', async () => {
  const models = register(
    { kimicode: { ...OPENAI_COMPATIBLE, base_url: 'https://kimi.example/v1' } },
    authFile({ kimicode: { key: 'kimi-secret' } }),
  );
  const resolution = await models.getAuth('kimicode');
  assert.equal(resolution.auth.apiKey, 'kimi-secret');
});

test('a missing credential resolves to nothing rather than throwing', async () => {
  const models = register(
    { meta: { ...OPENAI_COMPATIBLE, base_url: 'https://meta.example/v1' } },
    authFile({ somethingelse: { key: 'x' } }),
  );
  assert.equal(await models.getAuth('meta'), undefined);
});

test('registry headers reach the model with {session_id} substituted', () => {
  const dir = configDir({
    'opencode-go': {
      ...OPENAI_COMPATIBLE,
      base_url: 'https://opencode.example/zen/go/v1',
      default_model: 'some-model',
      models: [{ id: 'some-model', name: 'some-model', contextWindow: 1000, maxTokens: 100 }],
      headers: { 'x-opencode-session': '{session_id}', 'x-static': 'kept' },
    },
  });
  const resolved = resolveConfig(dir, { provider: 'opencode-go', sessionId: 'sess-42' });
  assert.equal(resolved.model.headers['x-opencode-session'], 'sess-42');
  assert.equal(resolved.model.headers['x-static'], 'kept');
});

test('a session-templated header is dropped when the summon has no session', () => {
  const dir = configDir({
    'opencode-go': {
      ...OPENAI_COMPATIBLE,
      base_url: 'https://opencode.example/zen/go/v1',
      default_model: 'some-model',
      models: [{ id: 'some-model', name: 'some-model', contextWindow: 1000, maxTokens: 100 }],
      headers: { 'x-opencode-session': '{session_id}', 'x-static': 'kept' },
    },
  });
  const resolved = resolveConfig(dir, { provider: 'opencode-go' });
  assert.equal(resolved.model.headers?.['x-opencode-session'], undefined);
  assert.equal(resolved.model.headers['x-static'], 'kept');
});

test('an OpenAI-compatible enrollment overrides a catalogue transport', () => {
  // Pi bundles kimi models as anthropic-messages, but the registry enrolls
  // kimicode as an OpenAI-compatible endpoint, which is what gets wired.
  const catalogueModel = builtinProviders()
    .flatMap((p) => p.getModels?.() ?? [])
    .find((m) => m.api !== 'openai-completions');
  assert.ok(catalogueModel, 'fixture assumes the catalogue has a non-openai-completions model');

  const dir = configDir({
    [catalogueModel.provider]: {
      ...OPENAI_COMPATIBLE,
      base_url: 'https://registry.example/v1',
      default_model: catalogueModel.id,
    },
  });
  const resolved = resolveConfig(dir, { provider: catalogueModel.provider });
  assert.equal(resolved.model.api, 'openai-completions');
  assert.equal(resolved.model.baseUrl, 'https://registry.example/v1');
});
