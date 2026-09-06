import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { desktop } from "../../src/renderer/api";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { LayoutState, SessionSnapshot, SettingsBundle } from "../../src/shared/types";

vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: async () => {}, whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
enableAutoUnmount(afterEach);

function setup() {
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore();
  const entries = [["root", null], ["a", "root"], ["b", "root"], ["c", "b"]].map(([id, parentId], i) => ({
    type: "message", id: id!, parentId, timestamp: String(i), message: { role: "user", content: id! },
  }));
  session.current = {
    session: { id: "draft-layout", path: "draft-layout.jsonl", cwd: ".", created: "", modified: "", messageCount: 4, firstMessage: "root" },
    entries, projection: projectSession(entries, "c"),
    runtime: { available: true, isStreaming: false },
    graph: { id: "draft-layout.jsonl", epoch: "one", revision: 1, runs: [] },
  } as SessionSnapshot;
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow: true } } });
  const graph = (wrapper.vm as any).$.setupState;
  return { graph, session, wrapper };
}

function expectClear(graph: any, id: string) {
  const node = graph.nodes.find((item: any) => item.id === id);
  for (const other of graph.nodes) {
    if (other.id === id || other.style?.visibility === "hidden") continue;
    expect(node.position.x >= other.position.x + other.dimensions.width + 28
      || node.position.x + node.dimensions.width + 28 <= other.position.x
      || node.position.y >= other.position.y + other.dimensions.height + 28
      || node.position.y + node.dimensions.height + 28 <= other.position.y,
    `${id} overlaps ${other.id}`).toBe(true);
  }
}

