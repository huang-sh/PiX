import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import PromptNode from "../../src/renderer/features/graph/PromptNode.vue";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import { desktop } from "../../src/renderer/api";
import { i18n } from "../../src/renderer/i18n";
import { useSessionStore } from "../../src/renderer/stores/session";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";
vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: async () => {}, whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
function snapshot(withUser = false): SessionSnapshot {
  const entries = withUser ? [{ type: "message", id: "user", parentId: null, timestamp: "2026-10-27T00:00:00Z",
    message: { role: "user", content: "remote question" } }] : [];
  return { session: { id: "live", path: "/remote/live.jsonl" }, entries,
    projection: projectSession(entries, withUser ? "user" : null), runtime: { available: true },
    graph: { id: "/remote/live.jsonl", epoch: "live", revision: 1, runs: [] } } as SessionSnapshot;
}
function setup(current = snapshot()) {
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore(); session.applySnapshot(current);
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow: true } } });
  const graph = (wrapper.vm as any).$.setupState;
  return { pinia, session, wrapper, graph };
}
it("shows the sent question before remote admission and replaces it without duplication", async () => {
  const { pinia, session, wrapper, graph } = setup();
  const chat = mount(BranchContextPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow: true } } });
  let finish!: (snapshot: SessionSnapshot) => void;
  let requestId = "";
  const pending = new Promise<SessionSnapshot>(resolve => { finish = resolve; });
  vi.spyOn(desktop, "invoke").mockImplementation(async (_route, input) => {
    requestId = (input as { requestId: string }).requestId;
    return pending;
  });
  try {
    const send = session.promptAt(null, "remote question");
    await nextTick();
    expect(graph.nodes.filter((node: any) => node.type === "prompt").map((node: any) => node.data.node.title)).toEqual(["remote question"]);
    expect(session.focusedNode).toBe(`pending:${requestId}`);
    expect(chat.text()).toContain("remote question");
    const accepted = snapshot();
    accepted.graph!.revision = 2;
    accepted.graph!.runs = [{ branchId: "main", runId: "run", requestId, nodeId: null,
      status: "running", pending: { text: "remote question", parentNodeId: null } }];
    session.applySnapshot(accepted);
    await nextTick();
    expect(graph.nodes.filter((node: any) => node.type === "prompt").map((node: any) => node.id)).toEqual(["pending:run"]);
    expect(graph.nodes.filter((node: any) => node.type === "draft" && node.style?.visibility !== "hidden")).toHaveLength(0);
    expect(session.focusedNode).toBe("pending:run");
    expect(chat.text()).toContain("remote question");
    delete session.pendingPrompts[`pending:${requestId}`]; // The acknowledgement can precede the real user entry.
    await nextTick();
    expect(graph.nodes.filter((node: any) => node.type === "draft" && node.style?.visibility !== "hidden")).toHaveLength(0);
    const newer = snapshot(true);
    newer.graph!.revision = 3;
    newer.graph!.runs = [{ branchId: "main", runId: "run", requestId, nodeId: "turn:user", status: "idle" }];
    session.applySnapshot(newer);
    finish(accepted);
    await send;
    expect(session.pendingPrompt).toBeUndefined();
    expect(session.focusedNode).toBe("turn:user");
  } finally { chat.unmount(); wrapper.unmount(); }
});

it("keeps a submitted branch draft hidden until its reply finishes, even when the real node arrives first", async () => {
  const { session, wrapper, graph } = setup(snapshot(true));
  await graph.compose("turn:user");
  const editor = graph.nodes.find((node: any) => node.type === "draft").data.draftState;
  editor.text = "child question";
  editor.busy = true;
  let requestId = "", finish!: (value: SessionSnapshot) => void;
  const pending = new Promise<SessionSnapshot>(resolve => { finish = resolve; });
  vi.spyOn(desktop, "invoke").mockImplementation(async (_route, input) => {
    requestId = (input as { requestId: string }).requestId;
    return pending;
  });
  try {
    const send = graph.submitDraft("child question");
    await nextTick();
    const next = snapshot(true);
    next.entries = [...next.entries, { type: "message", id: "child", parentId: "user", timestamp: "2026-10-27T00:00:01Z",
      message: { role: "user", content: "child question" } }];
    next.projection = projectSession(next.entries, "child");
    next.graph!.revision = 2;
    next.graph!.runs = [{ branchId: "main", runId: "run", requestId, nodeId: "turn:child", status: "running" }];
    session.applySnapshot(next);
    await nextTick();
    expect(graph.nodes.some((node: any) => node.id === "turn:child")).toBe(true);
    expect(graph.nodes.filter((node: any) => node.type === "draft" && node.style?.visibility !== "hidden")).toHaveLength(0);
    finish(next);
    await send;
    expect(graph.nodes.some((node: any) => node.type === "draft")).toBe(false);
  } finally { wrapper.unmount(); }
});

