import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import { desktop } from "../../src/renderer/api";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { RawSessionEntry, SessionSnapshot } from "../../src/shared/types";

function turns(count: number) {
  const entries: RawSessionEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({ type: "message", id: `u${i}`, parentId: i ? `a${i - 1}` : null, timestamp: "2026-01-01",
      message: { role: "user", content: `prompt ${i}` } });
    entries.push({ type: "message", id: `a${i}`, parentId: `u${i}`, timestamp: "2026-01-01",
      message: { role: "assistant", content: [{ type: "text", text: `answer ${i}` }] } });
  }
  return entries;
}
/** A snapshot as the wire delivers it once history is windowed: the pool only
 * holds the newest turns, while the projection still knows every node. */
function windowed(entries: RawSessionEntry[], pooled: RawSessionEntry[]): SessionSnapshot {
  const leaf = entries.at(-1)!.id;
  const projection = projectSession(entries, leaf);
  return {
    session: { id: "s", path: "s.jsonl", cwd: ".", created: "", modified: "", messageCount: entries.length, firstMessage: "prompt" },
    entries: pooled,
    projection: { ...projection, messages: projection.messages.filter(message => pooled.some(entry => entry.id === message.entryId)),
      messagesHasEarlier: true },
    runtime: { available: true, model: null, thinkingLevel: "off", availableThinkingLevels: [], isStreaming: false,
      isCompacting: false, isRetrying: false, autoRetryEnabled: true, autoCompactionEnabled: true,
      steeringMode: "all", followUpMode: "all", pendingMessageCount: 0 },
    graph: { id: "s.jsonl", epoch: "e", revision: 1, runs: [] },
  };
}
/** Mounts the panel on an already-applied snapshot, then gives the scroll
 * root jsdom-compatible geometry so fill checks behave like a real panel:
 * each rendered turn is 100px against a 500px viewport. */
async function mountOnSnapshot(snapshot: SessionSnapshot) {
  const pinia = createPinia(); setActivePinia(pinia);
  useLayoutStore().layout.collapsed.chat = false;
  useSessionStore().applySnapshot(snapshot);
  await flushPromises();
  const MarkdownRenderer = defineComponent({ name: "MarkdownRenderer", props: ["content", "customId"], template: "<div>{{ content }}</div>" });
  const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { MarkdownRenderer, PromptComposer: true } } });
  const root = wrapper.get(".branch-messages").element as HTMLElement;
  Object.defineProperty(root, "scrollHeight", { configurable: true, get: () => root.querySelectorAll(".chat-turn").length * 100 });
  Object.defineProperty(root, "clientHeight", { configurable: true, value: 500 });
  await flushPromises();
  return wrapper;
}
/** The user's gesture that pages older history in: scrolling up to the top. */
function scrollToTop(wrapper: ReturnType<typeof mount>) {
  const root = wrapper.get(".branch-messages").element as HTMLElement;
  root.scrollTop = 40;
  root.dispatchEvent(new Event("scroll"));
}
const pagingCalls = () => vi.mocked(desktop.invoke).mock.calls.filter(([route]) => route === "session.branchWindow");

afterEach(() => { vi.mocked(desktop.invoke).mockReset(); vi.mocked(desktop.invoke).mockImplementation(async () => ({})); });

it("pages history that is already local without asking the main process", async () => {
  const entries = turns(100);
  const wrapper = await mountOnSnapshot(windowed(entries, entries));
  try {
    expect(wrapper.findAll(".chat-turn")).toHaveLength(40);
    scrollToTop(wrapper);
    await flushPromises();
    expect(wrapper.findAll(".chat-turn")).toHaveLength(80);
    // A scrollable panel pages itself: no status, no retry row.
    expect(wrapper.find(".load-earlier-status").exists()).toBe(false);
    expect(wrapper.find("button.load-earlier-status").exists()).toBe(false);
    expect(pagingCalls()).toHaveLength(0);
  } finally { wrapper.unmount(); }
});

it("waits for older turns before rendering them and keeps the reading position", async () => {
  const entries = turns(100);
  let release: (value: unknown) => void = () => {};
  vi.mocked(desktop.invoke).mockImplementation(async route => route === "session.branchWindow"
    ? new Promise(resolve => { release = resolve; }) : {});
  const wrapper = await mountOnSnapshot(windowed(entries, entries.slice(-80)));
  try {
    const root = wrapper.get(".branch-messages").element as HTMLElement;
    root.scrollTop = 1_000;
    expect(wrapper.findAll(".chat-turn")).toHaveLength(40);

    scrollToTop(wrapper);
    await flushPromises();
    const status = wrapper.get(".load-earlier-status");
    expect(status.text()).toBe(i18n.global.t("branch.loadingEarlier"));
    expect(wrapper.findAll(".chat-turn")).toHaveLength(40);

    release({ entries, hasEarlier: false });
    await flushPromises();
    expect(wrapper.findAll(".chat-turn")).toHaveLength(80);
    // The fetched turns were prepended before the anchor was restored, so the
    // view keeps the content the reader was looking at instead of jumping.
    expect(root.scrollTop).toBe(40 + 4_000);
    expect(wrapper.find(".load-earlier-status").exists()).toBe(false);
  } finally { wrapper.unmount(); }
});

it("stops auto-paging when a byte-capped page stops growing, and a panel with no scroll room never scroll-pages", async () => {
  const entries = turns(100);
  let calls = 0;
  vi.mocked(desktop.invoke).mockImplementation(async route => {
    if (route !== "session.branchWindow") return {};
    calls++;
    // The byte cap returns the same newest turn every time: paging again can
    // only repeat that transfer, so the automatic cascade must stop.
    return { entries: entries.slice(-2), hasEarlier: true };
  });
  const wrapper = await mountOnSnapshot(windowed(entries, entries.slice(-2)));
  try {
    // The automatic top-up plus one unfilled cascade, then no further growth.
    const settled = calls;
    expect(settled).toBeGreaterThanOrEqual(1);
    await flushPromises();
    expect(calls).toBe(settled);
    // Two rendered turns never overflow the 500px viewport, so there is no
    // top to scroll to: the scroll trigger must stay silent (the streaming
    // follow-scroll would otherwise page through this path).
    scrollToTop(wrapper);
    await flushPromises();
    expect(calls).toBe(settled);
    // The stuck short panel offers its only way forward: a retry row whose
    // click is an explicit request, so the byte budget doubles and asks again.
    const retry = wrapper.get("button.load-earlier-status");
    expect(retry.text()).toBe(i18n.global.t("branch.retryEarlier"));
    await retry.trigger("click");
    await flushPromises();
    expect(calls).toBe(settled + 1);
  } finally { wrapper.unmount(); }
});
