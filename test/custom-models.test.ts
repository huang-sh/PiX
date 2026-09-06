import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { addCustomModel, getCustomModels } from "../src/main/custom-models.js";
import { PiRuntime } from "../src/main/pi-runtime.js";
import { validateRouteInput } from "../src/shared/contracts.js";
import type { BrokerModel, CustomModelInput } from "../src/shared/types.js";

const input: CustomModelInput = {
  provider: "pix-custom", modelId: "custom-model", baseUrl: "http://localhost:11434/v1",
  api: "openai-completions", apiKey: "local-test-key", name: "Custom model",
  contextWindow: 64000, maxTokens: 4096, reasoning: false, imageInput: true,
};

test("adds models without losing existing config or persisting keys, rejects invalid input without writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-model-config-"));
  const path = join(dir, "models.json");
  try {
    const existing = { providers: { "pix-custom": { headers: { "x-test": "$TOKEN" }, compat: { supportsStore: false }, models: [{ id: "older" }] }, other: { baseUrl: "https://example.com" } } };
    writeFileSync(path, JSON.stringify(existing));
    addCustomModel(path, input);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(saved.providers.other, existing.providers.other);
    assert.deepEqual(saved.providers["pix-custom"].headers, existing.providers["pix-custom"].headers);
    assert.deepEqual(saved.providers["pix-custom"].compat, existing.providers["pix-custom"].compat);
    assert.equal(saved.providers["pix-custom"].models.length, 2);
    assert.equal(saved.providers["pix-custom"].baseUrl, undefined);
    const before = readFileSync(path, "utf8");
    assert.ok(!before.includes(input.apiKey!));
    assert.throws(() => addCustomModel(path, input), /already exists/);
    for (const patch of [{ baseUrl: "file:///tmp/model" }, { baseUrl: "https://user:secret@example.com" }, { provider: "__proto__" }, { maxTokens: 0 }, { contextWindow: 1.5 }, { api: "unknown" }])
      assert.throws(() => addCustomModel(path, { ...input, ...patch } as CustomModelInput));
    assert.equal(readFileSync(path, "utf8"), before);
    writeFileSync(path, "{broken");
    assert.throws(() => addCustomModel(path, input), /not changed/);
    assert.equal(readFileSync(path, "utf8"), "{broken");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editing retains advanced options and sibling models, lists no credentials and rejects missing targets", () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-model-edit-"));
  const path = join(dir, "models.json");
  try {
    addCustomModel(path, input);
    const config = JSON.parse(readFileSync(path, "utf8"));
    const provider = config.providers[input.provider];
    provider.apiKey = "provider-secret";
    provider.headers = { Authorization: "header-secret" };
    provider.models[0].compat = { supportsStore: false };
    provider.models[0].cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
    provider.models.push({ id: "sibling" });
    writeFileSync(path, JSON.stringify(config));
    const patch = { ...input, name: "Edited", baseUrl: "https://example.com/v1", reasoning: true, imageInput: false, contextWindow: 32000, maxTokens: 2048 };
    addCustomModel(path, patch, true);
    const saved = JSON.parse(readFileSync(path, "utf8")).providers[input.provider];
    assert.equal(saved.models.length, 2);
    assert.deepEqual(saved.models[1], { id: "sibling" });
    assert.deepEqual(saved.models[0].compat, provider.models[0].compat);
    assert.deepEqual(saved.models[0].cost, provider.models[0].cost);
    assert.deepEqual(saved.headers, provider.headers);
    assert.equal(saved.apiKey, "provider-secret");
    const listed = getCustomModels(path);
    const { apiKey, ...expected } = patch;
    assert.deepEqual(listed, [expected]);
    assert.ok(!JSON.stringify(listed).includes("secret"));
    const before = readFileSync(path, "utf8");
    assert.throws(() => addCustomModel(path, { ...patch, modelId: "missing" }, true), /no longer exists/);
    assert.throws(() => addCustomModel(path, { ...patch, baseUrl: "file:///bad" }, true));
    assert.equal(readFileSync(path, "utf8"), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("custom model loads, authenticates, streams with the SDK, survives restart and reaches remote sessions without secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-model-runtime-"));
  let request: any;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    request = { body: JSON.parse(body), authorization: req.headers.authorization, url: req.url };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end('data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"custom works"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const options = { modelsPath: join(dir, "models.json"), authPath: join(dir, "auth.json"), modelsStorePath: join(dir, "catalogs"), allowModelNetwork: false };
  try {
    const runtime = new PiRuntime(null, null, () => {}, async () => {});
    runtime.agentDir = () => dir;
    const sdk = await ModelRuntime.create(options);
    runtime.modelServices = { modelRuntime: sdk };
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    await runtime.control({ action: "addCustomModel", ...input, baseUrl });
    const models = await runtime.control({ action: "getModels" }) as Array<{ id: string }>;
    assert.ok(models.some((model) => model.id === input.modelId));
    assert.ok(!readFileSync(options.modelsPath, "utf8").includes(input.apiKey!));
    assert.ok(readFileSync(options.authPath, "utf8").includes(input.apiKey!));
    const restarted = await ModelRuntime.create(options);
    const model = restarted.getModel(input.provider, input.modelId)!;
    assert.equal(model.baseUrl, baseUrl);
    assert.equal(model.contextWindow, input.contextWindow);
    assert.deepEqual(model.input, ["text", "image"]);
    const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" };
    const response = await restarted.completeSimple(model, { messages: [{ role: "user", content: [{ type: "text", text: "hello" }, image], timestamp: Date.now() }] });
    assert.equal(response.stopReason, "stop");
    assert.deepEqual(response.content, [{ type: "text", text: "custom works" }]);
    assert.equal(request.body.model, input.modelId);
    assert.ok(JSON.stringify(request.body.messages).includes("data:image/png;base64,iVBORw0KGgo="));
    assert.equal(request.authorization, `Bearer ${input.apiKey}`);
    assert.equal(request.url, "/v1/chat/completions");

    const authBefore = readFileSync(options.authPath, "utf8");
    const active = {
      model: sdk.getModel(input.provider, input.modelId)!, modelRuntime: sdk, isStreaming: true,
      setModel: async (next: typeof model) => { active.model = next; },
    };
    runtime.runtime = { session: active };
    runtime.snapshot = (() => ({})) as typeof runtime.snapshot;
    const configBefore = readFileSync(options.modelsPath, "utf8");
    await assert.rejects(runtime.control({ action: "updateCustomModel", ...input, baseUrl }), /current response/);
    assert.equal(readFileSync(options.modelsPath, "utf8"), configBefore);
    active.isStreaming = false;
    await runtime.control({ action: "updateCustomModel", ...input, apiKey: "", baseUrl, name: "Edited", imageInput: false, reasoning: true, contextWindow: 32000, maxTokens: 2048 });
    assert.equal(readFileSync(options.authPath, "utf8"), authBefore);
    const edited = sdk.getModel(input.provider, input.modelId)!;
    assert.deepEqual(active.model, edited);
    assert.equal(edited.name, "Edited");
    assert.equal(edited.contextWindow, 32000);
    assert.equal(edited.maxTokens, 2048);
    assert.equal(edited.reasoning, true);
    assert.deepEqual(edited.input, ["text"]);
    const savedModels = await runtime.control({ action: "getCustomModels" }) as CustomModelInput[];
    assert.equal(savedModels[0]?.name, "Edited");
    assert.equal(savedModels[0]?.apiKey, undefined);
    const editedRestart = await ModelRuntime.create(options);
    assert.equal(editedRestart.getModel(input.provider, input.modelId)?.contextWindow, 32000);

    const catalog = (await runtime.control({ action: "getModels", broker: true }) as BrokerModel[]).filter((m) => m.provider === input.provider);
    const wire = validateRouteInput("agent.control", { action: "setBrokerProviders", providers: [input.provider], models: catalog });
    assert.ok(!JSON.stringify(wire).includes(input.apiKey!));
    assert.ok(!JSON.stringify(wire).includes(baseUrl));
    const remote = new PiRuntime(null, null, () => {}, async () => {});
    const remoteSdk = await ModelRuntime.create({ ...options, modelsPath: null, authPath: join(dir, "remote-auth.json") });
    remote.modelServices = { modelRuntime: remoteSdk };
    await remote.configureBrokerProviders([input.provider], catalog);
    assert.equal(remoteSdk.getModel(input.provider, input.modelId)?.contextWindow, 32000);
    assert.ok((await remoteSdk.getAvailable()).some((m) => m.id === input.modelId));
    const nextSession = await ModelRuntime.create({ ...options, modelsPath: null, authPath: join(dir, "remote-auth.json") });
    await remote.applyModelBroker(nextSession);
    assert.ok(nextSession.getModel(input.provider, input.modelId));
    await remote.configureBrokerProviders([]);
    assert.equal(remoteSdk.getModel(input.provider, input.modelId), undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
