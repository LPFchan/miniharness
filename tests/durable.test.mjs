import test from "node:test";
import assert from "node:assert/strict";

import { omitUndefinedObjectFields } from "../dist/durable.js";

test("drops nested undefined object fields without mutating the message", () => {
  const message = {
    role: "assistant",
    usage: undefined,
    content: [{ type: "text", text: "ok", optional: undefined }],
  };

  const normalized = omitUndefinedObjectFields(message);
  assert.deepEqual(normalized, {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
  });
  assert.ok(Object.hasOwn(message, "usage"));
  assert.ok(Object.hasOwn(message.content[0], "optional"));
});

test("rejects undefined array elements instead of changing their position", () => {
  assert.throws(
    () => omitUndefinedObjectFields({ content: ["ok", undefined] }),
    /undefined array element/,
  );
});
