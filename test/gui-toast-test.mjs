// Focused GUI check for the corner toast: dispatches extension commands from
// the chat composer so notices travel the full pipeline (extension notify →
// main-process broadcast → renderer event → toast), then verifies per-level
// auto-dismiss, the warning/error border colors, ARIA roles, click-to-dismiss,
// and that the output tab keeps extension output after the toast expires.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts");
const testHome = join(artifacts, "gui-home-toast");
const electron = process.env.ELECTRON_BINARY ?? electronBinary(root);
if (!existsSync(electron)) throw new Error("Electron binary not found");
mkdirSync(join(testHome, ".pix", "agent", "extensions"), { recursive: true });
writeFileSync(join(testHome, ".pix", "agent", "extensions", "toast-check.ts"), `
export default function(pi) {
  pi.registerCommand("toast-info", { description: "Info toast",
    handler: (_args, ctx) => ctx.ui.notify("Toast info line", "info") });
  pi.registerCommand("toast-warn", { description: "Warning toast",
    handler: (_args, ctx) => ctx.ui.notify("Toast warn line", "warning") });
  pi.registerCommand("toast-fail", { description: "Error toast",
    handler: () => { throw new Error("Toast failure line"); } });
}
`);
mkdirSync(join(testHome, ".pix"), { recursive: true });
writeFileSync(
  join(testHome, ".pix", "agent", "settings.json"),
  JSON.stringify({ defaultProjectTrust: "always" }),
);
writeFileSync(
  join(testHome, ".pix", "gui.settings.json"),
  JSON.stringify({ openLastSessionOnStartup: true }),
);

const port = 9900 + Math.floor(Math.random() * 90);
const args = [
  "--no-sandbox",
  "--disable-gpu",
  `--user-data-dir=${join(testHome, "electron")}`,
  `--remote-debugging-port=${port}`,
  root,
];
const child = spawn(electron, args, {
  cwd: root,
  env: { ...process.env, PIX_HOME: testHome, PIX_PROJECT: join(root, "test", "workspace") },
  windowsHide: true,
});
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
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
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

