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
import { projectId, type ProjectInfo, type SessionSnapshot } from "../src/shared/types.js";
import { projectSession } from "../src/shared/session.js";

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

test("desktop reconnect retains its remote workspace and can stop its running session", async t => {
  const { host, connectDesktop } = await fixture(t);
  const controllers: MainController[] = [];
  const invoke = MainController.prototype.invoke;
  t.mock.method(MainController.prototype, "invoke", function(this: MainController, ...args: Parameters<MainController["invoke"]>) {
    controllers.push(this); return invoke.apply(this, args);
  });
  const desktop = await connectDesktop();
  await desktop.invoke("app.bootstrap");
  const controller = controllers[0]!;
  const project: ProjectInfo = { name: "remote", path: "/workspace", remote: { kind: "ssh", host: "test.invalid" } };
  const path = "/workspace/session.jsonl";
  const snapshot = { session: { path }, entries: [], projection: projectSession([], null), runtime: { isStreaming: true },
    graph: { id: path, epoch: "remote", revision: 1, runs: [] } } as unknown as SessionSnapshot;
  let running = true, stops = 0, disposed = false;
  const events = new EventEmitter();
  const remote = {
    connected: true,
    async request(route: string) {
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
  await desktop.invoke("app.bootstrap");
  const client = Reflect.get(desktop, "client") as HostClient;
  Reflect.get(client, "socket").terminate();
  await until(() => Reflect.get(desktop, "client") !== client && !Reflect.get(desktop, "reconnecting"));
  const bootstrap = await desktop.invoke("app.bootstrap");
  assert.deepEqual(bootstrap.project, project);
  assert.equal(controllers.at(-1), controller, "reconnect takes over the original remote pool");
  assert.equal(controller.pool.slot(projectId(project))?.client, remote);
  await desktop.invoke("session.stop", { path, projectId: projectId(project) });
  assert.equal(stops, 1);
  assert.equal(disposed, false);
  // Quit after completion: the connection must be released and no longer block shutdown.
  desktop.dispose();
  await until(() => disposed);
  assert.equal(controller.pool.hasConnections, false);
  assert.equal(host.owner.hasPendingWork, false);
});