describe("draft placement", () => {
  it.each(["up", "down"])("places a draft %s of siblings and preserves that order after submitting", async direction => {
    const { graph, session } = setup();
    await graph.compose("turn:root", direction); await flushPromises();
    const checkOrder = (id: string) => {
      expectClear(graph, id);
      const node = graph.nodes.find((item: any) => item.id === id);
      const sibling = graph.nodes.find((item: any) => item.id === `turn:${direction === "up" ? "a" : "b"}`);
      if (direction === "up") expect(node.position.y + node.dimensions.height + 28).toBeLessThanOrEqual(sibling.position.y);
      else expect(node.position.y).toBeGreaterThanOrEqual(sibling.position.y + sibling.dimensions.height + 28);
    };
    checkOrder("draft:turn:root");
    graph.syncNodeDimensions([{ type: "dimensions", id: "draft:turn:root", dimensions: { width: 360, height: 500 } }]);
    checkOrder("draft:turn:root");
    const promptAt = vi.spyOn(session, "promptAt").mockImplementation(async () => {
      const entries = [...session.current!.entries, { type: "message", id: "new", parentId: "root", timestamp: "9", message: { role: "user", content: "new" } }];
      session.current!.entries = entries;
      session.current!.projection = projectSession(entries, "new");
      return "turn:new";
    });
    try { await graph.submitDraft("new"); await flushPromises(); }
    finally { promptAt.mockRestore(); }
    checkOrder("turn:new");
    graph.rebuild(); checkOrder("turn:new");
    await graph.compose("turn:root", "down"); await flushPromises();
    checkOrder("turn:new");
    graph.cancelDraft(); await flushPromises();
    checkOrder("turn:new");
    const saved = session.current!;
    session.applySnapshot({ ...saved, session: { ...saved.session, path: "other.jsonl" } }); await flushPromises();
    session.applySnapshot(saved); await flushPromises();
    checkOrder("turn:new");
  });

  it("restores saved upward order in a fresh view and keeps subsequent upward branches above it", async () => {
    const { graph, session, wrapper } = setup();
    const invoke = vi.spyOn(desktop, "invoke");
    const promptAt = vi.spyOn(session, "promptAt").mockImplementation(async () => {
      const entries = [...session.current!.entries, { type: "message", id: "new", parentId: "root", timestamp: "9", message: { role: "user", content: "new" } }];
      session.current!.entries = entries;
      session.current!.projection = projectSession(entries, "new");
      return "turn:new";
    });
    let savedLayout: LayoutState;
    try {
      await graph.compose("turn:root", "up"); await graph.submitDraft("new"); await flushPromises();
      const lastSave = invoke.mock.calls.filter(([route]) => route === "layout.save").at(-1)!;
      savedLayout = structuredClone((lastSave[1] as { layout: LayoutState }).layout);
      expect(Object.values(savedLayout.branchOrders!)).toContainEqual([["turn:new", -1]]);
    } finally { promptAt.mockRestore(); invoke.mockRestore(); }
    const savedSession = session.current!;
    wrapper.unmount();
    const fresh = createPinia(); setActivePinia(fresh);
    useLayoutStore().hydrate({ app: { theme: "light", density: "comfortable" } } as SettingsBundle, savedLayout!);
    useSessionStore().applySnapshot(savedSession);
    const reopened = mount(GraphPanel, { global: { plugins: [fresh, i18n], stubs: { VueFlow: true } } });
    const restored = (reopened.vm as any).$.setupState;
    const y = (id: string) => restored.nodes.find((node: any) => node.id === id).position.y;
    expect(y("turn:new")).toBeLessThan(y("turn:a"));
    await restored.compose("turn:root", "up"); await flushPromises();
    expect(y("draft:turn:root")).toBeLessThan(y("turn:new"));
    expectClear(restored, "draft:turn:root");
  });

  it("keeps an upward branch above siblings while pending and after its real node arrives", async () => {
    const { graph, session } = setup();
    await graph.compose("turn:root", "up");
    const promptAt = vi.spyOn(session, "promptAt").mockImplementation(async () => {
      session.current!.graph!.runs = [{ branchId: "new", runId: "new", nodeId: null, status: "running", pending: { text: "new", parentNodeId: "turn:root" } }];
      return "pending:new";
    });
    try { await graph.submitDraft("new"); await flushPromises(); }
    finally { promptAt.mockRestore(); }
    const y = (id: string) => graph.nodes.find((node: any) => node.id === id).position.y;
    expect(y("pending:new")).toBeLessThan(y("turn:a"));
    expectClear(graph, "pending:new");
    const entries = [...session.current!.entries, { type: "message", id: "new", parentId: "root", timestamp: "9", message: { role: "user", content: "new" } }];
    session.current!.entries = entries;
    session.current!.projection = projectSession(entries, "new");
    session.current!.graph!.runs = [{ branchId: "new", runId: "new", nodeId: "turn:new", status: "idle" }];
    await flushPromises();
    expect(y("turn:new")).toBeLessThan(y("turn:a"));
    expectClear(graph, "turn:new");
    const savedOrders = Object.values(useLayoutStore().layout.branchOrders!).flat();
    expect(savedOrders).toContainEqual(["turn:new", -1]);
    expect(savedOrders.some(([id]) => id === "pending:new")).toBe(false);
  });

  it("keeps a continuation to the right of a manually moved parent before and after submitting", async () => {
    const { graph, session } = setup();
    const manual = { x: 1400, y: 800 };
    graph.rememberDrag({ node: { id: "turn:a", position: manual } });
    await graph.compose("turn:a"); await flushPromises();
    const parent = graph.nodes.find((node: any) => node.id === "turn:a");
    const draft = graph.nodes.find((node: any) => node.type === "draft");
    expect(parent.position).toEqual(manual);
    expect(draft.position.x).toBe(manual.x + parent.dimensions.width + 92);
    expect(draft.position.y + draft.dimensions.height / 2).toBe(manual.y + parent.dimensions.height / 2);
    const promptAt = vi.spyOn(session, "promptAt").mockImplementation(async () => {
      const entries = [...session.current!.entries, { type: "message", id: "done", parentId: "a", timestamp: "5",
        message: { role: "user", content: "done" } }];
      session.current!.projection = projectSession(entries, "done");
    });
    try { await graph.submitDraft("done"); await flushPromises(); }
    finally { promptAt.mockRestore(); }
    const child = graph.nodes.find((node: any) => node.id === "turn:done");
    expect(child.position).toEqual({ x: manual.x + 372, y: manual.y });
    expectClear(graph, "turn:done");
  });

  it.each([{ x: 1200, y: 900 }, { x: 800, y: 230 }])("retains manual positions without overlap when submitting another child (%j)", async (manual) => {
    const { graph, session } = setup();
    const entries = [...session.current!.entries, { type: "message", id: "a1", parentId: "a", timestamp: "4",
      message: { role: "user", content: "first child" } }];
    session.current!.entries = entries;
    session.current!.projection = projectSession(entries, "a1");
    await flushPromises();
    graph.rememberDrag({ node: { id: "turn:c", position: manual } });
    await graph.compose("turn:a"); await flushPromises();
    expectClear(graph, "draft:turn:a");
    expect(graph.nodes.find((node: any) => node.id === "turn:c").position).toEqual(manual);
    const promptAt = vi.spyOn(session, "promptAt").mockImplementation(async () => {
      const next = [...entries, { type: "message", id: "a2", parentId: "a", timestamp: "5",
        message: { role: "user", content: "second child" } }];
      session.current!.entries = next;
      session.current!.projection = projectSession(next, "a2");
    });
    try { await graph.submitDraft("second child"); await flushPromises(); }
    finally { promptAt.mockRestore(); }
    expect(graph.nodes.find((node: any) => node.id === "turn:c").position).toEqual(manual);
    expect(graph.nodes.some((node: any) => node.type === "draft")).toBe(false);
    expectClear(graph, "turn:a2");
    expectClear(graph, "turn:a1");
    const first = graph.nodes.find((node: any) => node.id === "turn:a1");
    const second = graph.nodes.find((node: any) => node.id === "turn:a2");
    const parent = graph.nodes.find((node: any) => node.id === "turn:a");
    expect(first.position.y).toBeLessThan(second.position.y);
    expect(second.position.y + second.dimensions.height + 28).toBeLessThanOrEqual(manual.y);
    expect(parent.position.y).toBe((first.position.y + second.position.y) / 2);
    expect(second.position.x).toBe(parent.position.x + parent.dimensions.width + 92);
  });

  it.each(["cancel", "submit"])("restores manual positions after draft %s and removes temporary spacing", async (action) => {
    const { graph, session } = setup();
    const original = graph.nodes.map((node: any) => ({ ...node.position }));
    const manual = { x: 1200, y: 900 };
    graph.rememberDrag({ node: { id: "turn:c", position: manual } });
    await graph.compose("turn:a"); await flushPromises();
    graph.syncNodeDimensions([{ type: "dimensions", id: "draft:turn:a", dimensions: { width: 360, height: 500 } }]);
    graph.rebuild();
    if (action === "cancel") graph.cancelDraft();
    else {
      const promptAt = vi.spyOn(session, "promptAt").mockImplementation(async () => {
        const entries = [...session.current!.entries, { type: "message", id: "done", parentId: "a", timestamp: "5",
          message: { role: "user", content: "done" } }];
        session.current!.projection = projectSession(entries, "done");
      });
      try { await graph.submitDraft("done"); }
      finally { promptAt.mockRestore(); }
    }
    await flushPromises();
    expect(graph.nodes.find((node: any) => node.id === "turn:c").position).toEqual(manual);
    expect(graph.nodes.slice(0, 3).map((node: any) => node.position)).toEqual(original.slice(0, 3));
    expect(graph.nodes.some((node: any) => node.type === "draft")).toBe(false);
  });

  it("keeps the draft after its own branch and reserves space before the next branch", async () => {
    const { graph } = setup();
    const original = graph.nodes.map((node: any) => ({ ...node.position }));
    await graph.compose("turn:a"); await flushPromises();
    expectClear(graph, "draft:turn:a");
    const draft = () => graph.nodes.find((node: any) => node.id === "draft:turn:a");
    const node = (id: string) => graph.nodes.find((node: any) => node.id === `turn:${id}`);
    const expectBranchOrder = () => {
      expect(draft().position.x).toBe(node("a").position.x + node("a").dimensions.width + 92);
      expect(draft().position.y + draft().dimensions.height / 2)
        .toBe(node("a").position.y + node("a").dimensions.height / 2);
      expect(draft().position.y + draft().dimensions.height + 28).toBeLessThanOrEqual(node("c").position.y);
      expect(node("b").position.y).toBe(node("c").position.y);
    };
    expectBranchOrder();
    graph.syncNodeDimensions([{ type: "dimensions", id: "draft:turn:a", dimensions: { width: 360, height: 700 } }]);
    expectClear(graph, "draft:turn:a");
    expectBranchOrder();
    graph.cancelDraft(); await flushPromises();
    expect(graph.nodes.map((node: any) => node.position)).toEqual(original);
  });

  it("reserves separate space for pending runs and an open draft across branches", async () => {
    const { graph, session } = setup();
    session.current!.graph!.runs = ["a", "b"].map(id => ({
      branchId: id, runId: id, nodeId: null, status: "running",
      pending: { text: id, parentNodeId: `turn:${id}` },
    }));
    await graph.compose("turn:a"); await flushPromises();
    for (const id of ["draft:turn:a", "pending:a", "pending:b"]) expectClear(graph, id);
    const y = (id: string) => graph.nodes.find((node: any) => node.id === id).position.y;
    expect(Math.max(y("draft:turn:a"), y("pending:a"))).toBeLessThan(y("turn:c"));
    expect(y("pending:b")).toBeGreaterThan(y("turn:c"));
  });

  it("keeps a draft beside an isolated parent when there is room", async () => {
    const { graph } = setup();
    await graph.compose("turn:c"); await flushPromises();
    const parent = graph.nodes.find((node: any) => node.id === "turn:c");
    const draft = graph.nodes.find((node: any) => node.id === "draft:turn:c");
    expect(draft.position.x).toBe(parent.position.x + 280 + 92);
    expect(draft.position.y + draft.dimensions.height / 2).toBe(parent.position.y + parent.dimensions.height / 2);
    expectClear(graph, draft.id);
  });
});
