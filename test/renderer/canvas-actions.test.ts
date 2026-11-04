import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useCanvasStore } from "../../src/renderer/stores/canvas";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";
import { i18n } from "../../src/renderer/i18n";
import { projectSession, searchGraphNodeIds } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";
import type { CanvasCommand } from "../../src/shared/canvas";

vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: async () => {}, whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
enableAutoUnmount(afterEach);
beforeEach(() => { vi.mocked(window.pix!.invoke).mockReset().mockResolvedValue([]); });
afterEach(() => vi.restoreAllMocks());

async function setup() {
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSessionStore(), layout = useLayoutStore(), canvas = useCanvasStore();
  useWorkspaceStore().project = { name: "project", path: "/project" };
  const entries = [["root", null], ["child", "root"]].map(([id, parentId]) => ({
    type: "message", id: id!, parentId, timestamp: "2026-01-01", message: { role: "user", content: id! },
  }));
  session.applySnapshot({ session: { id: "graph", path: "/project/graph.jsonl" }, entries,
    projection: projectSession(entries, "child"), runtime: { available: true, model: null, thinkingLevel: "off" },
    graph: { id: "graph", epoch: "epoch", revision: 1, runs: [] } } as unknown as SessionSnapshot);
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], stubs: { VueFlow: true, MiniMap: true } } });
  await flushPromises();
  const inspect = () => canvas.execute({ action: "inspect" }) as Promise<any>;
  const initial = await inspect();
  const execute = (command: Omit<CanvasCommand, "context">) => canvas.execute({ ...command, context: initial.context }) as Promise<any>;
  return { session, layout, canvas, wrapper, inspect, execute, initial };
}

it("exposes the actual nodes and opens/edits the same draft used by the human", async () => {
  const { execute, inspect } = await setup();
  expect((await inspect()).nodes.map((node: any) => node.id)).toEqual(["turn:root", "turn:child"]);
  await execute({ action: "compose", nodeId: "turn:root", direction: "up", text: "plan a branch" });
  expect((await inspect()).draft).toMatchObject({ visible: true, parentId: "turn:root", text: "plan a branch" });
  expect((await inspect()).positions.some((node: any) => node.id === "draft:turn:root")).toBe(true);
  expect(window.pix!.invoke).not.toHaveBeenCalledWith("agent.control", expect.objectContaining({ action: "promptAt" }));
  await execute({ action: "draft", text: "revised branch" });
  expect((await inspect()).draft.text).toBe("revised branch");
  const read = await execute({ action: "read", nodeId: "turn:child" });
  expect(read.messages.map((message: any) => message.text)).toContain("child");
  await execute({ action: "cancelDraft" });
  expect((await inspect()).draft.visible).toBe(false);
});

it("submits new sibling branches through promptAt and returns their real node IDs", async () => {
  const { session, execute, inspect } = await setup();
  let sequence = 0;
  vi.mocked(window.pix!.invoke).mockImplementation(async (route, input: any) => {
    if (route !== "agent.control" || input.action !== "promptAt") return [];
    // Electron rejects Vue proxies even when a reactive attachments array is empty.
    structuredClone(input);
    const id = `new${++sequence}`;
    const current = JSON.parse(JSON.stringify(session.current)) as SessionSnapshot;
    current.entries.push({ type: "message", id, parentId: "root", timestamp: "2026-01-02", message: { role: "user", content: input.text } });
    current.projection = projectSession(current.entries, id);
    current.graph!.revision++;
    current.graph!.runs.push({ branchId: id, runId: id, nodeId: `turn:${id}`, requestId: input.requestId, status: "running" });
    return current;
  });
  await execute({ action: "compose", nodeId: "turn:root", direction: "up", text: "first branch" });
  const first = await execute({ action: "submit" });
  expect(first.result).toEqual({ submitted: true, nodeId: "turn:new1" });
  const second = await execute({ action: "send", nodeId: "turn:root", text: "second branch",
    images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] });
  expect(second.result).toEqual({ submitted: true, nodeId: "turn:new2" });
  expect((await inspect()).nodes.filter((node: any) => node.parentId === "turn:root")).toHaveLength(3);
  const calls = vi.mocked(window.pix!.invoke).mock.calls.filter(([route, input]: any) => route === "agent.control" && input.action === "promptAt");
  expect(calls.map(([, input]: any) => input.nodeId)).toEqual(["turn:root", "turn:root"]);
  expect((calls[0]![1] as any).requestId).not.toBe((calls[1]![1] as any).requestId);
  expect((calls[1]![1] as any).images).toEqual([{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }]);
});

