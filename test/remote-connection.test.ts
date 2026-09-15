import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { WslHostClient } from "../src/main/wsl-host-client.js";
import { MainController } from "../src/main/controller.js";
import { PIX_REMOTE_PROTOCOL } from "../src/shared/remote-protocol.js";
import { projectId, type ProjectInfo } from "../src/shared/types.js";
import type { SessionSnapshot } from "../src/shared/types.js";
import { projectSession } from "../src/shared/session.js";
import { sessionEventEncoder, type SessionUpdate } from "../src/shared/session-updates.js";

// The controller rewrites the project history in the app settings, so without
// an isolated home these tests would enroll their temp workspaces in the
// developer's real session panel.
const settingsHome = mkdtempSync(join(tmpdir(), "pix-remote-home-"));
process.env.PIX_HOME = settingsHome;
process.env.PI_CODING_AGENT_DIR = join(settingsHome, ".pix", "agent");
process.on("exit", () => rmSync(settingsHome, { recursive: true, force: true }));

class FakeChild extends EventEmitter {
  killed = false;
  exitCode: number | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() { this.killed = true; this.emit("exit", 0); return true; }
}
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: any[] = [];
  pings = 0;
  send(raw: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(raw));
    callback?.();
  }
  ping(_data: unknown, _mask: unknown, callback: (error?: Error) => void) {
    this.pings++;
    callback();
  }
  terminate() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
}
function transport(t: TestContext) {
  const child = new FakeChild();
  const socket = new FakeSocket();
  const client = Reflect.construct(WslHostClient, [child, socket, { cwd: "/project" }]) as WslHostClient;
  t.after(async () => { child.exitCode = 0; child.emit("exit", 0); await client.dispose(); });
  return { client, child, socket };
}

test("remote transport reconstructs session deltas and requests a checkpoint after a gap", async t => {
  const { client, socket } = transport(t);
  const received: SessionSnapshot[] = [];
  client.onEvent(event => { const current = (event.payload as SessionUpdate).current; if (current) received.push(current); });
  const encoder = sessionEventEncoder();
  const snap = (revision: number) => ({ session: { path: "s" }, entries: [], projection: projectSession([], null), runtime: {},
    graph: { id: "s", epoch: "e", revision, runs: [] } }) as unknown as SessionSnapshot;
  const deliver = (revision: number, resync = false) => socket.emit("message", JSON.stringify({ type: "event", sequence: revision,
    event: encoder({ type: "sessions", payload: { current: snap(revision), resync } }) }));
  deliver(1); deliver(2);
  assert.deepEqual(received.map(value => value.graph!.revision), [1, 2]);
  encoder({ type: "sessions", payload: { current: snap(3) } });
  deliver(4);
  assert.equal(socket.sent.at(-1)?.route, "session.snapshot");
  const request = socket.sent.at(-1)!;
  deliver(5, true);
  socket.emit("message", JSON.stringify({ type: "response", id: request.id, ok: true, result: snap(5) }));
  deliver(6);
  assert.deepEqual(received.map(value => value.graph!.revision), [1, 2, 5, 6]);
});

test("connection loss rejects requests, cancels model work and notifies once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, child, socket } = transport(t);
  let signal: AbortSignal | undefined;
  client.setModelBroker((_request, abort) => {
    signal = abort;
    return new Promise((_resolve, reject) => abort.addEventListener("abort", () => reject(new Error("aborted"))));
  });
  socket.emit("message", JSON.stringify({ type: "model.request", id: "m1" }));
  let notices = 0;
  client.onDisconnect(() => notices++);
  const request = assert.rejects(client.request("session.list"), /disconnected/);
  socket.terminate();
  socket.emit("error", new Error("late error"));
  await request;
  assert.equal(signal?.aborted, true);
  assert.equal(client.connected, false);
  assert.equal(child.killed, false, "Give the remote host time to flush its session");
  t.mock.timers.tick(5_000);
  assert.equal(child.killed, true, "A stuck host must still be cleaned up");
  assert.equal(notices, 1);
  await assert.rejects(client.request("session.list"), /not connected/);
});

