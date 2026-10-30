import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { ProviderBalanceService, type BalanceProvider } from "../src/main/provider-balances.js";
import { balanceQuery, type ProviderBalance } from "../src/shared/provider-balances.js";
import { SettingsService } from "../src/main/services.js";
import { MainController } from "../src/main/controller.js";
import { headlessPlatform } from "../src/host/local-host.js";
import { isProjectRoute } from "../src/shared/remote-protocol.js";
import { validateRouteInput } from "../src/shared/contracts.js";

const provider = (baseUrl = "https://api.deepseek.com/v1"): BalanceProvider => ({
  provider: "renamed", name: "My provider", baseUrl, auth: async () => ({ apiKey: "fixture-secret" }),
});
const deepseek = (total = "12.34") => ({ balance_infos: [{ currency: "CNY", total_balance: total }] });
const query = balanceQuery({ url: "https://relay.example/balance", path: "data.balance", currency: "USD" });

test("known balance adapters use actual endpoint hosts, currencies and numeric strings", async t => {
  const cases: Array<[string, string, unknown, ProviderBalance["amounts"]]> = [
    ["https://api.deepseek.com/v1", "/user/balance", { balance_infos: [
      { currency: "USD", total_balance: "0" }, { currency: "CNY", total_balance: "12.34" },
    ] }, [{ currency: "CNY", remaining: 12.34 }, { currency: "USD", remaining: 0 }]],
    ["https://api.moonshot.cn/v1", "/v1/users/me/balance", { data: { available_balance: "1.25" } }, [{ currency: "CNY", remaining: 1.25 }]],
    ["https://api.moonshot.ai/v1", "/v1/users/me/balance", { data: { available_balance: 2 } }, [{ currency: "USD", remaining: 2 }]],
    ["https://api.siliconflow.cn/v1", "/v1/user/info", { data: { totalBalance: "3.5" } }, [{ currency: "CNY", remaining: 3.5 }]],
    ["https://api.siliconflow.com/v1", "/v1/user/info", { data: { totalBalance: "-1" } }, [{ currency: "USD", remaining: -1 }]],
    ["https://openrouter.ai/api/v1", "/api/v1/credits", { data: { total_credits: 100.5, total_usage: 25.75 } }, [{ currency: "USD", remaining: 74.75 }]],
  ];
  let expected: typeof cases[number];
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(url.origin, new URL(expected[0]).origin);
    assert.equal(url.pathname, expected[1]);
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer fixture-secret");
    assert.equal(options.redirect, "error");
    return Response.json(expected[2]);
  });
  for (expected of cases) {
    const result = await new ProviderBalanceService().read(provider(expected[0]));
    assert.deepEqual(result.amounts, expected[3]);
    assert.equal(result.error, undefined);
    assert.ok(result.updatedAt);
    assert.ok(!JSON.stringify(result).includes("fixture-secret"));
  }
});

test("relays and unknown providers never send credentials to a guessed vendor endpoint", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  for (const base of ["https://api.deepseek.com.evil.example", "http://api.deepseek.com", "https://api.deepseek.com:8443", "https://relay.example/v1"]) {
    const p = { ...provider(base), provider: "deepseek", auth: async () => { throw new Error("unsupported query must not resolve credentials"); } };
    assert.equal((await new ProviderBalanceService().read(p)).error, "unsupported");
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("custom queries use bounded field traversal and unit conversion on the configured origin", async t => {
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(url.href, "https://relay.example/balance");
    const headers = new Headers(options.headers);
    assert.equal(headers.get("authorization"), "Token saved-auth");
    assert.equal(headers.get("x-tenant"), "tenant");
    assert.equal(headers.get("x-remove"), null);
    return Response.json({ data: { amounts: [{ remaining: "500000" }] } });
  });
  const p = { ...provider("https://relay.example/v1"), query: { ...query, path: "data.amounts.0.remaining", multiplier: 1 / 500000 },
    auth: async () => ({ apiKey: "fixture-secret", headers: { authorization: "Token saved-auth", "x-tenant": "tenant", "x-remove": null } }) };
  assert.deepEqual((await new ProviderBalanceService().read(p)).amounts, [{ currency: "USD", remaining: 1 }]);
  assert.equal((await new ProviderBalanceService().read({ ...p, query: { ...query, url: "https://other.example/balance" } })).error, "originMismatch");
});

