#!/usr/bin/env node
// miniharness headless summon: argv/stdin prompt in, one DEC-20260808-001
// envelope out. Slice E scope: the complete argv/stdin interface of
// DEC-20260808-001 — flag parsing, system prompt, cwd, provider/model/effort
// validation, sessions, help, and the MINIHARNESS_FAIL_AFTER fault-injection
// hook.
//
// Seams for slice C/D integration:
//  - resolveModel(flags)  — minimal direct validation against
//    <configDir>/models.json (provider, model, effort). Slice D's
//    src/config.ts resolveConfig() replaces the internals at integration;
//    the call shape (flags in, ResolvedModel out) is already theirs.
//  - openSession(flags)   — parses --session-dir/--no-session and returns the
//    session config. Without slice C there is no JSONL writer, so the session
//    id stays null and nothing is written; slice C replaces the internals.
// Exit codes: 0 completed / 1 failed in flight / 2 bad invocation / 3 internal.
import { Agent } from "@earendil-works/pi-agent-core";
import {
  calculateCost,
  contentText,
  createModels,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
  type Usage,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { readFileSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Fixed by DEC-20260808-001: every field except `output` may be null. */
interface Envelope {
  output: string;
  session_id: string | null;
  model: string | null;
  provider: string | null;
  tokens: {
    input: number | null;
    output: number | null;
    cache_read: number | null;
    cache_write: number | null;
    reasoning: number | null;
  } | null;
  cost_microdollars: number | null;
  duration_ms: number | null;
}

/** DEC tier names, matching slice D's TIER_NAMES. */
const TIER_NAMES = ["haiku", "sonnet", "opus"] as const;
type TierName = (typeof TIER_NAMES)[number];

/** Registry tier map on a provider entry. */
interface TierMap {
  haiku?: string;
  sonnet?: string;
  opus?: string;
}

/** One provider entry in the generated models.json. */
interface ProviderEntry {
  base_url?: string;
  provider_type?: string;
  models?: unknown[];
  default_model?: string;
  tiers?: TierMap;
  [key: string]: unknown;
}

/** `{ providers: { <name>: ProviderEntry } }`, as generated from the registry. */
interface Config {
  providers: Record<string, ProviderEntry>;
}

/** The outcome of resolveModel(); slice D's ResolvedModel swaps in at merge. */
interface ResolvedModel {
  /** Library Model the summon runs on (pi provider id, baseUrl overridden). */
  model: Model<Api>;
  /** Validated thinking level (default "off"). */
  thinkingLevel: ModelThinkingLevel;
  /** Registry provider name for the envelope. */
  providerName: string;
  /** Raw model id as routed. */
  modelId: string;
}

/** Session configuration resolved by openSession(). */
interface SessionConfig {
  enabled: boolean;
  /** Session dir when sessions are on (may be undefined before slice C). */
  sessionDir?: string;
}

/** Every flag the DEC defines. */
interface Flags {
  provider?: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  systemPromptFile?: string;
  cwd?: string;
  sessionDir?: string;
  noSession: boolean;
  configDir?: string;
  help: boolean;
}

/** Control flow: unwinds the async stack; process.exitCode carries the DEC exit code. */
class ExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

/**
 * Write a diagnostic to stderr synchronously. `process.stderr.write` is
 * async and can be dropped when the process exits right after an async
 * stdin read unwinds; writeSync guarantees the message lands before exit.
 */
function diagnostic(message: string): void {
  writeSync(2, `miniharness: ${message}\n`);
}

/** Write to stdout synchronously so the bytes land before process exit. */
function emit(stdout: string): void {
  writeSync(1, stdout);
}

function usageError(message: string): never {
  diagnostic(message);
  process.exitCode = 2;
  throw new ExitSignal(2);
}

function internalError(message: string): never {
  diagnostic(`internal failure: ${message}`);
  process.exitCode = 3;
  throw new ExitSignal(3);
}

/** A model that reports a non-zero cost converts to USD per 1M tokens. */
function costMicrodollars(model: Model<Api>, usage: Usage): number | null {
  try {
    const total = calculateCost(model, usage).total;
    if (typeof total !== "number" || !Number.isFinite(total)) return null;
    return Math.round(total * 1_000_000);
  } catch {
    return null;
  }
}

/**
 * Read stdin only when it is not a TTY; empty stdin on a TTY is a usage
 * error rather than a hang. Returns "" when stdin was not consumed.
 */
async function readStdinIfPiped(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Config dir precedence: --config-dir > PI_CODING_AGENT_DIR > ~/.pi/agent/. */
function configDirOf(flags: Flags): string {
  if (flags.configDir !== undefined && flags.configDir !== "") return flags.configDir;
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir !== undefined && envDir !== "") return envDir;
  return join(homedir(), ".pi", "agent");
}

/** Load and schema-check <configDir>/models.json. Missing/invalid -> exit 2. */
function loadConfig(configDir: string): Config {
  const path = join(configDir, "models.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    usageError(`config: cannot read ${path}: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    usageError(`config: invalid JSON in ${path}: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    usageError(`config: ${path} must be a JSON object with a "providers" map`);
  }
  const providers = (parsed as { providers?: unknown }).providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
    usageError(`config: ${path} is missing a "providers" map`);
  }
  const normalized: Record<string, ProviderEntry> = {};
  for (const [name, entry] of Object.entries(providers as Record<string, unknown>)) {
    normalized[name] =
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? (entry as ProviderEntry)
        : {};
  }
  return { providers: normalized };
}

/**
 * Build the model catalogue from Pi's builtin providers (static, sync, no
 * network) — the same wiring the summon path uses.
 */
function catalogueModels(): Model<Api>[] {
  const models = createModels();
  for (const provider of builtinProviders()) {
    models.setProvider(provider);
  }
  return models.getModels() as Model<Api>[];
}

/** Look up a model id across the catalogue; prefer a provider-name match. */
function catalogueModel(
  catalogue: readonly Model<Api>[],
  id: string,
  providerName: string,
): Model<Api> | undefined {
  const matches = catalogue.filter((model) => model.id === id);
  if (matches.length === 0) return undefined;
  const sameName = matches.find((model) => model.provider === providerName);
  return sameName ?? matches[0]!;
}

function isTierName(value: string): value is TierName {
  return (TIER_NAMES as readonly string[]).includes(value);
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
 * Resolve provider + model + effort against <configDir>/models.json.
 * SEAM: slice D's src/config.ts resolveConfig() replaces the internals at
 * integration (same call shape, same ResolvedModel semantics). Until then
 * this is the minimal direct validation that makes the conformance gates
 * green: unknown provider, unknown model/tier, unsupported effort, and
 * missing config all exit 2 naming the valid set.
 */
function resolveModel(flags: Flags): ResolvedModel {
  const configDir = configDirOf(flags);
  const config = loadConfig(configDir);
  const names = Object.keys(config.providers);

  const providerName = flags.provider ?? names[0];
  if (!providerName) {
    usageError("config has no providers enrolled");
  }
  const provider = config.providers[providerName];
  if (!provider) {
    const list = names.length === 0 ? "none enrolled" : `enrolled: ${names.join(", ")}`;
    usageError(`provider "${providerName}" is not enrolled (${list})`);
  }

  const tiers = provider.tiers;
  let id: string | undefined;

  if (flags.model === undefined || flags.model === "") {
    id = provider.default_model;
  } else if (isTierName(flags.model)) {
    if (!tiers || typeof tiers !== "object") {
      usageError(
        `provider "${providerName}" has no tier map: tier "${flags.model}" cannot be resolved (use an explicit model id)`,
      );
    }
    id = tiers[flags.model];
    if (!id || typeof id !== "string" || id === "") {
      usageError(
        `provider "${providerName}" has no ${flags.model} tier (tier map: ${TIER_NAMES.map((t) => `${t}=${tiers[t] ?? "?"}`).join(", ")})`,
      );
    }
  } else {
    id = flags.model;
  }

  if (!id || id === "") {
    const hasTiers = tiers && typeof tiers === "object" && Object.keys(tiers).length > 0;
    const hint = hasTiers
      ? ` (tiers available: ${TIER_NAMES.filter((t) => tiers[t]).join(", ")})`
      : "";
    usageError(
      `provider "${providerName}" has no default_model; pass --model <id-or-tier>${hint}`,
    );
  }

  // The id must be known to the registry projection or the pi catalogue.
  const fixtureModels = Array.isArray(provider.models) ? provider.models : [];
  const inFixture = fixtureModels.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const entryId = (entry as Record<string, unknown>)["id"] ?? (entry as Record<string, unknown>)["model"];
    return entryId === id;
  });
  const catalogue = catalogueModels();
  const catalogueEntry = catalogueModel(catalogue, id, providerName);
  if (!inFixture && !catalogueEntry) {
    usageError(
      `unknown model "${id}" for provider "${providerName}" (not in the registry projection or the pi catalogue)`,
    );
  }

  let model: Model<Api>;
  if (catalogueEntry) {
    model = {
      ...catalogueEntry,
      id,
      baseUrl: provider.base_url ?? catalogueEntry.baseUrl,
    };
  } else {
    // Fixture entry present, catalogue absent: construct a minimal model.
    model = {
      id,
      name: id,
      api: "openai-completions",
      provider: providerName,
      baseUrl: provider.base_url ?? "http://localhost/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    };
  }

  // Effort validation: supported levels come from the model's thinkingLevelMap
  // via the library's own authority (same call slice D uses).
  let thinkingLevel: ModelThinkingLevel = "off";
  if (flags.effort !== undefined && flags.effort !== "") {
    if (!isThinkingLevel(flags.effort)) {
      usageError(
        `effort "${flags.effort}" is not a thinking level (valid: off, minimal, low, medium, high, xhigh, max)`,
      );
    }
    const supported = getSupportedThinkingLevels(model);
    if (!supported.includes(flags.effort as ModelThinkingLevel)) {
      usageError(
        `model "${id}" does not support effort "${flags.effort}" (supported: ${supported.join(", ") || "none"})`,
      );
    }
    thinkingLevel = flags.effort as ModelThinkingLevel;
  }

  return { model, thinkingLevel, providerName, modelId: id };
}

/**
 * Resolve the session configuration from flags.
 * SEAM: slice C's session wiring replaces the internals at integration.
 * Without slice C, --session-dir is accepted and ignored for writing and
 * session_id stays null (the DEC allows a null session_id); no JSONL is
 * written here — slice C owns the writer.
 */
function openSession(flags: Flags): SessionConfig {
  if (flags.noSession) {
    if (flags.sessionDir !== undefined) {
      usageError("--no-session and --session-dir are mutually exclusive");
    }
    return { enabled: false };
  }
  return {
    enabled: true,
    sessionDir: flags.sessionDir ?? process.env.MINIHARNESS_SESSION_DIR,
  };
}

function fail(message: string): never {
  diagnostic(message);
  process.exitCode = 1;
  throw new ExitSignal(1);
}

/**
 * Parse argv into flags + prompt positionals.
 *
 * Grammar: `--flag value`, `--flag=value`, `--` terminator (everything after
 * is positional), and at most one positional prompt. Unknown flag, missing
 * value, duplicated scalar flag, or more than one positional -> exit 2.
 */
function parseArgv(argv: string[]): { flags: Flags; positionals: string[] } {
  const flags: Flags = { noSession: false, help: false };
  const positionals: string[] = [];
  const seen = new Set<string>();
  const valueFlags = new Map<string, (value: string) => void>([
    ["--provider", (v) => (flags.provider = v)],
    ["--model", (v) => (flags.model = v)],
    ["--effort", (v) => (flags.effort = v)],
    ["--system-prompt", (v) => (flags.systemPrompt = v)],
    ["--system-prompt-file", (v) => (flags.systemPromptFile = v)],
    ["--cwd", (v) => (flags.cwd = v)],
    ["--session-dir", (v) => (flags.sessionDir = v)],
    ["--config-dir", (v) => (flags.configDir = v)],
  ]);

  let i = 0;
  let positionalOnly = false;
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (positionalOnly) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      positionalOnly = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--no-session") {
      flags.noSession = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (!valueFlags.has(name)) {
        usageError(`unknown flag: ${name}`);
      }
      if (seen.has(name)) {
        usageError(`flag given more than once: ${name}`);
      }
      seen.add(name);
      const set = valueFlags.get(name)!;
      let value: string;
      if (eq !== -1) {
        value = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          usageError(`flag ${name} requires a value`);
        }
        value = next;
        i++;
      }
      if (value === "") {
        usageError(`flag ${name} requires a non-empty value`);
      }
      set(value);
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      usageError(`unknown flag: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length > 1) {
    usageError("expected at most one prompt argument");
  }
  return { flags, positionals };
}

const USAGE = `Usage: miniharness [options] [prompt]

Headless model summon. Prints one JSON envelope to stdout on success
(DEC-20260808-001). The prompt is the positional argument, or stdin when no
positional is given and stdin is not a TTY.

Options:
  --provider <name>          Provider enrolled in the registry (models.json)
  --model <id-or-tier>       Model id or tier: haiku | sonnet | opus
  --effort <level>           Thinking level: off|minimal|low|medium|high|xhigh|max
  --system-prompt <text>     System prompt
  --system-prompt-file <path>  System prompt from a file ("-" = stdin)
  --cwd <path>               Working directory (must exist; default: process cwd)
  --session-dir <path>       Session JSONL directory (default: ~/.local/share/miniharness/sessions)
  --no-session               Do not persist a session
  --config-dir <path>        Config directory holding models.json
  --help                     Show this help and exit

Exit codes: 0 completed / 1 failed in flight / 2 bad invocation / 3 internal.
`;

/** Read the system prompt: --system-prompt text or --system-prompt-file. */
async function resolveSystemPrompt(flags: Flags): Promise<string> {
  if (flags.systemPrompt !== undefined && flags.systemPromptFile !== undefined) {
    usageError("--system-prompt and --system-prompt-file are mutually exclusive");
  }
  if (flags.systemPrompt !== undefined) return flags.systemPrompt;
  if (flags.systemPromptFile === undefined) return "";
  if (flags.systemPromptFile === "-") {
    return readStdinIfPiped();
  }
  try {
    return readFileSync(flags.systemPromptFile, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    usageError(`cannot read system prompt file ${flags.systemPromptFile}: ${detail}`);
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const { flags, positionals } = parseArgv(process.argv.slice(2));
  if (flags.help) {
    emit(USAGE);
    return;
  }

  // Prompt: positional, or stdin when piped. System prompt may also read
  // stdin via --system-prompt-file -; the two reads are mutually exclusive.
  let prompt: string;
  let stdinConsumed = false;
  if (positionals.length === 1) {
    prompt = positionals[0]!;
  } else {
    if (process.stdin.isTTY) {
      usageError("no prompt given: pass a positional argument or pipe stdin");
    }
    prompt = await readStdinIfPiped();
    stdinConsumed = true;
    if (prompt.trim().length === 0) {
      usageError("empty prompt on stdin");
    }
  }

  const systemPrompt = await resolveSystemPrompt(flags);
  if (flags.systemPromptFile === "-" && stdinConsumed) {
    usageError(
      "stdin cannot serve both the prompt and --system-prompt-file -; pass the prompt as a positional argument",
    );
  }

  // --cwd must exist and be a directory; affects the summon working context.
  if (flags.cwd !== undefined) {
    try {
      if (!statSync(flags.cwd).isDirectory()) {
        usageError(`--cwd is not a directory: ${flags.cwd}`);
      }
    } catch {
      usageError(`--cwd does not exist: ${flags.cwd}`);
    }
  }

  // Provider/model/effort validation happens before any network or summon.
  const resolved = resolveModel(flags);
  const session = openSession(flags);
  void session; // session writing lands with slice C; session_id stays null.

  const models = createModels();
  for (const provider of builtinProviders()) {
    models.setProvider(provider);
  }

  // Fault-injection hook (test-only): fail after invocation validation,
  // before the provider is contacted. Maps to DEC exit 1.
  if (process.env.MINIHARNESS_FAIL_AFTER === "provider-connect") {
    fail(
      "summon failed in flight: MINIHARNESS_FAIL_AFTER=provider-connect injected failure (test-only hook)",
    );
  }

  const agent = new Agent({
    initialState: {
      systemPrompt:
        systemPrompt ||
        "You are miniharness, a minimal headless assistant. Reply concisely and directly.",
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel,
      tools: [],
      messages: [],
    },
    streamFn: (m, ctx, opts) => models.streamSimple(m, ctx, opts),
  });

  try {
    await agent.prompt(prompt);
    await agent.waitForIdle();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`summon failed: ${detail}`);
  } finally {
    // Tear down any in-flight provider connection before exiting.
    agent.abort();
  }

  const messages = agent.state.messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") {
    fail("summon failed: no assistant reply produced");
  }

  const durationMs = Date.now() - startedAt;
  if (last.stopReason === "error" || last.stopReason === "aborted") {
    fail(`summon failed in flight: ${last.errorMessage ?? last.stopReason}`);
  }
  if (last.stopReason === "length") {
    fail("summon failed in flight: output truncated by token limit");
  }

  const usage = last.usage;
  const envelope: Envelope = {
    output: contentText(last.content),
    session_id: null, // sessions are slice C
    model: last.model ?? resolved.modelId,
    provider: last.provider ?? resolved.providerName,
    tokens:
      usage == null
        ? null
        : {
            input: usage.input ?? null,
            output: usage.output ?? null,
            cache_read: usage.cacheRead ?? null,
            cache_write: usage.cacheWrite ?? null,
            reasoning: usage.reasoning ?? null,
          },
    cost_microdollars:
      usage == null ? null : costMicrodollars(resolved.model, usage),
    duration_ms: durationMs,
  };

  emit(JSON.stringify(envelope) + "\n");
}

main().catch((error) => {
  if (error instanceof ExitSignal) {
    // exitCode already set; let streams drain and the process exit naturally.
    return;
  }
  const detail = error instanceof Error ? error.message : String(error);
  internalError(detail);
});
