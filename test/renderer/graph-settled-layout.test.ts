// Settled-state layout invariants: lanes follow measured card heights.
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useSessionStore } from "../../src/renderer/stores/session";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";

vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: async () => {}, whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
enableAutoUnmount(afterEach);

// Three sibling branches off the root with mixed depths.
const SPEC: Array<[string, string | null]> = [
  ["root", null], ["a", "root"], ["a1", "a"], ["a2", "a1"],
  ["b", "root"], ["b1", "b"], ["b2", "b1"], ["c", "root"],
];
// Realistic measured heights (CSS worst case ≈ 161–217px vs the 146 estimate).
const HEIGHTS: Record<string, number> = {
  "turn:root": 176, "turn:a": 238, "turn:a1": 204, "turn:a2": 222,
  "turn:b": 190, "turn:b1": 246, "turn:b2": 172, "turn:c": 210,
};

function setup(spec: Array<[string, string | null]> = SPEC, leaf = "a2") {
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore();
  const entries = spec.map(([id, parentId], i) => ({
    type: "message", id, parentId, timestamp: String(i).padStart(2, "0"),
    message: { role: "user", content: id },
  }));
  session.current = {
    session: { id: "settled", path: "settled.jsonl", cwd: ".", created: "", modified: "", messageCount: entries.length, firstMessage: "root" },
    entries, projection: projectSession(entries, leaf),
    runtime: { available: true, isStreaming: false },
    graph: { id: "settled.jsonl", epoch: "one", revision: 1, runs: [] },
  } as SessionSnapshot;
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow: true } } });
  return { graph: (wrapper.vm as any).$.setupState, session };
}

const GAP = 28;
interface Card { id: string; x: number; y: number; w: number; h: number }
const cards = (graph: any): Card[] => graph.nodes
  .filter((n: any) => n.type === "prompt" && String(n.id).startsWith("turn:"))
  .map((n: any) => ({ id: n.id, x: n.position.x, y: n.position.y, w: n.dimensions.width, h: n.dimensions.height }));
const separated = (a: Card, b: Card) =>
  a.x >= b.x + b.w + GAP || a.x + a.w + GAP <= b.x
  || a.y >= b.y + b.h + GAP || a.y + a.h + GAP <= b.y;
const position = (graph: any, id: string) => {
  const node = graph.nodes.find((n: any) => n.id === id);
  return node ? { x: node.position.x, y: node.position.y } : undefined;
};
const byId = (graph: any) => Object.fromEntries(cards(graph).map(c => [c.id, c])) as Record<string, Card>;
const overlapPairs = (snapshot: Card[]) => {
  const report: string[] = [];
  for (let i = 0; i < snapshot.length; i++) for (let j = i + 1; j < snapshot.length; j++)
    if (!separated(snapshot[i]!, snapshot[j]!)) report.push(`${snapshot[i]!.id} overlaps ${snapshot[j]!.id}`);
  return report;
};
// I2c: when only card heights grow, x never moves, card centers never move up,
// and cards that did not grow never jump up. A growing card may extend upward
// inside the band its row already reserved, so only its center is monotone.
const growthViolations = (before: Record<string, Card>, after: Card[]) => {
  const report: string[] = [];
  for (const card of after) {
    const was = before[card.id];
    if (card.x !== was.x) report.push(`${card.id} moved sideways`);
    if (card.y + card.h / 2 < was.y + was.h / 2) report.push(`${card.id} center moved up`);
    if (card.h === was.h && card.y < was.y) report.push(`${card.id} moved up without growing`);
  }
  return report;
};
const measure = (graph: any) => {
  graph.syncNodeDimensions(Object.entries(HEIGHTS).map(([id, height]) =>
    ({ type: "dimensions", id, dimensions: { width: 280, height } })));
};

