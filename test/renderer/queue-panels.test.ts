import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { h } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import { desktop } from "../../src/renderer/api";
import { i18n } from "../../src/renderer/i18n";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useSessionStore } from "../../src/renderer/stores/session";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function setup(pinned: string[]) {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore(), layout = useLayoutStore();
  const entries = [
    { type: "message", id: "root", parentId: null, timestamp: "0", message: { role: "user", content: "history" } },
    { type: "message", id: "answer", parentId: "root", timestamp: "1", message: { role: "assistant", content: "parent answer" } },
    { type: "message", id: "a", parentId: "answer", timestamp: "2", message: { role: "user", content: "branch A" } },
    { type: "message", id: "b", parentId: "answer", timestamp: "3", message: { role: "user", content: "branch B" } },
  ];
  const runtime = { available: true, isStreaming: true, thinkingLevel: "off", model: { provider: "test", id: "test", reasoning: false } };
  session.applySnapshot({ session: { id: "s", path: "/session.jsonl" }, entries, projection: projectSession(entries, "b"), runtime,
    graph: { id: "g", epoch: "epoch", revision: 1, runs: [
      { branchId: "branch-a", runId: "run-a", nodeId: "turn:a", status: "running", runtime: { ...runtime,
        queuedMessages: [{ id: "qa", kind: "followUp", text: "pending A", imageCount: 0 }] } },
      { branchId: "branch-b", runId: "run-b", nodeId: "turn:b", status: "running", runtime: { ...runtime,
        queuedMessages: [{ id: "qb", kind: "followUp", text: "pending B", imageCount: 0 }] } },
    ] } } as SessionSnapshot);
  session.focusedNode = "turn:a";
  layout.layout.collapsed.chat = false;
  layout.chatColumns = pinned;
  const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
  const wrapper = mount({ setup: () => () => [h(BranchContextPanel, { key: "primary" }),
    ...layout.chatColumns.map(nodeId => h(BranchContextPanel, { key: nodeId, nodeId }))] },
  { global: { plugins: [pinia, i18n] } });
  for (const button of wrapper.findAll(".composer-collapsed")) await button.trigger("click");
  await flushPromises();
  invoke.mockClear();
  const panel = (nodeId?: string) => wrapper.findAllComponents(BranchContextPanel).find(item => item.props("nodeId") === nodeId)!;
  return { wrapper, session, layout, invoke, panel };
}

it("routes simultaneous pinned panels independently of the primary panel's selection", async () => {
  const { wrapper, session, invoke, panel } = await setup(["turn:a", "turn:b"]);
  try {
    session.focusedNode = "turn:root";
    await flushPromises();
    const a = panel("turn:a"), b = panel("turn:b");
    expect(a.get(".composer-queue").text()).toContain("pending A");
    expect(a.get(".composer-queue").text()).not.toContain("pending B");
    expect(b.get(".composer-queue").text()).toContain("pending B");
    expect(panel().find(".composer-queue").exists()).toBe(false);
    for (const [view, text] of [[a, "next A"], [b, "next B"]] as const) {
      await view.get(".prompt-composer textarea").setValue(text);
      await view.get(".composer-submit").trigger("click");
      await flushPromises();
    }
    expect(invoke).toHaveBeenCalledWith("agent.control", { action: "followUp", text: "next A", graphId: "g", branchId: "branch-a", runId: "run-a" });
    expect(invoke).toHaveBeenCalledWith("agent.control", { action: "followUp", text: "next B", graphId: "g", branchId: "branch-b", runId: "run-b" });
    await a.get(".composer-queue-edit").trigger("click");
    await a.get(".composer-queue-editor textarea").setValue("edited A");
    await a.get(".composer-queue-editor").trigger("submit");
    await flushPromises();
    expect(invoke).toHaveBeenLastCalledWith("agent.control", { action: "updateQueuedMessage", id: "qa", operation: "edit", text: "edited A", graphId: "g", branchId: "branch-a", runId: "run-a" });
    await b.get(".composer-queue-steer").trigger("click"); await flushPromises();
    expect(invoke).toHaveBeenLastCalledWith("agent.control", { action: "updateQueuedMessage", id: "qb", operation: "steer", graphId: "g", branchId: "branch-b", runId: "run-b" });
    await a.get(".composer-queue-remove").trigger("click"); await flushPromises();
    expect(invoke).toHaveBeenLastCalledWith("agent.control", { action: "updateQueuedMessage", id: "qa", operation: "remove", graphId: "g", branchId: "branch-a", runId: "run-a" });
    await b.get(".composer-stop").trigger("click"); await flushPromises();
    expect(invoke).toHaveBeenLastCalledWith("agent.control", { action: "branchAbort", branchId: "branch-b", runId: "run-b" });
    expect(session.focusedNode).toBe("turn:root");
  } finally { wrapper.unmount(); }
});

it("shows one shared branch queue in multiple panels while retaining separate drafts", async () => {
  const { wrapper, session, invoke, panel } = await setup(["turn:a"]);
  try {
    const primary = panel(), pinned = panel("turn:a");
    await primary.get(".prompt-composer textarea").setValue("primary draft");
    await pinned.get(".prompt-composer textarea").setValue("pinned draft");
    await primary.get(".composer-queue-edit").trigger("click");
    await primary.get(".composer-queue-editor textarea").setValue("shared edited A");
    await primary.get(".composer-queue-editor").trigger("submit"); await flushPromises();
    session.current!.graph!.runs[0]!.runtime!.queuedMessages![0]!.text = "shared edited A";
    await flushPromises();
    for (const view of [primary, pinned]) expect(view.get(".composer-queue").text()).toContain("shared edited A");
    expect(primary.get<HTMLTextAreaElement>(".prompt-composer textarea").element.value).toBe("primary draft");
    expect(pinned.get<HTMLTextAreaElement>(".prompt-composer textarea").element.value).toBe("pinned draft");
    session.focusedNode = "turn:b"; await flushPromises();
    expect(primary.get(".composer-queue").text()).toContain("pending B");
    expect(pinned.get(".composer-queue").text()).toContain("shared edited A");
    await pinned.get(".composer-stop").trigger("click"); await flushPromises();
    expect(invoke).toHaveBeenLastCalledWith("agent.control", { action: "branchAbort", branchId: "branch-a", runId: "run-a" });
  } finally { wrapper.unmount(); }
});

it("sends from an idle historical panel normally while another panel has a running queue", async () => {
  const { wrapper, invoke, panel } = await setup(["turn:root"]);
  try {
    expect(panel().get(".composer-queue").text()).toContain("pending A");
    const history = panel("turn:root");
    expect(history.find(".composer-queue").exists()).toBe(false);
    expect(history.find(".composer-stop").exists()).toBe(false);
    await history.get(".prompt-composer textarea").setValue("new branch from history");
    await history.get(".composer-submit").trigger("click"); await flushPromises();
    expect(invoke).toHaveBeenCalledWith("agent.control", expect.objectContaining({ action: "promptAt", nodeId: "turn:root", text: "new branch from history" }));
    expect(invoke.mock.calls.some(([, input]) => (input as { action?: string }).action === "followUp")).toBe(false);
    expect(panel().get(".composer-queue").text()).toContain("pending A");
  } finally { wrapper.unmount(); }
});
