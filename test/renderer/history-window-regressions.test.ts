import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent } from "vue";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import { createRunCommand } from "../../src/renderer/features/commands/runCommand";
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
beforeAll(() => { globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(desktop.invoke).mockReset().mockResolvedValue({}); });

it("retains the compaction summary for the oldest visible branch turn", async () => {
  const all = [user("root", null), { type: "compaction", id: "c", parentId: "root", timestamp: "2026-01-02", summary: "branch summary", firstKeptEntryId: "root" } as RawSessionEntry];
  for (let i = 0; i < 40; i++) all.push(user(`b${i}`, i ? `b${i-1}` : "c"));
  const full = snapshot(all);
  full.projection.nodes.find(node => node.id === "turn:b0")!.metrics = { compactions: [{ status: "complete", entryTimestamp: "2026-01-02" }] };
  const { pinia, store } = setup([]);
  store.applySnapshot({ ...full, entries: [all[0]!] }); store.focusedNode = "turn:b39";
  vi.mocked(desktop.invoke).mockImplementation(async (route, input: any) => route === "session.branchWindow" ? windowEntries(all, input.leafId, input.limit, input.bytes) : {});
  // Model a panel whose 40 turns fill the viewport, avoiding the jsdom zero-height auto-fill.
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { MarkdownRenderer: true } } });
  try {
    await flushPromises();
    const panel = (wrapper.vm as any).$.setupState;
    expect(panel.visibleTurns).toHaveLength(40);
    expect(panel.visibleTurns[0].compactions[0].summary).toBe("branch summary");
  } finally { wrapper.unmount(); }
});

it("can publish search results while node updates arrive faster than remote replies", async () => {
  vi.useFakeTimers();
  const main = [user("main", null, "needle")];
  const { pinia, store } = setup(main);
  let calls = 0;
  vi.mocked(desktop.invoke).mockImplementation(async route => {
    if (route !== "session.search") return {};
    calls++; await new Promise(resolve => setTimeout(resolve, 500)); return { nodeIds: ["turn:main"] };
  });
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow: true } } });
  try {
    await flushPromises(); const graph = (wrapper.vm as any).$.setupState;
    await graph.toggleSearch(); await wrapper.get('[data-action="graph-search-input"]').setValue("needle");
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(250);
      const next = snapshot(main); next.graph!.revision = i + 2;
      next.projection.nodes[0]!.preview = `tool iteration ${i + 1}`;
      next.projection.nodes[0]!.toolCallCount = i + 1;
      store.applySnapshot(next); await flushPromises();
    }
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(5);
    expect(graph.searchHits).toEqual(["turn:main"]);
  } finally { wrapper.unmount(); }
});

for (const preloaded of [false, true]) it(`copies the last answer outside the wire window (preloaded=${preloaded})`, async () => {
  const all = [user("old", null), { ...user("answer", "old"), message: { role: "assistant", content: "last answer" } }, user("new", "answer", "x".repeat(4 << 20))];
  const { pinia, store } = setup([]);
  const full = snapshot(all), page = windowEntries(all, "new", 40, 4 << 20);
  const ids = new Set(page.entries.map(entry => entry.id));
  store.applySnapshot({ ...full, entries: page.entries, projection: { ...full.projection, messages: full.projection.messages.filter(message => ids.has(message.entryId)), messagesHasEarlier: true } });
  vi.mocked(desktop.invoke).mockImplementation(async (route, input: any) => route === "session.branchWindow" ? windowEntries(all, input.leafId, input.limit, input.bytes) : {});
  if (preloaded) await store.fetchWindow("new", 40);
  expect(store.current!.entries.some(entry => entry.id === "answer")).toBe(preloaded);
  const copy = vi.spyOn(window.pix!, "copy");
  let run!: (name: string) => Promise<void>;
  const wrapper = mount(defineComponent({ setup() { run = createRunCommand({ requestRename: async () => {}, requestCompact() {}, closeSettings() {} }).runCommand; return () => null; } }), { global: { plugins: [pinia, i18n] } });
  try { await run("copy"); expect(copy).toHaveBeenCalledWith("last answer"); }
  finally { wrapper.unmount(); }
});

it("invalidates a pending search when the query changes", async () => {
  vi.useFakeTimers();
  const { pinia, store } = setup([user("main", null)]);
  const replies: Array<(value: unknown) => void> = [];
  vi.mocked(desktop.invoke).mockImplementation(async route => route === "session.search"
    ? new Promise(resolve => replies.push(resolve)) : {});
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow: true } } });
  try {
    await flushPromises();
    const graph = (wrapper.vm as any).$.setupState;
    await graph.toggleSearch();
    await wrapper.get('[data-action="graph-search-input"]').setValue("old");
    await vi.advanceTimersByTimeAsync(150);
    await wrapper.get('[data-action="graph-search-input"]').setValue("new");
    await vi.advanceTimersByTimeAsync(150);
    replies[1]!({ nodeIds: ["turn:main"] }); await flushPromises();
    replies[0]!({ nodeIds: ["obsolete"] }); await flushPromises();
    expect(store.searchResults).toEqual(["turn:main"]);
    await graph.toggleSearch();
    expect(store.searchResults).toEqual([]);
  } finally { wrapper.unmount(); }
});

it("does not copy a reply from a replaced session while history is loading", async () => {
  const all = [user("old", null), { ...user("answer", "old"), message: { role: "assistant", content: "old answer" } }, user("new", "answer")];
  const { store } = setup([]);
  const full = snapshot(all);
  store.applySnapshot({ ...full, entries: [all[2]!], projection: { ...full.projection, messages: full.projection.messages.slice(-1) } });
  let release!: (value: unknown) => void;
  vi.mocked(desktop.invoke).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const reading = store.lastAssistantText();
  store.applySnapshot({ ...snapshot([]), graph: { ...full.graph!, epoch: "reopened" } });
  release(windowEntries(all, "answer", 40));
  expect(await reading).toBeUndefined();
  expect(store.current!.entries).toEqual([]);
});

it("reports a failed history read instead of claiming no assistant ever replied", async () => {
  const { store } = setup([user("new", "missing")]);
  vi.mocked(desktop.invoke).mockRejectedValue(new Error("offline"));
  await expect(store.lastAssistantText()).rejects.toThrow();
  expect(desktop.invoke).toHaveBeenCalledTimes(1);
});

it("resolves equal-timestamp compaction summaries within the selected branch", async () => {
  const all: RawSessionEntry[] = [user("root", null)];
  for (const id of ["a", "b"]) all.push(
    { type: "compaction", id: `c-${id}`, parentId: "root", timestamp: "2026-02-01", summary: `summary ${id}`, firstKeptEntryId: "root" },
    user(id, `c-${id}`),
  );
  const { pinia, store } = setup([]);
  const full = snapshot(all);
  for (const node of full.projection.nodes.filter(node => node.id !== "turn:root"))
    node.metrics = { compactions: [{ status: "complete", entryTimestamp: "2026-02-01" }] };
  store.applySnapshot(full); store.focusedNode = "turn:a";
  const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { MarkdownRenderer: true } } });
  try {
    await flushPromises();
    const panel = (wrapper.vm as any).$.setupState;
    expect(panel.visibleTurns.find((turn: any) => turn.id === "turn:a").compactions[0].summary).toBe("summary a");
    store.focusedNode = "turn:b"; await flushPromises();
    expect(panel.visibleTurns.find((turn: any) => turn.id === "turn:b").compactions[0].summary).toBe("summary b");
  } finally { wrapper.unmount(); }
});
