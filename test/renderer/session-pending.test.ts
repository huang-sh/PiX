import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { desktop } from "../../src/renderer/api";
import { i18n } from "../../src/renderer/i18n";
import { useSessionStore } from "../../src/renderer/stores/session";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";

vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: async () => {}, whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
afterEach(() => vi.restoreAllMocks());

function snapshot(path = "a.jsonl", empty = false): SessionSnapshot {
  const entries = empty ? [] : [{ type: "message", id: "root", parentId: null, timestamp: "0", message: { role: "user", content: "existing" } }];
  return { session: { id: path, path }, entries, projection: projectSession(entries, empty ? null : "root"),
    runtime: { available: true }, graph: { id: path, epoch: path, revision: 1, runs: [] } } as SessionSnapshot;
}
function setup() {
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore(); session.applySnapshot(snapshot());
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow: true } } });
  const graph = (wrapper.vm as any).$.setupState;
  return { session, wrapper, graph };
}

it("retains both optimistic nodes and chat contents when two sends await remote admission", async () => {
  const { session, wrapper, graph } = setup();
  const requests: Array<{ requestId: string; finish: (value: SessionSnapshot) => void }> = [];
  vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route !== "agent.control") return {};
    return new Promise<SessionSnapshot>(finish => requests.push({ requestId: (input as { requestId: string }).requestId, finish }));
  });
  const first = session.promptAt("turn:root", "first pending question");
  await nextTick();
  const firstId = `pending:${requests[0]!.requestId}`;
  expect(session.messageWindowFor(firstId, 20).messages.at(-1)?.text).toBe("first pending question");
  const second = session.promptAt("turn:root", "second pending question");
  try {
    await nextTick();
    const titles = graph.nodes.filter((node: any) => node.type === "prompt").map((node: any) => node.data.node.title);
    expect.soft(titles).toContain("first pending question");
    expect.soft(titles).toContain("second pending question");
    expect.soft(session.messageWindowFor(firstId, 20).messages.at(-1)?.text).toBe("first pending question");
  } finally { requests.forEach(request => request.finish(snapshot())); await Promise.all([first, second]); wrapper.unmount(); }
});

it.each([false, true])("keeps another session's pending node out of a new view (empty: %s)", async empty => {
  const { session, wrapper, graph } = setup();
  let finish!: (value: SessionSnapshot) => void;
  const pending = new Promise<SessionSnapshot>(resolve => { finish = resolve; });
  vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route === "agent.control" && (input as { action?: string }).action === "promptAt") return pending;
    if (route === "session.open") return snapshot((input as { path: string }).path, empty && (input as { path: string }).path === "b.jsonl");
    return [];
  });
  const send = session.promptAt("turn:root", "private to session A");
  try {
    await session.open("b.jsonl");
    await nextTick();
    expect(session.current?.session.path).toBe("b.jsonl");
    expect(graph.nodes.filter((node: any) => node.type === "prompt").map((node: any) => node.data.node.title))
      .not.toContain("private to session A");
    expect(session.messageWindowFor("turn:root", 20).messages.some(message => message.text === "private to session A")).toBe(false);
    if (empty) expect(graph.nodes.find((node: any) => node.type === "draft").style.visibility).toBe("visible");
    await session.open("a.jsonl");
    await nextTick();
    expect(graph.nodes.filter((node: any) => node.type === "prompt").map((node: any) => node.data.node.title))
      .toContain("private to session A");
  } finally { finish(snapshot()); await send; wrapper.unmount(); }
});

it("isolates pending input when two projects use the same session path", async () => {
  const { session, wrapper, graph } = setup();
  let finish!: (value: SessionSnapshot) => void;
  const pending = new Promise<SessionSnapshot>(resolve => { finish = resolve; });
  vi.spyOn(desktop, "invoke").mockReturnValue(pending);
  const send = session.promptAt("turn:root", "only in project A");
  try {
    session.hydrate({ name: "other", path: "/other" }, [], [], snapshot());
    await nextTick();
    expect(session.currentPendingPrompts).toHaveLength(0);
    expect(graph.nodes.some((node: any) => node.data.node?.title === "only in project A")).toBe(false);
    session.hydrate(null, [], [], snapshot());
    await nextTick();
    expect(graph.nodes.some((node: any) => node.data.node?.title === "only in project A")).toBe(true);
  } finally { finish(snapshot()); await send; wrapper.unmount(); }
});

