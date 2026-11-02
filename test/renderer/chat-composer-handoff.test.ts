import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { h, nextTick, watch } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import { desktop } from "../../src/renderer/api";
import { i18n } from "../../src/renderer/i18n";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function snapshot(): SessionSnapshot {
  const entries = [
    { type: "message", id: "root", parentId: null, timestamp: "0", message: { role: "user", content: "parent" } },
    { type: "message", id: "answer", parentId: "root", timestamp: "1", message: { role: "assistant", content: "answer", stopReason: "stop" } },
  ];
  return { session: { id: "review", path: "review.jsonl" }, entries,
    projection: projectSession(entries, "answer"),
    runtime: { available: true, model: { provider: "test", id: "vision", input: ["text", "image"] } },
    graph: { id: "review.jsonl", epoch: "review", revision: 1, runs: [] } } as SessionSnapshot;
}

it.each(["before progress", "before rejection", "after rejection"].flatMap(phase =>
  [false, true].map(reopenParent => ({ phase, reopenParent }))))(
  "restores text and attachments after $phase (reopen parent: $reopenParent)", async ({ phase, reopenParent }) => {
    const pinia = createPinia(); setActivePinia(pinia);
    const session = useSessionStore(), layout = useLayoutStore();
    session.applySnapshot(snapshot());
    layout.chatColumns = ["turn:root"];
    layout.layout.collapsed.chat = false;
    let requestId = "", fail!: (error: Error) => void;
    const pending = new Promise<SessionSnapshot>((_resolve, reject) => { fail = reject; });
    vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
      if (route === "agent.control" && (input as { action?: string }).action === "promptAt") {
        requestId = (input as { requestId: string }).requestId;
        return pending;
      }
      return [];
    });
    // Match Workbench's keyed columns: each handoff replaces the whole panel.
    const wrapper = mount({ setup: () => () => layout.chatColumns.map(nodeId => h(BranchContextPanel, { key: nodeId, nodeId })) },
      { global: { plugins: [pinia, i18n] } });
    try {
      await wrapper.get(".composer-collapsed").trigger("click");
      await wrapper.get("textarea").setValue("keep this failed question");
      const image = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "paste.png", { type: "image/png" });
      const document = new File(["notes"], "notes.txt", { type: "text/plain" });
      Object.defineProperty(document, "path", { value: "/tmp/notes.txt" });
      await wrapper.get("textarea").trigger("paste", { clipboardData: { files: [image, document] } });
      await vi.waitFor(() => expect(wrapper.findAll(".composer-images img")).toHaveLength(1));
      expect(wrapper.text()).toContain("notes.txt");
      const imageUrl = wrapper.get(".composer-images img").attributes("src");
      await wrapper.get(".composer-submit").trigger("click");
      expect(requestId).not.toBe("");

      if (phase !== "before progress") {
        const accepted = snapshot();
        accepted.graph!.revision = 2;
        accepted.graph!.runs = [{ branchId: "branch", runId: "run", requestId, nodeId: null, status: "running",
          pending: { text: "keep this failed question", parentNodeId: "turn:root" } }];
        session.applySnapshot(accepted);
        layout.trackChatColumns(new Set(accepted.projection.nodes.map(node => node.id)), accepted.graph!.runs);
        await nextTick();
        if (reopenParent) {
          await layout.openChatColumn("turn:root");
          await nextTick();
          const parent = wrapper.findAllComponents(BranchContextPanel).find(panel => panel.props("nodeId") === "turn:root");
          if (parent?.find(".composer-collapsed").exists()) await parent.get(".composer-collapsed").trigger("click");
        }
        expect(layout.chatColumns).toEqual(["turn:root"]);
        expect(wrapper.text()).toContain("keep this failed question");
        expect(wrapper.get(".composer-submit").attributes("aria-label")).toBe("Stop generating");
      }
      const failed = snapshot();
      failed.graph!.revision = 3;
      failed.graph!.runs = [{ branchId: "branch", runId: "run", requestId, nodeId: null, status: "interrupted", error: "model setup failed" }];
      if (phase !== "after rejection") {
        session.applySnapshot(failed);
        await nextTick();
      }
      fail(new Error("model setup failed"));
      await flushPromises();
      if (phase === "after rejection") {
        session.applySnapshot(failed);
        layout.trackChatColumns(new Set(failed.projection.nodes.map(node => node.id)), failed.graph!.runs);
        await nextTick();
      }
      expect(layout.chatColumns).toEqual(["turn:root"]);
      expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("keep this failed question");
      expect(wrapper.get("textarea").attributes("disabled")).toBeUndefined();
      expect(wrapper.get(".composer-images img").attributes("src")).toBe(imageUrl);
      expect(wrapper.text()).toContain("notes.txt");
      expect(layout.notice?.message).toBe("model setup failed");
    } finally { fail(new Error("cleanup")); await flushPromises(); wrapper.unmount(); }
  },
);

