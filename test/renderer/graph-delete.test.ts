import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useSessionStore } from "../../src/renderer/stores/session";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";

enableAutoUnmount(afterEach);

function forkedSnapshot(): SessionSnapshot {
  const entries = [
    { type: "message", id: "a", parentId: null, timestamp: "2026-01-01", message: { role: "user", content: "A" } },
    { type: "message", id: "b", parentId: "a", timestamp: "2026-01-02", message: { role: "user", content: "B" } },
    { type: "message", id: "c", parentId: "a", timestamp: "2026-01-03", message: { role: "user", content: "C" } },
    { type: "message", id: "d", parentId: "a", timestamp: "2026-01-04", message: { role: "user", content: "D" } },
  ];
  return snapshotWith(entries, "d");
}

function snapshotWith(entries: unknown[], leaf: string): SessionSnapshot {
  return {
    session: { id: "s2", path: "C:/tmp/s2.jsonl", cwd: "C:/tmp", created: "", modified: "", messageCount: entries.length, firstMessage: "A" },
    entries, projection: projectSession(entries as never, leaf),
    graph: { id: "C:/tmp/s2.jsonl", epoch: "epoch", revision: 1, runs: [], recoveredInputs: [] },
    runtime: { available: true, model: null, thinkingLevel: "off", availableThinkingLevels: [], isStreaming: false,
      isCompacting: false, isRetrying: false, autoCompactionEnabled: true, autoRetryEnabled: true,
      steeringMode: "all", followUpMode: "all", pendingMessageCount: 0 },
  } as unknown as SessionSnapshot;
}

function nodeTransform(wrapper: ReturnType<typeof mount>, id: string) {
  const style = wrapper.find(`[data-id="${id}"]`).attributes("style") ?? "";
  const m = style.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : undefined;
}

function snapshot(): SessionSnapshot {
  const entries = [
    { type: "message", id: "a", parentId: null, timestamp: "2026-01-01", message: { role: "user", content: "A" } },
    { type: "message", id: "b", parentId: "a", timestamp: "2026-01-01", message: { role: "user", content: "B" } },
    { type: "message", id: "c", parentId: "b", timestamp: "2026-01-01", message: { role: "user", content: "C" } },
  ];
  return {
    session: { id: "s1", path: "C:/tmp/s1.jsonl", cwd: "C:/tmp", created: "", modified: "", messageCount: 3, firstMessage: "A" },
    entries, projection: projectSession(entries, "c"),
    graph: { id: "C:/tmp/s1.jsonl", epoch: "epoch", revision: 1, runs: [], recoveredInputs: [] },
    runtime: { available: true, model: null, thinkingLevel: "off", availableThinkingLevels: [], isStreaming: false,
      isCompacting: false, isRetrying: false, autoCompactionEnabled: true, autoRetryEnabled: true,
      steeringMode: "all", followUpMode: "all", pendingMessageCount: 0 },
  };
}

