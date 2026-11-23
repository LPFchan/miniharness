import type { FetchFunction, ModelThinkingLevel } from "@earendil-works/pi-ai";

interface CompletionChoice {
  index?: number;
  message?: Record<string, unknown> & {
    tool_calls?: Record<string, unknown>[];
  };
  finish_reason?: unknown;
  logprobs?: unknown;
}

interface Completion {
  id?: unknown;
  created?: unknown;
  model?: unknown;
  choices?: CompletionChoice[];
  usage?: unknown;
  system_fingerprint?: unknown;
  service_tier?: unknown;
}

function requestUrl(input: Parameters<FetchFunction>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function completionChunk(completion: Completion): Record<string, unknown> {
  const choices = (completion.choices ?? []).map((choice, choiceIndex) => {
    const message = choice.message ?? {};
    const toolCalls = message.tool_calls?.map((call, callIndex) => ({
      ...call,
      index: callIndex,
    }));
    const delta = {
      ...message,
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
    };
    return {
      index: choice.index ?? choiceIndex,
      delta,
      finish_reason: choice.finish_reason ?? null,
      ...(choice.logprobs === undefined ? {} : { logprobs: choice.logprobs }),
    };
  });

  return {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices,
    ...(completion.usage === undefined ? {} : { usage: completion.usage }),
    ...(completion.system_fingerprint === undefined
      ? {}
      : { system_fingerprint: completion.system_fingerprint }),
    ...(completion.service_tier === undefined ? {} : { service_tier: completion.service_tier }),
  };
}

/**
 * Cloudflare Workers AI can leave OpenAI-compatible SSE responses open after
 * a tool result. Request a completed response instead, then present it to Pi
 * as a single valid SSE chunk so the rest of the agent loop stays unchanged.
 */
export function cloudflareCompletedResponseFetch(baseFetch: FetchFunction = globalThis.fetch): FetchFunction {
  return async (input, init) => {
    const body = init?.body;
    if (!requestUrl(input).includes("/chat/completions") || typeof body !== "string") {
      return baseFetch(input, init);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return baseFetch(input, init);
    }
    if (payload.stream !== true) return baseFetch(input, init);

    const completedPayload: Record<string, unknown> = { ...payload, stream: false };
    delete completedPayload.stream_options;
    const response = await baseFetch(input, {
      ...init,
      body: JSON.stringify(completedPayload),
    });
    if (!response.ok) return response;

    const completion = (await response.json()) as Completion;
    const chunk = completionChunk(completion);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set("content-type", "text/event-stream");
    headers.set("cache-control", "no-cache");
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

export type CloudflarePayloadOptions = Readonly<{
  effort: ModelThinkingLevel;
  providerDefault?: boolean;
}>;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Apply Cloudflare Workers AI chat-template thinking controls after Pi builds
 * its payload. Reasoning models on Workers AI (e.g. Gemma 4) default to
 * thinking on unless `chat_template_kwargs.enable_thinking` is explicitly
 * `false`; `--effort default` omits the control to preserve provider default.
 */
export function transformCloudflarePayload(
  payload: unknown,
  options: CloudflarePayloadOptions,
): unknown {
  const source = object(payload);
  if (source === undefined) return payload;

  const transformed: Record<string, unknown> = { ...source };
  const configured = object(source.chat_template_kwargs) ?? {};
  const chatTemplateKwargs: Record<string, unknown> = { ...configured };

  if (options.providerDefault === true) {
    delete chatTemplateKwargs.enable_thinking;
    if (Object.keys(chatTemplateKwargs).length === 0) {
      delete transformed.chat_template_kwargs;
    } else {
      transformed.chat_template_kwargs = chatTemplateKwargs;
    }
    return transformed;
  }

  if (options.effort === "off") {
    delete transformed.reasoning_effort;
    chatTemplateKwargs.enable_thinking = false;
    transformed.chat_template_kwargs = chatTemplateKwargs;
    return transformed;
  }

  chatTemplateKwargs.enable_thinking = true;
  transformed.chat_template_kwargs = chatTemplateKwargs;
  return transformed;
}
