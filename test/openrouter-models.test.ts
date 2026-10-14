import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiRuntime } from "../src/main/pi-runtime.js";
import type { BrokerModel, RuntimeModel } from "../src/shared/types.js";

test("OpenRouter login immediately filters by key and regional endpoint, preserves limits/prices and restores the offline catalog", async t => {
  const root = mkdtempSync(join(tmpdir(), "pix-openrouter-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const authPath = join(root, "auth.json");
  const modelsPath = join(root, "models.json");
  const configure = (region: string) => writeFileSync(modelsPath, JSON.stringify({
    providers: { openrouter: { baseUrl: `https://${region}.openrouter.ai/api/v1` } },
  }));
  writeFileSync(authPath, JSON.stringify({ openrouter: { type: "api_key", key: "test-key-a" } }));
  configure("us");
  const options = { authPath, modelsPath, catalogBaseUrl: "https://catalog.example" };
  const modelRuntime = await ModelRuntime.create(options);
  const candidates = modelRuntime.getModels("openrouter").slice(0, 2);
  assert.equal(candidates.length, 2);
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (new URL(url).origin === options.catalogBaseUrl) return new Response(null, { status: 404 });
    const key = new Headers(init?.headers).get("authorization");
    const index = key === "Bearer test-key-a" ? 0 : 1;
    assert.equal(key, index === 0 ? "Bearer test-key-a" : "Bearer test-key-b");
    assert.equal(url, `https://${index === 0 ? "us" : "eu"}.openrouter.ai/api/v1/models/user`);
    requests.push(url);
    return Response.json({ data: [{ id: candidates[index]!.id,
      top_provider: { context_length: 75000 + index, max_completion_tokens: 4096 + index },
      pricing: { prompt: "0.000002", completion: "0.000007", input_cache_read: "0.000001" },
    }] });
  });
  const runtime = new PiRuntime(null, null, () => {}, async () => {});
  runtime.agentDir = () => root;
  runtime.modelServices = { modelRuntime };
  for (const index of [0, 1]) {
    configure(index === 0 ? "us" : "eu");
    await runtime.control({ action: "loginApiKey", provider: "openrouter", apiKey: index === 0 ? "test-key-a" : "test-key-b" });
    const chat = (await runtime.control({ action: "getModels" }) as RuntimeModel[]).filter(model => model.provider === "openrouter");
    assert.deepEqual(chat.map(model => model.id), [candidates[index]!.id]);
    assert.equal(chat[0]!.contextWindow, 75000 + index);
    const catalog = (await runtime.control({ action: "getModels", broker: true }) as BrokerModel[])
      .filter(model => model.provider === "openrouter" && (!model.type || model.type === "chat"));
    assert.equal(catalog.length, 1);
    const model = catalog[0]!;
    assert.ok(model.type !== "image" && model.type !== "classifier");
    assert.equal(model.id, candidates[index]!.id);
    assert.equal(model.contextWindow, 75000 + index);
    assert.equal(model.maxTokens, 4096 + index);
    assert.deepEqual(model.cost, { input: 2, output: 7, cacheRead: 1, cacheWrite: 0 });
    assert.ok(!JSON.stringify(catalog).includes("test-key-"), "broker catalogs carry no credentials");
  }
  assert.equal(requests.length, 2);
  const restored = await ModelRuntime.create(options);
  assert.deepEqual(restored.getModels("openrouter").map(model => model.id), [candidates[1]!.id]);
  assert.equal(restored.getModels("openrouter")[0]!.maxTokens, 4097);
  assert.equal(restored.getModels("openrouter")[0]!.cost.input, 2);
  assert.equal(requests.length, 2, "reopening restores the personalized catalog without network access");
});