test("ordinary requests time out and late responses do not poison subsequent requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, socket } = transport(t);
  const timeout = assert.rejects(client.request("workspace.read", { path: "file" }), /timed out.*workspace.read/);
  t.mock.timers.tick(30_000);
  await timeout;
  socket.emit("message", JSON.stringify({ type: "response", id: "1", ok: true, result: "late" }));
  const next = client.request("session.list");
  socket.emit("message", JSON.stringify({ type: "response", id: "2", ok: true, result: [] }));
  assert.deepEqual(await next, []);
});

test("long-running prompts and shell commands are not cut off by the RPC timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, socket } = transport(t);
  const prompt = client.request("agent.control", { action: "prompt", text: "work" });
  const shell = client.request("shell.run", { command: "long job" });
  t.mock.timers.tick(300_000);
  for (const id of ["1", "2"])
    socket.emit("message", JSON.stringify({ type: "response", id, ok: true, result: "done" }));
  assert.deepEqual(await Promise.all([prompt, shell]), ["done", "done"]);
});

test("heartbeat detects a half-open connection and accepts healthy pong replies", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { client, socket } = transport(t);
  t.mock.timers.tick(15_000);
  assert.equal(socket.pings, 1);
  socket.emit("pong");
  t.mock.timers.tick(15_000);
  assert.equal(client.connected, true);
  t.mock.timers.tick(15_000);
  assert.equal(client.connected, false);
});

test("startup accepts a handshake split across chunks and can be cancelled", async () => {
  const child = new FakeChild();
  const ready = (WslHostClient as any).waitForReady(child, 1_000);
  child.stdout.write('login output\nPIX_AGENT_HOST_READY {"protocol":');
  child.stdout.write(`${PIX_REMOTE_PROTOCOL},"port":40000,"token":"secret","pid":1}\n`);
  assert.equal((await ready).port, 40000);
  const abort = new AbortController();
  const cancelled = assert.rejects((WslHostClient as any).waitForReady(new FakeChild(), 30_000, abort.signal), /cancelled/);
  abort.abort();
  await cancelled;
});

test("cancelling the WebSocket handshake closes the real socket promptly", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => {
    for (const socket of server.clients) socket.terminate();
    server.close(() => resolve());
  }));
  const port = (server.address() as { port: number }).port;
  const abort = new AbortController();
  const connection = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
  const rejected = assert.rejects((WslHostClient as any).openSocket({ port, token: "test" }, 30_000, abort.signal), /abort|cancel/i);
  const socket = await connection;
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  abort.abort();
  await rejected;
  await closed;
});

