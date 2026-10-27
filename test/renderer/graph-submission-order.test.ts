import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { desktop } from "../../src/renderer/api";
import { i18n } from "../../src/renderer/i18n";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useSessionStore } from "../../src/renderer/stores/session";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";

vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: async () => {}, whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
enableAutoUnmount(afterEach);
afterEach(() => vi.restoreAllMocks());

function snapshot(): SessionSnapshot {
  const entries = [["root", null], ["a", "root"], ["b", "root"], ["c", "b"]]
    .map(([id, parentId], index) => ({ type: "message", id: id!, parentId, timestamp: String(index),
      message: { role: "user", content: id! } }));
  return { session: { id: "order", path: "order.jsonl" }, entries, projection: projectSession(entries, "c"),
    runtime: { available: true }, graph: { id: "order.jsonl", epoch: "one", revision: 1, runs: [] } } as SessionSnapshot;
}

function setup() {
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore(); session.applySnapshot(snapshot());
  const requests: Array<{ requestId: string; finish: (value: SessionSnapshot) => void; fail: (error: Error) => void }> = [];
  vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route === "agent.control" && (input as { action: string }).action === "promptAt") {
      const { requestId } = input as { requestId: string };
      return new Promise<SessionSnapshot>((finish, fail) => requests.push({ requestId, finish, fail }));
    }
    return [];
  });
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow: true } } });
  const graph = (wrapper.vm as any).$.setupState;
  const y = (id: string): number => graph.nodes.find((node: any) => node.id === id).position.y;
  return { graph, session, requests, y };
}

it.each((["up", "down"] as const).flatMap(direction =>
  [false, true].map(initializing => ({ direction, initializing }))))(
  "preserves a $direction submission before its reply (initializing broadcast: $initializing)", async ({ direction, initializing }) => {
  const { graph, session, requests, y } = setup();
  await graph.compose("turn:root", direction);
  graph.draftState.busy = true;
  const send = graph.submitDraft("new question");
  const check = (id: string) => direction === "up"
    ? expect(y(id)).toBeLessThan(y("turn:a")) : expect(y(id)).toBeGreaterThan(y("turn:b"));
  try {
    await flushPromises();
    check(`pending:${requests[0]!.requestId}`);
    // Opening another composer must not change the in-flight submission's order.
    await graph.compose("turn:b");
    await flushPromises();
    check(`pending:${requests[0]!.requestId}`);
    const preparing = snapshot();
    preparing.graph!.revision = 2;
    preparing.graph!.runs = [{ branchId: "new", runId: "run", requestId: requests[0]!.requestId,
      nodeId: null, status: "running", pending: { text: "new question", parentNodeId: "turn:root" } }];
    if (initializing) {
      session.applySnapshot(preparing);
      await flushPromises();
      check("pending:run");
    }
    const admitted = snapshot();
    admitted.entries = [...admitted.entries, { type: "message", id: "new", parentId: "root", timestamp: "9",
      message: { role: "user", content: "new question" } }];
    admitted.projection = projectSession(admitted.entries, "new");
    admitted.graph!.revision = 3;
    admitted.graph!.runs = [{ branchId: "new", runId: "run", requestId: requests[0]!.requestId,
      nodeId: "turn:new", status: "running" }];
    session.applySnapshot(admitted);
    await flushPromises();
    check("turn:new");
    requests[0]!.finish(preparing); await send;
    await flushPromises();
    check("turn:new");
    expect(graph.nodes.some((node: any) => node.id === "draft:turn:b")).toBe(true);
    if (direction === "up") {
      const orders = Object.values(useLayoutStore().layout.branchOrders!).flat();
      expect(orders).toContainEqual(["turn:new", -1]);
      expect(orders.some(([id]) => id.startsWith("pending:"))).toBe(false);
    }
  } finally { requests.forEach(request => request.finish(session.current!)); await send; }
});

it("keeps concurrent upward submissions in their own lanes before either reply arrives", async () => {
  const { graph, session, requests, y } = setup();
  await graph.compose("turn:root", "up");
  graph.draftState.busy = true;
  const first = graph.submitDraft("first question");
  await graph.compose("turn:b", "up");
  graph.draftState.busy = true;
  const second = graph.submitDraft("second question");
  try {
    await flushPromises();
    expect(y(`pending:${requests[0]!.requestId}`)).toBeLessThan(y("turn:a"));
    expect(y(`pending:${requests[1]!.requestId}`)).toBeLessThan(y("turn:c"));
    const preparing = snapshot();
    preparing.graph!.revision = 2;
    preparing.graph!.runs = requests.map((request, index) => ({ branchId: `branch${index}`, runId: `run${index}`,
      requestId: request.requestId, nodeId: null, status: "running",
      pending: { text: index ? "second question" : "first question", parentNodeId: index ? "turn:b" : "turn:root" } }));
    session.applySnapshot(preparing);
    await flushPromises();
    expect(y("pending:run0")).toBeLessThan(y("turn:a"));
    expect(y("pending:run1")).toBeLessThan(y("turn:c"));
    const admitted = snapshot();
    admitted.entries = [...admitted.entries, ...[["first", "root"], ["second", "b"]].map(([id, parentId], index) => ({
      type: "message", id: id!, parentId, timestamp: String(index + 5), message: { role: "user", content: id! },
    }))];
    admitted.projection = projectSession(admitted.entries, "second");
    admitted.graph!.revision = 3;
    admitted.graph!.runs = preparing.graph!.runs.map((run, index) => ({ ...run, pending: undefined, nodeId: index ? "turn:second" : "turn:first" }));
    session.applySnapshot(admitted);
    await flushPromises();
    expect(y("turn:first")).toBeLessThan(y("turn:a"));
    expect(y("turn:second")).toBeLessThan(y("turn:c"));
    requests[1]!.finish(admitted); await second;
    requests[0]!.finish(preparing); await first;
    const orders = Object.values(useLayoutStore().layout.branchOrders!).flat();
    expect(orders).toContainEqual(["turn:first", -1]);
    expect(orders).toContainEqual(["turn:second", -2]);
    expect(orders.some(([id]) => id.startsWith("pending:"))).toBe(false);
  } finally { requests.forEach(request => request.finish(session.current!)); await Promise.all([first, second]); }
});

it.each([false, true])("removes a rejected submission's temporary order without changing the open draft (initialized: %s)", async initialized => {
  const { graph, session, requests } = setup();
  await graph.compose("turn:root", "up");
  const send = graph.submitDraft("rejected question");
  await graph.compose("turn:b", "up");
  const draft = graph.draftState;
  draft.text = "keep editing here";
  try {
    if (initialized) {
      const preparing = snapshot();
      preparing.graph!.revision = 2;
      preparing.graph!.runs = [{ branchId: "new", runId: "run", requestId: requests[0]!.requestId,
        nodeId: null, status: "running", pending: { text: "rejected question", parentNodeId: "turn:root" } }];
      session.applySnapshot(preparing);
      await flushPromises();
      session.applySnapshot({ ...preparing, graph: { ...preparing.graph!, revision: 3,
        runs: [{ ...preparing.graph!.runs[0]!, pending: undefined, status: "interrupted" }] } });
      await flushPromises();
    }
    requests[0]!.fail(new Error("admission failed"));
    expect(await send).toBe(false);
    await flushPromises();
    expect(Object.values(useLayoutStore().layout.branchOrders!).flat()).toEqual([]);
    expect(graph.draftState).toBe(draft);
    expect(draft.text).toBe("keep editing here");
  } finally { requests.forEach(request => request.finish(session.current!)); await send; }
});