describe("graph node context menu deletion", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  });
  beforeEach(() => {
    vi.mocked(window.pix!.invoke).mockReset();
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("vue-flow__node") ? 280 : 2400;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("vue-flow__node") ? 146 : 900;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("deletes the right-clicked subtree immediately, updates chat and removes its draft", async () => {
    const pinia = createPinia(); setActivePinia(pinia);
    const session = useSessionStore(); session.current = snapshot(); session.focusedNode = "turn:c";
    const next = snapshot(); next.entries = next.entries.slice(0, 1); next.projection = projectSession(next.entries, "a"); next.graph!.revision++;
    const invoke = vi.mocked(window.pix!.invoke).mockResolvedValueOnce(next);
    const wrapper = mount(GraphPanel, { attachTo: document.body, global: { plugins: [pinia, i18n] } });
    await flushPromises();
    await wrapper.find('[data-id="turn:c"] .node-add').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-id="draft:turn:c"]').exists()).toBe(true);
    const target = wrapper.find('[data-id="turn:b"] .prompt-node');
    await target.trigger("contextmenu", { clientX: 150, clientY: 90, button: 2 });
    await flushPromises();
    const item = document.querySelector<HTMLElement>('[data-action="node-delete"]');
    expect(item).not.toBeNull();
    expect(item!.hasAttribute("data-disabled")).toBe(false);
    item!.click(); await flushPromises();
    expect(invoke).toHaveBeenCalledWith("agent.control", { action: "deleteNode", nodeId: "turn:b", graphId: "C:/tmp/s1.jsonl" });
    expect(session.focusedNode).toBe("turn:a");
    expect(session.messageWindow(40).messages.map(message => message.text)).toEqual(["A"]);
    expect(wrapper.find('[data-id="turn:b"]').exists()).toBe(false);
    expect(wrapper.find('[data-id="turn:c"]').exists()).toBe(false);
    expect(wrapper.find('[data-id="draft:turn:c"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("reflows dragged nodes whose layout slot moved when a sibling subtree is deleted", async () => {
    const pinia = createPinia(); setActivePinia(pinia);
    const session = useSessionStore(); session.current = forkedSnapshot(); session.focusedNode = "turn:d";
    const next = forkedSnapshot();
    next.entries = next.entries.filter((entry) => entry.id !== "c");
    next.projection = projectSession(next.entries as never, "a"); next.graph!.revision++;
    vi.mocked(window.pix!.invoke).mockResolvedValueOnce(next);
    const wrapper = mount(GraphPanel, { attachTo: document.body, global: { plugins: [pinia, i18n] } });
    await flushPromises();
    // The user dragged turn:d two rows down and turn:b aside; deleting the middle
    // sibling must compact the freed slot instead of leaving a stale hole.
    const flow = wrapper.findComponent({ name: "VueFlow" });
    flow.vm.$emit("nodeDragStop", { node: { id: "turn:d", position: { x: 420, y: 600 } } });
    flow.vm.$emit("nodeDragStop", { node: { id: "turn:b", position: { x: 840, y: 48 } } });
    await flushPromises();
    await wrapper.find('[data-id="turn:c"] .prompt-node').trigger("contextmenu", { clientX: 150, clientY: 90, button: 2 });
    await flushPromises();
    document.querySelector<HTMLElement>('[data-action="node-delete"]')!.click();
    await flushPromises();
    // The reflow settles once the post-delete recenter animation finishes;
    // Vue Flow unmounts off-viewport nodes while it pans.
    await vi.waitFor(() => expect(nodeTransform(wrapper, "turn:d")).toEqual({ x: 420, y: 222 }), { timeout: 2000 });
    // turn:b's auto slot is untouched by the deletion, so its manual pick stays.
    expect(nodeTransform(wrapper, "turn:b")).toEqual({ x: 840, y: 48 });
    wrapper.unmount();
  });

  it("disables deletion during a run and shows backend failures without removing cards", async () => {
    const pinia = createPinia(); setActivePinia(pinia);
    const session = useSessionStore(); session.current = snapshot();
    session.current.graph!.runs = [{ branchId: "main", runId: "run", nodeId: "turn:c", status: "running" }];
    const wrapper = mount(GraphPanel, { attachTo: document.body, global: { plugins: [pinia, i18n] } });
    await flushPromises();
    await wrapper.find('[data-id="turn:b"] .prompt-node').trigger("contextmenu", { clientX: 150, clientY: 90 });
    await flushPromises();
    expect(document.querySelector('[data-action="node-delete"]')!.hasAttribute("data-disabled")).toBe(true);
    session.current.graph!.runs = []; await flushPromises();
    vi.mocked(window.pix!.invoke).mockRejectedValueOnce(new Error("write failed"));
    document.querySelector<HTMLElement>('[data-action="node-delete"]')!.click(); await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain("write failed");
    expect(wrapper.find('[data-id="turn:b"]').exists()).toBe(true);
    expect(session.deletingNode).toBe(false);
    wrapper.unmount();
  });

  it("offers reopening after a failed commit and allows retrying a failed reopen", async () => {
    const pinia = createPinia(); setActivePinia(pinia);
    const session = useSessionStore(); session.current = snapshot();
    session.current.runtime.available = false;
    session.current.graph!.storageError = "Reopen this session to recover: EACCES";
    const wrapper = mount(GraphPanel, { attachTo: document.body, global: { plugins: [pinia, i18n] } });
    await flushPromises();
    expect(session.deleteBlockedReason).toBe("graph.blockedReadonly");
    const invoke = vi.mocked(window.pix!.invoke).mockRejectedValueOnce(new Error("still unavailable"));
    await wrapper.find('[data-action="node-delete-recover"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain("still unavailable");
    expect(session.loading).toBe(false);
    expect(wrapper.find('[data-action="node-delete-recover"]').attributes("disabled")).toBeUndefined();
    const recovered = snapshot(); recovered.graph!.revision = 2;
    invoke.mockResolvedValueOnce(recovered).mockResolvedValue([]);
    await wrapper.find('[data-action="node-delete-recover"]').trigger("click");
    await flushPromises();
    expect(invoke).toHaveBeenCalledWith("session.open", { path: "C:/tmp/s1.jsonl" });
    expect(session.current?.runtime.available).toBe(true);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(session.loading).toBe(false);
  });
});
