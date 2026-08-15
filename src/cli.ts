#!/usr/bin/env node
// miniharness headless summon: argv/stdin prompt in, one DEC-20260808-001
// envelope on stdout, and DEC-20260809-001 lifecycle NDJSON on stderr.
// Exit codes: 0 completed / 1 failed in flight / 2 bad invocation / 3 internal.
import {
  Agent,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  buildSessionContext,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type CompactionEntry,
  type Entry,
} from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo, NodeExecutionEnv, Session } from "@earendil-works/pi-agent-core/node";
import {
  calculateCost,
  contentText,
  createModels,
  type Api,
  type Model,
  type ModelThinkingLevel,
  type Models,
  type Usage,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { readFileSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  createCliOAuthCredentialStore,
  loadConfig,
  registerCustomProviders,
  registerCliOAuthProviders,
  resolveConfig,
  resolveConfigDir,
} from "./config.js";
import { discoverRemoteMcpTools, mergeRemoteMcpTools, RemoteMcpError } from "./mcp.js";

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

/** The outcome of resolveModel() for the summon path. */
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
  /** Session dir when sessions are on. */
  sessionDir?: string;
  /** Existing JSONL session to continue. */
  resume?: string;
  purpose?: string;
}

interface OpenSession {
  fs: NodeExecutionEnv;
  session: Session;
  id: string;
  /** Messages Pi reconstructs from the existing session branch. */
  initialMessages: AgentMessage[];
}

/**
 * The outcome of a compaction attempt: a compactable history that was
 * compacted, or a reason why no compaction ran. Only `kind: "compacted"`
 * carries an entry; the other kinds mean the transcript stays as-is.
 */
interface CompactionOutcome {
  kind: "compacted" | "disabled" | "not-needed" | "nothing-to-compact" | "failed";
  /** Present exactly when kind === "compacted". */
  entry?: CompactionEntry;
  /** Human-readable reason for stderr diagnostics when kind === "failed". */
  error?: string;
}

/** DEC-20260808-001 (Sessions And Config): default JSONL session directory. */
const DEFAULT_SESSION_DIR = join(homedir(), ".local", "share", "miniharness", "sessions");

/** Every flag the DEC defines. */
interface Flags {
  provider?: string;
  model?: string;
  effort?: string;
  /** Compaction mode: "off" or "auto" (default "auto"). */
  compaction: "off" | "auto";
  systemPrompt?: string;
  systemPromptFile?: string;
  cwd?: string;
  sessionDir?: string;
  resume?: string;
  noSession: boolean;
  configDir?: string;
  purpose?: string;
  mcpServers: string[];
  mcpTools: string[];
  /** Suppress non-failure lifecycle records (DEC-20260809-001). */
  silent: boolean;
  help: boolean;
}

type LifecycleEventName =
  | "started"
  | "request_started"
  | "response_started"
  | "streaming_started"
  | "progress"
  | "tool_call"
  | "tool_started"
  | "tool_finished"
  | "finalizing"
  | "done"
  | "failed";

type LifecycleFields = Record<string, string | number | boolean | null>;

/**
 * DEC-20260809-001 lifecycle projection. Records contain timing, counters,
 * and safe identifiers only; prompt/model output/tool payloads never enter
 * stderr. State transitions are synchronous and ordered by `seq`.
 */
class LifecycleEmitter {
  private readonly startedMonotonic = process.hrtime.bigint();
  private sequence = 0;
  private silent = false;
  private stderrAvailable = true;

  setSilent(silent: boolean): void {
    this.silent = silent;
  }

  elapsedMs(): number {
    return Number((process.hrtime.bigint() - this.startedMonotonic) / 1_000_000n);
  }

  emit(event: LifecycleEventName, fields: LifecycleFields = {}, force = false): void {
    if ((!force && this.silent) || !this.stderrAvailable) return;
    const record = {
      protocol: "miniharness.lifecycle",
      version: 1,
      seq: ++this.sequence,
      event,
      timestamp: new Date().toISOString(),
      elapsed_ms: this.elapsedMs(),
      ...fields,
    };
    try {
      writeSync(2, JSON.stringify(record) + "\n");
    } catch {
      // A closed observer must not turn a completed model call into a harness
      // failure. Once stderr is unavailable, later records are best-effort.
      this.stderrAvailable = false;
    }
  }

