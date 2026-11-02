import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { connectLocalHost, HostClient, localHostInstallInProgress, localHostStatus, releaseInstallReservation, reserveLocalHostForInstall, restartLocalHost, stopLocalHost, withStoppedLocalHost } from "../src/host/client.js";
import { headlessPlatform, serveLocalHost } from "../src/host/local-host.js";
import { RemoteWorkspacePool } from "../src/main/remote-pool.js";
import { WslHostClient } from "../src/main/wsl-host-client.js";
import { GitService } from "../src/main/services.js";
import { offerMacInstall } from "../src/main/mac-install.js";
import { LOCAL_HOST_PROTOCOL, type HostAddress } from "../src/shared/host-protocol.js";
import { PIX_HOST_VERSION } from "../src/shared/remote-protocol.js";

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Timed out waiting for host shutdown");
}
async function profile(job: (file: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "pix-host-client-"));
  const values = { PIX_HOME: home, PI_CODING_AGENT_DIR: join(home, ".pix", "agent"), PI_OFFLINE: "1",
    PIX_HOST_ENTRY: fileURLToPath(new URL("../src/host/index.js", import.meta.url)) };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const fetch = globalThis.fetch;
  Object.assign(process.env, values);
  const file = join(home, ".pix", "run", "host.json");
  mkdirSync(join(file, ".."), { recursive: true });
  try { await job(file); }
  finally {
    try {
      if (existsSync(file)) {
        const address = JSON.parse(readFileSync(file, "utf8")) as HostAddress;
        if (address.pid !== process.pid) {
          try { process.kill(address.pid, "SIGTERM"); } catch {}
          await until(() => !existsSync(file));
        }
      }
    } finally {
      globalThis.fetch = fetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  }
}
const address = (port: number): HostAddress => ({ protocol: LOCAL_HOST_PROTOCOL, version: PIX_HOST_VERSION,
  pid: process.pid, port, token: "stale-test-token" });

for (const phase of ["handshake", "status", "late-status-reply", "shutdown"] as const)
test(`automatic upgrade honours cancellation during ${phase}`, async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  const connections = new Set<import("node:net").Socket>();
  let opened = 0, stops = 0, ready!: () => void, replyStatus = () => {}, replyShutdown = () => {};
  const pending = new Promise<void>(resolve => { ready = resolve; });
  server.on("connection", socket => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("end", () => socket.destroy());
  });
  server.on("upgrade", (request, socket, head) => {
    // Two version checks precede the upgrade's management connection.
    if (++opened === 3 && phase === "handshake") { socket.resume(); ready(); return; }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit("connection", ws, request));
  });
  sockets.on("connection", socket => socket.on("message", data => {
    const request = JSON.parse(String(data));
    if (request.method === "status") {
      replyStatus = () => socket.send(JSON.stringify({ type: "reply", id: request.id, result: { clients: 1 } }));
      if (phase === "shutdown") replyStatus();
      else ready();
    } else if (request.method === "shutdown") {
      stops++;
      replyShutdown = () => socket.send(JSON.stringify({ type: "reply", id: request.id, result: { stopped: true } }));
      if (phase === "shutdown") ready();
      else replyShutdown();
    }
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await profile(async file => {
      const old = { ...address((server.address() as { port: number }).port), version: "0.0.31" };
      writeFileSync(file, JSON.stringify(old));
      const abort = new AbortController(), reason = new Error("Window closed during upgrade");
      let settled = false;
      const connecting = connectLocalHost(null, undefined, true, undefined, false, undefined, undefined, abort.signal)
        .finally(() => { settled = true; });
      void connecting.catch(() => {});
      try {
        await pending;
        abort.abort(reason);
        if (phase === "late-status-reply") replyStatus();
        if (phase === "shutdown") {
          await new Promise(resolve => setTimeout(resolve, 100));
          assert.equal(settled, false, "a committed shutdown must still await its acknowledgement");
          assert.equal(existsSync(join(file, "..", "starting")), true);
          replyShutdown();
        }
        await Promise.race([connecting.catch(() => {}), new Promise(resolve => setTimeout(resolve, 500))]);
        assert.equal(settled, true, "a cancelled upgrade must not wait for the management timeout");
        await assert.rejects(connecting, error => error === reason);
        assert.equal(stops, phase === "shutdown" ? 1 : 0, "cancellation must not send a new shutdown request");
        await until(() => connections.size === 0);
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), old);
        assert.equal(existsSync(join(file, "..", "starting")), false);
      } finally {
        for (const socket of connections) socket.destroy();
        await connecting.catch(() => {});
      }
    });
  } finally {
    for (const socket of connections) socket.destroy();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const phase of ["handshake", "attach", "status"] as const)
