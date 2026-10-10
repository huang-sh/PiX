// Run with Node for development, or ELECTRON_RUN_AS_NODE=1 and packaged PiX
// to exercise the actual external extension and the SDK inside app.asar.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const modules = resolve(process.argv[2] ?? fileURLToPath(new URL("../node_modules", import.meta.url)));
const sdkModules = resolve(process.argv[3] ?? modules);
const root = mkdtempSync(join(tmpdir(), "pix-fff-smoke-"));
const agentDir = join(root, "agent");
const project = join(root, "project");
mkdirSync(agentDir);
mkdirSync(project);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.FFF_FRECENCY_DB = join(agentDir, "frecency");
process.env.FFF_HISTORY_DB = join(agentDir, "history");
process.env.PI_OFFLINE = "1";
writeFileSync(join(project, "pix-fff-fixture.ts"), "export const pixFffNeedle = 42;\n");

let session;
try {
  const pi = await import(pathToFileURL(join(sdkModules, "@earendil-works/pi-coding-agent/dist/index.js")).href);
  const settingsManager = pi.SettingsManager.create(project, agentDir);
  const services = await pi.createAgentSessionServices({
    cwd: project, agentDir, settingsManager,
    resourceLoaderOptions: {
      additionalExtensionPaths: [join(modules, "@ff-labs/pi-fff")],
      extensionFactories: [{ name: "codemode", builtin: true, factory: pi.createCodemodeExtension() }],
    },
  });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  ({ session } = await pi.createAgentSessionFromServices({
    services, sessionManager: pi.SessionManager.inMemory(project),
  }));
  await session.bindExtensions({});
  const extension = services.resourceLoader.getExtensions().extensions.find((entry) => entry.commands.has("fff-mode"));
  assert.ok(extension, "pi-fff was not loaded as an extension");
  for (const [name, pattern, expected] of [
    ["fffind", "pix-fff-fixture", /pix-fff-fixture\.ts/],
    ["ffgrep", "pixFffNeedle", /export const pixFffNeedle = 42/],
  ]) {
    const tool = extension.tools.get(name);
    assert.ok(tool, `${name} was not registered`);
    assert.equal(tool.sourceInfo.source, "cli");
    assert.equal(tool.sourceInfo.scope, "temporary");
    const result = await tool.definition.execute(name, { pattern }, undefined, undefined, session.extensionRunner.createContext());
    assert.match(result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), expected);
  }
  assert.deepEqual(settingsManager.getPackages(), []);
  // A real nested call also exercises Codemode's worker and QuickJS WASM in app.asar.
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(join(sdkModules, "@earendil-works/pi-ai/dist/providers/faux.js")).href);
  const faux = fauxProvider();
  session.modelRuntime.registerNativeProvider(faux.provider);
  await session.setModel(session.modelRuntime.getModel("faux", "faux-1"));
  session.setActiveToolsByName(["codemode", "ffgrep"]);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: 'text(await tools.ffgrep({ pattern: "pixFffNeedle" }));' })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("Search the fixture with Codemode");
  const call = session.sessionManager.getEntries().find(entry => entry.message?.toolName === "codemode")?.message;
  assert.equal(call?.isError, false);
  assert.match(JSON.stringify(call.content), /export const pixFffNeedle = 42/);
  assert.equal(call.nestedCalls.calls[0].name, "ffgrep");
  console.log(JSON.stringify({ modules, sdkModules, fffind: true, ffgrep: true, codemode: true, passed: true }));
} finally {
  if (session) {
    await session.extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
