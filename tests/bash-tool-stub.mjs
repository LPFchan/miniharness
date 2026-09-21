/**
 * Provider stub for the built-in bash tool tests.
 *
 * Records the tool names offered on every turn, and optionally drives one real
 * tool round trip: turn 1 emits a `bash` tool call carrying
 * MINIHARNESS_BASH_COMMAND, turn 2 replies with text once the loop has fed the
 * tool result back. The recorded turns are the assertion surface.
 */

import { createAssistantMessageEventStream, createProvider } from '@earendil-works/pi-ai';
import { readFileSync, writeFileSync } from 'node:fs';

export const STUB_MODEL = 'stub-bash-tool';

function usage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Append this turn to the capture file, which the test reads back as JSON. */
function record(capture, entry) {
  if (!capture) return 0;
  let turns = [];
  try {
    turns = JSON.parse(readFileSync(capture, 'utf8'));
  } catch {
    turns = [];
  }
  turns.push(entry);
  writeFileSync(capture, JSON.stringify(turns));
  return turns.length - 1;
}

function streamSimple(model, context, _options) {
  const capture = process.env.MINIHARNESS_BASH_CAPTURE;
  const turnIndex = record(capture, {
    tools: (context.tools ?? []).map((tool) => tool.name),
    messages: JSON.stringify(context.messages ?? []),
  });

  const command = process.env.MINIHARNESS_BASH_COMMAND;
  const stream = createAssistantMessageEventStream();
  const base = {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason: 'pending',
    timestamp: Date.now(),
  };

  // Only the first turn issues the tool call; the loop's second call must see
  // the tool result already in context and finish with text.
  if (command !== undefined && turnIndex === 0) {
    const toolCall = {
      type: 'toolCall',
      id: 'call-bash-1',
      name: 'bash',
      arguments: { command },
    };
    const message = { ...base, content: [toolCall], stopReason: 'toolUse', usage: usage() };
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: base });
      stream.push({ type: 'toolcall_start', contentIndex: 0, partial: base });
      stream.push({
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: JSON.stringify({ command }),
        partial: message,
      });
      stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message });
      stream.end(message);
    });
    return stream;
  }

  const message = {
    ...base,
    content: [{ type: 'text', text: 'stub reply' }],
    stopReason: 'stop',
    usage: usage(),
  };
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: base });
    stream.push({ type: 'text_start', contentIndex: 0, partial: base });
    stream.push({ type: 'text_delta', contentIndex: 0, delta: 'stub reply', partial: message });
    stream.push({ type: 'text_end', contentIndex: 0, content: 'stub reply', partial: message });
    stream.end(message);
  });
  return stream;
}

export function registerTestProvider(models) {
  models.setProvider(createProvider({
    id: 'stub',
    name: 'stub',
    baseUrl: 'http://stub.local/v1',
    auth: {
      apiKey: {
        name: 'stub key',
        resolve: async () => ({ auth: { apiKey: 'test-key' }, source: 'test' }),
      },
    },
    models: [{
      id: STUB_MODEL,
      name: STUB_MODEL,
      api: 'openai-completions',
      provider: 'stub',
      baseUrl: 'http://stub.local/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    }],
    api: { 'openai-completions': { streamSimple } },
  }));
}