test(`cancelling a connection during ${phase} promptly releases its socket without replacing the host`, async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  let stalled!: () => void;
  const ready = new Promise<void>(resolve => { stalled = resolve; });
  const connections = new Set<import("node:net").Socket>();
  server.on("connection", socket => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("end", () => socket.destroy());
  });
  server.on("upgrade", (request, socket, head) => {
    if (phase === "handshake") { socket.resume(); stalled(); return; }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit("connection", ws, request));
  });
  sockets.on("connection", socket => socket.on("message", data => {
    const request = JSON.parse(String(data));
    if (phase === "status" && request.method === "attach") {
      socket.send(JSON.stringify({ type: "reply", id: request.id, error: "PiX host is shutting down" }));
    } else stalled();
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await profile(async file => {
      const current = address((server.address() as { port: number }).port);
      writeFileSync(file, JSON.stringify(current));
      const abort = new AbortController();
      let settled = false;
      const connecting = connectLocalHost(null, undefined, true, undefined, false, undefined, undefined, abort.signal)
        .finally(() => { settled = true; });
      void connecting.catch(() => {});
      try {
        await ready;
        abort.abort(new Error("Window closed"));
        await Promise.race([connecting.catch(() => {}), new Promise(resolve => setTimeout(resolve, 500))]);
        assert.equal(settled, true, "cancellation must not wait for the handshake or RPC timeout");
        await assert.rejects(connecting, /Window closed/);
        await until(() => connections.size === 0);
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), current);
        assert.equal(existsSync(join(file, "..", "starting")), false);
      } finally {
        for (const socket of connections) socket.destroy();
        await connecting.catch(() => {});
      }
    });
  } finally {
    for (const socket of connections) socket.destroy();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a completed connection is unaffected by cancelling its former startup signal", async () => {
  await profile(async () => {
    const host = await serveLocalHost();
    const abort = new AbortController();
    const client = await connectLocalHost(null, undefined, true, undefined, false, undefined, undefined, abort.signal);
    try {
      abort.abort(new Error("Startup caller finished"));
      assert.equal((await client.request<{ pid: number }>({ method: "status" })).pid, host.address.pid);
    } finally { await client.close(); await host.shutdown(); }
  });
});

