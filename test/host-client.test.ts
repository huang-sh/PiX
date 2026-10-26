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
import { connectLocalHost } from "../src/host/client.js";
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
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  }
}
const address = (port: number): HostAddress => ({ protocol: LOCAL_HOST_PROTOCOL, version: PIX_HOST_VERSION,
  pid: process.pid, port, token: "stale-test-token" });

test("concurrent clients replace a refused address even when its PID and old version survive", { timeout: 20000 }, async () => {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  await profile(async file => {
    writeFileSync(file, JSON.stringify({ ...address(port), version: "old-version" }));
    const clients = await Promise.all([connectLocalHost(null), connectLocalHost(null)]);
    try {
      const states = await Promise.all(clients.map(client => client.request<{ pid: number }>({ method: "status" })));
      assert.equal(states[0]!.pid, states[1]!.pid);
      assert.notEqual(states[0]!.pid, process.pid);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, states[0]!.pid);
      // An application error from a reachable host must not trigger replacement.
      await assert.rejects(connectLocalHost(join(file, "missing-project")), /ENOENT|ENOTDIR/);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, states[0]!.pid);
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