it("does not act on stale sessions or invented nodes", async () => {
  const { session, execute } = await setup();
  await expect(execute({ action: "send", nodeId: "made-up", text: "wrong" })).rejects.toThrow("not found");
  session.current!.session.path = "/project/other.jsonl";
  await expect(execute({ action: "delete", nodeId: "turn:root" })).rejects.toThrow("session changed");
  expect(window.pix!.invoke).not.toHaveBeenCalledWith("agent.control", expect.anything());
});

it("routes stop and queued edits to the requested run, not the currently selected branch", async () => {
  const { session, execute } = await setup();
  session.current!.graph!.runs = [
    { branchId: "a", runId: "run-a", nodeId: "turn:root", status: "running" },
    { branchId: "b", runId: "run-b", nodeId: "turn:child", status: "running" },
  ];
  session.focusedNode = "turn:child";
  await execute({ action: "followUp", nodeId: "turn:root", text: "next task" });
  await execute({ action: "editQueued", nodeId: "turn:root", queueId: "queued-a", text: "revised" });
  await execute({ action: "stop", nodeId: "turn:root" });
  expect(window.pix!.invoke).toHaveBeenCalledWith("agent.control", expect.objectContaining({ action: "followUp", branchId: "a", runId: "run-a", graphId: "graph" }));
  expect(window.pix!.invoke).toHaveBeenCalledWith("agent.control", expect.objectContaining({ action: "updateQueuedMessage", id: "queued-a", operation: "edit", branchId: "a" }));
  expect(window.pix!.invoke).toHaveBeenCalledWith("agent.control", { action: "branchAbort", branchId: "a", runId: "run-a" });
});

it("keeps UI restrictions and reports failed mutations instead of claiming success", async () => {
  const { session, execute, inspect } = await setup();
  session.current!.runtime.available = false;
  await expect(execute({ action: "compose", nodeId: "turn:root" })).rejects.toThrow("read-only");
  await expect(execute({ action: "label", nodeId: "turn:root", text: "label" })).rejects.toThrow("read-only");
  session.current!.runtime.available = true;
  vi.mocked(window.pix!.invoke).mockImplementation(async route => {
    if (route === "agent.control") throw new Error("disk unavailable");
    return [];
  });
  await expect(execute({ action: "delete", nodeId: "turn:root" })).rejects.toThrow("disk unavailable");
  expect((await inspect()).totalNodes).toBe(2);
  await expect(execute({ action: "send", nodeId: "turn:root", text: "keep this draft" })).rejects.toThrow("disk unavailable");
  expect((await inspect()).draft).toMatchObject({ visible: true, text: "keep this draft", busy: false });
});

it("controls selection, panels, search, filters and manual layout through the live view", async () => {
  const { session, layout, execute, inspect } = await setup();
  await execute({ action: "highlight", nodeId: "turn:root" });
  expect(session.highlightedNode).toBe("turn:root");
  await execute({ action: "select", nodeId: "turn:child" });
  expect(session.focusedNode).toBe("turn:child");
  await execute({ action: "openPanel", nodeId: "turn:root" });
  expect(layout.chatColumns).toContain("turn:root");
  await execute({ action: "closePanel", nodeId: "turn:root" });
  expect(layout.chatColumns).not.toContain("turn:root");
  // Search runs main-side; mirror it locally so the canvas API behaves as in production.
  vi.mocked(window.pix!.invoke).mockImplementation(((route: string, input: { query?: string }) => {
    const current = route === "session.search" ? useSessionStore().current : null;
    return current ? { nodeIds: searchGraphNodeIds(current.projection, current.entries, String(input.query)) } : [];
  }) as unknown as typeof window.pix!.invoke);
  await execute({ action: "search", text: "child" });
  expect((await inspect()).search.hits).toContain("turn:child");
  await execute({ action: "filter", filter: "errors" });
  expect((await inspect()).filter).toBe("errors");
  await execute({ action: "move", nodeId: "turn:root", x: 1000, y: 600, branch: true });
  expect((await inspect()).positions.find((node: any) => node.id === "turn:root")).toMatchObject({ x: 1000, y: 600 });
  await execute({ action: "tidy" });
  expect((await inspect()).positions.find((node: any) => node.id === "turn:root").x).not.toBe(1000);
});

it("rejects overlapping tool operations and unregisters a destroyed canvas", async () => {
  const { execute, canvas, wrapper } = await setup();
  let finish!: (value: any) => void;
  vi.mocked(window.pix!.invoke).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = execute({ action: "label", nodeId: "turn:root", text: "label" });
  await flushPromises();
  await expect(execute({ action: "delete", nodeId: "turn:root" })).rejects.toThrow("in progress");
  finish({}); await pending;
  wrapper.unmount();
  await expect(canvas.execute({ action: "inspect" })).rejects.toThrow("not available");
});
