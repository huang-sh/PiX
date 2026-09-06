import test from "node:test";
import assert from "node:assert/strict";
import { agentEventForwarder } from "../src/main/agent-event-forwarder.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("coalesces cumulative progress before cloning and preserves lifecycle order and tool identities", async () => {
  const events: any[] = [];
  const forwarder = agentEventForwarder(event => events.push(event));
  let reads = 0;
  const message = { get content() { reads++; return "latest"; } };
  forwarder.push({ type: "agent_start", branchId: "A", runId: "run" });
  forwarder.push({ type: "message_start", message: { role: "assistant" } });
  for (let i = 0; i < 1000; i++) forwarder.push({ type: "message_update", message, assistantMessageEvent: { partial: message }, branchId: "A", runId: "run" });
  assert.equal(reads, 0, "superseded progress must never be cloned");
  forwarder.push({ type: "message_end", message: { content: "final" } });
  for (const toolCallId of ["one", "two"]) {
    forwarder.push({ type: "tool_execution_start", toolCallId });
    for (let i = 0; i < 10; i++) forwarder.push({ type: "tool_execution_update", toolCallId, partialResult: `value ${i}` });
  }
  forwarder.push({ type: "agent_settled" });
  assert.equal(events.length, 0, "SDK callbacks never call UI listeners inline");
  await tick();
  assert.equal(reads, 1);
  assert.deepEqual(events.map(e => e.type), ["agent_start", "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_start", "tool_execution_update", "agent_settled"]);
  assert.equal(events[2].assistantMessageEvent, undefined);
  assert.equal(events[2].branchId, "A");
  assert.equal(events[3].message.content, "final");
  assert.deepEqual(events.filter(e=>e.type === "tool_execution_update").map(e=>[e.toolCallId,e.partialResult]), [["one","value 9"],["two","value 9"]]);
  forwarder.dispose();
});

test("flushes a running stream on a bounded timer and cancels pending work on disposal", async () => {
  const events: unknown[] = [];
  const forwarder = agentEventForwarder(event => events.push(event));
  forwarder.push({ type: "message_update", message: { content: "live" } });
  await new Promise(resolve=>setTimeout(resolve, 80)); await tick();
  assert.equal(events.length, 1);
  forwarder.push({ type: "message_update", message: { content: "discarded" } });
  forwarder.dispose();
  await new Promise(resolve=>setTimeout(resolve, 80)); await tick();
  assert.equal(events.length, 1);
});
