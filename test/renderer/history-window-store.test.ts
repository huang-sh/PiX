import { createPinia, setActivePinia } from "pinia";
import { flushPromises } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { desktop } from "../../src/renderer/api";
import { useSessionStore } from "../../src/renderer/stores/session";
import { projectSession, promptRecall, windowEntries } from "../../src/shared/session";
import { validateRouteInput } from "../../src/shared/contracts";
import type { RawSessionEntry, SessionSnapshot } from "../../src/shared/types";

function setup(count: number, pageCap = 500, answerBytes = 0) {
  setActivePinia(createPinia());
  const entries: RawSessionEntry[] = [];
  const answer = "x".repeat(answerBytes);
  for (let i = 0; i < count; i++) {
    entries.push({ type: "message", id: `u${i}`, parentId: i ? `a${i - 1}` : null, timestamp: String(i).padStart(5, "0"),
      message: { role: "user", content: `prompt ${i}` } });
    entries.push({ type: "message", id: `a${i}`, parentId: `u${i}`, timestamp: String(i).padStart(5, "0"),
      message: { role: "assistant", content: answer || `answer ${i}` } });
  }
  const leaf = entries.at(-1)!.id;
  const store = useSessionStore();
  const window = windowEntries(entries, leaf, Math.min(40, pageCap), 4 << 20);
  store.applySnapshot({ session: { path: "history.jsonl" }, entries: window.entries,
    projection: { ...projectSession(entries, leaf), messagesHasEarlier: true },
    runtime: {}, graph: { id: "history", epoch: "e", revision: 1, runs: [] } } as SessionSnapshot);
  const requests: Array<{ leafId: string; limit: number; bytes: number }> = [];
  vi.mocked(desktop.invoke).mockImplementation(async (route, input) => {
    if (route !== "session.branchWindow") return {};
    const request = validateRouteInput(route, input) as typeof requests[number];
    requests.push(request);
    // A byte-limited page can return fewer turns than requested, even when
    // the caller has already reached the maximum byte budget.
    return windowEntries(entries, request.leafId, Math.min(pageCap, request.limit), request.bytes);
  });
  return { store, leaf, requests, entries, node: `turn:u${count - 1}` };
}
const users = (store: ReturnType<typeof useSessionStore>, node: string, count: number) =>
  store.messageWindowFor(node, count).messages.filter(message => message.role === "user");
afterEach(() => { vi.mocked(desktop.invoke).mockReset(); vi.mocked(desktop.invoke).mockImplementation(async () => ({})); });

it("pages beyond 500 turns using bounded requests and advancing ancestors", async () => {
  const { store, leaf, node, requests } = setup(600);
  for (let count = 80; count <= 640; count += 40) {
    const request = store.windowPlanFor(node, count)!.request;
    if (request) await store.fetchWindow(leaf, request.limit, request.bytes);
    expect(users(store, node, count)).toHaveLength(Math.min(count, 600));
  }
  expect(store.messageWindowFor(node, 640).hasEarlier).toBe(false);
  expect(new Set(requests.map(request => request.leafId)).size).toBe(requests.length);
  expect(requests.every(request => request.limit <= 500)).toBe(true);
});

it("splits a large initial request at the route's turn ceiling", async () => {
  const { store, leaf, node, requests } = setup(650);
  await store.fetchWindow(leaf, 700);
  expect(users(store, node, 700)).toHaveLength(650);
  expect(requests.map(request => request.limit)).toEqual([500, 160]);
});

it("advances byte-capped pages even at the maximum byte budget", async () => {
  const { store, leaf, node, requests } = setup(12, 2);
  await store.fetchWindow(leaf, 40, 64 << 20);
  expect(users(store, node, 40)).toHaveLength(12);
  expect(store.messageWindowFor(node, 40).hasEarlier).toBe(false);
  expect(requests.map(request => request.leafId)).toEqual(["a9", "a7", "a5", "a3", "a1"]);
  expect(requests.every(request => request.bytes === 64 << 20)).toBe(true);
});

it("keeps buffered earlier turns available to a new 40-turn view", async () => {
  const { store, leaf, node, requests } = setup(100);
  await store.fetchWindow(leaf, 120);
  const calls = requests.length;
  expect(users(store, node, 40)).toHaveLength(40);
  expect(store.messageWindowFor(node, 40).hasEarlier).toBe(true);
  expect(store.windowPlanFor(node, 80)!.request).toBeNull();
  expect(users(store, node, 100)).toHaveLength(100);
  expect(requests).toHaveLength(calls);
});

