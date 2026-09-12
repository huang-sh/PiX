import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGroup, SessionSummary } from "../../src/shared/types";
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

  it("hides archived sessions until showArchived turns on", async () => {
    const session = useSessionStore();
    session.projects = [group([sessionA("kept"), sessionA("gone", { archived: true })])];
    session.sessions = session.projects[0]!.sessions;

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
