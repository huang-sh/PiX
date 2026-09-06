import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { WslHostClient } from "../src/main/wsl-host-client.js";
import { MainController } from "../src/main/controller.js";
import { PIX_REMOTE_PROTOCOL } from "../src/shared/remote-protocol.js";
import { projectId, type ProjectInfo } from "../src/shared/types.js";

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
  const root = mkdtempSync(join(tmpdir(), "pix-remote-"));
  const controller = new MainController(root, {
    async pickProject() { return undefined; },
    async pickSession() { return undefined; },
    async confirm() { return true; },
    async openExternal() {}, quit() {},
  });
  controller.settings.appPath = join(root, "app.json");
  controller.pi.control = async () => [];
  const project: ProjectInfo = { name: "old", path: "/old", remote: { kind: "ssh", host: "old" } };
  const old = candidate(controller);
  controller.project = project;
  controller.wsl = old as any;
  controller.wslSettings = controller.settings.bundle();
  controller.settings.rememberProject(project, []);
  t.after(async () => {
    await controller.closeWsl();
    controller.pi.dispose();
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
    onDisconnect(listener: (error: Error) => void) { events.on("disconnect", listener); return () => events.off("disconnect", listener); },
    async dispose() { this.disposed = true; this.connected = false; },
    disconnect() { this.connected = false; events.emit("disconnect", new Error("network lost")); },
  };
}

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

test("a successful candidate is committed before closing the old host and reports later disconnection", async (t) => {
  const { controller, old } = controllerFixture(t);
  const next = candidate(controller);
  t.mock.method(WslHostClient, "connectSsh", async () => next as any);
  await controller.connectSsh("new", "~", true);
  const result = await controller.openRemoteProject("/new/sub");
  assert.equal(result.project?.path, "/new/sub");
  assert.equal(controller.wsl, next);
  assert.equal(old.disposed, true);
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
