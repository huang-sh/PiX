// GUI test: export a branch subgraph of the real session through the same
// agent.control call the context menu makes, and prove the exported copy
// carries both the graph and the stored file-change diffs.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts");
const testHome = join(artifacts, "gui-export-home");
const workspace = join(artifacts, "gui-export-workspace");
const source = process.env.PIX_GUI_SESSION
  ?? "/Users/pch/Projects/PiX/.pi/sessions/2026-10-28T04-15-57-958Z_01a180b8-cff6-75af-bb2a-89be846a9d88.jsonl";
const branchId = "884865b2-e960-41c4-a72c-0897b42bf436";
if (!existsSync(source)) throw new Error("source session not found");
for (const dir of [testHome, workspace]) rmSync(dir, { recursive: true, force: true });
mkdirSync(join(testHome, ".pix", "agent"), { recursive: true });
mkdirSync(join(workspace, ".pi", "sessions"), { recursive: true });
writeFileSync(join(testHome, ".pix", "agent", "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
const session = join(workspace, ".pi", "sessions", "big.jsonl");
cpSync(source, session);
// Copy the graph and snapshot sidecars; owner.json is a live lock, never data.
mkdirSync(`${session}.pix-tree`);
for (const name of readdirSync(`${source}.pix-tree`)) if (name !== "owner.json")
  cpSync(join(`${source}.pix-tree`, name), join(`${session}.pix-tree`, name), { recursive: true });
cpSync(`${source}.file-changes`, `${session}.file-changes`, { recursive: true });

const electron = electronBinary(root);
// PIX_GUI_APP points the same drive at an installed bundle (e.g. /Applications/
// PiX.app) instead of the dev out/ build.
const installed = process.env.PIX_GUI_APP;
const port = 9793;
const child = spawn(installed ?? electron, [
  "--no-sandbox", "--disable-gpu", `--user-data-dir=${join(testHome, "electron")}`,
  `--remote-debugging-port=${port}`, ...(installed ? [] : [join(root, "out", "main", "index.js")]),
], {
  cwd: root,
  env: {
    ...process.env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "",
    PIX_HOME: testHome, PIX_PROJECT: workspace, PI_OFFLINE: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk; });
const exitEarly = () => { throw new Error(`Electron exited early (${child.exitCode})\n${stderr}`); };

class Cdp {
  constructor(url) { this.socket = new WebSocket(url); this.id = 0; this.pending = new Map(); }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
  }
  async send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  async screenshot(name) {
    const shot = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(artifacts, name), Buffer.from(shot.data, "base64"));
  }
}

async function retry(fn, timeout = 30_000) {
  const start = Date.now();
  let error;
  while (Date.now() - start < timeout) {
    if (child.exitCode !== null) exitEarly();
    try { return await fn(); } catch (cause) { error = cause; await new Promise(resolve => setTimeout(resolve, 120)); }
  }
  throw error;
}

const readExported = path => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
const report = {};
let cdp;
try {
  await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json`);
    const pages = (await response.json()).filter(item => item.type === "page" && item.webSocketDebuggerUrl);
    if (!pages.length) throw new Error("no pages yet");
    for (const page of pages) {
      const probe = new Cdp(page.webSocketDebuggerUrl);
      await probe.open().catch(() => {});
      const ready = await probe.evaluate("window.__pixTest?.state().loading === false && Boolean(document.querySelector('.shell'))").catch(() => false);
      if (ready) { cdp = probe; return; }
      await probe.close().catch(() => {});
    }
    throw new Error(`app still booting (${pages.length} pages)`);
  });
  cdp.socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(message.params.type)) report.consoleErrors = (report.consoleErrors ?? 0) + 1;
    if (message.method === "Runtime.exceptionThrown") report.consoleErrors = (report.consoleErrors ?? 0) + 1;
  });

  await cdp.evaluate(`window.__pixTest.openSession(${JSON.stringify(session)})`);
  const state = await retry(() => cdp.evaluate(`(() => {
    const current = window.__pixTest.state().current;
    if (!current?.projection.nodes.length) throw new Error("no nodes");
    return { path: current.session.path, nodes: current.projection.nodes.length,
      branchNode: current.projection.nodes.find(node => node.branchId === ${JSON.stringify(branchId)})?.id ?? null,
      graphBranches: current.graph ? null : null };
  })()`), 90_000);
  if (!state.branchNode) throw new Error(`branch ${branchId} has no node in the projection`);
  report.session = state;

  // The exact call the 导出分支 context menu makes.
  for (const direction of ["descendants", "ancestors"]) {
    const result = await cdp.evaluate(`window.pix.invoke('agent.control', ${JSON.stringify({
      action: "exportBranchSession", nodeId: state.branchNode, graphId: state.path, direction,
    })})`);
    if (!result?.path || !existsSync(result.path)) throw new Error(`${direction}: no exported file (${JSON.stringify(result)})`);
    const entries = readExported(result.path);
    const changes = entries.filter(entry => entry.type === "custom" && entry.customType === "pix.file-change");
    const snapshots = readdirSync(`${result.path}.file-changes`);
    const withPatch = snapshots.filter(name => {
      const snapshot = JSON.parse(readFileSync(join(`${result.path}.file-changes`, name), "utf8"));
      return typeof snapshot.patch === "string" && snapshot.patch.length > 0;
    });
    report[direction] = { path: result.path, entries: entries.length, fileChangeEntries: changes.length,
      snapshots: snapshots.length, snapshotsWithPatch: withPatch.length };
    if (direction === "descendants") {
      if (!changes.length) throw new Error("descendants export lost the file-change entries");
      if (!withPatch.length) throw new Error("no copied snapshot carries a readable patch");
      await cdp.screenshot("gui-export-branch.png");
    }
  }
  // Opening the exported copy in the GUI must project its changes panel data.
  await cdp.evaluate(`window.__pixTest.openSession(${JSON.stringify(report.descendants.path)})`);
  const reopened = await retry(() => cdp.evaluate(`(() => {
    const current = window.__pixTest.state().current;
    const withChanges = current?.projection.nodes.filter(node => node.fileChanges?.length) ?? [];
    if (!current?.projection.nodes.length) throw new Error("no nodes");
    return { nodes: current.projection.nodes.length, nodesWithFileChanges: withChanges.length,
      sample: withChanges[0]?.fileChanges[0] ?? null };
  })()`), 60_000);
  report.reopenedExport = reopened;
  if (!reopened.nodesWithFileChanges) throw new Error("exported copy shows no file changes in the GUI");
  await cdp.screenshot("gui-export-reopened.png");

  console.log(JSON.stringify(report, null, 2));
  if (report.consoleErrors) throw new Error(`${report.consoleErrors} renderer console errors`);
} finally {
  try { await cdp?.close(); } catch { /* the socket may already be gone */ }
  child.kill("SIGKILL");
  spawn("pkill", ["-9", "-f", testHome]);
  await new Promise(resolve => { child.once("exit", resolve); setTimeout(resolve, 1500); });
}
process.exit(0);
