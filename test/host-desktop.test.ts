import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { HostClient, localHostStatus, stopLocalHost } from "../src/host/client.js";
import { desktopClientId, DesktopHostController } from "../src/host/desktop.js";
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
  const connectDesktop = async (platform: Platform = { ...headlessPlatform }, id?: string, legacyId?: string) => {
    const desktop = await DesktopHostController.connect(cwd, platform, id, legacyId);
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

test("full quit closes peer desktops without letting their reconnect loops restart the host", async t => {
  const { host, connectDesktop } = await fixture(t);
  let quits = 0;
  const a = await connectDesktop({ ...headlessPlatform, quit() { quits++; } }, "full-quit-a");
  const b = await connectDesktop({ ...headlessPlatform, quit() { quits++; } }, "full-quit-b");
  const state = await localHostStatus();
  await stopLocalHost(state.host!.id, true, true);
  await until(() => quits === 2);
  assert.equal(a.hostShutdownRequested, true);
  assert.equal(b.hostShutdownRequested, true);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await localHostStatus()).host, undefined);
  await assert.rejects(a.invoke("app.bootstrap"), /quitting/);
  await host.shutdown();
});

test("a failed full quit can resume the same desktop view", async t => {
  const { cwd, connectDesktop } = await fixture(t);
  const desktop = await connectDesktop();
  await desktop.invoke("app.bootstrap");
  await desktop.disconnectForQuit();
  await assert.rejects(desktop.invoke("app.bootstrap"), /quitting/);
  await desktop.resumeAfterCancelledQuit();
  const restored = await desktop.invoke("app.bootstrap");
  assert.equal(restored.project.path, realpathSync(cwd));
});

test("a failed quit whose connection cannot resume opens host recovery", async t => {
  const { connectDesktop } = await fixture(t);
  const desktop = await connectDesktop();
  await desktop.disconnectForQuit();
  const events: DesktopEvent[] = [];
  desktop.onEvent(event => events.push(event));
  t.mock.method(HostClient, "connect", async () => { throw new Error("host still shutting down"); });
  await assert.rejects(desktop.resumeAfterCancelledQuit(), /still shutting down/);
  assert.ok(events.some(event => event.type === "host.connection" && (event.payload as { connected: boolean }).connected === false));
});

test("a desktop opens without its host and retains recovery, logs and quit controls", async t => {
  const { cwd, host } = await fixture(t);
  let attempts = 0, quits = 0, logs = 0;
  t.mock.method(HostClient, "connect", async () => { attempts++; throw new Error("Host version is incompatible"); });
  const desktop = DesktopHostController.create(cwd, { ...headlessPlatform, quit() { quits++; }, showItemInFolder() { logs++; } });
  try {
    assert.equal(attempts, 0, "creating the desktop must not depend on a successful host connection");
    await assert.rejects(desktop.invoke("app.bootstrap"), /incompatible/);
    const state = await desktop.invoke("app.hostStatus");
    assert.equal(state.connected, false);
    assert.equal(state.host?.version, host.address.version);
    assert.equal(state.host?.verified, true);
    await desktop.invoke("app.revealLogs");
    await desktop.invoke("app.quit");
    assert.equal(logs, 1);
    assert.equal(quits, 1);
  } finally { desktop.dispose(); }
});

