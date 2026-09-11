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
