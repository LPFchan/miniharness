import { createAssistantMessageEventStream, createProvider } from '@earendil-works/pi-ai';
import { writeFileSync } from 'node:fs';

export const STUB_MODEL = 'stub-generation-params';

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

function streamSimple(model, context, options) {
  const capture = process.env.MINIHARNESS_GEN_PARAMS_CAPTURE;
  if (capture) {
    writeFileSync(capture, JSON.stringify({
      context: { systemPrompt: context.systemPrompt, messages: context.messages },
      options,
    }));
  }
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
  queueMicrotask(() => {
    const message = {
      ...base,
      content: [{ type: 'text', text: 'stub reply' }],
      stopReason: 'stop',
      usage: usage(),
    };
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