test("desktop power assertions follow all host tasks, live settings and reconnects", async t => {
  const { host, connect, connectDesktop } = await fixture(t);
  const running = new Set<string>();
  t.mock.method(host.owner.registry, "runningPaths", () => new Set(running));
  const assertions: boolean[] = [];
  const desktop = await connectDesktop({ ...headlessPlatform, setKeepAwake(active) { assertions.push(active); } });
  const cli = await connect();
  await until(() => assertions.length > 0);
  assert.deepEqual(assertions, [false]);

  running.add("background-session");
  host.owner.emit({ type: "sessions", payload: {} });
  await until(() => assertions.at(-1) === true);
  running.add("another-session");
  running.delete("background-session");
  await cli.request({ method: "status" });
  assert.deepEqual(assertions, [false, true], "ending one task must not release another task's assertion");

  await cli.invoke("settings.update", { scope: "app", patch: { preventSleepDuringTasks: false } });
  await until(() => assertions.at(-1) === false);
  await cli.invoke("settings.reset", { scope: "app" });
  await until(() => assertions.at(-1) === true);

  const original = Reflect.get(desktop, "client") as HostClient;
  Reflect.get(original, "socket").terminate();
  await until(() => Reflect.get(desktop, "client") !== original && !Reflect.get(desktop, "reconnecting"));
  await until(() => assertions.at(-1) === true);
  assert.deepEqual(assertions.slice(-2), [false, true], "reconnect releases the old assertion and restores active work");

  running.clear();
  host.owner.emit({ type: "sessions", payload: {} });
  await until(() => assertions.at(-1) === false);
  running.add("last-task");
  host.owner.emit({ type: "sessions", payload: {} });
  await until(() => assertions.at(-1) === true);
  await desktop.detach();
  assert.equal(assertions.at(-1), false, "quitting releases the desktop's power assertion");
});

test("running remote tasks keep the desktop awake after switching to a local project", async t => {
  const { host, connect } = await fixture(t);
  const remote: ProjectInfo = { name: "remote", path: "/workspace", remote: { kind: "ssh", host: "test.invalid" } };
  let running = true, connected = true;
  const assertions: boolean[] = [];
  t.mock.method(MainController.prototype, "projectGroups", () => []);
  t.mock.method(MainController.prototype, "invoke", async function(this: MainController) {
    this.settings.rememberProject(remote, [{ path: "/workspace/session.jsonl", running } as never]);
    t.mock.method(this.pool, "slot", () => ({ client: { connected } }) as never);
  });
  const desktop = await connect({ ...headlessPlatform, setKeepAwake(active) { assertions.push(active); } });
  await desktop.invoke("app.bootstrap");
  await until(() => assertions.at(-1) === true);
  connected = false;
  host.owner.emit({ type: "remote.connection", payload: { connected: false } });
  await until(() => assertions.at(-1) === false);
  connected = true;
  host.owner.emit({ type: "remote.connection", payload: { connected: true } });
  await until(() => assertions.at(-1) === true);
  running = false;
  await desktop.invoke("app.bootstrap");
  await until(() => assertions.at(-1) === false);
});

test("screen-on preference works independently, switches live and survives reconnect", async t => {
  const { host, connect, connectDesktop } = await fixture(t);
  const running = new Set<string>();
  t.mock.method(host.owner.registry, "runningPaths", () => new Set(running));
  const states: Array<[boolean, boolean]> = [];
  const desktop = await connectDesktop({ ...headlessPlatform,
    setKeepAwake(active, keepScreenOn = false) { states.push([active, keepScreenOn]); },
  });
  const cli = await connect();
  await until(() => states.length > 0);
  assert.deepEqual(states.at(-1), [false, false]);
  running.add("task");
  host.owner.emit({ type: "sessions", payload: {} });
  await until(() => states.at(-1)?.[0] === true);
  const update = async (patch: Record<string, boolean>, expected: [boolean, boolean]) => {
    await cli.invoke("settings.update", { scope: "app", patch });
    await until(() => JSON.stringify(states.at(-1)) === JSON.stringify(expected));
  };
  await update({ keepScreenOnDuringTasks: true }, [true, true]);
  await update({ keepScreenOnDuringTasks: false }, [true, false]);
  await update({ preventSleepDuringTasks: false, keepScreenOnDuringTasks: true }, [true, true]);
  await update({ keepScreenOnDuringTasks: false }, [false, false]);
  await update({ keepScreenOnDuringTasks: true }, [true, true]);
  const original = Reflect.get(desktop, "client") as HostClient;
  Reflect.get(original, "socket").terminate();
  await until(() => Reflect.get(desktop, "client") !== original && !Reflect.get(desktop, "reconnecting"));
  await until(() => states.at(-1)?.[1] === true);
  assert.deepEqual(states.slice(-2), [[false, false], [true, true]]);
  running.clear();
  host.owner.emit({ type: "sessions", payload: {} });
  await until(() => states.at(-1)?.[0] === false);
});