it("does not mistake an empty stale page for the root or loop on it", async () => {
  const { store, leaf, node } = setup(100);
  vi.mocked(desktop.invoke).mockResolvedValue({ entries: [], hasEarlier: false });
  await store.fetchWindow(leaf, 80);
  expect(desktop.invoke).toHaveBeenCalledTimes(1);
  expect(store.messageWindowFor(node, 80).hasEarlier).toBe(true);
  expect(store.windowPlanFor(node, 80)!.request).not.toBeNull();
});

it("automatically fetches only one byte-limited page rather than filling 40 large turns", async () => {
  const { store, node, requests } = setup(50, 500, 1 << 20);
  expect(users(store, node, 40)).toHaveLength(3);
  await flushPromises();
  expect(users(store, node, 40)).toHaveLength(6);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ leafId: "a46", bytes: 4 << 20 });
  await flushPromises();
  expect(requests).toHaveLength(1);
});

it("shares one automatic page between a top-up and a viewport fill check", async () => {
  const { store, leaf, entries, node } = setup(20, 2);
  let release!: (result: unknown) => void;
  vi.mocked(desktop.invoke).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const topUp = store.fetchWindow(leaf, 40, 4 << 20, true);
  const fill = store.fetchWindow(leaf, 80, 4 << 20, true);
  expect(desktop.invoke).toHaveBeenCalledTimes(1);
  release(windowEntries(entries, "a17", 2, 4 << 20));
  await Promise.all([topUp, fill]);
  expect(users(store, node, 40)).toHaveLength(4);
  expect(desktop.invoke).toHaveBeenCalledTimes(1);
});

it("discards pooled deleted turns and rejects pre-deletion paging and recall replies", async () => {
  const { store, leaf, entries } = setup(100);
  // The initial pool and recall both contain turns that will be deleted.
  vi.mocked(desktop.invoke).mockResolvedValue({ prompts: ["prompt 99", "prompt 0"] });
  await store.loadPromptRecall();
  expect(store.promptRecall).toContain("prompt 99");

  let oldPage!: (value: unknown) => void, oldRecall!: (value: unknown) => void;
  vi.mocked(desktop.invoke).mockImplementation(async route => {
    if (route === "session.branchWindow") return new Promise(resolve => { oldPage = resolve; });
    if (route === "session.prompts") return new Promise(resolve => { oldRecall = resolve; });
    return {};
  });
  const paging = store.fetchWindow(leaf, 80);
  const recalling = store.loadPromptRecall();
  const current = store.current!;
  const retained = entries.slice(0, 2);
  store.applySnapshot({ ...current, entries: retained, projection: projectSession(retained, "a0"),
    graph: { ...current.graph!, epoch: "after-deletion", revision: current.graph!.revision + 1 } });
  expect([...store.entryPool.keys()]).toEqual(["u0", "a0"]);
  expect(store.promptRecall).toEqual([]);
  expect(store.windowAttempts.size).toBe(0);
  expect(store.windowInFlight.size).toBe(0);

  // The new list may finish before the old list; neither old response may
  // restore deleted data or overwrite the rebuilt history's recall.
  vi.mocked(desktop.invoke).mockResolvedValue({ prompts: ["prompt 0"] });
  await store.loadPromptRecall();
  oldPage(windowEntries(entries, "a59", 40, 4 << 20));
  oldRecall({ prompts: ["prompt 99", "prompt 0"] });
  await Promise.all([paging, recalling]);
  expect([...store.entryPool.keys()]).toEqual(["u0", "a0"]);
  expect(promptRecall(store.current!.entries)).toEqual(["prompt 0"]);
  expect(store.promptRecall).toEqual(["prompt 0"]);
});

it.each(["setThinking", "reload", "promptAt"])("rejects a pre-deletion %s reply without a view change", async action => {
  const { store } = setup(100);
  const before = store.current!;
  let release!: (snapshot: SessionSnapshot) => void;
  vi.mocked(desktop.invoke).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const control = store.control({ action, level: "high" });
  const retained = { ...before, entries: [], projection: projectSession([], null),
    graph: { ...before.graph!, epoch: "after-deletion", revision: before.graph!.revision + 1 } };
  store.applySnapshot(retained);
  release(before);
  await control;
  expect(store.current?.graph?.epoch).toBe("after-deletion");
  expect(store.entryPool.size).toBe(0);
  expect(store.current?.projection.nodes).toEqual([]);
});

