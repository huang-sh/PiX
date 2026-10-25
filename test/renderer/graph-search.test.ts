import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, onMounted, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useSessionStore } from "../../src/renderer/stores/session";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import { graphNodeBlobs, searchGraphNodeIds } from "../../src/renderer/lib/graph-search";
import type { RawSessionEntry, SessionSnapshot } from "../../src/shared/types";

vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: vi.fn(async () => {}), whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
enableAutoUnmount(afterEach);

const entries: RawSessionEntry[] = [
  { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01", message: { role: "user", content: "fix the login bug" } },
  { type: "message", id: "t1", parentId: "u1", timestamp: "2026-01-01", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "auth.ts" }] } },
  { type: "message", id: "a1", parentId: "t1", timestamp: "2026-01-01", message: { role: "assistant", content: [{ type: "text", text: "patched the session guard" }] } },
  { type: "message", id: "u2", parentId: null, timestamp: "2026-01-01", message: { role: "user", content: "write the docs" } },
  { type: "message", id: "a2", parentId: "u2", timestamp: "2026-01-01", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
];
const projection = projectSession(entries, "a1");

describe("graph search matching", () => {
  it("matches prompts, replies, and tool names case-insensitively", () => {
    expect(searchGraphNodeIds(projection, entries, "login")).toEqual(["turn:u1"]);
    expect(searchGraphNodeIds(projection, entries, "SESSION GUARD")).toEqual(["turn:u1"]);
    expect(searchGraphNodeIds(projection, entries, "read")).toEqual(["turn:u1"]);
    expect(searchGraphNodeIds(projection, entries, "docs")).toEqual(["turn:u2"]);
    expect(searchGraphNodeIds(projection, entries, "  ")).toEqual([]);
  });

  it("builds text blobs once per immutable snapshot", () => {
    expect(graphNodeBlobs(projection, entries)).toBe(graphNodeBlobs(projection, entries));
    expect(graphNodeBlobs(projection, [...entries])).not.toBe(graphNodeBlobs(projection, entries));
  });
});

function mountGraph() {
  const pinia = createPinia(); setActivePinia(pinia);
  const layout = useLayoutStore(); layout.panelsSettled = true;
  useSessionStore().current = {
    session: { id: "search", path: "C:/tmp/search.jsonl", cwd: "C:/tmp", created: "", modified: "", messageCount: entries.length, firstMessage: "" },
    entries, projection,
    runtime: { available: true, model: null, thinkingLevel: "off", availableThinkingLevels: [], isStreaming: false,
      isCompacting: false, isRetrying: false, autoCompactionEnabled: true, autoRetryEnabled: true,
      steeringMode: "all", followUpMode: "all", pendingMessageCount: 0 },
  } satisfies SessionSnapshot;
  const store = { getViewport: () => ({ x: 0, y: 0, zoom: 0.4 }), setCenter: vi.fn(async () => true),
    findNode: vi.fn(() => undefined), dimensions: ref({ width: 800, height: 600 }) };
  const VueFlow = defineComponent({
    name: "VueFlow", emits: ["paneReady"], setup(_, { emit }) { onMounted(() => emit("paneReady", store)); },
    template: '<div><slot /></div>',
  });
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow, MiniMap: true } } });
  const setupState = (wrapper.vm as unknown as { $: { setupState: Record<string, any> } }).$.setupState;
  return { wrapper, setupState, setCenter: store.setCenter };
}

