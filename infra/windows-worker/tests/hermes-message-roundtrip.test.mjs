import test from "node:test";
import assert from "node:assert/strict";

const {
  restoreAgentMessage,
  serializeAgentMessage,
} = await import("../../../src/lib/hermes-agent.ts");

test("assistant tool_calls survive storage round trip", () => {
  const message = {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "query_bitable",
          arguments: '{"table":"requirements"}',
        },
      },
    ],
  };

  const stored = serializeAgentMessage(message, "conversation-1", "feishu-message-1");
  const restored = restoreAgentMessage(stored);

  assert.deepEqual(restored, message);
  assert.deepEqual(stored.tool_calls, message.tool_calls);
});

test("tool message tool_call_id and name survive storage round trip", () => {
  const message = {
    role: "tool",
    content: '{"rows":[]}',
    tool_call_id: "call-1",
    name: "query_bitable",
  };

  const stored = serializeAgentMessage(message, "conversation-1", "feishu-message-1");
  const restored = restoreAgentMessage(stored);

  assert.deepEqual(restored, message);
  assert.equal(stored.tool_call_id, "call-1");
  assert.equal(stored.name, "query_bitable");
});

test("ordinary user and assistant messages remain compatible", () => {
  const user = { role: "user", content: "hello" };
  const assistant = { role: "assistant", content: "hi" };

  const storedUser = serializeAgentMessage(user, "conversation-1", "feishu-message-1");
  const storedAssistant = serializeAgentMessage(assistant, "conversation-1", "feishu-message-1");

  assert.deepEqual(restoreAgentMessage(storedUser), user);
  assert.deepEqual(restoreAgentMessage(storedAssistant), assistant);
  assert.equal(storedUser.feishu_message_id, "feishu-message-1");
  assert.equal(storedAssistant.feishu_message_id, null);
  assert.equal(storedUser.tool_calls, null);
  assert.equal(storedAssistant.name, null);
});

test("invalid tool_calls are ignored without breaking history restoration", () => {
  const malformedRows = [
    { role: "assistant", content: "one", tool_calls: "invalid" },
    { role: "assistant", content: "two", tool_calls: [{ id: "call-1" }] },
    { role: "assistant", content: "three", tool_calls: null },
  ];

  for (const row of malformedRows) {
    assert.doesNotThrow(() => restoreAgentMessage(row));
    assert.equal(restoreAgentMessage(row).tool_calls, undefined);
  }
});
