import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { VueFlow } from "@vue-flow/core";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useSessionStore } from "../../src/renderer/stores/session";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";

vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: async () => {}, whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
enableAutoUnmount(afterEach);
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function setup() {
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore();
  useLayoutStore().panelsSettled = true;
  const entries = [["root", null], ["a", "root"], ["a1", "a"], ["b", "root"]]
    .map(([id, parentId], index) => ({ type: "message", id: id!, parentId, timestamp: String(index),
      message: { role: "user", content: id! } }));
  session.applySnapshot({ session: { id: "drag", path: "drag.jsonl" }, entries,
    projection: projectSession(entries, "b"), runtime: { available: true },
    graph: { id: "drag", epoch: "one", revision: 1, runs: [] } } as SessionSnapshot);
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], config: {
    warnHandler(message) { if (!message.startsWith("Extraneous non-")) console.warn(message); },
  } } });
  const flow = (wrapper.findComponent(VueFlow).vm as any).$.exposed;
  vi.spyOn(flow, "setCenter").mockResolvedValue(true);
  flow.dimensions.value = { width: 2000, height: 2000 };
  await flushPromises();
  flow.viewport.value = { x: 0, y: 0, zoom: 1 };
  await flushPromises();
  return { wrapper, flow, session, graph: (wrapper.vm as any).$.setupState };
}

it.each(["snapshot", "resize"])("keeps a dragged node and its edge at the pointer during a %s update", async update => {
  const { wrapper, flow, session, graph } = await setup();
  const node = flow.findNode("turn:a");
  const edge = flow.edges.value.find((edge: any) => edge.target === node.id);
  const endpoint = { x: edge.targetX + 80, y: edge.targetY + 90 };
  const event = { event: new MouseEvent("mousemove", { buttons: 1 }), node, nodes: [node] };
  flow.emits.nodeDragStart(event);
  const position = { x: node.position.x + 80, y: node.position.y + 90 };
  flow.emits.nodesChange([{ id: node.id, type: "position", position, dragging: true }]);
  flow.emits.nodeDrag(event);
  await flushPromises();
  const path = () => wrapper.get(`[data-id="${edge.id}"] .vue-flow__edge-path`).attributes("d");
  expect(node.computedPosition).toMatchObject(position);
  expect(edge.targetX).toBe(endpoint.x);
  expect(edge.targetY).toBe(endpoint.y);
  if (update === "snapshot") {
    const current = session.current!;
    session.applySnapshot({ ...current, graph: { ...current.graph!, revision: 2 },
      projection: { ...current.projection, nodes: current.projection.nodes.map(item => ({ ...item, running: true })) } });
  } else {
    graph.syncNodeDimensions([{ id: "turn:b", type: "dimensions", dimensions: { width: 320, height: 220 } }]);
  }
  await flushPromises();
  expect(node.position).toEqual(position);
  expect(node.computedPosition).toMatchObject(position);
  expect(edge.targetX).toBe(endpoint.x);
  expect(edge.targetY).toBe(endpoint.y);
  expect(path().endsWith(`${endpoint.x},${endpoint.y}`)).toBe(true);
  flow.emits.nodeDragStop(event);
  await flushPromises();
  expect(node.position).toEqual(position);
});

it.each(["none", "start", "move", "drop"])("preserves branch dragging when Shift is held at %s", async phase => {
  const { flow, session } = await setup();
  const node = flow.findNode("turn:a");
  const child = flow.findNode("turn:a1");
  const sibling = flow.findNode("turn:b");
  const childPosition = { ...child.position }, siblingPosition = { ...sibling.position };
  const position = { x: node.position.x + 80, y: node.position.y + 90 };
  const event = (shiftKey: boolean) => ({ event: new MouseEvent("mousemove", { buttons: 1, shiftKey }), node, nodes: [node] });
  flow.emits.nodeDragStart(event(phase === "start"));
  flow.emits.nodesChange([{ id: node.id, type: "position", position, dragging: true }]);
  flow.emits.nodeDrag(event(phase === "move"));
  await flushPromises();
  const current = session.current!;
  session.applySnapshot({ ...current, graph: { ...current.graph!, revision: 2 },
    projection: { ...current.projection, nodes: current.projection.nodes.map(item => ({ ...item, running: true })) } });
  await flushPromises();
  flow.emits.nodeDragStop(event(phase === "drop"));
  await flushPromises();
  expect(node.position).toEqual(position);
  expect(child.position).toEqual(phase === "none" ? childPosition
    : { x: childPosition.x + 80, y: childPosition.y + 90 });
  expect(sibling.position).toEqual(siblingPosition);
});

it("removes a hidden sending draft's edge and restores it when the draft reappears", async () => {
  const { wrapper, graph } = await setup();
  await graph.compose("turn:root");
  await flushPromises();
  const edge = '[data-id="edge:draft:turn:root"]';
  expect(wrapper.find(edge).exists()).toBe(true);
  graph.draftState.busy = true;
  await flushPromises();
  expect(wrapper.get('[data-id="draft:turn:root"]').attributes("style")).toContain("visibility: hidden");
  expect(wrapper.find(edge).exists()).toBe(false);
  graph.draftState.busy = false;
  await flushPromises();
  expect(wrapper.find(edge).exists()).toBe(true);
});