test("custom queries compare their origin with the SDK's resolved request endpoint", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.href, query.url);
    return Response.json({ data: { balance: 6 } });
  });
  const p = { ...provider("https://openrouter.ai/api/v1"), query,
    auth: async () => ({ apiKey: "relay-key", baseUrl: "https://relay.example/v1" }) };
  const result = await new ProviderBalanceService().read(p);
  assert.deepEqual(result.amounts, [{ currency: "USD", remaining: 6 }]);
  assert.equal(result.error, undefined);
  const rejected = await new ProviderBalanceService().read({ ...p,
    auth: async () => ({ apiKey: "other-key", baseUrl: "https://other.example/v1" }) });
  assert.equal(rejected.error, "originMismatch");
  assert.equal(fetch.mock.callCount(), 1, "resolved credentials cannot reach a different origin");
});

test("cache refreshes coalesce, isolate changed credentials and keep last success on temporary errors", async t => {
  let respond: () => void = () => {};
  const gate = new Promise<void>(resolve => { respond = resolve; });
  const fetch = t.mock.method(globalThis, "fetch", async () => { await gate; return Response.json(deepseek()); });
  const service = new ProviderBalanceService();
  const a = service.read(provider(), true), b = service.read(provider(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetch.mock.callCount(), 1);
  respond();
  assert.deepEqual(await a, await b);
  const fresh = await service.read(provider());
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => new Response(null, { status: 429 }));
  const stale = await service.read(provider(), true);
  assert.equal(stale.stale, true);
  assert.equal(stale.updatedAt, fresh.updatedAt);
  assert.equal(stale.error, "rateLimited");
  assert.deepEqual(stale.amounts, fresh.amounts);
  const other = await service.read({ ...provider(), auth: async () => ({ apiKey: "other-key" }) });
  assert.deepEqual(other.amounts, []);
  assert.equal(other.stale, undefined);
});

test("reopening balances during a refresh joins the new reading instead of showing the previous cache", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(deepseek("12")));
  const service = new ProviderBalanceService();
  await service.read(provider());
  let respond!: () => void;
  const gate = new Promise<void>(resolve => { respond = resolve; });
  fetch.mock.mockImplementation(async () => { await gate; return Response.json(deepseek("9")); });
  const refresh = service.read(provider(), true);
  await new Promise(resolve => setImmediate(resolve));
  const reopened = service.read({ ...provider(), name: "Updated name" });
  await new Promise(resolve => setImmediate(resolve));
  respond();
  const [refreshed, displayed] = await Promise.all([refresh, reopened]);
  assert.deepEqual(displayed.amounts, [{ currency: "CNY", remaining: 9 }]);
  assert.deepEqual(displayed.amounts, refreshed.amounts);
  assert.equal(displayed.name, "Updated name");
  assert.equal(fetch.mock.callCount(), 2, "the reopened panel shares the in-flight request");
});

test("unauthorized readings clear stale balances rather than suggesting a valid login", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(deepseek()));
  const service = new ProviderBalanceService();
  await service.read(provider());
  fetch.mock.mockImplementation(async () => new Response(null, { status: 401 }));
  const denied = await service.read(provider(), true);
  assert.equal(denied.error, "authorization");
  assert.deepEqual(denied.amounts, []);
  fetch.mock.mockImplementation(async () => { throw new Error("secret URL or body must not escape"); });
  const unavailable = await service.read(provider(), true);
  assert.deepEqual(unavailable.amounts, []);
  assert.equal(unavailable.error, "unavailable");
  assert.ok(!JSON.stringify(unavailable).includes("secret"));
});

test("malformed auth headers affect only that provider and never expose credential values", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(deepseek()));
  const service = new ProviderBalanceService();
  const results = await Promise.all([
    service.read({ ...provider(), auth: async () => ({ apiKey: "fixture-secret\ninvalid" }) }),
    service.read({ ...provider(), auth: async () => ({ apiKey: "fixture-secret", headers: { "invalid header": "private-value" } }) }),
    service.read(provider()),
  ]);
  assert.deepEqual(results.map(result => result.error), ["credentials", "credentials", undefined]);
  assert.equal(fetch.mock.callCount(), 1);
  assert.ok(!JSON.stringify(results).includes("fixture-secret"));
  assert.ok(!JSON.stringify(results).includes("private-value"));
});

