import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { h, nextTick } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import { desktop } from "../../src/renderer/api";
import { i18n } from "../../src/renderer/i18n";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";
vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: async () => {}, whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function snapshot(): SessionSnapshot {
  const entries = [["root", null], ["a", "root"], ["b", "root"]].map(([id, parentId], index) => ({
    id: id!, parentId, type: "message", timestamp: String(index), message: { role: "user", content: id! },
  }));
  return { session: { id: "review", path: "review.jsonl" }, entries, projection: projectSession(entries, "b"),
    runtime: { available: true }, graph: { id: "review.jsonl", epoch: "review", revision: 1, runs: [] } } as SessionSnapshot;
}
function setup() {
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore(); session.applySnapshot(snapshot());
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow: true } } });
  return { pinia, session, wrapper, graph: (wrapper.vm as any).$.setupState };
}
function admitted(requestId = ""): SessionSnapshot {
  const result = snapshot();
  result.entries = [...result.entries, { type: "message", id: "sent", parentId: "root", timestamp: "9", message: { role: "user", content: "new upward question" } }];
  result.projection = projectSession(result.entries, "sent");
  result.graph!.revision = 2;
  result.graph!.runs = [{ branchId: "branch", runId: "run", requestId, nodeId: "turn:sent", status: "running" }];
  return result;
}

it.each(["broadcast", "pending", "reply"])("hands a pinned column to its node through %s", async phase => {
  const { pinia, session, wrapper } = setup();
  const layout = useLayoutStore();
  layout.layout.collapsed.chat = false;
  layout.chatColumns = ["turn:root"];
  const panels = mount({ setup: () => () => layout.chatColumns.map(nodeId => h(BranchContextPanel, { key: nodeId, nodeId })) },
    { global: { plugins: [pinia, i18n], stubs: { VueFlow: true } } });
  const panel = panels.getComponent(BranchContextPanel);
  let finish!: (value: SessionSnapshot) => void, requestId = "";
  const pending = new Promise<SessionSnapshot>(resolve => { finish = resolve; });
  vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route !== "agent.control") return {};
    requestId = (input as { requestId: string }).requestId;
    return pending;
  });
  const send = (panel.vm as any).$.setupState.submitComposer("new upward question");
  try {
    await nextTick();
    expect(panels.text()).toContain("new upward question");
    if (phase === "pending") {
      const accepted = snapshot();
      accepted.graph!.runs = [{ branchId: "branch", runId: "run", requestId, nodeId: null, status: "running",
        pending: { text: "new upward question", parentNodeId: "turn:root" } }];
      session.applySnapshot(accepted);
      await nextTick();
      expect(layout.chatColumns).toEqual(["turn:root"]);
      expect(panels.text()).toContain("new upward question");
    }
    if (phase === "reply") { finish(admitted(requestId)); await send; }
    else session.applySnapshot(admitted(requestId));
    await nextTick();
    expect(layout.chatColumns).toEqual(["turn:sent"]);
    expect(panels.text()).toContain("new upward question");
    expect(session.focusedNode).not.toBe("turn:sent");
    finish(admitted(requestId)); await send; await nextTick();
    expect(layout.chatColumns).toEqual(["turn:sent"]);
  } finally { finish(admitted(requestId)); await send; panels.unmount(); wrapper.unmount(); }
});

it("preserves an upward submission's order when another draft opens before its reply", async () => {
  const { session, wrapper, graph } = setup();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(session, "promptAt").mockImplementation(async () => {
    await pending;
    session.applySnapshot(admitted());
    return "turn:sent";
  });
  await graph.compose("turn:root", "up");
  const send = graph.submitDraft("new upward question");
  try {
    await graph.compose("turn:b");
    const draft = graph.nodes.find((node: any) => node.type === "draft").data.draftState;
    draft.text = "keep editing here";
    finish(); await send;
    await nextTick();
    const y = (id: string) => graph.nodes.find((node: any) => node.id === id).position.y;
    expect(y("turn:sent")).toBeLessThan(y("turn:a"));
    expect(graph.nodes.some((node: any) => node.id === "draft:turn:b")).toBe(true);
    expect(draft.text).toBe("keep editing here");
  } finally { finish(); await send; wrapper.unmount(); }
});

