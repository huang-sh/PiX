import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { WslHostClient, RemoteHostUnreachable, HostStarted, launcherScript } from "../src/main/wsl-host-client.js";
import { logFile } from "../src/main/debug-log.js";
import { MainController } from "../src/main/controller.js";
import { PiRuntime } from "../src/main/pi-runtime.js";
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
  close() { this.readyState = WebSocket.CLOSING; }
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
  const newSession = client.request("agent.control", { action: "newSession" });
  t.mock.timers.tick(300_000);
  for (const id of ["1", "2", "3"])
    socket.emit("message", JSON.stringify({ type: "response", id, ok: true, result: "done" }));
  assert.deepEqual(await Promise.all([prompt, shell, newSession]), ["done", "done", "done"]);
});

test("heartbeat detects a half-open connection and accepts healthy pong replies", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { client, socket } = transport(t);
  t.mock.timers.tick(15_000);
  assert.equal(socket.pings, 1);
  socket.emit("pong");
  t.mock.timers.tick(15_000);
  assert.equal(client.connected, true);
  // A single missed pong is tolerated: the host may block its event loop on
  // synchronous session creation. Two consecutive misses mean the host is gone.
  t.mock.timers.tick(15_000);
  assert.equal(client.connected, true);
  t.mock.timers.tick(15_000);
  assert.equal(client.connected, false);
});

test("a launcher exit does not end the link, but a reattach transport exit does", async (t) => {
  // The launcher wrapper is expected to exit once the detached host runs;
  // only a transport child (a reattach's ssh -N tunnel) carries the link.
  const launcher = transport(t);
  launcher.child.emit("exit", 0);
  assert.equal(launcher.client.connected, true, "the detached host outlives its launcher");
  const child = new FakeChild();
  const socket = new FakeSocket();
  const transportClient = Reflect.construct(WslHostClient, [
    child, socket, { cwd: "/project" },
    { kind: "ssh", target: "h", port: 1, token: "t", pid: 1 }, true, true,
  ]) as WslHostClient;
  t.after(async () => { child.exitCode = 0; child.emit("exit", 0); await transportClient.dispose(); });
  const failure = new Promise<Error>(resolve => transportClient.onDisconnect(resolve));
  child.stderr.write("ssh: connect to host h port 22: Connection reset\n");
  child.emit("exit", 255);
  assert.match((await failure).message, /SSH transport exited with code 255/);
});

async function waitForLog(text: string) {
  for (let i = 0; i < 400; i++) {
    const content = existsSync(logFile()) ? readFileSync(logFile(), "utf8") : "";
    if (content.includes(text)) return content;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Missing log text: ${text}`);
}

test("socket-first disconnection logs late stderr at child close without notifying twice", async t => {
  const { client, child, socket } = transport(t);
  const failures: Error[] = [];
  client.onDisconnect(error => failures.push(error));
  const rejected = assert.rejects(client.request("session.list"), /Remote host disconnected/);
  socket.terminate();
  await rejected;
  assert.equal(failures.length, 1, "requests and UI fail immediately, before child exit");
  child.exitCode = 23;
  child.emit("exit", 23);
  await client.dispose(); // Failure cleanup must not mark this as a requested exit.
  child.stderr.write("earlier output ".repeat(400));
  child.stderr.write("\nlate stderr after exit: final diagnostic\n");
  child.stderr.end();
  child.emit("close", 23, null);
  const log = await waitForLog("late stderr after exit: final diagnostic");
  assert.match(log, /launcher closed\] requested=false code=23 signal=none/);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.message, "Remote host disconnected");
});

test("requested disposal is distinguished from failure and retains the final signal", async t => {
  const { client, child } = transport(t);
  const closing = client.dispose();
  child.exitCode = 0;
  child.emit("exit", null, "SIGTERM");
  await closing;
  child.emit("close", null, "SIGTERM");
  await waitForLog("requested=true code=none signal=SIGTERM");
});

for (const failure of ["ENOENT", "EACCES", "ELOOP", "file"] as const) {
  test(`host startup preserves ${failure} directory diagnostics`, { timeout: 20_000 }, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pix-host-path-error-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const target = join(root, "project");
    if (failure === "file") writeFileSync(target, "not a directory");
    // Permission errors depend on the test account/OS, and Windows junctions
    // cannot create a symlink loop. Inject only those fs failures in the child.
    const preload = failure === "EACCES" || failure === "ELOOP" ? `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const original = fs.realpathSync;
      fs.realpathSync = function(path, ...args) {
        if (String(path) === ${JSON.stringify(target)}) {
          throw Object.assign(new Error(${JSON.stringify(`${failure}: cannot resolve ${target}`)}), { code: ${JSON.stringify(failure)} });
        }
        return original.call(this, path, ...args);
      };
      syncBuiltinESMExports();
    ` : undefined;
    const child = spawn(process.execPath, [
      ...(preload ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`] : []),
      fileURLToPath(new URL("../src/server/index.js", import.meta.url)),
      "serve", "--cwd", target, "--exit-on-disconnect",
    ], { env: { ...process.env, PIX_HOME: join(root, "home"),
      PI_CODING_AGENT_DIR: join(root, "home", "agent") }, stdio: "pipe" });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 1);
    assert.match(stderr, failure === "file" ? /Project path is not a directory/ : new RegExp(failure));
    assert.ok(stderr.replaceAll("\\", "/").includes(target.split(sep).join("/")), stderr);
    assert.doesNotMatch(stdout, /PIX_AGENT_HOST_READY/);
  });
}

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

