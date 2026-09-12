import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MainController, type Platform } from "../src/main/controller.js";
import type { ProjectGroup, ProjectInfo, SessionSummary } from "../src/shared/types.js";

// Library routes write the profile sidecar and the remembered project history,
// so keep them out of the developer's real home.
const home = mkdtempSync(join(tmpdir(), "pix-library-home-"));
process.env.PIX_HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const platform: Platform = {
  async pickProject() {
    return undefined;
  },
  async pickSession() {
    return undefined;
  },
  async confirm() {
    return false;
  },
  async openExternal() {},
  showItemInFolder() {},
  quit() {},
};

const summary = (id: string, cwd: string): SessionSummary => ({
  id,
  path: `${cwd}/.pi/sessions/${id}.jsonl`,
  name: id,
  cwd,
  created: "2026-01-01T00:00:00Z",
  modified: "2026-01-01T00:00:00Z",
  messageCount: 1,
  firstMessage: id,
});

interface LibraryReply {
  sessions?: SessionSummary[];
  projects: ProjectGroup[];
}

test("a remote workspace keeps the session list it already holds when a mark changes", async () => {
  const controller = new MainController(null, platform);
  const remote: ProjectInfo = { name: "proj", path: "/remote/proj", remote: { kind: "ssh", host: "h" } };
  const remoteSession = summary("remote-1", "/remote/proj");
  controller.settings.rememberProject(remote, [remoteSession]);
  controller.project = remote;
  // The local runtime still points at whatever local project was open last.
  controller.pi.list = async () => [summary("local-1", "/local/other")];

  const reply = (await controller.invoke("library.pin", {
    path: remoteSession.path,
    pinned: true,
  })) as LibraryReply;

  assert.equal(reply.sessions, undefined);
  assert.deepEqual(
    reply.projects[0]?.sessions.map((item) => [item.id, item.pinned]),
    [["remote-1", true]],
  );
});

test("a local project still answers with the decorated live list", async () => {
  const controller = new MainController(null, platform);
  const local: ProjectInfo = { name: "proj", path: "/local/proj" };
  const localSession = summary("local-1", "/local/proj");
  controller.settings.rememberProject(local, [localSession]);
  controller.project = local;
  controller.pi.list = async () => [localSession];

  const reply = (await controller.invoke("library.archiveSession", {
    path: localSession.path,
    archived: true,
  })) as LibraryReply;

  assert.deepEqual(
    reply.sessions?.map((item) => [item.id, item.archived]),
    [["local-1", true]],
  );
  assert.deepEqual(
    reply.projects[0]?.sessions.map((item) => [item.id, item.archived]),
    [["local-1", true]],
  );
});