test("power-state lookup failures cannot reject unrelated host requests or crash event delivery", async t => {
  const { host, connect } = await fixture(t);
  const desktop = await connect({ ...headlessPlatform });
  const failure = t.mock.method(host.owner.registry, "runningPaths", () => { throw new Error("Runtime is closing"); });
  assert.ok(await desktop.invoke("settings.get"));
  host.owner.emit({ type: "sessions", payload: {} });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(await desktop.invoke("settings.get"));
  failure.mock.restore();
});

test("terminal input and platform replies do not repeatedly read power settings", async t => {
  const { host, connect } = await fixture(t);
  const desktop = await connect({ ...headlessPlatform });
  // Drain the initial capability reply before measuring unrelated traffic.
  await new Promise(resolve => setTimeout(resolve, 20));
  const bundle = t.mock.method(host.owner.settings, "bundle");
  t.mock.method(MainController.prototype, "invoke", async () => ({ ok: true }));
  for (let i = 0; i < 5; i++) await desktop.invoke("terminal.write", { id: "terminal", data: "x" });
  assert.equal(bundle.mock.callCount(), 0, "typing must not perform synchronous power-settings I/O per keystroke");
});

test("power-release failures cannot prevent desktop reconnection or detachment", async t => {
  const { connectDesktop } = await fixture(t);
  const desktop = await connectDesktop({ ...headlessPlatform, setKeepAwake() { throw new Error("Power service unavailable"); } });
  const original = Reflect.get(desktop, "client") as HostClient;
  Reflect.get(original, "socket").terminate();
  await until(() => Reflect.get(desktop, "client") !== original && !Reflect.get(desktop, "reconnecting"));
  assert.ok(await desktop.invoke("app.bootstrap"));
  await desktop.detach();
});

test("clients without the optional power capability receive no unsupported callbacks", async t => {
  const { host, connect } = await fixture(t);
  const replies: unknown[] = [];
  const send = Reflect.get(HostClient.prototype, "send");
  t.mock.method(HostClient.prototype as any, "send", function(this: HostClient, message: { type: string; error?: string }) {
    if (message.type === "platform.reply" && message.error) replies.push(message);
    return send.call(this, message);
  });
  const { setKeepAwake: _, ...platform } = headlessPlatform;
  const client = await connect(platform, "legacy-desktop");
  await client.request({ method: "status" });
  t.mock.method(host.owner.registry, "runningPaths", () => new Set(["running-session"]));
  host.owner.emit({ type: "sessions", payload: {} });
  await client.invoke("settings.update", { scope: "app", patch: { preventSleepDuringTasks: false } });
  await client.request({ method: "status" });
  assert.deepEqual(replies, [], "optional capabilities must not generate errors for existing desktop clients");
});

test("each desktop maintains its own power assertion when another desktop detaches", async t => {
  const { host, connectDesktop } = await fixture(t);
  const running = new Set(["already-running"]);
  t.mock.method(host.owner.registry, "runningPaths", () => new Set(running));
  const firstStates: boolean[] = [], secondStates: boolean[] = [];
  const first = await connectDesktop({ ...headlessPlatform, setKeepAwake(active) { firstStates.push(active); } });
  await connectDesktop({ ...headlessPlatform, setKeepAwake(active) { secondStates.push(active); } });
  await until(() => firstStates.at(-1) === true && secondStates.at(-1) === true);
  await first.detach();
  assert.equal(firstStates.at(-1), false);
  assert.deepEqual(secondStates, [true]);
  running.clear();
  host.owner.emit({ type: "sessions", payload: {} });
  await until(() => secondStates.at(-1) === false);
});

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