  fail(exitCode: 1 | 2 | 3, failureClass: "summon" | "usage" | "internal", message: string): void {
    this.emit(
      "failed",
      { exit_code: exitCode, failure_class: failureClass, message },
      true,
    );
  }
}

const lifecycle = new LifecycleEmitter();

/** Control flow: unwinds the async stack; process.exitCode carries the DEC exit code. */
class ExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

/** Write to stdout synchronously so the bytes land before process exit. */
function emit(stdout: string): void {
  writeSync(1, stdout);
}

function usageError(message: string): never {
  lifecycle.fail(2, "usage", message);
  process.exitCode = 2;
  throw new ExitSignal(2);
}

function internalError(message: string): never {
  lifecycle.fail(3, "internal", `internal failure: ${message}`);
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

/**
 * Resolve provider + model + effort through slice D's config module
 * (src/config.ts). ConfigError maps to DEC exit 2 with the module's
 * one-line message; resolution is pure, sync, and network-free.
 */
function resolveModel(flags: Flags): ResolvedModel {
  const configDir = resolveConfigDir(flags.configDir);
  try {
    const resolved = resolveConfig(configDir, {
      provider: flags.provider,
      model: flags.model,
      effort: flags.effort,
    });
    return {
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel,
      providerName: resolved.providerName,
      modelId: resolved.model.id,
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      usageError(error.message);
    }
    throw error;
  }
}
/**
 * Resolve the session configuration from flags.
 * Sessions are on by default (DEC-20260808-001): the summon appends a JSONL
 * session through the library's JsonlSessionRepo into the resolved dir.
 */
function openSession(flags: Flags): SessionConfig {
  if (flags.noSession) {
    if (flags.resume !== undefined) {
      usageError("--no-session and --resume are mutually exclusive");
    }
    if (flags.sessionDir !== undefined) {
      usageError("--no-session and --session-dir are mutually exclusive");
    }
    if (flags.purpose !== undefined) {
      usageError("--no-session and --purpose are mutually exclusive");
    }
    return { enabled: false };
  }
  return {
    enabled: true,
    sessionDir: flags.sessionDir ?? process.env.MINIHARNESS_SESSION_DIR ?? DEFAULT_SESSION_DIR,
    resume: flags.resume,
    purpose: flags.purpose,
  };
}

const SAFE_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * Open an existing Pi JSONL session through the library. The repository is
 * deliberately used for both discovery and reading: this keeps validation,
 * JSONL decoding, compaction handling, and branch selection in pi-agent-core
 * instead of duplicating its file format here.
 */
async function openResumedSession(dir: string, id: string): Promise<OpenSession> {
  if (!SAFE_SESSION_ID.test(id)) {
    usageError("--resume must be a safe session identifier");
  }
  const fs = new NodeExecutionEnv({ cwd: process.cwd() });
  try {
    const repo = new JsonlSessionRepo({ fs, sessionsRoot: dir });
    let metadata;
    try {
      metadata = (await repo.list()).find((candidate) => candidate.id === id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      usageError(`cannot read resumed session ${id}: ${detail}`);
    }
    if (metadata === undefined) {
      usageError(`resumed session not found: ${id}`);
    }
    const session = await repo.open(metadata);
    const entries = await session.findEntries({ order: "oldestFirst" });
    const context = buildSessionContext(entries);
    return { fs, session, id, initialMessages: context.messages };
  } catch (error) {
    await fs.cleanup();
    if (error instanceof ExitSignal) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    usageError(`cannot resume session ${id}: ${detail}`);
  }
}

/**
 * Fail fast on an unwritable session dir (DEC exit 3) before any provider
 * call, so a broken session path never costs a summon. `NodeExecutionEnv`
 * returns errors as `Result`s and must never throw, so the whole probe is
 * wrapped in the same try/catch as the write path.
 */
async function assertSessionDirWritable(dir: string): Promise<void> {
  const fs = new NodeExecutionEnv({ cwd: process.cwd() });
  try {
    const created = await fs.createDir(dir, { recursive: true });
    if (!created.ok) {
      internalError(`session dir not writable: ${created.error.message}`);
    }
    const probe = await fs.appendFile(join(dir, ".miniharness-write-probe"), "");
    if (!probe.ok) {
      internalError(`session dir not writable: ${probe.error.message}`);
    }
    await fs.remove(join(dir, ".miniharness-write-probe"), { force: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    internalError(`session dir not writable: ${detail}`);
  } finally {
    await fs.cleanup();
  }
}

/**
 * Open a JSONL session through the library and append the transcript. When a
 * compaction entry is supplied it is appended after the messages, which is
 * exactly how the library persists compaction: a `compaction` entry whose
 * summary + retainedTail reconstruct the post-compaction context on readback
 * (the session context transform treats the newest compaction entry as the
 * head of the branch). On any failure (create, append, drain) this rejects
 * so the caller exits DEC code 3 - session writes are harness-owned, not
 * summon failures.
 */
async function writeSession(
  messages: AgentMessage[],
  dir: string,
  purpose: string | undefined,
  compactionEntry?: CompactionEntry,
): Promise<string> {
  const fs = new NodeExecutionEnv({ cwd: process.cwd() });
  const repo = new JsonlSessionRepo({ fs, sessionsRoot: dir });
  const session: Session = await repo.create({
    cwd: process.cwd(),
    ...(purpose === undefined ? {} : { metadata: { purpose } }),
  });
  const metadata = await session.getMetadata();
  for (const message of messages) {
    await session.appendMessage(message);
  }
  if (compactionEntry !== undefined) {
    await session.appendEntry(compactionEntry, "main");
  }
  await session.getLog();
  await fs.cleanup();
  return metadata.id;
}

/** Append only the new turn to an already-open session. */
async function appendSession(
  open: OpenSession,
  messages: AgentMessage[],
  compactionEntry?: CompactionEntry,
): Promise<void> {
  try {
    for (const message of messages) {
      await open.session.appendMessage(message);
    }
    if (compactionEntry !== undefined) {
      await open.session.appendEntry(compactionEntry, "main");
    }
    await open.session.getLog();
  } finally {
    await open.fs.cleanup();
  }
}

function fail(message: string): never {
  lifecycle.fail(1, "summon", message);
  process.exitCode = 1;
  throw new ExitSignal(1);
}

/**
 * Project Pi's detailed AgentEvent stream into DEC-20260809-001's stable,
 * content-free lifecycle vocabulary.
 */
function subscribeLifecycle(
  agent: Agent,
  resolved: ResolvedModel,
): () => void {
  let turn = 0;
  let responseStarted = false;
  let streamingStarted = false;
  let finalizing = false;
  let deltaCount = 0;
  let textBytes = 0;
  let reasoningBytes = 0;
  let toolBytes = 0;
  let toolUpdates = 0;
  let lastProgressElapsed = Number.NEGATIVE_INFINITY;
  let lastReportedDeltaCount = 0;

  const emitProgress = (phase: "streaming" | "tool", force = false): void => {
    const elapsed = lifecycle.elapsedMs();
    if (!force && elapsed - lastProgressElapsed < 1_000) return;
    lifecycle.emit("progress", {
      turn,
      phase,
      delta_count: deltaCount,
      text_bytes: textBytes,
      reasoning_bytes: reasoningBytes,
      tool_bytes: toolBytes,
      tool_updates: toolUpdates,
    });
    lastProgressElapsed = elapsed;
    lastReportedDeltaCount = deltaCount;
  };

  return agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        return;
      case "turn_start":
        turn++;
        responseStarted = false;
        streamingStarted = false;
        lifecycle.emit("request_started", {
          turn,
          provider: resolved.providerName,
          model: resolved.modelId,
        });
        return;
      case "message_start":
        if (event.message.role === "assistant" && !responseStarted) {
          responseStarted = true;
          lifecycle.emit("response_started", { turn });
        }
        return;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (!responseStarted) {
          responseStarted = true;
          lifecycle.emit("response_started", { turn });
        }
        if (update.type === "text_delta" || update.type === "thinking_delta") {
          if (update.delta.length === 0) return;
          if (!streamingStarted) {
            streamingStarted = true;
            lifecycle.emit("streaming_started", {
              turn,
              stream_kind: update.type === "text_delta" ? "text" : "reasoning",
            });
          }
          deltaCount++;
          if (update.type === "text_delta") {
            textBytes += Buffer.byteLength(update.delta);
          } else {
            reasoningBytes += Buffer.byteLength(update.delta);
          }
          emitProgress("streaming");
          return;
        }
        if (update.type === "toolcall_delta") {
          deltaCount++;
          toolBytes += Buffer.byteLength(update.delta);
          emitProgress("streaming");
          return;
        }
        if (update.type === "toolcall_end") {
          lifecycle.emit("tool_call", {
            turn,
            tool_call_id: update.toolCall.id,
            tool_name: update.toolCall.name,
          });
        }
        return;
      }
      case "message_end":
        if (
          event.message.role === "assistant" &&
          deltaCount !== lastReportedDeltaCount
        ) {
          emitProgress("streaming", true);
        }
        return;
      case "tool_execution_start":
        lifecycle.emit("tool_started", {
          turn,
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
        });
        return;
      case "tool_execution_update":
        toolUpdates++;
        emitProgress("tool");
        return;
      case "tool_execution_end":
        lifecycle.emit("tool_finished", {
          turn,
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          is_error: event.isError,
        });
        return;
      case "turn_end":
        return;
      case "agent_end":
        if (!finalizing) {
          finalizing = true;
          lifecycle.emit("finalizing", { turns: turn });
        }
        return;
    }
  });
}