function controllerFixture(t: TestContext, seed?: (home: string) => void) {
  // A fresh profile per test: persisted reattach handles and remembered
  // projects must not leak between tests.
  const home = mkdtempSync(join(tmpdir(), "pix-remote-home-"));
  const previousHome = process.env.PIX_HOME;
  process.env.PIX_HOME = home;
  seed?.(home);
  t.after(() => {
    process.env.PIX_HOME = previousHome ?? settingsHome;
    rmSync(home, { recursive: true, force: true });
  });
  // Canonical like the controller sees it: session.stop matches registry entries by the realpath the invoke boundary produces (macOS /var symlink).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pix-remote-")));
  const controller = new MainController(root, {
    async pickProject() { return undefined; },
    async pickSession() { return undefined; },
    async confirm() { return true; },
    async openExternal() {}, async openPath() {}, async openWith() {}, async openWithApps() { return []; }, async openWithApp() {}, showItemInFolder() {}, quit() {},
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
    hello: { cwd: "/new" } as { cwd: string } & Record<string, unknown>, connected: true, disposed: false, abandoned: false, reattached: false,
    handle: undefined as any,
    calls: [] as any[],
    async request(route: string, input?: any): Promise<any> {
      this.calls.push([route, input]);
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
    async abandon() { this.abandoned = true; this.connected = false; },
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
  const result = await controller.pool.openRemoteProject("/new/sub");
  assert.equal(result.project?.path, "/new/sub");
  assert.equal(controller.wsl, next);
  assert.equal(old.disposed, false, "switching remote projects keeps the previous host pooled");
  fastReconnect(t);
  t.mock.method(WslHostClient, "connectSsh", async () => { throw new Error("network down"); });
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

// The reconnect loop waits between attempts; tests cap the wait so loops settle fast.
function fastReconnect(t: TestContext) {
  const previous = process.env.PIX_REMOTE_RECONNECT_MAX_MS;
  process.env.PIX_REMOTE_RECONNECT_MAX_MS = "20";
  t.after(() => {
    if (previous === undefined) delete process.env.PIX_REMOTE_RECONNECT_MAX_MS;
    else process.env.PIX_REMOTE_RECONNECT_MAX_MS = previous;
  });
}

test("an unplanned disconnect of the viewed workspace reconnects automatically", async (t) => {
  fastReconnect(t);
  const { controller, old, project } = controllerFixture(t);
  const events: any[] = [];
  controller.onEvent((event) => events.push(event));
  const fresh = candidate(controller);
  fresh.hello = { cwd: project.path };
  t.mock.method(WslHostClient, "connectSsh", async () => fresh as any);
  old.disconnect();
  await new Promise(resolve => setTimeout(resolve, 50));
  const dropped = events.find((event) => event.type === "remote.connection" && event.payload.connected === false);
  assert.equal(dropped.payload.reconnecting, true);
  assert.ok(events.some((event) => event.type === "remote.connection" &&
    event.payload.connected === true && event.payload.projectId === projectId(project)),
    "a restored transport is announced so the view can rehydrate");
  assert.equal(controller.wsl, fresh);
  assert.equal(old.disposed, true);
  assert.equal(controller.projectGroups().find((record) => record.id === projectId(project))?.connected, true);
});

test("failed reconnect attempts back off and stop once another project is viewed", async (t) => {
  fastReconnect(t);
  const { controller, old } = controllerFixture(t);
  const connectSsh = t.mock.method(WslHostClient, "connectSsh", async () => { throw new Error("network down"); });
  old.disconnect();
  await new Promise(resolve => setTimeout(resolve, 100));
  const attempts = connectSsh.mock.callCount();
  assert.ok(attempts >= 2, "the connection is retried");
  controller.configure(controller.localProjectPath);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(connectSsh.mock.callCount(), attempts, "retries stop once the workspace leaves the view");
});

test("closing the remote workspace stops the automatic reconnect", async (t) => {
  fastReconnect(t);
  const { controller, old } = controllerFixture(t);
  const connectSsh = t.mock.method(WslHostClient, "connectSsh", async () => { throw new Error("network down"); });
  old.disconnect();
  await controller.closeWsl();
  await new Promise(resolve => setTimeout(resolve, 100));
  const attempts = connectSsh.mock.callCount();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(connectSsh.mock.callCount(), attempts, "an explicit disconnect is not second-guessed");
});

test("a background host disconnect is reported without automatic reconnect", async (t) => {
  fastReconnect(t);
  const { controller, old, project } = controllerFixture(t);
  const background: ProjectInfo = { name: "bg", path: "/bg", remote: { kind: "ssh", host: "bg" } };
  const spare = candidate(controller);
  controller.installSlot(spare as never, background, controller.settings.bundle());
  const connectSsh = t.mock.method(WslHostClient, "connectSsh", async () => { throw new Error("must not reconnect"); });
  const events: any[] = [];
  controller.onEvent((event) => events.push(event));
  spare.disconnect();
  await new Promise(resolve => setTimeout(resolve, 50));
  const dropped = events.find((event) => event.type === "remote.connection" && event.payload.connected === false);
  assert.equal(dropped.payload.reconnecting, false);
  assert.equal(connectSsh.mock.callCount(), 0);
  assert.equal(controller.wsl, old, "the viewed workspace is untouched");
  assert.equal(controller.projectGroups().find((record) => record.id === projectId(project))?.connected, true);
});

test("bootstrapping a dead viewed workspace restarts recovery", async (t) => {
  fastReconnect(t);
  const { controller, project } = controllerFixture(t);
  const dead = candidate(controller);
  dead.connected = false;
  controller.installSlot(dead as never, project, controller.settings.bundle());
  const fresh = candidate(controller);
  fresh.hello = { cwd: project.path };
  t.mock.method(WslHostClient, "connectSsh", async () => fresh as any);
  const cached = await controller.invoke("app.bootstrap") as any;
  assert.equal(cached.project.path, project.path, "a dead host serves its remembered rows while recovering");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(controller.wsl, fresh);
});

// A lingering host is remembered so a later session reattaches to it.
const seededHandle = { kind: "ssh", target: "old", port: 41000, token: "secret", pid: 4242, path: "/old" } as const;
function seedLingeringHost(home: string) {
  mkdirSync(join(home, ".pix"), { recursive: true });
  const key = projectId({ name: "", path: "/old", remote: { kind: "ssh", host: "old" } });
  writeFileSync(join(home, ".pix", "remote-hosts.json"), JSON.stringify({ [key]: seededHandle }));
}

test("the launcher script detaches the host and reports readiness via a file", () => {
  const script = launcherScript({
    exe: "/home/u/.pix/server/current/bin/pix-agent-host",
    cwd: "/proj",
    port: 41234,
    base: "/home/u/.pix",
  });
  assert.match(script, /--cwd \/proj --port 41234 --ready-file "\$F"/);
  assert.match(script, /setsid \$C \|\| nohup \$C/, "the host detaches from the launching session");
  assert.match(script, /<\/dev\/null >>\$L 2>&1 &/, "stdio is redirected so the wrapper can exit");
  assert.match(script, /cat "\$F"/, "readiness reaches the desktop through the wrapper's stdout");
  assert.match(script, /tail -n 5 "\$L"/, "startup failures surface their log tail");
  assert.ok(!script.includes("'"), "the ssh transport wraps the script in single quotes");
  assert.ok(!/[&]\s*;/.test(script), "a ';' after the background '&' is a POSIX sh syntax error");
  const deployed = launcherScript({
    exe: "$HOME/.pix/server/current/bin/pix-agent-host",
    cwd: "/p",
    port: 1,
    base: "$HOME/.pix",
    deployCredentials: true,
  });
  assert.match(deployed, /--allow-credential-deploy/);
});

test("dispose orders a lingering host to shut down; abandon leaves it running", async (t) => {
  const disposed = transport(t);
  disposed.child.exitCode = 0;
  await disposed.client.dispose();
  assert.equal(disposed.socket.sent.filter((message: any) => message.type === "shutdown").length, 1,
    "an intentional teardown tells the host to exit now");
  const child = new FakeChild();
  const socket = new FakeSocket();
  const client = Reflect.construct(WslHostClient, [child, socket, { cwd: "/p" },
    { kind: "ssh", target: "h", port: 1, token: "t", pid: 1 }, true, true]) as WslHostClient;
  t.after(async () => { child.exitCode = 0; child.emit("exit", 0); await client.dispose(); });
  child.exitCode = 0;
  await client.abandon();
  assert.equal(socket.sent.filter((message: any) => message.type === "shutdown").length, 0,
    "an abandoned link leaves the lingering host alone");
});

test("reattach speaks the token handshake against a lingering host", async (t) => {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: ({ req }, done) =>
      done(new URL(req.url ?? "/", "ws://127.0.0.1").searchParams.get("token") === "secret", 401),
  });
  server.on("connection", socket => socket.send(JSON.stringify({
    type: "hello", protocol: PIX_REMOTE_PROTOCOL, hostVersion: "test", piVersion: "test",
    platform: "linux", arch: "x64", cwd: "/project",
  })));
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => {
    for (const socket of server.clients) socket.terminate();
    server.close(() => resolve());
  }));
  const port = (server.address() as { port: number }).port;
  const client = await WslHostClient.reattach(
    { kind: "wsl", target: "Ubuntu", port, token: "secret", pid: 1 },
    { connectTimeoutMs: 2_000 },
  );
  assert.equal(client.reattached, true);
  assert.equal(client.hello.cwd, "/project");
  await client.abandon();
  await assert.rejects(
    WslHostClient.reattach({ kind: "wsl", target: "Ubuntu", port, token: "wrong", pid: 1 }, { connectTimeoutMs: 500 }),
    /connect|handshake|401|Unable/i,
    "a wrong token cannot attach",
  );
});

