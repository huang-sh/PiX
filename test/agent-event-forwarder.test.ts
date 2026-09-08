import test from "node:test";
import assert from "node:assert/strict";
import { agentEventForwarder } from "../src/main/agent-event-forwarder.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("forwards every update without a timer, captures mutable SDK content, and preserves lifecycle order", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: any[] = [];
  const forwarder = agentEventForwarder(event => events.push(event));
  const message = { role: "assistant", content: [{ type: "text", text: "" }] };
  forwarder.push({ type: "agent_start", branchId: "A", runId: "run" });
  forwarder.push({ type: "message_start", message });
  for (const text of ["a", "ab", "abc"]) {
    message.content[0]!.text = text;
    forwarder.push({ type: "message_update", message, assistantMessageEvent: { partial: message }, branchId: "A", runId: "run" });
  }
  forwarder.push({ type: "message_end", message });
  message.content[0]!.text = "mutated later";
  for (const toolCallId of ["one", "two"]) {
    forwarder.push({ type: "tool_execution_start", toolCallId });
    const partialResult = { content: [{ type: "text", text: "first" }] };
    forwarder.push({ type: "tool_execution_update", toolCallId, partialResult });
    partialResult.content[0]!.text = "last";
    forwarder.push({ type: "tool_execution_end", toolCallId, result: partialResult });
  }
  forwarder.push({ type: "agent_settled" });
  assert.equal(events.length, 0, "SDK callbacks never call UI listeners inline");
  await tick(); // No timer advancement: progress must already be delivered.
  assert.deepEqual(events.map(e => e.type), ["agent_start", "message_start", "message_update", "message_update", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "agent_settled"]);
  assert.deepEqual(events.slice(1, 6).map(e => e.message.content[0].text), ["", "a", "ab", "abc", "abc"]);
  assert.equal(events[2].assistantMessageEvent, undefined);
  assert.equal(events[2].branchId, "A");
  assert.deepEqual(events.filter(e => e.type === "tool_execution_update").map(e => [e.toolCallId, e.partialResult]), [["one", "first"], ["two", "first"]]);
  forwarder.dispose();
});

test("disposal cancels queued events and listener failures do not stop later delivery", async () => {
  const events: any[] = [];
  const forwarder = agentEventForwarder(event => {
    events.push(event);
    if (events.length === 1) throw Error("renderer closed");
  });
  forwarder.push({ type: "agent_start" });
  forwarder.push({ type: "message_end", message: { role: "assistant", content: [] } });
  await tick();
  assert.equal(events.length, 2);
  forwarder.push({ type: "agent_settled" });
  forwarder.dispose();
  forwarder.push({ type: "agent_start" });
  await tick();
  assert.equal(events.length, 2);
});