it.each([false, true])("follows a successful send without changing another draft (pending admission reply: %s)", async pendingReply => {
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore(), layout = useLayoutStore();
  const original = snapshot();
  original.entries.push({ type: "message", id: "other", parentId: "answer", timestamp: "2", message: { role: "user", content: "another branch" } });
  original.projection = projectSession(original.entries, "other");
  session.applySnapshot(original);
  layout.chatColumns = ["turn:root", "turn:other"];
  layout.layout.collapsed.chat = false;
  // Workbench tracks a pin introduced by a reply even if no new snapshot follows it.
  const stopTracking = watch([() => session.current?.projection.nodes, () => session.current?.graph?.runs, () => layout.chatColumns], () => {
    layout.trackChatColumns(new Set(session.current!.projection.nodes.map(node => node.id)), session.current!.graph!.runs);
  });
  let requestId = "", finish!: (value: SessionSnapshot) => void;
  const pending = new Promise<SessionSnapshot>(resolve => { finish = resolve; });
  vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route === "agent.control" && (input as { action?: string }).action === "promptAt") {
      requestId = (input as { requestId: string }).requestId;
      return pending;
    }
    return [];
  });
  const wrapper = mount({ setup: () => () => layout.chatColumns.map(nodeId => h(BranchContextPanel, { key: nodeId, nodeId })) },
    { global: { plugins: [pinia, i18n] } });
  try {
    for (const button of wrapper.findAll(".composer-collapsed")) await button.trigger("click");
    await wrapper.findAll("textarea")[0]!.setValue("sent question");
    await wrapper.findAll("textarea")[1]!.setValue("keep editing here");
    await wrapper.findAll(".composer-submit")[0]!.trigger("click");
    const accepted = structuredClone(original);
    accepted.graph!.revision = 2;
    accepted.graph!.runs = [{ branchId: "branch", runId: "run", requestId, nodeId: null, status: "running",
      pending: { text: "sent question", parentNodeId: "turn:root" } }];
    session.applySnapshot(accepted);
    await nextTick();
    expect(layout.chatColumns).toEqual(["turn:root", "turn:other"]);
    expect(wrapper.findAll("textarea")[0]!.attributes("disabled")).toBeDefined();
    await layout.openChatColumn("turn:root");
    expect(layout.chatColumns).toEqual(["turn:root", "turn:other"]);
    expect(layout.notice).toBeUndefined();
    if (pendingReply) {
      finish(accepted);
      await flushPromises();
      expect(layout.chatColumns).toEqual(["pending:run", "turn:other"]);
      expect(layout.chatColumnParents["pending:run"]).toBe("turn:root");
      expect(wrapper.findAllComponents(BranchContextPanel)[0]!.text()).toContain("sent question");
      expect(wrapper.findAll(".composer-submit")[0]!.attributes("aria-label")).toBe("Stop generating");
    }

    const admitted = structuredClone(original);
    admitted.entries.push({ type: "message", id: "sent", parentId: "answer", timestamp: "3", message: { role: "user", content: "sent question" } });
    admitted.projection = projectSession(admitted.entries, "sent");
    admitted.graph!.revision = 3;
    admitted.graph!.runs = [{ branchId: "branch", runId: "run", requestId, nodeId: "turn:sent", status: "idle" }];
    session.applySnapshot(admitted);
    await nextTick();
    finish(admitted);
    await flushPromises();
    expect(layout.chatColumns).toEqual(["turn:sent", "turn:other"]);
    expect(wrapper.findAll<HTMLTextAreaElement>("textarea").map(editor => editor.element.value)).toEqual(["", "keep editing here"]);
    expect(wrapper.findAll("textarea")[0]!.attributes("disabled")).toBeUndefined();
    expect(Object.keys(layout.chatColumnComposers).sort()).toEqual(["turn:other", "turn:sent"]);
    layout.closeChatColumn("turn:sent");
    expect(Object.keys(layout.chatColumnComposers)).toEqual(["turn:other"]);
    layout.clearChatColumns();
    expect(layout.chatColumnComposers).toEqual({});
  } finally { finish(original); await flushPromises(); stopTracking(); wrapper.unmount(); }
});