test("desktop identities preserve packaged upgrades and portable restarts while isolating dev worktrees", () => {
  const profile = "/profiles/pix";
  const packaged = desktopClientId(profile, "/tmp/extract-A/app.asar", true);
  assert.equal(packaged, `desktop-${createHash("sha256").update(profile).digest("hex")}`, "existing packaged clients must reclaim their retained host view");
  assert.equal(desktopClientId(profile, "/tmp/extract-B/app.asar", true), packaged, "portable extraction paths must not change the identity");
  assert.notEqual(desktopClientId("/profiles/other", "/tmp/extract-A/app.asar", true), packaged);
  const dev = desktopClientId(profile, "/source/pix", false);
  assert.notEqual(dev, packaged);
  assert.equal(desktopClientId(profile, "/source/pix", false), dev, "dev restarts reuse their identity");
  assert.notEqual(desktopClientId(profile, "/source/other-worktree", false), dev);
});

test("desktops sharing a profile retain independent views across reconnects", async t => {
  const { host, cwd, connectDesktop } = await fixture(t);
  const controllers = new Map<DesktopHostController, MainController>();
  let invoked!: MainController;
  const invoke = MainController.prototype.invoke;
  t.mock.method(MainController.prototype, "invoke", function(this: MainController, ...args: Parameters<MainController["invoke"]>) {
    invoked = this;
    return invoke.apply(this, args);
  });
  const first = await connectDesktop(undefined, desktopClientId(cwd, "/installed/app.asar", true));
  await first.invoke("app.bootstrap");
  controllers.set(first, invoked);
  const firstClient = Reflect.get(first, "client") as HostClient;
  const second = await connectDesktop(undefined, desktopClientId(cwd, "/source/pix", false), desktopClientId(cwd, "", true));
  await second.invoke("app.bootstrap");
  controllers.set(second, invoked);
  assert.equal(firstClient.connected, true);
  assert.equal(Reflect.get(first, "client"), firstClient);
  assert.notEqual(Reflect.get(first, "clientId"), Reflect.get(second, "clientId"));
  assert.notEqual(controllers.get(first), controllers.get(second));

  const desktops = [first, second];
  for (const index of [0, 1]) {
    const desktop = desktops[index]!, other = desktops[1 - index]!;
    const original = Reflect.get(desktop, "client") as HostClient;
    const unaffected = Reflect.get(other, "client") as HostClient;
    const id = Reflect.get(desktop, "clientId");
    Reflect.get(original, "socket").terminate();
    await until(() => Reflect.get(desktop, "client") !== original && !Reflect.get(desktop, "reconnecting"));
    await desktop.invoke("app.bootstrap");
    assert.equal(invoked, controllers.get(desktop), "reconnect restores the desktop's original view");
    assert.equal(Reflect.get(desktop, "clientId"), id);
    await other.invoke("app.bootstrap");
    assert.equal(invoked, controllers.get(other));
    assert.equal(Reflect.get(other, "client"), unaffected, "the other desktop must not reconnect");
    assert.equal(unaffected.connected, true);

    const viewCount = Reflect.get(host.owner.registry, "views").size;
    await desktop.detach();
    const restarted = await connectDesktop(undefined, desktopClientId(cwd,
      index === 0 ? "/updated/app.asar" : "/source/pix", index === 0), index === 0 ? undefined : desktopClientId(cwd, "", true));
    await restarted.invoke("app.bootstrap");
    assert.equal(invoked, controllers.get(desktop), "a full desktop restart restores its retained view");
    desktops[index] = restarted;
    controllers.set(restarted, invoked);
    assert.equal(Reflect.get(host.owner.registry, "views").size, viewCount, "restarting must not accumulate orphaned views");
    await other.invoke("app.bootstrap");
    assert.equal(Reflect.get(other, "client"), unaffected);
  }
});

