// Real GraphPanel + VueFlow: layout-only tests cannot catch stale display coordinates.
import { flushPromises, mount } from "@vue/test-utils";
import { VueFlow } from "@vue-flow/core";
import { createPinia, setActivePinia } from "pinia";
import { expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";

vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: async () => {}, whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));

it("keeps display coordinates synchronized when a snapshot moves an offscreen branch into view", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore();
  useLayoutStore().panelsSettled = true;
  const snapshot = (extraBranches: boolean): SessionSnapshot => {
    const spec: Array<[string, string | null]> = [["root", null]];
    if (extraBranches) for (let i = 0; i < 7; i++) spec.push([`extra${i}`, "root"]);
    spec.push(["b", "root"], ["b1", "b"]);
    const entries = spec.map(([id, parentId], index) => ({
      type: "message", id, parentId, timestamp: String(index).padStart(2, "0"), message: { role: "user", content: id },
    }));
    return {
      session: { id: "panel-sync", path: "panel-sync.jsonl", cwd: ".", created: "", modified: "", messageCount: entries.length, firstMessage: "root" },
      entries, projection: projectSession(entries, "root"),
      runtime: { available: true, isStreaming: false },
      graph: { id: "panel-sync.jsonl", epoch: "one", revision: extraBranches ? 1 : 2, runs: [] },
    } as SessionSnapshot;
  };
  session.applySnapshot(snapshot(true));
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], config: {
    warnHandler(message) { if (!message.startsWith("Extraneous non-")) console.warn(message); },
  } } });
  try {
    const flow = (wrapper.findComponent(VueFlow).vm as any).$.exposed;
    // Keep a fixed test viewport; centering is independent of node layout.
    vi.spyOn(flow, "setCenter").mockResolvedValue(true);
    flow.dimensions.value = { width: 1400, height: 400 };
    await flushPromises();
    flow.viewport.value = { x: 0, y: 0, zoom: 1 };
    await flushPromises();
    expect(flow.dimensions.value).toEqual({ width: 1400, height: 400 });
    expect(wrapper.find('[data-id="turn:extra0"]').exists()).toBe(true);
    expect(wrapper.find('[data-id="turn:b"]').exists()).toBe(false);
    const graph = (wrapper.vm as any).$.setupState;
    await graph.compose("turn:extra0");
    graph.syncNodeDimensions([{ type: "dimensions", id: "draft:turn:extra0", dimensions: { width: 360, height: 700 } }]);
    await flushPromises();
    for (const id of ["turn:b", "turn:b1"]) {
      const node = flow.findNode(id);
      expect(node.position.y).toBeGreaterThan(1266);
      expect(node.computedPosition.y).toBe(node.position.y);
      expect(wrapper.find(`[data-id="${id}"]`).exists()).toBe(false);
    }
    graph.cancelDraft();
    await flushPromises();
    session.applySnapshot(snapshot(false));
    await flushPromises();
    for (const id of ["turn:b", "turn:b1"]) {
      expect(flow.findNode(id).position.y).toBe(48);
      expect(flow.findNode(id).computedPosition.y).toBe(48);
      expect(wrapper.find(`[data-id="${id}"]`).exists()).toBe(true);
    }
    flow.viewport.value = { x: 0, y: 0, zoom: 0.25 };
    await flushPromises();
    expect(flow.findNode("turn:b").computedPosition.y).toBe(48);
    expect(wrapper.find('[data-id="turn:b"]').exists()).toBe(true);
  } finally {
    wrapper.unmount();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