describe("graph search panel", () => {
  beforeEach(() => { vi.mocked(window.pix!.invoke).mockReset().mockResolvedValue({}); });

  it("highlights matching cards and shows the hit count while typing", async () => {
    const { wrapper } = mountGraph(); await flushPromises();
    await wrapper.find('.graph-controls button[aria-expanded]').trigger("click");
    await flushPromises();
    const input = wrapper.get('[data-action="graph-search-input"]');
    await input.setValue("login");
    await flushPromises();
    expect(wrapper.get(".graph-search-count").text()).toBe("1 match");
    const state = (wrapper.vm as unknown as { $: { setupState: Record<string, any> } }).$.setupState;
    expect(state.nodes.find((node: { id: string }) => node.id === "turn:u1").data.searchHit).toBe(true);
    expect(state.nodes.find((node: { id: string }) => node.id === "turn:u2").data.searchHit).toBeFalsy();
    await input.setValue("nothing matches this");
    await flushPromises();
    expect(wrapper.get(".graph-search-count").text()).toBe("No matches");
  });

  it("cycles through hits on Enter and lands the selection", async () => {
    const { wrapper, setupState } = mountGraph(); await flushPromises();
    await wrapper.find('.graph-controls button[aria-expanded]').trigger("click");
    await flushPromises();
    const input = wrapper.get('[data-action="graph-search-input"]');
    await input.setValue("the");
    await flushPromises();
    // "the" matches both turns ("fix the login bug", "write the README").
    await input.trigger("keydown.enter");
    await flushPromises();
    expect(useSessionStore().focusedNode).toBe("turn:u1");
    await input.trigger("keydown.enter", { shiftKey: true });
    await flushPromises();
    expect(useSessionStore().focusedNode).toBe("turn:u2");
    expect(setupState.searchPosition).toBe(1);
  });

  it("clears highlights when the search is closed", async () => {
    const { wrapper } = mountGraph(); await flushPromises();
    const state = (wrapper.vm as unknown as { $: { setupState: Record<string, any> } }).$.setupState;
    await wrapper.find('.graph-controls button[aria-expanded]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="graph-search-input"]').setValue("login");
    await flushPromises();
    expect(state.nodes.find((node: { id: string }) => node.id === "turn:u1").data.searchHit).toBe(true);
    await wrapper.find('.graph-controls button[aria-expanded]').trigger("click");
    await flushPromises();
    expect(state.nodes.find((node: { id: string }) => node.id === "turn:u1").data.searchHit).toBeFalsy();
    expect(wrapper.find('[data-action="graph-search-input"]').exists()).toBe(false);
  });
});


describe("graph labels and task filters", () => {
  beforeEach(() => { vi.mocked(window.pix!.invoke).mockReset().mockResolvedValue({}); });
  it("shows matching tasks and ancestor context without changing the session projection", async () => {
    const { wrapper, setupState } = mountGraph(); await flushPromises();
    const session = useSessionStore();
    session.current!.projection = { ...session.current!.projection, nodes: session.current!.projection.nodes.map((node, index) =>
      index ? { ...node, label: "文档完成", parentId: "turn:u1" } : node) };
    await wrapper.get('[data-action="graph-filter"]').setValue("labeled"); await flushPromises();
    expect(setupState.filterCount).toBe(1);
    expect(setupState.filteredGraph.nodes.map((node: { id: string }) => node.id)).toEqual(["turn:u1", "turn:u2"]);
    expect(setupState.nodes.find((node: { id: string }) => node.id === "turn:u1").data.filterContext).toBe(true);
    expect(session.current!.projection.nodes).toHaveLength(2);
    await wrapper.get('[data-action="graph-filter"]').setValue("running"); await flushPromises();
    expect(setupState.filteredGraph.nodes.filter((node: { type: string }) => node.type === "prompt")).toHaveLength(0);
    expect(wrapper.get('[role="status"]').text()).toContain("No matching tasks");
    await wrapper.get('[data-action="graph-filter"]').setValue("all"); await flushPromises();
    expect(setupState.filteredGraph.nodes.filter((node: { type: string }) => node.type === "prompt")).toHaveLength(2);
  });

  it("saves a node label through the shared control and keeps failures editable", async () => {
    const { setupState } = mountGraph(); await flushPromises();
    setupState.editLabel(useSessionStore().current!.projection.nodes[0]);
    setupState.labelText = "登录测试通过";
    vi.mocked(window.pix!.invoke).mockRejectedValueOnce(new Error("storage unavailable"));
    await setupState.saveLabel();
    expect(setupState.labelError).toBe("storage unavailable");
    expect(setupState.labelText).toBe("登录测试通过");
    expect(setupState.labelTarget).toBeTruthy();
    vi.mocked(window.pix!.invoke).mockResolvedValueOnce({});
    await setupState.saveLabel();
    expect(window.pix!.invoke).toHaveBeenLastCalledWith("agent.control", { action: "setLabel", entryId: "u1", label: "登录测试通过" });
    expect(setupState.labelTarget).toBeUndefined();
  });

  it("searches bookmark names and closes label editing when sessions change", async () => {
    const { setupState } = mountGraph(); await flushPromises();
    const current = useSessionStore().current!;
    const marked = { ...current.projection, nodes: current.projection.nodes.map((node, index) => index ? { ...node, label: "文档书签" } : node) };
    expect(searchGraphNodeIds(marked, entries, "文档书签")).toEqual(["turn:u2"]);
    setupState.editLabel(current.projection.nodes[0]);
    current.session = { ...current.session, path: "other-session" };
    await flushPromises();
    expect(setupState.labelTarget).toBeUndefined();
  });
});
