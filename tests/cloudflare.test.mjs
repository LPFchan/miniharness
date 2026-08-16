import test from "node:test";
import assert from "node:assert/strict";
import { cloudflareCompletedResponseFetch } from "../dist/cloudflare.js";

function parseSse(responseText) {
  const lines = responseText.trim().split("\n\n");
  assert.equal(lines.at(-1), "data: [DONE]");
  return JSON.parse(lines[0].slice("data: ".length));
}

test("Cloudflare adapter requests a completed response and returns one SSE chunk", async () => {
  let sent;
  const baseFetch = async (_input, init) => {
    sent = JSON.parse(init.body);
    return Response.json({
      id: "chat-1",
      object: "chat.completion",
      created: 123,
      model: "gemma",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "finished", reasoning_content: "done thinking" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  };

  const response = await cloudflareCompletedResponseFetch(baseFetch)(
    "https://api.cloudflare.com/client/v4/accounts/example/ai/v1/chat/completions",
    {
      method: "POST",
      body: JSON.stringify({ model: "gemma", stream: true, stream_options: { include_usage: true } }),
    },
  );

  assert.deepEqual(sent, { model: "gemma", stream: false });
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const chunk = parseSse(await response.text());
  assert.equal(chunk.object, "chat.completion.chunk");
  assert.deepEqual(chunk.choices[0], {
    index: 0,
    delta: { role: "assistant", content: "finished", reasoning_content: "done thinking" },
    finish_reason: "stop",
  });
  assert.equal(chunk.usage.total_tokens, 12);
});

test("Cloudflare adapter makes completed tool calls valid streaming deltas", async () => {
  const baseFetch = async () =>
    Response.json({
      id: "chat-tool",
      created: 124,
      model: "gemma",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call-1", type: "function", function: { name: "query_cost", arguments: '{"scope":"all"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

  const response = await cloudflareCompletedResponseFetch(baseFetch)(
    "https://api.cloudflare.com/ai/v1/chat/completions",
    { method: "POST", body: JSON.stringify({ stream: true }) },
  );
  const chunk = parseSse(await response.text());
  assert.equal(chunk.choices[0].delta.tool_calls[0].index, 0);
  assert.equal(chunk.choices[0].delta.tool_calls[0].function.name, "query_cost");
  assert.equal(chunk.choices[0].finish_reason, "tool_calls");
});

test("Cloudflare adapter passes through unrelated and failed requests", async () => {
  const calls = [];
  const failed = new Response("unavailable", { status: 503 });
  const baseFetch = async (input, init) => {
    calls.push({ input, init });
    return calls.length === 1 ? new Response("ordinary") : failed;
  };
  const adapted = cloudflareCompletedResponseFetch(baseFetch);

  const ordinary = await adapted("https://example.test/models", { method: "GET" });
  assert.equal(await ordinary.text(), "ordinary");
  const failure = await adapted("https://api.cloudflare.com/ai/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ stream: true }),
  });
  assert.equal(failure, failed);
  assert.equal(JSON.parse(calls[1].init.body).stream, false);
});
