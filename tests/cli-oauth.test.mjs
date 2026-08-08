/**
 * DEC-20260808-002 tests: CLI OAuth credential reuse.
 *
 * Ungated — synthetic credential files in tmp dirs, no network, no real
 * CLI logins touched (env overrides point the readers at the tmp files).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliOAuthCredentialStore } from "../dist/cli-oauth.js";
import { registerCliOAuthProviders } from "../dist/config.js";
import { createModels } from "@earendil-works/pi-ai";

/** Env overrides this suite mutates; cleared after each test. */
const OVERRIDE_VARS = ["MINIHARNESS_CLAUDE_CREDENTIALS_FILE", "MINIHARNESS_CODEX_AUTH_FILE"];

function clearOverrides() {
  for (const name of OVERRIDE_VARS) delete process.env[name];
}

function tmpdir_(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeClaudeCredentials(dir, oauth) {
  const file = join(dir, ".credentials.json");
  writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }));
  return file;
}

function writeCodexAuth(dir, tokens) {
  const file = join(dir, "auth.json");
  writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: null, tokens }));
  return file;
}

const CLAUDE_OAUTH = {
  accessToken: "sk-ant-oat-access",
  refreshToken: "sk-ant-ort-refresh",
  expiresAt: 1800000000000,
  scopes: ["user:inference"],
  subscriptionType: "max",
};

const CODEX_TOKENS = {
  access_token: "codex-access",
  refresh_token: "codex-refresh",
  account_id: "acct-123",
  id_token: "id",
};

test("reads Claude Code credentials into the pi-ai oauth shape", async () => {
  const dir = tmpdir_("miniharness-claude-");
  process.env.MINIHARNESS_CLAUDE_CREDENTIALS_FILE = writeClaudeCredentials(dir, CLAUDE_OAUTH);
  const store = new CliOAuthCredentialStore();
  const credential = await store.read("anthropic");
  assert.deepEqual(credential, {
    type: "oauth",
    access: "sk-ant-oat-access",
    refresh: "sk-ant-ort-refresh",
    expires: 1800000000000,
  });
});

test("reads Codex CLI auth.json with zero expiry so first use refreshes", async () => {
  const dir = tmpdir_("miniharness-codex-");
  process.env.MINIHARNESS_CODEX_AUTH_FILE = writeCodexAuth(dir, CODEX_TOKENS);
  const store = new CliOAuthCredentialStore();
  const credential = await store.read("codex");
  assert.equal(credential.type, "oauth");
  assert.equal(credential.access, "codex-access");
  assert.equal(credential.refresh, "codex-refresh");
  assert.equal(credential.accountId, "acct-123");
  assert.equal(credential.expires, 0);
});

test("defensive reads: missing file, malformed JSON, missing fields all resolve undefined", async () => {
  const dir = tmpdir_("miniharness-defensive-");
  const store = new CliOAuthCredentialStore();

  process.env.MINIHARNESS_CLAUDE_CREDENTIALS_FILE = join(dir, "absent.json");
  assert.equal(await store.read("anthropic"), undefined);

  const malformed = join(dir, "malformed.json");
  writeFileSync(malformed, "{not json");
  process.env.MINIHARNESS_CLAUDE_CREDENTIALS_FILE = malformed;
  assert.equal(await store.read("anthropic"), undefined);

  const missing = join(dir, "missing-fields.json");
  writeFileSync(missing, JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
  process.env.MINIHARNESS_CLAUDE_CREDENTIALS_FILE = missing;
  assert.equal(await store.read("anthropic"), undefined);

  // Point both readers at absent files so list() cannot see the host's
  // real CLI logins (the suite shares process.env with other test files).
  process.env.MINIHARNESS_CLAUDE_CREDENTIALS_FILE = join(dir, "absent.json");
  process.env.MINIHARNESS_CODEX_AUTH_FILE = join(dir, "absent.json");
  assert.equal(await store.read("some-other-provider"), undefined);
  assert.deepEqual(await store.list(), []);

  clearOverrides();
});

test("modify writes rotated Claude tokens back, preserving unrelated fields", async () => {
  const dir = tmpdir_("miniharness-claude-write-");
  const file = writeClaudeCredentials(dir, CLAUDE_OAUTH);
  process.env.MINIHARNESS_CLAUDE_CREDENTIALS_FILE = file;
  const store = new CliOAuthCredentialStore();

  const rotated = await store.modify("anthropic", async (current) => ({
    ...current,
    access: "sk-ant-oat-rotated",
    refresh: "sk-ant-ort-rotated",
    expires: 1900000000000,
  }));
  assert.equal(rotated.access, "sk-ant-oat-rotated");

  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.claudeAiOauth.accessToken, "sk-ant-oat-rotated");
  assert.equal(onDisk.claudeAiOauth.refreshToken, "sk-ant-ort-rotated");
  assert.equal(onDisk.claudeAiOauth.expiresAt, 1900000000000);
  assert.equal(onDisk.claudeAiOauth.subscriptionType, "max");
});

