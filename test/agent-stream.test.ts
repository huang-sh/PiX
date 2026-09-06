import test from "node:test";
import assert from "node:assert/strict";
import { reduceAgentActivity } from "../src/shared/agent-stream.js";

test("recovers cumulative assistant and tool output without their start events", () => {
  let activity = reduceAgentActivity(undefined, { type: "message_update", message: {
    role: "assistant", content: [{ type: "text", text: "already streaming" }],
  } });
  assert.equal(activity?.partial, true);
  assert.equal(activity?.items[0]?.text, "already streaming");
  activity = reduceAgentActivity(activity, { type: "message_end", message: {
    role: "assistant", content: [{ type: "text", text: "complete" }],
  } });
  assert.equal(activity?.items.length, 1);
  assert.equal(activity?.items[0]?.status, "complete");
  activity = reduceAgentActivity(activity, { type: "tool_execution_update", toolCallId: "read", toolName: "read",
    partialResult: { content: [{ type: "text", text: "partial tool output" }] } });
  activity = reduceAgentActivity(activity, { type: "tool_execution_end", toolCallId: "read",
    result: { content: [{ type: "text", text: "tool completed" }] } });
  assert.equal(activity?.items.length, 2);
  assert.equal(activity?.items[1]?.text, "tool completed");
  assert.equal(activity?.items[1]?.status, "complete");
  activity = reduceAgentActivity(activity, { type: "agent_settled" });
  assert.equal(activity?.active, false);
  assert.equal(reduceAgentActivity(undefined, { type: "agent_settled" }), undefined);
});

test("reduces Pi assistant and tool streams until agent_settled", () => {
  let activity = reduceAgentActivity(undefined, { type: "agent_start" });
  activity = reduceAgentActivity(activity, {
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  activity = reduceAgentActivity(activity, {
    type: "message_update",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "checking" },
        { type: "text", text: "I found\nTool: read" },
      ],
    },
  });
  activity = reduceAgentActivity(activity, {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read",
    args: { path: "README.md" },
  });
  activity = reduceAgentActivity(activity, {
    type: "tool_execution_update",
    toolCallId: "call-1",
    partialResult: { content: [{ type: "text", text: "partial" }] },
  });
  activity = reduceAgentActivity(activity, {
    type: "tool_execution_end",
    toolCallId: "call-1",
    result: { content: [{ type: "text", text: "done" }] },
    isError: false,
  });
  activity = reduceAgentActivity(activity, { type: "agent_settled" });

  assert.equal(activity?.active, false);
  assert.equal(activity?.items.find((item) => item.kind === "tool")?.input, "README.md");
  assert.deepEqual(
    activity?.items.map(({ kind, text, thinking, status }) => ({ kind, text, thinking, status })),
    [
      { kind: "assistant", text: "I found", thinking: "checking", status: "running" },
      { kind: "tool", text: "done", thinking: undefined, status: "complete" },
    ],
  );
});

test("marks a failed assistant message with its error detail", () => {
  let activity = reduceAgentActivity(undefined, { type: "agent_start" });
  activity = reduceAgentActivity(activity, {
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  activity = reduceAgentActivity(activity, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: '401: {"message":"Authentication Fails"}',
    },
  });
  activity = reduceAgentActivity(activity, { type: "agent_settled" });

  const failed = activity?.items.find((item) => item.kind === "assistant");
  assert.equal(failed?.status, "error");
  assert.equal(failed?.errorMessage, '401: {"message":"Authentication Fails"}');
  assert.equal(activity?.currentAssistantId, undefined);
});
