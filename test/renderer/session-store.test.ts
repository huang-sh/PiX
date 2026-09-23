import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectSession } from "../../src/shared/session";
import type { ProjectGroup, ProjectInfo, RawSessionEntry, SessionSnapshot, SessionSummary } from "../../src/shared/types";
import { desktop } from "../../src/renderer/api";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";

const first: RawSessionEntry[] = [
  { type: "message", id: "u1", parentId: null, timestamp: "2026-09-02T10:00:00Z", message: { role: "user", content: "first" } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-02T10:00:01Z", message: { role: "assistant", content: "answer" } },
];
const project: ProjectInfo = { name: "PiX", path: "D:/dev/PiX" };

function hydrate(session: ReturnType<typeof useSessionStore>, current: SessionSnapshot) {
  const projects: ProjectGroup[] = [{
    id: `local:${project.path}`,
    project,
    sessions: [],
    lastOpened: "2026-09-03T00:00:00Z",
    connected: true,
  }];
  session.hydrate(project, [], projects, current);
}

function snapshot(entries: RawSessionEntry[], leafId: string): SessionSnapshot {
  return {
    session: {
      id: "session",
      path: "session.jsonl",
      cwd: ".",
      created: "2026-09-02T10:00:00Z",
      modified: "2026-09-02T10:00:00Z",
      messageCount: entries.length,
      firstMessage: "first",
    },
    entries,
    projection: projectSession(entries, leafId),
    runtime: { isStreaming: true } as SessionSnapshot["runtime"],
  };
}

describe("session stream focus", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  it("keeps the current streamed session in the navigator", () => {
    const session = useSessionStore();
    hydrate(session, snapshot(first, "a1"));

    expect(session.sessions).toEqual([{ ...session.current?.session, running: true }]);
  });

  it("adopts the new session from its own reply before any broadcast arrives", async () => {
    const session = useSessionStore();
    useWorkspaceStore().hydrate(project);
    hydrate(session, snapshot(first, "a1"));
    const created = { ...session.current!, session: { ...session.current!.session, path: "new.jsonl" } };
    const invoke = vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
      if (route === "agent.control" && (input as { action?: string }).action === "newSession") return created;
      if (route === "session.list") return [created.session];
      return [];
    });

    await session.create();

    expect(invoke.mock.calls.some(([route]) => route === "session.list")).toBe(true);
    expect(session.current?.session.path).toBe("new.jsonl");
    expect(session.sessions.map(row => row.path)).toEqual(["new.jsonl"]);
  });

  it("applies project-group refreshes from any project without touching the view", () => {
    const session = useSessionStore();
    hydrate(session, snapshot(first, "a1"));
    const view = session.current;
    const other: ProjectGroup = {
      id: "local:other",
      project: { name: "other", path: "D:/dev/other" },
      sessions: [{ ...view!.session, path: "D:/dev/other/.pi/sessions/bg.jsonl", running: true }],
      lastOpened: "2026-09-03T00:00:00Z",
      connected: false,
    };

    session.applyProjects([...session.projects, other]);

    expect(session.current).toBe(view);
    expect(session.projects).toHaveLength(2);
    const rows = session.filteredProjects.find(record => record.id === other.id)?.sessions ?? [];
    expect(rows.find(item => item.running)?.path).toBe("D:/dev/other/.pi/sessions/bg.jsonl");
  });

  it("refreshes running markers without losing another session's state", () => {
    const session = useSessionStore();
    hydrate(session, snapshot(first, "a1"));
    const row = session.current!.session;
    const background = { ...row, path: "other.jsonl", messageCount: 2 };
    const groups = (rows: SessionSummary[]) => [{ ...session.projects[0]!, sessions: rows }];

    session.applyProjects(groups([row, { ...background, running: true }]));

    const project = () => session.filteredProjects[0]?.sessions;
    expect(project()?.find(item => item.path === "other.jsonl")?.running).toBe(true);
    // A snapshot updates its own row without erasing the background run.
    session.applySnapshot(snapshot(first, "a1"));
    expect(project()?.find(item => item.path === "other.jsonl")?.running).toBe(true);
    session.applyProjects(groups([row, background]));
    expect(project()?.find(item => item.path === "other.jsonl")?.running).toBeUndefined();
  });

  it("stops a background session through the stop route and refreshes", async () => {
    const session = useSessionStore();
    hydrate(session, snapshot(first, "a1"));
    const row = session.current!.session;
    const invoke = vi.spyOn(desktop, "invoke").mockImplementation(async (route: string) =>
      route === "session.stop" ? { stopped: true } : [row]);

    await session.stop("other.jsonl");

    expect(invoke).toHaveBeenCalledWith("session.stop", { path: "other.jsonl" });
    expect(invoke).toHaveBeenCalledWith("session.list");
  });

  it("updates graph running markers from snapshots without a list refresh", () => {
    const session = useSessionStore();
    const idle = snapshot(first, "a1");
    idle.runtime.isStreaming = false;
    const graph = { id: idle.session.path, epoch: "e", revision: 1,
      runs: [{ branchId: "b", runId: "r", status: "running" }] } as SessionSnapshot["graph"];
    hydrate(session, { ...idle, graph });
    expect(session.filteredProjects[0]!.sessions[0]!.running).toBe(true);
    session.applySnapshot({ ...idle, graph: { ...graph!, revision: 2, runs: [] } });
    expect(session.filteredProjects[0]!.sessions[0]!.running).toBeUndefined();
  });

  it("keeps running flags scoped to each project even when hosts share a session path", () => {
    const session = useSessionStore();
    const idle = snapshot(first, "a1");
    idle.runtime.isStreaming = false;
    hydrate(session, idle);
    const other: ProjectGroup = { ...session.projects[0]!, id: "ssh:host:/project",
      project: { name: "remote", path: "/project", remote: { kind: "ssh", host: "host" } },
      sessions: [{ ...idle.session, running: true }], connected: true };
    session.applyProjects([...session.projects, other]);
    expect(session.filteredProjects.find(row => row.id === session.activeProjectId)!.sessions[0]!.running).toBeUndefined();
    expect(session.filteredProjects.find(row => row.id === other.id)!.sessions[0]!.running).toBe(true);
    session.disconnected(other.id);
    expect(session.filteredProjects.find(row => row.id === other.id)!.sessions[0]!.running).toBeUndefined();
  });

  it("applies fresh active-project rows from background project events", () => {
    const session = useSessionStore();
    hydrate(session, snapshot(first, "a1"));
    session.applyProjects([{ ...session.projects[0]!, sessions: [{ ...session.sessions[0]!, running: false, messageCount: 42 }] }]);
    expect(session.sessions[0]!.messageCount).toBe(42);
    expect(session.filteredProjects[0]!.sessions[0]!.running).toBe(false);
  });

  it.each(["project", "session"])("ignores delayed prompt replies after switching %s", async kind => {
    const session = useSessionStore();
    const before = snapshot(first, "a1");
    hydrate(session, before);
    let finish!: (snapshot: SessionSnapshot) => void;
    vi.spyOn(desktop, "invoke").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = session.prompt("held");
    if (kind === "project") {
      session.hydrate({ ...project, path: "D:/other" }, [], [], before);
    } else session.applySnapshot({ ...before, session: { ...before.session, path: "other.jsonl" } });
    const view = session.current;
    session.focusedNode = "keep-focus";
    finish(before);
    await pending;
    expect(session.current).toBe(view);
    expect(session.focusedNode).toBe("keep-focus");
  });

  it.each([["A", "B"], ["B", "A"]])("keeps the latest open when replies arrive %s then %s", async (firstReply, lastReply) => {
    const session = useSessionStore(); hydrate(session, snapshot(first, "a1"));
    const release = new Map<string, (value: SessionSnapshot) => void>();
    const idle = snapshot(first, "a1"); idle.runtime.isStreaming = false;
    const invoke = vi.spyOn(desktop, "invoke").mockImplementation((route, input) => route === "session.open"
      ? new Promise(resolve => release.set((input as { path: string }).path, resolve)) : Promise.resolve([]));
    invoke.mockClear();
    const a = session.open("A"), b = session.open("B");
    const pending = { A: a, B: b };
    for (const path of [firstReply, lastReply]) {
      release.get(path)!({ ...idle, session: { ...idle.session, path } });
      await pending[path as keyof typeof pending];
      if (path === "A" && firstReply === "A") expect(session.loading).toBe(true);
    }
    expect(session.current?.session.path).toBe("B");
    expect(session.loading).toBe(false);
    expect(invoke.mock.calls.filter(([route]) => route === "session.list")).toHaveLength(1);
  });

  it("invalidates pending opens at the start of a project switch and ignores stale errors", async () => {
    const session = useSessionStore(); hydrate(session, snapshot(first, "a1"));
    const before = session.current;
    let reject!: (error: Error) => void;
    vi.spyOn(desktop, "invoke").mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    const opening = session.open("old");
    const request = ++session.viewRequest;
    reject(new Error("old open failed")); await opening;
    expect(session.current).toBe(before);
    expect(session.loading).toBe(true);
    session.hydrate({ name: "other", path: "/other" }, [], [], undefined, request);
    expect(session.current).toBeUndefined();
  });

  it("does not apply an old open reply after hydrating another project", async () => {
    const session = useSessionStore(); hydrate(session, snapshot(first, "a1"));
    let finish!: (value: SessionSnapshot) => void;
    vi.spyOn(desktop, "invoke").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const opening = session.open("old");
    const other = { ...snapshot(first, "a1"), session: { ...snapshot(first, "a1").session, path: "other" } };
    session.hydrate({ name: "other", path: "/other" }, [], [], other);
    finish(snapshot(first, "a1")); await opening;
    expect(session.current?.session.path).toBe("other");
    expect(session.sessions.map(row => row.path)).toEqual(["other"]);
  });

  it("clears the current session after deletion, including broadcast-only deletion", async () => {
    const session = useSessionStore();
    hydrate(session, snapshot(first, "a1"));
    session.highlightedNode = "turn:u1";
    session.onAgentEvent({ type: "agent_start" });
    session.userThinking = "high";
    session.commands = [{ name: "test" }];
    session.models = [{ provider: "test", id: "test" }];
    vi.spyOn(desktop, "invoke").mockResolvedValue({ sessions: [] });

    await session.remove("session.jsonl", true);

    expect(session.current).toBeUndefined();
    expect(session.focusedNode).toBeNull();
    expect(session.highlightedNode).toBeNull();
    expect(session.activity).toBeUndefined();
    expect(session.pendingPrompt).toBeUndefined();
    expect(session.userThinking).toBeUndefined();
    expect(session.commands).toEqual([]);
    // The model catalog is global state, not session state — deleting the
    // session must not clear it.
    expect(session.models).toEqual([{ provider: "test", id: "test" }]);
    expect(session.messageWindow(40).messages).toEqual([]);
    expect(session.projects[0]?.sessions).toEqual([]);

    hydrate(session, snapshot(first, "a1"));
    session.applyDeletion("session.jsonl", []);
    expect(session.current).toBeUndefined();
  });

  it("preserves the current session when deletion is cancelled or targets another session", async () => {
    const session = useSessionStore();
    hydrate(session, snapshot(first, "a1"));
    const current = session.current;
    const invoke = vi.spyOn(desktop, "invoke").mockResolvedValue({ cancelled: true, sessions: [] });
    await session.remove("session.jsonl");
    expect(session.current).toBe(current);
    expect(session.sessions).toHaveLength(1);

    invoke.mockResolvedValue({ sessions: [current!.session] });
    await session.remove("other.jsonl", true);
    expect(session.current).toBe(current);
    expect(session.messageWindow(40).messages).toHaveLength(2);
  });

  it("loads commands and models independently, keeping the catalog when discovery fails or the session goes away", async () => {
    const session = useSessionStore();
    const current = snapshot(first, "a1");
    current.runtime = { ...current.runtime, available: true };
    hydrate(session, current);
    vi.spyOn(desktop, "invoke").mockImplementation(async (_route, input) => {
      if ((input as { action?: string }).action === "commands") throw new Error("commands unavailable");
      return [{ provider: "deepseek", id: "deepseek-chat" }] as never;
    });

    await session.loadCommands();
    expect(session.commands).toEqual([]);

    await session.loadModels();
    expect(session.models).toEqual([{ provider: "deepseek", id: "deepseek-chat" }]);

    // Commands are session-scoped and clear without a usable session; the
    // catalog is global and survives.
    current.runtime = { ...current.runtime, available: false };
    await session.loadCommands();
    expect(session.commands).toEqual([]);
    expect(session.models).toEqual([{ provider: "deepseek", id: "deepseek-chat" }]);
  });

  it("ignores command discovery from a previously selected session", async () => {
    const session = useSessionStore();
    const current = snapshot(first, "a1");
    current.runtime.available = true;
    hydrate(session, current);
    let resolveOld!: (value: any) => void;
    vi.spyOn(desktop, "invoke")
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue([{ name: "new-command", source: "extension" }] as never);
    const oldLoad = session.loadCommands();
    hydrate(session, { ...current, session: { ...current.session, path: "new.jsonl" } });
    await session.loadCommands();
    resolveOld([{ name: "old-command", source: "extension" }]);
    await oldLoad;
    expect(session.commands.map(command => command.name)).toEqual(["new-command"]);
  });

  it("follows the new active node when a continued run starts", () => {
    const session = useSessionStore();
    hydrate(session, snapshot(first, "a1"));
    session.focusedNode = "turn:u1";
    const continued = [
      ...first,
      { type: "message", id: "u2", parentId: "a1", timestamp: "2026-09-02T10:01:00Z", message: { role: "user", content: "second" } },
    ] satisfies RawSessionEntry[];

    session.applySnapshot(snapshot(continued, "u2"));
    expect(session.selectedNode?.id).toBe("turn:u1");

    session.onAgentEvent({ type: "agent_start" });
    expect(session.focusedNode).toBeNull();
    expect(session.selectedNode?.id).toBe("turn:u2");
    expect(session.activity?.active).toBe(true);
  });

  it("shows a submitted user message before the runtime responds", async () => {
    const session = useSessionStore();
    hydrate(session, snapshot(first, "a1"));
    let resolve!: (value: SessionSnapshot) => void;
    const response = new Promise<SessionSnapshot>((done) => (resolve = done));
    vi.spyOn(desktop, "invoke").mockReturnValue(response);

    const running = session.prompt("second");
    expect(session.messageWindow(40).messages.at(-1)).toMatchObject({ role: "user", text: "second" });

    const continued = [
      ...first,
      { type: "message", id: "u2", parentId: "a1", timestamp: "2026-09-02T10:01:00Z", message: { role: "user", content: "second" } },
    ] satisfies RawSessionEntry[];
    resolve(snapshot(continued, "u2"));
    await running;
    expect(session.messageWindow(40).messages.filter((message) => message.text === "second")).toHaveLength(1);
  });

  it("removes the optimistic message when sending fails", async () => {
    const session = useSessionStore();
    hydrate(session, snapshot(first, "a1"));
    vi.spyOn(desktop, "invoke").mockRejectedValue(new Error("send failed"));

    await expect(session.prompt("second")).rejects.toThrow("send failed");
    expect(session.pendingPrompt).toBeUndefined();
    expect(session.messageWindow(40).messages.some((message) => message.text === "second")).toBe(false);
  });

  it("applies draft settings after branch navigation and before prompting", async () => {
    const session = useSessionStore();
    const current = snapshot(first, "a1");
    current.projection.activeNodeId = null;
    current.runtime = {
      ...current.runtime,
      available: true,
      model: { provider: "openai", id: "gpt-5.4" },
      thinkingLevel: "high",
    };
    hydrate(session, current);
    const inputs: unknown[] = [];
    vi.spyOn(desktop, "invoke").mockImplementation(async (_route, input) => {
      inputs.push(input);
      return {} as never;
    });

    await session.promptAt(
      "turn:u1",
      "second",
      { provider: "zai", id: "glm-5.3" },
      "low",
    );

    expect(inputs).toEqual([
      { action: "navigateTree", entryId: "a1" },
      // Session-scoped, like the TUI's model switch; the profile default only
      // moves through an explicit "set as default".
      { action: "setModel", provider: "zai", modelId: "glm-5.3" },
      { action: "setThinking", level: "low" },
      { action: "prompt", text: "second" },
    ]);
  });

  it("does not show an optimistic message on another branch", async () => {
    const session = useSessionStore();
    hydrate(session, snapshot(first, "a1"));
    let resolve!: (value: SessionSnapshot) => void;
    const response = new Promise<SessionSnapshot>((done) => (resolve = done));
    vi.spyOn(desktop, "invoke").mockReturnValue(response);

    const running = session.prompt("second");
    expect(session.messageWindow(40).messages.at(-1)?.text).toBe("second");
    await session.selectNode("turn:other");
    expect(session.messageWindow(40).messages.some((message) => message.text === "second")).toBe(false);

    const continued = [
      ...first,
      { type: "message", id: "u2", parentId: "a1", timestamp: "2026-09-02T10:01:00Z", message: { role: "user", content: "second" } },
    ] satisfies RawSessionEntry[];
    resolve(snapshot(continued, "u2"));
    await running;
  });
});
