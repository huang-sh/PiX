import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshot, SessionSummary } from "../../src/shared/types";
import { projectSession } from "../../src/shared/session";
import { i18n } from "../../src/renderer/i18n";

// The history journal is a run-scoped singleton the session store imports at
// module load, so every test resets modules and pulls a fresh pair. The
// invoker (`window.pix.invoke`) survives the reset, so its mocks live on.

const project = { name: "PiX", path: "D:/dev/PiX" };

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

async function boot() {
  vi.resetModules();
  setActivePinia(createPinia());
  const history = await import("../../src/renderer/experimental/history/store");
  const session = await import("../../src/renderer/stores/session");
  const workspace = await import("../../src/renderer/stores/workspace");
  const { useLayoutStore } = await import("../../src/renderer/stores/layout");
  useLayoutStore().settings = { app: { experimentalHistory: true } } as never;
  return {
    history,
    store: session.useSessionStore(),
    workspace: workspace.useWorkspaceStore(),
  };
}

let lib: ReturnType<typeof vi.fn>;

beforeEach(() => {
  lib = vi.mocked(window.pix!.invoke);
  lib.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("history instrumentation of management actions", () => {
  it("pin records an undoable entry; undo flips the flag without a new entry; redo re-pins", async () => {
    const { history, store } = await boot();
    store.sessions = [summary("s.jsonl", "My Sesh")];
    lib.mockResolvedValue({ projects: [] });

    await store.pin("s.jsonl", true);
    expect(history.history.entries).toHaveLength(1);
    expect(history.history.entries[0]?.kind).toBe("pin");
    expect(history.history.entries[0]?.undoable).toBe(true);

    await history.undoSteps(1);
    expect(lib).toHaveBeenLastCalledWith("library.pin", { path: "s.jsonl", pinned: false });
    expect(history.history.entries).toHaveLength(1);

    await history.redoSteps(1);
    expect(lib).toHaveBeenLastCalledWith("library.pin", { path: "s.jsonl", pinned: true });
  });

  it("archive session records a kind and undo flips the archive flag back", async () => {
    const { history, store } = await boot();
    store.sessions = [summary("s1", "My Sesh")];
    lib.mockResolvedValue({ projects: [] });

    await store.archiveSession("s1", true);
    expect(history.history.entries[0]?.kind).toBe("archiveSession");

    await history.undoSteps(1);
    expect(lib).toHaveBeenLastCalledWith("library.archiveSession", { path: "s1", archived: false });
  });

  it("rename captures the previous name and undo renames it back", async () => {
    const { history, store } = await boot();
    store.sessions = [summary("s1", "Old Name")];
    lib.mockResolvedValue({ sessions: [summary("s1", "New Name")] });

    await store.rename("s1", "New Name");
    expect(history.history.entries[0]?.label).toContain("Old Name");

    lib.mockClear();
    await history.undoSteps(1);
    expect(lib).toHaveBeenLastCalledWith("session.rename", { path: "s1", name: "Old Name" });

    lib.mockClear();
    await history.redoSteps(1);
    expect(lib).toHaveBeenLastCalledWith("session.rename", { path: "s1", name: "New Name" });
  });

  it("create records the created path and undo deletes that session", async () => {
    const { history, store, workspace } = await boot();
    workspace.hydrate(project);
    const created = snapshot("new.jsonl");
    lib.mockImplementation(async (route) => {
      if (route === "agent.control") return created;
      if (route === "session.list") return [created.session];
      return [];
    });

    await store.create();
    expect(store.current?.session.path).toBe("new.jsonl");
    expect(history.history.entries[0]?.kind).toBe("createSession");

    lib.mockResolvedValue({ sessions: [] });
    await history.undoSteps(1);
    expect(lib).toHaveBeenCalledWith("session.delete", { path: "new.jsonl", confirmed: true });
  });

  it("remove records a deleteSession lock", async () => {
    const { history, store } = await boot();
    store.sessions = [summary("s1", "My Sesh")];
    lib.mockResolvedValue({ sessions: [] });

    await store.remove("s1", true);
    expect(history.history.entries[0]?.kind).toBe("deleteSession");
    expect(history.history.entries[0]?.undoable).toBe(false);
  });

  it("prompt records a sendPrompt lock", async () => {
    const { history, store } = await boot();
    store.current = snapshot("s1");
    lib.mockResolvedValue({});

    await store.prompt("Hello, world");
    expect(history.history.entries[0]?.kind).toBe("sendPrompt");
    expect(history.history.entries[0]?.undoable).toBe(false);
  });

  it("undo stops at a lock: an earlier pin is not reopened and the toast reports the lock", async () => {
    const { history, store } = await boot();
    store.sessions = [summary("s1", "My Sesh")];
    // Undoable pin first, then an irreversible prompt on top.
    lib.mockResolvedValue({ projects: [] });
    await store.pin("s1", true);
    expect(history.history.cursor).toBe(1);

    store.current = snapshot("s1");
    lib.mockResolvedValue({});
    await store.prompt("locked ahead");
    expect(history.history.entries).toHaveLength(2);

    lib.mockClear();
    const ret = await history.undoSteps(1);
    expect(ret).toBe(false);
    expect(lib).not.toHaveBeenCalledWith("library.pin", { path: "s1", pinned: false });
    expect(history.history.cursor).toBe(2);
    const expected = i18n.global.t("history.locked", {
      label: i18n.global.t("history.sendPrompt", { text: "locked ahead" }),
    });
    expect(history.history.toast).toBe(expected);
  });

  it("deleteNode records a deleteTurn lock", async () => {
    const { history, store } = await boot();
    const view = snapshot("s1");
    store.current = view;
    lib.mockImplementation(async (_route, input) => {
      if ((input as { action?: string }).action === "deleteNode") return view;
      return {};
    });

    await store.deleteNode("a1");
    expect(history.history.entries[0]?.kind).toBe("deleteTurn");
    expect(history.history.entries[0]?.undoable).toBe(false);
  });

  it("abort control records an abortRun lock naming the running run", async () => {
    const { history, store } = await boot();
    const view = snapshot("s1");
    store.current = view;
    const target = view.projection.nodes.find((node: { id: string; title: string }) => node.id === "a1");
    view.graph!.runs = [{ branchId: "main", runId: "run", nodeId: "a1", status: "running" }];
    lib.mockResolvedValue({});

    await store.control({ action: "branchAbort", branchId: "main", runId: "run" });
    expect(history.history.entries[0]?.kind).toBe("abortRun");
    expect(history.history.entries[0]?.label).toContain(target?.title ?? "");
  });

  it("plain control actions that are not prompt/abort do not seal the journal", async () => {
    const { history, store } = await boot();
    store.current = snapshot("s1");
    lib.mockResolvedValue({});

    await store.control({ action: "compact" });
    expect(history.history.entries).toHaveLength(0);
  });
});