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
  assert.equal(activity?.items[1]?.timestamp, undefined, "a recovered call must not invent its start time");
  activity = reduceAgentActivity(activity, { type: "agent_settled" });
  assert.equal(activity?.active, false);
  assert.equal(reduceAgentActivity(undefined, { type: "agent_settled" }), undefined);
});

test("tool timing uses SDK durations for successful, failed and recovered calls", () => {
  let activity = reduceAgentActivity(undefined, { type: "tool_execution_start", toolCallId: "outer", toolName: "codemode" });
  const timestamp = activity?.items[0]?.timestamp;
  assert.ok(timestamp && Number.isFinite(Date.parse(timestamp)));
  activity = reduceAgentActivity(activity, { type: "tool_execution_end", toolCallId: "outer", durationMs: 1234,
    result: { content: [] } });
  assert.equal(activity?.items[0]?.timestamp, timestamp);
  assert.equal(activity?.items[0]?.durationMs, 1234);
  activity = reduceAgentActivity(activity, { type: "tool_execution_end", toolCallId: "failed", durationMs: 0,
    isError: true, result: { content: [] } });
  assert.equal(activity?.items[1]?.timestamp, undefined);
  assert.equal(activity?.items[1]?.durationMs, 0);
  assert.equal(activity?.items[1]?.status, "error");
  for (const durationMs of [undefined, -1, NaN, Infinity, "12"]) {
    const recovered = reduceAgentActivity(undefined, { type: "tool_execution_end", toolCallId: "old", durationMs, result: {} });
    assert.equal(recovered?.items[0]?.durationMs, undefined);
  }
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

test("user messages count as new passes only when steered in after the opening echo", () => {
  // Pi 1.5.0 echoes the prompt right after agent_start: the pass's first
  // user message, never a steer.
  let activity = reduceAgentActivity(undefined, { type: "agent_start" });
  activity = reduceAgentActivity(activity, { type: "message_start", message: { role: "system", content: [] } });
  activity = reduceAgentActivity(activity, {
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "regular prompt" }] },
  });
  assert.equal(activity?.pass, 1);
  assert.equal(activity?.promptEchoed, true);
  // A steer in the gap before any output still begins a new visible turn.
  activity = reduceAgentActivity(activity, {
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "gap steer" }] },
  });
  assert.equal(activity?.pass, 2);
  assert.equal(activity?.items.length, 0);
  activity = reduceAgentActivity(activity, {
    type: "message_start",
    message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
  });
  assert.equal(activity?.items[0]!.pass, 2);
  // The next run's agent_start resets the pass and the echo marker.
  activity = reduceAgentActivity(activity, { type: "agent_settled" });
  activity = reduceAgentActivity(activity, { type: "agent_start" });
  assert.equal(activity?.pass, 1);
  assert.equal(activity?.promptEchoed, undefined);
  // An auto-retry's agent_start bumps the pass and keeps the visible output.
  activity = reduceAgentActivity(activity, {
    type: "message_start",
    message: { role: "assistant", content: [{ type: "text", text: "partial answer" }] },
  });
  activity = reduceAgentActivity(activity, { type: "agent_start" });
  assert.equal(activity?.pass, 2);
  assert.equal(activity?.items.length, 1);
});

test("a view attached mid-run counts a following user message as steered", () => {
  let activity = reduceAgentActivity(undefined, {
    type: "message_start",
    message: { role: "assistant", content: [{ type: "text", text: "already streaming" }] },
  });
  assert.equal(activity?.partial, true);
  activity = reduceAgentActivity(activity, {
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "late steer" }] },
  });
  assert.equal(activity?.pass, 2);
});

test("a mid-run user message starts a fresh live view for the new turn", () => {
  let activity = reduceAgentActivity(undefined, { type: "agent_start" });
  activity = reduceAgentActivity(activity, {
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "opening prompt" }] },
  });
  activity = reduceAgentActivity(activity, {
    type: "message_start",
    message: { role: "assistant", content: [{ type: "toolCall", id: "a", name: "toolA" }] },
  });
  for (const [id, name] of [["a", "toolA"], ["b", "toolB"], ["c", "toolC"]] as const) {
    activity = reduceAgentActivity(activity, { type: "tool_execution_start", toolCallId: id, toolName: name, args: {} });
    activity = reduceAgentActivity(activity, { type: "tool_execution_end", toolCallId: id, result: { content: [] }, isError: false });
  }
  // The steered user message lands between tool c and tool d.
  activity = reduceAgentActivity(activity, {
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "urgent steer" }] },
  });
  assert.equal(activity?.active, true);
  assert.equal(activity?.items.length, 0);
  assert.equal(activity?.pass, 2);
  activity = reduceAgentActivity(activity, {
    type: "tool_execution_start", toolCallId: "d", toolName: "toolD", args: {},
  });
  assert.deepEqual(
    activity?.items.map(item => (item as { title?: string }).title),
    ["toolD"],
  );
});