it.each(["pending reply", "real node", "failure"])("leaves a closed-and-reopened column's new draft alone after an old %s", async outcome => {
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore(), layout = useLayoutStore();
  session.applySnapshot(snapshot());
  layout.chatColumns = ["turn:root"];
  layout.layout.collapsed.chat = false;
  let requestId = "", finish!: (value: SessionSnapshot) => void, fail!: (error: Error) => void;
  const pending = new Promise<SessionSnapshot>((resolve, reject) => { finish = resolve; fail = reject; });
  vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route === "agent.control" && (input as { action?: string }).action === "promptAt") {
      requestId = (input as { requestId: string }).requestId;
      return pending;
    }
    return [];
  });
  const wrapper = mount({ setup: () => () => layout.chatColumns.map(nodeId => h(BranchContextPanel, { key: nodeId, nodeId })) },
    { global: { plugins: [pinia, i18n] } });
  try {
    await wrapper.get(".composer-collapsed").trigger("click");
    await wrapper.get("textarea").setValue("old submitted question");
    await wrapper.get(".composer-submit").trigger("click");
    layout.closeChatColumn("turn:root");
    await nextTick();
    await layout.openChatColumn("turn:root");
    await nextTick();
    await wrapper.get(".composer-collapsed").trigger("click");
    await wrapper.get("textarea").setValue("new unsent question");
    const accepted = snapshot();
    accepted.graph!.revision = 2;
    accepted.graph!.runs = [{ branchId: "branch", runId: "run", requestId, nodeId: null, status: "running",
      pending: { text: "old submitted question", parentNodeId: "turn:root" } }];
    session.applySnapshot(accepted);
    await nextTick();
    expect(wrapper.get("textarea").attributes("disabled")).toBeUndefined();
    expect(wrapper.get(".composer-submit").attributes("aria-label")).toContain("Enter to send");
    if (outcome === "failure") {
      const failed = snapshot();
      failed.graph!.revision = 3;
      failed.graph!.runs = [{ branchId: "branch", runId: "run", requestId, nodeId: null, status: "interrupted" }];
      session.applySnapshot(failed);
      fail(new Error("initialization failed"));
    } else {
      const admitted = snapshot();
      admitted.entries.push({ type: "message", id: "sent", parentId: "answer", timestamp: "3", message: { role: "user", content: "old submitted question" } });
      admitted.projection = projectSession(admitted.entries, "sent");
      admitted.graph!.revision = 3;
      admitted.graph!.runs = [{ branchId: "branch", runId: "run", requestId, nodeId: "turn:sent", status: "idle" }];
      if (outcome === "real node") session.applySnapshot(admitted);
      finish(outcome === "pending reply" ? accepted : admitted);
      await flushPromises();
      session.applySnapshot(admitted);
    }
    await flushPromises();
    expect(layout.chatColumns).toEqual(["turn:root"]);
    expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("new unsent question");
    expect(wrapper.get("textarea").attributes("disabled")).toBeUndefined();
  } finally { finish(snapshot()); await flushPromises(); wrapper.unmount(); }
});
