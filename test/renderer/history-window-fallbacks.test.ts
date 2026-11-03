import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent } from "vue";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import PromptComposer from "../../src/renderer/components/PromptComposer.vue";
import { desktop } from "../../src/renderer/api";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useSessionStore } from "../../src/renderer/stores/session";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { RawSessionEntry, SessionSnapshot } from "../../src/shared/types";

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }

/** Three turns, but the wire window only carries the newest two: the first
 * turn's entries must come back on demand. */
function windowedSnapshot() {
  const entries: RawSessionEntry[] = [];
  for (let i = 0; i < 3; i++) {
    entries.push({ type: "message", id: `u${i}`, parentId: i ? `a${i - 1}` : null, timestamp: "2026-01-01",
      message: { role: "user", content: `prompt ${i} ${"x".repeat(120)}` } });
    entries.push({ type: "message", id: `a${i}`, parentId: `u${i}`, timestamp: "2026-01-01",
      message: { role: "assistant", content: [{ type: "text", text: `answer ${i} ${"y".repeat(400)}` }] } });
  }
  const projection = projectSession(entries, "a2");
  return {
    session: { id: "s", path: "s.jsonl", cwd: ".", created: "", modified: "", messageCount: entries.length, firstMessage: "prompt" },
    entries: entries.slice(2),
    projection: { ...projection, messagesHasEarlier: true },
    runtime: { available: true, model: null, thinkingLevel: "off", availableThinkingLevels: [], isStreaming: false,
      isCompacting: false, isRetrying: false, autoCompactionEnabled: true, autoRetryEnabled: true,
      steeringMode: "all", followUpMode: "all", pendingMessageCount: 0 },
    graph: { id: "s.jsonl", epoch: "e", revision: 1, runs: [] },
  } as SessionSnapshot & { entries: RawSessionEntry[] };
}

afterEach(() => { vi.mocked(desktop.invoke).mockReset(); vi.mocked(desktop.invoke).mockImplementation(async () => ({})); });

beforeAll(() => { globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver; });

it("loads an older node's turn before showing or resending it", async () => {
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore();
  const snapshot = windowedSnapshot();
  const older = snapshot.projection.nodes.find(node => node.id === "turn:u0")!;
  expect(older).toBeTruthy();
  vi.mocked(desktop.invoke).mockImplementation(async route => route === "session.branchWindow"
    ? { entries: [
      { type: "message", id: "u0", parentId: null, timestamp: "2026-01-01", message: { role: "user", content: "prompt 0 " + "x".repeat(120) } },
      { type: "message", id: "a0", parentId: "u0", timestamp: "2026-01-01",
        message: { role: "assistant", content: [{ type: "text", text: "answer 0 " + "y".repeat(400) }] } },
    ], hasEarlier: true }
    : {});
  session.applySnapshot(snapshot);
  await flushPromises();
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n] } });
  try {
    await vi.waitFor(() => expect(wrapper.findAllComponents({ name: "PromptNode" })
      .some(item => item.props("id") === "turn:u0")).toBe(true));
    const card = wrapper.findAllComponents({ name: "PromptNode" }).find(item => item.props("id") === "turn:u0")!;
    const data = card.props("data") as { content: () => { user: string; assistant: string }; onLoadContent: () => Promise<void> };
    // Before loading, the card falls back to the clipped projection text.
    expect(data.content().user.length).toBeLessThan("prompt 0 ".length + 120);
    await data.onLoadContent();
    await flushPromises();
    expect(desktop.invoke).toHaveBeenCalledWith("session.branchWindow", expect.objectContaining({ leafId: "a0" }));
    expect(data.content().user).toBe("prompt 0 " + "x".repeat(120));
    expect(data.content().assistant).toBe("answer 0 " + "y".repeat(400));
  } finally { wrapper.unmount(); }
});

it("recalls prompts from beyond the window by merging the main process list", async () => {
  const pinia = createPinia(); setActivePinia(pinia);
  useLayoutStore().layout.collapsed.chat = false;
  vi.mocked(desktop.invoke).mockImplementation(async route => route === "session.prompts"
    ? { prompts: ["older prompt", "prompt 1 " + "x".repeat(120)] } : {});
  const session = useSessionStore();
  const snapshot = windowedSnapshot();
  session.applySnapshot(snapshot);
  await flushPromises();
  const MarkdownRenderer = defineComponent({ name: "MarkdownRenderer", props: ["content", "customId"], template: "<div>{{ content }}</div>" });
  const wrapper = mount(BranchContextPanel, { global: { plugins: [pinia, i18n],
    stubs: { MarkdownRenderer, PromptComposer: false } } });
  try {
    // The composer starts collapsed; opening it mounts the recall list.
    await wrapper.get(".composer-collapsed").trigger("click");
    await flushPromises();
    const history = wrapper.findComponent(PromptComposer).props("history") as string[];
    // Newest local prompts first, then whatever only the main process knows.
    expect(history.slice(0, 2)).toEqual([`prompt 2 ${"x".repeat(120)}`, `prompt 1 ${"x".repeat(120)}`]);
    expect(history).toContain("older prompt");
    expect(history.filter(text => text.startsWith("prompt 1 "))).toHaveLength(1);
  } finally { wrapper.unmount(); }
});
