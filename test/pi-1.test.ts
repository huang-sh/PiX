import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ExtensionDialogs } from "../src/main/extension-dialogs.js";
import { PiRuntime } from "../src/main/pi-runtime.js";
import { BrokerModelStream, brokerModelKey } from "../src/main/model-broker.js";
import { projectSession } from "../src/shared/session.js";
import { reduceAgentActivity } from "../src/shared/agent-stream.js";
import { validateRouteInput } from "../src/shared/contracts.js";
import type { RawSessionEntry } from "../src/shared/types.js";

test("dialogs validate replies, cancel per owner, and dismiss on abort or timeout", async () => {
  const events: any[] = [];
  const dialogs = new ExtensionDialogs(event => events.push(event));
  const owner = {}, other = {};
  const first = dialogs.request(owner, { kind: "select", title: "Choose", source: "test", options: ["one"] });
  const second = dialogs.request(other, { kind: "input", title: "Input", source: "test" });
  const [a, b] = dialogs.list();
  assert.throws(() => dialogs.respond(a!.id, "unknown"), /Invalid dialog selection/);
  dialogs.respond(a!.id, "one");
  assert.equal(await first, "one");
  dialogs.cancel(owner);
  assert.equal(dialogs.list().length, 1);
  dialogs.respond(b!.id, "");
  assert.equal(await second, "");
  const abort = new AbortController();
  const waiting = dialogs.request(owner, { kind: "input", title: "Code", source: "test" }, { signal: abort.signal });
  abort.abort();
  assert.equal(await waiting, undefined);
  assert.equal(await dialogs.request(owner, { kind: "input", title: "Expired", source: "test" }, { timeout: 1 }), undefined);
  assert.equal(dialogs.list().length, 0);
  assert.equal(events.filter(event => event.type === "ui.dismiss").length, 4);
});

test("Pi 1.0 Codemode runs nested writes through PiX hooks and restores their records", { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "pix-pi1-"));
  const events: any[] = [];
  const runtime = new PiRuntime(root, join(root, "sessions"), event => events.push(event), async () => {});
  runtime.agentDir = () => join(root, "agent");
  mkdirSync(runtime.agentDir());
  writeFileSync(join(runtime.agentDir(), "mcp.json"), JSON.stringify({ mcpServers: { "pix-profile": { command: "unused", enabled: false } } }));
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const options = runtime["sessionServicesOptions"].bind(runtime);
  runtime["sessionServicesOptions"] = (pi, cwd) => {
    const base = options(pi, cwd);
    return { ...base, agentDir: join(root, "agent"), settingsManager: pi.SettingsManager.inMemory({}),
      resourceLoaderOptions: { ...base.resourceLoaderOptions, additionalExtensionPaths: [], noSkills: true, noContextFiles: true } };
  };
  const faux = fauxProvider({ models: [{ id: "test", contextWindow: 128000 }] });
  await runtime.create();
  runtime.runtime.session.modelRuntime.registerNativeProvider(faux.provider);
  await runtime.control({ action: "setModel", provider: "faux", modelId: "test" });
  await runtime.control({ action: "setTools", names: ["read", "write", "codemode"] });
  const tools = runtime.runtime.session.getAllTools().map((tool: any) => tool.name);
  assert.ok(tools.includes("codemode"));
  assert.ok(tools.includes("tool_search"));
  assert.ok((await runtime.control({ action: "commands" }) as any[]).some(command => command.name === "mcp"));
  await runtime.control({ action: "prompt", text: "/mcp" });
  assert.ok(events.some(event => event.type === "notice" && event.payload.message.includes("pix-profile")), "MCP reads PiX's profile");
  faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", {
    code: 'text(await tools.write({ path: "nested.txt", content: "Pi 1.0" }));',
  })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  await runtime.control({ action: "prompt", text: "write a file using Codemode" });
  assert.equal(readFileSync(join(root, "nested.txt"), "utf8"), "Pi 1.0");
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.projection.nodes.at(-1)!.fileChanges?.length, 1);
  assert.equal(snapshot.projection.nodes.at(-1)!.toolCallCount, 2);
  const call = snapshot.projection.messages.find(message => message.toolName === "codemode");
  assert.equal(call?.nestedCalls?.[0]?.name, "write");
  const path = snapshot.session.path;
  await runtime.close();
  await runtime.open(path);
  assert.deepEqual(runtime.snapshot().projection.messages.find(message => message.toolName === "codemode")?.nestedCalls, call!.nestedCalls);
  assert.ok(events.some(event => event.payload?.parentToolCallId));
});

test("image and classifier catalogs cross the broker without credentials and remain separate from chat", async () => {
  const base = { provider: "test", id: "shared", name: "test", api: "test", input: ["text"], cost: {} };
  const catalog = validateRouteInput("agent.control", { action: "setBrokerProviders", providers: ["test"], models: [
    { ...base, type: "image", output: ["image"], headers: { Authorization: "secret" } },
    { ...base, type: "classifier", contextWindow: 1000 },
  ] });
  assert.ok(!JSON.stringify(catalog).includes("secret"));
  assert.notEqual(brokerModelKey(base), brokerModelKey({ ...base, type: "image" }));
  assert.notEqual(brokerModelKey({ ...base, type: "image" }), brokerModelKey({ ...base, type: "classifier" }));
  const stream = new BrokerModelStream(base);
  const result = { output: [{ type: "image", data: "image", mimeType: "image/png" }], stopReason: "stop" };
  stream.push({ type: "result", result });
  assert.deepEqual(await stream.result(), result);
  for (const type of ["image", "classifier"]) {
    const failed = new BrokerModelStream({ ...base, type });
    failed.fail("disconnected");
    assert.equal((await failed.result()).stopReason, "error");
    assert.deepEqual((await failed.result())[type === "image" ? "output" : "answers"], type === "image" ? [] : {});
    const aborted = new BrokerModelStream({ ...base, type });
    aborted.fail("cancelled", true);
    assert.equal((await aborted.result()).stopReason, "aborted");
  }
});

test("tool images and nested ancestry survive the live and persisted projections", () => {
  const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
  const result = { role: "toolResult", toolName: "codemode", toolCallId: "parent", content: [image],
    nestedCalls: { complete: false, calls: [{ id: "child", name: "write", arguments: { path: "file" }, status: "ok" }] } };
  const entries: RawSessionEntry[] = [
    { id: "u", parentId: null, timestamp: "1", type: "message", message: { role: "user", content: "draw" } },
    { id: "r", parentId: "u", timestamp: "2", type: "message", message: result },
  ];
  const message = projectSession(entries, "r").messages.at(-1)!;
  assert.deepEqual(message.images, [image]);
  assert.equal(message.nestedCalls?.[0]?.input, "file");
  assert.equal(message.nestedCallsComplete, false);
  let activity = reduceAgentActivity(undefined, { type: "tool_execution_start", toolCallId: "child", parentToolCallId: "parent", toolName: "write" });
  activity = reduceAgentActivity(activity, { type: "tool_execution_end", toolCallId: "child", result });
  assert.equal(activity!.items[0]!.parentToolCallId, "parent");
  assert.deepEqual(activity!.items[0]!.images, [image]);
});
