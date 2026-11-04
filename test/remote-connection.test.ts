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
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { ClassifierContext } from "@earendil-works/pi-ai";
import { WslHostClient, RemoteHostUnreachable, HostStarted, launcherScript } from "../src/main/wsl-host-client.js";
import { logFile } from "../src/main/debug-log.js";
import { MainController } from "../src/main/controller.js";
import { PiRuntime } from "../src/main/pi-runtime.js";
import { PIX_REMOTE_PROTOCOL, hasHostWork } from "../src/shared/remote-protocol.js";
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

test("remote activity requires an advertised capability and validates its response", async t => {
  const { client, socket } = transport(t);
  assert.equal(await client.activity(), undefined);
  assert.equal(socket.sent.length, 0, "older hosts must not receive unsupported requests");
  client.hello.workActivity = true;
  const reading = client.activity();
  const request = socket.sent.at(-1)!;
  assert.equal(request.route, "host.activity");
  socket.emit("message", JSON.stringify({ type: "response", id: request.id, ok: true,
    result: { running: 0, pending: false, commands: 1, terminals: 1, terminalUnknown: 0 } }));
  assert.equal((await reading)?.commands, 1);
  const invalid = client.activity();
  socket.emit("message", JSON.stringify({ type: "response", id: socket.sent.at(-1)!.id, ok: true, result: [] }));
  await assert.rejects(invalid, /invalid work activity/);
});

test("shutdown confirmation distinguishes a busy host from released workspace resources", async t => {
  const { client, socket, child } = transport(t);
  assert.equal(await client.shutdownIfIdle(), false);
  assert.equal(socket.sent.length, 0, "older hosts cannot confirm shutdown");
  assert.equal(client.connected, true);
  client.hello.shutdownAck = true;
  const busy = client.shutdownIfIdle();
  assert.equal(socket.sent.at(-1)?.route, "host.shutdown");
  socket.emit("message", JSON.stringify({ type: "response", id: socket.sent.at(-1)!.id, ok: true, result: { stopped: false } }));
  assert.equal(await busy, false);
  assert.equal(client.connected, true, "a deferred upgrade keeps its existing connection");
  const idle = client.shutdownIfIdle();
  socket.emit("message", JSON.stringify({ type: "response", id: socket.sent.at(-1)!.id, ok: true, result: { stopped: true } }));
  assert.equal(await idle, true);
  child.exitCode = 0;
  socket.terminate();
  assert.equal(await client.dispose(), true, "confirmation survives the socket closing");
});

test("a lost shutdown acknowledgement does not report the host stopped", async t => {
  const { client, socket } = transport(t);
  client.hello.shutdownAck = true;
  const closing = client.dispose();
  assert.equal(socket.sent.at(-1)?.route, "host.shutdown");
  socket.terminate();
  assert.equal(await closing, false);
});

for (const operation of ["dispose", "shutdownIfIdle"] as const)
test(`overlapping remote ${operation} calls wait for the same shutdown acknowledgement`, async t => {
  const { client, socket, child } = transport(t);
  client.hello.shutdownAck = true;
  child.exitCode = 0;
  const first = client.shutdownIfIdle();
  const second = client[operation]();
  try {
    assert.equal(socket.sent.length, 1, "cancellation and cleanup must not issue competing shutdown requests");
    assert.equal(client.connected, true, "the acknowledgement must arrive before cleanup closes the link");
  } finally {
    for (const request of socket.sent)
      socket.emit("message", JSON.stringify({ type: "response", id: request.id, ok: true, result: { stopped: true } }));
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
  }
});

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

