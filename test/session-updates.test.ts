import test from "node:test";
import assert from "node:assert/strict";
import { projectSession } from "../src/shared/session.js";
import { applySessionPatch, sessionEventDecoder, sessionEventEncoder, sessionPatch, type SessionUpdate } from "../src/shared/session-updates.js";
import type { DesktopEvent, RawSessionEntry, SessionSnapshot } from "../src/shared/types.js";

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function snapshot(entries: RawSessionEntry[], revision: number): SessionSnapshot {
  return { session: { id: "s", path: "s", cwd: ".", created: "", modified: "", messageCount: entries.length, firstMessage: "prompt" },
    entries, projection: projectSession(entries, entries.at(-1)?.id ?? null), runtime: { available: true } as SessionSnapshot["runtime"],
    graph: { id: "s", epoch: "e", revision, runs: [] } };
}
const user = (id: string, parentId: string | null = null): RawSessionEntry => ({ id, parentId, type: "message", timestamp: "2026-01-01", message: { role: "user", content: id } });
const event = (current: SessionSnapshot, resync = false): DesktopEvent => ({ type: "sessions", payload: { current, resync } });

test("wire patches reproduce inserts, updates, deletions, metadata removal and compaction", () => {
  let current = snapshot([user("one"), user("two")], 1);
  current.graph!.recoveredInputs = [{ requestId: "r", text: "saved" }];
  const steps = [
    snapshot([current.entries[0]!, user("inserted", "one"), current.entries[1]!], 2),
    snapshot([user("inserted"), user("two")], 3),
    snapshot([user("inserted"), user("two"), { type: "compaction", id: "compact", parentId: "two", timestamp: "2026-01-01", summary: "summary", firstKeptEntryId: "inserted" }], 4),
  ];
  for (const next of steps) {
    const patch = sessionPatch(current, next)!;
    assert.ok(patch);
    assert.deepEqual(wire(applySessionPatch(wire(current), wire(patch))), wire(next));
    current = next;
  }
  assert.equal(applySessionPatch(snapshot([], 1), sessionPatch(steps[0]!, steps[1]!)!), undefined);
  assert.equal(sessionPatch(current, { ...current, graph: { ...current.graph!, epoch: "restart", revision: 1 } }), undefined);
  assert.equal(sessionPatch(current, snapshot([...current.entries].reverse(), 5)), undefined, "reordering uses a full checkpoint");
});

test("a single appended message does not serialize unchanged history or images", () => {
  const entries = Array.from({ length: 1000 }, (_, i) => user(`u${i}`));
  entries[0]!.message = { role: "user", content: [{ type: "text", text: "u0" }, { type: "image", mimeType: "image/png", data: "image".repeat(100000) }] };
  const before = snapshot(entries, 1);
  const next = snapshot([...entries, { type: "message", id: "answer", parentId: "u999", timestamp: "2026-01-01", message: { role: "assistant", content: [{ type: "text", text: "new answer" }] } }], 2);
  const patch = sessionPatch(before, next)!;
  const bytes = JSON.stringify(patch);
  assert.equal(patch.entries?.inserted.length, 1);
  assert.equal(patch.entries?.updated.length, 0);
  assert.ok(bytes.length < 5000, `patch was ${bytes.length} bytes`);
  assert.ok(!bytes.includes('imageimage'));
  assert.deepEqual(wire(applySessionPatch(wire(before), wire(patch))), wire(next));
});

test("subscribers start with full state and recover a missed patch without using RPC state as their baseline", async () => {
  const encoder = sessionEventEncoder();
  const first = snapshot([user("one")], 1), second = snapshot([user("one"), user("two")], 2);
  const third = snapshot([user("one"), user("two"), user("three")], 3);
  let requests = 0, release!: () => void;
  const decoder = sessionEventDecoder(() => { requests++; return new Promise<void>(resolve => { release = resolve; }); });
  const initial = encoder(event(first));
  assert.ok((initial.payload as SessionUpdate).current);
  assert.deepEqual((decoder(wire(initial))!.payload as SessionUpdate).current, wire(first));
  const lost = encoder(event(second));
  assert.ok((lost.payload as SessionUpdate).patch);
  const gap = encoder(event(third));
  assert.equal(decoder(wire(gap)), undefined);
  assert.equal(decoder(wire(gap)), undefined);
  assert.equal(requests, 1);
  const checkpoint = encoder(event(third, true));
  assert.deepEqual((decoder(wire(checkpoint))!.payload as SessionUpdate).current, wire(third));
  release(); await Promise.resolve();
  const next = snapshot([...third.entries, user("four")], 4);
  assert.deepEqual(wire((decoder(wire(encoder(event(next))))!.payload as SessionUpdate).current), wire(next));
  assert.equal(decoder(wire(gap)), undefined, "late patches never roll state back");
  assert.ok((sessionEventEncoder()(event(next)).payload as SessionUpdate).current, "new subscribers get their own checkpoint");
});
