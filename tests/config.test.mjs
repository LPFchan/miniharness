/**
 * Slice D unit tests: models.json consumer + provider/model/effort
 * resolution. Ungated: no network, no credentials, no live providers.
 *
 * The fixture at tests/fixture-models.json is the 2026-08-08 registry
 * projection (6 enabled providers, 2 with default_model + tiers). All
 * error paths are asserted against the fixture; synthetic configs are
 * written to tmp dirs for the file-level errors (missing file, malformed
 * JSON, schema violations).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  loadConfig,
  resolveConfigDir,
  resolveEffort,
  resolveModel,
  resolveProvider,
  TIER_NAMES,
} from "../dist/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixture-models.json");

function fixtureConfig() {
  return loadConfig(fixtureDir());
}

/** Materialize the fixture file into a tmp config dir as models.json. */
function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "miniharness-fixture-"));
  copyFileSync(FIXTURE, join(dir, "models.json"));
  return dir;
}

/** Write a synthetic config dir and return its path. */
function tmpConfigDir(contents) {
  const dir = mkdtempSync(join(tmpdir(), "miniharness-config-"));
  if (contents !== undefined) writeFileSync(join(dir, "models.json"), contents);
  return dir;
}

const COMMANDCODE = "commandcode";
const KIMICODE = "kimicode";

test("fixture loads: eight enrolled providers, four with tiers/defaults", () => {
  const config = fixtureConfig();
  const names = Object.keys(config.providers).sort();
  assert.deepEqual(names, ["anthropic", "codex", "commandcode", "crofai", "deepseek", "grimoire", "kimicode", "meta"]);
  assert.equal(config.providers.anthropic.default_model, "claude-sonnet-5");
  assert.equal(config.providers.anthropic.tiers.haiku, "claude-haiku-4-5");
  assert.equal(config.providers.codex.default_model, "gpt-5.6-sol");
  assert.equal(config.providers[COMMANDCODE].default_model, "xiaomi/mimo-v2.5-pro");
  assert.deepEqual(config.providers[COMMANDCODE].tiers, {
    haiku: "MiniMaxAI/MiniMax-M3",
    sonnet: "xiaomi/mimo-v2.5-pro",
    opus: "moonshotai/Kimi-K3",
  });
  assert.equal(config.providers[KIMICODE].default_model, "k3");
  assert.equal(config.providers.grimoire.base_url, "https://chat.lost.plus/v1");
});

test("tier names are exactly haiku/sonnet/opus", () => {
  assert.deepEqual(TIER_NAMES, ["haiku", "sonnet", "opus"]);
});

test("resolveModel: explicit id resolves with catalogue merge", () => {
  const config = fixtureConfig();
  const resolved = resolveModel(config, KIMICODE, "k3");
  assert.equal(resolved.modelSource, "explicit");
  assert.equal(resolved.tier, undefined);
  assert.equal(resolved.modelSpec, "k3");
  assert.equal(resolved.model.id, "k3");
  assert.equal(resolved.model.provider, KIMICODE);
  // Registry enrollment overrides the catalogue's baseUrl.
  assert.equal(resolved.model.baseUrl, "https://api.kimi.com/coding/v1");
  // Catalogue capability data merged by model id.
  assert.equal(resolved.model.reasoning, true);
  assert.equal(typeof resolved.model.contextWindow, "number");
  assert.deepEqual(resolved.model.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  });
});

test("resolveModel: tier resolves through the provider tier map", () => {
  const config = fixtureConfig();
  const resolved = resolveModel(config, COMMANDCODE, "sonnet");
  assert.equal(resolved.modelSource, "tier");
  assert.equal(resolved.tier, "sonnet");
  assert.equal(resolved.modelSpec, "xiaomi/mimo-v2.5-pro");
  assert.equal(resolved.model.id, "xiaomi/mimo-v2.5-pro");
  assert.equal(resolved.model.provider, COMMANDCODE);
  assert.equal(resolved.model.baseUrl, "https://api.commandcode.ai/provider/v1");
});

test("resolveModel: every tier of both tiered providers resolves", () => {
  const config = fixtureConfig();
  for (const provider of [COMMANDCODE, KIMICODE]) {
    for (const tier of TIER_NAMES) {
      const resolved = resolveModel(config, provider, tier);
      assert.equal(resolved.tier, tier);
      assert.equal(resolved.model.id, config.providers[provider].tiers[tier]);
      assert.equal(resolved.model.provider, provider);
      assert.equal(resolved.model.baseUrl, config.providers[provider].base_url);
    }
  }
});

test("resolveModel: omitted model uses the provider default_model", () => {
  const config = fixtureConfig();
  const resolved = resolveModel(config, KIMICODE, undefined);
  assert.equal(resolved.modelSource, "default");
  assert.equal(resolved.tier, undefined);
  assert.equal(resolved.modelSpec, "k3");
  assert.equal(resolved.model.id, "k3");
  assert.equal(resolved.model.provider, KIMICODE);
});

