/**
 * Stub provider registration for the compaction tests. The harness loads
 * this module (via MINIHARNESS_EXTRA_PROVIDER) and calls registerTestProvider
 * to add the stub to its Models instance. streamSimple returns a pre-built
 * event stream, so no network or credentials are ever touched.
 */

import { createAssistantMessageEventStream, createProvider } from '@earendil-works/pi-ai';

export const STUB_MODEL = 'stub-overflow-1';

function usage(extra = {}) {
  return {
    input: 40,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    ...extra,
  };
}

export function registerTestProvider(models) {
  models.setProvider(
    createProvider({
      id: 'stub',
      name: 'stub',
      baseUrl: 'http://stub.local/v1',
      auth: {
        apiKey: {
          name: 'stub key',
          resolve: async () => ({ auth: { apiKey: 'test-key' }, source: 'test' }),
        },
      },
      models: [
        {
          id: STUB_MODEL,
          name: 'stub overflow model',
          api: 'openai-completions',
          provider: 'stub',
          baseUrl: 'http://stub.local/v1',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 512,
          maxTokens: 128,
        },
      ],
      api: {
        'openai-completions': {
          streamSimple: () => {
            const stream = createAssistantMessageEventStream();
            stream.push({
              type: 'start',
              partial: {
                role: 'assistant',
                content: [],
                api: 'openai-completions',
                provider: 'stub',
                model: STUB_MODEL,
                usage: usage(),
                stopReason: 'pending',
                timestamp: Date.now(),
              },
            });
            stream.end({
              role: 'assistant',
              content: [{ type: 'text', text: 'stub reply' }],
              api: 'openai-completions',
              provider: 'stub',
              model: STUB_MODEL,
            usage: usage({ input: 1024, output: 8 }),
              stopReason: 'stop',
              timestamp: Date.now(),
            });
            return stream;
          },
        },
      },
    }),
  );
}
