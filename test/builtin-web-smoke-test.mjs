import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundlePiPackage } from "../scripts/bundle-pi-package.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pix-web-smoke-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
// Loopback is allowed only in this isolated test configuration.
writeFileSync(join(agentDir, "web-search.json"), JSON.stringify({
  ssrf: { allowRanges: ["127.0.0.0/8"] },
  fetchRouting: { providers: ["http"] },
}));
const html = `<html><head><title>PiX web fixture</title></head><body><article><h1>PiX web fixture</h1>${
  "<p>BundledWebNeedle: this article checks readable HTML extraction through the packaged extension and its runtime dependencies.</p>".repeat(12)
}</article></body></html>`;
const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
});
let session;
try {
  // Staging outside the repository prevents undeclared dependencies from
  // accidentally resolving against the developer's node_modules.
  if (!process.argv[2]) bundlePiPackage(appDir, root, "pi-web-access");
  const modules = resolve(process.argv[2] ?? join(root, "pi-builtin", "node_modules"));
  const sdkModules = resolve(process.argv[3] ?? join(appDir, "node_modules"));
  const pi = await import(pathToFileURL(join(sdkModules, "@earendil-works/pi-coding-agent/dist/index.js")).href);
  const settingsManager = pi.SettingsManager.create(root, agentDir);
  const services = await pi.createAgentSessionServices({
    cwd: root, agentDir, settingsManager,
    resourceLoaderOptions: { additionalExtensionPaths: [join(modules, "pi-web-access")] },
  });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  ({ session } = await pi.createAgentSessionFromServices({ services, sessionManager: pi.SessionManager.inMemory(root) }));
  await session.bindExtensions({});
  const extension = services.resourceLoader.getExtensions().extensions.find((entry) => entry.tools.has("web_search"));
  assert.ok(extension, "pi-web-access did not register web_search");
  const tool = extension.tools.get("fetch_content");
  assert.ok(tool);
  assert.equal(tool.sourceInfo.source, "cli");
  assert.equal(tool.sourceInfo.scope, "temporary");
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const url = `http://127.0.0.1:${server.address().port}/article`;
  for (const mode of ["raw", "readable"]) {
    const result = await tool.definition.execute(mode, { url, mode }, undefined, undefined, session.extensionRunner.createContext());
    const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    assert.match(text, /BundledWebNeedle/);
    if (mode === "readable") assert.doesNotMatch(text, /<article>|<p>/);
  }
  assert.deepEqual(settingsManager.getPackages(), []);
  console.log(JSON.stringify({ modules, webSearchRegistered: true, rawFetch: true, readableFetch: true, passed: true }));
} finally {
  if (session) {
    await session.extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
  }
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  rmSync(root, { recursive: true, force: true });
}
