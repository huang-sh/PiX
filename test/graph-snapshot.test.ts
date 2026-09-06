import test from "node:test";
import assert from "node:assert/strict";
import { GraphSnapshotCache } from "../src/main/graph-snapshot.js";
import { GraphFiles, type BranchRecord } from "../src/main/graph-files.js";
import { projectSession } from "../src/shared/session.js";
import type { RawSessionEntry, SessionSnapshot } from "../src/shared/types.js";

const entry = (id: string, parentId: string | null, role = "user"): RawSessionEntry => ({ type: "message", id, parentId,
  timestamp: "2026-01-01", message: { role, content: [{ type: "text", text: id }] } });
function snapshot(entries: RawSessionEntry[]): SessionSnapshot {
  return { session: { path: "main" }, entries, projection: projectSession(entries, entries.at(-1)?.id ?? null), runtime: {} } as SessionSnapshot;
}

test("merged snapshots match full projection while unchanged branches never re-read their contents", () => {
  const graph = new GraphFiles("main");
  const main = snapshot([entry("root", null), entry("answer", "root", "assistant")]);
  const branches = new Map<string, { snapshot: SessionSnapshot }>();
  for (let i = 0; i < 8; i++) {
    const id = `branch${i}`;
    const record: BranchRecord = { id, parentId: "main", forkEntryId: "answer", inherited: { root: "root", answer: "answer" },
      baseline: main.entries, header: {}, request: { text: id }, requestId: id, runId: id, status: "idle" };
    graph.records.set(id, record);
    const entries = [...main.entries];
    for (let turn = 0; turn < 100; turn++) entries.push(entry(`u${turn}`, turn ? `a${turn - 1}` : "answer"), entry(`a${turn}`, `u${turn}`, "assistant"));
    branches.set(id, { snapshot: snapshot(entries) });
  }
  const cache = new GraphSnapshotCache();
  cache.update(graph, main, branches);
  const initial = cache.view(main, new Set());
  const oracle = projectSession(initial.entries, main.projection.leafId);
  const structural = (nodes: typeof oracle.nodes) => nodes.map(({ id, parentId, depth, title, preview, toolCallCount, hasError }) => ({ id, parentId, depth, title, preview, toolCallCount, hasError }));
  assert.deepEqual(structural(initial.projection.nodes), structural(oracle.nodes));
  assert.deepEqual(initial.projection.edges, oracle.edges);
  assert.deepEqual(initial.projection.messages, oracle.messages);
  assert.equal(initial.projection.nodes[0]?.leafEntryId, "answer", "child metadata never moves the main fork point");
  const delta = graph.delta.bind(graph);
  const refreshed: string[] = [];
  graph.delta = (...args) => { refreshed.push(args[0].id); return delta(...args); };
  // No getters in another branch should be read on an unrelated update.
  Object.defineProperty(branches.get("branch7")!.snapshot.entries.at(-1)!, "message", { get() { throw Error("unrelated history was scanned"); } });
  cache.update(graph, main, branches);
  assert.equal(cache.view(main, new Set()).entries, initial.entries);
  assert.deepEqual(refreshed, []);
  const changed = branches.get("branch0")!;
  changed.snapshot = snapshot([...changed.snapshot.entries, entry("new", "a99", "assistant")]);
  cache.update(graph, main, branches);
  const next = cache.view(main, new Set(["turn:branch0:u99"]));
  assert.deepEqual(refreshed, ["branch0"]);
  assert.equal(next.entries.find(e => e.id === "branch0:a0"), initial.entries.find(e => e.id === "branch0:a0"));
  assert.equal(next.projection.nodes.find(n => n.id === "turn:branch7:u99"), initial.projection.nodes.find(n => n.id === "turn:branch7:u99"));
  assert.equal(next.projection.nodes.find(n => n.id === "turn:branch0:u99")?.running, true);
  assert.equal(cache.view(main, new Set()).projection.nodes.find(n => n.id === "turn:branch0:u99")?.running, false);
  branches.delete("branch1"); graph.records.delete("branch1"); cache.update(graph, main, branches);
  assert.ok(!cache.view(main, new Set()).entries.some(e => e.id.startsWith("branch1:")));
});