test("legacy view migration moves ownership once and preserves the new view on later restarts", async t => {
  const { host, cwd, connectDesktop } = await fixture(t);
  let invoked!: MainController;
  const invoke = MainController.prototype.invoke;
  t.mock.method(MainController.prototype, "invoke", function(this: MainController, ...args: Parameters<MainController["invoke"]>) {
    invoked = this; return invoke.apply(this, args);
  });
  const legacyId = desktopClientId(cwd, "", true), devId = desktopClientId(cwd, "/source/pix", false);
  const legacy = await connectDesktop(undefined, legacyId);
  await legacy.invoke("app.bootstrap");
  const retained = invoked;
  await legacy.detach();
  const dev = await connectDesktop(undefined, devId, legacyId);
  await dev.invoke("app.bootstrap");
  assert.equal(invoked, retained, "migration must reuse the controller, selection and remote pool");
  assert.equal(Reflect.get(host.owner.registry, "views").size, 2, "migration must not leave a legacy alias or a new registry view");

  const packaged = await connectDesktop(undefined, legacyId);
  await packaged.invoke("app.bootstrap");
  const packagedView = invoked;
  assert.notEqual(packagedView, retained, "the released legacy identity must own an independent view");
  await packaged.detach();
  await dev.detach();
  const restarted = await connectDesktop(undefined, devId, legacyId);
  await restarted.invoke("app.bootstrap");
  assert.equal(invoked, retained, "an existing dev view wins over the legacy fallback");
  const packagedRestarted = await connectDesktop(undefined, legacyId);
  await packagedRestarted.invoke("app.bootstrap");
  assert.equal(invoked, packagedView);
  assert.equal(Reflect.get(host.owner.registry, "views").size, 3);
});

test("a delayed legacy socket close cannot detach or suspend its migrated view", async t => {
  let socket!: WebSocket, invoked!: MainController;
  const serverEmit = WebSocketServer.prototype.emit;
  t.mock.method(WebSocketServer.prototype, "emit", function(this: WebSocketServer, event: string, ...args: any[]) {
    if (event === "connection" && !socket) socket = args[0];
    return serverEmit.call(this, event, ...args);
  });
  const { connectDesktop } = await fixture(t);
  const invoke = MainController.prototype.invoke;
  t.mock.method(MainController.prototype, "invoke", function(this: MainController, ...args: Parameters<MainController["invoke"]>) {
    invoked = this; return invoke.apply(this, args);
  });
  const legacy = await connectDesktop(undefined, "legacy-desktop");
  await legacy.invoke("app.bootstrap");
  const retained = invoked;
  const detach = t.mock.method(retained, "detach"), suspend = t.mock.method(retained, "suspend");
  const socketEmit = socket.emit;
  let deferred: any[] | undefined;
  const closing = t.mock.method(socket, "emit", function(this: WebSocket, event: string, ...args: any[]) {
    if (event === "close") { deferred = args; return true; }
    return socketEmit.call(this, event, ...args);
  });
  try {
    await legacy.detach();
    await until(() => socket.readyState === WebSocket.CLOSED && Boolean(deferred));
    const migrated = await connectDesktop(undefined, "dev-desktop", "legacy-desktop");
    await migrated.invoke("app.bootstrap");
    assert.equal(invoked, retained);
    closing.mock.restore();
    socketEmit.call(socket, "close", ...deferred!);
    deferred = undefined;
    assert.equal(detach.mock.callCount(), 0);
    assert.equal(suspend.mock.callCount(), 0);
    assert.ok(await migrated.invoke("app.bootstrap"));
  } finally {
    closing.mock.restore();
    if (deferred) socketEmit.call(socket, "close", ...deferred);
  }
});

test("concurrent dev migrations cannot claim the same retained legacy view twice", async t => {
  const { host, cwd, connectDesktop } = await fixture(t);
  let invoked!: MainController;
  const invoke = MainController.prototype.invoke;
  t.mock.method(MainController.prototype, "invoke", function(this: MainController, ...args: Parameters<MainController["invoke"]>) {
    invoked = this; return invoke.apply(this, args);
  });
  const legacyId = desktopClientId(cwd, "", true);
  const legacy = await connectDesktop(undefined, legacyId);
  await legacy.invoke("app.bootstrap");
  const retained = invoked;
  await legacy.detach();
  const desktops = await Promise.all(["/source/first", "/source/second"].map(path =>
    connectDesktop(undefined, desktopClientId(cwd, path, false), legacyId)));
  const views: MainController[] = [];
  for (const desktop of desktops) { await desktop.invoke("app.bootstrap"); views.push(invoked); }
  assert.equal(views.filter(view => view === retained).length, 1);
  assert.notEqual(views[0], views[1]);
  assert.equal(Reflect.get(host.owner.registry, "views").size, 3);
});

