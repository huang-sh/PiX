// End-to-end acceptance coverage for the operation history feature, at the
// store level with mocked IPC (scenarios 1-3, 5) and via the mounted panel
// (scenario 4). Shortcut keys themselves belong to a parallel PR; the rapid
// ⌘Z behaviour these tests cover is the undoSteps/redoSteps concurrency that
// shortcuts delegate to.

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import type { SessionSnapshot, SessionSummary } from "../../src/shared/types";
import { projectSession } from "../../src/shared/session";
import { i18n } from "../../src/renderer/i18n";
import { resetForTest } from "../../src/renderer/experimental/history/store";
import HistoryPanel from "../../src/renderer/experimental/history/HistoryPanel.vue";

function summary(path: string, name?: string, firstMessage = "Hello"): SessionSummary {
  return { id: path, path, name, cwd: ".", created: "", modified: "", messageCount: 1, firstMessage };
}

function snapshot(path: string): SessionSnapshot {
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01", message: { role: "user", content: "first" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01", message: { role: "assistant", content: "answer" } },
  ];
  return {
    session: { id: path, path, cwd: ".", created: "", modified: "", messageCount: 2, firstMessage: "first" },
    entries,
    projection: projectSession(entries as never, "a1"),
    graph: { id: path, epoch: "epoch", revision: 1, runs: [], recoveredInputs: [] },
    runtime: { available: true, model: null, thinkingLevel: "off", availableThinkingLevels: [], isStreaming: false,
      isCompacting: false, isRetrying: false, autoCompactionEnabled: true, autoRetryEnabled: true,
      steeringMode: "all", followUpMode: "all", pendingMessageCount: 0 },
  } as unknown as SessionSnapshot;
}

// Shared singleton boot (no vi.resetModules: panel and session store must
// share the same history instance inside one test file).
async function boot() {
  resetForTest();
  setActivePinia(createPinia());
  const history = await import("../../src/renderer/experimental/history/store");
  const session = await import("../../src/renderer/stores/session");
  const { useLayoutStore } = await import("../../src/renderer/stores/layout");
  useLayoutStore().settings = { app: { experimentalHistory: true } } as never;
  return { history, store: session.useSessionStore() };
}

let lib: ReturnType<typeof vi.fn>;

