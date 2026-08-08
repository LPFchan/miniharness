#!/usr/bin/env node
/**
 * models.json consumer + provider/model/effort resolution (slice D).
 *
 * DEC-20260808-001 ("CLI Summon Contract"): `--provider` names a provider
 * enrolled in the registry, `--model` names an explicit model id OR a
 * registry tier (`haiku`/`sonnet`/`opus`) resolved through that provider's
 * tier map, and `--effort` takes a thinking level validated against the
 * model's `thinkingLevelMap` from the generated `models.json`. The config
 * is consumed from `PI_CODING_AGENT_DIR` (setup-managed, generated from
 * the canonical registry); `--config-dir <path>` overrides. Omitted
 * provider/model/effort fall back to the provider's `default_model` (and
 * the library's default thinking level, `off`).
 *
 * Config dir precedence: `--config-dir` value > `PI_CODING_AGENT_DIR`
 * env > `~/.pi/agent/`. `~/.pi/agent/` is Pi's own default agent config
 * directory; the setup-side generator owns that seam (it will write the
 * generated `models.json` there). This module only reads it.
 *
 * The fixture's provider entries carry enrollment (`base_url`,
 * `provider_type`) and, where the registry defines them, `default_model`
 * and `tiers`. Per-model capability data (`thinkingLevelMap`, cost,
 * context window) comes from Pi's catalogue, merged by model id — the
 * registry projection intentionally ships empty `models` arrays (heatmap
 * RSH-20260808-001 Q1), so a model id absent from the file's `models`
 * arrays falls back to the built-in catalogue entry for that id.
 *
 * These functions are pure: no argv, no process.exit, no network, no
 * credentials. Every failure is a typed `ConfigError` whose `message` is a
 * one-line human string the CLI renders as DEC exit 2.
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

/** DEC tier names, in the registry's conventional order. */
export const TIER_NAMES = ["haiku", "sonnet", "opus"] as const;
export type TierName = (typeof TIER_NAMES)[number];

/** Registry tier map on a provider entry (`--model haiku|sonnet|opus`). */
export interface TierMap {
  haiku?: string;
  sonnet?: string;
  opus?: string;
}

/** One provider entry in the generated `models.json`. */
export interface ProviderEntry {
  base_url?: string;
  provider_type?: string;
  /** Per-model enrollment records (registry projection; often empty). */
  models?: Record<string, unknown>[];
  default_model?: string;
  tiers?: TierMap;
  /** Auth pointers for the setup generator's future use; not consumed here. */
  auth?: unknown;
  [key: string]: unknown;
}

/** `{ providers: { <name>: ProviderEntry } }`, as generated from the registry. */
export interface Config {
  providers: Record<string, ProviderEntry>;
}

/**
 * The result of resolving provider + model spec + effort.
 *
 * `model` is the concrete library `Model` the harness summons: its `id`
 * and `provider` are what `pi-ai`'s `Models.streamSimple` routes on
 * (`requireProvider(model.provider)` looks the provider up by this exact
 * id), so `provider` carries the registry provider name and `baseUrl` is
 * overridden from the registry enrollment.
 */
export interface ResolvedModel {
  providerName: string;
  provider: ProviderEntry;
  modelSpec: string;
  /** `explicit` | `tier` | `default` */
  modelSource: "explicit" | "tier" | "default";
  tier?: TierName;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
}

type Api = import("@earendil-works/pi-ai").Api;

/**
 * Every config resolution failure. `message` is one line, ready for the
 * CLI to render as DEC exit 2.
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Errors from loading or parsing the config file itself. */
export class ConfigFileError extends ConfigError {}

/** Errors from resolving a provider/model/effort against the config. */
export class ConfigResolutionError extends ConfigError {}

/** The model catalogue merged from Pi's builtin providers. */
export interface Catalogue {
  models: readonly Model<Api>[];
}

