import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { installHttpProxy } from "../src/main/http-proxy.js";

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("background fetch uses live proxy settings, environment or desktop system networking", async t => {
  const sockets = new Set<Socket>();
  const tunnels: string[] = [];
  const origin = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ path: req.url, method: req.method, body }));
  });
  const proxy = createServer();
  proxy.on("connect", (req, client, head) => {
    tunnels.push(req.url!);
    if (req.url === "auth.openai.com:443") {
      // Prove HTTPS token requests reach the proxy without contacting OpenAI.
      client.end("HTTP/1.1 502 Test proxy\r\nConnection: close\r\n\r\n");
      return;
    }
    const target = new URL(`http://${req.url}`);
    const upstream = connect(Number(target.port), target.hostname, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  for (const server of [origin, proxy]) server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const originUrl = await listen(origin);
  const proxyUrl = await listen(proxy);
  let configured: string | undefined;
  const env: NodeJS.ProcessEnv = { NO_PROXY: "" };
  const systemCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  const close = installHttpProxy(() => configured, async input => {
    systemCalls.push(String(input));
    return new Response("system proxy");
  }, env);
  t.after(async () => {
    await close();
    globalThis.fetch = originalFetch;
    for (const socket of sockets) socket.destroy();
    await Promise.all([origin, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  await t.test("uses the desktop system stack when no proxy is specified", async () => {
    assert.equal(await (await fetch("https://auth.openai.com/oauth/token")).text(), "system proxy");
    assert.equal(systemCalls.length, 1);
  });
  await t.test("the HTTP proxy setting routes token POST bodies and overrides environment proxies", async () => {
    configured = proxyUrl;
    env.HTTPS_PROXY = "http://127.0.0.1:1";
    const response = await fetch(`${originUrl}/oauth/token`, {
      method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: "test-only" }),
    });
    assert.deepEqual(await response.json(), {
      path: "/oauth/token", method: "POST", body: "grant_type=authorization_code&code=test-only",
    });
    assert.equal(tunnels.length, 1);
    assert.equal(systemCalls.length, 1);
  });
  await t.test("HTTPS authentication requests tunnel through the configured proxy", async () => {
    await assert.rejects(fetch("https://auth.openai.com/oauth/token", {
      method: "POST", body: "test-only", signal: AbortSignal.timeout(3000),
    }));
    assert.ok(tunnels.includes("auth.openai.com:443"));
  });
  await t.test("NO_PROXY bypasses the explicit proxy", async () => {
    env.NO_PROXY = "127.0.0.1";
    const before = tunnels.length;
    assert.equal((await (await fetch(originUrl)).json()).method, "GET");
    assert.equal(tunnels.length, before);
  });
  await t.test("changes and clearing the setting take effect without restarting", async () => {
    env.NO_PROXY = "";
    configured = "http://127.0.0.1:1";
    await assert.rejects(fetch(originUrl));
    configured = undefined;
    delete env.HTTPS_PROXY;
    env.ALL_PROXY = proxyUrl;
    const before = tunnels.length;
    assert.equal((await (await fetch(originUrl)).json()).method, "GET");
    assert.equal(tunnels.length, before + 1);
    delete env.ALL_PROXY;
    assert.equal(await (await fetch(originUrl)).text(), "system proxy");
  });
  await t.test("preserves Request and FormData support", async () => {
    configured = proxyUrl;
    const form = new FormData();
    form.append("test", "value");
    const response = await fetch(new Request(originUrl, { method: "POST", body: form }));
    assert.match((await response.json()).body, /name="test"\r\n\r\nvalue/);
  });
  await t.test("unsupported explicit proxies fail instead of silently connecting directly", async () => {
    configured = "socks5://127.0.0.1:7890";
    await assert.rejects(fetch(originUrl), /http:\/\/ or https:\/\//);
  });
});

test("an independent host follows live desktop PAC decisions while preserving explicit proxy precedence", async t => {
  const sockets = new Set<Socket>();
  let tunnels = 0, resolutions = 0;
  const origin = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    response.end(body || "direct");
  });
  const proxy = createServer();
  proxy.on("connect", (request, client, head) => {
    tunnels++;
    const target = new URL(`http://${request.url}`);
    const upstream = connect(Number(target.port), target.hostname, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head); client.pipe(upstream).pipe(client);
    });
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  for (const server of [origin, proxy]) server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const url = await listen(origin), proxyUrl = await listen(proxy);
  let decision = `PROXY ${new URL(proxyUrl).host}`;
  let configured: string | undefined;
  const env: NodeJS.ProcessEnv = { NO_PROXY: "" };
  const originalFetch = globalThis.fetch;
  const close = installHttpProxy(() => configured, undefined, env, async target => {
    resolutions++; assert.equal(new URL(target).origin, url); return decision;
  });
  t.after(async () => {
    await close(); globalThis.fetch = originalFetch;
    for (const socket of sockets) socket.destroy();
    await Promise.all([origin, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });
  const form = new FormData(); form.append("message", "through PAC");
  assert.match(await (await fetch(new Request(url, { method: "POST", body: form }))).text(), /through PAC/);
  assert.equal(tunnels, 1);
  decision = "DIRECT";
  assert.equal(await (await fetch(url)).text(), "direct");
  assert.equal(tunnels, 1);
  configured = proxyUrl;
  assert.equal(await (await fetch(url)).text(), "direct");
  assert.equal(resolutions, 2, "explicit settings do not ask the desktop to resolve PAC");
  assert.equal(tunnels, 2);
  configured = undefined;
  env.HTTPS_PROXY = proxyUrl;
  await fetch(url);
  assert.equal(resolutions, 2, "environment proxies retain their precedence, too");
});

test("aborting a host request does not wait for a stalled system PAC lookup", { timeout: 2000 }, async t => {
  const originalFetch = globalThis.fetch;
  let finish!: (route: string) => void;
  const close = installHttpProxy(() => undefined, undefined, {}, () => new Promise(resolve => { finish = resolve; }));
  t.after(async () => { finish?.("DIRECT"); await close(); globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  const pending = fetch(new Request("http://127.0.0.1:1", { signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("a server without a desktop system stack can connect directly", async t => {
  const origin = createServer((_req, res) => res.end("direct"));
  const url = await listen(origin);
  const originalFetch = globalThis.fetch;
  const close = installHttpProxy(() => undefined, undefined, {});
  t.after(async () => {
    await close();
    globalThis.fetch = originalFetch;
    origin.closeAllConnections();
    await new Promise<void>(resolve => origin.close(() => resolve()));
  });
  assert.equal(await (await fetch(url)).text(), "direct");
  assert.equal(await (await fetch("data:text/plain,data-url")).text(), "data-url");
});
