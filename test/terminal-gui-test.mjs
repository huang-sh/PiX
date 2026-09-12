import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts");
const testHome = mkdtempSync(join(tmpdir(), "pix-terminal-gui-"));
const electron = process.env.ELECTRON_BINARY ?? electronBinary(root);

if (!existsSync(electron)) throw new Error("Electron binary not found");
mkdirSync(artifacts, { recursive: true });
mkdirSync(join(testHome, ".pix", "agent"), { recursive: true });
writeFileSync(
  join(testHome, ".pix", "agent", "settings.json"),
  JSON.stringify({ defaultProjectTrust: "always" }),
);

const port = 9900 + Math.floor(Math.random() * 90);
const args = [
  "--no-sandbox",
  "--disable-gpu",
  `--user-data-dir=${join(testHome, "electron")}`,
  `--remote-debugging-port=${port}`,
  root,
];
const env = {
  ...process.env,
  PIX_HOME: testHome,
  PIX_PROJECT: join(root, "test", "workspace"),
  PI_OFFLINE: "1",
  ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
};
const xvfb =
  process.platform === "linux"
    ? String(spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout).trim()
    : "";
const child = xvfb
  ? spawn(xvfb, ["-a", electron, ...args], { cwd: root, env })
  : spawn(electron, args, { cwd: root, env, windowsHide: true });

let stderr = "";
child.stderr.on("data", (chunk) => (stderr += String(chunk)));

async function retry(fn, timeout = 30_000) {
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
    this.socket.close();
  }
}

async function typeCommand(cdp, command) {
  await cdp.evaluate("document.querySelector('.terminal-host .xterm-helper-textarea').focus()");
  await cdp.send("Input.insertText", { text: command });
  for (const type of ["keyDown", "keyUp"])
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
}

let cdp;
try {
  const target = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    const page = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!page) throw new Error("Electron page target missing");
    return page;
  });
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  await retry(async () => {
    if (
      !(await cdp.evaluate(
        "window.__pixTest?.state().loading === false && Boolean(document.querySelector('.shell'))",
      ))
    )
      throw new Error("PiX renderer is not ready");
  });
  await cdp.evaluate(`(() => {
    window.__terminalGuiEvents = [];
    window.__terminalGuiUnsubscribe = window.pix.onEvent((event) => {
      if (event.type === 'terminal') window.__terminalGuiEvents.push(event.payload);
    });
  })()`);

  await cdp.evaluate("document.querySelector('[data-action=tool-panel]').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('[data-tool-section=terminal]'))")))
      throw new Error("Terminal tool is not available");
  });
  await cdp.evaluate("document.querySelector('[data-tool-section=terminal]').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.terminal-host .xterm-helper-textarea'))")))
      throw new Error("Interactive terminal did not mount");
  });
  await retry(async () => {
    if (
      !(await cdp.evaluate(
        "window.__terminalGuiEvents.some(event => Boolean(event.data?.trim()))",
      ))
    )
      throw new Error("Interactive shell is not ready");
  });

  const firstCommand =
    process.platform === "win32"
      ? "$global:PiXGuiState=('pix-terminal-' + 'persisted'); Write-Output ('pix-' + 'terminal-gui-output')"
      : "export PIX_GUI_STATE=pix-terminal-\"\"persisted; printf 'pix-%s\\n' 'terminal-gui-output'";
  await typeCommand(cdp, firstCommand);
  await retry(async () => {
    if (
      !(await cdp.evaluate(
        "window.__terminalGuiEvents.map(event => event.data || '').join('').includes('pix-terminal-gui-output')",
      ))
    )
      throw new Error("Terminal command output did not appear");
  });

  await cdp.evaluate("document.querySelector('[data-action=add-tool-tab]').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('[data-tool-menu=files]'))")))
      throw new Error("Tool menu did not open");
  });
  await cdp.evaluate("document.querySelector('[data-tool-menu=files]').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("window.__pixTest.state().contentSection === 'files'")))
      throw new Error("Files tool did not open");
  });
  await cdp.evaluate("document.querySelector('[data-tool-tab=terminal] .tool-tab-main').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("window.__pixTest.state().contentSection === 'terminal'")))
      throw new Error("Terminal tab did not reopen");
  });

  await typeCommand(
    cdp,
    process.platform === "win32"
      ? "Write-Output $global:PiXGuiState"
      : "printf '%s\\n' \"$PIX_GUI_STATE\"",
  );
  await retry(async () => {
    if (
      !(await cdp.evaluate(
        "window.__terminalGuiEvents.map(event => event.data || '').join('').includes('pix-terminal-persisted')",
      ))
    )
      throw new Error("Terminal session did not persist across tool switching");
  });

  const result = await cdp.evaluate(`(() => {
    const host = document.querySelector('.terminal-host');
    const rows = host.querySelector('.xterm-rows');
    const rect = host.getBoundingClientRect();
    const output = window.__terminalGuiEvents.map(event => event.data || '').join('');
    return {
      passed: true,
      activeTool: window.__pixTest.state().contentSection,
      terminalMounted: Boolean(host.querySelector('.xterm-helper-textarea')),
      commandOutput: output.includes('pix-terminal-gui-output'),
      sessionPersisted: output.includes('pix-terminal-persisted'),
      viewport: { width: Math.round(rect.width), height: Math.round(rect.height) },
      renderedRows: rows.children.length
    };
  })()`);
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    join(artifacts, "gui-terminal.png"),
    Buffer.from(screenshot.data, "base64"),
  );
  writeFileSync(
    join(artifacts, "gui-terminal.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (cdp) {
    const diagnostic = await cdp
      .evaluate(`({
        tool: window.__pixTest?.state().contentSection,
        terminalText: document.querySelector('.terminal-host .xterm-rows')?.textContent,
        terminalEvents: window.__terminalGuiEvents,
        terminalMounted: Boolean(document.querySelector('.terminal-host .xterm-helper-textarea'))
      })`)
      .catch(() => undefined);
    if (diagnostic) console.error(JSON.stringify(diagnostic, null, 2));
    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" }).catch(() => undefined);
    if (screenshot)
      writeFileSync(
        join(artifacts, "gui-terminal-failure.png"),
        Buffer.from(screenshot.data, "base64"),
      );
  }
  throw error;
} finally {
  await cdp?.close();
  if (process.platform === "win32" && child.pid)
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  else child.kill("SIGTERM");
  if (child.exitCode === null)
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  try {
    rmSync(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {}
}