test("cache survives restarts, stores no credentials and separates edited query definitions", async t => {
  const home = mkdtempSync(join(tmpdir(), "pix-balance-cache-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "balances.json");
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ data: { balance: 9 } }));
  const p = { ...provider("https://relay.example/v1"), query };
  const fresh = await new ProviderBalanceService(path).read(p);
  const saved = readFileSync(path, "utf8");
  assert.ok(!saved.includes("fixture-secret"));
  assert.ok(!saved.includes("https://"));
  fetch.mock.mockImplementation(async () => new Response(null, { status: 503 }));
  const restored = await new ProviderBalanceService(path).read(p);
  assert.equal(restored.stale, true);
  assert.deepEqual(restored.amounts, fresh.amounts);
  const changed = await new ProviderBalanceService(path).read({ ...p, query: { ...query, currency: "CNY" } });
  assert.deepEqual(changed.amounts, []);
});

test("malformed, oversized and missing amounts are unavailable, never a fictitious zero", async t => {
  let response: () => Response = () => Response.json({});
  t.mock.method(globalThis, "fetch", async () => response());
  for (const body of [{}, { balance_infos: [] }, deepseek(""), deepseek("not a number"), deepseek("Infinity")]) {
    response = () => Response.json(body);
    assert.equal((await new ProviderBalanceService().read(provider())).error, "invalidResponse");
  }
  response = () => new Response("x".repeat(65537));
  assert.equal((await new ProviderBalanceService().read(provider())).error, "invalidResponse");
  response = () => new Response("not json");
  assert.equal((await new ProviderBalanceService().read(provider())).error, "invalidResponse");
});

test("auth URL overrides are checked before a balance request and timeouts stay distinct", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("should not fetch"); });
  const p = { ...provider(), auth: async () => ({ apiKey: "secret", baseUrl: "https://relay.example/v1" }) };
  assert.equal((await new ProviderBalanceService().read(p)).error, "unsupported");
  assert.equal(fetch.mock.callCount(), 0);
  const abort = new AbortController(); abort.abort();
  t.mock.method(AbortSignal, "timeout", () => abort.signal);
  assert.equal((await new ProviderBalanceService().read({ ...provider(), auth: async signal => { signal.throwIfAborted(); return {}; } })).error, "timeout");
});

test("balance query validation rejects executable paths, URLs and invalid numbers", () => {
  for (const path of ["__proto__.x", "data.constructor", "data[0]", "data.balance / 500000", "", "data..balance"])
    assert.throws(() => balanceQuery({ ...query, path }));
  for (const url of ["file:///etc/passwd", "https://key@relay.example/balance", "https://relay.example/balance#secret"])
    assert.throws(() => balanceQuery({ ...query, url }));
  for (const multiplier of [0, -1, NaN, Infinity, "1"])
    assert.throws(() => balanceQuery({ ...query, multiplier }));
  assert.deepEqual(validateRouteInput("usage.balances", { provider: "deepseek", refresh: true }), { provider: "deepseek", refresh: true });
  assert.equal(isProjectRoute("usage.balances"), false, "balances use the same desktop credentials as provider settings in remote workspaces");
});

test("usage settings preserve billing exclusions and remove only the reset provider query", t => {
  const home = mkdtempSync(join(tmpdir(), "pix-balance-settings-"));
  const previous = process.env.PIX_HOME; process.env.PIX_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous; rmSync(home, { recursive: true, force: true }); });
  const settings = new SettingsService(null);
  settings.update({ usage: { unbilledProviders: ["coding"], balanceQueries: { relay: query } } });
  settings.update({ usage: { unbilledProviders: ["other"] } });
  assert.deepEqual(settings.bundle().app.usage?.balanceQueries, { relay: query });
  settings.update({ usage: { balanceQueries: { relay: null } } });
  assert.deepEqual(settings.bundle().app.usage, { unbilledProviders: ["other"] });
  settings.update({ usage: { balanceQueries: { bad: { url: "file:///bad" }, relay: query } } });
  assert.deepEqual(settings.bundle().app.usage?.balanceQueries, { relay: query });
  settings.update({ usage: null });
  assert.equal(settings.bundle().app.usage, undefined);
});

