// GUI interaction stress: a 119MB/400-turn details-heavy session, hammered.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts");
const testHome = join(artifacts, "gui-stress-home");
const workspace = join(artifacts, "gui-stress-workspace");
const sessionPath = join(workspace, ".pi", "sessions", "stress.jsonl");
rmSync(testHome, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });
mkdirSync(join(testHome, ".pix", "agent"), { recursive: true });
mkdirSync(join(workspace, ".pi", "sessions"), { recursive: true });
writeFileSync(join(testHome, ".pix", "agent", "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));

// Shape: 400 turns, every turn carrying a big accessibility outline + rendered
// outline — the real-world worst case for the wire window.
{
  const lines = [{ type: "session", version: 3, id: "stress", timestamp: "2026-01-01T00:00:00.000Z", cwd: workspace }];
  let parentId = null;
  for (let i = 0; i < 400; i++) {
    const outline = { lookId: `l${i}`, root: { children: Array.from({ length: 4_000 }, (_, k) => ({ id: k, label: `node ${i}-${k}`, role: "AXButton" })) } };
    const msg = (id, p, message) => lines.push({ type: "message", id, parentId: p, timestamp: "2026-01-01T00:00:00.000Z", message });
    msg(`u${i}`, parentId, { role: "user", content: [{ type: "text", text: `needle-${i} look at the screen and fix the button labels` }] });
    msg(`t${i}`, `u${i}`, { role: "toolResult", toolName: "computer-use", content: [{ type: "text", text: "Observed visual @r3" }], details: { outline, renderedOutline: "r".repeat(100_000) } });
    msg(`a${i}`, `t${i}`, { role: "assistant", content: [{ type: "text", text: `fixed turn ${i}` }] });
    parentId = `a${i}`;
  }
  writeFileSync(sessionPath, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
}
const stage = name => console.log(`[${new Date().toISOString().slice(11, 19)}] ${name}`);
console.log(`stress session: ${(statSync(sessionPath).size / 1048576).toFixed(1)}MB`);

const electron = electronBinary(root);
const port = 9793;
const child = spawn(electron, [
  "--no-sandbox", "--disable-gpu", `--user-data-dir=${join(testHome, "electron")}`,
  `--remote-debugging-port=${port}`, join(root, "out", "main", "index.js"),
], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "",
    PIX_HOME: testHome, PIX_PROJECT: workspace, PI_OFFLINE: "1", ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk; });

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
  send(method, params = {}) {
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
  async close() {
    if (this.socket.readyState >= WebSocket.CLOSING) return;
    await new Promise(resolve => { const t = setTimeout(resolve, 500); this.socket.addEventListener("close", () => { clearTimeout(t); resolve(); }, { once: true }); this.socket.close(); });
  }
}
async function retry(fn, timeout = 60_000) {
  const start = Date.now();
  let error;
  while (Date.now() - start < timeout) {
    if (child.exitCode !== null) throw new Error(`Electron exited early (${child.exitCode})\n${stderr}`);
    try { return await fn(); } catch (cause) { error = cause; await new Promise(resolve => setTimeout(resolve, 120)); }
  }
  throw error;
}
const ms = n => n >= 1000 ? (n / 1000).toFixed(2) + "s" : Math.round(n) + "ms";

const report = {};
let cdp, consoleErrors = 0;
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
  await cdp.send("Runtime.enable").catch(() => {});
  await cdp.send("Performance.enable").catch(() => {});
  cdp.socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(message.params.type)) consoleErrors++;
    if (message.method === "Runtime.exceptionThrown") consoleErrors++;
  });

  stage("opening session");
  const t0 = Date.now();
  await cdp.evaluate(`window.__pixTest.openSession(${JSON.stringify(sessionPath)})`);
  await retry(() => cdp.evaluate("window.__pixTest.state().current?.projection.nodes.length >= 400"));
  report.openToNodes = ms(Date.now() - t0); stage(`nodes ready (${report.openToNodes})`);
  await cdp.evaluate("window.__pixTest.state().layout.collapsed.chat ? window.__pixTest.toggle('chat') : 0");
  await retry(() => cdp.evaluate("Boolean(document.querySelector('.chat-turn'))"));
  report.openToChat = ms(Date.now() - t0); stage(`chat ready (${report.openToChat})`);
  report.wire = await cdp.evaluate(`window.__pixTest.state().current.entries.length`);

  // 1) Spam the load-earlier button: 10 rapid clicks while fetches are in flight.
  const beforeTurns = await cdp.evaluate("document.querySelectorAll('.chat-turn').length");
  stage("spamming load-earlier");
  const pageStart = Date.now();
  for (let i = 0; i < 10; i++) {
    await cdp.evaluate("document.querySelector('.load-earlier-turns')?.click()");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await retry(() => cdp.evaluate(`!document.querySelector('.load-earlier-turns') || document.querySelector('.load-earlier-turns')?.disabled === false`), 60_000);
  await new Promise(resolve => setTimeout(resolve, 1000));
  // Diagnostics if paging did not grow the visible history.
  if (await cdp.evaluate("document.querySelectorAll('.chat-turn').length") === beforeTurns) {
    const direct = await cdp.evaluate(`window.pix.invoke('session.branchWindow', { session: window.__pixTest.state().current.session.path, leafId: window.__pixTest.state().current.projection.leafId, limit: 80, bytes: 8388608 }).then(r => ({ entries: r.entries.length, hasEarlier: r.hasEarlier }), e => ({ error: String(e.message) }))`);
    console.log("PAGING STALLED. direct branchWindow:", JSON.stringify(direct),
      "windowStates:", await cdp.evaluate("JSON.stringify(window.__pixTest.state().windowStates)"),
      "leaf:", await cdp.evaluate("JSON.stringify({ leafId: window.__pixTest.state().current.projection.leafId, focused: window.__pixTest.state().focusedNode, nodeLeaf: window.__pixTest.state().current.projection.nodes.find(n => n.id === (window.__pixTest.state().focusedNode ?? window.__pixTest.state().current.projection.activeNodeId))?.leafEntryId })"));
  }
  report.paging = { clicks: 10, before: beforeTurns, after: await cdp.evaluate("document.querySelectorAll('.chat-turn').length"),
    totalMs: ms(Date.now() - pageStart), pool: await cdp.evaluate("window.__pixTest.state().current.entries.length") };

  // 2) Rapid node switching across the whole graph.
  const nodeIds = await cdp.evaluate("window.__pixTest.state().current.projection.nodes.map(n => n.id)");
  stage("node switching");
  const switchStart = Date.now();
  for (let i = nodeIds.length - 1; i >= 0; i -= Math.ceil(nodeIds.length / 40)) {
    await cdp.evaluate(`window.__pixTest.selectNode(${JSON.stringify(nodeIds[i])})`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  report.nodeSwitching = { visits: 40, totalMs: ms(Date.now() - switchStart) };

  // 3) Search: type a query letter by letter, then clear it.
  stage("search typing");
  const searchStart = Date.now();
  await cdp.evaluate("document.querySelector('[aria-label=\"Search nodes\"]')?.click() || [...document.querySelectorAll('button')].find(b => b.querySelector('svg.lucide-search'))?.click()");
  await retry(() => cdp.evaluate("Boolean(document.querySelector('[data-action=graph-search-input]'))"));
  for (const part of ["n", "ne", "nee", "need", "needl", "needle", "needle-3", "needle-39", "needle-399"]) {
    await cdp.evaluate(`document.querySelector('[data-action=graph-search-input]').value = ${JSON.stringify(part)};
      document.querySelector('[data-action=graph-search-input]').dispatchEvent(new Event('input', { bubbles: true }))`);
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  await new Promise(resolve => setTimeout(resolve, 800));
  report.search = { typed: 9, totalMs: ms(Date.now() - searchStart),
    count: await cdp.evaluate("document.querySelector('.graph-search-count')?.textContent ?? ''"),
    hits: await cdp.evaluate("document.querySelectorAll('.search-hit, [data-search-hit=true]').length") };

  // 4) Renderer memory after all of it.
  await cdp.send("Performance.enable").catch(() => {});
  const metrics = await cdp.send("Performance.getMetrics").catch(() => undefined);
  report.rendererHeapMB = metrics ? (metrics.metrics.find(m => m.name === "JSHeapUsedSize")?.value / 1048576).toFixed(0) : null;
  report.consoleErrors = consoleErrors;
  console.log(JSON.stringify(report, null, 2));
  if (consoleErrors) throw new Error(`${consoleErrors} renderer console errors`);
} finally {
  try { await cdp?.close(); } catch { /* already gone */ }
  // Electron helpers and the detached host survive a plain kill; take the tree.
  child.kill("SIGKILL");
  spawn("pkill", ["-9", "-f", testHome]);
  await new Promise(resolve => { child.once("exit", resolve); setTimeout(resolve, 1500); });
}
process.exit(0);