describe("settled graph layout follows measured card sizes", () => {
  it("keeps every branch in its own vertical band after measurements arrive", async () => {
    const { graph } = setup();
    measure(graph);
    await flushPromises();
    const snapshot = cards(graph);
    expect(overlapPairs(snapshot), JSON.stringify(snapshot)).toEqual([]);
  });

  it("returns to the same measured positions after opening and cancelling a draft", async () => {
    const { graph } = setup();
    measure(graph);
    await flushPromises();
    const before = Object.fromEntries(cards(graph).map(c => [c.id, { x: c.x, y: c.y }]));
    await graph.compose("turn:a");
    await flushPromises();
    graph.cancelDraft();
    await flushPromises();
    for (const card of cards(graph)) expect({ x: card.x, y: card.y }).toEqual(before[card.id]);
  });

  it("keeps deeper column x positions stable while a draft is open", async () => {
    const spec: Array<[string, string | null]> = [["root", null], ["a", "root"], ["b", "root"], ["c", "b"], ["d1", "c"]];
    const { graph } = setup(spec, "d1");
    const before = position(graph, "turn:d1");
    expect(before).toBeDefined();
    await graph.compose("turn:a"); // draft sits at depth 2, beside c's column
    await flushPromises();
    expect(position(graph, "turn:d1")?.x).toBe(before?.x);
    graph.cancelDraft();
    await flushPromises();
    expect(position(graph, "turn:d1")).toEqual(before);
  });

  it("settles the new node where its pending card waited", async () => {
    const { graph, session } = setup();
    const promptAt = vi.spyOn(session, "promptAt").mockImplementation(async () => {
      session.current!.graph!.runs = [{ branchId: "new", runId: "new", nodeId: null, status: "running",
        pending: { text: "new", parentNodeId: "turn:a" } }];
      return "pending:new";
    });
    try { await graph.compose("turn:a"); await graph.submitDraft("new"); await flushPromises(); }
    finally { promptAt.mockRestore(); }
    const pending = position(graph, "pending:new");
    expect(pending).toBeDefined();
    const entries = [...session.current!.entries, { type: "message", id: "new", parentId: "a", timestamp: "99",
      message: { role: "user", content: "new" } }];
    session.current!.entries = entries;
    session.current!.projection = projectSession(entries, "new");
    session.current!.graph!.runs = [{ branchId: "new", runId: "new", nodeId: "turn:new", status: "idle" }];
    await flushPromises();
    expect(position(graph, "turn:new")).toEqual(pending);
  });

  it("pushes content only downward as measured heights arrive", async () => {
    const { graph } = setup();
    const estimates = byId(graph);
    // One measurement lands mid-graph: the card is taller than its estimate.
    graph.syncNodeDimensions([{ type: "dimensions", id: "turn:a1", dimensions: { width: 280, height: HEIGHTS["turn:a1"]! } }]);
    await flushPromises();
    let snapshot = cards(graph);
    expect(growthViolations(estimates, snapshot), JSON.stringify(snapshot)).toEqual([]);
    expect(snapshot.find(c => c.id === "turn:a2")!.y).toBeGreaterThan(estimates["turn:a2"]!.y);
    // The remaining measurements land in a second wave.
    graph.syncNodeDimensions(Object.entries(HEIGHTS).filter(([id]) => id !== "turn:a1")
      .map(([id, height]) => ({ type: "dimensions", id, dimensions: { width: 280, height } })));
    await flushPromises();
    const partial = byId(graph);
    snapshot = cards(graph);
    expect(growthViolations(partial, snapshot), JSON.stringify(snapshot)).toEqual([]);
    expect(overlapPairs(snapshot), JSON.stringify(snapshot)).toEqual([]);
  });

  it("grows the settled card in place when its measured height arrives", async () => {
    const { graph, session } = setup();
    measure(graph); // siblings carry real measurements; the new card starts at the estimate
    await flushPromises();
    const promptAt = vi.spyOn(session, "promptAt").mockImplementation(async () => {
      session.current!.graph!.runs = [{ branchId: "new", runId: "new", nodeId: null, status: "running",
        pending: { text: "new", parentNodeId: "turn:a" } }];
      return "pending:new";
    });
    try { await graph.compose("turn:a"); await graph.submitDraft("new"); await flushPromises(); }
    finally { promptAt.mockRestore(); }
    const entries = [...session.current!.entries, { type: "message", id: "new", parentId: "a", timestamp: "99",
      message: { role: "user", content: "new" } }];
    session.current!.entries = entries;
    session.current!.projection = projectSession(entries, "new");
    session.current!.graph!.runs = [{ branchId: "new", runId: "new", nodeId: "turn:new", status: "idle" }];
    await flushPromises();
    // I2b landed the card at its estimate; the real card is taller (preview content).
    const settled = byId(graph);
    expect(settled["turn:new"]!.h).toBe(146);
    graph.syncNodeDimensions([{ type: "dimensions", id: "turn:new", dimensions: { width: 280, height: 217 } }]);
    await flushPromises();
    const snapshot = cards(graph);
    expect(growthViolations(settled, snapshot), JSON.stringify(snapshot)).toEqual([]);
    expect(overlapPairs(snapshot), JSON.stringify(snapshot)).toEqual([]);
    // Branch a's lane is already pitched to turn:a's 238px, so the taller card
    // grows in place around its center and the reserved band absorbs it: no
    // other card moves at all.
    const grown = snapshot.find(c => c.id === "turn:new")!;
    expect(grown.h).toBe(217);
    expect(grown.y + grown.h / 2).toBe(settled["turn:new"]!.y + settled["turn:new"]!.h / 2);
    for (const card of snapshot) if (card.id !== "turn:new")
      expect({ x: card.x, y: card.y }, card.id).toEqual({ x: settled[card.id]!.x, y: settled[card.id]!.y });
  });

  it("releases a manual pin when a deletion moves its auto slot", async () => {
    const spec: Array<[string, string | null]> = [["root", null], ["a", "root"], ["a1", "a"], ["b", "root"]];
    const { graph, session } = setup(spec, "b");
    const manual = { x: 1400, y: 800 };
    graph.rememberDrag({ node: { id: "turn:b", position: manual } });
    await flushPromises();
    expect(position(graph, "turn:b")).toEqual(manual);
    const surviving = session.current!.entries.filter(e => e.id !== "a" && e.id !== "a1");
    session.current!.entries = surviving;
    session.current!.projection = projectSession(surviving, "b");
    await flushPromises();
    expect(position(graph, "turn:b")).toBeDefined();
    expect(position(graph, "turn:b")).not.toEqual(manual);
  });
});
