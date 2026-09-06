import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import type { Edge } from "@vue-flow/core";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useSessionStore } from "../../src/renderer/stores/session";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";
import { i18n } from "../../src/renderer/i18n";

vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: async () => {}, whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
enableAutoUnmount(afterEach);

function snapshot(running: string[] = [], revision = 1): SessionSnapshot {
  const entries = [["root", null], ["old", "root"], ["trunk", "root"], ["a", "trunk"], ["b", "trunk"]]
    .map(([id, parentId], i) => ({ type: "message", id: id!, parentId, timestamp: String(i), message: { role: "user", content: id! } }));
  const projection = projectSession(entries, "old");
  projection.nodes = projection.nodes.map(node => ({ ...node, running: running.includes(node.id) }));
  return {
    session: { id: "edges", path: "edges.jsonl" }, entries, projection,
    runtime: { available: true, isStreaming: false },
    graph: { id: "edges", epoch: "one", revision, runs: running.map(id => ({ branchId: id, runId: id, nodeId: id, status: "running" })) },
  } as SessionSnapshot;
}

function setup(current: SessionSnapshot) {
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore(); session.applySnapshot(current);
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow: true } } });
  const graph = (wrapper.vm as any).$.setupState;
  const highlighted = () => (graph.edges as Edge[]).filter(edge => edge.class === "running-edge").map(edge => edge.target).sort();
  return { graph, session, highlighted };
}

it("follows all running branches, preserves shared paths, and clears highlighting when they finish", async () => {
  const { session, graph, highlighted } = setup(snapshot(["turn:a", "turn:b"]));
  expect(highlighted()).toEqual(["turn:a", "turn:b", "turn:trunk"]);
  const edges = graph.edges;
  session.focusedNode = "turn:old"; await flushPromises();
  expect(graph.edges).toEqual(edges);
  session.applySnapshot(snapshot(["turn:b"], 2)); await flushPromises();
  expect(highlighted()).toEqual(["turn:b", "turn:trunk"]);
  session.applySnapshot(snapshot([], 3)); await flushPromises();
  expect(highlighted()).toEqual([]);
});

it.each(["local", "graph"])("highlights %s pending paths while keeping unsent draft edges distinct", async kind => {
  const { session, graph, highlighted } = setup(snapshot());
  await graph.compose("turn:old"); await flushPromises();
  expect((graph.edges as Edge[]).find(edge => edge.target === "draft:turn:old")?.class).toBe("draft-edge");
  expect(highlighted()).toEqual([]);
  if (kind === "graph") {
    const next = snapshot([], 2);
    next.graph!.runs = [{ branchId: "new", runId: "new", nodeId: null, status: "running", pending: { text: "new", parentNodeId: "turn:trunk" } }];
    session.applySnapshot(next);
  } else {
    session.pendingPrompt = { message: { entryId: "pending:new", turnId: "pending:new", role: "user", text: "new", timestamp: "" },
      knownEntryIds: [], targetNodeId: "turn:trunk" };
  }
  await flushPromises();
  expect(highlighted()).toEqual(["pending:new", "turn:trunk"]);
  session.pendingPrompt = undefined;
  session.applySnapshot(snapshot([], 3)); await flushPromises();
  expect(highlighted()).toEqual([]);
  expect((graph.edges as Edge[]).find(edge => edge.target === "draft:turn:old")?.class).toBe("draft-edge");
});