/**
 * Decide whether the completed transcript needs compaction and, when it does,
 * run it through the library's compaction machinery.
 *
 * Pre-emptive by design: the agent loop never checks context overflow, so an
 * oversized transcript reaches the provider and fails (or gets truncated)
 * before we ever see a stop reason. We therefore estimate the transcript
 * against the model's context window *after* the summon completes and, on
 * overflow, compact so the follow-up resume keeps working. The library's
 * DEFAULT_COMPACTION_SETTINGS (enabled, 16 KiB reserved for the summary
 * prompt + output, ~20 KiB recent tail retained) are used as-is: this is a
 * single-shot headless summon, and inventing new tuning knobs would violate
 * "own only the invocation contract".
 *
 * The compaction entry produced here is persisted by the caller (if sessions
 * are on) so the adoption/recovery surface stays truthful.
 */
async function maybeCompact(
  messages: AgentMessage[],
  model: Model<Api>,
  models: Models,
  mode: "off" | "auto",
): Promise<CompactionOutcome> {
  if (mode === "off") return { kind: "disabled" };
  const contextTokens = estimateContextTokens(messages).tokens;
  if (!shouldCompact(contextTokens, model.contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
    return { kind: "not-needed" };
  }

  // prepareCompaction consumes session entries (message entries plus any
  // prior compaction entry); build a message-only path from the transcript.
  const pathEntries: Entry[] = messages.map((message, index) => ({
    type: "message",
    id: `msg-${index}`,
    seq: index,
    parentId: index === 0 ? null : `msg-${index - 1}`,
    timestamp: message.timestamp,
    message,
  }));
  const preparation = prepareCompaction(pathEntries, DEFAULT_COMPACTION_SETTINGS);
  if (!preparation.ok) {
    return {
      kind: "failed",
      error: `compaction preparation failed: ${preparation.error.message}`,
    };
  }
  if (preparation.value === undefined) {
    return { kind: "nothing-to-compact" };
  }

  const result = await compact(
    preparation.value,
    models,
    model,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  if (!result.ok) {
    return { kind: "failed", error: `compaction failed: ${result.error.message}` };
  }
  return {
    kind: "compacted",
    entry: {
      type: "compaction",
      id: `compaction-${Date.now()}`,
      seq: pathEntries.length,
      parentId: pathEntries[pathEntries.length - 1]?.id ?? null,
      timestamp: Date.now(),
      summary: result.value.summary,
      retainedTail: result.value.retainedTail,
      tokensBefore: result.value.tokensBefore,
      details: result.value.details,
      usage: result.value.usage,
    },
  };
}

/**
 * Parse argv into flags + prompt positionals.
 *
 * Grammar: `--flag value`, `--flag=value`, `--` terminator (everything after
 * is positional), and at most one positional prompt. Unknown flag, missing
 * value, duplicated scalar flag, or more than one positional -> exit 2.
 */
function parseArgv(argv: string[]): { flags: Flags; positionals: string[] } {
  const flags: Flags = {
    noSession: false,
    silent: false,
    help: false,
    compaction: "auto",
    mcpServers: [],
    mcpTools: [],
  };
  const positionals: string[] = [];
  const seen = new Set<string>();
  const valueFlags = new Map<string, (value: string) => void>([
    ["--provider", (v) => (flags.provider = v)],
    ["--model", (v) => (flags.model = v)],
    ["--effort", (v) => (flags.effort = v)],
    ["--compaction", (v) => (flags.compaction = parseCompaction(v))],
    ["--system-prompt", (v) => (flags.systemPrompt = v)],
    ["--system-prompt-file", (v) => (flags.systemPromptFile = v)],
    ["--cwd", (v) => (flags.cwd = v)],
    ["--session-dir", (v) => (flags.sessionDir = v)],
    ["--resume", (v) => (flags.resume = v)],
    ["--config-dir", (v) => (flags.configDir = v)],
    ["--purpose", (v) => (flags.purpose = parsePurpose(v))],
    ["--mcp-server", (v) => flags.mcpServers.push(v)],
    ["--mcp-tool", (v) => flags.mcpTools.push(v)],
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
    if (arg === "--silent") {
      flags.silent = true;
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

/**
 * Validate the --compaction value. Only "off" and "auto" exist; anything
 * else is a DEC exit-2 usage error.
 */
function parseCompaction(value: string): "off" | "auto" {
  if (value === "off" || value === "auto") return value;
  usageError(`--compaction must be "off" or "auto" (got "${value}")`);
}

const SAFE_PURPOSE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function parsePurpose(value: string): string {
  if (!SAFE_PURPOSE.test(value)) {
    usageError("--purpose must be a safe identifier");
  }
  return value;
}

function parseMcpServer(value: string): { label: string; url: string } {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    usageError("--mcp-server must be <label>=<url>");
  }
  return { label: value.slice(0, separator), url: value.slice(separator + 1) };
}

const USAGE = `Usage: miniharness [options] [prompt]

Headless model summon. Prints one JSON envelope to stdout on success
(DEC-20260808-001). The prompt is the positional argument, or stdin when no
positional is given and stdin is not a TTY.

Compaction ("auto", default): when the transcript would overflow the model's
context window, the library compacts the history into a summary and the
summon continues instead of failing. "off" disables this. The envelope is
unchanged either way; the session JSONL records the compaction entry.

Options:
  --provider <name>          Provider enrolled in the registry (models.json)
  --model <id-or-tier>       Model id or tier: haiku | sonnet | opus
  --effort <level>           Thinking level: off|minimal|low|medium|high|xhigh|max
  --compaction <mode>        Compaction: off | auto (default: auto)
  --system-prompt <text>     System prompt
  --system-prompt-file <path>  System prompt from a file ("-" = stdin)
  --cwd <path>               Working directory (must exist; default: process cwd)
  --session-dir <path>       Session JSONL directory (default: ~/.local/share/miniharness/sessions)
  --resume <session-id>      Continue an existing JSONL session in place
  --purpose <identifier>     Durable purpose marker in session metadata
  --mcp-server <label>=<url>  Attach one repeatable remote Streamable HTTP MCP server
  --mcp-tool <name>           Restrict MCP calls to this repeatable tool name
  --no-session               Do not persist a session
  --silent                   Suppress lifecycle/progress events (failures remain)
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
  lifecycle.setSilent(flags.silent);
  if (flags.help) {
    emit(USAGE);
    return;
  }
  lifecycle.emit("started");

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
    let cwdStat;
    try {
      cwdStat = statSync(flags.cwd);
    } catch {
      usageError(`--cwd does not exist: ${flags.cwd}`);
    }
    if (!cwdStat.isDirectory()) {
      usageError(`--cwd is not a directory: ${flags.cwd}`);
    }
  }

  // Provider/model/effort validation happens before any network or summon.
  const session = openSession(flags);
  if (session.enabled && session.sessionDir !== undefined) {
    await assertSessionDirWritable(session.sessionDir);
  }
  const resumed =
    session.enabled && session.sessionDir !== undefined && session.resume !== undefined
      ? await openResumedSession(session.sessionDir, session.resume)
      : undefined;
  const resolved = resolveModel(flags);

  // DEC-20260808-002: the credential store reads the operator's Claude
  // Code / Codex CLI OAuth logins and writes refreshed tokens back.
  const models = createModels({ credentials: createCliOAuthCredentialStore() });
  for (const provider of builtinProviders()) {
    models.setProvider(provider);
  }
  // Registry providers Pi does not ship (crofai, grimoire, kimicode, …)
  // stream through OpenAI-compatible endpoints registered from the
  // projection + setup's auth store.
  const config = loadConfig(resolveConfigDir(flags.configDir));
  registerCustomProviders(models, config);
  // DEC-20260808-002: registry providers with a live CLI OAuth login
  // (anthropic, codex) alias their Pi builtin equivalents so auth resolves
  // from the store above. Must run after registerCustomProviders to win.
  registerCliOAuthProviders(models, config);

  // Test-only seam: register an extra provider (e.g. the compaction test's
  // stub) so behavior can be exercised without network or credentials. The
  // summon path never sets this env var.
  if (process.env.MINIHARNESS_EXTRA_PROVIDER !== undefined) {
    const extraProviderPath = process.env.MINIHARNESS_EXTRA_PROVIDER;
    const { registerTestProvider } = await import(extraProviderPath);
    registerTestProvider(models);
  }

  // Fault-injection hook (test-only): fail after invocation validation,
  // before the provider is contacted. Maps to DEC exit 1.
  if (process.env.MINIHARNESS_FAIL_AFTER === "provider-connect") {
    fail(
      "summon failed in flight: MINIHARNESS_FAIL_AFTER=provider-connect injected failure (test-only hook)",
    );
  }

  if (flags.mcpTools.length > 0 && flags.mcpServers.length === 0) {
    usageError("--mcp-tool requires --mcp-server");
  }
  const allowedMcpTools = flags.mcpTools.length === 0 ? undefined : new Set(flags.mcpTools);
  const remoteToolGroups: AgentTool[][] = [];
  for (const raw of flags.mcpServers) {
    const server = parseMcpServer(raw);
    try {
      remoteToolGroups.push(await discoverRemoteMcpTools({ ...server, allowedTools: allowedMcpTools }));
    } catch (error) {
      if (error instanceof RemoteMcpError) usageError(error.message);
      usageError("MCP server discovery failed");
    }
  }
  let remoteTools: AgentTool[] = [];
  if (remoteToolGroups.length > 0) {
    try {
      remoteTools = mergeRemoteMcpTools(remoteToolGroups, allowedMcpTools);
    } catch (error) {
      if (error instanceof RemoteMcpError) usageError(error.message);
      usageError("MCP server discovery failed");
    }
  }

  const agent = new Agent({
    initialState: {
      systemPrompt:
        systemPrompt ||
        "You are miniharness, a minimal headless assistant. Reply concisely and directly.",
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel,
      tools: remoteTools,
      messages: resumed?.initialMessages ?? [],
    },
    streamFn: (m, ctx, opts) => models.streamSimple(m, ctx, opts),
  });
  const unsubscribeLifecycle = subscribeLifecycle(agent, resolved);

  try {
    await agent.prompt(prompt);
    await agent.waitForIdle();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`summon failed: ${detail}`);
  } finally {
    // Tear down any in-flight provider connection before exiting.
    agent.abort();
    unsubscribeLifecycle();
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
  // Compaction runs after the summon completes: the transcript is fixed, the
  // context-token estimate is trustworthy, and a compaction failure can never
  // hide a successful reply. The outcome is folded into the session only - the
  // DEC-20260808-001 envelope keeps its fixed shape.
  let compactionEntry: CompactionEntry | undefined;
  let finalizationWarning: string | undefined;
  const compactionOutcome = await maybeCompact(messages, resolved.model, models, flags.compaction);
  if (compactionOutcome.kind === "compacted") {
    compactionEntry = compactionOutcome.entry;
  } else if (compactionOutcome.kind === "failed") {
    finalizationWarning = `compaction skipped: ${compactionOutcome.error}`;
  }

  let sessionId: string | null = null;
  if (session.enabled && session.sessionDir !== undefined) {
    try {
      if (resumed !== undefined) {
        const appended = messages.slice(resumed.initialMessages.length);
        await appendSession(resumed, appended, compactionEntry);
        sessionId = resumed.id;
      } else {
        sessionId = await writeSession(messages, session.sessionDir, session.purpose, compactionEntry);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (resumed !== undefined) await resumed.fs.cleanup();
      internalError(`session write failed: ${detail}`);
    }
  }

  const envelope: Envelope = {
    output: contentText(last.content),
    session_id: sessionId,
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
  lifecycle.emit("done", {
    duration_ms: Date.now() - startedAt,
    ...(finalizationWarning === undefined ? {} : { warning: finalizationWarning }),
  });
}

main().catch((error) => {
  if (error instanceof ExitSignal) {
    // exitCode already set; let streams drain and the process exit naturally.
    return;
  }
  const detail = error instanceof Error ? error.message : String(error);
  internalError(detail);
});