it("reconciles overlapping sends individually and keeps the latest focus after out-of-order replies", async () => {
  const { session, wrapper, graph } = setup();
  const requests: Array<{ requestId: string; finish: (value: SessionSnapshot) => void }> = [];
  vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route !== "agent.control") return {};
    return new Promise<SessionSnapshot>(finish => requests.push({ requestId: (input as { requestId: string }).requestId, finish }));
  });
  const first = session.promptAt("turn:root", "first question"), second = session.promptAt("turn:root", "second question");
  const accepted = snapshot();
  accepted.graph!.revision = 2;
  accepted.graph!.runs = requests.map(({ requestId }, index) => ({ branchId: `branch${index}`, runId: `run${index}`, requestId,
    nodeId: null, status: "running", pending: { text: index ? "second question" : "first question", parentNodeId: "turn:root" } }));
  try {
    session.applySnapshot(accepted);
    await nextTick();
    expect(session.focusedNode).toBe("pending:run1");
    expect(graph.nodes.filter((node: any) => node.type === "prompt").map((node: any) => node.id))
      .toEqual(["turn:root", "pending:run0", "pending:run1"]);
    requests[1]!.finish(accepted); await second;
    expect(session.currentPendingPrompts.map(pending => pending.message.text)).toEqual(["first question"]);
    const newer = snapshot();
    newer.entries = [...newer.entries, { type: "message", id: "first", parentId: "root", timestamp: "1", message: { role: "user", content: "first question" } }];
    newer.projection = projectSession(newer.entries, "first");
    newer.graph!.revision = 3;
    newer.graph!.runs = [{ ...accepted.graph!.runs[0]!, nodeId: "turn:first", pending: undefined }, accepted.graph!.runs[1]!];
    session.applySnapshot(newer);
    requests[0]!.finish(accepted); await first;
    await nextTick();
    expect(session.focusedNode).toBe("pending:run1");
    expect(session.currentPendingPrompts).toHaveLength(0);
    expect(graph.nodes.filter((node: any) => node.data.node?.title === "first question")).toHaveLength(1);
    expect(session.messageWindowFor("pending:run1", 20).messages.at(-1)?.text).toBe("second question");
  } finally { requests.forEach(request => request.finish(snapshot())); await Promise.all([first, second]); wrapper.unmount(); }
});

it.each([0, 1])("removes only a failed send while the other still awaits admission (failed: %s)", async failed => {
  const { session, wrapper, graph } = setup();
  const requests: Array<{ finish: (value: SessionSnapshot) => void; fail: (error: Error) => void }> = [];
  vi.spyOn(desktop, "invoke").mockImplementation(async (route) => {
    if (route !== "agent.control") return {};
    return new Promise<SessionSnapshot>((finish, fail) => requests.push({ finish, fail }));
  });
  const sends = ["first", "second"].map(text => session.promptAt("turn:root", text).catch(() => undefined));
  try {
    requests[failed]!.fail(new Error("send failed")); await sends[failed];
    await nextTick();
    expect(session.currentPendingPrompts.map(pending => pending.message.text)).toEqual([failed ? "first" : "second"]);
    expect(graph.nodes.filter((node: any) => node.id.startsWith("pending:")).map((node: any) => node.data.node.title)).toEqual([failed ? "first" : "second"]);
  } finally { requests.forEach(request => request.finish(snapshot())); await Promise.all(sends); wrapper.unmount(); }
});

it.each([false, true])("adopts a returning session's reply only for the same runtime (replaced: %s)", async replaced => {
  const { session, wrapper, graph } = setup();
  let finish!: (value: SessionSnapshot) => void;
  const pending = new Promise<SessionSnapshot>(resolve => { finish = resolve; });
  let requestId = "";
  vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route === "agent.control" && (input as { action?: string }).action === "promptAt") {
      requestId = (input as { requestId: string }).requestId;
      return pending;
    }
    if (route === "session.open") return snapshot((input as { path: string }).path);
    return [];
  });
  const send = session.promptAt("turn:root", "sent before switching");
  try {
    await session.open("b.jsonl");
    await session.open("a.jsonl");
    if (replaced) {
      const replacement = snapshot();
      replacement.graph!.epoch = "replacement";
      session.applySnapshot(replacement);
    }
    const admitted = snapshot();
    admitted.entries = [...admitted.entries, { type: "message", id: "sent", parentId: "root", timestamp: "1", message: { role: "user", content: "sent before switching" } }];
    admitted.projection = projectSession(admitted.entries, "sent");
    admitted.graph!.revision = 2;
    admitted.graph!.runs = [{ branchId: "main", runId: "run", requestId, nodeId: "turn:sent", status: "running" }];
    finish(admitted); await send;
    await nextTick();
    expect(graph.nodes.some((node: any) => node.id === "turn:sent")).toBe(!replaced);
    expect(session.current?.graph?.epoch).toBe(replaced ? "replacement" : "a.jsonl");
    expect(session.focusedNode).toBe("turn:root");
    expect(session.currentPendingPrompts).toHaveLength(0);
  } finally { finish(snapshot()); await send; wrapper.unmount(); }
});
