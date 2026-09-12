import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGroup, SessionSnapshot, SessionSummary } from "../../src/shared/types";
import { desktop } from "../../src/renderer/api";
import { useSessionStore } from "../../src/renderer/stores/session";

const sessionA = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  path: `/sessions/${id}.jsonl`,
  name: id,
  cwd: "/project",
  created: "2026-09-03T00:00:00Z",
  modified: "2026-09-03T00:00:00Z",
  messageCount: 1,
  firstMessage: id,
  ...extra,
});

function group(sessions: SessionSummary[], extra: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: "local:/project",
    project: { name: "project", path: "/project" },
    sessions,
    lastOpened: "2026-09-03T00:00:00Z",
    connected: true,
    ...extra,
  };
}

// A runtime snapshot only carries the raw summary, never the library marks.
function snapshot(session: SessionSummary): SessionSnapshot {
  return {
    session,
    entries: [],
    projection: { nodes: [], edges: [], messages: [], activeNodeId: null, leafId: null,
      activeBranchNodeIds: [], activeBranchEntryIds: [] },
    runtime: { available: true, isStreaming: false, isCompacting: false, isRetrying: false },
  } as unknown as SessionSnapshot;
}

// A remote workspace answers with decorated project groups but a flat list
// that carries no marks (it never passes through the local sessions() route).
function seedRemote(session: ReturnType<typeof useSessionStore>) {
  session.hydrate(
    { name: "project", path: "/project" },
    [sessionA("star"), sessionA("kept"), sessionA("gone")],
    [group([sessionA("star", { pinned: true }), sessionA("kept"), sessionA("gone", { archived: true })])],
  );
}

describe("session library marks", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  it("pins a session through the library and ranks it first", async () => {
    const session = useSessionStore();
    const plain = sessionA("old");
    session.projects = [group([sessionA("new"), plain])];
    session.sessions = session.projects[0]!.sessions;
    vi.spyOn(desktop, "invoke").mockResolvedValue({
      sessions: [plain, sessionA("new", { pinned: true })],
      projects: [group([plain, sessionA("new", { pinned: true })])],
    });

    await session.pin("/sessions/new.jsonl", true);

    expect(desktop.invoke).toHaveBeenCalledWith("library.pin", { path: "/sessions/new.jsonl", pinned: true });
    const listed = session.filteredProjects[0]!.sessions.map((item) => item.id);
    expect(listed).toEqual(["new", "old"]);
  });

  it("hides archived sessions until showArchived turns on", () => {
    const session = useSessionStore();
    session.hydrate(
      { name: "project", path: "/project" },
      [sessionA("kept"), sessionA("gone")],
      [group([sessionA("kept"), sessionA("gone", { archived: true })])],
    );

    expect(session.filteredProjects[0]!.sessions.map((item) => item.id)).toEqual(["kept"]);
    session.showArchived = true;
    expect(session.filteredProjects[0]!.sessions.map((item) => item.id)).toEqual(["kept", "gone"]);
  });

  it("hides archived projects until showArchived turns on", () => {
    const session = useSessionStore();
    session.projects = [group([], { id: "local:/a", project: { name: "a", path: "/a" } }), group([], { id: "local:/b", project: { name: "b", path: "/b" }, archived: true })];

    expect(session.filteredProjects.map((record) => record.id)).toEqual(["local:/a"]);
    session.showArchived = true;
    expect(session.filteredProjects.map((record) => record.id)).toEqual(["local:/a", "local:/b"]);
  });

  it("keeps the marks of the open session through live snapshots", () => {
    const session = useSessionStore();
    seedRemote(session);

    session.applySnapshot(snapshot(sessionA("star")));

    // The archived session stays hidden and the pinned one keeps its rank.
    expect(session.filteredProjects[0]!.sessions.map((item) => item.id)).toEqual(["star", "kept"]);
    session.showArchived = true;
    expect(session.filteredProjects[0]!.sessions.map((item) => item.id)).toEqual(["star", "kept", "gone"]);
  });

  it("keeps marks for a remote workspace whose session lists carry none", async () => {
    const session = useSessionStore();
    seedRemote(session);

    // Every remote surface (bootstrap, refresh, rename, delete) returns the
    // undecorated list; marks must still decide what the navigator shows.
    vi.spyOn(desktop, "invoke").mockResolvedValue([sessionA("star"), sessionA("kept"), sessionA("gone")]);
    await session.refresh();

    expect(session.filteredProjects[0]!.sessions.map((item) => item.id)).toEqual(["star", "kept"]);
  });

  it("unpins immediately even while the flat list still carries the old mark", async () => {
    const session = useSessionStore();
    seedRemote(session);
    // A previously decorated surface left a stale pin on the flat list.
    session.sessions = [sessionA("star", { pinned: true }), sessionA("kept"), sessionA("gone")];
    vi.spyOn(desktop, "invoke").mockResolvedValue({
      projects: [group([sessionA("star"), sessionA("kept"), sessionA("gone", { archived: true })])],
    });

    await session.pin("/sessions/star.jsonl", false);

    // The shown entry loses the pin even though the flat list still carries it.
    expect(session.filteredProjects[0]!.sessions.find((item) => item.id === "star")?.pinned).toBeUndefined();
    expect(session.sessions.find((item) => item.id === "star")?.pinned).toBe(true);
  });

  it("archives and restores a whole project through the library", async () => {
    const session = useSessionStore();
    session.projects = [group([])];
    vi.spyOn(desktop, "invoke").mockResolvedValue({
      projects: [group([], { archived: true })],
    });

    await session.archiveProject("local:/project", true);

    expect(desktop.invoke).toHaveBeenCalledWith("library.archiveProject", { id: "local:/project", archived: true });
    expect(session.projects[0]!.archived).toBe(true);
    expect(session.filteredProjects).toHaveLength(0);
  });
});