test("resolveModel: explicit id resolves through the catalogue (deepseek)", () => {
  const config = fixtureConfig();
  // deepseek is enrolled with an empty models array; the id resolves via
  // pi's builtin catalogue (deepseek-v4-flash), merged with the registry
  // enrollment.
  const resolved = resolveModel(config, "deepseek", "deepseek-v4-flash");
  assert.equal(resolved.modelSource, "explicit");
  assert.equal(resolved.model.id, "deepseek-v4-flash");
  assert.equal(resolved.model.provider, "deepseek");
  assert.equal(resolved.model.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(typeof resolved.model.contextWindow, "number");
  assert.ok(Array.isArray(resolved.model.input));
});

test("resolveModel: unknown provider lists the enrolled set", () => {
  const config = fixtureConfig();
  assert.throws(
    () => resolveModel(config, "nope", "k3"),
    (error) =>
      error instanceof ConfigError &&
      /provider "nope" is not enrolled/.test(error.message) &&
      error.message.includes("commandcode") &&
      error.message.includes("kimicode"),
  );
});

test("resolveModel: unknown explicit model is an error", () => {
  const config = fixtureConfig();
  assert.throws(
    () => resolveModel(config, KIMICODE, "not-a-real-model"),
    (error) => error instanceof ConfigError && /unknown model/.test(error.message),
  );
});

test("resolveModel: unknown tier on a tierless provider is an error naming the tier map", () => {
  const config = fixtureConfig();
  assert.throws(
    () => resolveModel(config, "crofai", "sonnet"),
    (error) =>
      error instanceof ConfigError &&
      /has no tier map/.test(error.message) &&
      /explicit model id/.test(error.message),
  );
});

test("resolveModel: tier name on a tiered provider with no matching tier is an error", () => {
  const config = fixtureConfig();
  const provider = {
    ...config.providers[COMMANDCODE],
    tiers: { haiku: "MiniMaxAI/MiniMax-M3" }, // sonnet/opus dropped
  };
  const synthetic = { providers: { [COMMANDCODE]: provider } };
  assert.throws(
    () => resolveModel(synthetic, COMMANDCODE, "opus"),
    (error) => error instanceof ConfigError && /has no opus tier/.test(error.message),
  );
});

test("resolveModel: omitted model on a provider without default_model is an error with tier hint", () => {
  const config = fixtureConfig();
  assert.throws(
    () => resolveModel(config, "crofai", undefined),
    (error) =>
      error instanceof ConfigError &&
      /has no default_model/.test(error.message) &&
      /--model/.test(error.message),
  );
});

test("resolveProvider: enrolled provider returns its entry; unknown lists names", () => {
  const config = fixtureConfig();
  assert.equal(resolveProvider(config, KIMICODE).default_model, "k3");
  assert.throws(
    () => resolveProvider(config, "nope"),
    (error) => error instanceof ConfigError && /not enrolled/.test(error.message),
  );
});

test("resolveEffort: supported level passes; unsupported level names the supported set", () => {
  const config = fixtureConfig();
  const k3 = resolveModel(config, KIMICODE, "k3");
  assert.equal(resolveEffort(k3, "low"), "low");
  assert.equal(resolveEffort(k3, "high"), "high");
  assert.throws(
    () => resolveEffort(k3, "minimal"),
    (error) =>
      error instanceof ConfigError &&
      /does not support effort "minimal"/.test(error.message) &&
      /low, high, max/.test(error.message),
  );
  assert.throws(
    () => resolveEffort(k3, "medium"),
    (error) => error instanceof ConfigError && /low, high, max/.test(error.message),
  );
});

test("resolveEffort: kimi-for-coding's tlm-less catalogue entry follows pi's supported set", () => {
  const config = fixtureConfig();
  const resolved = resolveModel(config, KIMICODE, "kimi-for-coding");
  // kimi-for-coding has no thinkingLevelMap in pi's catalogue; the
  // library's getSupportedThinkingLevels then reports the full default set
  // for a reasoning model (off..high).
  assert.equal(resolveEffort(resolved, "off"), "off");
  assert.equal(resolveEffort(resolved, "low"), "low");
  assert.equal(resolveEffort(resolved, "high"), "high");
  assert.throws(
    () => resolveEffort(resolved, "max"),
    (error) => error instanceof ConfigError && /does not support effort "max"/.test(error.message),
  );
});

test("resolveEffort: omitted effort defaults to the library default (off)", () => {
  const config = fixtureConfig();
  const resolved = resolveModel(config, KIMICODE, "k3");
  assert.equal(resolveEffort(resolved, undefined), "off");
});

test("resolveEffort: unknown level name is an error", () => {
  const config = fixtureConfig();
  const resolved = resolveModel(config, KIMICODE, "k3");
  assert.throws(
    () => resolveEffort(resolved, "turbo"),
    (error) => error instanceof ConfigError && /valid: off, minimal/.test(error.message),
  );
});

test("loadConfig: missing config file is a ConfigError", () => {
  const dir = tmpConfigDir(undefined);
  assert.throws(
    () => loadConfig(dir),
    (error) => error instanceof ConfigError && /cannot read/.test(error.message),
  );
});

test("loadConfig: malformed JSON is a ConfigError", () => {
  const dir = tmpConfigDir("{ not json");
  assert.throws(
    () => loadConfig(dir),
    (error) => error instanceof ConfigError && /invalid JSON/.test(error.message),
  );
});

test("loadConfig: missing providers map is a ConfigError", () => {
  const dir = tmpConfigDir(JSON.stringify({ version: 1 }));
  assert.throws(
    () => loadConfig(dir),
    (error) => error instanceof ConfigError && /"providers"/.test(error.message),
  );
});

test("loadConfig: non-object root is a ConfigError", () => {
  const dir = tmpConfigDir("[1,2,3]");
  assert.throws(
    () => loadConfig(dir),
    (error) => error instanceof ConfigError && /JSON object/.test(error.message),
  );
});

test("loadConfig: non-object provider entries are tolerated (normalized)", () => {
  const dir = tmpConfigDir(JSON.stringify({ providers: { crofai: null, meta: 42 } }));
  const config = loadConfig(dir);
  assert.deepEqual(Object.keys(config.providers), ["crofai", "meta"]);
});

test("resolveConfigDir precedence: flag > env > default", () => {
  assert.equal(resolveConfigDir("/flag", {}), "/flag");
  assert.equal(resolveConfigDir(undefined, { PI_CODING_AGENT_DIR: "/env" }), "/env");
  assert.equal(resolveConfigDir("", { PI_CODING_AGENT_DIR: "/env" }), "/env");
  const dir = resolveConfigDir(undefined, {});
  assert.ok(dir.endsWith(join(".pi", "agent")), `default dir should be ~/.pi/agent, got ${dir}`);
});

test("resolveModel: explicit id on a provider that has no catalogue entry but a file entry", () => {
  // Synthesize a provider whose models array carries a full entry: the
  // fixture's empty arrays are the default, but the loader must honor one
  // when the generator starts emitting them.
  const dir = tmpConfigDir(
    JSON.stringify({
      providers: {
        acme: {
          base_url: "https://acme.example/v1",
          provider_type: "OpenAICompatible",
          default_model: "acme/small",
          tiers: { haiku: "acme/tiny", sonnet: "acme/small", opus: "acme/big" },
          models: [
            {
              id: "acme/small",
              reasoning: true,
              thinkingLevelMap: { off: "none", low: "low", high: "high" },
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
            },
          ],
        },
      },
    }),
  );
  const config = loadConfig(dir);
  const resolved = resolveModel(config, "acme", "sonnet");
  assert.equal(resolved.model.id, "acme/small");
  assert.equal(resolved.model.baseUrl, "https://acme.example/v1");
  assert.equal(resolved.model.thinkingLevelMap.off, "none");
  assert.equal(resolved.model.contextWindow, 200000);
  // Fixture file entry wins over the catalogue for declared fields.
  assert.equal(resolveEffort(resolved, "low"), "low");
  // Absent map keys are provider defaults (supported); only xhigh/max need
  // an explicit mapping per pi's getSupportedThinkingLevels.
  assert.equal(resolveEffort(resolved, "medium"), "medium");
  assert.throws(
    () => resolveEffort(resolved, "xhigh"),
    (error) => error instanceof ConfigError && /does not support effort "xhigh"/.test(error.message),
  );
});

test("ConfigError is the single typed error family", () => {
  const config = fixtureConfig();
  const failures = [
    () => loadConfig(tmpConfigDir(undefined)),
    () => resolveProvider(config, "nope"),
    () => resolveModel(config, "nope", "k3"),
    () => resolveModel(config, "crofai", "sonnet"),
    () => resolveEffort(resolveModel(config, KIMICODE, "k3"), "minimal"),
  ];
  for (const fn of failures) {
    try {
      fn();
      assert.fail("expected a ConfigError");
    } catch (error) {
      assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error}`);
      assert.equal(typeof error.message, "string");
      assert.ok(error.message.length > 0);
      assert.ok(!error.message.includes("\n"), "error messages must be one line");
    }
  }
});

test("resolveModel: model carries the registry provider name for routing", () => {
  const config = fixtureConfig();
  const resolved = resolveModel(config, KIMICODE, "k3");
  assert.equal(resolved.model.provider, "kimicode");
  // The pi provider that actually streams it (kimi-coding) is available in
  // the catalogue; the routed name stays the registry name per the DEC.
});

test("custom OpenAI-compatible providers resolve explicit models from config without /models discovery", () => {
  const config = {
    providers: {
      cloudflare: {
        base_url: "https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1",
        provider_type: "OpenAICompatible",
        models: [{
          id: "@cf/zai-org/glm-4.7-flash",
          name: "GLM 4.7 Flash",
          reasoning: false,
          contextWindow: 131072,
          maxTokens: 8192,
          cost: { input: 0, output: 0 },
        }],
      },
    },
  };
  const resolved = resolveModel(config, "cloudflare", "@cf/zai-org/glm-4.7-flash");
  assert.equal(resolved.model.provider, "cloudflare");
  assert.equal(resolved.model.baseUrl, config.providers.cloudflare.base_url);
  assert.equal(resolved.model.contextWindow, 131072);
  assert.equal(resolved.model.reasoning, false);
});