/**
 * Build the model catalogue from Pi's builtin providers. Static, sync, no
 * network: `createModels()` + `builtinProviders()` + `setProvider` is the
 * exact wiring `cli.ts` already uses, and `getModels()` is the synchronous
 * catalogue read (no `refresh()`). A registry provider that is not a pi
 * builtin id simply contributes no entries.
 */
export function createCatalogue(): Catalogue {
  const models = createModels();
  for (const provider of builtinProviders()) {
    models.setProvider(provider);
  }
  return { models: models.getModels() };
}

/**
 * Default config directory: `~/.pi/agent/` — Pi's own default agent
 * config directory, the seam the setup-side generator owns.
 */
export function defaultConfigDir(home: string = homedir()): string {
  return join(home, ".pi", "agent");
}

/**
 * Resolve the config directory: `--config-dir` value > `PI_CODING_AGENT_DIR`
 * env > `~/.pi/agent/`. The first argument is the flag value (undefined when
 * the flag is absent); it wins only when provided.
 */
export function resolveConfigDir(flagValue: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (flagValue !== undefined && flagValue !== "") return flagValue;
  const envDir = env.PI_CODING_AGENT_DIR;
  if (envDir !== undefined && envDir !== "") return envDir;
  return defaultConfigDir();
}

/**
 * Load and validate `<configDir>/models.json`. Missing file, invalid JSON,
 * and schema violations all throw `ConfigFileError` (a `ConfigError`).
 */
export function loadConfig(configDir: string): Config {
  let raw: string;
  try {
    raw = readFileSync(join(configDir, "models.json"), "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigFileError(
      `config: cannot read ${join(configDir, "models.json")}: ${detail}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigFileError(`config: invalid JSON in ${join(configDir, "models.json")}: ${detail}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigFileError(
      `config: ${join(configDir, "models.json")} must be a JSON object with a "providers" map`,
    );
  }

  const providers = (parsed as { providers?: unknown }).providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
    throw new ConfigFileError(
      `config: ${join(configDir, "models.json")} is missing a "providers" map`,
    );
  }

  // Normalize entries so downstream code always sees an object.
  const normalized: Record<string, ProviderEntry> = {};
  for (const [name, entry] of Object.entries(providers as Record<string, unknown>)) {
    normalized[name] =
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? (entry as ProviderEntry)
        : {};
  }
  return { providers: normalized };
}

/** Provider names from the config, sorted for stable error messages. */
export function providerNames(config: Config): string[] {
  return Object.keys(config.providers).sort();
}

/**
 * Resolve a provider by registry name. Unknown names throw
 * `ConfigResolutionError` listing the enrolled providers.
 */
export function resolveProvider(config: Config, name: string): ProviderEntry {
  const provider = config.providers[name];
  if (!provider) {
    const known = providerNames(config);
    const list = known.length === 0 ? "none enrolled" : `enrolled: ${known.join(", ")}`;
    throw new ConfigResolutionError(`provider "${name}" is not enrolled (${list})`);
  }
  return provider;
}

/**
 * Look up a model id across the merged catalogue. Pi's `getModel(provider,
 * id)` is scoped to one pi provider id; a registry provider name is not a
 * pi provider id, so scan all catalogue entries by id and prefer the first
 * whose `provider` is a builtin whose id matches the registry provider
 * name when one exists (e.g. `kimicode` -> `kimi-coding`).
 */
export function catalogueModel(catalogue: Catalogue, id: string, providerName: string): Model<Api> | undefined {
  const matches = catalogue.models.filter((model) => model.id === id);
  if (matches.length === 0) return undefined;
  const sameName = matches.find((model) => model.provider === providerName);
  return sameName ?? matches[0];
}

/**
 * Resolve a model spec against a provider. `modelSpec` is the `--model`
 * value (undefined when the flag is absent): an explicit model id, a tier
 * name (`haiku`/`sonnet`/`opus`, only when the provider carries a tier
 * map), or omitted (the provider's `default_model`; a provider without
 * one is an error). The fixture entry (when present) is merged with Pi's
 * catalogue by model id so the result carries `thinkingLevelMap` and the
 * other capability fields; a model id absent from the catalogue falls back
 * to a constructed entry from the file.
 */