test("a remembered lingering host is reattached instead of spawned", async (t) => {
  const { controller, old } = controllerFixture(t, seedLingeringHost);
  const fresh = candidate(controller);
  fresh.hello = { cwd: "/old" };
  fresh.reattached = true;
  fresh.handle = seededHandle;
  old.connected = false;  // drop the pooled fast path so the reattach path runs
  const reattach = t.mock.method(WslHostClient, "reattach", async () => fresh as any);
  const spawn = t.mock.method(WslHostClient, "connectSsh", async () => { throw new Error("must not spawn"); });
  const result = await controller.connectSsh("old", "/old");
  assert.equal(reattach.mock.callCount(), 1);
  assert.equal(spawn.mock.callCount(), 0, "attaching beats spawning a second host");
  assert.equal(controller.wsl, fresh);
  assert.equal((result as { project: ProjectInfo }).project.path, "/old");
});

test("an unreachable server keeps the lingering host's handle", async (t) => {
  const { controller, old } = controllerFixture(t, seedLingeringHost);
  old.connected = false;  // drop the pooled fast path so the reattach path runs
  t.mock.method(WslHostClient, "reattach", async () => { throw new RemoteHostUnreachable("ssh: connect refused"); });
  const kill = t.mock.method(WslHostClient, "killHost", async () => {});
  const spawn = t.mock.method(WslHostClient, "connectSsh", async () => { throw new Error("server down"); });
  await assert.rejects(controller.connectSsh("old", "/old"), /refused/);
  assert.equal(kill.mock.callCount(), 0, "an unreachable server must not condemn its hosts");
  assert.equal(spawn.mock.callCount(), 0, "spawning cannot succeed either; the next retry reattaches");
  const stored = readFileSync(join(process.env.PIX_HOME!, ".pix", "remote-hosts.json"), "utf8");
  assert.match(stored, /"pid":4242/, "the handle stays for the next attempt");
});

