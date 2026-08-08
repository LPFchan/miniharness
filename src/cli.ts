#!/usr/bin/env node
// miniharness headless summon: argv/stdin prompt in, one DEC-20260808-001
// envelope out. Slice A scope: thinnest possible summon; provider/model/effort
// resolution, sessions, and config are owned by later slices (C/D/E).
// Exit codes: 0 completed / 1 failed in flight / 2 bad invocation / 3 internal.
import { Agent } from "@earendil-works/pi-agent-core";
import {
  calculateCost,
  contentText,
  createModels,
  type Api,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

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

function usageError(message: string): never {
  process.stderr.write(`miniharness: ${message}\n`);
  process.exitCode = 2;
  throw new ExitSignal(2);
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

async function readPrompt(argv: string[]): Promise<string> {
  // A single positional argument is the prompt. Anything else is bad usage.
  const positionals = argv.filter((arg) => !arg.startsWith("-"));
  if (positionals.length > 1) {
    usageError("expected at most one prompt argument");
  }
  if (positionals.length === 1) {
    return positionals[0]!;
  }
  // No positional: read the prompt from stdin (only when not a TTY).
  if (process.stdin.isTTY) {
    usageError("no prompt given: pass a positional argument or pipe stdin");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const prompt = Buffer.concat(chunks).toString("utf8");
  if (prompt.trim().length === 0) {
    usageError("empty prompt on stdin");
  }
  return prompt;
}

/**
 * Resolve the default model the library offers: first provider with
 * configured auth, using its first model. This mirrors pi-coding-agent's
 * `findInitialModel` fallback (step 4/5); slice D replaces this with
 * registry/models.json resolution.
 */
async function resolveDefaultModel(): Promise<Model<Api>> {
  const models = createModels();
  for (const provider of builtinProviders()) {
    models.setProvider(provider);
  }
  const available = await models.getAvailable();
  if (available.length === 0) {
    usageError(
      "no configured provider found: set a provider API key in the environment " +
        "(e.g. ANTHROPIC_API_KEY, OPENROUTER_API_KEY) and retry",
    );
  }
  return available[0]!;
}

function fail(message: string): never {
  process.stderr.write(`miniharness: ${message}\n`);
  process.exitCode = 1;
  throw new ExitSignal(1);
}

/**
 * Internal control flow: unwinds the async stack so the process can exit
 * naturally once stdout/stderr pipes have drained. `process.exitCode` carries
 * the DEC-20260808-001 exit code; the process exits 0 only when the code was
 * never set.
 */
class ExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const prompt = await readPrompt(process.argv.slice(2));
  const model = await resolveDefaultModel();

  const models = createModels();
  for (const provider of builtinProviders()) {
    models.setProvider(provider);
  }

  const agent = new Agent({
    initialState: {
      systemPrompt:
        "You are miniharness, a minimal headless assistant. Reply concisely and directly.",
      model,
      thinkingLevel: "off",
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
    model: last.model ?? model.id,
    provider: last.provider ?? model.provider,
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
    cost_microdollars: usage == null ? null : costMicrodollars(model, usage),
    duration_ms: durationMs,
  };

  process.stdout.write(JSON.stringify(envelope) + "\n");
}

main().catch((error) => {
  if (error instanceof ExitSignal) {
    // exitCode already set; let streams drain and the process exit naturally.
    return;
  }
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`miniharness: internal failure: ${detail}\n`);
  process.exitCode = 3;
});