it.each(["success", "failure"])("preserves a new branch draft when an older send ends in %s", async outcome => {
  const current = snapshot(true);
  current.entries = [...current.entries, { type: "message", id: "other", parentId: "user", timestamp: "2026-10-27T00:00:01Z",
    message: { role: "user", content: "other branch" } }];
  current.projection = projectSession(current.entries, "other");
  const { session, wrapper, graph } = setup(current);
  await graph.compose("turn:user");
  const submitted = graph.nodes.find((node: any) => node.type === "draft").data.draftState;
  submitted.busy = true;
  let requestId = "", finish!: (value: SessionSnapshot) => void, fail!: (error: Error) => void;
  const pending = new Promise<SessionSnapshot>((resolve, reject) => { finish = resolve; fail = reject; });
  vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route !== "agent.control") return {};
    requestId = (input as { requestId: string }).requestId;
    return pending;
  });
  const send = graph.submitDraft("in flight");
  try {
    await graph.compose("turn:other");
    await nextTick();
    const editor = () => graph.nodes.find((node: any) => node.id === "draft:turn:other");
    const draft = editor().data.draftState;
    draft.text = "keep typing here";
    draft.images = [{ type: "image", mimeType: "image/png", data: "new-image" }];
    expect(editor().style.visibility).toBe("visible");
    const accepted = { ...current, graph: { ...current.graph!, revision: 2,
      runs: [{ branchId: "sending", runId: "run", requestId, nodeId: null, status: "running" as const,
        pending: { text: "in flight", parentNodeId: "turn:user" } }],
    } };
    session.applySnapshot(accepted);
    await nextTick();
    expect(editor().style.visibility).toBe("visible");
    if (outcome === "success") finish(accepted);
    else fail(new Error("old send failed"));
    expect(await send).toBe(outcome === "success");
    await nextTick();
    expect(editor().data.draftState).toBe(draft);
    expect(draft.text).toBe("keep typing here");
    expect(draft.images).toEqual([{ type: "image", mimeType: "image/png", data: "new-image" }]);
    expect(editor().style.visibility).toBe("visible");
  } finally { finish(current); await send; wrapper.unmount(); }
});

it("updates a node directly from streamed text without rebuilding the graph", async () => {
  const current = snapshot(true);
  current.graph!.runs = [{ branchId: "main", runId: "run", nodeId: "turn:user", status: "running" }];
  const { pinia, session, wrapper, graph } = setup(current);
  const node = graph.nodes.find((node: any) => node.id === "turn:user");
  const card = mount(PromptNode, { props: { id: node.id, data: node.data }, global: { plugins: [pinia, i18n], stubs: { VueFlow: true, Handle: true } } });
  const nodes = graph.nodes;
  const update = (text: string, runId = "run") => session.onAgentEvent({ type: "message_update",
    graphId: current.graph!.id, branchId: "main", runId, message: { role: "assistant", content: [{ type: "text", text }] } });
  try {
    update("first streamed text"); await nextTick();
    expect(card.text()).toContain("first streamed text");
    update("new streamed text"); await nextTick();
    expect(card.text()).toContain("new streamed text");
    expect(card.text()).not.toContain("first streamed text");
    update("stale run text", "old-run"); await nextTick();
    expect(card.text()).not.toContain("stale run text");
    expect(graph.nodes).toBe(nodes);
  } finally { card.unmount(); wrapper.unmount(); }
});