it.each([false, true])("accepts a control's own epoch transition (broadcast first: %s)", async broadcastFirst => {
  const { store } = setup(2);
  const before = store.current!;
  let release!: (snapshot: SessionSnapshot) => void;
  vi.mocked(desktop.invoke).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const control = store.control({ action: "reload" });
  const rebuilt = { ...before, graph: { ...before.graph!, epoch: "rebuilt", revision: before.graph!.revision + 1 } };
  if (broadcastFirst) store.applySnapshot({ ...rebuilt });
  release(rebuilt);
  await control;
  expect(store.current?.graph?.epoch).toBe("rebuilt");
  expect(store.entryPool.size).toBe(4);
});

it("replaces complete read-only history and isolates equal paths on different hosts", () => {
  const { store, entries } = setup(2);
  const full = { ...store.current!, graph: undefined, entriesComplete: true as const, entries };
  store.hydrate({ name: "A", path: "/project", remote: { kind: "ssh", host: "A" } }, [], [], { ...full });
  store.applySnapshot({ ...full, entries: [], projection: projectSession([], null) });
  expect(store.entryPool.size).toBe(0);
  store.applySnapshot({ ...full });
  store.hydrate({ name: "B", path: "/project", remote: { kind: "ssh", host: "B" } }, [], [],
    { ...full, entries: entries.slice(0, 2), projection: projectSession(entries.slice(0, 2), "a0") });
  expect([...store.entryPool.keys()]).toEqual(["u0", "a0"]);
});

it("ignores reads from a replaced unversioned history, including across hosts", async () => {
  const { store, entries } = setup(2);
  const source = { ...store.current!, graph: undefined, entriesComplete: true as const };
  store.hydrate({ name: "A", path: "/project", remote: { kind: "ssh", host: "A" } }, [], [], source);
  let page!: (value: unknown) => void, recall!: (value: unknown) => void;
  vi.mocked(desktop.invoke).mockImplementation(route => new Promise(resolve => {
    if (route === "session.branchWindow") page = resolve;
    if (route === "session.prompts") recall = resolve;
  }));
  const paging = store.fetchWindow("unloaded", 1), recalling = store.loadPromptRecall();
  store.hydrate({ name: "B", path: "/project", remote: { kind: "ssh", host: "B" } }, [], [],
    { ...source, entries: [], projection: projectSession([], null) });
  page({ entries, hasEarlier: false }); recall({ prompts: ["host A prompt"] });
  await Promise.all([paging, recalling]);
  expect(store.entryPool.size).toBe(0);
  expect(store.promptRecall).toEqual([]);
});

it("does not extend the decoder's wire baseline when history is pooled", async () => {
  const { store, entries, leaf } = setup(100);
  await store.fetchWindow(leaf, 120);
  const page = windowEntries(entries, leaf, 40);
  const incoming = { ...store.current!, entries: page.entries, projection: { ...store.current!.projection } };
  const wireEntries = incoming.entries, wireProjection = incoming.projection;
  store.applySnapshot(incoming);
  expect(incoming.entries).toBe(wireEntries);
  expect(incoming.entries).toHaveLength(80);
  expect(incoming.projection).toBe(wireProjection);
  expect(store.current).not.toBe(incoming);
  expect(store.current!.entries).toHaveLength(200);
});

for (const identity of [{ session: "other.jsonl", epoch: "e" }, { session: "history.jsonl", epoch: "reopened" }])
it(`rejects history pages from a different identity ${JSON.stringify(identity)}`, async () => {
  const { store, leaf, entries, node } = setup(100);
  const before = store.current!.entries;
  vi.mocked(desktop.invoke).mockResolvedValue({ ...windowEntries(entries, "a59", 40), ...identity });
  await store.fetchWindow(leaf, 80);
  expect(store.current!.entries).toBe(before);
  expect(users(store, node, 40)).toHaveLength(40);
  expect(store.windowPlanFor(node, 80)!.request).not.toBeNull();
});
