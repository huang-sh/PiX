import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Verifies pi-web-access through the exact path PiX's recommended-install
// button uses: DefaultPackageManager.installAndPersist (user scope) into a
// temp agentDir, discovery via settings, then a live fetch through the
// extension and its runtime dependencies. Runs a real npm install, so it
// needs registry access and installs the latest published version.
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
  "<p>InstalledWebNeedle: this article checks readable HTML extraction through the user-installed extension and its runtime dependencies.</p>".repeat(12)
}</article></body></html>`;
const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
});
let session;
try {
  const sdkModules = resolve(process.argv[2] ?? join(appDir, "node_modules"));
  const pi = await import(pathToFileURL(join(sdkModules, "@earendil-works/pi-coding-agent/dist/index.js")).href);
  const settingsManager = pi.SettingsManager.create(root, agentDir);
  const packageManager = new pi.DefaultPackageManager({ cwd: root, agentDir, settingsManager });
  await packageManager.installAndPersist("npm:pi-web-access");
  const services = await pi.createAgentSessionServices({ cwd: root, agentDir, settingsManager });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  ({ session } = await pi.createAgentSessionFromServices({ services, sessionManager: pi.SessionManager.inMemory(root) }));
  await session.bindExtensions({});
  const extension = services.resourceLoader.getExtensions().extensions.find((entry) => entry.tools.has("web_search"));
  assert.ok(extension, "pi-web-access did not register web_search");
  assert.equal(extension.sourceInfo.source, "npm:pi-web-access");
  assert.equal(extension.sourceInfo.scope, "user");
  const tool = extension.tools.get("fetch_content");
  assert.ok(tool);
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const url = `http://127.0.0.1:${server.address().port}/article`;
  for (const mode of ["raw", "readable"]) {
    const result = await tool.definition.execute(mode, { url, mode }, undefined, undefined, session.extensionRunner.createContext());
    const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    assert.match(text, /InstalledWebNeedle/);
    if (mode === "readable") assert.doesNotMatch(text, /<article>|<p>/);
  }
  assert.deepEqual(settingsManager.getPackages(), ["npm:pi-web-access"]);
  console.log(JSON.stringify({ agentDir, webSearchRegistered: true, rawFetch: true, readableFetch: true, passed: true }));
} finally {
  if (session) {
    await session.extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
  }
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  rmSync(root, { recursive: true, force: true });
}
