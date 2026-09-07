import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, onMounted, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useSessionStore } from "../../src/renderer/stores/session";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import { nextFrame } from "../../src/renderer/lib/frame";
import type { SessionSnapshot } from "../../src/shared/types";

vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: vi.fn(async () => {}), whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
enableAutoUnmount(afterEach);

function setup() {
  const pinia = createPinia(); setActivePinia(pinia);
  const layout = useLayoutStore(); layout.panelsSettled = true;
  const entries = [{ type: "message", id: "a", parentId: null, timestamp: "2026-01-01",
    message: { role: "user", content: "A" } }];
  useSessionStore().current = {
    session: { id: "controls", path: "C:/tmp/controls.jsonl", cwd: "C:/tmp", created: "", modified: "", messageCount: 1, firstMessage: "A" },
    entries, projection: projectSession(entries, "a"),
    runtime: { available: false, model: null, thinkingLevel: "off", availableThinkingLevels: [], isStreaming: false,
      isCompacting: false, isRetrying: false, autoCompactionEnabled: true, autoRetryEnabled: true,
      steeringMode: "all", followUpMode: "all", pendingMessageCount: 0 },
  } satisfies SessionSnapshot;
  const viewport = { x: 0, y: 0, zoom: 0.4 };
  const setCenter = vi.fn(async () => true);
  const findNode = vi.fn<() => { dimensions: { width: number; height: number }; handleBounds: { source: []; target: [] } } | undefined>(() => undefined);
  const store = { getViewport: () => viewport, setCenter, findNode,
    dimensions: ref({ width: 800, height: 600 }) };
  const VueFlow = defineComponent({
    name: "VueFlow", emits: ["paneReady"], setup(_, { emit }) { onMounted(() => emit("paneReady", store)); },
    template: '<div><slot /></div>',
  });
  const MiniMap = defineComponent({ name: "MiniMap", emits: ["click"], props: ["nodeColor"], template: '<div class="test-minimap" />' });
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow, MiniMap } } });
  return { wrapper, layout, viewport, setCenter, findNode, MiniMap };
}

describe("graph viewport controls", () => {
  beforeEach(() => { vi.mocked(window.pix!.invoke).mockReset().mockResolvedValue({}); });

  it("toggles and persists the minimap through the actual toolbar button", async () => {
    const { wrapper, layout } = setup(); await flushPromises();
    const button = wrapper.find('.graph-controls button[aria-pressed]');
    expect(wrapper.find('.test-minimap').exists()).toBe(false);
    await button.trigger("click"); await flushPromises();
    expect(button.attributes("aria-pressed")).toBe("true");
    expect(wrapper.find('.test-minimap').exists()).toBe(true);
    expect(window.pix!.invoke).toHaveBeenLastCalledWith("layout.save", { layout: expect.objectContaining({ minimap: true }) });
    await button.trigger("click"); await flushPromises();
    expect(layout.layout.minimap).toBe(false);
    expect(wrapper.find('.test-minimap').exists()).toBe(false);
  });

  it("colors running minimap nodes with the standalone running token, not an accent shade", async () => {
    const { wrapper, MiniMap } = setup(); await flushPromises();
    await wrapper.find('.graph-controls button[aria-pressed]').trigger("click");
    await flushPromises();
    const nodeColor = wrapper.findComponent(MiniMap).props("nodeColor") as (node: { type?: string; data?: unknown }) => string;
    expect(nodeColor).toBeTypeOf("function");
    expect(nodeColor({ type: "prompt", data: { running: true } })).toBe("var(--running)");
    expect(nodeColor({ type: "prompt", data: { running: false } })).toBe("var(--accent)");
    // Draft nodes never light up, even if their data someday grows a running flag.
    expect(nodeColor({ type: "draft", data: { running: true } })).toBe("var(--accent)");
  });

  it("navigates to the minimap's graph coordinates without changing zoom or selection", async () => {
    const { wrapper, setCenter, MiniMap } = setup(); await flushPromises();
    await wrapper.find('.graph-controls button[aria-pressed]').trigger("click");
    await flushPromises(); setCenter.mockClear();
    wrapper.findComponent(MiniMap).vm.$emit("click", { position: { x: 1024, y: -800 }, event: new MouseEvent("click") });
    expect(setCenter).toHaveBeenCalledExactlyOnceWith(1024, -800, { zoom: 0.4 });
    expect(useSessionStore().focusedNode).toBeNull();
  });

  it("uses retained measurements when the current node has been removed by viewport filtering", async () => {
    const { wrapper, setCenter, findNode } = setup(); await flushPromises();
    findNode.mockReturnValueOnce({ dimensions: { width: 280, height: 200 }, handleBounds: { source: [], target: [] } });
    wrapper.findComponent({ name: "VueFlow" }).vm.$emit("nodesChange", [{ type: "dimensions", id: "turn:a", dimensions: { width: 280, height: 200 } }]);
    setCenter.mockClear();
    await wrapper.find('.graph-controls button:last-child').trigger("click"); await flushPromises();
    expect(setCenter).toHaveBeenCalledExactlyOnceWith(188, 148, { zoom: 0.9, duration: 280 });
  });

  it("retains event measurements without a mounted flow node, including after its content changes", async () => {
    const { wrapper, setCenter } = setup(); await flushPromises();
    wrapper.findComponent({ name: "VueFlow" }).vm.$emit("nodesChange", [
      { type: "dimensions", id: "turn:a", dimensions: { width: 280, height: 122 } },
    ]);
    const session = useSessionStore();
    const current = session.current!;
    session.applySnapshot({ ...current, projection: { ...current.projection,
      nodes: current.projection.nodes.map(node => ({ ...node, running: true })),
    } });
    await flushPromises(); setCenter.mockClear();
    await wrapper.find('.graph-controls button:last-child').trigger("click"); await flushPromises();
    expect(setCenter).toHaveBeenCalledExactlyOnceWith(188, 109, { zoom: 0.9, duration: 280 });
  });

  it("recenters the current node at a readable zoom when its toolbar button is clicked", async () => {
    const { wrapper, viewport, setCenter } = setup(); await flushPromises();
    viewport.x = -4000; viewport.y = 2000;
    setCenter.mockClear();
    await wrapper.find('.graph-controls button:last-child').trigger("click"); await flushPromises();
    expect(setCenter).toHaveBeenCalledExactlyOnceWith(188, 121, { zoom: 0.9, duration: 0 });
  });

  it("discards delayed centering after a newer selection and leaves visible cards in place", async () => {
    const { wrapper, viewport, setCenter } = setup(); await flushPromises();
    const session = useSessionStore();
    const current = session.current!;
    const entries = [...current.entries, { type: "message", id: "b", parentId: null, timestamp: "2026-01-01", message: { role: "user", content: "B" } }];
    session.applySnapshot({ ...current, entries, projection: projectSession(entries, "a") });
    await flushPromises();
    const graph = (wrapper.vm as any).$.setupState;
    viewport.x = -5000;
    let release!: () => void;
    vi.mocked(nextFrame).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    setCenter.mockClear();
    const first = graph.select("turn:a");
    await flushPromises();
    await graph.select("turn:b");
    expect(setCenter).toHaveBeenCalledTimes(1);
    release(); await first;
    expect(setCenter).toHaveBeenCalledTimes(1);
    expect(session.focusedNode).toBe("turn:b");
    viewport.x = 0; viewport.y = 0;
    setCenter.mockClear();
    await graph.select("turn:a");
    expect(setCenter).not.toHaveBeenCalled();
  });
});