test("remote transport returns image and classifier results and cancels either operation", async t => {
  const { client, socket } = transport(t);
  for (const operation of ["generateImages", "classify"] as const) {
    const result = { api: "test", provider: "test", model: "model", timestamp: 1, stopReason: "stop" as const,
      ...(operation === "generateImages" ? { output: [] } : { answers: {} }) };
    client.setModelBroker(async request => { assert.equal(request.operation, operation); return result as any; });
    socket.emit("message", JSON.stringify({ type: "model.request", id: operation, operation }));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(socket.sent.at(-1), { type: "model.event", id: operation, event: { type: "result", result } });
    client.setModelBroker((_request, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    socket.emit("message", JSON.stringify({ type: "model.request", id: operation, operation }));
    socket.emit("message", JSON.stringify({ type: "model.cancel", id: operation }));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(socket.sent.at(-1), { type: "model.failure", id: operation, error: "cancelled" });
  }
});

test("remote classifier requests preserve image input", async t => {
  const { client, socket } = transport(t);
  const context: ClassifierContext = {
    state: { task: "Inspect the image" },
    images: [{ type: "image", data: "test-image", mimeType: "image/png" }],
    questions: { visible: { type: "bool", instructions: "Is an object visible?", criteria: {
      true: "An object is visible", false: "No object is visible",
    } } },
  };
  const result = { api: "test", provider: "test", model: "vision", timestamp: 1,
    stopReason: "stop" as const, answers: {} };
  client.setModelBroker(async request => {
    assert.equal(request.operation, "classify");
    assert.deepEqual(request.context, context);
    return result as any;
  });
  socket.emit("message", JSON.stringify({ type: "model.request", id: "vision", operation: "classify", context }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(socket.sent.at(-1), { type: "model.event", id: "vision", event: { type: "result", result } });
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

test("long-running prompts, stops and shell commands are not cut off by the RPC timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, socket } = transport(t);
  const prompt = client.request("agent.control", { action: "prompt", text: "work" });
  const shell = client.request("shell.run", { command: "long job" });
  const newSession = client.request("agent.control", { action: "newSession" });
  const promptAt = client.request("agent.control", { action: "promptAt", requestId: "slow-startup", nodeId: null, text: "work" });
  const abort = client.request("agent.control", { action: "abort" });
  const branchAbort = client.request("agent.control", { action: "branchAbort", branchId: "main", runId: "run" });
  const sessionStop = client.request("session.stop", { path: "/project/session.jsonl" });
  const admitted = assert.doesNotReject(Promise.all([promptAt, sessionStop]));
  t.mock.timers.tick(300_000);
  for (const id of ["1", "2", "3", "4", "5", "6", "7"])
    socket.emit("message", JSON.stringify({ type: "response", id, ok: true, result: "done" }));
  await admitted;
  assert.deepEqual(await Promise.all([prompt, shell, newSession, promptAt, abort, branchAbort, sessionStop]), Array(7).fill("done"));
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

test("a WSL launcher exit does not end the link, but every SSH transport exit does", async (t) => {
  // WSL reaches the host directly; both fresh and reattached SSH clients
  // depend on their child process to carry the local forward.
  const launcher = transport(t);
  launcher.child.emit("exit", 0);
  assert.equal(launcher.client.connected, true, "the detached host outlives its launcher");
  for (const reattached of [false, true]) {
    const child = new FakeChild();
    const socket = new FakeSocket();
    const transportClient = Reflect.construct(WslHostClient, [
      child, socket, { cwd: "/project" },
      { kind: "ssh", target: "h", port: 1, token: "t", pid: 1 }, true, reattached,
    ]) as WslHostClient;
    t.after(async () => { child.exitCode = 0; child.emit("exit", 0); await transportClient.dispose(); });
    const failure = new Promise<Error>(resolve => transportClient.onDisconnect(resolve));
    child.stderr.write("ssh: connect to host h port 22: Connection reset\n");
    child.emit("exit", 255);
    assert.match((await failure).message, /SSH transport exited with code 255/);
  }
});

async function waitForLog(...texts: string[]) {
  for (let i = 0; i < 400; i++) {
    const content = existsSync(logFile()) ? readFileSync(logFile(), "utf8") : "";
    if (texts.every(text => content.includes(text))) return content;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Missing log text: ${texts.join(", ")}`);
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
  const log = await waitForLog("late stderr after exit: final diagnostic", "launcher closed] requested=false code=23 signal=none");
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
    hello: { cwd: "/new", piVersion: PI_VERSION } as { cwd: string } & Record<string, unknown>, connected: true, disposed: false, abandoned: false, reattached: false,
    handle: undefined as any,
    calls: [] as any[],
    async activity() {
      const sessions = await this.request("session.list");
      return { running: sessions.filter((session: { running?: boolean }) => session.running).length,
        pending: false, commands: 0, terminals: 0, terminalUnknown: 0 };
    },
    async shutdownIfIdle() {
      const activity = await this.activity();
      return Boolean(activity && !hasHostWork(activity));
    },
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
    async dispose() { this.disposed = true; this.connected = false; return true; },
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

test("app prompt changes sync every connected remote host, including background projects", async t => {
  const { controller, old } = controllerFixture(t);
  const second = candidate(controller);
  const project: ProjectInfo = { name: "second", path: "/second", remote: { kind: "ssh", host: "second" } };
  controller.installSlot(second as never, project, controller.settings.bundle());
  controller.configure(controller.localProjectPath);
  const customization = { preamble: "Shared persona", rules: "Shared rules" };
  await controller.invoke("settings.update", { scope: "app", patch: { promptCustomization: customization } });
  for (const remote of [old, second])
    assert.deepEqual(remote.calls.at(-1), ["agent.control", { action: "setPromptCustomization", customization }]);
  await controller.invoke("settings.reset", { scope: "app" });
  for (const remote of [old, second])
    assert.deepEqual(remote.calls.at(-1), ["agent.control", { action: "setPromptCustomization", customization: {} }]);
});

test("remote prompt synchronization failures are reported and retried on restore", async t => {
  const { controller, old } = controllerFixture(t);
  const request = old.request.bind(old);
  old.request = async (route, input) => {
    if (input?.action === "setPromptCustomization") throw new Error("prompt sync failed");
    return request(route, input);
  };
  await assert.rejects(controller.invoke("settings.update", { scope: "app", patch: { promptCustomization: { rules: "New rules" } } }), /prompt sync failed/);
  old.request = request;
  await controller.pool.wslBootstrap();
  assert.ok(old.calls.some(([route, input]) => route === "agent.control" && input?.action === "setPromptCustomization" && input.customization.rules === "New rules"));
});

test("dialog replies retain their remote owner after switching back to a local project", async t => {
  const { controller, old, project } = controllerFixture(t);
  const id = projectId(project);
  controller.configure(controller.localProjectPath);
  const events: any[] = [];
  controller.onEvent(event => events.push(event));
  const request = { id: "question", kind: "input", title: "Code", source: "/old" };
  old.emit({ type: "ui.request", payload: request });
  assert.deepEqual(events.at(-1), { type: "ui.request", payload: { ...request, projectId: id } });
  await controller.invoke("ui.respond", { id: request.id, projectId: id, value: "1234" });
  assert.deepEqual(old.calls.at(-1), ["ui.respond", { id: request.id, value: "1234" }]);
  old.request = async route => route === "ui.pending" ? [request] : [];
  assert.deepEqual(await controller.invoke("ui.pending"), [{ ...request, projectId: id }]);
});

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

test("the SSH launcher stays alive after READY until its input closes", {
  skip: process.platform === "win32",
  timeout: 30_000,
}, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pix-ssh-launcher-")));
  const port = await (WslHostClient as any).availableLocalPort();
  const child = spawn("sh", ["-c", launcherScript({
    exe: `${process.execPath} ${fileURLToPath(new URL("../src/server/index.js", import.meta.url))}`,
    cwd: root,
    base: root,
    port,
    keepAlive: true,
  })], { env: { ...process.env, PIX_HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") } });
  let client: WslHostClient | undefined;
  let ready: any;
  t.after(async () => {
    try {
      if (!client?.connected && ready) {
        await client?.dispose();
        const { socket, hello } = await (WslHostClient as any).openSocket(ready, 2_000);
        client = Reflect.construct(WslHostClient, [undefined, socket, hello]) as WslHostClient;
      }
      await client?.dispose();
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });
  ready = await (WslHostClient as any).waitForReady(child, 15_000);
  // Give a short-lived launcher time to exit before the desktop handshakes.
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(child.exitCode, null, "the SSH forward must survive READY");
  const { socket, hello } = await (WslHostClient as any).openSocket(ready, 2_000);
  client = Reflect.construct(WslHostClient, [child, socket, hello,
    { kind: "ssh", target: "test", ...ready }, true]) as WslHostClient;
  assert.equal(client.connected, true);
  assert.equal(client.reattached, false);
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.stdin.end();
  await exited;
  assert.equal(child.exitCode, 0, "closing desktop stdin releases the SSH session");
  assert.equal(client.connected, false, "losing the fresh SSH transport ends the link");
});

test("dispose orders a lingering host to shut down; abandon leaves it running", async (t) => {
  const disposed = transport(t);
  disposed.child.exitCode = 0;
  assert.equal(await disposed.client.dispose(), false, "legacy shutdown cannot confirm that the host stopped");
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
  fresh.hello = { cwd: "/old", piVersion: PI_VERSION };
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

test("disconnect without shutdown confirmation retains discovery across controller restart", async t => {
  const { controller, old, project } = controllerFixture(t, seedLingeringHost);
  old.handle = seededHandle;
  old.dispose = async () => { old.connected = false; old.disposed = true; return false; };
  await controller.closeWsl();
  const file = join(process.env.PIX_HOME!, ".pix", "remote-hosts.json");
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[projectId(project)].pid, seededHandle.pid);
  const reopened = new MainController(controller.localProjectPath, controller.platform);
  reopened.projectRuntime.control = async () => [];
  const fresh = candidate(reopened);
  fresh.hello.cwd = "/old";
  fresh.reattached = true;
  fresh.handle = seededHandle;
  const reattach = t.mock.method(WslHostClient, "reattach", async () => fresh as any);
  const spawn = t.mock.method(WslHostClient, "connectSsh", async () => { throw new Error("must reattach"); });
  try {
    await reopened.connectSsh("old", "/old");
    assert.equal(reattach.mock.callCount(), 1);
    assert.equal(spawn.mock.callCount(), 0);
    assert.equal(reopened.wsl, fresh);
  } finally {
    await reopened.closeWsl(); reopened.projectRuntime.dispose(); reopened.shell.dispose();
  }
});

test("an idle host using the old Pi is stopped before the upgraded host starts", async (t) => {
  const { controller, old } = controllerFixture(t, seedLingeringHost);
  old.connected = false;
  const obsolete = candidate(controller);
  obsolete.hello = { cwd: "/old", piVersion: "1.0.0" };
  obsolete.reattached = true;
  obsolete.handle = seededHandle;
  const fresh = candidate(controller);
  fresh.hello = { cwd: "/old", piVersion: PI_VERSION };
  fresh.handle = { ...seededHandle, pid: 5252 };
  t.mock.method(WslHostClient, "reattach", async () => obsolete as any);
  const spawn = t.mock.method(WslHostClient, "connectSsh", async () => {
    assert.equal(obsolete.disposed, true, "the old host releases its graph lock before replacement");
    return fresh as any;
  });
  await controller.connectSsh("old", "/old");
  assert.equal(spawn.mock.callCount(), 1);
  assert.equal(controller.wsl, fresh);
});

for (const work of [{ commands: 1 }, { pending: true }, { terminalUnknown: 1 }])
test(`SDK upgrade preserves shell work and uncertainty: ${JSON.stringify(work)}`, async t => {
  const { controller, old } = controllerFixture(t, seedLingeringHost);
  old.connected = false;
  const obsolete = candidate(controller);
  obsolete.hello = { cwd: "/old", piVersion: "1.0.0" };
  obsolete.handle = seededHandle;
  obsolete.reattached = true;
  obsolete.activity = async () => ({ running: 0, pending: false, commands: 0, terminals: 1, terminalUnknown: 0, ...work });
  t.mock.method(WslHostClient, "reattach", async () => obsolete as any);
  const spawn = t.mock.method(WslHostClient, "connectSsh", async () => { throw new Error("must not spawn"); });
  await controller.connectSsh("old", "/old");
  assert.equal(controller.wsl, obsolete);
  assert.equal(obsolete.connected, true);
  assert.equal(obsolete.disposed, false);
  assert.equal(spawn.mock.callCount(), 0);
  const saved = JSON.parse(readFileSync(join(process.env.PIX_HOME!, ".pix", "remote-hosts.json"), "utf8"));
  assert.equal(saved[projectId(controller.project!)].pid, seededHandle.pid);
});

for (const fails of [false, true])
test(`SDK upgrade cannot replace an idle host without shutdown confirmation (failure=${fails})`, async t => {
  const { controller, old } = controllerFixture(t, seedLingeringHost);
  old.connected = false;
  const obsolete = candidate(controller);
  obsolete.hello = { cwd: "/old", piVersion: "1.0.0" };
  obsolete.handle = seededHandle;
  obsolete.reattached = true;
  obsolete.shutdownIfIdle = async () => { if (fails) throw new Error("confirmation lost"); return false; };
  t.mock.method(WslHostClient, "reattach", async () => obsolete as any);
  const spawn = t.mock.method(WslHostClient, "connectSsh", async () => { throw new Error("must not spawn"); });
  await controller.connectSsh("old", "/old");
  assert.equal(controller.wsl, obsolete);
  assert.equal(obsolete.disposed, false);
  assert.equal(spawn.mock.callCount(), 0);
  const saved = JSON.parse(readFileSync(join(process.env.PIX_HOME!, ".pix", "remote-hosts.json"), "utf8"));
  assert.equal(saved[projectId(controller.project!)].pid, seededHandle.pid);
});

test("a running host using the old Pi remains attached until a later reconnect", async (t) => {
  const { controller, old } = controllerFixture(t, seedLingeringHost);
  old.connected = false;
  const busy = candidate(controller);
  busy.hello = { cwd: "/old", piVersion: "1.0.0" };
  busy.reattached = true;
  busy.handle = seededHandle;
  busy.request = async (route: string) => route === "session.list"
    ? [{ ...remoteSnapshot().session, running: true }]
    : controller.settings.bundle();
  t.mock.method(WslHostClient, "reattach", async () => busy as any);
  const spawn = t.mock.method(WslHostClient, "connectSsh", async () => { throw new Error("must not spawn"); });
  const events: any[] = [];
  controller.onEvent(event => events.push(event));
  await controller.connectSsh("old", "/old");
  assert.equal(controller.wsl, busy);
  assert.equal(busy.disposed, false);
  assert.equal(spawn.mock.callCount(), 0);
  assert.ok(events.some(event => event.type === "notice" && /close and reopen the remote workspace/.test(event.payload.message)));
});

test("an old host with unknown running state is never replaced speculatively", async (t) => {
  const { controller, old } = controllerFixture(t, seedLingeringHost);
  old.connected = false;
  const uncertain = candidate(controller);
  uncertain.hello = { cwd: "/old", piVersion: "1.0.0" };
  uncertain.reattached = true;
  uncertain.handle = seededHandle;
  uncertain.request = async (route: string) => {
    if (route === "session.list") throw new Error("cannot inspect runs");
    return controller.settings.bundle();
  };
  t.mock.method(WslHostClient, "reattach", async () => uncertain as any);
  const spawn = t.mock.method(WslHostClient, "connectSsh", async () => { throw new Error("must not spawn"); });
  await assert.rejects(controller.connectSsh("old", "/old"), /cannot inspect runs/);
  assert.equal(uncertain.disposed, false);
  assert.equal(spawn.mock.callCount(), 0);
  assert.match(readFileSync(join(process.env.PIX_HOME!, ".pix", "remote-hosts.json"), "utf8"), /"pid":4242/);
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

for (const cancel of ["explicit", "replacement"]) for (const lateSuccess of [false, true]) {
  test(`cancelling a reattach handshake preserves its host (${cancel}, late success: ${lateSuccess})`, async t => {
    const { controller, old, project } = controllerFixture(t, seedLingeringHost);
    old.connected = false;
    const pending = candidate(controller);
    pending.reattached = true;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(WslHostClient, "reattach", async (...[_handle, options]: Parameters<typeof WslHostClient.reattach>) => {
      entered();
      if (lateSuccess) { await gate; return pending as any; }
      return new Promise<never>((_resolve, reject) => options?.signal?.addEventListener("abort",
        () => reject(new Error("Remote connection cancelled")), { once: true }));
    });
    const kill = t.mock.method(WslHostClient, "killHost", async () => {});
    const next = candidate(controller);
    const spawn = t.mock.method(WslHostClient, "connectSsh", async (...[_host, _cwd, options]: Parameters<typeof WslHostClient.connectSsh>) => {
      options?.signal?.throwIfAborted();
      return next as any;
    });
    const first = assert.rejects(controller.connectSsh("old", "/old"), /cancelled/i);
    try {
      await started;
      if (cancel === "explicit") await controller.pool.cancelRemote();
      else await controller.connectSsh("new", "/new");
    } finally { release(); }
    await first;
    assert.equal(kill.mock.callCount(), 0, "cancellation must not stop a previously running host");
    assert.equal(spawn.mock.callCount(), cancel === "explicit" ? 0 : 1);
    assert.equal(pending.disposed, false);
    assert.equal(pending.abandoned, lateSuccess, "a late successful attachment only releases its transport");
    const stored = JSON.parse(readFileSync(join(process.env.PIX_HOME!, ".pix", "remote-hosts.json"), "utf8"));
    assert.equal(stored[projectId(project)].pid, seededHandle.pid, "the original handle must survive for retry");
  });
}

test("a cancelled attempt abandons a reattached host instead of stopping it", async (t) => {
  const { controller, old } = controllerFixture(t, seedLingeringHost);
  const pending = candidate(controller);
  pending.hello = { cwd: "/old", piVersion: PI_VERSION };
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
  fresh.hello = { cwd: "/old", piVersion: PI_VERSION };
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

test("an absent desktop releases finished remote connections and preserves live brokers", async t => {
  const { controller, old } = controllerFixture(t);
  let running = true;
  old.request = async route => route === "session.list" ? [{ running }] : [];
  await controller.pool.closeIdleRemote();
  assert.equal(old.disposed, false);
  assert.equal(old.abandoned, false, "a live broker must stay connected while its GUI is absent");
  running = false;
  await controller.pool.closeIdleRemote();
  assert.equal(old.disposed, true);
  assert.equal(controller.pool.hasConnections, false);
});

for (const work of [{ commands: 1 }, { terminalUnknown: 1 }, { pending: true }])
test(`remote cleanup preserves shell work and uncertainty: ${JSON.stringify(work)}`, async t => {
  const { controller, old } = controllerFixture(t);
  old.activity = async () => ({ running: 0, pending: false, commands: 0, terminals: 1, terminalUnknown: 0, ...work });
  const activity = await controller.pool.activity();
  assert.equal(activity.commands, work.commands ?? 0);
  assert.equal(activity.unknown, work.terminalUnknown ?? 0);
  assert.equal(activity.running, work.pending ? 1 : 0);
  await controller.pool.closeIdleRemote();
  assert.equal(old.disposed, false);
  assert.equal(old.abandoned, false);
  await controller.pool.closeAllRemote();
  assert.equal(old.disposed, false);
  assert.equal(old.abandoned, true);
});

test("older remote hosts remain running when their shell activity cannot be verified", async t => {
  const { controller, old } = controllerFixture(t);
  old.activity = async () => undefined as never;
  assert.equal((await controller.pool.activity()).unknown, 1);
  await controller.pool.closeAllRemote();
  assert.equal(old.disposed, false);
  assert.equal(old.abandoned, true);
});

for (const change of ["added", "replaced", "removed", "new activity", "running activity"] as const)
test(`remote activity ignores stale samples when a connection is ${change} during inspection`, async t => {
  const { controller, old, project } = controllerFixture(t);
  let inspected!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { inspected = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  old.activity = async () => {
    inspected(); await gate;
    return { running: Number(change === "running activity"), pending: false, commands: Number(change === "running activity"),
      terminals: 0, terminalUnknown: change === "removed" ? 1 : 0 };
  };
  const reading = controller.pool.activity();
  try {
    await started;
    if (change === "added") {
      controller.installSlot(candidate(controller) as never,
        { name: "added", path: "/added", remote: { kind: "ssh", host: "added" } }, controller.settings.bundle());
    } else if (change === "replaced") {
      controller.installSlot(candidate(controller) as never, project, controller.settings.bundle());
    } else if (change === "removed") {
      await controller.closeWsl();
    } else {
      old.emit({ type: "terminal", payload: { id: "live", data: "new work" } });
    }
    release();
    assert.deepEqual(await reading, { running: Number(change === "running activity"), commands: Number(change === "running activity"),
      unknown: change === "removed" ? 0 : 1 });
  } finally { release(); await reading; }
});

for (const source of ["shell", "terminal", "queued shell", "queued terminal"] as const)
test(`remote shutdown atomically preserves a live ${source} command without a running Agent`, { timeout: 30000 }, async t => {
  const { controller, old } = controllerFixture(t);
  old.connected = false;
  const home = mkdtempSync(join(tmpdir(), "pix-remote-work-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server/index.js", import.meta.url)),
    "serve", "--cwd", home], { env: { ...process.env, HOME: home, ZDOTDIR: home, PIX_HOME: home,
    PI_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1" }, stdio: "pipe" });
  const clients: WslHostClient[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.dispose()));
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM"); await exited;
    }
    rmSync(home, { recursive: true, force: true });
  });
  const ready = await (WslHostClient as any).waitForReady(child, 15_000);
  const handle = { ...ready, kind: "ssh", target: "fixture" };
  const connect = async (reattached = false) => {
    const { socket, hello } = await (WslHostClient as any).openSocket(ready, 15_000);
    // The real SSH launcher has already exited; the lingering host is not
    // the transport child that a disconnected client is allowed to terminate.
    const client = Reflect.construct(WslHostClient, [undefined, socket, hello, handle, false, reattached]) as WslHostClient;
    clients.push(client); return client;
  };
  const wait = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 500; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error("Timed out waiting for remote work state");
  };
  const spawning = t.mock.method(WslHostClient, "connectSsh", () => connect());
  const attaching = t.mock.method(WslHostClient, "reattach", async (saved: typeof handle) => {
    assert.equal(saved.pid, ready.pid);
    assert.equal(saved.token, ready.token);
    const client = await connect(true);
    client.hello.piVersion = "1.0.0";
    return client;
  });
  await controller.connectSsh("fixture", home);
  const client = controller.wsl!;
  const cwd = controller.project!.path;
  const key = projectId(controller.project!);
  const saved = () => JSON.parse(readFileSync(join(process.env.PIX_HOME!, ".pix", "remote-hosts.json"), "utf8"));
  let id = "";
  const command = process.platform === "win32" ? "ping.exe -n 60 127.0.0.1" : "sleep 60";
  const terminal = source === "terminal" || source === "queued terminal";
  if (terminal) {
    const transport = Reflect.get(client.socket, "_socket") as { cork(): void; uncork(): void };
    if (source === "queued terminal") transport.cork();
    let stopping: Promise<boolean> | undefined;
    let creating: Promise<{ id: string }>;
    try {
      if (source === "queued terminal") stopping = client.shutdownIfIdle();
      creating = client.request<{ id: string }>("terminal.create", { cols: 80, rows: 24 });
    } finally { if (source === "queued terminal") transport.uncork(); }
    ({ id } = await creating);
    if (stopping) assert.equal(await stopping, false, "a terminal created after the activity snapshot must invalidate idle shutdown");
    await wait(async () => (await client.activity())?.terminalUnknown === 0);
    await client.request("terminal.write", { id, data: command + "\r" });
  } else {
    client.onEvent(event => { if (event.type === "shell") id = (event.payload as { id: string }).id; });
    // Batch the frames so shutdown is inspected while shell.run is still
    // awaiting its default trust confirmation, before a process exists.
    const transport = Reflect.get(Reflect.get(client, "socket"), "_socket") as { cork(): void; uncork(): void };
    if (source === "queued shell") transport.cork();
    let stopping: Promise<boolean> | undefined;
    try {
      void client.request("shell.run", { command: (process.platform === "win32" ? "Write-Output started; " : "printf started; ") + command }).catch(() => {});
      if (source === "queued shell") stopping = client.shutdownIfIdle();
    } finally { if (source === "queued shell") transport.uncork(); }
    if (stopping) assert.equal(await stopping, false, "accepted shell work must block shutdown before it starts");
  }
  await wait(async () => (await client.activity())?.commands === 1 && Boolean(id));
  assert.equal((await client.request<Array<{ running?: boolean }>>("session.list")).some(session => session.running), false);
  assert.equal(await client.shutdownIfIdle(), false, "an SDK upgrade cannot stop shell work");
  assert.equal(client.connected, true);
  // Exercise normal disconnect and persisted discovery, rather than reconnecting
  // directly with a ready-file token the desktop might already have forgotten.
  await controller.closeWsl();
  assert.equal(saved()[key].pid, ready.pid);
  assert.equal(child.exitCode, null);
  await controller.connectSsh("fixture", cwd);
  const reattached = controller.wsl!;
  assert.equal(attaching.mock.callCount(), 1);
  assert.equal(spawning.mock.callCount(), 1, "SDK mismatch must not start another host while commands run");
  assert.equal(saved()[key].pid, ready.pid);
  assert.equal((await reattached.activity())?.commands, 1, "disconnect must preserve the command");
  await reattached.request(terminal ? "terminal.kill" : "shell.abort", { id });
  await wait(async () => (await reattached.activity())?.commands === 0);
  assert.equal(await reattached.shutdownIfIdle(), true);
  await controller.closeWsl();
  assert.equal(saved()[key], undefined, "only confirmed cleanup can delete discovery information");
  await wait(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0, "an idle host still shuts down normally");
});

test("idle remote cleanup does not dispose a desktop that reconnected during the liveness probe", async t => {
  const { controller, old } = controllerFixture(t);
  let connected = false;
  old.request = async () => { connected = true; return []; };
  await controller.pool.closeIdleRemote(() => connected);
  assert.equal(old.disposed, false);
  assert.equal(controller.pool.hasConnections, true);
});

test("idle remote cleanup preserves activity received during its liveness probe", async t => {
  const { controller, old, project } = controllerFixture(t);
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  controller.pool.slot(projectId(project))!.lastActivity = now;
  old.activity = async () => {
    old.emit({ type: "terminal", payload: { id: "active-terminal", data: "new output" } });
    return { running: 0, pending: false, commands: 0, terminals: 0, terminalUnknown: 0 };
  };
  await controller.pool.closeIdleRemote();
  assert.equal(old.disposed, false, "fresh activity invalidates the earlier idle sample");
  assert.equal(controller.pool.hasConnections, true);
});

for (const cleanup of ["closeIdleRemote", "recycleRemote", "forgetProject"] as const)
for (const outcome of ["busy", "unverified"] as const)
test(`${cleanup} preserves the live transport when atomic shutdown is ${outcome}`, async t => {
  const { controller, project } = controllerFixture(t);
  const { client, socket, child } = transport(t);
  child.exitCode = 0;
  client.hello.workActivity = true;
  client.hello.shutdownAck = true;
  controller.installSlot(client, project, controller.settings.bundle());
  controller.configure(controller.localProjectPath);
  const id = projectId(project);
  controller.pool.slot(id)!.lastActivity = 0;
  let allowShutdown = false;
  let shutdownChecks = 0;
  t.mock.method(socket, "send", (raw: string, callback?: (error?: Error) => void) => {
    const request = JSON.parse(raw);
    socket.sent.push(request);
    callback?.();
    queueMicrotask(() => {
      if (request.route === "host.activity") socket.emit("message", JSON.stringify({
        type: "response", id: request.id, ok: true,
        result: { running: 0, pending: false, commands: 0, terminals: 0, terminalUnknown: 0 },
      }));
      else if (request.route === "host.shutdown") {
        shutdownChecks++;
        socket.emit("message", JSON.stringify(!allowShutdown && outcome === "unverified"
          ? { type: "response", id: request.id, ok: false, error: { message: "Cannot verify current work" } }
          : { type: "response", id: request.id, ok: true, result: { stopped: allowShutdown } }));
      }
    });
  });
  const run = () => cleanup === "closeIdleRemote" ? controller.pool.closeIdleRemote()
    : cleanup === "forgetProject" ? controller.invoke("app.forgetProject", { id })
    : Reflect.get(controller.pool, "recycleRemote").call(controller.pool) as Promise<void>;
  try {
    if (cleanup === "forgetProject") await assert.rejects(run(), /confirm.*shutdown/i);
    else await run();
    assert.equal(shutdownChecks, 1, "the remote host must atomically confirm shutdown after the idle sample");
    assert.equal(client.connected, true, "unconfirmed cleanup must keep the model broker and terminal link alive");
    assert.equal(controller.pool.slot(id)?.client, client);
    if (cleanup === "forgetProject") assert.ok(controller.projectGroups().some(group => projectId(group.project) === id));
    allowShutdown = true;
    await run();
    assert.equal(client.connected, false, "confirmed idle hosts are still recycled");
    assert.equal(controller.pool.slot(id), undefined);
    if (cleanup === "forgetProject") assert.ok(!controller.projectGroups().some(group => projectId(group.project) === id));
  } finally { socket.terminate(); }
});

for (const cleanup of ["closeIdleRemote", "recycleRemote"] as const)
for (const outcome of ["busy", "stopped", "cancel", "quit", "changed", "early cancel", "early quit", "browse"] as const)
test(`${cleanup} serializes workspace selection with pending shutdown (${outcome})`, async t => {
  const { controller, old, project } = controllerFixture(t);
  controller.configure(controller.localProjectPath);
  controller.pool.slot(projectId(project))!.lastActivity = 0;
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const shuttingDown = new Promise<void>(resolve => { started = resolve; });
  old.shutdownIfIdle = async () => { started(); await gate; return outcome !== "busy"; };
  const fresh = candidate(controller); fresh.hello.cwd = outcome === "browse" ? "/browse" : project.path;
  const connect = t.mock.method(WslHostClient, "connectSsh", async () => fresh as any);
  const cleaning = cleanup === "closeIdleRemote" ? controller.pool.closeIdleRemote()
    : Reflect.get(controller.pool, "recycleRemote").call(controller.pool) as Promise<void>;
  let selecting: Promise<unknown> | undefined;
  try {
    await shuttingDown;
    const before = old.calls.length;
    selecting = controller.connectSsh("old", "/old");
    void selecting.catch(() => {});
    if (outcome === "early cancel") await controller.pool.cancelRemote();
    const quitting = outcome === "early quit" ? controller.pool.closeAllRemote() : undefined;
    const browsing = outcome === "browse" ? controller.connectSsh("new", "/browse", true) : undefined;
    await new Promise<void>(resolve => setImmediate(resolve));
    if (outcome !== "early quit") assert.equal(old.calls.length, before, "selection must wait instead of using a host that may already be shutting down");
    if (outcome === "cancel") await controller.pool.cancelRemote();
    if (outcome === "quit") await controller.pool.closeAllRemote();
    if (outcome === "changed") controller.configure(controller.localProjectPath);
    await quitting; await browsing;
    release(); await cleaning;
    if (["cancel", "quit", "changed", "early cancel", "early quit", "browse"].includes(outcome)) {
      await assert.rejects(selecting, /cancel|changed/i);
      assert.equal(connect.mock.callCount(), outcome === "browse" ? 1 : 0, "obsolete selection and Quit cannot start a replacement host");
      assert.equal(controller.project?.remote, undefined);
      if (outcome === "browse") assert.equal((await controller.pool.browseDirectories({ path: "/browse" }) as { path: string }).path, "/browse");
    } else {
      const result = await selecting as { project: ProjectInfo };
      assert.equal(result.project.path, project.path);
      assert.equal(controller.wsl, outcome === "busy" ? old : fresh);
      assert.equal(controller.wsl?.connected, true);
      assert.equal(connect.mock.callCount(), outcome === "busy" ? 0 : 1);
    }
  } finally { release(); await Promise.allSettled([cleaning, selecting]); }
});

test("cancelled pooled selection does not apply a late session snapshot", async t => {
  const { controller, old, project } = controllerFixture(t);
  controller.configure(controller.localProjectPath);
  controller.pool.slot(projectId(project))!.activePath = "/old/session.jsonl";
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const opening = new Promise<void>(resolve => { started = resolve; });
  const request = old.request.bind(old);
  old.request = async (route, input) => {
    if (route === "session.open") { started(); await gate; return remoteSnapshot(); }
    return request(route, input);
  };
  const selecting = controller.connectSsh("old", "/old");
  void selecting.catch(() => {});
  try {
    await opening;
    await controller.pool.cancelRemote();
    release();
    await assert.rejects(selecting, /cancel/i);
    assert.equal(controller.current, undefined);
    assert.equal(old.connected, true, "cancelling selection must preserve the pooled host");
  } finally { release(); await selecting.catch(() => {}); }
});

for (const stopped of [false, true])
test(`overlapping idle cleanup shares one shutdown decision (stopped=${stopped})`, async t => {
  const { controller, old, project } = controllerFixture(t);
  const slot = controller.pool.slot(projectId(project))!;
  let release!: () => void, checks = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  old.shutdownIfIdle = async () => { checks++; await gate; return stopped; };
  const first = controller.pool.dropIdleSlot(slot), second = controller.pool.dropIdleSlot(slot);
  try {
    assert.equal(checks, 1);
    release();
    assert.deepEqual(await Promise.all([first, second]), [stopped, stopped]);
    assert.equal(old.disposed, stopped);
  } finally { release(); await Promise.allSettled([first, second]); }
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

for (const change of ["selected", "selection pending", "registered again", "active again"] as const)
test(`remote recycling preserves a workspace ${change} during its idle check`, async t => {
  const { controller, old, project } = controllerFixture(t);
  controller.configure(controller.localProjectPath);
  const id = projectId(project);
  controller.pool.slot(id)!.lastActivity = 0;
  let scanned!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { scanned = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  old.activity = async () => {
    scanned(); await gate;
    return { running: 0, pending: false, commands: 0, terminals: 0, terminalUnknown: 0 };
  };
  const recycling = Reflect.get(controller.pool, "recycleRemote").call(controller.pool) as Promise<void>;
  let selection: Promise<unknown> | undefined;
  let resumeSelection = () => {};
  try {
    await started;
    if (change === "selected") await controller.connectSsh("old", "/old");
    else if (change === "selection pending") {
      let selecting!: () => void;
      const selectingStarted = new Promise<void>(resolve => { selecting = resolve; });
      const selectionGate = new Promise<void>(resolve => { resumeSelection = resolve; });
      const request = old.request.bind(old);
      old.request = async (route, input) => {
        if (route === "settings.get") { selecting(); await selectionGate; }
        return request(route, input);
      };
      selection = controller.connectSsh("old", "/old");
      await selectingStarted;
    }
    else if (change === "registered again") controller.installSlot(old as never, project, controller.settings.bundle());
    else old.emit({ type: "terminal", payload: { id: "active-terminal", data: "new output" } });
    release();
    await recycling;
    if (change === "selection pending") {
      controller.pool.slot(id)!.lastActivity = 0;
      await Reflect.get(controller.pool, "recycleRemote").call(controller.pool);
    }
    assert.equal(old.disposed, false, "a stale idle sample must not disconnect a workspace that changed");
    assert.equal(controller.pool.slot(id)?.client, old);
    if (change === "selected") assert.equal(controller.wsl, old);
  } finally { release(); resumeSelection(); await selection; await recycling; }
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

test("forgetting a remote project rejects an idle result invalidated by new terminal activity", async t => {
  const { controller } = controllerFixture(t);
  const spare = candidate(controller);
  const project: ProjectInfo = { name: "spare", path: "/spare", remote: { kind: "ssh", host: "spare" } };
  controller.installSlot(spare as never, project, controller.settings.bundle());
  controller.settings.rememberProject(project, []);
  let release!: () => void, scanning!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scanned = new Promise<void>(resolve => { scanning = resolve; });
  spare.activity = async () => { scanning(); await gate; return { running: 0, pending: false, commands: 0, terminals: 1, terminalUnknown: 0 }; };
  const removing = controller.invoke("app.forgetProject", { id: projectId(project) });
  try {
    await scanned;
    spare.emit({ type: "terminal", payload: { id: "new-command", data: "working" } });
    release();
    await assert.rejects(removing, /changed|Retry/i);
    assert.equal(spare.disposed, false);
    assert.ok(controller.settings.projectHistory().some(record => record.id === projectId(project)));
  } finally { release(); await removing.catch(() => {}); }
});

test("forgetting a project retains its history and handle when remote shutdown is not confirmed", async t => {
  const project: ProjectInfo = { name: "spare", path: "/spare", remote: { kind: "ssh", host: "spare" } };
  const id = projectId(project);
  const handle = { kind: "ssh", target: "spare", port: 41001, token: "keep-running-host", pid: 4242, path: "/spare" };
  const { controller } = controllerFixture(t, home => {
    mkdirSync(join(home, ".pix"), { recursive: true });
    writeFileSync(join(home, ".pix", "remote-hosts.json"), JSON.stringify({ [id]: handle }));
  });
  const spare = candidate(controller);
  spare.handle = handle;
  spare.dispose = async () => { spare.disposed = true; spare.connected = false; return false; };
  controller.installSlot(spare as never, project, controller.settings.bundle());
  controller.settings.rememberProject(project, []);
  await assert.rejects(controller.invoke("app.forgetProject", { id }), /confirm.*shutdown/i);
  assert.ok(controller.settings.projectHistory().some(record => record.id === id));
  assert.equal(JSON.parse(readFileSync(join(process.env.PIX_HOME!, ".pix", "remote-hosts.json"), "utf8"))[id].token, handle.token);
});

test("forgetting a project cannot remove a replacement slot admitted during remote cleanup", async t => {
  const { controller } = controllerFixture(t);
  const project: ProjectInfo = { name: "spare", path: "/spare", remote: { kind: "ssh", host: "spare" } };
  const spare = candidate(controller), replacement = candidate(controller);
  controller.installSlot(spare as never, project, controller.settings.bundle());
  controller.settings.rememberProject(project, []);
  let release!: () => void, closing!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { closing = resolve; });
  spare.dispose = async () => { closing(); await gate; spare.disposed = true; spare.connected = false; return true; };
  const removing = controller.invoke("app.forgetProject", { id: projectId(project) });
  try {
    await started;
    controller.installSlot(replacement as never, project, controller.settings.bundle());
    release();
    await assert.rejects(removing, /changed|Retry/i);
    assert.equal(controller.pool.slot(projectId(project))?.client, replacement);
    assert.equal(replacement.disposed, false);
    assert.ok(controller.settings.projectHistory().some(record => record.id === projectId(project)));
  } finally { release(); await removing.catch(() => {}); }
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
    getModel: (provider: string, id: string) => ({ provider, id, baseUrl: "https://real.example" }),
    checkAuth: async (provider: string) => (local.includes(provider) ? { type: "api_key" } : null),
    registerProvider: (id: string) => runtime.registered.push(id),
    unregisterProvider: (id: string) => { runtime.registered = runtime.registered.filter((p: string) => p !== id); },
    setRuntimeApiKey: async (id: string) => { runtime.keys.add(id); },
    removeRuntimeApiKey: async (id: string) => { runtime.keys.delete(id); },
    stream: () => "native",
    streamSimple: () => "native-simple",
    generateImages: () => "native-image",
    classify: () => "native-classifier",
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
  const operations: string[] = [];
  const broker = runtime.modelBroker;
  runtime.modelBroker = (_model, _context, _options, operation) => { operations.push(operation!); return "routed"; };
  for (const [operation, expected] of [["streamSimple", "native-simple"], ["generateImages", "native-image"], ["classify", "native-classifier"]]) {
    assert.equal(modelRuntime[operation!]({ provider: "anthropic" }, {}, {}), expected);
    assert.equal(modelRuntime[operation!]({ provider: "openai" }, {}, {}), "routed");
  }
  assert.deepEqual(operations, ["streamSimple", "generateImages", "classify"]);
  runtime.modelBroker = broker;
  // setModel's preflight must see brokered providers as configured.
  assert.deepEqual(await modelRuntime.checkAuth("openai"), { type: "api_key", source: "pix-desktop-broker" });
  assert.deepEqual(await modelRuntime.checkAuth("anthropic"), { type: "api_key" });
  assert.equal(await modelRuntime.checkAuth("unknown"), null);

  // A session holding an overlay-resolved model re-resolves when its
  // provider gains local credentials; the placeholder URL must not leak
  // into a direct call.
  let reResolved: any = undefined;
  runtime.runtime = { session: {
    model: { provider: "openai", id: "gpt", baseUrl: "http://pix-desktop-broker.invalid" },
    isStreaming: false,
    setModel: async (model: any) => { reResolved = model; },
  } };

  // A deployed credential moves its provider to direct calls...
  local.push("openai");
  await runtime.refreshBrokerAuth();
  assert.equal(reResolved?.baseUrl, "https://real.example", "the stale overlay model is re-resolved");
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
  reattached.hello = { cwd: "/old", piVersion: PI_VERSION };
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

for (const kind of ["ssh", "wsl"] as const) test(`${kind} history reads reach the remote host and paged images remain readable`, async t => {
  const { controller, old, project } = controllerFixture(t);
  if (kind === "wsl") {
    controller.project = { ...project, remote: { kind, distro: "Ubuntu" } };
    controller.installSlot(old as never, controller.project, controller.settings.bundle());
  }
  const path = "/old/history.jsonl";
  const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
  const entry = { type: "message", id: "branch-image", parentId: null, timestamp: "2026-01-01",
    message: { role: "user", content: [image] } };
  const current = { session: { path }, entries: [], projection: { nodes: [], edges: [], messages: [] },
    runtime: { available: true }, graph: { id: path, epoch: "remote-epoch", revision: 1, runs: [] } } as unknown as SessionSnapshot;
  controller.current = current;
  const original = old.request.bind(old);
  old.request = async (route, input) => {
    old.calls.push([route, input]);
    if (route === "session.branchWindow") return { entries: [entry], hasEarlier: false, session: path, epoch: "remote-epoch" };
    if (route === "session.search") return { nodeIds: ["turn:branch-image"] };
    if (route === "session.prompts") return { prompts: ["remote prompt"] };
    assert.notEqual(route, "session.image", "older hosts need no new image route");
    return original(route, input);
  };
  const page = await controller.invoke("session.branchWindow", { session: path, leafId: entry.id, limit: 1, bytes: 4 << 20 });
  assert.deepEqual((page as { entries: unknown[] }).entries, [entry]);
  assert.deepEqual(await controller.invoke("session.search", { session: path, query: "remote" }), { nodeIds: ["turn:branch-image"] });
  assert.deepEqual(await controller.invoke("session.prompts", { session: path }), { prompts: ["remote prompt"] });
  assert.deepEqual(await controller.invoke("session.image", { session: path, entryId: entry.id, index: 0, epoch: "remote-epoch" }), image);
  assert.equal(controller.current, current, "a page response is not a session snapshot");
});

function remoteImageFixture(t: TestContext) {
  const fixture = controllerFixture(t);
  const path = "/old/images.jsonl";
  const snapshot = remoteSnapshot(path);
  snapshot.entries = [];
  snapshot.graph = { id: path, epoch: "images-1", revision: 1, runs: [] };
  fixture.controller.current = snapshot;
  const images = ["first", "second", "third"].map(text => ({ type: "image", mimeType: "image/png", data: Buffer.from(text).toString("base64") }));
  const entry = { type: "message", id: "images", parentId: null, timestamp: "2026-01-01", message: { role: "user", content: images } };
  const page = { entries: [entry], hasEarlier: false, session: path, epoch: snapshot.graph.epoch };
  const request = { session: path, entryId: entry.id, epoch: snapshot.graph.epoch, index: 0 };
  return { ...fixture, snapshot, images, page, request };
}

test("remote images share pending and completed pages across image indices and preview sizes", async t => {
  const { controller, old, images, page, request } = remoteImageFixture(t);
  let calls = 0, release!: (value: unknown) => void;
  const original = old.request.bind(old);
  old.request = async (route, input) => {
    if (route !== "session.branchWindow") return original(route, input);
    calls++;
    return new Promise(resolve => { release = resolve; });
  };
  const pending = images.map((_, index) => controller.invoke("session.image", { ...request, index, thumbnail: true }));
  assert.equal(calls, 1);
  release(page);
  assert.deepEqual(await Promise.all(pending), images);
  assert.deepEqual(await controller.invoke("session.image", { ...request, index: 1 }), images[1]);
  assert.equal(calls, 1, "opening the original uses the same entry as its thumbnail");
  assert.deepEqual(controller.current!.entries, [], "image caching does not mutate the wire snapshot baseline");
});

for (const change of ["epoch", "session", "host", "page-epoch", "page-session"] as const)
test(`remote image reads reject a changed ${change} during IO`, async t => {
  const { controller, old, snapshot, page, request } = remoteImageFixture(t);
  const original = old.request.bind(old);
  old.request = async (route, input) => {
    if (route !== "session.branchWindow") return original(route, input);
    if (change === "epoch") controller.current = { ...snapshot, graph: { ...snapshot.graph!, epoch: "images-2" } };
    if (change === "session") controller.current = remoteSnapshot("/old/other.jsonl");
    if (change === "host") {
      const project: ProjectInfo = { name: "other", path: "/old", remote: { kind: "ssh", host: "other" } };
      controller.project = project;
      controller.installSlot(candidate(controller) as never, project, controller.settings.bundle());
    }
    return { ...page, ...(change === "page-epoch" ? { epoch: "images-2" } : {}),
      ...(change === "page-session" ? { session: "/old/other.jsonl" } : {}) };
  };
  await assert.rejects(controller.invoke("session.image", request), /Session changed/);
});

test("remote image pages retry failures, support older hosts, and invalidate after reopening", async t => {
  const { controller, old, snapshot, images, page, request } = remoteImageFixture(t);
  let calls = 0;
  const original = old.request.bind(old);
  old.request = async (route, input) => {
    if (route !== "session.branchWindow") return original(route, input);
    if (++calls === 1) throw new Error("temporary transport failure");
    return { entries: page.entries, hasEarlier: false };
  };
  await assert.rejects(controller.invoke("session.image", request), /temporary transport failure/);
  assert.deepEqual(await controller.invoke("session.image", request), images[0]);
  assert.equal(calls, 2);
  controller.current = { ...snapshot, graph: { ...snapshot.graph!, epoch: "images-2" } };
  await assert.rejects(controller.invoke("session.image", request), /Session changed/);
  assert.deepEqual(await controller.invoke("session.image", { ...request, epoch: "images-2" }), images[0]);
  assert.equal(calls, 3, "a new epoch cannot reuse the old image entry");
});