function controllerFixture(t: TestContext) {
  // Canonical like the controller sees it: session.stop matches registry entries by the realpath the invoke boundary produces (macOS /var symlink).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pix-remote-")));
  const controller = new MainController(root, {
    async pickProject() { return undefined; },
    async pickSession() { return undefined; },
    async confirm() { return true; },
    async openExternal() {}, showItemInFolder() {}, quit() {},
  });
  controller.projectRuntime.control = async () => [];
  const project: ProjectInfo = { name: "old", path: "/old", remote: { kind: "ssh", host: "old" } };
  const old = candidate(controller);
  controller.project = project;
  controller.installSlot(old as never, project, controller.settings.bundle());
  controller.settings.rememberProject(project, []);
  t.after(async () => {
    await controller.closeWsl();
    controller.projectRuntime.dispose();
    controller.shell.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { controller, old, project };
}
function candidate(controller: MainController) {
  const events = new EventEmitter();
  return {
    hello: { cwd: "/new" }, connected: true, disposed: false,
    async request(route: string, input?: any): Promise<any> {
      if (route === "settings.get") return controller.settings.bundle();
      if (route === "workspace.open") return { path: input.path };
      if (route === "workspace.directories") return { path: input.path, entries: [] };
      return [];
    },
    setModelBroker() {},
    onEvent(listener: (event: any) => void) { events.on("event", listener); return () => events.off("event", listener); },
    emit(event: unknown) { events.emit("event", event); },
    onDisconnect(listener: (error: Error) => void) { events.on("disconnect", listener); return () => events.off("disconnect", listener); },
    async dispose() { this.disposed = true; this.connected = false; },
    disconnect() { this.connected = false; events.emit("disconnect", new Error("network lost")); },
  };
}

function remoteSnapshot(path = "/old/session.jsonl", running = false): SessionSnapshot {
  return {
    session: { id: path, path, cwd: "/old", created: "", modified: "", firstMessage: "remote", messageCount: 1 },
    entries: [], projection: projectSession([], null), runtime: { available: true, isStreaming: false },
    graph: { id: path, epoch: "e", revision: running ? 1 : 2,
      runs: running ? [{ branchId: "branch", runId: "run", status: "running" }] : [] },
  } as unknown as SessionSnapshot;
}

for (const order of [["A", "B"], ["B", "A"]]) {
  test(`remote session selection follows click order when replies arrive ${order.join(" then ")}`, async t => {
    const { controller, old } = controllerFixture(t);
    const release = new Map<string, (value: SessionSnapshot) => void>();
    old.request = (_route, input) => new Promise(resolve => release.set(input.path, resolve));
    const a = controller.invoke("session.open", { path: "A" });
    const b = controller.invoke("session.open", { path: "B" });
    const pending = { A: a, B: b };
    for (const path of order) {
      release.get(path)!(remoteSnapshot(path));
      await pending[path as keyof typeof pending];
    }
    assert.equal(controller.current?.session.path, "B");
    old.emit({ type: "sessions", payload: { current: remoteSnapshot("A") } });
    assert.equal(controller.current?.session.path, "B", "the old host selection cannot stream into B");
    old.emit({ type: "sessions", payload: { current: remoteSnapshot("B") } });
    assert.equal(controller.current?.session.path, "B");
  });
}

test("a remote fork hands the view to the session the runtime moved to", async t => {
  const { controller, old } = controllerFixture(t);
  const before = remoteSnapshot("/old/session.jsonl");
  old.request = async () => before;
  await controller.invoke("session.open", { path: before.session.path });

  const forked = remoteSnapshot("/old/fork.jsonl");
  old.request = async () => forked;
  await controller.invoke("agent.control", { action: "fork", entryId: "turn:1" });
  assert.equal(controller.current?.session.path, "/old/fork.jsonl", "the fork moves the view");

  old.emit({ type: "sessions", payload: { current: remoteSnapshot("/old/fork.jsonl", true) } });
  assert.equal(controller.current?.graph?.runs.some(run => run.status === "running"), true,
    "the forked session keeps streaming into the view");
});

test("a delayed pooled-project activation cannot replace a newer local selection", async t => {
  const { controller, old } = controllerFixture(t);
  let release!: (rows: unknown[]) => void;
  old.request = route => route === "session.list"
    ? new Promise(resolve => { release = resolve; }) : Promise.resolve(controller.settings.bundle());
  const activating = controller.connectSsh("old", "/old");
  const rejected = assert.rejects(activating, /selection changed/);
  await new Promise(resolve => setImmediate(resolve));
  controller.configure(controller.localProjectPath);
  const local = remoteSnapshot("local"); controller.current = local;
  release([]); await rejected;
  assert.equal(controller.project?.remote, undefined);
  assert.equal(controller.current, local);
});

test("remote completion and delayed replies keep their owner after switching local", async t => {
  const { controller, old, project } = controllerFixture(t);
  const running = remoteSnapshot(undefined, true), settled = remoteSnapshot();
  old.request = async () => running;
  await controller.invoke("session.open", { path: running.session.path });
  let finish!: (value: SessionSnapshot) => void;
  old.request = () => new Promise(resolve => { finish = resolve; });
  const pending = controller.invoke("agent.control", { action: "prompt", text: "held" });
  controller.configure(controller.localProjectPath);
  const local = { ...remoteSnapshot("local.jsonl"), session: { ...settled.session, path: "local.jsonl" } };
  controller.current = local;
  controller.rememberSnapshot(controller.project, local);
  const events: any[] = [];
  controller.onEvent(event => events.push(event));
  old.emit({ type: "sessions", payload: { current: settled } });
  finish(settled);
  await pending;
  assert.equal(controller.current, local);
  assert.ok(events.every(event => !event.payload.current), "background completion never drives the view");
  const groups = controller.projectGroups();
  assert.deepEqual(groups.find(group => group.id === projectId(controller.project!))?.sessions.map(row => row.path), ["local.jsonl"]);
  assert.equal(groups.find(group => group.id === projectId(project))?.sessions[0]?.running, undefined);
});

test("remote list events update only their owning group and keep running flags across local switches", async t => {
  const { controller, old, project } = controllerFixture(t);
  const current = remoteSnapshot(undefined, true);
  old.request = async () => current;
  await controller.invoke("session.open", { path: current.session.path });
  controller.configure(controller.localProjectPath);
  const events: any[] = [];
  controller.onEvent(event => events.push(event));
  old.emit({ type: "sessions", payload: { projects: [
    { id: "local:/unrelated", project: { name: "unrelated", path: "/unrelated" }, sessions: [remoteSnapshot("/unrelated/s.jsonl").session] },
    { id: "local:/old", project: { name: "old", path: "/old" }, sessions: [{ ...current.session, running: true }] },
  ] } });
  assert.equal(controller.projectGroups().find(group => group.id === projectId(project))?.sessions[0]?.running, true);
  assert.ok(events.at(-1).payload.projects.some((group: any) => group.id === projectId(project)));
  assert.ok(events.at(-1).payload.projects.every((group: any) => group.id !== "local:/unrelated"));
  old.emit({ type: "sessions", payload: { current: remoteSnapshot() } });
  assert.equal(controller.projectGroups().find(group => group.id === projectId(project))?.sessions[0]?.running, undefined);
});

test("hosts with identical session paths cannot drive each other's view or stop requests", async t => {
  const { controller, old, project } = controllerFixture(t);
  const current = remoteSnapshot(undefined, true);
  old.request = async () => current;
  await controller.invoke("session.open", { path: current.session.path });
  const otherProject: ProjectInfo = { ...project, remote: { kind: "ssh", host: "another" } };
  const other = candidate(controller);
  controller.installSlot(other as never, otherProject, controller.settings.bundle());
  controller.settings.rememberProject(otherProject, [current.session]);
  controller.current = current;
  const seen: unknown[] = [];
  controller.onEvent(event => { if (event.type === "agent" || (event.payload as any).current) seen.push(event); });
  other.emit({ type: "sessions", payload: { current: remoteSnapshot() } });
  other.emit({ type: "agent", payload: { type: "agent_start", graphId: current.graph!.id } });
  assert.equal(controller.current, current);
  assert.deepEqual(seen, []);
  const calls: unknown[] = [];
  old.request = async (route, input) => { calls.push(["old", route, input]); return []; };
  other.request = async (route, input) => {
    calls.push(["other", route, input]);
    return route === "session.stop" ? { stopped: true } : [remoteSnapshot().session];
  };
  assert.deepEqual(await controller.invoke("session.stop", { path: current.session.path, projectId: projectId(otherProject) }), { stopped: true });
  assert.deepEqual(calls[0], ["other", "session.stop", { path: current.session.path }]);
  assert.ok(calls.every((call: any) => call[0] === "other"));
  other.disconnect();
  await assert.rejects(controller.invoke("session.stop", { path: current.session.path, projectId: projectId(otherProject) }), /not connected/i);
});

test("remote deletion refreshes the owner and clears the view only while that project is active", async t => {
  const { controller, old } = controllerFixture(t);
  const current = remoteSnapshot();
  old.request = async () => current;
  await controller.invoke("session.open", { path: current.session.path });
  const events: any[] = [];
  controller.onEvent(event => events.push(event));
  old.emit({ type: "sessions", payload: { deletedPath: current.session.path, sessions: [] } });
  assert.equal(controller.current, undefined);
  assert.equal(events.at(-1).payload.deletedPath, current.session.path);
  controller.configure(controller.localProjectPath);
  controller.current = remoteSnapshot("local.jsonl");
  events.length = 0;
  old.emit({ type: "sessions", payload: { deletedPath: current.session.path, sessions: [] } });
  assert.equal(controller.current.session.path, "local.jsonl");
  assert.ok(events.every(event => !event.payload.deletedPath));
});

test("stopping a local background session bypasses the active remote host", async t => {
  const { controller, old } = controllerFixture(t);
  const localProject = { name: "local", path: controller.localProjectPath! };
  const snapshot = remoteSnapshot(join(localProject.path, "local.jsonl"), true);
  writeFileSync(snapshot.session.path, "");
  const actions: unknown[] = [];
  controller.createSessionRuntime = () => ({
    async open() {}, snapshot: () => snapshot, state: () => ({}),
    async control(input: unknown) { actions.push(input); }, async close() {},
  }) as never;
  await controller.registry.open(localProject, localProject.path, snapshot.session.path);
  old.request = async () => assert.fail("local stop must not reach the remote host");
  assert.deepEqual(await controller.invoke("session.stop", { path: snapshot.session.path, projectId: projectId(localProject) }), { stopped: true });
  assert.deepEqual(actions, [{ action: "branchAbort", branchId: "branch", runId: "run" }]);
  await controller.registry.disposeAll();
});

test("failed host connection and failed bootstrap both preserve the old workspace", async (t) => {
  const { controller, old, project } = controllerFixture(t);
  t.mock.method(WslHostClient, "connectSsh", async () => { throw new Error("authentication failed"); });
  await assert.rejects(controller.connectSsh("new", "/new"), /authentication/);
  assert.equal(controller.wsl, old);
  assert.equal(controller.project, project);
  assert.equal(old.disposed, false);
  const next = candidate(controller);
  next.request = async () => { throw new Error("bootstrap failed"); };
  t.mock.method(WslHostClient, "connectSsh", async () => next as any);
  await assert.rejects(controller.connectSsh("new", "/new"), /bootstrap failed/);
  assert.equal(controller.wsl, old);
  assert.equal(controller.project, project);
  assert.equal(old.disposed, false);
  assert.equal(next.disposed, true);
});

test("directory browsing and cancellation use only the candidate, not the active workspace", async (t) => {
  const { controller, old, project } = controllerFixture(t);
  const next = candidate(controller);
  t.mock.method(WslHostClient, "connectSsh", async () => next as any);
  await controller.connectSsh("new", "~", true);
  assert.equal(controller.project, project);
  assert.equal(controller.wsl, old);
  assert.deepEqual(await controller.invoke("remote.directories", { path: "/new/sub" }), { path: "/new/sub", entries: [] });
  await controller.invoke("remote.cancel");
  assert.equal(next.disposed, true);
  assert.equal(old.disposed, false);
  assert.equal(controller.project, project);
});

test("a successful candidate is pooled instead of closing the old host and reports later disconnection", async (t) => {
  const { controller, old } = controllerFixture(t);
  const next = candidate(controller);
  t.mock.method(WslHostClient, "connectSsh", async () => next as any);
  await controller.connectSsh("new", "~", true);
  const result = await controller.openRemoteProject("/new/sub");
  assert.equal(result.project?.path, "/new/sub");
  assert.equal(controller.wsl, next);
  assert.equal(old.disposed, false, "switching remote projects keeps the previous host pooled");
  const events: any[] = [];
  controller.onEvent((event) => events.push(event));
  next.disconnect();
  assert.equal(events.at(-1).type, "remote.connection");
  const id = projectId(controller.project!);
  assert.equal(controller.projectGroups().find((record) => record.id === id)?.connected, false);
  const cached = await controller.invoke("app.bootstrap") as any;
  assert.equal(cached.project.path, "/new/sub");
  assert.equal(cached.projects.find((record: any) => record.id === id).connected, false);
});

test("reconnecting to a pooled project reuses its host instead of spawning a second one", async (t) => {
  const { controller, old } = controllerFixture(t);
  const next = candidate(controller);
  const connectSsh = t.mock.method(WslHostClient, "connectSsh", async () => next as any);
  await controller.connectSsh("new", "/new");
  assert.equal(controller.wsl, next);

  const reused = await controller.connectSsh("old", "/old");

  assert.equal(connectSsh.mock.callCount(), 1, "the pooled host is adopted, not reconnected");
  assert.equal(controller.wsl, old);
  assert.equal((reused as { project: ProjectInfo }).project.path, "/old");
  assert.equal(next.disposed, false);
});

test("recycling keeps hosts with running work and disposes idle ones", async (t) => {  const previousIdle = process.env.PIX_REMOTE_IDLE_MS;
  process.env.PIX_REMOTE_IDLE_MS = "1000";
  t.after(() => {
    if (previousIdle === undefined) delete process.env.PIX_REMOTE_IDLE_MS;
    else process.env.PIX_REMOTE_IDLE_MS = previousIdle;
  });
  const { controller, old } = controllerFixture(t);
  const busy = candidate(controller), spare = candidate(controller);
  controller.installSlot(busy as never, { name: "busy", path: "/busy", remote: { kind: "ssh", host: "busy" } }, controller.settings.bundle());
  controller.installSlot(spare as never, { name: "spare", path: "/spare", remote: { kind: "ssh", host: "spare" } }, controller.settings.bundle());
  busy.request = async (route: string) => route === "session.list" ? [{ running: true } as never] : [];
  const next = candidate(controller);
  t.mock.method(WslHostClient, "connectSsh", async () => next as any);
  await controller.connectSsh("new", "/new");

  await new Promise(resolve => setTimeout(resolve, 3500));

  assert.equal(busy.disposed, false, "a host with running work is never recycled");
  assert.equal(next.disposed, false, "the workspace in view is never recycled");
  assert.equal(spare.disposed, true, "an idle host is recycled");
  assert.equal(old.disposed, true, "an idle host beyond the pool cap is recycled");
});

test("quitting disposes every pooled host, running or not", async (t) => {
  const { controller, old } = controllerFixture(t);
  const spare = candidate(controller);
  controller.installSlot(spare as never, { name: "spare", path: "/spare", remote: { kind: "ssh", host: "spare" } }, controller.settings.bundle());
  const next = candidate(controller);
  t.mock.method(WslHostClient, "connectSsh", async () => next as any);
  await controller.connectSsh("new", "/new");

  controller.dispose();
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(old.disposed, true, "a parked host is disposed on quit");
  assert.equal(spare.disposed, true, "a pooled host is disposed on quit");
  assert.equal(next.disposed, true, "the active host is disposed on quit");
});

test("forgetting a project disposes its pooled host and refuses while it runs", async (t) => {
  const { controller } = controllerFixture(t);
  const spare = candidate(controller);
  const project: ProjectInfo = { name: "spare", path: "/spare", remote: { kind: "ssh", host: "spare" } };
  controller.installSlot(spare as never, project, controller.settings.bundle());
  controller.settings.rememberProject(project, []);
  const running = async (route: string) => route === "session.list" ? [{ running: true } as never] : [];
  const idle = async (route: string) => route === "session.list" ? [] : [];
  spare.request = running;

  await assert.rejects(controller.invoke("app.forgetProject", { id: projectId(project) }), /Stop the running sessions/);
  assert.equal(spare.disposed, false, "a running host is not disposed by the refused removal");

  spare.request = idle;
  await controller.invoke("app.forgetProject", { id: projectId(project) });
  assert.equal(spare.disposed, true, "the pooled host goes with the history entry");
  assert.equal(controller.projectGroups().some(record => record.id === projectId(project)), false);
});

test("a differently spelled path still adopts the pooled host instead of spawning a second one", async (t) => {
  const { controller } = controllerFixture(t);
  const canonical: ProjectInfo = { name: "new", path: "/new", remote: { kind: "ssh", host: "new" } };
  const pooledClient = candidate(controller);
  controller.installSlot(pooledClient as never, canonical, controller.settings.bundle());
  controller.settings.rememberProject(canonical, []);
  const fresh = candidate(controller);
  t.mock.method(WslHostClient, "connectSsh", async () => fresh as any);

  const result = await controller.connectSsh("new", "/new/");

  assert.equal(fresh.disposed, true, "the redundant connection is dropped after the canonical recheck");
  assert.equal(controller.wsl, pooledClient, "the pooled host is adopted");
  assert.equal((result as { project: ProjectInfo }).project.path, "/new");
});

test("reactivating a pooled workspace restores its remembered session", async (t) => {
  const { controller, old } = controllerFixture(t);
  const snapshot = { session: { path: "/old/s.jsonl" }, entries: [], projection: { nodes: [] }, runtime: {},
    graph: { id: "/old/s.jsonl", epoch: "e", revision: 1, runs: [] } };
  old.request = async (route: string, input?: any) => {
    if (route === "session.open" && input?.path === "/old/s.jsonl") return snapshot;
    if (route === "session.list") return [];
    return controller.settings.bundle();
  };
  await controller.invoke("session.open", { path: "/old/s.jsonl" });

  const next = candidate(controller);
  t.mock.method(WslHostClient, "connectSsh", async () => next as any);
  await controller.connectSsh("new", "/new");
  const result = await controller.connectSsh("old", "/old");

  assert.equal((result as { current?: typeof snapshot }).current?.session.path, "/old/s.jsonl",
    "the session this workspace last showed comes back with it");
  assert.equal(controller.current?.session.path, "/old/s.jsonl");
});

test("cancellation during installation reaches the worker and prevents a late connection from replacing the old host", async (t) => {
  const { controller, old } = controllerFixture(t);
  const next = candidate(controller);
  let options: any;
  let resolve!: (value: any) => void;
  let started!: () => void;
  const starting = new Promise<void>((accept) => { started = accept; });
  t.mock.method(WslHostClient, "connectSsh", async (_host: string, _cwd: string, input: any) => {
    options = input;
    started();
    return new Promise((accept) => { resolve = accept; });
  });
  const connecting = assert.rejects(controller.connectSsh("new", "/new"), /cancelled/);
  await starting;
  await controller.invoke("remote.cancel");
  assert.equal(options.signal.aborted, true);
  resolve(next);
  await connecting;
  assert.equal(next.disposed, true);
  assert.equal(controller.wsl, old);
  assert.equal(old.disposed, false);
});

test("cancelling while the selected folder loads preserves the active workspace", async (t) => {
  const { controller, old, project } = controllerFixture(t);
  const next = candidate(controller);
  t.mock.method(WslHostClient, "connectSsh", async () => next as any);
  await controller.connectSsh("new", "~", true);
  let finish!: (value: any) => void;
  let started!: () => void;
  const loading = new Promise<void>((resolve) => { started = resolve; });
  const request = next.request.bind(next);
  next.request = async (route, input) => {
    if (route === "settings.get") {
      started();
      return new Promise((resolve) => { finish = resolve; });
    }
    return request(route, input);
  };
  const opening = assert.rejects(controller.openRemoteProject("/new/sub"), /cancelled/);
  await loading;
  await controller.cancelRemote();
  finish(controller.settings.bundle());
  await opening;
  assert.equal(controller.project, project);
  assert.equal(controller.wsl, old);
  assert.equal(old.disposed, false);
});

test("a failed WSL preparation preserves the SSH workspace", async (t) => {
  const { controller, old, project } = controllerFixture(t);
  t.mock.method(WslHostClient, "installed", async () => { throw new Error("WSL unavailable"); });
  await assert.rejects(controller.connectWsl("Ubuntu", "/home/dev"), /WSL unavailable/);
  assert.equal(controller.project, project);
  assert.equal(controller.wsl, old);
  assert.equal(old.disposed, false);
});

test("host list events still match the slot when paths differ by a trailing slash", async t => {
  const { controller, old, project } = controllerFixture(t);
  const row = remoteSnapshot("/old/s.jsonl").session;
  old.request = async () => [row];
  await controller.invoke("session.open", { path: row.path });
  controller.configure(controller.localProjectPath);

  old.emit({ type: "sessions", payload: { projects: [
    { id: "local:/unrelated", project: { name: "unrelated", path: "/unrelated" }, sessions: [remoteSnapshot("/unrelated/s.jsonl").session] },
    { id: "local:/old", project: { name: "old", path: "/old/" }, sessions: [{ ...row, running: true }] },
  ] } });

  const group = controller.projectGroups().find(record => record.id === projectId(project));
  assert.equal(group?.sessions[0]?.running, true, "the slot's rows update despite the slash spelling");
});

test("bootstrapping a connected remote workspace restores its remembered session", async t => {
  const { controller, old } = controllerFixture(t);
  const snapshot = remoteSnapshot("/old/s.jsonl");
  old.request = async (route: string, input?: any) => {
    if (route === "session.open" && input?.path === "/old/s.jsonl") return snapshot;
    if (route === "session.list") return [];
    return controller.settings.bundle();
  };
  await controller.invoke("session.open", { path: "/old/s.jsonl" });

  const bootstrapped = await controller.wslBootstrap() as { current?: typeof snapshot };

  assert.equal(bootstrapped.current?.session.path, "/old/s.jsonl",
    "a window reload lands back on the session the workspace last showed");
  assert.equal(controller.current?.session.path, "/old/s.jsonl");
});