test("a stale remembered host is stopped and replaced by a fresh spawn", async (t) => {
  const { controller, old } = controllerFixture(t, seedLingeringHost);
  old.connected = false;  // drop the pooled fast path so the reattach path runs
  t.mock.method(WslHostClient, "reattach", async () => { throw new Error("handshake failed"); });
  const kill = t.mock.method(WslHostClient, "killHost", async () => {});
  const fresh = candidate(controller);
  fresh.hello = { cwd: "/old" };
  fresh.handle = { kind: "ssh", target: "old", port: 42000, token: "next", pid: 5252 };
  t.mock.method(WslHostClient, "connectSsh", async () => fresh as any);
  await controller.connectSsh("old", "/old");
  assert.equal(kill.mock.callCount(), 1, "the wedged host is stopped by its verified pid");
  assert.equal(controller.wsl, fresh);
  const stored = JSON.parse(readFileSync(join(process.env.PIX_HOME!, ".pix", "remote-hosts.json"), "utf8"));
  const key = projectId({ name: "", path: "/old", remote: { kind: "ssh", host: "old" } });
  assert.equal(stored[key].pid, 5252, "the stored handle follows the fresh host");
});

test("a cancelled attempt abandons a reattached host instead of stopping it", async (t) => {
  const { controller, old } = controllerFixture(t, seedLingeringHost);
  const pending = candidate(controller);
  pending.hello = { cwd: "/old" };
  pending.reattached = true;
  old.connected = false;  // drop the pooled fast path so the reattach path runs
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  pending.request = (route: string) =>
    route === "session.list" ? gate.then(() => []) : Promise.resolve(controller.settings.bundle());
  t.mock.method(WslHostClient, "reattach", async () => pending as any);
  const first = controller.connectSsh("old", "/old");
  await new Promise(resolve => setImmediate(resolve));
  const next = candidate(controller);
  next.hello = { cwd: "/other" };
  t.mock.method(WslHostClient, "connectSsh", async () => next as any);
  await controller.connectSsh("other", "/other");
  release();
  await assert.rejects(first, /cancelled/i);
  assert.equal(pending.abandoned, true, "the lingering host keeps running");
  assert.equal(pending.disposed, false, "no shutdown was ordered");
});