test("modify writes rotated Codex tokens back, preserving account_id and siblings", async () => {
  const dir = tmpdir_("miniharness-codex-write-");
  const file = writeCodexAuth(dir, CODEX_TOKENS);
  process.env.MINIHARNESS_CODEX_AUTH_FILE = file;
  const store = new CliOAuthCredentialStore();

  await store.modify("codex", async (current) => ({
    ...current,
    access: "codex-rotated",
    refresh: "codex-refresh-rotated",
    expires: 1900000000000,
  }));

  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.tokens.access_token, "codex-rotated");
  assert.equal(onDisk.tokens.refresh_token, "codex-refresh-rotated");
  assert.equal(onDisk.tokens.account_id, "acct-123");
  assert.equal(onDisk.tokens.id_token, "id");
  assert.equal(onDisk.OPENAI_API_KEY, null);
});

test("modify returning undefined (already refreshed) writes nothing", async () => {
  const dir = tmpdir_("miniharness-noop-");
  const file = writeClaudeCredentials(dir, CLAUDE_OAUTH);
  process.env.MINIHARNESS_CLAUDE_CREDENTIALS_FILE = file;
  const before = readFileSync(file, "utf8");
  const store = new CliOAuthCredentialStore();
  const result = await store.modify("anthropic", async () => undefined);
  assert.equal(result.access, "sk-ant-oat-access");
  assert.equal(readFileSync(file, "utf8"), before);
});

test("modify never throws when write-back fails", async () => {
  const dir = tmpdir_("miniharness-unwritable-");
  // Point write-back at a path whose parent is a file: rename must fail.
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "x");
  process.env.MINIHARNESS_CLAUDE_CREDENTIALS_FILE = join(blocker, "sub", ".credentials.json");
  const store = new CliOAuthCredentialStore();
  const rotated = await store.modify("anthropic", async () => ({
    type: "oauth",
    access: "a",
    refresh: "r",
    expires: 1,
  }));
  assert.equal(rotated.access, "a");
});

test("alias registration: codex routes through the openai-codex builtin under the registry id", () => {
  const dir = tmpdir_("miniharness-alias-");
  process.env.MINIHARNESS_CODEX_AUTH_FILE = writeCodexAuth(dir, CODEX_TOKENS);
  process.env.MINIHARNESS_CLAUDE_CREDENTIALS_FILE = join(dir, "absent.json");

  const models = createModels();
  registerCliOAuthProviders(models, { providers: { codex: {}, anthropic: {} } });

  const codex = models.getProvider("codex");
  assert.equal(codex.id, "codex");
  assert.ok(codex.auth.oauth, "alias keeps the builtin oauth auth");
  assert.ok(codex.getModels().length > 0, "alias keeps the builtin model catalogue");

  // anthropic's credential file is absent: no alias, builtin stays untouched.
  assert.equal(models.getProvider("anthropic"), undefined);
  clearOverrides();
});

test("alias registration: anthropic aliases its builtin when credentials exist", () => {
  const dir = tmpdir_("miniharness-alias-anthropic-");
  process.env.MINIHARNESS_CLAUDE_CREDENTIALS_FILE = writeClaudeCredentials(dir, CLAUDE_OAUTH);

  const models = createModels();
  registerCliOAuthProviders(models, { providers: { anthropic: {} } });
  const anthropic = models.getProvider("anthropic");
  assert.equal(anthropic.id, "anthropic");
  assert.ok(anthropic.auth.oauth);
  clearOverrides();
});

test("alias registration skips providers absent from the registry", () => {
  const dir = tmpdir_("miniharness-alias-skip-");
  process.env.MINIHARNESS_CODEX_AUTH_FILE = writeCodexAuth(dir, CODEX_TOKENS);
  const models = createModels();
  registerCliOAuthProviders(models, { providers: { crofai: {} } });
  assert.equal(models.getProvider("codex"), undefined);
  clearOverrides();
});