it.each(["graph", "closed"])("does not retarget an unrelated or closed pin (%s)", async source => {
  const { session, wrapper } = setup();
  const layout = useLayoutStore();
  layout.chatColumns = ["turn:root"];
  let requestId = "", finish!: (value: SessionSnapshot) => void;
  const pending = new Promise<SessionSnapshot>(resolve => { finish = resolve; });
  vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route !== "agent.control") return {};
    requestId = (input as { requestId: string }).requestId;
    return pending;
  });
  const send = session.promptAt("turn:root", "new upward question", undefined, undefined, undefined,
    source === "closed" ? { follow: false, columnId: "turn:root" } : undefined);
  try {
    if (source === "closed") layout.closeChatColumn("turn:root");
    session.applySnapshot(admitted(requestId));
    expect(layout.chatColumns).toEqual(source === "closed" ? [] : ["turn:root"]);
    finish(admitted(requestId)); await send;
    expect(layout.chatColumns).toEqual(source === "closed" ? [] : ["turn:root"]);
  } finally { finish(admitted(requestId)); await send; wrapper.unmount(); }
});

it("saves each concurrent draft's own order when both replies arrive together", async () => {
  const { session, wrapper, graph } = setup();
  const requests: Array<() => void> = [];
  vi.spyOn(session, "promptAt").mockImplementation(async (parent, text) => {
    await new Promise<void>(resolve => requests.push(resolve));
    const next = snapshot();
    next.entries = [...next.entries, ...[["first", "root"], ["second", "b"]].map(([id, parentId], index) => ({
      type: "message", id: id!, parentId, timestamp: String(index + 5), message: { role: "user", content: id! },
    }))];
    next.projection = projectSession(next.entries, "second");
    session.applySnapshot(next);
    return text === "first" ? "turn:first" : "turn:second";
  });
  await graph.compose("turn:root", "up");
  const first = graph.submitDraft("first");
  await graph.compose("turn:b", "up");
  const second = graph.submitDraft("second");
  try {
    requests.forEach(resolve => resolve());
    await Promise.all([first, second]);
    const orders = Object.values(useLayoutStore().layout.branchOrders!).flat();
    expect(orders).toContainEqual(["turn:first", -1]);
    expect(orders).toContainEqual(["turn:second", -2]);
  } finally { requests.forEach(resolve => resolve()); await Promise.all([first, second]); wrapper.unmount(); }
});

it.each([false, true])("returns its own node after a later run starts (pending reply: %s)", async pendingReply => {
  const { session, wrapper } = setup();
  let finish!: (value: SessionSnapshot) => void, requestId = "";
  const pending = new Promise<SessionSnapshot>(resolve => { finish = resolve; });
  vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route !== "agent.control") return {};
    requestId = (input as { requestId: string }).requestId;
    return pending;
  });
  const send = session.promptAt("turn:root", "new upward question");
  try {
    const ownReply = admitted(requestId);
    session.applySnapshot(ownReply);
    const newer = admitted(requestId);
    newer.entries = [...newer.entries, { type: "message", id: "later", parentId: "sent", timestamp: "10", message: { role: "user", content: "later turn" } }];
    newer.projection = projectSession(newer.entries, "later");
    newer.graph!.revision = 3;
    newer.graph!.runs = [{ branchId: "branch", runId: "later", requestId: "later-request", nodeId: "turn:later", status: "running" }];
    session.applySnapshot(newer);
    session.focusedNode = "turn:later";
    const reply = pendingReply ? snapshot() : ownReply;
    if (pendingReply) reply.graph!.runs = [{ branchId: "branch", runId: "run", requestId, nodeId: null, status: "running",
      pending: { text: "new upward question", parentNodeId: "turn:root" } }];
    finish(reply);
    expect(await send).toBe("turn:sent");
    expect(session.focusedNode).toBe("turn:later");
    expect(session.current?.graph?.revision).toBe(3);
  } finally { finish(admitted(requestId)); await send; wrapper.unmount(); }
});