test("an old host without migration support rejects migration without attaching or disconnecting its existing desktop", async t => {
  const { host, cwd, connectDesktop } = await fixture(t);
  const legacyId = desktopClientId(cwd, "", true);
  const legacy = await connectDesktop(undefined, legacyId);
  const original = Reflect.get(legacy, "client") as HostClient;
  const views = Reflect.get(host.owner.registry, "views").size;
  await assert.rejects(HostClient.connect({ ...host.address, desktopViewMigration: undefined }, cwd, { ...headlessPlatform },
    desktopClientId(cwd, "/source/pix", false), true, legacyId), /cannot migrate the previous desktop view/);
  assert.equal(Reflect.get(host.owner.registry, "views").size, views);
  assert.equal(original.connected, true);
  assert.equal(Reflect.get(legacy, "client"), original);
  assert.ok(await legacy.invoke("app.bootstrap"));
});

test("invalid migration identities cannot change ownership of a retained desktop", async t => {
  const { host, cwd, connectDesktop } = await fixture(t);
  const legacy = await connectDesktop(undefined, "legacy-desktop");
  await legacy.detach();
  const views = Reflect.get(host.owner.registry, "views").size;
  for (const invalid of ["", "invalid/identity", 123])
    await assert.rejects(HostClient.connect(host.address, cwd, { ...headlessPlatform }, "dev-desktop", true, invalid as string), /Invalid previous desktop client identity/);
  await assert.rejects(HostClient.connect(host.address, cwd, undefined, "dev-desktop", true, "legacy-desktop"), /Invalid desktop client identity/);
  assert.equal(Reflect.get(host.owner.registry, "views").size, views);
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

for (const recovery of ["reconnect", "restart", "migration"] as const)
for (const kind of ["ssh", "wsl"] as const) test(`desktop ${recovery} retains ${kind} images and can stop its running session`, async t => {
  const { host, cwd, connectDesktop } = await fixture(t);
  const controllers: MainController[] = [];
  const invoke = MainController.prototype.invoke;
  t.mock.method(MainController.prototype, "invoke", function(this: MainController, ...args: Parameters<MainController["invoke"]>) {
    controllers.push(this); return invoke.apply(this, args);
  });
  let desktop = await connectDesktop(undefined, desktopClientId(cwd, "/tmp/extract-A/app.asar", true));
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
  if (recovery === "restart" || recovery === "migration") {
    await desktop.detach();
    const migrated = recovery === "migration";
    desktop = await connectDesktop(undefined, desktopClientId(cwd, migrated ? "/source/pix" : "/tmp/extract-B/app.asar", !migrated),
      migrated ? desktopClientId(cwd, "", true) : undefined);
  } else {
    Reflect.get(client, "socket").terminate();
    await until(() => Reflect.get(desktop, "client") !== client && !Reflect.get(desktop, "reconnecting"));
  }
  const bootstrap = await desktop.invoke("app.bootstrap");
  assert.deepEqual(bootstrap.project, project);
  assert.equal(controllers.at(-1), controller, "recovery takes over the original remote pool");
  assert.equal(controller.pool.slot(projectId(project))?.client, remote);
  assert.deepEqual(await desktop.invoke("session.image", reference), image, "image references survive desktop recovery");
  await desktop.invoke("session.stop", { path, projectId: projectId(project) });
  assert.equal(stops, 1);
  assert.equal(disposed, false);
  // Quit after completion: the connection must be released and no longer block shutdown.
  desktop.dispose();
  await until(() => disposed);
  assert.equal(controller.pool.hasConnections, false);
  assert.equal(host.owner.hasPendingWork, false);
});