export function resolveModel(
  config: Config,
  providerName: string,
  modelSpec: string | undefined,
  catalogue: Catalogue = createCatalogue(),
): ResolvedModel {
  const provider = resolveProvider(config, providerName);
  const tiers = provider.tiers;

  let id: string | undefined;
  let source: ResolvedModel["modelSource"];
  let tier: TierName | undefined;

  if (modelSpec === undefined || modelSpec === "") {
    id = provider.default_model;
    source = "default";
  } else if (isTierName(modelSpec)) {
    if (!tiers || typeof tiers !== "object") {
      throw new ConfigResolutionError(
        `provider "${providerName}" has no tier map: tier "${modelSpec}" cannot be resolved (use an explicit model id)`,
      );
    }
    id = tiers[modelSpec];
    tier = modelSpec;
    source = "tier";
    if (!id || typeof id !== "string" || id === "") {
      throw new ConfigResolutionError(
        `provider "${providerName}" has no ${modelSpec} tier (tier map: ${TIER_NAMES.map((t) => `${t}=${tiers[t] ?? "?"}`).join(", ")})`,
      );
    }
  } else {
    id = modelSpec;
    source = "explicit";
  }

  if (!id || id === "") {
    const hasTiers = tiers && typeof tiers === "object" && Object.keys(tiers).length > 0;
    const hint = hasTiers
      ? ` (tiers available: ${TIER_NAMES.filter((t) => tiers[t]).join(", ")})`
      : "";
    throw new ConfigResolutionError(
      `provider "${providerName}" has no default_model; pass --model <id-or-tier>${hint}`,
    );
  }

  const fixtureModel = findFixtureModel(provider, id);
  const catalogueEntry = catalogueModel(catalogue, id, providerName);
  if (!fixtureModel && !catalogueEntry) {
    throw new ConfigResolutionError(
      `unknown model "${id}" for provider "${providerName}" (not in the registry projection or the pi catalogue)`,
    );
  }

  let model: Model<Api>;
  if (catalogueEntry) {
    model = {
      ...catalogueEntry,
      id,
      provider: providerName,
      baseUrl: provider.base_url ?? catalogueEntry.baseUrl,
    };
    if (fixtureModel) {
      // Registry projection wins where the file defines a field.
      const tlm = tlmOf(fixtureModel);
      if (tlm !== undefined) model.thinkingLevelMap = tlm;
      const reasoning = boolOf(fixtureModel, "reasoning");
      if (reasoning !== undefined) model.reasoning = reasoning;
    }
  } else {
    // Fixture entry present, catalogue entry absent: construct from the
    // file (the setup generator's future per-model capability data).
    model = {
      id,
      name: strOf(fixtureModel, "name") ?? id,
      api: "openai-completions",
      provider: providerName,
      baseUrl: provider.base_url ?? "http://localhost/v1",
      reasoning: boolOf(fixtureModel, "reasoning") ?? true,
      input: ["text"],
      cost: costOf(fixtureModel) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: numOf(fixtureModel, "contextWindow") ?? 128_000,
      maxTokens: numOf(fixtureModel, "maxTokens") ?? 8_192,
      ...(tlmOf(fixtureModel) !== undefined ? { thinkingLevelMap: tlmOf(fixtureModel) } : {}),
    };
  }

  return { providerName, provider, modelSpec: id, modelSource: source, tier, model, thinkingLevel: "off" };
}

function isTierName(value: string): value is TierName {
  return (TIER_NAMES as readonly string[]).includes(value);
}

/** Find the first file entry whose `id` (or `model`) matches. */
function findFixtureModel(
  provider: ProviderEntry,
  id: string,
): Record<string, unknown> | undefined {
  const models = provider.models;
  if (!Array.isArray(models)) return undefined;
  return models.find((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const entryId = entry["id"] ?? entry["model"];
    return entryId === id;
  });
}

