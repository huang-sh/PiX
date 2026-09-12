import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Verifies pi-web-access through the layout `pi install` (and PiX's
// recommended-install action) produces: the package and its runtime
// dependency tree under <agentDir>/npm/node_modules plus an npm: source in
// user settings. The tree is staged from the pinned devDependency so the test
// stays offline; npm itself is not exercised.
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

// Copy name and its production dependencies from the project's node_modules
// into an npm-install-style tree, preserving nested versions.
function stagePackage(modules, installRoot, name, parent, copied = new Set()) {
  const require = createRequire(join(parent, "package.json"));
  const manifest = require.resolve.paths(name)
    .map((path) => join(path, name, "package.json"))
    .find(existsSync);
  assert.ok(manifest, `Missing dependency ${name} required by ${parent}. Run npm ci.`);
  const source = dirname(manifest);
  if (copied.has(source)) return copied;
  const path = relative(modules, source);
  assert.ok(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path),
    `Dependency outside project node_modules: ${source}`);
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  cpSync(source, join(installRoot, "node_modules", path), {
    recursive: true,
    filter: (file) => file === source || basename(file) !== "node_modules",
  });
  copied.add(source);
  for (const dependency of Object.keys(pkg.dependencies ?? {}))
    stagePackage(modules, installRoot, dependency, source, copied);
  return copied;
}

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
  // The persistence half of installAndPersist, without the npm download: the
  // staged tree below stands in for what npm would have installed.
  packageManager.addSourceToSettings("npm:pi-web-access");
  const installRoot = join(agentDir, "npm");
  packageManager.ensureNpmProject(installRoot);
  const staged = stagePackage(sdkModules, installRoot, "pi-web-access", appDir);
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
  console.log(JSON.stringify({ agentDir, stagedPackages: staged.size, webSearchRegistered: true, rawFetch: true, readableFetch: true, passed: true }));
} finally {
  if (session) {
    await session.extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
  }
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  rmSync(root, { recursive: true, force: true });
}