test("saving one provider's query preserves another window's provider query", t => {
  const home = mkdtempSync(join(tmpdir(), "pix-balance-two-windows-"));
  const previous = process.env.PIX_HOME; process.env.PIX_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous; rmSync(home, { recursive: true, force: true }); });
  const first = new SettingsService(null), second = new SettingsService(null);
  first.update({ usage: { balanceQueries: { one: query } } });
  second.update({ usage: { balanceQueries: { two: { ...query, currency: "CNY" } } } });
  assert.deepEqual(first.bundle().app.usage?.balanceQueries, { one: query, two: { ...query, currency: "CNY" } });
  first.update({ usage: { balanceQueries: { one: null } } });
  assert.deepEqual(second.bundle().app.usage?.balanceQueries, { two: { ...query, currency: "CNY" } });
});

test("controller balances work without a project, isolate auth failures and refresh only one provider", async t => {
  const home = mkdtempSync(join(tmpdir(), "pix-balance-controller-"));
  const previous = process.env.PIX_HOME; process.env.PIX_HOME = home;
  const controller = new MainController(null, { ...headlessPlatform });
  t.after(async () => { await controller.closeAll(); if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous; rmSync(home, { recursive: true, force: true }); });
  const providers = ["configured", "unconfigured", "broken"];
  const modelRuntime = {
    getProviders: () => providers.map(id => ({ id, name: id, baseUrl: "https://api.deepseek.com" })),
    checkAuth: async (id: string) => { if (id === "broken") throw new Error("key error"); return id === "configured" ? { type: "api_key" } : undefined; },
    getAllModels: (): Array<{ provider: string; id: string; baseUrl: string }> => [],
    getAuth: async () => ({ auth: { apiKey: "fixture-secret" } }),
  };
  t.mock.method(controller.projectRuntime, "modelRuntime", async () => modelRuntime);
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(deepseek()));
  const result = await controller.invoke("usage.balances", {}) as ProviderBalance[];
  assert.deepEqual(result.map(card => card.provider), ["configured", "broken"]);
  assert.equal(result[1]?.error, "credentials");
  assert.equal(fetch.mock.callCount(), 1);
  await controller.invoke("usage.balances", { provider: "configured", refresh: true });
  assert.equal(fetch.mock.callCount(), 2);
  const runtime = await controller.projectRuntime.modelRuntime();
  runtime.getAllModels = () => [{ provider: "configured", id: "relayed", baseUrl: "https://relay.example/v1" }];
  const relayed = await controller.invoke("usage.balances", { provider: "configured", refresh: true }) as ProviderBalance[];
  assert.equal(relayed[0]?.error, "unsupported", "model endpoint overrides take precedence over the original vendor's endpoint");
  assert.equal(fetch.mock.callCount(), 2, "a relay key never reaches the original vendor's billing endpoint");
});

test("a stalled SDK auth check times out without blocking healthy balance cards", async t => {
  const home = mkdtempSync(join(tmpdir(), "pix-balance-auth-timeout-"));
  const previous = process.env.PIX_HOME; process.env.PIX_HOME = home;
  const controller = new MainController(null, { ...headlessPlatform });
  t.after(async () => { await controller.closeAll(); if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous; rmSync(home, { recursive: true, force: true }); });
  const runtime = createModels();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  for (const id of ["stalled", "healthy"]) runtime.setProvider({
    id, name: id, baseUrl: "https://api.deepseek.com/v1", getModels: () => [],
    stream: () => { throw new Error("not used"); }, streamSimple: () => { throw new Error("not used"); },
    auth: { apiKey: { name: "fixture",
      check: async () => { if (id === "stalled") await gate; return { type: "api_key" }; },
      resolve: async () => ({ auth: { apiKey: "fixture-secret" } }),
    } },
  });
  t.mock.method(controller.projectRuntime, "modelRuntime", async () => runtime);
  t.mock.method(globalThis, "fetch", async () => Response.json(deepseek()));
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  let settled: ProviderBalance[] | undefined;
  const reading = controller.invoke("usage.balances", {}).then(value => { settled = value as ProviderBalance[]; return settled; });
  await new Promise(resolve => setImmediate(resolve));
  deadline.abort(new DOMException("fixture timeout", "TimeoutError"));
  await new Promise(resolve => setImmediate(resolve));
  const finishedAtDeadline = settled;
  release();
  const result = await reading;
  assert.ok(finishedAtDeadline, "one stalled auth check must not leave the entire list loading past its deadline");
  assert.equal(result.find(card => card.provider === "stalled")?.error, "timeout");
  assert.deepEqual(result.find(card => card.provider === "healthy")?.amounts, [{ currency: "CNY", remaining: 12.34 }]);
});
