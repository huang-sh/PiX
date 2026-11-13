import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useSessionStore } from "../../src/renderer/stores/session";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";

vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: async () => {}, whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
enableAutoUnmount(afterEach);
afterEach(() => vi.restoreAllMocks());

function snapshot(name = "A"): SessionSnapshot {
  const entries = ["root", "other"].map((id, index) => ({ type: "message", id, parentId: index ? "root" : null,
    timestamp: String(index), message: { role: "user", content: id } }));
  return { session: { id: name, path: `${name}.jsonl` }, entries, projection: projectSession(entries, "other"),
    runtime: { available: true }, graph: { id: name, epoch: "one", revision: 1, runs: [] } } as SessionSnapshot;
}
function append(base: SessionSnapshot, parentId: string | null = "root") {
  const entries = [...base.entries, { type: "message", id: "sent", parentId, timestamp: "9", message: { role: "user", content: "sent" } }];
  return { ...base, entries, projection: projectSession(entries, "sent") };
}
function run(requestId: string, nodeId: string | null = null, parentNodeId: string | null = "turn:root"): NonNullable<SessionSnapshot["graph"]>["runs"][number] {
  return { branchId: "branch", runId: "run", requestId, nodeId, status: nodeId ? "idle" : "running",
    ...(nodeId ? {} : { pending: { text: "sent", parentNodeId } }) };
}
function setup() {
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore(); session.applySnapshot(snapshot());
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow: true } } });
  const graph = (wrapper.vm as any).$.setupState;
  const at = (id: string) => graph.nodes.find((node: any) => node.id === id)?.position;
  const move = (id: string, position = { x: 1300, y: 700 }) => graph.rememberDrag({ node: { id, position } });
  return { session, graph, at, move };
}

it.each([false, true])("keeps a moved draft through a direct reply or root pending admission (root: %s)", async root => {
  const { session, graph, at, move } = setup();
  if (root) { session.applySnapshot({ ...snapshot(), entries: [], projection: projectSession([], null) }); await flushPromises(); }
  else await graph.compose("turn:root");
  move(root ? "draft:root" : "draft:turn:root");
  let requestId = "";
  vi.spyOn(session, "promptAt").mockImplementation(async (_parent, _text, _model, _thinking, _images, options) => {
    requestId = options!.requestId!;
    expect(options?.forceFork).not.toBe(true);
    if (!root) { session.applySnapshot(append(session.current!)); return "turn:sent"; }
    session.current!.graph!.runs = [run(requestId, null, null)];
    return "pending:run";
  });
  await graph.submitDraft("sent"); await flushPromises();
  if (root) {
    expect(at("pending:run")).toEqual({ x: 1300, y: 700 });
    move("pending:run", { x: 1450, y: 820 });
    session.applySnapshot({ ...append(session.current!, null), graph: { ...session.current!.graph!, runs: [run(requestId, "turn:sent")] } });
    await flushPromises();
  }
  graph.rebuild();
  expect(at("turn:sent")).toEqual(root ? { x: 1450, y: 820 } : { x: 1300, y: 700 });
});

it("drops a cancelled draft's slot before reopening it", async () => {
  const { graph, at, move } = setup();
  await graph.compose("turn:root");
  const automatic = { ...at("draft:turn:root") };
  move("draft:turn:root"); graph.cancelDraft(); await graph.compose("turn:root");
  expect(at("draft:turn:root")).toEqual(automatic);
});

it("retains the draft and its position when sending fails", async () => {
  const { session, graph, at, move } = setup();
  await graph.compose("turn:root"); move("draft:turn:root"); graph.draftState.text = "retry this";
  vi.spyOn(session, "promptAt").mockRejectedValue(new Error("offline"));
  expect(await graph.submitDraft("retry this")).toBe(false);
  graph.rebuild();
  expect(at("draft:turn:root")).toEqual({ x: 1300, y: 700 });
  expect(graph.draftState.text).toBe("retry this");
});

it("carries optimistic and pending positions through broadcasts before the reply", async () => {
  const { session, graph, at, move } = setup();
  await graph.compose("turn:root"); move("draft:turn:root");
  let finish!: (id: string) => void, requestId = "";
  vi.spyOn(session, "promptAt").mockImplementation(async (_parent, _text, _model, _thinking, _images, options) => {
    requestId = options!.requestId!;
    const id = `pending:${requestId}`;
    session.pendingPrompts[id] = { requestId, projectId: session.activeProjectId, sessionPath: session.current!.session.path,
      targetNodeId: "turn:root", knownEntryIds: ["root", "other"],
      message: { entryId: id, turnId: id, role: "user", text: "sent", timestamp: "9" } };
    return new Promise<string>(resolve => { finish = resolve; });
  });
  const send = graph.submitDraft("sent");
  try {
    await flushPromises();
    expect(at(`pending:${requestId}`)).toEqual({ x: 1300, y: 700 });
    move(`pending:${requestId}`, { x: 1450, y: 820 });
    session.current!.graph!.runs = [run(requestId)]; await flushPromises();
    expect(at("pending:run")).toEqual({ x: 1450, y: 820 });
    session.applySnapshot({ ...append(session.current!), graph: { ...session.current!.graph!, runs: [run(requestId, "turn:sent")] } });
    await flushPromises();
    expect(at("turn:sent")).toEqual({ x: 1450, y: 820 });
    finish("turn:sent"); await send;
    expect(at("turn:sent")).toEqual({ x: 1450, y: 820 });
  } finally { finish("turn:sent"); await send; }
});