test("automatic recovery reattaches to the lingering host", async (t) => {
  fastReconnect(t);
  const { controller, old, project } = controllerFixture(t, seedLingeringHost);
  old.handle = seededHandle as any;
  const fresh = candidate(controller);
  fresh.hello = { cwd: "/old" };
  fresh.reattached = true;
  fresh.handle = seededHandle;
  t.mock.method(WslHostClient, "reattach", async () => fresh as any);
  const events: any[] = [];
  controller.onEvent(event => events.push(event));
  old.disconnect();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(events.some((event) => event.type === "remote.connection" &&
    event.payload.connected === true && event.payload.projectId === projectId(project)),
    "the reconnect loop reattached to the same host");
  assert.equal(controller.wsl, fresh);
});

test("quitting stops idle hosts but parks hosts mid-run for a reattach", async (t) => {
  const { controller, old } = controllerFixture(t);
  old.connected = false;  // drop the pooled fast path so a fresh host commits
  const busy = candidate(controller);
  busy.hello = { cwd: "/old" };
  busy.handle = { kind: "ssh", target: "old", port: 41000, token: "secret", pid: 4242 };
  busy.request = async (route: string) =>
    route === "session.list" ? [{ running: true } as never] : [];
  t.mock.method(WslHostClient, "connectSsh", async () => busy as any);
  await controller.connectSsh("old", "/old");
  const stored = join(process.env.PIX_HOME!, ".pix", "remote-hosts.json");
  assert.ok(existsSync(stored), "the committed host is remembered");
  await controller.pool.closeAllRemote();
  assert.equal(busy.abandoned, true, "a host mid-run is parked, not stopped");
  assert.equal(busy.disposed, false);
  assert.ok(existsSync(stored), "its handle stays for the next session's reattach");
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

for (const kind of ["ssh", "wsl"] as const) {
  test(`${kind} symlink connections and directory browsing reuse the same real host`, { timeout: 60_000 }, async t => {
    const { controller } = controllerFixture(t);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pix-host-alias-")));
    const project = join(root, "project");
    const alias = join(root, "alias");
    const canonical = project.split(sep).join("/");
    mkdirSync(join(project, ".pi", "sessions"), { recursive: true });
    symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(project, ".pi", "sessions", "saved.jsonl"), JSON.stringify({
      type: "session", version: 3, id: "saved", cwd: alias, timestamp: new Date().toISOString(),
    }) + "\n");
    const clients: WslHostClient[] = [];
    t.after(async () => {
      await controller.pool.closeAllRemote();
      await Promise.all(clients.map(client => client.dispose()));
      rmSync(root, { recursive: true, force: true });
    });
    // Exercise the real server and WebSocket handshake; replace only SSH/WSL
    // process launching so the regression runs without a configured remote.
    const connect = async (cwd: string) => {
      const child = spawn(process.execPath, [
        fileURLToPath(new URL("../src/server/index.js", import.meta.url)),
        "serve", "--cwd", cwd, "--exit-on-disconnect",
      ], { env: { ...process.env, PIX_HOME: join(root, "home"),
        PI_CODING_AGENT_DIR: join(root, "home", "agent") }, stdio: "pipe" });
      try {
        const ready = await (WslHostClient as any).waitForReady(child, 15_000);
        const { socket, hello } = await (WslHostClient as any).openSocket(ready, 15_000);
        const client = Reflect.construct(WslHostClient, [child, socket, hello]) as WslHostClient;
        clients.push(client);
        return client;
      } catch (error) {
        child.kill();
        throw error;
      }
    };
    t.mock.method(WslHostClient, "connectSsh", (_host: string, cwd: string) => connect(cwd));
    t.mock.method(WslHostClient, "installed", (options: { cwd: string }) => connect(options.cwd));
    const open = (cwd: string, browse = false) => kind === "ssh"
      ? controller.connectSsh("alias-test", cwd, browse)
      : controller.connectWsl("alias-test", cwd, browse);

    const first = await open(alias);
    const original = controller.wsl!;
    assert.equal(original.hello.cwd, canonical, "hello expands symlinks on the host");
    assert.equal(original.hello.piVersion,
      JSON.parse(readFileSync("server/package.json", "utf8")).dependencies["@earendil-works/pi-coding-agent"],
      "hello reports the installed SDK version");
    assert.equal(first.project.path, canonical);
    assert.equal((await controller.invoke("session.list") as unknown[]).length, 1,
      "sessions created through the alias remain visible");

    await open(canonical);
    assert.equal(clients.length, 1, "the real path matches the first slot before spawning");
    await open(alias);
    assert.equal(clients.length, 2);
    assert.equal(clients[1]!.connected, false, "the redundant host is closed after hello");
    assert.equal(controller.wsl, original);

    await open(root, true);
    await controller.invoke("remote.openProject", { path: alias });
    assert.equal(clients[2]!.connected, false, "browsing to the alias also discards its temporary host");
    assert.equal(controller.wsl, original);
    assert.equal(original.connected, true, "the original host is never replaced");
    assert.equal((await controller.invoke("session.list") as unknown[]).length, 1);
  });
}

test("a differently spelled path reuses the pooled host after closing the redundant one", async (t) => {
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
  const opening = assert.rejects(controller.pool.openRemoteProject("/new/sub"), /cancelled/);
  await loading;
  await controller.pool.cancelRemote();
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

  const bootstrapped = await controller.pool.wslBootstrap() as { current?: typeof snapshot };

  assert.equal(bootstrapped.current?.session.path, "/old/s.jsonl",
    "a window reload lands back on the session the workspace last showed");
  assert.equal(controller.current?.session.path, "/old/s.jsonl");
});

// --- Model autonomy: local credentials win over the desktop broker. ---

function fakeModelRuntime(local: string[]) {
  const runtime: any = {
    registered: [] as string[],
    keys: new Set<string>(),
    checkAuth: async (provider: string) => (local.includes(provider) ? { type: "api_key" } : null),
    registerProvider: (id: string) => runtime.registered.push(id),
    unregisterProvider: (id: string) => { runtime.registered = runtime.registered.filter((p: string) => p !== id); },
    setRuntimeApiKey: async (id: string) => { runtime.keys.add(id); },
    removeRuntimeApiKey: async (id: string) => { runtime.keys.delete(id); },
    stream: () => "native",
    streamSimple: () => "native",
  };
  return runtime;
}

test("a host with local credentials serves those providers directly", async () => {
  const runtime = new PiRuntime(null, null, () => {}, async () => {});
  const local = ["anthropic"];
  const modelRuntime = fakeModelRuntime(local);
  runtime.modelRuntime = async () => modelRuntime;
  let brokered = 0;
  runtime.modelBroker = () => { brokered++; return "brokered"; };
  const models = [
    { provider: "anthropic", id: "claude", name: "Claude" },
    { provider: "openai", id: "gpt", name: "GPT" },
  ] as never[];
  await runtime.configureBrokerProviders(["anthropic", "openai"], models);
  assert.deepEqual(modelRuntime.registered, ["openai"], "locally-authenticated providers keep their native catalog");
  assert.deepEqual([...modelRuntime.keys], ["openai"], "no fake runtime key shadows a local credential");
  assert.equal(modelRuntime.stream({ provider: "anthropic" }, {}, {}), "native");
  assert.equal(modelRuntime.stream({ provider: "openai" }, {}, {}), "brokered");
  // setModel's preflight must see brokered providers as configured.
  assert.deepEqual(await modelRuntime.checkAuth("openai"), { type: "api_key", source: "pix-desktop-broker" });
  assert.deepEqual(await modelRuntime.checkAuth("anthropic"), { type: "api_key" });
  assert.equal(await modelRuntime.checkAuth("unknown"), null);

  // A deployed credential moves its provider to direct calls...
  local.push("openai");
  await runtime.refreshBrokerAuth();
  assert.deepEqual(modelRuntime.registered, [], "the overlay is stripped once credentials exist");
  assert.equal(modelRuntime.stream({ provider: "openai" }, {}, {}), "native");

  // ...and revoking it hands the provider back to the desktop.
  local.splice(local.indexOf("openai"), 1);
  await runtime.refreshBrokerAuth();
  assert.deepEqual(modelRuntime.registered, ["openai"]);
  assert.equal(modelRuntime.stream({ provider: "openai" }, {}, {}), "brokered");
  assert.equal(brokered, 2);

  // A lingering host without its desktop fails clearly, not with a DNS error.
  runtime.modelBroker = undefined;
  assert.equal(modelRuntime.stream({ provider: "anthropic" }, {}, {}), "native",
    "local credentials keep working with no desktop attached");
  assert.throws(() => modelRuntime.stream({ provider: "openai" }, {}, {}), /reconnect it to use this model/);
  assert.equal(await modelRuntime.checkAuth("openai"), null,
    "with no desktop attached, a brokered provider honestly reports unconfigured");
});

test("connecting deploys credentials to an authorized host when enabled", async (t) => {
  const { controller, old, project } = controllerFixture(t);
  old.connected = false;
  await controller.invoke("settings.update", { scope: "app", patch: { deployModelCredentialsToRemote: true } });
  controller.projectRuntime.listApiKeys = () => ({ anthropic: "sk-local", mycustom: "sk-2" });
  controller.projectRuntime.control = async (input: any) =>
    input.action === "getModels" ? [] : input.action === "getCustomModels"
      ? [{ provider: "mycustom", modelId: "m1", name: "M1", baseUrl: "https://x", api: "openai-completions",
          contextWindow: 128000, maxTokens: 16384, reasoning: false, imageInput: false }]
      : [];
  const fresh = candidate(controller);
  fresh.hello = { cwd: "/old", allowCredentialDeploy: true };
  fresh.handle = { kind: "ssh", target: "old", port: 1, token: "t", pid: 1 };
  t.mock.method(WslHostClient, "connectSsh", async () => fresh as any);
  await controller.connectSsh("old", "/old");
  await new Promise(resolve => setTimeout(resolve, 50));
  const logins = fresh.calls.filter(([route, input]: any[]) => route === "agent.control" && input.action === "loginApiKey");
  assert.deepEqual(logins.map(([, input]: any[]) => input.provider).sort(), ["anthropic", "mycustom"],
    "every stored API key reaches the host");
  assert.deepEqual(logins.map(([, input]: any[]) => input.apiKey), ["sk-local", "sk-2"]);
  assert.equal(fresh.calls.some(([route, input]: any[]) => route === "agent.control" && String(input?.action).includes("CustomModel")), true,
    "custom model definitions ride along");
  const stored = JSON.parse(readFileSync(join(process.env.PIX_HOME!, ".pix", "remote-hosts.json"), "utf8"));
  assert.deepEqual(stored[projectId(project)].pushedProviders.sort(), ["anthropic", "mycustom"]);
  const firstLogin = fresh.calls.findIndex(([route, input]: any[]) => route === "agent.control" && input.action === "loginApiKey");
  assert.ok(fresh.calls.slice(firstLogin + 1).some(([route, input]: any[]) =>
    route === "agent.control" && input.action === "setBrokerProviders"),
    "the catalog re-pushes after the keys land so open sessions go direct");
});

test("deployment stays off without the setting or the host's authorization", async (t) => {
  const { controller, old } = controllerFixture(t);
  old.connected = false;
  controller.projectRuntime.listApiKeys = () => ({ anthropic: "sk-local" });
  const unauthorized = candidate(controller);
  unauthorized.hello = { cwd: "/old" };
  t.mock.method(WslHostClient, "connectSsh", async () => unauthorized as any);
  await controller.invoke("settings.update", { scope: "app", patch: { deployModelCredentialsToRemote: true } });
  await controller.connectSsh("old", "/old");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(unauthorized.calls.some(([route, input]: any[]) => route === "agent.control" && input?.action === "loginApiKey"), false,
    "a host started without the authorization receives nothing");

  const previous = candidate(controller);
  previous.hello = { cwd: "/old", allowCredentialDeploy: true };
  const seeded: typeof previous = previous;
  await controller.invoke("settings.update", { scope: "app", patch: { deployModelCredentialsToRemote: false } });
  const active = controller.pool.active();
  assert.ok(active);
  active!.client = seeded as never;
  await controller.invoke("agent.control", { action: "loginApiKey", provider: "anthropic", apiKey: "sk" });
  assert.equal(seeded.calls.some(([route, input]: any[]) => route === "agent.control" && input?.action === "loginApiKey" && input?.provider === "anthropic" && input?.apiKey === "sk"), false,
    "with the setting off, credentials never leave the desktop");
});

test("a desktop logout removes only credentials this desktop deployed", async (t) => {
  const { controller, old, project } = controllerFixture(t, home => {
    seedLingeringHost(home);
    const file = join(home, ".pix", "remote-hosts.json");
    const key = projectId({ name: "", path: "/old", remote: { kind: "ssh", host: "old" } });
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored[key].pushedProviders = ["anthropic"];
    writeFileSync(file, JSON.stringify(stored));
  });
  await controller.invoke("settings.update", { scope: "app", patch: { deployModelCredentialsToRemote: true } });
  old.hello = { cwd: "/old", allowCredentialDeploy: true } as any;
  controller.projectRuntime.control = async () => [];
  await controller.invoke("agent.control", { action: "logout", provider: "serverlocal" });
  assert.ok(!old.calls.some(([route, input]: any[]) => route === "agent.control" && input?.action === "logout"),
    "a login the server already had is never removed");
  await controller.invoke("agent.control", { action: "logout", provider: "anthropic" });
  assert.ok(old.calls.some(([route, input]: any[]) => route === "agent.control" && input?.action === "logout" && input?.provider === "anthropic"),
    "a deployed provider is cleaned up");
  const stored = JSON.parse(readFileSync(join(process.env.PIX_HOME!, ".pix", "remote-hosts.json"), "utf8"));
  assert.deepEqual(stored[projectId(project)].pushedProviders, []);
});

test("revoking removes deployed credentials from a connected host", async (t) => {
  const { controller, old, project } = controllerFixture(t, home => {
    seedLingeringHost(home);
    const file = join(home, ".pix", "remote-hosts.json");
    const key = projectId({ name: "", path: "/old", remote: { kind: "ssh", host: "old" } });
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored[key].pushedProviders = ["anthropic", "mycustom"];
    writeFileSync(file, JSON.stringify(stored));
  });
  const result = await controller.invoke("remote.revoke", { id: projectId(project) }) as { revoked: string[] };
  assert.deepEqual([...result.revoked].sort(), ["anthropic", "mycustom"]);
  const logouts = old.calls.filter(([route, input]: any[]) => route === "agent.control" && input?.action === "logout");
  assert.deepEqual(logouts.map(([, input]: any[]) => input.provider).sort(), ["anthropic", "mycustom"]);
  const stored = JSON.parse(readFileSync(join(process.env.PIX_HOME!, ".pix", "remote-hosts.json"), "utf8"));
  assert.deepEqual(stored[projectId(project)].pushedProviders, []);
});

test("dropping a disconnected slot keeps its lingering host's handle", async (t) => {
  const bgProject: ProjectInfo = { name: "bg", path: "/bg", remote: { kind: "ssh", host: "bg" } };
  const bgId = projectId(bgProject);
  const { controller } = controllerFixture(t, home => {
    mkdirSync(join(home, ".pix"), { recursive: true });
    writeFileSync(join(home, ".pix", "remote-hosts.json"), JSON.stringify({
      [bgId]: { kind: "ssh", target: "bg", port: 41001, token: "tok", pid: 4343, path: "/bg" },
    }));
  });
  const spare = candidate(controller);
  controller.installSlot(spare as never, bgProject, controller.settings.bundle());
  spare.disconnect();   // unplanned: its host lingers with running work
  await controller.pool.dropSlot(controller.pool.slot(bgId)!, true);
  let stored = readFileSync(join(process.env.PIX_HOME!, ".pix", "remote-hosts.json"), "utf8");
  assert.match(stored, /"pid":4343/, "the handle survives so the next session reattaches");
  controller.pool.forgetHost(bgId);
  stored = readFileSync(join(process.env.PIX_HOME!, ".pix", "remote-hosts.json"), "utf8");
  assert.ok(!stored.includes("4343"), "removing the project gives up on its host");
});

test("a link death after READY redials the surviving host instead of wasting it", async (t) => {
  const { controller, old } = controllerFixture(t);
  old.connected = false;
  // READY arrived, then the tunnel died before the WebSocket handshake —
  // exactly the pattern of an SSH reset mid-connect.
  const startedHandle = { kind: "ssh", target: "old", port: 41515, token: "survivor", pid: 6262 } as const;
  t.mock.method(WslHostClient, "connectSsh", async () => {
    throw new HostStarted("connect ECONNREFUSED 127.0.0.1:54114", startedHandle as never);
  });
  const reattached = candidate(controller);
  reattached.hello = { cwd: "/old" };
  reattached.reattached = true;
  reattached.handle = { kind: "ssh", target: "old", port: 41515, token: "survivor", pid: 6262 };
  const reattach = t.mock.method(WslHostClient, "reattach", async () => reattached as any);
  const result = await controller.connectSsh("old", "/old");
  assert.equal(reattach.mock.callCount(), 1, "the connect redials the surviving host");
  assert.equal(controller.wsl, reattached);
  assert.equal((result as { project: ProjectInfo }).project.path, "/old");
  const stored = JSON.parse(readFileSync(join(process.env.PIX_HOME!, ".pix", "remote-hosts.json"), "utf8"));
  const key = projectId({ name: "", path: "/old", remote: { kind: "ssh", host: "old" } });
  assert.equal(stored[key]?.pid, 6262, "the handle is kept even before the workspace commits");
});

test("a host that never started is not redialed", async (t) => {
  const { controller, old } = controllerFixture(t);
  old.connected = false;
  t.mock.method(WslHostClient, "connectSsh", async () => { throw new Error("ssh: connect refused"); });
  const reattach = t.mock.method(WslHostClient, "reattach", async () => { throw new Error("must not reattach"); });
  await assert.rejects(controller.connectSsh("old", "/old"), /connect refused/);
  assert.equal(reattach.mock.callCount(), 0);
});
