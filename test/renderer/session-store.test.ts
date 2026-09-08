import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectSession } from "../../src/shared/session";
import type { ProjectGroup, ProjectInfo, RawSessionEntry, SessionSnapshot } from "../../src/shared/types";
import { desktop } from "../../src/renderer/api";
import { useSessionStore } from "../../src/renderer/stores/session";

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

    expect(session.sessions).toEqual([session.current?.session]);
  });

  it("clears the current session after deletion, including broadcast-only deletion", async () => {
    const session = useSessionStore();
    hydrate(session, snapshot(first, "a1"));
    session.onAgentEvent({ type: "agent_start" });
    session.userThinking = "high";
    session.commands = [{ name: "test" }];
    session.models = [{ provider: "test", id: "test" }];
    vi.spyOn(desktop, "invoke").mockResolvedValue({ sessions: [] });

    await session.remove("session.jsonl", true);

    expect(session.current).toBeUndefined();
    expect(session.focusedNode).toBeNull();
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
