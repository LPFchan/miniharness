import test from "node:test";
import assert from "node:assert/strict";
import { transformGrimoirePayload } from "../dist/grimoire.js";
import { composeGrimoirePayloadTransform } from "../dist/config.js";

test("Grimoire off disables llama.cpp thinking and omits the uncapped sentinel", () => {
  const payload = transformGrimoirePayload({
    model: "qwen3.8-27B",
    max_completion_tokens: -1,
    chat_template_kwargs: { preserve_thinking: true },
  }, {
    modelId: "qwen3.8-27B",
    effort: "off",
  });
  assert.deepEqual(payload, {
    model: "qwen3.8-27B",
    chat_template_kwargs: { preserve_thinking: true, enable_thinking: false },
  });
});

test("Grimoire Qwen reasoning uses native chat-template effort", () => {
  const payload = transformGrimoirePayload({ model: "qwen3.8-27B-xhigh", reasoning_effort: "xhigh" }, {
    modelId: "qwen3.8-27B-xhigh",
    effort: "xhigh",
    thinkingLevelMap: { xhigh: "maximum" },
  });
  assert.deepEqual(payload, {
    model: "qwen3.8-27B-xhigh",
    chat_template_kwargs: { enable_thinking: true, reasoning_effort: "maximum" },
  });
});

test("Grimoire provider default omits llama.cpp reasoning controls", () => {
  const payload = transformGrimoirePayload({
    model: "qwen3.8-27B",
    reasoning_effort: "off",
    chat_template_kwargs: { preserve_thinking: true, enable_thinking: false },
  }, {
    modelId: "qwen3.8-27B",
    effort: "off",
    providerDefault: true,
  });
  assert.deepEqual(payload, {
    model: "qwen3.8-27B",
    chat_template_kwargs: { preserve_thinking: true },
  });
});

test("Grimoire Muse reasoning uses native reasoning strength", () => {
  const payload = transformGrimoirePayload({ model: "muse-glimmer-30b-high", max_tokens: 4096 }, {
    modelId: "muse-glimmer-30b-high",
    effort: "high",
  });
  assert.deepEqual(payload, {
    model: "muse-glimmer-30b-high",
    max_tokens: 4096,
    chat_template_kwargs: { reasoning_strength: "high" },
  });
});

test("Grimoire request composition follows per-request reasoning and preserves prior transforms", async () => {
  const model = {
    id: "qwen3.8-27B-xhigh",
    thinkingLevelMap: { xhigh: "xhigh" },
  };
  const main = composeGrimoirePayloadTransform({
    reasoning: "xhigh",
    onPayload: (payload) => ({ ...payload, prior: true }),
  });
  assert.deepEqual(await main.onPayload({ max_completion_tokens: 4096 }, model), {
    max_completion_tokens: 4096,
    prior: true,
    chat_template_kwargs: { enable_thinking: true, reasoning_effort: "xhigh" },
  });

  const mandatory = composeGrimoirePayloadTransform({ reasoning: "high" });
  assert.deepEqual(await mandatory.onPayload({}, {
    id: "qwen3.8-27B-high",
    thinkingLevelMap: { off: null, high: "high" },
  }), {
    chat_template_kwargs: { enable_thinking: true, reasoning_effort: "high" },
  });

  const compaction = composeGrimoirePayloadTransform({});
  assert.deepEqual(await compaction.onPayload({ max_completion_tokens: 13107 }, model), {
    max_completion_tokens: 13107,
    chat_template_kwargs: { enable_thinking: false },
  });
});
