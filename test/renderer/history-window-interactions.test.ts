import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent } from "vue";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import PromptComposer from "../../src/renderer/components/PromptComposer.vue";
import { desktop } from "../../src/renderer/api";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { i18n } from "../../src/renderer/i18n";
import { projectSession, windowEntries } from "../../src/shared/session";
import type { RawSessionEntry, SessionSnapshot } from "../../src/shared/types";

const user = (id: string, parentId: string | null, content = id): RawSessionEntry =>
  ({ type: "message", id, parentId, timestamp: "2026-01-01", message: { role: "user", content } });
function snapshot(entries: RawSessionEntry[]): SessionSnapshot {
  return { session: { path: "s", id: "s" }, entries, projection: projectSession(entries, entries.at(-1)?.id ?? null),
    runtime: { available: true, model: null, thinkingLevel: "off", availableThinkingLevels: [] },
    graph: { id: "s", epoch: "e", revision: 1, runs: [] } } as SessionSnapshot;
}
function setup(entries: RawSessionEntry[]) {
  const pinia = createPinia(); setActivePinia(pinia);
  useLayoutStore().layout.collapsed.chat = false;
  const store = useSessionStore(); store.applySnapshot(snapshot(entries));
  return { pinia, store };
}
const MarkdownRenderer = defineComponent({ props: ["content"], template: "<div>{{ content }}</div>" });
beforeAll(() => { globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver; });
afterEach(() => { vi.mocked(desktop.invoke).mockReset().mockResolvedValue({}); });

it("loads one turn for a node preview even when pages are byte-capped", async () => {
  const all = Array.from({ length: 60 }, (_, i) => user(`u${i}`, i ? `u${i - 1}` : null));
  const { pinia, store } = setup([]);
  store.applySnapshot({ ...snapshot(all), entries: all.slice(-3) });
  const requests: Array<{ leafId: string; limit: number; bytes: number }> = [];
  vi.mocked(desktop.invoke).mockImplementation(async (route, input) => {
    if (route !== "session.branchWindow") return {};
    const request = input as typeof requests[number]; requests.push(request);
    return windowEntries(all, request.leafId, Math.min(3, request.limit), request.bytes);
  });
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow: true } } });
  try {
    await flushPromises();
    const graph = (wrapper.vm as unknown as { $: { setupState: Record<string, any> } }).$.setupState;
    await graph.loadNodeContent(store.current!.projection.nodes[50]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ leafId: "u50", limit: 1 });
    expect(graph.nodeContent("turn:u50").user).toBe("u50");
  } finally { wrapper.unmount(); }
});

it("refreshes recall when an off-main branch arrives without reopening the session", async () => {
  const main = [user("main", null, "old main prompt")];
  const { pinia, store } = setup(main); store.focusedNode = "turn:main";
  let prompts = ["old main prompt"];
  vi.mocked(desktop.invoke).mockImplementation(async route => route === "session.prompts" ? { prompts } : {});
  const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { MarkdownRenderer } } });
  try {
    await wrapper.get(".composer-collapsed").trigger("click"); await flushPromises();
    prompts = ["new branch prompt", ...prompts];
    const next = snapshot(main); next.graph!.revision++;
    next.projection = projectSession([...main, user("branch", "main", "new branch prompt")], "main");
    store.applySnapshot(next); await flushPromises();
    expect(wrapper.findComponent(PromptComposer).props("history")).toEqual(prompts);
  } finally { wrapper.unmount(); }
});

it("refreshes search when a branch arrives without retyping the query", async () => {
  const main = [user("main", null)];
  const { pinia, store } = setup(main);
  let hits: string[] = [], calls = 0;
  vi.mocked(desktop.invoke).mockImplementation(async route => {
    if (route !== "session.search") return {};
    calls++; return { nodeIds: hits };
  });
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow: true } } });
  try {
    await flushPromises();
    const graph = (wrapper.vm as unknown as { $: { setupState: Record<string, any> } }).$.setupState;
    await graph.toggleSearch();
    await wrapper.get('[data-action="graph-search-input"]').setValue("needle");
    await vi.waitFor(() => expect(calls).toBe(1));
    hits = ["turn:branch"];
    const next = snapshot(main); next.graph!.revision++;
    next.projection = projectSession([...main, user("branch", "main", "needle")], "main");
    store.applySnapshot(next);
    await vi.waitFor(() => expect(graph.searchHits).toEqual(hits));
  } finally { wrapper.unmount(); }
});
