import test from "node:test";
import assert from "node:assert/strict";
import { reduceAgentActivity } from "../src/shared/agent-stream.js";

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
