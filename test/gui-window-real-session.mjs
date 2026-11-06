// GUI test on the real 48MB session: open, measure, page history, search.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts");
const testHome = join(artifacts, "gui-window-home");
const workspace = join(artifacts, "gui-window-workspace");
const source = process.env.PIX_GUI_SESSION
  ?? "/Users/pch/Projects/PiX/.pi/sessions/2026-10-28T04-15-57-958Z_01a180b8-cff6-75af-bb2a-89be846a9d88.jsonl";
if (!existsSync(source)) throw new Error("source session not found");
rmSync(testHome, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });
mkdirSync(join(testHome, ".pix", "agent"), { recursive: true });
mkdirSync(join(workspace, ".pi", "sessions"), { recursive: true });
writeFileSync(join(testHome, ".pix", "agent", "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
cpSync(source, join(workspace, ".pi", "sessions", "big.jsonl"));

const electron = electronBinary(root);
const port = 9791;
const child = spawn(electron, [
  "--no-sandbox", "--disable-gpu", `--user-data-dir=${join(testHome, "electron")}`,
  `--remote-debugging-port=${port}`, join(root, "out", "main", "index.js"),
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
  await cdp.send("Runtime.enable").catch(() => {});
  await cdp.send("Page.enable").catch(() => {});
  let consoleErrors = 0;
  cdp.socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(message.params.type)) consoleErrors++;
    if (message.method === "Runtime.exceptionThrown") consoleErrors++;
  });

  // Boot layout starts with chat collapsed; expand it for the chat assertions.
  await cdp.evaluate("window.__pixTest.state().layout.collapsed.chat ? window.__pixTest.toggle('chat') : 0");
  const sessions = await retry(() => cdp.evaluate("window.__pixTest.state().sessions.length"));
  if (!sessions) throw new Error("sessions list is empty");

  const openStart = Date.now();
  await cdp.evaluate(`window.__pixTest.openSession(${JSON.stringify(join(workspace, ".pi", "sessions", "big.jsonl"))})`);
  await retry(() => cdp.evaluate(`Boolean(window.__pixTest.state().current?.projection.nodes.length)`));
  const openMs = Date.now() - openStart;

  // Wire window bounded + graph complete.
  const snap = await retry(() => cdp.evaluate(`(() => {
    const current = window.__pixTest.state().current;
    return { entries: current.entries.length, messages: current.projection.messages.length,
      hasEarlier: current.projection.messagesHasEarlier === true, nodes: current.projection.nodes.length,
      messageCount: current.session.messageCount };
  })()`));
  report.openMs = openMs;
  report.snapshot = snap;
  if (snap.hasEarlier !== true) throw new Error(`expected messagesHasEarlier=true, got ${JSON.stringify(snap)}`);
  if (snap.entries >= snap.messageCount + 100) throw new Error("wire snapshot looks unbounded");
  if (snap.nodes < 4) throw new Error(`graph lost nodes: ${snap.nodes}`);

  // Chat panel renders the windowed turn and offers earlier history. Boot
  // starts with chat collapsed and hydration can re-apply it, so expand after
  // the session is open.
  await cdp.evaluate("window.__pixTest.state().layout.collapsed.chat ? window.__pixTest.toggle('chat') : 0");
  await retry(() => cdp.evaluate("Boolean(document.querySelector('.chat-turn'))"), 30_000);
  await cdp.screenshot("gui-window-open.png");
  // The first render can be replaced as window fetches land; sample for a few
  // seconds to see whether turns vanish again (that would be a real bug).
  const samples = await cdp.evaluate(`new Promise(resolve => {
    const seen = [];
    const timer = setInterval(() => {
      const state = window.__pixTest.state();
      const node = state.current?.projection.nodes.find(n => n.id === (state.focusedNode ?? state.current?.projection.activeNodeId));
      seen.push({ turns: document.querySelectorAll('.chat-turn').length,
        load: document.querySelector('.load-earlier-turns')?.textContent?.trim() ?? null,
        activity: Boolean(document.querySelector('.live-output, .agent-process.live')),
        messagesHtml: document.querySelector('.branch-messages')?.innerHTML.length ?? 0,
        leafId: state.current?.projection.leafId ?? null,
        nodeLeaf: node?.leafEntryId ?? null,
        nodeBranch: node?.branchId ?? null,
        hasEarlier: state.current?.projection.messagesHasEarlier === true,
        entries: state.current?.entries.length ?? 0 });
      if (seen.length >= 10) { clearInterval(timer); resolve(seen); }
    }, 300);
  })`);
  report.renderSamples = samples;
  const before = samples.at(-1);
  report.chatBefore = before;

  if (!before.turns) {
    const debug = await cdp.evaluate(`(() => ({
      collapsed: window.__pixTest.state().layout.collapsed.chat,
      focused: window.__pixTest.state().focusedNode,
      body: document.querySelector('.branch-messages')?.innerHTML.slice(200, 1400) ?? null,
    }))()`);
    throw new Error(`chat panel rendered no turns: ${JSON.stringify(debug)}`);
  }

  // Two correct outcomes: either the automatic top-up already delivered the
  // whole history (button gone, every turn rendered), or the button remains
  // and clicking it must strictly grow the visible history.
  if (before.load) {
    await cdp.evaluate("document.querySelector('.load-earlier-turns').click()");
    await retry(() => cdp.evaluate(`document.querySelectorAll('.chat-turn').length > ${before.turns}`), 30_000)
      .catch(async () => {
        const state = await cdp.evaluate("window.__pixTest.state()");
        // Accept the other outcome only if the pool truly holds everything:
        // the local walk reached the root, so nothing earlier exists to load.
        const complete = state.current.entries.length >= state.current.session.messageCount;
        if (!complete) throw new Error("clicking load-earlier did not grow history");
        report.pagedToRootWithoutClick = true;
      });
  } else {
    const state = await cdp.evaluate("window.__pixTest.state()");
    if (state.current.entries.length < state.current.session.messageCount)
      throw new Error(`button hidden but history incomplete: ${state.current.entries.length}/${state.current.session.messageCount}`);
    report.autoLoadedEverything = true;
  }
  report.chatAfter = {
    turns: await cdp.evaluate("document.querySelectorAll('.chat-turn').length"),
    earlier: await cdp.evaluate("document.querySelector('.load-earlier-turns')?.textContent?.trim() ?? null"),
    text: await cdp.evaluate("document.querySelector('.branch-messages')?.textContent.slice(0, 300) ?? ''"),
  };
  if (report.chatAfter.turns < before.turns) throw new Error("paging lost turns");
  await cdp.screenshot("gui-window-paged.png");

  // Graph search must run main-side over the full history and hit nodes.
  await cdp.evaluate("window.pix.invoke('session.search', { session: window.__pixTest.state().current.session.path, query: 'computer-use' })")
    .then(result => { report.search = result; })
    .catch(error => { throw new Error(`session.search failed: ${error.message}`); });
  if (!report.search?.nodeIds?.length) throw new Error(`search found nothing: ${JSON.stringify(report.search)}`);

  // Prompt recall reaches beyond the window (main process full history).
  report.prompts = await cdp.evaluate("window.pix.invoke('session.prompts', { session: window.__pixTest.state().current.session.path })");
  if (!Array.isArray(report.prompts?.prompts) || !report.prompts.prompts.length)
    throw new Error(`prompt recall empty: ${JSON.stringify(report.prompts)}`);

  // Renderer console must stay clean of errors through all of it.
  report.consoleErrors = consoleErrors;

  console.log(JSON.stringify(report, null, 2));
  if (report.consoleErrors) throw new Error(`${report.consoleErrors} renderer console errors`);
} finally {
  try { await cdp?.close(); } catch { /* the socket may already be gone */ }
  child.kill("SIGKILL");
  spawn("pkill", ["-9", "-f", testHome]);
  await new Promise(resolve => { child.once("exit", resolve); setTimeout(resolve, 1500); });
}
process.exit(0);
