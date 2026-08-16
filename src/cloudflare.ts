import type { FetchFunction } from "@earendil-works/pi-ai";

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
