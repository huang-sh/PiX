// Per-turn file changes end to end: a real session (faux provider) writes three
// files, then the built app renders the file card, its saved diff and its
// narrow-dock layout.
//
// Needs `tsc -p tsconfig.test.json` (out-test/) and `npm run build` (out/); the
// npm script below does both.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts");
// Fixed locations: every run starts from the same three files and session, and
// the previous run's app data is replaced instead of accumulating.
const testHome = join(artifacts, "gui-home-changes");
const project = join(artifacts, "gui-changes-workspace");
if (!existsSync(join(root, "out/main/index.js")) || !existsSync(join(root, "out-test/src/main/pi-runtime.js")))
  throw new Error("Build the app first: npx tsc -p tsconfig.test.json && npm run build");
const { PiRuntime } = await import("../out-test/src/main/pi-runtime.js");
const { fauxAssistantMessage, fauxProvider, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");

const electron = process.env.ELECTRON_BINARY ?? electronBinary(root);
if (!existsSync(electron)) throw new Error("Electron binary not found");
rmSync(testHome, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });
mkdirSync(join(project, "src"), { recursive: true });
mkdirSync(join(testHome, ".pi", "agent"), { recursive: true });
mkdirSync(join(testHome, ".pix"), { recursive: true });
process.env.PIX_HOME = testHome;
process.env.PI_CODING_AGENT_DIR = join(testHome, ".pi", "agent");
writeFileSync(join(testHome, ".pi", "agent", "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
writeFileSync(join(testHome, ".pix", "settings.json"), JSON.stringify({
  language: "zh-CN",
  openLastSessionOnStartup: true,
  layout: {
    version: 4,
    widths: { navigator: 248, chat: 356, content: 320 },
    collapsed: { navigator: true, chat: false, content: true },
    composer: { open: false },
    minimap: false,
    utility: { open: false, collapsed: false, height: 250, activeTab: "terminal" },
  },
}));
writeFileSync(join(project, "src", "main.ts"), 'const greeting = "Hello";\nconsole.log(greeting);\n');

// One real turn that writes three files without a Git repository.
const runtime = new PiRuntime(project, join(project, ".pi", "sessions"), () => {}, async () => {});
await runtime.create();
const faux = fauxProvider({ models: [{ id: "test" }] });
runtime.runtime.session.modelRuntime.registerNativeProvider(faux.provider);
await runtime.control({ action: "setModel", provider: "faux", modelId: "test" });
faux.setResponses([
  fauxAssistantMessage([
    fauxToolCall("write", { path: "src/main.ts", content: 'const greeting = "你好，PiX";\nconsole.log(greeting);\nexport { greeting };\n' }),
    fauxToolCall("write", { path: "src/settings.json", content: '{\n  "theme": "dark",\n  "language": "zh-CN"\n}\n' }),
    fauxToolCall("write", { path: "README.md", content: "# PiX\n\n每轮改动均可查看历史差异。\n" }),
  ], { stopReason: "toolUse" }),
  fauxAssistantMessage("已更新问候语与设置，并补充项目说明。"),
]);
await runtime.control({ action: "prompt", text: "更新问候语和设置，并添加项目说明。" });
const snapshot = runtime.snapshot();
assert.equal(snapshot.projection.nodes[0].fileChanges.length, 3, "the turn should record three files");
await runtime.close();

const port = 9900 + Math.floor(Math.random() * 80);
const args = [
  "--no-sandbox",
  "--disable-gpu",
  `--user-data-dir=${join(testHome, "electron")}`,
  `--remote-debugging-port=${port}`,
  root,
];
const xvfb = process.platform === "linux" ? String(spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout).trim() : "";
const child = xvfb
  ? spawn(xvfb, ["-a", electron, ...args], { cwd: root, env: testEnv() })
  : spawn(electron, args, { cwd: root, env: testEnv(), windowsHide: true });
function testEnv() {
  return { ...process.env, PIX_HOME: testHome, PIX_PROJECT: project, PI_OFFLINE: "1", ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
}
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += String(chunk)));

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error
        ? pending.reject(new Error(message.error.message))
        : pending.resolve(message.result);
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
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    return result.result?.value;
  }
  async close() {
    if (this.socket.readyState >= WebSocket.CLOSING) return;
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 500);
      this.socket.addEventListener("close", () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.socket.close();
    });
  }
}

