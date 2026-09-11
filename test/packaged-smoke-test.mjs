// Smoke test for a packaged PiX build (release/win-unpacked/PiX.exe, the
// portable exe, or release/mac*/PiX.app on macOS). Drives the packaged app
// over the Chrome DevTools protocol like test/gui-test.mjs, so the asar
// layout, preload, IPC, and the node-pty native binary are all exercised in
// their packaged form.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const exe =
  process.env.PIX_PACKAGED_EXE ??
  (process.argv[2] ? join(root, process.argv[2]) : "");
const defaultTarget =
  process.platform === "darwin"
    ? join(root, "release", "mac", "PiX.app", "Contents", "MacOS", "PiX")
    : join(root, "release", "win-unpacked", "PiX.exe");
const target = exe || defaultTarget;
if (!existsSync(target))
  throw new Error(`Packaged PiX executable not found: ${target}`);
const resources = process.platform === "darwin"
  ? join(dirname(target), "..", "Resources") : join(dirname(target), "resources");
// A portable launcher extracts resources only after startup; run this direct
// SDK check for the unpacked executable, where the resources are addressable.
const bundledChecks = existsSync(join(resources, "app.asar"));
if (bundledChecks) {
  for (const name of ["fff", "web"]) {
    const result = spawnSync(target, [
      join(root, "test", `builtin-${name}-smoke-test.mjs`),
      join(resources, "pi-builtin", "node_modules"),
      join(resources, "app.asar", "node_modules"),
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8", timeout: 60_000, windowsHide: true,
    });
    if (result.status !== 0)
      throw new Error(`Packaged ${name} check failed: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    console.log(result.stdout.trim());
  }
}
const artifacts = join(root, "artifacts");
const testHome = join(artifacts, "packaged-home");
mkdirSync(join(testHome, ".pix", "agent"), { recursive: true });
writeFileSync(
  join(testHome, ".pix", "agent", "settings.json"),
  JSON.stringify({ defaultProjectTrust: "always" }),
);
writeFileSync(
  join(testHome, ".pix", "gui.settings.json"),
  JSON.stringify({
    openLastSessionOnStartup: true,
    layout: {
      version: 3,
      widths: { navigator: 248, chat: 356, content: 320 },
      collapsed: { navigator: false, chat: false, content: true },
      minimap: false,
      utility: { open: false, collapsed: false, height: 250, activeTab: "terminal" },
    },
  }),
);

const port = 9900 + Math.floor(Math.random() * 100);
const child = spawn(target, [
  "--no-sandbox",
  "--disable-gpu",
  `--user-data-dir=${join(testHome, "electron")}`,
  `--remote-debugging-port=${port}`,
], {
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    PIX_HOME: testHome,
    PIX_PROJECT: join(root, "test", "workspace"),
    PI_OFFLINE: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += String(chunk)));

async function retry(fn, timeout = 20_000) {
  const start = Date.now();
  let error;
  while (Date.now() - start < timeout) {
    if (child.exitCode !== null)
      throw new Error(`Packaged PiX exited early (${child.exitCode})\n${stderr}`);
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
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    return result.result?.value;
  }
  async close() {
    if (this.socket.readyState >= WebSocket.CLOSING) return;
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 500);
      this.socket.addEventListener(
        "close",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      this.socket.close();
    });
  }
}

let cdp;
try {
  const page = await retry(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`))
      .json();
    const found = targets.find(
      (item) => item.type === "page" && item.webSocketDebuggerUrl,
    );
    if (!found) throw new Error("Packaged PiX page target missing");
    return found;
  });
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await retry(async () => {
    const ready = await cdp.evaluate(
      "window.__pixTest?.state().loading === false && Boolean(document.querySelector('.shell'))",
    );
    if (!ready) throw new Error(`Renderer is not ready\n${stderr}`);
  });
  const session = await retry(async () => {
    const value = await cdp.evaluate(
      "({ sessions: window.__pixTest.state().sessions.length, current: Boolean(window.__pixTest.state().current) })",
    );
    if (!value.sessions || !value.current)
      throw new Error(`Fixture session did not open: ${JSON.stringify(value)}`);
    return value;
  });
  await retry(async () => {
    await cdp.evaluate("document.querySelector('[data-action=tool-panel]')?.click()");
    if (!(await cdp.evaluate("window.__pixTest.state().layout.collapsed.content === false")))
      throw new Error("Tool panel toggle is not ready yet");
  });
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('[data-tool-section=files]'))")))
      throw new Error("Tool home sections did not appear");
  });
  await cdp.evaluate("document.querySelector('[data-tool-section=files]').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.file-workspace .file-empty'))")))
      throw new Error("Files tool did not open");
  });
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('[data-action=add-tool-tab]'))")))
      throw new Error("Tool tab add button did not appear");
  });
  await retry(async () => {
    await cdp.evaluate("document.querySelector('[data-action=add-tool-tab]')?.click()");
    if (!(await cdp.evaluate("Boolean(document.querySelector('[data-tool-menu=terminal]'))")))
      throw new Error("Tool tab menu did not open");
  });
  await retry(async () => {
    await cdp.evaluate("document.querySelector('[data-tool-menu=terminal]')?.click()");
    if (!(await cdp.evaluate("Boolean(document.querySelector('.terminal-host .xterm-helper-textarea'))")))
      throw new Error(`node-pty terminal did not mount in the packaged app\n${stderr}`);
  });
  // Drive a PTY through the real IPC channel so the packaged node-pty
  // binary (ConPTY) is verified deterministically, independent of xterm
  // keyboard timing.
  const terminal = await cdp.evaluate(`(async () => {
    const chunks = [];
    const off = window.pix.onEvent((e) => {
      if (e?.type === "terminal" && typeof e.payload?.data === "string")
        chunks.push(e.payload.data);
    });
    try {
      const { id } = await window.pix.invoke("terminal.create", { cols: 80, rows: 24 });
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !chunks.length)
        await new Promise((resolve) => setTimeout(resolve, 200));
      await window.pix.invoke("terminal.write", { id, data: ${JSON.stringify(
        process.platform === "win32"
          ? "Write-Output pix-packaged-ok\\r"
          : "printf 'pix-packaged-ok\\\\n'\\n",
      )} });
      while (Date.now() < deadline && !chunks.join("").includes("pix-packaged-ok"))
        await new Promise((resolve) => setTimeout(resolve, 200));
      await window.pix.invoke("terminal.kill", { id }).catch(() => {});
      return { ok: chunks.join("").includes("pix-packaged-ok"), output: chunks.join("").slice(0, 400) };
    } finally {
      off();
    }
  })()`);
  if (!terminal.ok)
    throw new Error(
      `Packaged PTY did not execute input: ${JSON.stringify(terminal)}\n${stderr}`,
    );
  // Bundled skills in their packaged form (<resources>/skills): listed with
  // the read-only builtin badge, openable in the viewer, and toggleable via
  // the override table — all through the real IPC channel.
  const bundled = await retry(async () => {
    const meta = await cdp.evaluate(`(async () => {
      const skills = await window.pix.invoke("agent.control", { action: "getSkills" });
      const zotero = skills.find((skill) => skill.name === "zotero-cli");
      if (!zotero) throw new Error("bundled zotero-cli not listed");
      return { scope: zotero.scope, editable: zotero.editable, path: zotero.path };
    })()`);
    if (meta.scope !== "builtin" || meta.editable !== false || !/[\\/]skills[\\/]zotero-cli[\\/]SKILL\.md$/.test(meta.path))
      throw new Error(`bundled skill metadata wrong: ${JSON.stringify(meta)}`);
    return meta;
  });
  const viewed = await cdp.evaluate(`(async () => {
    const document = await window.pix.invoke("agent.control", { action: "getSkill", path: ${JSON.stringify(bundled.path)} });
    return { name: document.name, hasBody: /zotero-cli/.test(document.body) };
  })()`);
  if (viewed.name !== "zotero-cli" || !viewed.hasBody)
    throw new Error(`bundled skill not viewable: ${JSON.stringify(viewed)}`);
  const manualOnly = await cdp.evaluate(`(async () => {
    await window.pix.invoke("agent.control", { action: "setSkillManualOnly", path: ${JSON.stringify(bundled.path)}, manualOnly: true });
    const skills = await window.pix.invoke("agent.control", { action: "getSkills" });
    return skills.find((skill) => skill.name === "zotero-cli").disableModelInvocation;
  })()`);
  if (manualOnly !== true)
    throw new Error("bundled skill manual-only toggle did not take effect");
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    join(artifacts, "packaged-smoke.png"),
    Buffer.from(shot.data, "base64"),
  );
  const result = {
    exe: target,
    rendererReady: true,
    sessions: session.sessions,
    terminal: true,
    bundledSkills: true,
    fffind: bundledChecks,
    ffgrep: bundledChecks,
    webFetch: bundledChecks,
    passed: true,
  };
  writeFileSync(
    join(artifacts, "packaged-smoke.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await cdp?.close();
  if (process.platform === "win32" && child.pid)
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
    });
  else child.kill("SIGTERM");
  if (child.exitCode === null)
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}
