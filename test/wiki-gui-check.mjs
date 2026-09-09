// Targeted GUI check: the session wiki region renders in the branch panel,
// reports coverage from a real manifest, and its actions invoke wiki routes.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts");
const testHome = join(artifacts, "wiki-gui-home");
const electron = process.env.ELECTRON_BINARY ?? electronBinary(root);
if (!existsSync(electron)) throw new Error("Electron binary not found");
mkdirSync(testHome, { recursive: true });
mkdirSync(join(testHome, ".pi", "agent"), { recursive: true });
mkdirSync(join(testHome, ".pix"), { recursive: true });
writeFileSync(join(testHome, ".pi", "agent", "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
writeFileSync(join(testHome, ".pix", "settings.json"), JSON.stringify({
  openLastSessionOnStartup: true,
  layout: {
    widths: { navigator: 248, chat: 356, content: 320 },
    collapsed: { navigator: false, chat: false, content: true },
    minimap: false,
    utility: { open: false, collapsed: false, height: 250, activeTab: "terminal" },
  },
}));

const port = 9700 + Math.floor(Math.random() * 200);
const child = spawn(electron, [
  "--no-sandbox", "--disable-gpu",
  `--user-data-dir=${join(testHome, "electron")}`,
  `--remote-debugging-port=${port}`,
  root,
], {
  cwd: root,
  env: {
    ...process.env,
    PIX_HOME: testHome,
    PIX_PROJECT: join(root, "test", "workspace"),
    PI_OFFLINE: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
  windowsHide: true,
});
let stderr = "";
child.stderr.on("data", chunk => { stderr += String(chunk); });

async function retry(fn, timeout = 25_000) {
  const start = Date.now();
  let error;
  while (Date.now() - start < timeout) {
    if (child.exitCode !== null) throw new Error(`Electron exited early (${child.exitCode})\n${stderr}`);
    try { return await fn(); } catch (cause) { error = cause; await new Promise(r => setTimeout(r, 150)); }
  }
  throw error;
}

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
  close() { try { this.socket.close(); } catch {} }
}

let cdp;
try {
  const target = await retry(async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
    const page = list.find(entry => entry.type === "page" && /index\.html/.test(entry.url));
    if (!page) throw new Error("renderer page not ready");
    return page;
  });
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();

  // Boot with the last session auto-opened (offline, no model calls).
  await retry(async () => {
    const ready = await cdp.evaluate(`(() => {
      const state = window.__pixTest?.state?.();
      return Boolean(state && state.current && state.current.session);
    })()`);
    if (!ready) throw new Error("session not open yet");
  });

  // The "opened" persistence hook refreshes the wiki deterministically and
  // pushes a status event; the panel must render the region with real data.
  const region = await retry(async () => {
    const value = await cdp.evaluate(`(() => {
      const region = document.querySelector('.wiki-region');
      if (!region) return null;
      region.open = true;
      const state = window.__pixTest.state();
      return {
        coverage: region.querySelector('.wiki-coverage')?.textContent ?? "",
        facts: [...region.querySelectorAll('.wiki-facts dt')].map(dt => dt.textContent),
        modelOptions: region.querySelectorAll('.wiki-model option').length,
        actions: [...region.querySelectorAll('.wiki-actions button, .wiki-actions label')].map(b => b.textContent.trim()),
        branchRows: state.wiki ? state.wiki.branches.map(b => \`\${b.branchId.slice(0, 8)}:\${b.status}:\${b.coveredTurns}/\${b.totalTurns}\`) : null,
        available: state.wiki?.available,
        enabled: state.wiki?.enabled,
      };
    })()`);
    if (!value) throw new Error("wiki region not rendered");
    return value;
  });

  if (!region.available) throw new Error(`wiki status unavailable: ${JSON.stringify(region)}`);
  if (!region.coverage.trim()) throw new Error(`no coverage text: ${JSON.stringify(region)}`);
  if (!region.actions.some(a => /自动更新|Auto-update/.test(a))) throw new Error(`auto toggle missing: ${JSON.stringify(region.actions)}`);
  if (!region.actions.some(a => /立即更新|Update now/.test(a))) throw new Error(`update button missing: ${JSON.stringify(region.actions)}`);
  if (!region.branchRows.length) throw new Error(`no branch rows after deterministic refresh: ${JSON.stringify(region)}`);

  // The refresh action must round-trip through the wiki.control route.
  const refreshOk = await retry(async () => {
    const state = await cdp.evaluate(`window.__pixTest.state()`);
    const before = state.wiki?.updatedAt;
    await cdp.evaluate(`[...document.querySelectorAll('.wiki-actions button')].find(b => /刷新|Refresh/.test(b.textContent))?.click()`);
    await new Promise(r => setTimeout(r, 400));
    const after = (await cdp.evaluate(`window.__pixTest.state()`)).wiki?.updatedAt;
    if (!after || after === before) throw new Error("refresh did not update wiki status");
    return true;
  });

  console.log(JSON.stringify({ region, refreshOk }, null, 2));
  console.log("Wiki GUI check passed");
} finally {
  cdp?.close();
  child.kill();
}
