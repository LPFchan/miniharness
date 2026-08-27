import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

export type GrimoirePayloadOptions = Readonly<{
  modelId: string;
  effort: ModelThinkingLevel;
  thinkingLevelMap?: ThinkingLevelMap;
}>;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Apply Grimoire's llama.cpp-native request controls after Pi builds its payload. */
export function transformGrimoirePayload(payload: unknown, options: GrimoirePayloadOptions): unknown {
  const source = object(payload);
  if (source === undefined) return payload;

  const transformed = { ...source };
  if (typeof transformed.max_tokens === "number" && transformed.max_tokens <= 0) delete transformed.max_tokens;
  if (typeof transformed.max_completion_tokens === "number" && transformed.max_completion_tokens <= 0) delete transformed.max_completion_tokens;
  delete transformed.reasoning_effort;

  const configured = object(source.chat_template_kwargs) ?? {};
  const chatTemplateKwargs: Record<string, unknown> = { ...configured };
  delete chatTemplateKwargs.reasoning_effort;
  delete chatTemplateKwargs.reasoning_strength;
  const mappedEffort = options.thinkingLevelMap?.[options.effort];
  const nativeEffort = typeof mappedEffort === "string" ? mappedEffort : options.effort;
  if (options.effort === "off") {
    chatTemplateKwargs.enable_thinking = false;
  } else if (options.modelId.toLowerCase().startsWith("muse-glimmer")) {
    delete chatTemplateKwargs.enable_thinking;
    chatTemplateKwargs.reasoning_strength = nativeEffort;
  } else {
    chatTemplateKwargs.enable_thinking = true;
    chatTemplateKwargs.reasoning_effort = nativeEffort;
  }
  transformed.chat_template_kwargs = chatTemplateKwargs;
  return transformed;
}
