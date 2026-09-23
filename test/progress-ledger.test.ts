import test from "node:test";
import assert from "node:assert/strict";
import { ProgressLedger } from "../src/main/progress-ledger.js";
import type { DesktopEvent, SessionSnapshot } from "../src/shared/types.js";

const snapshotOf = (id: string, epoch: string): SessionSnapshot => ({
  session: { path: id }, entries: [], projection: null as never, runtime: {} as never,
  graph: { id, epoch, revision: 1, runs: [] },
}) as unknown as SessionSnapshot;
const stream = (graphId: string, text = "streaming"): DesktopEvent => ({ type: "agent", payload: {
  type: "message_update", graphId, message: { role: "assistant", content: [{ type: "text", text }] },
} } as never);
const settle = (graphId: string): DesktopEvent => ({ type: "agent", payload: {
  type: "message_end", graphId, message: { role: "assistant", content: [{ type: "text", text: "done" }] },
} } as never);

function ledger(live: string[] = [], viewed?: string) {
  const set = new Set(live);
  return new ProgressLedger({
    isLiveSession: (id) => set.has(id),
    viewedGraphId: () => viewed,
  });
}

test("record keeps per-session baselines and replay returns only the viewed session's", () => {
  const l = ledger();
  const a1 = stream("a.jsonl", "first");
  const a2 = stream("a.jsonl", "second");
  const b = stream("b.jsonl");
  l.record(a1);
  l.record(a2);
  l.record(b);
  assert.deepEqual(l.replay("a.jsonl"), [a2], "the latest update of a run wins");
  assert.deepEqual(l.replay("b.jsonl"), [b]);
  assert.deepEqual(l.replay(undefined), []);
});

test("a settling message_end drops its session's baseline", () => {
  const l = ledger();
  l.record(stream("a.jsonl"));
  l.record(settle("a.jsonl"));
  assert.deepEqual(l.replay("a.jsonl"), []);
});

test("ingest notes the epoch of a sessions event and forgets baselines of a dropped host", () => {
  const l = ledger(["a.jsonl"]);
  l.ingest({ type: "sessions", payload: { current: snapshotOf("a.jsonl", "e1") } });
  l.ingest({ type: "sessions", payload: { current: snapshotOf("r.jsonl", "e1") } });
  assert.deepEqual([...l.epochs.keys()].sort(), ["a.jsonl", "r.jsonl"]);

  l.record(stream("a.jsonl"));
  l.record(stream("r.jsonl"));
  l.ingest({ type: "remote.connection", payload: { projectId: "r", connected: false, message: "" } });
  assert.deepEqual(l.replay("a.jsonl").length, 1, "a local session keeps its baseline");
  assert.deepEqual(l.replay("r.jsonl"), [], "a dropped host's runs are dead");

  // A connection carrying other payloads, or a reconnect, leaves baselines alone.
  l.record(stream("r.jsonl"));
  l.ingest({ type: "remote.connection", payload: { projectId: "r", connected: true, message: "" } });
  assert.deepEqual(l.replay("r.jsonl").length, 1);
});

test("a restarted epoch invalidates only its own session's baselines", () => {
  const l = ledger(["a.jsonl", "b.jsonl"]);
  l.ingest({ type: "sessions", payload: { current: snapshotOf("a.jsonl", "e1") } });
  l.ingest({ type: "sessions", payload: { current: snapshotOf("b.jsonl", "e1") } });
  l.record(stream("a.jsonl"));
  l.record(stream("b.jsonl"));
  l.ingest({ type: "sessions", payload: { current: snapshotOf("a.jsonl", "e2") } });
  assert.deepEqual(l.replay("a.jsonl"), [], "the restarted session's baseline goes");
  assert.deepEqual(l.replay("b.jsonl").length, 1, "other sessions keep theirs");
});

test("epoch records are pruned to the live set", () => {
  const l = ledger(["a.jsonl", "b.jsonl"]);
  l.ingest({ type: "sessions", payload: { current: snapshotOf("a.jsonl", "e1") } });
  l.ingest({ type: "sessions", payload: { current: snapshotOf("b.jsonl", "e1") } });

  // Neither live, mid-stream, nor in view: the record is inert and goes.
  const gone = ledger(["b.jsonl"]);
  gone.ingest({ type: "sessions", payload: { current: snapshotOf("old.jsonl", "e1") } });
  gone.ingest({ type: "sessions", payload: { current: snapshotOf("b.jsonl", "e1") } });
  assert.deepEqual([...gone.epochs.keys()], ["b.jsonl"]);

  // Mid-stream keeps the record without a live entry; the last baseline's death takes it.
  const midStream = ledger(["b.jsonl"], "b.jsonl");
  midStream.ingest({ type: "sessions", payload: { current: snapshotOf("r.jsonl", "e1") } });
  midStream.record(stream("r.jsonl"));
  midStream.ingest({ type: "sessions", payload: { current: snapshotOf("b.jsonl", "e1") } });
  assert.ok(midStream.epochs.has("r.jsonl"));
  midStream.record(settle("r.jsonl"));
  midStream.ingest({ type: "sessions", payload: { current: snapshotOf("b.jsonl", "e1") } });
  assert.ok(!midStream.epochs.has("r.jsonl"));

  // The session in view keeps its record without a live entry.
  const viewed = ledger([], "r.jsonl");
  viewed.ingest({ type: "sessions", payload: { current: snapshotOf("r.jsonl", "e1") } });
  viewed.ingest({ type: "sessions", payload: { current: snapshotOf("b.jsonl", "e1") } });
  assert.ok(viewed.epochs.has("r.jsonl"));
});

test("clear drops every baseline", () => {
  const l = ledger(["a.jsonl"]);
  l.record(stream("a.jsonl"));
  l.clear();
  assert.deepEqual(l.replay("a.jsonl"), []);
});
