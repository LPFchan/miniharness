/**
 * Stub provider registration for the compaction tests. The harness loads
 * this module (via MINIHARNESS_EXTRA_PROVIDER) and calls registerTestProvider
 * to add the stub to its Models instance. streamSimple returns a pre-built
 * event stream, so no network or credentials are ever touched.
 */

import { createAssistantMessageEventStream, createProvider } from '@earendil-works/pi-ai';

export const STUB_MODEL = 'stub-overflow-1';

let streamSimpleCalls = 0;

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
            streamSimpleCalls++;
            const stream = createAssistantMessageEventStream();
            const base = {
              role: 'assistant',
              api: 'openai-completions',
              provider: 'stub',
              model: STUB_MODEL,
              usage: usage(),
              stopReason: 'pending',
              timestamp: Date.now(),
            };
            if (
              streamSimpleCalls > 1 &&
              process.env.MINIHARNESS_COMPACTION_FAILURE === 'returned'
            ) {
              const error = {
                ...base,
                content: [],
                stopReason: 'error',
                errorMessage: 'stub compaction failure',
              };
              stream.push({ type: 'error', reason: 'error', error });
              return stream;
            }
            stream.push({
              type: 'start',
              partial: {
                ...base,
                content: [],
              },
            });
            stream.push({
              type: 'text_start',
              contentIndex: 0,
              partial: { ...base, content: [{ type: 'text', text: '' }] },
            });
            stream.push({
              type: 'text_delta',
              contentIndex: 0,
              delta: 'stub reply',
              partial: { ...base, content: [{ type: 'text', text: 'stub reply' }] },
            });
            stream.push({
              type: 'text_end',
              contentIndex: 0,
              content: 'stub reply',
              partial: { ...base, content: [{ type: 'text', text: 'stub reply' }] },
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
