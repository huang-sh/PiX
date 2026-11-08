// The remote half of Pixie's task host: a delegated run whose project lives on
// a connected remote (WSL/SSH) host is snapshotted, driven and read through
// the pool's client, while Pixie itself stays on the local machine.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MainController, type Platform } from "../src/main/controller.js";
import { projectSession } from "../src/shared/session.js";
import { projectId } from "../src/shared/types.js";
import type { ProjectInfo, SessionSnapshot } from "../src/shared/types.js";

const platform: Platform = {
  async pickProject() { return undefined; },
  async pickSession() { return undefined; },
  async confirm() { return false; },
  async openExternal() {},
  async openPath() {},
  async openWith() {},
  async openWithApps() { return []; },
  async openWithApp() {},
  showItemInFolder() {},
  quit() {},
};

const remoteProject: ProjectInfo = { name: "srv", path: "/home/me/ws", remote: { kind: "ssh", host: "synology" } };
const target = { project: remoteProject, session: "/home/me/ws/.pi/sessions/remote.jsonl" };
const source = { id: "user-1", text: "fix the remote build", sessionId: "pixie-1" };

function snapshot(requestId: string, status: "running" | "idle") {
  const entries = [
    { type: "message", id: "u", parentId: null, timestamp: "2026-11-08", message: { role: "user", content: "work" } },
    { type: "message", id: "a", parentId: "u", timestamp: "2026-11-08", message: { role: "assistant", content: "done" } },
  ] as never;
  return { session: { id: "remote", path: target.session }, entries, projection: projectSession(entries, "a"),
    runtime: { available: true }, graph: { id: target.session, revision: 1,
      runs: [{ requestId, runId: "run-r", branchId: "main", nodeId: "turn:u", status }] } } as unknown as SessionSnapshot;
}

test("a connected remote project serves delegation, control and reads over the pool client", async (t: TestContext) => {
  const home = mkdtempSync(join(tmpdir(), "pix-remote-pixie-"));
  const previous = process.env.PIX_HOME;
  process.env.PIX_HOME = home;
  const controller = new MainController(null, platform);
  t.after(async () => {
    await controller.pixie.close();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  const requests: Array<{ route: string; input: unknown; session: string | undefined }> = [];
  let current = snapshot("pixie-t1", "running");
  let connected = true;
  const client = {
    get connected() { return connected; },
    request: async (route: string, input: unknown, _signal: unknown, session?: string) => {
      requests.push({ route, input, session });
      if (route === "session.snapshot") return current;
      if (route === "agent.control") {
        const action = (input as { action: string }).action;
        if (action === "promptAt") current = snapshot((input as { requestId: string }).requestId, "running");
        return current;
      }
      if (route === "session.branchWindow")
        return { entries: current.entries, hasEarlier: false, leafId: "a" };
      throw new Error(`unexpected route ${route}`);
    },
  };
  controller.pool["remotePool"].set(projectId(remoteProject), {
    client: client as never, project: remoteProject, settings: {} as never, activePath: target.session,
    stopEvents: () => {}, stopDisconnect: () => {}, lastActivity: 0,
  } as never);

  const [host] = [...controller.pixie.tasks["hosts"] as unknown as Set<{ available: (target: { project: ProjectInfo; session: string }) => boolean }>];
  assert.ok(host, "the controller registered its task host");
  assert.equal(host.available(target), true, "a connected slot serves the remote target");
  connected = false;
  assert.equal(host.available(target), false, "a dropped connection stops serving it");
  connected = true;

  const journal = controller.pixie.tasks;
  const { task } = await journal.delegate({ action: "delegate", context: "c", nodeId: null,
    text: "Fix the remote build", purpose: "Restore the remote build", acceptance: "Build passes" } as never,
    source, target);
  assert.equal(task.state, "running", "admission observed the remote run");
  assert.deepEqual(requests[0], { route: "session.snapshot", input: undefined, session: target.session });
  const prompt = requests.at(-1)!;
  assert.equal(prompt.route, "agent.control");
  assert.equal(prompt.session, target.session);
  assert.equal((prompt.input as { action: string; requestId: string }).requestId, task.requestId,
    "the prompt lands on the remote session with the request identity");

  await journal.read(task.id, 5);
  const window = requests.find(request => request.route === "session.branchWindow")!;
  assert.deepEqual(window.input, { session: target.session, leafId: "a", limit: 5, bytes: 64 * 1024 },
    "reads page the remote session's transcript window");

  await journal.control({ action: "steer", taskId: task.id, text: "hurry" } as never, source);
  const steer = requests.at(-1)!;
  assert.equal(steer.route, "agent.control");
  assert.equal((steer.input as { action: string }).action, "steer");
  assert.ok(controller.pool.slot(projectId(remoteProject))!.lastActivity > 0, "remote control refreshes the slot's activity");

  // An offline remote host keeps its durable journal state instead of failing.
  connected = false;
  await journal.reconcile();
  assert.equal(journal.get(task.id).state, "running", "offline targets retain their durable state");
});