test("late subscriptions receive shutdown once without replaying ordinary events", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const shutdown = { type: "event", sequence: 2, event: { type: "host.shutdown", payload: {} } };
  server.on("connection", socket => socket.on("message", data => {
    const request = JSON.parse(String(data));
    if (request.method === "attach") {
      socket.send(JSON.stringify({ type: "event", sequence: 1, event: { type: "notice", payload: { message: "earlier" } } }));
      socket.send(JSON.stringify(shutdown));
    }
    socket.send(JSON.stringify({ type: "reply", id: request.id, result: {} }));
  }));
  await once(server, "listening");
  const client = await HostClient.connect(address((server.address() as { port: number }).port), null);
  try {
    await client.request({ method: "status" });
    let unsubscribedEvents = 0;
    const cancelled = client.onEvent(() => { unsubscribedEvents++; });
    cancelled();
    const events: string[] = [];
    const unsubscribe = client.onEvent(event => { events.push(event.type); });
    assert.deepEqual(events, [], "replay must let subscribers finish initializing");
    await Promise.resolve();
    assert.equal(client.shutdownRequested, true);
    assert.equal(unsubscribedEvents, 0);
    assert.deepEqual(events, ["host.shutdown"]);
    await assert.rejects(client.invoke("app.bootstrap"), /shutting down/);
    for (const socket of server.clients) socket.send(JSON.stringify(shutdown));
    await client.request({ method: "status" });
    assert.deepEqual(events, ["host.shutdown"], "a repeated quit request must not trigger another quit flow");
    unsubscribe();
  } finally {
    await client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a shutdown bundled with the WebSocket handshake is retained before open resolves", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    socket.cork();
    sockets.handleUpgrade(request, socket, head, ws => {
      ws.send(JSON.stringify({ type: "event", sequence: 1, event: { type: "host.shutdown", payload: {} } }));
      ws.on("message", data => {
        const request = JSON.parse(String(data));
        ws.send(JSON.stringify({ type: "reply", id: request.id, result: {} }));
      });
    });
    socket.uncork();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = await HostClient.open(address((server.address() as { port: number }).port));
  try {
    await client.request({ method: "status" });
    assert.equal(client.shutdownRequested, true);
  } finally {
    await client.close();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("an installer closes idle clients atomically without requesting task interruption", async () => {
  await profile(async file => {
    const host = await serveLocalHost();
    const first = await HostClient.connect(host.address, null);
    const second = await HostClient.connect(host.address, null);
    host.owner.shell.create(80, 24);
    await until(async () => (await host.owner.shell.terminalWork()).unknown === 0);
    const events: string[] = [];
    first.onEvent(event => { events.push(event.type); });
    try {
      const state = await localHostStatus();
      await stopLocalHost(state.host!.id, false, true, true);
      assert.ok(events.includes("host.shutdown"));
      assert.equal(existsSync(file), false);
    } finally { await first.close(); await second.close(); await host.shutdown(); }
  });
});

test("installation preserves commands in interactive terminals until the user explicitly confirms interruption", async () => {
  await profile(async file => {
    const host = await serveLocalHost();
    const { id } = host.owner.shell.create(80, 24);
    try {
      await until(async () => (await host.owner.shell.terminalWork()).unknown === 0);
      host.owner.shell.writeTerminal(id, process.platform === "win32" ? "ping.exe -n 60 127.0.0.1\r" : "sleep 60\r");
      const inspected = await localHostStatus();
      await until(async () => (await host.owner.shell.terminalWork()).commands === 1);
      const state = await localHostStatus();
      assert.equal(state.host?.commands, 1);
      await assert.rejects(stopLocalHost(inspected.host!.id, false, true, true), /shell commands/);
      assert.equal(existsSync(file), true);
      assert.equal(host.owner.shell.terminals.has(id), true);
      host.owner.shell.writeTerminal(id, "\x03");
      await until(async () => (await host.owner.shell.terminalWork()).commands === 0 && (await host.owner.shell.terminalWork()).unknown === 0);
      await stopLocalHost(state.host!.id, false, true, true);
      assert.equal(existsSync(file), false, "an idle terminal must still install without force");
    } finally { await host.shutdown(); }
  });
});

test("installer shutdown still rejects new tasks and shell commands despite idle-client permission", async t => {
  await profile(async file => {
    const host = await serveLocalHost();
    const client = await HostClient.connect(host.address, null);
    try {
      const state = await localHostStatus();
      const pending = t.mock.getter(host.owner, "hasPendingWork", () => true);
      await assert.rejects(stopLocalHost(state.host!.id, false, true, true), /running tasks/);
      pending.mock.restore();
      host.owner.shell.running.set("new command", { kill() {} });
      await assert.rejects(stopLocalHost(state.host!.id, false, true, true), /shell commands/);
      assert.equal(existsSync(file), true);
    } finally { await client.close(); await host.shutdown(); }
  });
});

test("installation preserves shell requests awaiting a desktop's approval", async () => {
  await profile(async file => {
    const host = await serveLocalHost();
    let approve: ((value: boolean) => void) | undefined;
    const client = await HostClient.connect(host.address, join(file, "../../.."), {
      ...headlessPlatform, confirm: () => new Promise<boolean>(resolve => { approve = resolve; }),
    });
    const command = client.invoke("shell.run", { command: "printf approved" });
    void command.catch(() => {});
    try {
      await until(() => Boolean(approve));
      const state = await localHostStatus();
      assert.equal(state.host?.pending, true);
      assert.equal(state.host?.commands, 0, "approval precedes process creation");
      await assert.rejects(stopLocalHost(state.host!.id, false, true, true), /running tasks/);
      assert.equal(existsSync(file), true);
      approve!(false);
      assert.equal((await command as { cancelled: boolean }).cancelled, true);
      await until(() => !host.owner.hasPendingWork);
      await stopLocalHost(state.host!.id, false, true, true);
      assert.equal(existsSync(file), false, "cancelled approval must not leave installation blocked");
    } finally {
      approve?.(false);
      await client.close();
      await command.catch(() => {});
      await host.shutdown();
    }
  });
});

test("an unavailable terminal process identity blocks automatic installation", async () => {
  await profile(async file => {
    const host = await serveLocalHost();
    host.owner.shell.terminals.set("untracked terminal", { kill() {} } as any);
    try {
      const state = await localHostStatus();
      assert.equal(state.host?.commands, 0);
      assert.equal(state.host?.terminalUnknown, 1);
      await assert.rejects(stopLocalHost(state.host!.id, false, true, true), /cannot check terminal child processes/);
      assert.equal(existsSync(file), true);
    } finally { await host.shutdown(); }
  });
});

test("installation preserves a terminal attached while another terminal check is pending", async t => {
  await profile(async file => {
    const host = await serveLocalHost();
    const management = await HostClient.open(host.address);
    let scanned!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { scanned = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(host.owner.shell, "terminalWork", async () => {
      scanned(); await gate;
      return { commands: 0, unknown: 0 };
    });
    let desktop: HostClient | undefined;
    const shutdown = management.request({ method: "shutdown", install: true, quitClients: true });
    void shutdown.catch(() => {});
    try {
      await started;
      desktop = await HostClient.connect(host.address, join(file, "../../.."));
      await desktop.invoke("terminal.create", { cols: 80, rows: 24 });
      release();
      await assert.rejects(shutdown, /cannot check terminal child processes/);
      assert.equal(existsSync(file), true, "a terminal outside the inspected snapshot must survive");
    } finally {
      release();
      await shutdown.catch(() => {});
      await desktop?.close(); await management.close(); await host.shutdown();
    }
  });
});

test("installation checks live remote commands and uncertainty before closing idle connections", async t => {
  t.mock.getter(RemoteWorkspacePool.prototype, "hasConnectedClients", () => true);
  await profile(async file => {
    const host = await serveLocalHost();
    const client = await HostClient.connect(host.address, null);
    let remote = { running: 0, commands: 1, unknown: 0 };
    t.mock.method(RemoteWorkspacePool.prototype, "activity", async () => remote);
    try {
      const state = await localHostStatus();
      assert.equal(state.host?.commands, 1);
      await assert.rejects(stopLocalHost(state.host!.id, false, true, true), /shell commands/);
      remote = { running: 1, commands: 0, unknown: 0 };
      assert.equal((await localHostStatus()).host?.remoteRunning, 1);
      await assert.rejects(stopLocalHost(state.host!.id, false, true, true), /running tasks/);
      remote = { running: 0, commands: 0, unknown: 1 };
      assert.equal((await localHostStatus()).host?.remoteUnknown, 1);
      await assert.rejects(stopLocalHost(state.host!.id, false, true, true), /cannot verify work in a remote workspace/);
      assert.equal(existsSync(file), true);
      remote = { running: 0, commands: 0, unknown: 0 };
      await stopLocalHost(state.host!.id, false, true, true);
      assert.equal(existsSync(file), false);
    } finally { await client.close(); await host.shutdown(); }
  });
});

for (const running of [false, true])
test(`installation rechecks remote connections changed while local terminals are inspected (running=${running})`, async t => {
  await profile(async file => {
    const host = await serveLocalHost();
    const desktop = await HostClient.connect(host.address, join(file, "../../.."));
    const management = await HostClient.open(host.address);
    let pool: RemoteWorkspacePool | undefined;
    t.mock.method(RemoteWorkspacePool.prototype, "activity", async function(this: RemoteWorkspacePool) {
      if (this !== host.owner.pool) pool = this;
      return { running: Number(running), commands: 0, unknown: 0 };
    });
    let inspected!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { inspected = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(host.owner.shell, "terminalWork", async () => {
      inspected(); await gate;
      return { commands: 0, unknown: 0 };
    });
    const shutdown = management.request({ method: "shutdown", install: true, quitClients: true });
    void shutdown.catch(() => {});
    try {
      await started;
      pool!.installSlot({ connected: true,
        onEvent: () => () => {}, onDisconnect: () => () => {},
        activity: async () => ({ running: 0, pending: false, commands: 1, terminals: 0, terminalUnknown: 0 }),
        abandon: async () => {}, dispose: async () => false,
      } as never, { name: "late", path: "/late", remote: { kind: "ssh", host: "late" } }, host.owner.settings.bundle());
      release();
      await assert.rejects(shutdown, running ? /running tasks/ : /cannot verify work in a remote workspace/);
      assert.equal(existsSync(file), true, "late remote work must not lose its local broker");
    } finally {
      release(); await shutdown.catch(() => {});
      await desktop.close(); await management.close(); await host.shutdown();
    }
  });
});

test("installation preserves terminal input received after its scan while remote checks are pending", async t => {
  await profile(async file => {
    const host = await serveLocalHost();
    const desktop = await HostClient.connect(host.address, join(file, "../../.."));
    const management = await HostClient.open(host.address);
    host.owner.shell.terminals.set("fixture", { pid: process.pid, write() {}, kill() {} } as any);
    let terminalScanned!: () => void, remoteScanned!: () => void, release!: () => void;
    const terminalReady = new Promise<void>(resolve => { terminalScanned = resolve; });
    const remoteReady = new Promise<void>(resolve => { remoteScanned = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(host.owner.shell, "terminalWork", async () => {
      terminalScanned(); return { commands: 0, unknown: 0 };
    });
    t.mock.method(RemoteWorkspacePool.prototype, "activity", async () => {
      remoteScanned(); await gate; return { running: 0, commands: 0, unknown: 0 };
    });
    const shutdown = management.request({ method: "shutdown", install: true, quitClients: true });
    void shutdown.catch(() => {});
    try {
      await Promise.all([terminalReady, remoteReady]);
      await new Promise(resolve => setImmediate(resolve));
      host.owner.shell.writeTerminal("fixture", "sleep 60\r");
      release();
      await assert.rejects(shutdown, /cannot check terminal child processes/);
      assert.equal(existsSync(file), true);
    } finally {
      release(); await shutdown.catch(() => {});
      await desktop.close(); await management.close(); await host.shutdown();
    }
  });
});

test("installation ignores a remote connection removed after its scan while local checks are pending", async t => {
  await profile(async file => {
    const host = await serveLocalHost();
    const desktop = await HostClient.connect(host.address, join(file, "../../.."));
    const management = await HostClient.open(host.address);
    let pool: RemoteWorkspacePool | undefined;
    t.mock.method(RemoteWorkspacePool.prototype, "activity", async function(this: RemoteWorkspacePool) {
      if (this !== host.owner.pool) pool = this;
      return { running: 1, commands: 0, unknown: 0 };
    });
    await localHostStatus();
    const slot = pool!.installSlot({ connected: true,
      onEvent: () => () => {}, onDisconnect: () => () => {}, dispose: async () => false,
    } as never, { name: "removed", path: "/removed", remote: { kind: "ssh", host: "removed" } }, host.owner.settings.bundle());
    let inspected!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { inspected = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(host.owner.shell, "terminalWork", async () => {
      inspected(); await gate; return { commands: 0, unknown: 0 };
    });
    const shutdown = management.request<{ stopped: boolean }>({ method: "shutdown", install: true, quitClients: true });
    void shutdown.catch(() => {});
    try {
      await started;
      await pool!.dropSlot(slot, true);
      release();
      assert.equal((await shutdown).stopped, true, "a removed connection must not block installation with its old task count");
      await until(() => !existsSync(file));
    } finally {
      release(); await shutdown.catch(() => {});
      await desktop.close(); await management.close(); await host.shutdown();
    }
  });
});

test("remote workspace browsing counts as a connection before the project is committed", async t => {
  await profile(async file => {
    const host = await serveLocalHost();
    const desktop = await HostClient.connect(host.address, join(file, "../../.."));
    const management = await HostClient.open(host.address);
    const remote = { hello: { cwd: "/browsing" }, connected: true,
      activity: async () => ({ running: 1, pending: false, commands: 0, terminals: 0, terminalUnknown: 0 }),
      dispose: async () => { remote.connected = false; return false; },
    };
    t.mock.method(WslHostClient, "connectSsh", async () => remote as never);
    try {
      await desktop.invoke("ssh.connect", { host: "fixture", cwd: "/browsing", browse: true });
      const state = await localHostStatus();
      assert.equal(state.host?.remoteRunning, 1);
      assert.equal(state.host?.remoteConnections, 1, "a live browsing connection still needs quit protection");
      await assert.rejects(management.request({ method: "shutdown" }), /disconnect remote workspaces/);
      assert.equal(remote.connected, true);
      assert.equal(existsSync(file), true);
    } finally { await desktop.close(); await management.close(); await host.shutdown(); }
  });
});

test("cancelling a spawned host keeps the startup lock until its address is published", { timeout: 15000 }, async () => {
  await profile(async file => {
    const home = join(file, "../../..");
    const entry = join(home, "delayed-host.mjs"), ready = join(home, "child-started"), gate = join(home, "publish-host");
    writeFileSync(entry, `
      import { existsSync, writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      while (!existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 10));
      const { serveLocalHost } = await import(${JSON.stringify(new URL("../src/host/local-host.js", import.meta.url).href)});
      await serveLocalHost();
    `);
    const previous = process.env.PIX_HOST_ENTRY;
    process.env.PIX_HOST_ENTRY = entry;
    const abort = new AbortController();
    const connecting = connectLocalHost(null, undefined, true, undefined, false, undefined, undefined, abort.signal);
    void connecting.catch(() => {});
    let manager: HostClient | undefined;
    try {
      await until(() => existsSync(ready));
      abort.abort(new Error("cancelled startup"));
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(existsSync(join(file, "../starting")), true, "an initializing child still owns the startup interval");
      writeFileSync(gate, "publish");
      await assert.rejects(connecting, /cancelled startup/);
      assert.equal(existsSync(join(file, "../starting")), false);
      manager = await HostClient.open(JSON.parse(readFileSync(file, "utf8")));
      await manager.request({ method: "shutdown" });
      await until(() => !existsSync(file));
    } finally {
      writeFileSync(gate, "publish");
      await connecting.catch(() => {});
      await manager?.close();
      if (previous === undefined) delete process.env.PIX_HOST_ENTRY; else process.env.PIX_HOST_ENTRY = previous;
      if (existsSync(ready)) { try { process.kill(Number(readFileSync(ready, "utf8")), "SIGTERM"); } catch {} }
    }
  });
});

for (const work of [{ terminals: 1 }, { remoteConnections: 1 }])
test(`installation preserves older hosts without command tracking: ${JSON.stringify(work)}`, async () => {
  await profile(async file => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const legacy = address((server.address() as { port: number }).port);
    let stopped = false;
    server.on("connection", socket => socket.on("message", data => {
      const request = JSON.parse(String(data));
      if (request.method === "shutdown") stopped = true;
      socket.send(JSON.stringify({ type: "reply", id: request.id, result: { protocol: LOCAL_HOST_PROTOCOL,
        version: PIX_HOST_VERSION, pid: process.pid, clients: 1, running: [], ...work, installGuard: true } }));
    }));
    writeFileSync(file, JSON.stringify(legacy));
    try {
      const state = await localHostStatus();
      await assert.rejects(stopLocalHost(state.host!.id, false, true, true), /older PiX host cannot verify commands/);
      assert.equal(stopped, false);
    } finally { rmSync(file); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

test("native installer reservations outlive the helper and only their own receipt releases them", async () => {
  await profile(async file => {
    const host = await serveLocalHost();
    const state = await localHostStatus();
    const reservation = await reserveLocalHostForInstall(state.host!.id, false, process.ppid);
    const lock = join(file, "..", "starting");
    try {
      assert.equal(existsSync(file), false);
      assert.equal(readFileSync(join(lock, "pid"), "utf8"), String(process.ppid));
      assert.equal(localHostInstallInProgress(), true);
      releaseInstallReservation({ ...reservation, token: "wrong-installer" });
      assert.equal(existsSync(lock), true, "a competing install must never release this reservation");
      releaseInstallReservation(reservation);
      assert.equal(existsSync(lock), false);
      assert.equal(localHostInstallInProgress(), false);
    } finally { releaseInstallReservation(reservation); await host.shutdown(); }
  });
});

test("an overlapping status probe does not look like a live desktop or block safe shutdown", async () => {
  await profile(async file => {
    const host = await serveLocalHost();
    const probe = await HostClient.open(host.address);
    try {
      const state = await localHostStatus();
      assert.equal(state.host?.clients, 0, "inspection transports are not user clients");
      await stopLocalHost(state.host!.id);
      await until(() => !existsSync(file));
    } finally { await probe.close(); await host.shutdown(); }
  });
});

test("a host still cleaning up remains verifiable and accepts another shutdown request", async t => {
  await profile(async file => {
    const host = await serveLocalHost();
    let cleaning = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const closeAll = host.owner.closeAll.bind(host.owner);
    t.mock.method(host.owner, "closeAll", async () => { cleaning = true; await gate; await closeAll(); });
    const client = await HostClient.open(host.address);
    try {
      await client.request({ method: "shutdown" });
      await until(() => cleaning);
      const state = await localHostStatus();
      assert.equal(state.host?.verified, true, "slow cleanup must not disable the user's force-restart controls");
      assert.equal(state.host?.stopping, true);
      await assert.rejects(HostClient.connect(host.address, null), /shutting down/);
      assert.deepEqual(await client.request({ method: "shutdown", force: true }), { stopped: true });
    } finally {
      release();
      await client.close();
      await until(() => !existsSync(file));
    }
  });
});

test("reconnection waits for an idle host's cleanup without exposing a recovery failure", async t => {
  await profile(async file => {
    const host = await serveLocalHost();
    const manager = await HostClient.open(host.address);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const closeAll = host.owner.closeAll.bind(host.owner);
    t.mock.method(host.owner, "closeAll", async () => { await gate; await closeAll(); });
    let replacement: HostClient | undefined;
    let settled = false;
    await manager.request({ method: "shutdown" });
    const connecting = connectLocalHost(null).finally(() => { settled = true; });
    void connecting.catch(() => {});
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(settled, false, "normal cleanup must wait rather than fail the window's bootstrap");
      assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, host.address.pid);
      release();
      replacement = await connecting;
      assert.notEqual(replacement.address.pid, host.address.pid);
      await replacement.request({ method: "shutdown" });
      await until(() => !existsSync(file));
    } finally {
      release();
      await connecting.catch(() => {});
      await manager.close();
      await replacement?.close();
      await host.shutdown();
    }
  });
});

test("waiting for a stopping host can be cancelled without starting a replacement", async t => {
  await profile(async file => {
    const host = await serveLocalHost();
    const manager = await HostClient.open(host.address);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const closeAll = host.owner.closeAll.bind(host.owner);
    t.mock.method(host.owner, "closeAll", async () => { await gate; await closeAll(); });
    const abort = new AbortController();
    await manager.request({ method: "shutdown" });
    const connecting = connectLocalHost(null, undefined, true, undefined, false, undefined, undefined, abort.signal);
    void connecting.catch(() => {});
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      abort.abort(new Error("Window closed"));
      await assert.rejects(connecting, /Window closed/);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, host.address.pid);
      assert.equal(existsSync(join(file, "..", "starting")), false);
    } finally {
      release();
      await manager.close();
      await until(() => !existsSync(file));
    }
  });
});

test("installation waits for idle cleanup and replaces the app without task prompts", async t => {
  await profile(async file => {
    const host = await serveLocalHost();
    const manager = await HostClient.open(host.address);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const closeAll = host.owner.closeAll.bind(host.owner);
    t.mock.method(host.owner, "closeAll", async () => { await gate; await closeAll(); });
    await manager.request({ method: "shutdown" });
    let moved = false;
    const installing = offerMacInstall({
      zh: true,
      show: async () => { assert.fail("idle installation must not show task or recovery prompts"); },
      windows: async () => ({ quit: async () => {}, reopen: async () => { assert.fail("normal installation must continue"); } }),
      move: () => { assert.equal(existsSync(file), false); moved = true; return true; },
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(moved, false, "the executable must stay intact until cleanup completes");
      release();
      assert.equal(await installing, "quit");
      assert.equal(moved, true);
    } finally {
      release();
      await installing.catch(() => {});
      await manager.close();
      await host.shutdown();
    }
  });
});

test("installation excludes competing host starters until app replacement completes", { timeout: 20000 }, async () => {
  await profile(async file => {
    const host = await serveLocalHost();
    const state = await localHostStatus();
    let replacing = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const installing = withStoppedLocalHost(state.host!.id, false, async () => {
      replacing = true;
      assert.equal(existsSync(file), false);
      await gate;
      return "installed";
    });
    let client: HostClient | undefined;
    try {
      await until(() => replacing);
      const connecting = connectLocalHost(null);
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(existsSync(file), false, "a GUI cannot respawn its host during file replacement");
      release();
      assert.equal(await installing, "installed");
      client = await connecting;
      await client.request({ method: "shutdown" });
      await until(() => !existsSync(file));
    } finally { release(); await client?.close(); await host.shutdown(); }
  });
});

test("shutdown guards are atomic when another client attaches after inspection", async () => {
  await profile(async file => {
    const host = await serveLocalHost();
    const management = await HostClient.open(host.address);
    const desktop = await HostClient.connect(host.address, null);
    try {
      await assert.rejects(management.request({ method: "shutdown" }), /other PiX windows/);
      assert.equal(existsSync(file), true);
    } finally { await desktop.close(); await management.close(); await host.shutdown(); }
  });
});

test("status and safe shutdown account for shell commands and terminal sessions", async () => {
  await profile(async file => {
    const host = await serveLocalHost();
    host.owner.shell.running.set("command", { kill() {} });
    host.owner.shell.terminals.set("terminal", { kill() {} } as any);
    const client = await HostClient.open(host.address);
    try {
      const state = await localHostStatus();
      assert.equal(state.host?.commands, 1);
      assert.equal(state.host?.terminals, 1);
      await assert.rejects(client.request({ method: "shutdown" }), /shell commands/);
      assert.equal(existsSync(file), true);
    } finally { await client.close(); await host.shutdown(); }
  });
});

test("a status probe finishes closing before another management operation can inspect clients", { timeout: 10000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let closing = false;
  let release = () => {};
  server.on("connection", socket => {
    const close = socket.close.bind(socket);
    socket.close = (() => { closing = true; release = () => close(); }) as typeof socket.close;
    socket.on("message", data => {
      const request = JSON.parse(String(data));
      socket.send(JSON.stringify({ type: "reply", id: request.id, result: {
        protocol: LOCAL_HOST_PROTOCOL, version: PIX_HOST_VERSION, pid: process.pid,
        clients: server.clients.size, running: [],
      } }));
    });
  });
  await once(server, "listening");
  try {
    await profile(async file => {
      writeFileSync(file, JSON.stringify(address((server.address() as { port: number }).port)));
      let finished = false;
      const inspecting = localHostStatus().then(state => { finished = true; return state; });
      await until(() => closing);
      assert.equal(finished, false, "a probe must not be counted as another live client by the next operation");
      release();
      assert.equal((await inspecting).host?.verified, true);
    });
  } finally { release(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("explicit restart holds the startup lock through shutdown and replacement startup", { timeout: 20000 }, async t => {
  await profile(async file => {
    const host = await serveLocalHost();
    const state = await localHostStatus();
    let stopping = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const closeAll = host.owner.closeAll.bind(host.owner);
    t.mock.method(host.owner, "closeAll", async () => { stopping = true; await gate; await closeAll(); });
    const restarting = restartLocalHost(state.host!.id, true);
    let replacement: HostClient | undefined;
    try {
      await until(() => stopping);
      assert.equal(existsSync(join(file, "..", "starting", "pid")), true,
        "older clients must not be able to launch a competing host during shutdown");
      release();
      replacement = await restarting;
      assert.notEqual(replacement.address.pid, process.pid);
      assert.equal(existsSync(join(file, "..", "starting")), false);
      await replacement.request({ method: "shutdown" });
      await until(() => !existsSync(file));
    } finally { release(); replacement?.close(); await host.shutdown(); }
  });
});

for (const fails of [false, true])
test(`installation preserves an in-flight Git branch switch until it settles (failure=${fails})`, { timeout: 10000 }, async t => {
  await profile(async file => {
    const host = await serveLocalHost();
    const cwd = realpathSync(process.env.PIX_HOME!);
    const client = await HostClient.connect(host.address, cwd);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const switching = new Promise<void>(resolve => { started = resolve; });
    t.mock.method(GitService.prototype, "switchBranch", async () => {
      started(); await gate;
      if (fails) throw new Error("checkout failed");
      return { available: false } as never;
    });
    const command = client.invoke("git.switch", { branch: "fixture", cwd });
    void command.catch(() => {});
    try {
      await Promise.race([switching, command]);
      assert.equal((await localHostStatus()).host?.pending, true, "installation must not treat an active checkout as idle");
      const manager = await HostClient.open(host.address);
      try { await assert.rejects(manager.request({ method: "shutdown", install: true }), /Stop running tasks/); }
      finally { await manager.close(); }
      assert.equal(existsSync(file), true);
      release();
      if (fails) await assert.rejects(command, /checkout failed/);
      else await command;
      assert.equal((await localHostStatus()).host?.pending, false, "completed and failed checkouts both release pending work");
    } finally {
      release(); await command.catch(() => {}); await client.close(); await host.shutdown();
    }
  });
});

test("management reports pending work and only explicit force can stop a busy host", { timeout: 15000 }, async t => {
  await profile(async file => {
    const host = await serveLocalHost();
    t.mock.getter(host.owner, "hasPendingWork", () => true);
    t.mock.method(host.owner.registry, "runningPaths", () => new Set(["private-session-path"]));
    try {
      const state = await localHostStatus();
      assert.equal(state.host?.verified, true);
      assert.equal(state.host?.running, 1);
      assert.equal(state.host?.pending, true);
      assert.ok(!JSON.stringify(state).includes("private-session-path"));
      assert.ok(!JSON.stringify(state).includes(host.address.token));
      await assert.rejects(stopLocalHost(state.host!.id), /Stop running tasks/);
      assert.equal(existsSync(file), true);
      await stopLocalHost(state.host!.id, true);
      assert.equal(existsSync(file), false);
    } finally { await host.shutdown(); }
  });
});

test("a confirmation for a previous host cannot stop its replacement", { timeout: 10000 }, async () => {
  await profile(async file => {
    const host = await serveLocalHost();
    try {
      const state = await localHostStatus();
      writeFileSync(file, JSON.stringify({ ...host.address, token: "replacement-host-token" }));
      await assert.rejects(stopLocalHost(state.host!.id, true), /host changed/);
      const client = await HostClient.open(host.address);
      try { assert.equal((await client.request<{ pid: number }>({ method: "status" })).pid, process.pid); }
      finally { client.close(); }
    } finally { writeFileSync(file, JSON.stringify(host.address)); await host.shutdown(); }
  });
});

test("concurrent clients upgrade an idle older host only after its shutdown completes", { timeout: 20000 }, async t => {
  await profile(async file => {
    const host = await serveLocalHost();
    const old = { ...host.address, version: "0.0.31" };
    writeFileSync(file, JSON.stringify(old));
    let stopping = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const closeAll = host.owner.closeAll.bind(host.owner);
    t.mock.method(host.owner, "closeAll", async () => { stopping = true; await gate; await closeAll(); });
    const connecting = Promise.all([connectLocalHost(null), connectLocalHost(null),
      connectLocalHost(null, { ...headlessPlatform }, true, "desktop", true, "legacy")]);
    let clients: HostClient[] = [];
    try {
      await until(() => stopping);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), old, "do not publish a replacement before session cleanup finishes");
      await assert.rejects(HostClient.connect(host.address, null), /shutting down/);
      release();
      clients = await connecting;
      const pids = await Promise.all(clients.map(async client => (await client.request<{ pid: number }>({ method: "status" })).pid));
      assert.notEqual(pids[0], process.pid);
      assert.ok(pids.every(pid => pid === pids[0]), "only one replacement host may start");
      assert.equal(clients[0]!.address.version, PIX_HOST_VERSION);
      await Promise.all(clients.slice(1).map(client => client.close()));
      await clients[0]!.request({ method: "shutdown" });
      await until(() => !existsSync(file));
    } finally {
      release();
      for (const client of clients) client.close();
      await host.shutdown();
    }
  });
});

test("an older host with pending tasks, active runs or remote connections is preserved", { timeout: 20000 }, async t => {
  await profile(async file => {
    const host = await serveLocalHost();
    const client = await HostClient.connect(host.address, null, { ...headlessPlatform }, "old-desktop");
    const closed = once(Reflect.get(client, "socket"), "close");
    client.close();
    await closed;
    let busy = "";
    t.mock.getter(host.owner, "hasPendingWork", () => busy === "pending");
    t.mock.method(host.owner.registry, "runningPaths", () => new Set(busy === "running" ? ["session"] : []));
    t.mock.getter(RemoteWorkspacePool.prototype, "hasConnections", () => busy === "remote");
    const old = { ...host.address, version: "0.0.31" };
    writeFileSync(file, JSON.stringify(old));
    try {
      for (busy of ["pending", "running", "remote"]) {
        await assert.rejects(connectLocalHost(null), /Stop running tasks and disconnect remote workspaces/);
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), old);
        assert.equal(existsSync(join(file, "..", "starting")), false);
      }
    } finally { busy = ""; client.close(); await host.shutdown(); }
  });
});

test("an older host with another connected client is not replaced", { timeout: 10000 }, async () => {
  await profile(async file => {
    const host = await serveLocalHost();
    const client = await HostClient.connect(host.address, null);
    const old = { ...host.address, version: "0.0.31" };
    writeFileSync(file, JSON.stringify(old));
    try {
      await assert.rejects(connectLocalHost(null), /Close other PiX windows and terminal clients/);
      assert.equal((await client.request<{ pid: number }>({ method: "status" })).pid, process.pid);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), old);
    } finally { client.close(); await host.shutdown(); }
  });
});

test("host inspection, newer versions and incompatible protocols never trigger shutdown", { timeout: 10000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let requests = 0;
  server.on("connection", socket => socket.on("message", () => { requests++; }));
  await once(server, "listening");
  try {
    await profile(async file => {
      const base = address((server.address() as { port: number }).port);
      for (const [old, start] of [
        [{ ...base, version: "0.0.31" }, false],
        [{ ...base, version: "999.0.0" }, true],
        [{ ...base, version: "0.0.31", protocol: LOCAL_HOST_PROTOCOL + 1 }, true],
      ] as const) {
        writeFileSync(file, JSON.stringify(old));
        await assert.rejects(connectLocalHost(null, undefined, start), /different version/);
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), old);
      }
      assert.equal(requests, 0);
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("concurrent clients replace a refused address even when its PID and old version survive", { timeout: 20000 }, async () => {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  await profile(async file => {
    writeFileSync(file, JSON.stringify({ ...address(port), version: "old-version" }));
    const clients = await Promise.all([connectLocalHost(null), connectLocalHost(null),
      connectLocalHost(null, { ...headlessPlatform }, true, "dev-desktop", true, "legacy-desktop")]);
    try {
      const states = await Promise.all(clients.map(client => client.request<{ pid: number }>({ method: "status" })));
      assert.equal(states[0]!.pid, states[1]!.pid);
      assert.equal(states[0]!.pid, states[2]!.pid, "migration checks must not prevent replacing a stale address");
      assert.notEqual(states[0]!.pid, process.pid);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, states[0]!.pid);
      // An application error from a reachable host must not trigger replacement.
      await assert.rejects(connectLocalHost(join(file, "missing-project")), /ENOENT|ENOTDIR/);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, states[0]!.pid);
      await Promise.all(clients.slice(1).map(client => client.close()));
      await clients[0]!.request({ method: "shutdown" });
      await until(() => !existsSync(file));
    } finally { for (const client of clients) client.close(); }
  });
});

test("a port reused by an HTTP service does not keep the old host address alive", { timeout: 20000 }, async () => {
  const server = createServer((_req, response) => { response.writeHead(200); response.end("Other service"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    await profile(async file => {
      const old = address((server.address() as { port: number }).port);
      writeFileSync(file, JSON.stringify(old));
      const client = await connectLocalHost(null);
      try {
        assert.notEqual(client.address.port, old.port);
        await client.request({ method: "shutdown" });
        await until(() => !existsSync(file));
      } finally { client.close(); }
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("a port that resets the handshake cannot keep a stale host address alive", { timeout: 20000 }, async () => {
  let connections = 0;
  const server = createTcpServer(socket => { connections++; socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    await profile(async file => {
      writeFileSync(file, JSON.stringify(address((server.address() as { port: number }).port)));
      const clients = await Promise.all([connectLocalHost(null), connectLocalHost(null)]);
      try {
        assert.ok(connections >= 2, "retry the handshake before replacing its address");
        assert.notEqual(clients[0]!.address.pid, process.pid);
        assert.equal(clients[0]!.address.pid, clients[1]!.address.pid, "concurrent recovery starts only one replacement host");
        await clients[1]!.close();
        await clients[0]!.request({ method: "shutdown" });
        await until(() => !existsSync(file));
      } finally { for (const client of clients) client.close(); }
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("a transient handshake reset reconnects without replacing a reachable host", { timeout: 10000 }, async () => {
  let connections = 0;
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (++connections === 1) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit("connection", ws, request));
  });
  sockets.on("connection", socket => socket.on("message", data => {
    const request = JSON.parse(String(data));
    socket.send(JSON.stringify({ type: "reply", id: request.id, result: { pid: process.pid } }));
  }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    await profile(async file => {
      const old = address((server.address() as { port: number }).port);
      writeFileSync(file, JSON.stringify(old));
      const client = await connectLocalHost(null);
      try {
        assert.equal((await client.request<{ pid: number }>({ method: "status" })).pid, process.pid);
        assert.equal(connections, 2);
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), old);
        assert.equal(existsSync(join(file, "..", "starting")), false);
      } finally { client.close(); }
    });
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("incompatible, unauthorized and failed attachments preserve the existing host", { timeout: 10000 }, async t => {
  for (const kind of ["version", "authentication", "attachment", "disconnect"] as const) await t.test(kind, async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0,
      verifyClient: (_info, done) => done(kind !== "authentication", 401) });
    server.on("connection", socket => socket.on("message", data => {
      if (kind === "disconnect") { socket.terminate(); return; }
      const request = JSON.parse(String(data));
      socket.send(JSON.stringify({ type: "reply", id: request.id, error: "Project attachment refused" }));
    }));
    await once(server, "listening");
    try {
      await profile(async file => {
        const old = { ...address((server.address() as { port: number }).port), ...(kind === "version" ? { version: "old-version" } : {}) };
        writeFileSync(file, JSON.stringify(old));
        const error = kind === "version" ? /different version/ : kind === "authentication" ? /401/
          : kind === "disconnect" ? /disconnected/ : /Project attachment refused/;
        await assert.rejects(connectLocalHost(null), error);
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), old);
      });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
