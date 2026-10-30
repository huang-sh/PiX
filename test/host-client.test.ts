import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { connectLocalHost, HostClient, localHostStatus, restartLocalHost, stopLocalHost, withStoppedLocalHost } from "../src/host/client.js";
import { headlessPlatform, serveLocalHost } from "../src/host/local-host.js";
import { RemoteWorkspacePool } from "../src/main/remote-pool.js";
import { LOCAL_HOST_PROTOCOL, type HostAddress } from "../src/shared/host-protocol.js";
import { PIX_HOST_VERSION } from "../src/shared/remote-protocol.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
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
