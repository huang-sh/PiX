import test from "node:test";
import assert from "node:assert/strict";
import { sessionEventDecoder, sessionEventEncoder } from "../src/shared/session-updates.js";
import { agentMessageContent, reduceAgentActivity } from "../src/shared/agent-stream.js";
import type { AgentActivity, DesktopEvent } from "../src/shared/types.js";

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const event = (branchId: string, text: string, thinking = ""): DesktopEvent => ({ type: "agent", payload: {
  type: "message_update", graphId: "g", branchId, runId: branchId + "1",
  message: { role: "assistant", content: [{ type: "text", text }, { type: "thinking", thinking }] },
} });
const tool = (id: string, text: string): DesktopEvent => ({ type: "agent", payload: {
  type: "tool_execution_update", graphId: "g", branchId: "A", runId: "A1", toolCallId: id, partialResult: text,
} });

test("interleaved branches and tools transmit only appended text and reconstruct full state across both remote hops", () => {
  const hostEncoder = sessionEventEncoder(), desktopEncoder = sessionEventEncoder();
  const hostDecoder = sessionEventDecoder(async () => assert.fail("unexpected host resync"));
  const uiDecoder = sessionEventDecoder(async () => assert.fail("unexpected UI resync"));
  const prefix = "中文🙂 long reply ".repeat(3000);
  let bytes = 0;
  for (let i = 0; i < 50; i++) {
    for (const original of [event("A", prefix + "a".repeat(i), "think" + "x".repeat(i)),
      event("B", prefix + "b".repeat(i)), tool("one", prefix + "1".repeat(i)), tool("two", "2".repeat(i))]) {
      const encoded = wire(hostEncoder(original));
      if (i) {
        bytes += JSON.stringify(encoded).length;
        assert.ok(JSON.stringify(encoded).length < 600, "per-token payload must not grow with the reply");
      }
      const decoded = hostDecoder(encoded)!;
      const output = uiDecoder(wire(desktopEncoder(decoded)))!;
      const expected = original.payload as any, actual = output.payload as any;
      if (expected.type === "message_update") {
        assert.equal(agentMessageContent(actual.message, "text"), agentMessageContent(expected.message, "text"));
        assert.equal(agentMessageContent(actual.message, "thinking"), agentMessageContent(expected.message, "thinking"));
      } else assert.equal(actual.partialResult, expected.partialResult);
    }
  }
  assert.ok(bytes < 120000);
});

test("replacement, truncation, missing start, lifecycle completion and new runs preserve activity", () => {
  const encode = sessionEventEncoder(), decode = sessionEventDecoder(async () => assert.fail("unexpected resync"));
  let activity: AgentActivity | undefined;
  for (const text of ["initial text", "initial text plus", "replacement", "", "final text"]) {
    const decoded = decode(wire(encode(event("A", text))))!;
    activity = reduceAgentActivity(activity, decoded.payload);
    assert.equal(activity?.items[0]?.text, text);
  }
  const end: DesktopEvent = { type: "agent", payload: { ...(event("A", "corrected final").payload as any), type: "message_end" } };
  activity = reduceAgentActivity(activity, decode(wire(encode(end)))!.payload);
  assert.equal(activity?.items[0]?.text, "corrected final");
  assert.equal(activity?.items[0]?.status, "complete");
  const next = encode(event("A", "next message"));
  assert.equal((next.payload as any).progress.baseRevision, undefined);
  const restarted = event("A", "new run"); (restarted.payload as any).runId = "A2";
  assert.equal((encode(restarted).payload as any).progress.baseRevision, undefined);
});

test("missed updates and a reloaded decoder request one resync and accept a full checkpoint", async () => {
  const encode = sessionEventEncoder();
  let requests = 0, release!: () => void;
  const decode = sessionEventDecoder(() => { requests++; return new Promise<void>(resolve => { release = resolve; }); });
  decode(wire(encode(event("A", "one"))));
  encode(event("A", "one two")); // Lost event.
  assert.equal(decode(wire(encode(event("A", "one two three")))), undefined);
  assert.equal(decode(wire(encode(event("A", "one two three four")))), undefined);
  assert.equal(requests, 1);
  // Production resyncs always carry the current snapshot (session.snapshot).
  const checkpoint: DesktopEvent = { type: "sessions", payload: { resync: true,
    current: { session: { path: "s" }, graph: { id: "s", epoch: "e", revision: 1, runs: [] } } as never } };
  decode(wire(encode(checkpoint)));
  const recovered = decode(wire(encode(event("A", "complete live text"))));
  assert.equal(agentMessageContent((recovered!.payload as any).message, "text"), "complete live text");
  release(); await Promise.resolve();
  const reloaded = sessionEventDecoder(async () => { requests++; });
  assert.equal(reloaded(wire(encode(event("A", "complete live text!")))), undefined);
  assert.equal(requests, 2);
});

test("list-only session events keep progress deltas and snapshot patches incremental", () => {
  const encode = sessionEventEncoder(), decode = sessionEventDecoder(async () => assert.fail("unexpected resync"));
  decode(wire(encode(event("A", "one"))));
  // A background session's list refresh carries no snapshot; it must not reset
  // the baselines of the session streaming in view.
  decode(wire(encode({ type: "sessions", payload: { sessions: [] } })));
  const second = encode(event("A", "one two"));
  assert.equal((second.payload as any).progress.baseRevision, 1);
  assert.equal((second.payload as any).progress.text.value, " two");
  const decoded = decode(wire(second))!;
  assert.equal(agentMessageContent((decoded.payload as any).message, "text"), "one two");

  const before = { session: { path: "s" }, entries: [], projection: { nodes: [] }, runtime: {},
    graph: { id: "s", epoch: "e", revision: 1, runs: [] } } as any;
  const after = { ...before, graph: { ...before.graph, revision: 2 } };
  encode({ type: "sessions", payload: { current: before } });
  encode({ type: "sessions", payload: { sessions: [] } });
  const patch = encode({ type: "sessions", payload: { current: after } });
  assert.equal((patch.payload as any).patch?.baseRevision, 1, "snapshot patching survives list-only events");
});