beforeEach(() => {
  lib = vi.mocked(window.pix!.invoke);
  lib.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Flush the reactive DOM updates that block under fake timers (pattern from
// history-panel.test.ts).
async function flush() {
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 0));
  vi.useFakeTimers();
}

describe("management ops round-trip E2E", () => {
  it("pin: undo flips the flag without a new entry, redo re-pins", async () => {
    const { history, store } = await boot();
    store.sessions = [summary("s.jsonl", "My Sesh")];
    lib.mockResolvedValue({ projects: [] });

    await store.pin("s.jsonl", true);
    expect(history.history.cursor).toBe(1);

    const undone = await history.undoSteps(1);
    expect(undone).toBe(true);
    expect(lib).toHaveBeenLastCalledWith("library.pin", { path: "s.jsonl", pinned: false });
    expect(history.history.entries).toHaveLength(1); // no new journal entry
    expect(history.history.cursor).toBe(0);

    await history.redoSteps(1);
    expect(lib).toHaveBeenLastCalledWith("library.pin", { path: "s.jsonl", pinned: true });
    expect(history.history.cursor).toBe(1);
  });

  it("archiveSession: undo restores the archived flag, redo re-archives", async () => {
    const { history, store } = await boot();
    store.sessions = [summary("s1", "My Sesh")];
    lib.mockResolvedValue({ projects: [] });

    await store.archiveSession("s1", true);
    expect(history.history.entries[0]?.kind).toBe("archiveSession");

    await history.undoSteps(1);
    expect(lib).toHaveBeenLastCalledWith("library.archiveSession", { path: "s1", archived: false });

    await history.redoSteps(1);
    expect(lib).toHaveBeenLastCalledWith("library.archiveSession", { path: "s1", archived: true });
  });

  it("rename: undo restores the previous name via session.rename IPC", async () => {
    const { history, store } = await boot();
    store.sessions = [summary("s1", "Old Name")];
    lib.mockResolvedValue({ sessions: [summary("s1", "New Name")] });

    await store.rename("s1", "New Name");
    expect(history.history.entries[0]?.label).toContain("Old Name");

    await history.undoSteps(1);
    expect(lib).toHaveBeenLastCalledWith("session.rename", { path: "s1", name: "Old Name" });

    await history.redoSteps(1);
    expect(lib).toHaveBeenLastCalledWith("session.rename", { path: "s1", name: "New Name" });
  });

  it("archiveProject: undo flips the archiveProject flag back, redo re-archives", async () => {
    const { history, store } = await boot();
    store.projects = [{ id: "p1", project: { name: "Proj", path: "D:/P" }, sessions: [] }];
    lib.mockResolvedValue({ projects: [] });

    await store.archiveProject("p1", true);
    expect(history.history.entries[0]?.kind).toBe("archiveDirectory");

    await history.undoSteps(1);
    expect(lib).toHaveBeenLastCalledWith("library.archiveProject", { id: "p1", archived: false });

    await history.redoSteps(1);
    expect(lib).toHaveBeenLastCalledWith("library.archiveProject", { id: "p1", archived: true });
  });
});

describe("lock sealing after irreversible ops", () => {
  type Store = Awaited<ReturnType<typeof boot>>["store"];

  // Seed one applied, undoable pin plus a fresh current snapshot for the lock op.
  async function seedPinAndCurrent(store: Store, lib: ReturnType<typeof vi.fn>) {
    store.sessions = [summary("s1", "My Sesh")];
    lib.mockResolvedValue({ projects: [] });
    await store.pin("s1", true);
    store.current = snapshot("s1");
  }

  it("undo of a pinned step stops at a sendPrompt lock", async () => {
    const { history, store } = await boot();
    await seedPinAndCurrent(store, lib);
    expect(history.history.cursor).toBe(1);

    lib.mockResolvedValue({});
    await store.prompt("hi");
    expect(history.history.entries).toHaveLength(2);
    expect(history.history.entries[1]?.undoable).toBe(false);

    lib.mockClear();
    const ret = await history.undoSteps(1);
    expect(ret).toBe(false);
    expect(lib).not.toHaveBeenCalledWith("library.pin", { path: "s1", pinned: false });
    expect(history.history.cursor).toBe(2); // the lock seals the pin underneath
    expect(history.history.toast).toBe(i18n.global.t("history.locked", {
      label: i18n.global.t("history.sendPrompt", { text: "hi" }),
    }));
  });

  it("undo of a pinned step stops at an abort lock", async () => {
    const { history, store } = await boot();
    await seedPinAndCurrent(store, lib);

    const view = snapshot("s1");
    store.current = view;
    view.graph!.runs = [{ branchId: "main", runId: "run", nodeId: "a1", status: "running" }];
    lib.mockResolvedValue({});
    await store.control({ action: "branchAbort", branchId: "main", runId: "run" });
    expect(history.history.entries[1]?.kind).toBe("abortRun");

    lib.mockClear();
    const ret = await history.undoSteps(1);
    expect(ret).toBe(false);
    expect(lib).not.toHaveBeenCalledWith("library.pin", { path: "s1", pinned: false });
    expect(history.history.cursor).toBe(2);
  });

  it("undo of a pinned step stops at a deleteNode lock", async () => {
    const { history, store } = await boot();
    await seedPinAndCurrent(store, lib);

    const view = snapshot("s1");
    store.current = view;
    lib.mockImplementation(async (_route, input) =>
      (input as { action?: string }).action === "deleteNode" ? view : {});
    await store.deleteNode("a1");
    expect(history.history.entries[1]?.kind).toBe("deleteTurn");

    lib.mockClear();
    const ret = await history.undoSteps(1);
    expect(ret).toBe(false);
    expect(lib).not.toHaveBeenCalledWith("library.pin", { path: "s1", pinned: false });
    expect(history.history.cursor).toBe(2);
  });
});

describe("rapid consecutive undo (⌘Z mash)", () => {
  it("four un-awaited undos each run exactly once and redo walks them all back", async () => {
    const { history } = await boot();
    // Microtask deferral keeps the walk concurrency deterministic.
    const undo = vi.fn(async () => { await Promise.resolve(); return true; });
    const redo = vi.fn(async () => { await Promise.resolve(); return true; });
    for (let i = 0; i < 4; i += 1)
      history.track({ kind: "pin", label: "Pin", undo, redo });
    expect(history.history.cursor).toBe(4);

    const results = await Promise.all([
      history.undoSteps(1), history.undoSteps(1),
      history.undoSteps(1), history.undoSteps(1),
    ]);
    expect(results).toEqual([true, true, true, true]);
    expect(undo).toHaveBeenCalledTimes(4); // exactly once per entry
    expect(history.history.cursor).toBe(0);
    expect(history.history.entries).toHaveLength(4); // entries untouched

    await history.redoSteps(4);
    expect(redo).toHaveBeenCalledTimes(4);
    expect(history.history.cursor).toBe(4);
  });

  it("a second undo and a fresh track() during an in-flight walk chain in order after it", async () => {
    vi.useFakeTimers();
    try {
      const { history } = await boot();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const calls: string[] = [];

      // B (newest) undo is gated; A undo resolves immediately.
      history.track({
        kind: "pin", label: "A",
        undo: async () => { calls.push("undo:A"); return true; },
        redo: async () => { calls.push("redo:A"); return true; },
      });
      history.track({
        kind: "pin", label: "B",
        undo: async () => { calls.push("undo:B"); await gate; return true; },
        redo: async () => { calls.push("redo:B"); return true; },
      });
      expect(history.history.cursor).toBe(2);

      // First undo is gated on B; a second undo and a fresh append both queue
      // behind it — nothing may cut in front of the in-flight walk.
      const first = history.undoSteps(1);
      const second = history.undoSteps(1);
      const fresh = history.track({
        kind: "pin", label: "C",
        undo: async () => { calls.push("undo:C"); return true; },
        redo: async () => { calls.push("redo:C"); return true; },
      });
      expect(history.history.busy).toBe(true);
      expect(calls).toEqual([]); // B suspended at the gate, nothing else ran

      release!();
      await first;
      await second;
      await vi.advanceTimersByTimeAsync(1); // land the deferred C append

      // Serialised: B then A; C lands only after the walk, truncating the
      // now-entirely-undone segment so C becomes the sole entry.
      expect(calls).toEqual(["undo:B", "undo:A"]);
      expect(history.history.entries.map((entry) => entry.label)).toEqual(["C"]);
      expect(history.history.cursor).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("panel click-to-jump integration", () => {
  let wrapper: ReturnType<typeof mount<HistoryPanel>>;

  beforeEach(() => { vi.useFakeTimers(); });

  afterEach(async () => {
    wrapper?.unmount();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  function mountPanel() {
    wrapper = mount(HistoryPanel, {
      attachTo: document.body,
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
  }

  it("clicking an applied row (real store actions) undoes it and reflects the inverse IPC", async () => {
    const { history: h, store } = await boot();
    store.sessions = [summary("s1", "My Sesh")];
    lib.mockResolvedValue({ projects: [] });
    await store.pin("s1", true);             // idx0 pin
    await store.archiveSession("s1", true);  // idx1 archive (newest)
    expect(h.history.cursor).toBe(2);

    h.togglePanel();
    mountPanel();
    await flush();

    // Newest row (archive) is applied first; clicking it undoes the archive.
    lib.mockClear();
    await wrapper.get(".history-row-applied").trigger("click");
    await flush();
    expect(h.history.cursor).toBe(1);
    expect(lib).toHaveBeenCalledWith("library.archiveSession", { path: "s1", archived: false });
  });

  it("clicking an undone row on real store actions re-applies it", async () => {
    const { history: h, store } = await boot();
    store.sessions = [summary("s1", "My Sesh")];
    lib.mockResolvedValue({ projects: [] });
    await store.pin("s1", true);        // idx0
    await store.pin("s1", false);       // idx1 (unpin) — newest
    await h.undoSteps(1);               // cursor 1: idx1 undone
    expect(h.history.cursor).toBe(1);

    h.togglePanel();
    mountPanel();
    await flush();

    // Newest undone row first — clicking it redoes the unpin.
    lib.mockClear();
    await wrapper.get(".history-row-undone").trigger("click");
    await flush();
    expect(h.history.cursor).toBe(2);
    expect(lib).toHaveBeenCalledWith("library.pin", { path: "s1", pinned: false });
  });

  it("sealed rows below a sendPrompt lock are disabled and do nothing when clicked", async () => {
    const { history: h, store } = await boot();
    store.sessions = [summary("s1", "My Sesh")];
    lib.mockResolvedValue({ projects: [] });
    await store.pin("s1", true);        // idx0 pin
    store.current = snapshot("s1");
    lib.mockResolvedValue({});
    await store.prompt("hi");           // idx1 sendPrompt lock
    expect(h.lockIndex()).toBe(1);

    h.togglePanel();
    mountPanel();
    await flush();

    const applied = wrapper.findAll(".history-row-applied");
    expect(applied.at(0)?.attributes("disabled")).toBeDefined(); // newest row: lock
    const lockRow = applied.at(1)!; // the sealed pin below it
    expect(lockRow.attributes("disabled")).toBeDefined();
    lib.mockClear();
    await lockRow.trigger("click");
    await flush();
    expect(h.history.cursor).toBe(2);
    expect(lib).not.toHaveBeenCalledWith("library.pin", { path: "s1", pinned: false });
    expect(h.history.toast).toBeNull(); // a disabled row's click is a pure no-op
  });
});

describe("depth/lock invariants", () => {
  it("undoDepth, redoDepth, and lockIndex agree with entries and cursor", async () => {
    const { history } = await boot();
    const u = (id: string) => history.track({
      kind: "pin", label: id,
      undo: async () => true, redo: async () => true,
    });
    u("u0");                    // idx0 undoable
    history.trackEvent({ kind: "sendPrompt", label: "lock" }); // idx1 lock
    u("u1");                    // idx2 undoable
    u("u2");                    // idx3 undoable

    // All applied.
    expect(history.history.entries).toHaveLength(4);
    expect(history.history.cursor).toBe(4);
    expect(history.undoDepth()).toBe(2);  // u2,u1 above the lock
    expect(history.redoDepth()).toBe(0);
    expect(history.lockIndex()).toBe(1);

    // Partial undo above the lock.
    await history.undoSteps(2); // undoes u2 (idx3) and u1 (idx2)
    expect(history.history.cursor).toBe(2);
    expect(history.undoDepth()).toBe(0);  // the cursor edge is the lock
    expect(history.redoDepth()).toBe(2);
    expect(history.lockIndex()).toBe(1);

    // Undoing further is blocked by the lock: the cursor does not move.
    const blocked = await history.undoSteps(2);
    expect(blocked).toBe(false);
    expect(history.history.cursor).toBe(2);
    expect(history.undoDepth()).toBe(0);
    expect(history.redoDepth()).toBe(2);
    expect(history.lockIndex()).toBe(1);

    // Redo walks back above the lock.
    await history.redoSteps(2);
    expect(history.history.cursor).toBe(4);
    expect(history.undoDepth()).toBe(2);
    expect(history.redoDepth()).toBe(0);
    expect(history.lockIndex()).toBe(1);
  });
});