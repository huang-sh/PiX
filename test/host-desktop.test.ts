import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { once } from "node:events";
import { HostClient } from "../src/host/client.js";
import { DesktopHostController } from "../src/host/desktop.js";
import { headlessPlatform, serveLocalHost } from "../src/host/local-host.js";
import { MainController, type Platform } from "../src/main/controller.js";
import { projectId, type DesktopEvent, type ProjectInfo, type RawSessionEntry, type SessionSnapshot } from "../src/shared/types.js";
import { projectSession } from "../src/shared/session.js";
import { sessionEventDecoder, type SessionUpdate } from "../src/shared/session-updates.js";
import { sessionImageEncoder } from "../src/shared/session-images.js";
import { agentMessageContent } from "../src/shared/agent-stream.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Timed out waiting for desktop recovery");
}
async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "pix-desktop-host-"));
  const cwd = join(home, "workspace"); mkdirSync(cwd);
  const previous = { PIX_HOME: process.env.PIX_HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
  Object.assign(process.env, { PIX_HOME: home, PI_CODING_AGENT_DIR: join(home, ".pix/agent"), PI_OFFLINE: "1" });
  const fetch = globalThis.fetch;
  const host = await serveLocalHost();
  const clients: HostClient[] = [];
  const desktops: DesktopHostController[] = [];
  t.after(async () => {
    desktops.forEach(desktop => desktop.dispose());
    clients.forEach(client => client.close());
    await host.shutdown();
    globalThis.fetch = fetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  const connect = async (platform?: Platform, id?: string) => {
    const client = await HostClient.connect(host.address, cwd, platform, id);
    clients.push(client); return client;
  };
  const connectDesktop = async () => {
    const desktop = await DesktopHostController.connect(cwd, { ...headlessPlatform });
    desktops.push(desktop); return desktop;
  };
  return { host, cwd, connect, connectDesktop };
}

async function desktopView(t: TestContext) {
  const { cwd, connectDesktop } = await fixture(t);
  let controller!: MainController;
  const invoke = MainController.prototype.invoke;
  t.mock.method(MainController.prototype, "invoke", function(this: MainController, ...args: Parameters<MainController["invoke"]>) {
    controller = this;
    return invoke.apply(this, args);
  });
  const desktop = await connectDesktop();
  await desktop.invoke("app.bootstrap");
  return { cwd, desktop, controller };
}

test("desktop IPC sends image references, keeps subscriber baselines independent and supports resync", async t => {
  const { cwd, desktop, controller } = await desktopView(t);
  const events: DesktopEvent[] = [], fullEvents: DesktopEvent[] = [];
  const stop = desktop.onEvent(event => events.push(structuredClone(event)), true);
  desktop.onEvent(event => fullEvents.push(event));
  const decode = sessionEventDecoder(async () => assert.fail("unexpected renderer resync"));
  const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const entries: RawSessionEntry[] = [{ type: "message", id: "prompt", parentId: null, timestamp: "2026-10-27", message: {
    role: "user", content: [{ type: "text", text: "inspect image" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=".repeat(250_000) }],
  } }];
  const snapshot = (revision: number): SessionSnapshot => ({
    session: { id: "s", path: join(cwd, "session.jsonl"), cwd, created: "", modified: "", messageCount: entries.length, firstMessage: "inspect image" },
    entries: [...entries], projection: projectSession(entries, entries.at(-1)!.id),
    runtime: { available: true } as SessionSnapshot["runtime"], graph: { id: "s", epoch: "e", revision, runs: [] },
  });
  const publish = async (revision: number, resync = false) => {
    const current = snapshot(revision), count = events.length;
    controller.emit({ type: "sessions", payload: { current, resync } });
    await until(() => events.length > count);
    assert.deepEqual(wire((fullEvents.at(-1)!.payload as SessionUpdate).current), wire(sessionImageEncoder()(current)), "desktop consumers receive history references");
    assert.deepEqual(wire((decode(events.at(-1)!)!.payload as SessionUpdate).current), wire(sessionImageEncoder()(current)));
    assert.ok(JSON.stringify(events.at(-1)).length < 5000, "checkpoints must not retransmit historical image bytes");
    return events.at(-1)!;
  };
  await publish(1);
  assert.ok((events[0]!.payload as SessionUpdate).current, "a new subscriber starts with a checkpoint");
  for (let revision = 2; revision <= 10; revision++) {
    entries.push({ type: "message", id: `answer-${revision}`, parentId: entries.at(-1)!.id, timestamp: "2026-10-27",
      message: { role: "assistant", content: [{ type: "text", text: `answer ${revision}` }] } });
    const event = await publish(revision);
    assert.ok((event.payload as SessionUpdate).patch, "desktop must re-encode the host's decoded snapshot before IPC");
    assert.ok(JSON.stringify(event).length < 5000, "incremental IPC must not retransmit unchanged images");
  }
  const lateEvents: DesktopEvent[] = [];
  const stopLate = desktop.onEvent(event => lateEvents.push(event), true);
  await publish(11);
  assert.ok((lateEvents[0]!.payload as SessionUpdate).current, "late subscribers cannot use another subscriber's baseline");
  assert.ok((events.at(-1)!.payload as SessionUpdate).patch);
  const checkpoint = await publish(12, true);
  assert.ok((checkpoint.payload as SessionUpdate).current, "resync forces a checkpoint");
  const incremental = await publish(13);
  assert.ok((incremental.payload as SessionUpdate).patch);
  stop(); stopLate();
  const count = events.length, lateCount = lateEvents.length, fullCount = fullEvents.length;
  controller.emit({ type: "notice", payload: { message: "after unsubscribe" } });
  await until(() => fullEvents.length > fullCount);
  assert.equal(events.length, count);
  assert.equal(lateEvents.length, lateCount);
});

test("CLI clients keep inline images in snapshots and events without opting into references", async t => {
  const { cwd, connect } = await fixture(t);
  let controller!: MainController;
  const invoke = MainController.prototype.invoke;
  t.mock.method(MainController.prototype, "invoke", function(this: MainController, ...args: Parameters<MainController["invoke"]>) {
    controller = this;
    return invoke.apply(this, args);
  });
  const client = await connect();
  await client.invoke("app.bootstrap");
  const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
  const entries: RawSessionEntry[] = [{ type: "message", id: "prompt", parentId: null, timestamp: "2026-10-28",
    message: { role: "user", content: [image] } }];
  controller.current = { session: { path: join(cwd, "session.jsonl") }, entries,
    projection: projectSession(entries, "prompt"), runtime: { available: true },
    graph: { id: "s", epoch: "e", revision: 1, runs: [] } } as unknown as SessionSnapshot;
  const events: DesktopEvent[] = [];
  client.onEvent(event => events.push(event));
  const current = await client.invoke<SessionSnapshot>("session.snapshot");
  await until(() => events.some(event => event.type === "sessions" && (event.payload as SessionUpdate).current));
  assert.deepEqual(current.projection.messages[0]!.images, [image]);
  const event = events.find(event => event.type === "sessions" && (event.payload as SessionUpdate).current)!;
  const delivered = (event.payload as SessionUpdate).current!;
  assert.deepEqual(delivered.projection.messages[0]!.images, [image]);
  assert.deepEqual(delivered.entries, entries, "CLI export/retry paths retain original bytes");
});

test("desktop IPC streams appended text and tool output instead of repeating their growing prefixes", async t => {
  const { desktop, controller } = await desktopView(t);
  const events: DesktopEvent[] = [];
  desktop.onEvent(event => events.push(structuredClone(event)), true);
  const decode = sessionEventDecoder(async () => assert.fail("unexpected renderer resync"));
  const prefix = "中文🙂 long output ".repeat(10_000);
  for (let i = 0; i < 4; i++) {
    for (const original of [
      { type: "agent", payload: { type: "message_update", graphId: "g", branchId: "b", runId: "r",
        message: { role: "assistant", content: [{ type: "text", text: prefix + "a".repeat(i) }, { type: "thinking", thinking: "think" + "b".repeat(i) }] } } },
      { type: "agent", payload: { type: "tool_execution_update", graphId: "g", branchId: "b", runId: "r", toolCallId: "t", partialResult: prefix + "c".repeat(i) } },
    ] satisfies DesktopEvent[]) {
      const count = events.length;
      controller.emit(original);
      await until(() => events.length > count);
      const event = events.at(-1)!;
      assert.ok((event.payload as any).progress, "desktop IPC must retain progress encoding across the host hop");
      if (i) assert.ok(JSON.stringify(event).length < 1000, "streaming payload size must not grow with accumulated output");
      const payload = decode(event)!.payload as any;
      if (original.payload.type === "message_update") {
        assert.equal(agentMessageContent(payload.message, "text"), agentMessageContent(original.payload.message, "text"));
        assert.equal(agentMessageContent(payload.message, "thinking"), agentMessageContent(original.payload.message, "thinking"));
      } else assert.equal(payload.partialResult, prefix + "c".repeat(i));
    }
  }
});

test("shared session browser callbacks follow the connected desktop and its replacement", async t => {
  const { host, cwd, connect } = await fixture(t);
  const opened: string[] = [];
  const first = await connect({ ...headlessPlatform, async openExternal(url) { opened.push(`first:${url}`); } }, "desktop");
  const runtime = host.owner.createSessionRuntime({ path: "unused", project: { name: "workspace", path: cwd }, dir: null, lastUsed: 0 });
  await runtime.openExternal("https://example.invalid/first");
  const closed = new Promise<void>(resolve => first.onDisconnect(() => resolve()));
  first.close(); await closed;
  await connect({ ...headlessPlatform, async openExternal(url) { opened.push(`second:${url}`); } }, "desktop");
  await runtime.openExternal("https://example.invalid/second");
  assert.deepEqual(opened, ["first:https://example.invalid/first", "second:https://example.invalid/second"]);
});

test("the host resolves system proxy decisions through the desktop capability", async t => {
  const { connect } = await fixture(t);
  const server = createServer((_request, response) => response.end("through host"));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/model`;
  const decisions: string[] = [];
  const client = await connect({ ...headlessPlatform, async resolveProxy(target) { decisions.push(target); return "DIRECT"; } }, "desktop");
  assert.equal(await (await fetch(url)).text(), "through host");
  assert.deepEqual(decisions, [url]);
  const closed = new Promise<void>(resolve => client.onDisconnect(() => resolve()));
  client.close(); await closed;
  assert.equal(await (await fetch(url)).text(), "through host", "accepted work retains the last known route while no GUI is attached");
});

test("independent desktops do not take over each other's views", async t => {
  const { connectDesktop } = await fixture(t);
  const first = await connectDesktop();
  const second = await connectDesktop();
  const firstClient = Reflect.get(first, "client") as HostClient;
  await second.invoke("app.bootstrap");
  assert.equal(firstClient.connected, true);
  assert.equal(Reflect.get(first, "client"), firstClient);
  assert.notEqual(Reflect.get(first, "clientId"), Reflect.get(second, "clientId"));
});

test("desktop quit remains available when the host cannot serve requests", async t => {
  const { cwd } = await fixture(t);
  let quits = 0;
  const desktop = await DesktopHostController.connect(cwd, { ...headlessPlatform, quit() { quits++; } });
  const client = Reflect.get(desktop, "client") as HostClient;
  t.mock.method(client, "invoke", async () => { throw new Error("Host unavailable"); });
  try {
    assert.deepEqual(await desktop.invoke("app.quit"), { ok: true });
    assert.equal(quits, 1);
  } finally { desktop.dispose(); }
});

test("a second disconnect during desktop recovery does not leave recovery waiting on itself", async t => {
  const { connectDesktop } = await fixture(t);
  const desktop = await connectDesktop();
  const original = Reflect.get(desktop, "client") as HostClient;
  const bind = Reflect.get(desktop, "bind");
  const notices: unknown[] = [];
  let interrupted = false;
  desktop.onEvent(event => { if (event.type === "notice") notices.push(event); });
  const binding = t.mock.method(desktop as any, "bind", (client: HostClient) => {
    bind.call(desktop, client);
    if (!interrupted) {
      interrupted = true;
      Reflect.get(client, "socket").terminate();
    }
  });
  Reflect.get(original, "socket").terminate();
  await until(() => Reflect.get(desktop, "client") !== original && !Reflect.get(desktop, "reconnecting"));
  assert.ok(notices.some(event => JSON.stringify(event).includes("error")));
  binding.mock.restore();
  assert.ok(await desktop.invoke("app.bootstrap"));
});

for (const kind of ["ssh", "wsl"] as const) test(`desktop reconnect retains ${kind} images and can stop its running session`, async t => {
  const { host, connectDesktop } = await fixture(t);
  const controllers: MainController[] = [];
  const invoke = MainController.prototype.invoke;
  t.mock.method(MainController.prototype, "invoke", function(this: MainController, ...args: Parameters<MainController["invoke"]>) {
    controllers.push(this); return invoke.apply(this, args);
  });
  const desktop = await connectDesktop();
  await desktop.invoke("app.bootstrap");
  const controller = controllers[0]!;
  const project: ProjectInfo = { name: "remote", path: "/workspace", remote: kind === "ssh"
    ? { kind, host: "test.invalid" } : { kind, distro: "Ubuntu" } };
  const path = "/workspace/session.jsonl";
  const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
  const entries: RawSessionEntry[] = [{ type: "message", id: "prompt", parentId: null, timestamp: "2026-10-28",
    message: { role: "user", content: [image] } }];
  const snapshot = { session: { path }, entries, projection: projectSession(entries, "prompt"), runtime: { isStreaming: true },
    graph: { id: path, epoch: "remote", revision: 1, runs: [] } } as unknown as SessionSnapshot;
  let running = true, stops = 0, disposed = false;
  const events = new EventEmitter();
  const remote = {
    connected: true,
    async request(route: string) {
      assert.notEqual(route, "session.image", "old remote hosts do not need to implement image reads");
      if (route === "session.list") return [{ path, running }];
      if (route === "settings.get") return controller.settings.bundle();
      if (route === "session.snapshot" || route === "session.open") return snapshot;
      if (route === "session.stop") { stops++; running = false; return { stopped: true }; }
      return [];
    },
    onEvent(listener: (...args: any[]) => void) { events.on("event", listener); return () => events.off("event", listener); },
    onDisconnect() { return () => {}; },
    async dispose() { disposed = true; this.connected = false; }, async abandon() { this.connected = false; },
  };
  controller.project = project;
  controller.current = snapshot;
  controller.settings.rememberProject(project, [{ path, running: true } as never]);
  controller.installSlot(remote as never, project, controller.settings.bundle()).activePath = path;
  const initial = await desktop.invoke("app.bootstrap");
  const reference = initial.current.projection.messages[0].images[0].reference;
  assert.equal(reference.session, path);
  assert.deepEqual(await desktop.invoke("session.image", reference), image);
  remote.connected = false;
  assert.deepEqual(await desktop.invoke("session.image", reference), image, "cached images survive remote transport loss");
  remote.connected = true;
  const client = Reflect.get(desktop, "client") as HostClient;
  Reflect.get(client, "socket").terminate();
  await until(() => Reflect.get(desktop, "client") !== client && !Reflect.get(desktop, "reconnecting"));
  const bootstrap = await desktop.invoke("app.bootstrap");
  assert.deepEqual(bootstrap.project, project);
  assert.equal(controllers.at(-1), controller, "reconnect takes over the original remote pool");
  assert.equal(controller.pool.slot(projectId(project))?.client, remote);
  assert.deepEqual(await desktop.invoke("session.image", reference), image, "image references survive desktop reconnect");
  await desktop.invoke("session.stop", { path, projectId: projectId(project) });
  assert.equal(stops, 1);
  assert.equal(disposed, false);
  // Quit after completion: the connection must be released and no longer block shutdown.
  desktop.dispose();
  await until(() => disposed);
  assert.equal(controller.pool.hasConnections, false);
  assert.equal(host.owner.hasPendingWork, false);
});