/** Narrow a fixture entry field to a thinking level map (or undefined). */
function tlmOf(
  entry: Record<string, unknown> | undefined,
): Partial<Record<ModelThinkingLevel, string | null>> | undefined {
  if (!entry) return undefined;
  const value = entry["thinkingLevelMap"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result: Partial<Record<ModelThinkingLevel, string | null>> = {};
  for (const [level, mapped] of Object.entries(value as Record<string, unknown>)) {
    if (typeof mapped === "string" || mapped === null) {
      result[level as ModelThinkingLevel] = mapped;
    }
  }
  return result;
}

/** Narrow a fixture entry field to a boolean (or undefined). */
function boolOf(entry: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = entry?.[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Narrow a fixture entry field to a finite number (or undefined). */
function numOf(entry: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = entry?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Narrow a fixture entry field to a non-empty string (or undefined). */
function strOf(entry: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = entry?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Narrow a fixture entry's cost block to a ModelCost (or undefined). */
function costOf(
  entry: Record<string, unknown> | undefined,
): Model<Api>["cost"] | undefined {
  const value = entry?.["cost"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const cost = value as Record<string, unknown>;
  const input = numOf(cost, "input");
  const output = numOf(cost, "output");
  if (input === undefined || output === undefined) return undefined;
  return {
    input,
    output,
    cacheRead: numOf(cost, "cacheRead") ?? 0,
    cacheWrite: numOf(cost, "cacheWrite") ?? 0,
  };
}

/**
 * Resolve the effective thinking level. Omitted effort uses the library
 * default (`off`, pi-agent-core's default `thinkingLevel`). An explicit
 * level must be supported by the model's `thinkingLevelMap` — a level
 * mapped to `null` is unsupported, and `xhigh`/`max` require an explicit
 * mapping — this delegates to pi-ai's `getSupportedThinkingLevels`, the
 * library's own authority on what a model supports. An unsupported level
 * throws `ConfigResolutionError` naming the supported set.
 */
export function resolveEffort(
  resolved: Pick<ResolvedModel, "model">,
  effort: string | undefined,
): ModelThinkingLevel {
  if (effort === undefined || effort === "") return "off";
  if (!isThinkingLevel(effort)) {
    throw new ConfigResolutionError(
      `effort "${effort}" is not a thinking level (valid: off, minimal, low, medium, high, xhigh, max)`,
    );
  }

  const supported = getSupportedThinkingLevels(resolved.model);
  if (!supported.includes(effort)) {
    throw new ConfigResolutionError(
      `model "${resolved.model.id}" does not support effort "${effort}" (supported: ${supported.join(", ") || "none"})`,
    );
  }

  return effort;
}

function isThinkingLevel(value: string): value is ModelThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

/**
 * One-stop resolution used by the CLI (slice E wires flags into it):
 * provider + model + effort against a config dir. Throws `ConfigError`
 * on every failure. `effort` is validated only when the model could be
 * resolved (the DEC exit-2 ordering: provider, then model, then effort).
 */
export function resolveConfig(
  configDir: string,
  flags: { provider?: string; model?: string; effort?: string },
  catalogue: Catalogue = createCatalogue(),
): ResolvedModel {
  const config = loadConfig(configDir);
  const providerName = flags.provider ?? inferProvider(config);
  const resolved = resolveModel(config, providerName, flags.model, catalogue);
  resolved.thinkingLevel = resolveEffort(resolved, flags.effort);
  return resolved;
}

/**
 * Default provider: the first enrolled provider, in config order. The DEC
 * gives no other default; this mirrors the CLI's current "first configured
 * provider" behavior.
 */
export function inferProvider(config: Config): string {
  const names = Object.keys(config.providers);
  if (names.length === 0) {
    throw new ConfigResolutionError("config has no providers enrolled");
  }
  return names[0]!;
}

/** Deterministic check of `models.json` readability (missing file, invalid JSON). */
export function assertConfigReadable(configDir: string): void {
  loadConfig(configDir);
}

/** Read-only probe used by tests to build a config dir. */
export function listConfigDir(configDir: string): string[] {
  return readdirSync(configDir);
}