async function retry(fn, attempts = 100, delay = 150) {
  let error;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (thrown) {
      error = thrown;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw error;
}

// Snapshot of the toast plus the theme tokens it should derive colors from.
const toastProbe = `(() => {
  const toast = document.querySelector('.toast');
  if (!toast) return null;
  const token = getComputedStyle(document.documentElement).getPropertyValue('--warn');
  return { text: toast.textContent, cls: toast.className, role: toast.getAttribute('role'),
    border: getComputedStyle(toast).borderColor, warnToken: token.trim() };
})()`;
const hexToRgb = (hex) => {
  const m = hex.match(/^#(..)(..)(..)/);
  return `rgb(${[m[1], m[2], m[3]].map((v) => parseInt(v, 16)).join(", ")})`;
};

const results = {};
try {
  const target = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const page = (await response.json()).find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!page) throw new Error("Electron page target missing");
    return page;
  });
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  await retry(async () => {
    const ready = await cdp.evaluate(
      "window.__pixTest?.state().loading === false && Boolean(document.querySelector('.shell'))",
    );
    if (!ready) throw new Error(`PiX renderer is not ready\n${stderr}`);
  });
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.prompt-node.selected'))")))
      throw new Error("Restored session graph missing");
  });

  // Open the chat panel composer, exactly like the slash GUI check does.
  await cdp.evaluate(`window.__pixTest.state().layout.collapsed.chat ? window.__pixTest.toggle('chat') : undefined`);
  await cdp.evaluate(`document.querySelector('.branch-panel .composer-collapsed')?.click()`);
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.branch-panel textarea'))")))
      throw new Error("Chat composer did not open");
  });
  const chatType = (text) => cdp.evaluate(`(() => {
    const editor = document.querySelector('.branch-panel textarea');
    editor.value = ${JSON.stringify(text)};
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const chatEnter = () => cdp.evaluate(`document.querySelector('.branch-panel textarea')
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  const dismissToast = () => cdp.evaluate(`document.querySelector('.toast')?.click()`);
  const dispatch = async (name) => {
    // Type first: an empty draft disables the submit button, so readiness can
    // only be probed with text in place (disabled then means busy/not runnable).
    await chatType(`/${name} `);
    await retry(async () => {
      if (await cdp.evaluate("document.querySelector('.branch-panel .composer-submit')?.disabled"))
        throw new Error("composer not ready");
    });
    await dismissToast();
    await chatEnter();
  };
  const waitForToast = (fragment) => retry(async () => {
    const toast = await cdp.evaluate(toastProbe);
    if (!toast || !toast.text.includes(fragment)) throw new Error(`toast missing "${fragment}": ${JSON.stringify(toast)}`);
    return toast;
  });
  const waitForToastGone = () => retry(async () => {
    if (await cdp.evaluate("Boolean(document.querySelector('.toast'))")) throw new Error("toast still visible");
    return true;
  }, 80);
  const shot = (name) => cdp.send("Page.captureScreenshot", { format: "png" })
    .then((frame) => writeFileSync(join(artifacts, name), Buffer.from(frame.data, "base64")));

  // Create and activate the output tab: its content must come from the
  // workspace event log, never from the transient notice state.
  await chatType("/session ");
  await cdp.evaluate("document.querySelector('.branch-panel .composer-submit').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("window.__pixTest.state().contentSection === 'output'")))
      throw new Error("builtin /session did not open the output tab");
  });

  // info: shows as a polite status and expires on its own.
  await dispatch("toast-info");
  const info = await waitForToast("Toast info line");
  if (info.cls !== "toast info" || info.role !== "status")
    throw new Error(`info toast markup wrong: ${JSON.stringify(info)}`);
  await shot("gui-toast-info.png");
  results.infoAutoDismisses = await waitForToastGone();

  results.outputKeepsExtensionLogAfterToastExpires = await retry(async () => {
    const view = await cdp.evaluate(`(() => ({
      log: document.querySelector('.log-view')?.textContent ?? '',
      toast: Boolean(document.querySelector('.toast')),
      section: window.__pixTest.state().contentSection,
    }))()`);
    if (view.section !== "output" || !view.log.includes("Toast info line") || view.toast)
      throw new Error(`output tab lost the extension log: ${JSON.stringify(view)}`);
    return true;
  });

  // warning: same polite role but the amber border from --warn.
  await dispatch("toast-warn");
  const warning = await waitForToast("Toast warn line");
  if (warning.cls !== "toast warning" || warning.role !== "status" || warning.border !== hexToRgb(warning.warnToken))
    throw new Error(`warning toast markup/colors wrong: ${JSON.stringify(warning)}`);
  await shot("gui-toast-warning.png");
  results.warningAutoDismisses = await waitForToastGone();

  // error: assertive alert, danger border, and it stays until clicked.
  await dispatch("toast-fail");
  const error = await retry(async () => {
    const toast = await cdp.evaluate(toastProbe);
    if (!toast || !toast.text.includes("Toast failure line")) throw new Error(`toast missing failure: ${JSON.stringify(toast)}`);
    return toast;
  });
  const danger = await cdp.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--danger').trim()");
  if (error.cls !== "toast error" || error.role !== "alert" || error.border !== hexToRgb(danger))
    throw new Error(`error toast markup/colors wrong: ${JSON.stringify(error)}`);
  await shot("gui-toast-error.png");
  await new Promise((resolve) => setTimeout(resolve, 8000));
  if (!(await cdp.evaluate("Boolean(document.querySelector('.toast.error'))")))
    throw new Error("error toast did not persist");
  results.errorPersistsUntilClicked = true;
  await dismissToast();
  await waitForToastGone();
  results.errorClickDismisses = true;

  await cdp.close();
} finally {
  child.kill();
}
const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(JSON.stringify(results, null, 2));
if (failed.length || Object.keys(results).length < 5) {
  console.error(`\ntoast GUI test FAILED\n${stderr.slice(-2000)}`);
  process.exit(1);
}
console.log("\ntoast GUI test passed");
