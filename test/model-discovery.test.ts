import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { normalizeContext, type ModelAuth } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { discoverModels } from "../src/main/model-discovery.js";
import { validateRouteInput } from "../src/shared/contracts.js";
import type { CustomProviderInput } from "../src/shared/types.js";

const provider: CustomProviderInput = {
  provider: "custom", baseUrl: "https://models.example/proxy/v1/", api: "openai-completions", apiKey: "test-secret",
};

test("discovers OpenAI-compatible models, deduplicates IDs and keeps auth out of results", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(url.href, "https://models.example/proxy/v1/models");
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer test-secret");
    assert.equal(options.redirect, "error", "credentials cannot follow a redirect");
    return Response.json({ data: [{ id: "b" }, { id: "a", name: "Alpha" }, { id: "b" }] });
  });
  for (const api of ["openai-completions", "openai-responses"] as const) {
    const models = await discoverModels({ ...provider, api });
    assert.deepEqual(models, [{ id: "a", name: "Alpha" }, { id: "b" }]);
    assert.ok(!JSON.stringify(models).includes("secret"));
  }
  assert.equal(fetch.mock.callCount(), 2);
});

test("root base URLs produce one leading slash for every supported protocol", async t => {
  let expectedPath = "";
  let google = false;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.pathname, expectedPath);
    return Response.json(google ? { models: [] } : { data: [] });
  });
  for (const api of ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const) {
    google = api === "google-generative-ai";
    expectedPath = api === "anthropic-messages" ? "/v1/models" : "/models";
    for (const baseUrl of ["https://proxy.example", "https://proxy.example/"])
      await discoverModels({ ...provider, baseUrl, api });
  }
});

test("discovers Anthropic models across pages with saved credentials and headers", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(url.pathname, "/proxy/v1/models");
    const headers = new Headers(options.headers);
    assert.equal(headers.get("x-api-key"), "stored-secret");
    assert.equal(headers.get("x-tenant"), "tenant");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    if (requests++ === 0) {
      assert.equal(url.searchParams.get("after_id"), null);
      return Response.json({ data: [{ id: "claude-a", display_name: "Claude A" }], has_more: true, last_id: "claude-a" });
    }
    assert.equal(url.searchParams.get("after_id"), "claude-a");
    return Response.json({ data: [{ id: "claude-b" }], has_more: false });
  });
  assert.deepEqual(await discoverModels({ ...provider, baseUrl: "https://models.example/proxy", api: "anthropic-messages", apiKey: "" }, {
    apiKey: "stored-secret", headers: { "x-tenant": "tenant" },
  }), [{ id: "claude-a", name: "Claude A" }, { id: "claude-b" }]);
  assert.equal(requests, 2);
});

test("Anthropic discovery follows the same base URL semantics as the conversation SDK", async t => {
  let expectedPath = "";
  let expectedAuthorization: string | null = null, expectedApiKey: string | null = null;
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(url.pathname, expectedPath);
    const headers = new Headers(options.headers);
    assert.equal(headers.get("authorization"), expectedAuthorization);
    assert.equal(headers.get("x-api-key"), expectedApiKey);
    return Response.json({ data: [], has_more: false });
  });
  const cases = [
    ...["https://proxy.example/api", "https://proxy.example/api/", "https://proxy.example/api/v1"]
      .map(baseUrl => ({ baseUrl, provider: "proxy", apiKey: "fixture-key" })),
    { baseUrl: "https://proxy.example", provider: "anthropic", apiKey: "sk-ant-oat-fixture" },
    { baseUrl: "https://proxy.example", provider: "github-copilot", apiKey: "fixture-key" },
  ];
  for (const { baseUrl, provider: providerId, apiKey } of cases) {
    let conversationPath = "";
    await streamAnthropic({
      id: "claude-fixture", name: "Fixture", provider: providerId, api: "anthropic-messages", baseUrl,
      contextWindow: 1000, maxTokens: 100, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }, normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] }), {
      apiKey, fetch: async (url, options) => {
        conversationPath = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
        const headers = new Headers(options?.headers ?? (url instanceof Request ? url.headers : undefined));
        expectedAuthorization = headers.get("authorization");
        expectedApiKey = headers.get("x-api-key");
        return Response.json({ error: { type: "invalid_request_error", message: "Fixture response" } }, { status: 400 });
      },
    }).result();
    assert.ok(conversationPath.endsWith("/messages"));
    expectedPath = conversationPath.replace(/\/messages$/, "/models");
    await discoverModels({ ...provider, provider: providerId, baseUrl, api: "anthropic-messages", apiKey });
  }
});

test("configured authentication headers take precedence over generated defaults", async t => {
  t.mock.method(globalThis, "fetch", async (_url: URL, options: RequestInit) => {
    const headers = new Headers(options.headers);
    assert.equal(headers.get("Authorization"), "Token configured-auth");
    assert.equal(headers.get("x-tenant"), "tenant-a");
    return Response.json({ data: [{ id: "proxy-model" }] });
  });
  await discoverModels(provider, { headers: { authorization: "Token configured-auth", "x-tenant": "tenant-a" } });
});