it.each([false, true])("keeps a legacy draft's position after sending (root: %s)", async root => {
  const { session, graph, at, move } = setup();
  const base = { ...snapshot(), graph: undefined, ...(root ? { entries: [], projection: projectSession([], null) } : {}) };
  session.applySnapshot(base); await flushPromises();
  if (!root) await graph.compose("turn:root");
  move(root ? "draft:root" : "draft:turn:root");
  vi.spyOn(session, "promptAt").mockImplementation(async () => { session.applySnapshot(append(base, root ? null : "root")); });
  await graph.submitDraft("sent"); await flushPromises();
  expect(at("turn:sent")).toEqual({ x: 1300, y: 700 });
});

it("does not move an existing source returned by a send", async () => {
  const { session, graph, at, move } = setup();
  const source = { ...at("turn:root") };
  await graph.compose("turn:root"); move("draft:turn:root");
  vi.spyOn(session, "promptAt").mockResolvedValue("turn:root");
  await graph.submitDraft("sent"); await flushPromises();
  expect(at("turn:root")).toEqual(source);
});

it("leaves another session's draft alone when an old send finishes", async () => {
  const { session, graph, at, move } = setup();
  await graph.compose("turn:root"); move("draft:turn:root");
  let finish!: (id: string) => void;
  vi.spyOn(session, "promptAt").mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
  const send = graph.submitDraft("old session");
  session.applySnapshot(snapshot("B")); await flushPromises();
  await graph.compose("turn:root"); move("draft:turn:root", { x: 900, y: 500 }); graph.draftState.text = "B";
  finish("turn:sent"); await send; await flushPromises();
  expect(at("draft:turn:root")).toEqual({ x: 900, y: 500 });
  expect(graph.draftState.text).toBe("B");
});

it("does not restore an old slot after tidying during a send", async () => {
  const { session, graph, at, move } = setup();
  await graph.compose("turn:root"); move("draft:turn:root");
  let finish!: () => void;
  vi.spyOn(session, "promptAt").mockImplementation(async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    session.applySnapshot(append(session.current!)); return "turn:sent";
  });
  const send = graph.submitDraft("sent"); await graph.tidy();
  finish(); await send; await flushPromises();
  expect(at("turn:sent")).not.toEqual({ x: 1300, y: 700 });
});

it.each(["optimistic", "pending", "settled"])("keeps the position when returning to a %s session", async stage => {
  const { session, graph, at, move } = setup();
  await graph.compose("turn:root"); move("draft:turn:root");
  let requestId = "", finish!: (id: string) => void;
  vi.spyOn(session, "promptAt").mockImplementation(async (_parent, _text, _model, _thinking, _images, options) => {
    requestId = options!.requestId!;
    if (stage === "optimistic") return new Promise<string>(resolve => { finish = resolve; });
    session.current!.graph!.runs = [run(requestId)]; return "pending:run";
  });
  const send = graph.submitDraft("sent");
  if (stage !== "optimistic") await send;
  await flushPromises();
  const original = session.current!;
  session.applySnapshot(snapshot("B")); await flushPromises();
  const returned = stage === "settled" ? append(original) : original;
  session.applySnapshot({ ...returned, graph: { ...returned.graph!, runs: [run(requestId, stage === "settled" ? "turn:sent" : null)] } });
  await flushPromises();
  if (stage === "optimistic") { finish("pending:run"); await send; }
  expect(at(stage === "settled" ? "turn:sent" : "pending:run")).toEqual({ x: 1300, y: 700 });
});

it("keeps the position when switching before a pending card renders, despite tidying B", async () => {
  const { session, graph, at, move } = setup();
  await graph.compose("turn:root"); move("draft:turn:root");
  const original = session.current!;
  let requestId = "", finish!: (id: string) => void;
  vi.spyOn(session, "promptAt").mockImplementation(async (_parent, _text, _model, _thinking, _images, options) => {
    requestId = options!.requestId!; return new Promise<string>(resolve => { finish = resolve; });
  });
  const send = graph.submitDraft("sent");
  session.applySnapshot(snapshot("B")); await flushPromises(); await graph.tidy();
  session.applySnapshot({ ...original, graph: { ...original.graph!, runs: [run(requestId)] } }); await flushPromises();
  finish("pending:run"); await send;
  expect(at("pending:run")).toEqual({ x: 1300, y: 700 });
});

it("does not move the source when preflight fails while another session is open", async () => {
  const { session, graph, at, move } = setup();
  const original = session.current!, source = { ...at("turn:root") };
  await graph.compose("turn:root"); move("draft:turn:root");
  let requestId = "", reject!: (error: Error) => void;
  vi.spyOn(session, "promptAt").mockImplementation(async (_parent, _text, _model, _thinking, _images, options) => {
    requestId = options!.requestId!;
    session.current!.graph!.runs = [run(requestId)];
    return new Promise<string>((_resolve, fail) => { reject = fail; });
  });
  const send = graph.submitDraft("sent"); await flushPromises();
  session.applySnapshot({ ...snapshot("B"), entries: [], projection: projectSession([], null) }); await flushPromises();
  reject(new Error("preflight failed")); expect(await send).toBe(false);
  session.applySnapshot({ ...original, graph: { ...original.graph!, runs: [{ ...run(requestId, "turn:root"), error: "preflight failed" }] } });
  await flushPromises();
  expect(at("turn:root")).toEqual(source);
  expect(at("pending:run")).toBeUndefined();
});