async function retry(fn, timeout = 20_000) {
  const start = Date.now();
  let error;
  while (Date.now() - start < timeout) {
    if (child.exitCode !== null)
      throw new Error(`Electron exited early (${child.exitCode})\n${stderr}`);
    try {
      return await fn();
    } catch (cause) {
      error = cause;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw error;
}

/** retry() only repeats on a throw, so every wait rejects until it can proceed. */
async function waitFor(expression, label) {
  return retry(async () => {
    const value = await cdp.evaluate(expression);
    if (value === null || value === undefined || value === false)
      throw new Error(`Waiting for ${label}\n${stderr.slice(-1200)}`);
    return value;
  });
}

let cdp;
try {
  const target = await retry(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
    if (!page) throw new Error(`Electron page target missing\n${stderr}`);
    return page;
  });
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await waitFor("window.__pixTest && window.__pixTest.state().loading === false && Boolean(document.querySelector('.shell'))", "the renderer shell");

  // Boot renders the chat panel collapsed even when the saved layout has it
  // open, so drive it by the rendered width rather than the stored flag.
  await retry(async () => {
    const width = await cdp.evaluate("document.querySelector('.chat')?.getBoundingClientRect().width ?? 0");
    if (width >= 300) return;
    await cdp.evaluate("window.__pixTest.toggle('chat')");
    throw new Error(`Waiting for the chat panel, currently ${Math.round(width)}px wide\n${stderr.slice(-1200)}`);
  });

  // The card belongs to the finished turn of the session we just wrote.
  await cdp.evaluate(`window.__pixTest.openSession(${JSON.stringify(snapshot.session.path)})`);
  await cdp.evaluate(`window.__pixTest.selectNode(${JSON.stringify(snapshot.projection.activeNodeId)})`);
  await waitFor("document.querySelectorAll('.file-changes li').length === 3", "the three file rows");
  await cdp.evaluate("document.querySelector('.toast')?.click()");

  const card = await retry(async () => {
    const value = await cdp.evaluate(`(() => {
      const card = document.querySelector('.file-changes');
      if (!card) return null;
      const rows = Array.from(card.querySelectorAll('li'));
      return { text: card.innerText, rows: rows.length,
        naturalWidth: Math.round(card.getBoundingClientRect().width),
        statuses: rows.map((row) => row.querySelector('.change-status').textContent.trim()),
        unreadable: document.body.innerText.includes('Git 不可用') };
    })()`);
    if (!value) throw new Error(`The file card is missing\n${stderr.slice(-1200)}`);
    return value;
  });
  assert.match(card.text, /3 个文件已更改/);
  assert.match(card.text, /\+9/);
  assert.match(card.text, /−1/);
  assert.equal(card.unreadable, false, "saved diffs must not depend on a Git repository");
  assert.deepEqual(card.statuses, ["A", "M", "A"], "README added, main.ts modified, settings.json added");
  await cdp.evaluate("document.querySelector('.file-changes')?.scrollIntoView({ block: 'center' })");
  await new Promise((resolve) => setTimeout(resolve, 250));
  await cdp.send("Page.captureScreenshot").then((shot) =>
    writeFileSync(join(artifacts, "file-changes-card.png"), Buffer.from(shot.data, "base64")));

  // View diff opens this turn's immutable patch, not the working tree.
  await cdp.evaluate(`Array.from(document.querySelectorAll('.file-changes li')).find((li) => li.innerText.includes('main.ts')).querySelector('button').click()`);
  const diff = await retry(async () => {
    const value = await cdp.evaluate(`(() => {
      const view = document.querySelector('.file-diff');
      if (!view || !view.querySelector('.added')) return null;
      return { added: view.innerText, tab: document.querySelector('.workspace-tabs .active')?.innerText ?? '' };
    })()`);
    if (!value) throw new Error(`The saved diff did not open\n${stderr.slice(-1200)}`);
    return value;
  });
  assert.match(diff.added, /\+const greeting = "你好，PiX";/);
  assert.match(diff.added, /-const greeting = "Hello";/);
  assert.match(diff.tab, /main\.ts/);
  await cdp.evaluate("document.querySelector('.file-diff')?.scrollIntoView({ block: 'center' })");
  await new Promise((resolve) => setTimeout(resolve, 250));
  await cdp.send("Page.captureScreenshot").then((shot) =>
    writeFileSync(join(artifacts, "file-changes-diff.png"), Buffer.from(shot.data, "base64")));

  // A narrow dock keeps the filename on one ellipsized line with its directory
  // and moves the actions to their own line, instead of wrapping every row into
  // name, directory, totals and buttons.
  const layout = await cdp.evaluate(`(() => {
    const card = document.querySelector('.file-changes');
    const read = () => {
      const rows = Array.from(card.querySelectorAll('li'));
      const row = rows[1], name = row.querySelector('.change-filename'), actions = row.querySelector('.change-actions');
      const buttons = Array.from(actions.querySelectorAll('button'));
      return { directory: getComputedStyle(name.querySelector('small')).display,
        rows: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
        height: Math.round(card.getBoundingClientRect().height),
        fits: card.scrollWidth <= card.clientWidth,
        ownLine: Math.round(buttons[0].getBoundingClientRect().top - row.getBoundingClientRect().top) > 20,
        rightAligned: Math.round(row.getBoundingClientRect().right - buttons[buttons.length - 1].getBoundingClientRect().right) < 20 };
    };
    const wide = (card.style.width = '340px', read());
    const narrow = (card.style.width = '260px', read());
    card.style.width = '';
    return { wide, narrow };
  })()`);
  assert.equal(layout.wide.directory, "block", "a wide row keeps the directory on its own line");
  assert.equal(layout.wide.ownLine, false, "a wide row keeps the actions beside the filename");
  assert.equal(layout.wide.fits, true, "the wide card must not overflow its panel");
  assert.equal(layout.narrow.directory, "inline", "a narrow row puts the directory beside the filename");
  assert.equal(layout.narrow.ownLine, true, "a narrow row gives the actions their own line");
  assert.equal(layout.narrow.rightAligned, true);
  assert.equal(layout.narrow.fits, true, "the narrow card must not overflow its panel");
  assert.equal(new Set(layout.narrow.rows).size, 1, "narrow rows keep one uniform height");
  assert.ok(layout.narrow.height < layout.wide.height + 60, "narrow rows must not grow per wrapped line");

  // Snapshots and the card survive a reload and a theme change.
  await cdp.evaluate("window.pix.invoke('settings.update', { scope: 'app', patch: { theme: 'dark' } })");
  await cdp.send("Page.reload");
  await waitFor("window.__pixTest && window.__pixTest.state().loading === false", "the reloaded renderer");
  await cdp.evaluate(`window.__pixTest.openSession(${JSON.stringify(snapshot.session.path)})`);
  await cdp.evaluate(`window.__pixTest.selectNode(${JSON.stringify(snapshot.projection.activeNodeId)})`);
  await waitFor("document.querySelectorAll('.file-changes li').length === 3", "the file rows after reload");
  await cdp.evaluate("document.querySelector('.toast')?.click()");
  await cdp.evaluate(`Array.from(document.querySelectorAll('.file-changes li')).find((li) => li.innerText.includes('main.ts')).querySelector('button').click()`);
  const dark = await retry(async () => {
    const value = await cdp.evaluate(`document.documentElement.dataset.theme === 'dark'
      ? document.querySelector('.file-diff .added')?.textContent : null`);
    if (!value) throw new Error(`The saved diff did not reopen in the dark theme\n${stderr.slice(-1200)}`);
    return value;
  });
  assert.match(dark, /你好/);
  await cdp.evaluate("document.querySelector('.file-changes')?.scrollIntoView({ block: 'center' })");
  await new Promise((resolve) => setTimeout(resolve, 250));
  await cdp.send("Page.captureScreenshot").then((shot) =>
    writeFileSync(join(artifacts, "file-changes-dark.png"), Buffer.from(shot.data, "base64")));

  console.log(JSON.stringify({ passed: true, statuses: card.statuses, naturalCardWidth: card.naturalWidth, tab: diff.tab, wide: layout.wide, narrow: layout.narrow }, null, 2));
} finally {
  await cdp?.close();
  if (child.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  if (child.exitCode === null)
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}
