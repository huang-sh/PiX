import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, onMounted, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useSessionStore } from "../../src/renderer/stores/session";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { RawSessionEntry, SessionSnapshot } from "../../src/shared/types";

vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: vi.fn(async () => {}), whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
enableAutoUnmount(afterEach);

function mountGraph(entries: RawSessionEntry[], leafId: string | null, available: boolean) {
  const pinia = createPinia(); setActivePinia(pinia);
  const layout = useLayoutStore(); layout.panelsSettled = true;
  useSessionStore().current = {
    session: { id: "retry", path: "C:/tmp/retry.jsonl", cwd: "C:/tmp", created: "", modified: "", messageCount: entries.length, firstMessage: "" },
    entries, projection: projectSession(entries, leafId),
    runtime: { available, model: null, thinkingLevel: "off", availableThinkingLevels: [], isStreaming: false,
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
  return { wrapper, setupState: (wrapper.vm as unknown as { $: { setupState: Record<string, any> } }).$.setupState };
}

const okBranch: RawSessionEntry[] = [
  { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01", message: { role: "user", content: "fix the login bug" } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01", message: { role: "assistant", content: [{ type: "text", text: "fixed it" }] } },
  { type: "message", id: "u2", parentId: "a1", timestamp: "2026-01-01", message: { role: "user", content: "now refactor it" } },
  { type: "message", id: "a2", parentId: "u2", timestamp: "2026-01-01", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "boom" }] } },
];

describe("retry failed turn", () => {
  beforeEach(() => { vi.mocked(window.pix!.invoke).mockReset().mockResolvedValue({}); });

  it("offers retry only on failed turns of a writable runtime", async () => {
    const { setupState } = mountGraph(okBranch, "a2", true); await flushPromises();
    const failed = setupState.nodes.find((node: { id: string }) => node.id === "turn:u2");
    const healthy = setupState.nodes.find((node: { id: string }) => node.id === "turn:u1");
    expect(typeof failed?.data?.onRetry).toBe("function");
    expect(healthy?.data?.onRetry).toBeUndefined();
  });

  it("stays hidden on a read-only runtime", async () => {
    const { setupState } = mountGraph(okBranch, "a2", false); await flushPromises();
    expect(setupState.nodes.find((node: { id: string }) => node.id === "turn:u2")?.data?.onRetry).toBeUndefined();
  });

  it("reopens the failed prompt as a draft on the parent, keeping the failed turn", async () => {
    const { setupState } = mountGraph(okBranch, "a2", true); await flushPromises();
    await setupState.retryTurn("turn:u2");
    await flushPromises();
    expect(setupState.draftParent).toBe("turn:u1");
    expect(setupState.draftState.text).toBe("now refactor it");
    expect(setupState.nodes.find((node: { id: string }) => node.id === "draft:turn:u1")).toBeTruthy();
    // The failed turn itself is untouched: still on the canvas, still marked failed.
    const failed = setupState.nodes.find((node: { id: string }) => node.id === "turn:u2");
    expect(failed?.data?.node?.hasError).toBe(true);
  });

  it("retries a failed root turn by continuing its own branch", async () => {
    const root: RawSessionEntry[] = [
      { type: "message", id: "r1", parentId: null, timestamp: "2026-01-01", message: { role: "user", content: "first attempt" } },
      { type: "message", id: "r2", parentId: "r1", timestamp: "2026-01-01", message: { role: "assistant", isError: true, content: [{ type: "text", text: "failed" }] } },
    ];
    const { setupState } = mountGraph(root, "r2", true); await flushPromises();
    await setupState.retryTurn("turn:r1");
    await flushPromises();
    expect(setupState.draftParent).toBe("turn:r1");
    expect(setupState.draftState.text).toBe("first attempt");
  });
});