test("SDK header removals omit defaults and never send a literal null header", async t => {
  let google = false;
  let keyHeader = "Authorization";
  t.mock.method(globalThis, "fetch", async (_url: URL, options: RequestInit) => {
    const headers = new Headers(options.headers);
    assert.equal(headers.get(keyHeader), null);
    assert.equal(headers.get("accept"), null);
    assert.equal(headers.get("x-remove"), null);
    assert.equal(headers.get("x-tenant"), "tenant-a");
    return Response.json(google ? { models: [] } : { data: [] });
  });
  for (const api of ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const) {
    google = api === "google-generative-ai";
    keyHeader = google ? "X-Goog-Api-Key" : api === "anthropic-messages" ? "X-Api-Key" : "Authorization";
    const auth: ModelAuth = { headers: { [keyHeader]: null, AcCePt: null, "X-Remove": null, "X-Tenant": "tenant-a" } };
    await discoverModels({ ...provider, api }, auth);
  }
});

test("discovery follows the endpoint resolved by authentication and validates it before sending keys", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(url.href, "https://resolved.example/region/v1/models");
    assert.equal(new Headers(options.headers).get("authorization"), "Bearer resolved-key");
    return Response.json({ data: [] });
  });
  const auth: ModelAuth = { apiKey: "resolved-key", baseUrl: "https://resolved.example/region/v1/" };
  await discoverModels({ ...provider, apiKey: "" }, auth);
  const calls = fetch.mock.callCount();
  await assert.rejects(discoverModels(provider, { ...auth, baseUrl: "file:///tmp/models" }), /HTTP/);
  assert.equal(fetch.mock.callCount(), calls);
});

test("discovers Gemini conversation models, normalizes IDs and follows page tokens", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(url.pathname, "/v1beta/models");
    assert.equal(new Headers(options.headers).get("x-goog-api-key"), provider.apiKey);
    if (requests++ === 0) return Response.json({ models: [
      { name: "models/gemini-a", displayName: "Gemini A", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
    ], nextPageToken: "page-two" });
    assert.equal(url.searchParams.get("pageToken"), "page-two");
    return Response.json({ models: [{ name: "models/gemini-b" }] });
  });
  assert.deepEqual(await discoverModels({ ...provider, baseUrl: "https://models.example/v1beta", api: "google-generative-ai" }), [
    { id: "gemini-a", name: "Gemini A" }, { id: "gemini-b", name: "models/gemini-b" },
  ]);
});

test("handles keyless endpoints and rejects invalid responses, pagination and HTTP failures", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async (_url: URL, options: RequestInit) => {
    assert.equal(new Headers(options.headers).get("Authorization"), null);
    return Response.json({ data: [] });
  });
  assert.deepEqual(await discoverModels({ ...provider, apiKey: "" }), []);
  for (const body of [{}, { data: [{}] }, { data: [{ id: " " }] }, { data: [], has_more: true }]) {
    fetch.mock.mockImplementation(async () => Response.json(body));
    await assert.rejects(discoverModels(provider), /invalid/);
  }
  fetch.mock.mockImplementation(async () => Response.json({ data: [{ id: "a" }], has_more: true, last_id: "a" }));
  await assert.rejects(discoverModels(provider), /pagination/);
  fetch.mock.mockImplementation(async () => new Response("<html>Login</html>"));
  await assert.rejects(discoverModels(provider), /did not return JSON/);
  fetch.mock.mockImplementation(async () => new Response("test-secret", { status: 401 }));
  await assert.rejects(discoverModels(provider), error => error instanceof Error && /HTTP 401/.test(error.message) && !error.message.includes("test-secret"));
  const calls = fetch.mock.callCount();
  await assert.rejects(discoverModels({ ...provider, baseUrl: "file:///tmp/models" }), /HTTP/);
  assert.equal(fetch.mock.callCount(), calls);
});

test("a deadline interrupts a response whose headers arrive but JSON body stalls", { timeout: 5000 }, async t => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"data":[{"id":"incomplete"},');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const deadline = new AbortController();
  let received!: () => void;
  const headersReceived = new Promise<void>(resolve => { received = resolve; });
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    const response = await nativeFetch(url, options);
    received();
    return response;
  });
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const failed = assert.rejects(discoverModels({ ...provider, baseUrl }, {}, deadline.signal), /timed out/);
    await headersReceived;
    await new Promise<void>(resolve => setImmediate(resolve));
    deadline.abort();
    await failed;
  } finally {
    deadline.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("oversized responses and catalogs fail instead of returning a partial list", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(" ".repeat(8 * 1024 * 1024 + 1)));
  await assert.rejects(discoverModels(provider), /exceeds 8 MB/);
  fetch.mock.mockImplementation(async () => Response.json({ data: Array.from({ length: 10001 }, (_, id) => ({ id: `model-${id}` })) }));
  await assert.rejects(discoverModels(provider), /exceeds 10000 models/);
});

test("validates batch submissions and discovery independently of model options", () => {
  assert.deepEqual(validateRouteInput("agent.control", { action: "discoverModels", ...provider }), { action: "discoverModels", ...provider });
  const batch = { action: "addCustomModels", ...provider, contextWindow: 64000, maxTokens: 4096, reasoning: false, imageInput: true,
    models: [{ modelId: "a", name: "Alpha" }, { modelId: "b" }] };
  assert.equal((validateRouteInput("agent.control", batch) as typeof batch).models.length, 2);
  for (const models of [[], [{ modelId: " " }], [{ modelId: "a" }, { modelId: " a " }]])
    assert.throws(() => validateRouteInput("agent.control", { ...batch, models }));
});
