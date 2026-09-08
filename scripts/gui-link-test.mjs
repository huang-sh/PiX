// GUI verification for the openLinksInApp feature: a real (CDP-trusted) click
// on a chat markdown link must open the URL in the built-in Browser tool
// instead of the OS browser. Runs against an isolated throwaway project so it
// never disturbs the shared test-workspace fixtures (session lists sort by
// file mtime, so dropping a session there would hijack gui-test.mjs).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts");
const testHome = join(artifacts, "gui-link-home");
const project = join(artifacts, "gui-link-project");
const linkUrl = "https://pi.dev/docs";
const electron = process.env.ELECTRON_BINARY ?? electronBinary(root);
if (!existsSync(electron)) throw new Error("Electron binary not found");

// A lingering instance can still hold the profile dir on Windows; failing to
// clear it is not fatal — the run then surfaces a clear early-exit instead.
for (const dir of [testHome, project]) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    console.warn(`could not clear ${dir} (in use?); continuing`);
  }
}
mkdirSync(join(testHome, ".pi", "agent"), { recursive: true });
mkdirSync(join(testHome, ".pix"), { recursive: true });
mkdirSync(join(project, ".pi", "sessions"), { recursive: true });
writeFileSync(join(project, "README.md"), "# gui-link-project\n\nFixture project for the chat-link GUI test.\n");
writeFileSync(
  join(project, "NOTES.md"),
  "# Notes\n\nFixture file for the absolute-path chat-link GUI test.\n",
);
// Forward slashes on purpose: chat models emit absolute paths this way, and
// the drive-letter form must survive into the rendered href untouched.
const notesHref = join(project, "NOTES.md").replaceAll("\\", "/");
writeFileSync(
  join(testHome, ".pi", "agent", "settings.json"),
  JSON.stringify({ defaultProjectTrust: "always" }),
);
writeFileSync(join(testHome, ".pix", "settings.json"), JSON.stringify({ language: "en" }));

const epoch = Date.parse("2026-08-30T10:00:00.000Z");
const sessionFile = join(
  project,
  ".pi",
  "sessions",
  "2026-08-30T10-00-00-000Z_00000000-0000-4000-8000-0000000000a1.jsonl",
);
writeFileSync(
  sessionFile,
  [
    {
      type: "session",
      version: 3,
      id: "00000000-0000-4000-8000-0000000000a1",
      timestamp: "2026-08-30T10:00:00.000Z",
      cwd: project,
    },
    {
      type: "message",
      message: {
        role: "user",
        content: "Where do the docs live?",
        timestamp: epoch + 1000,
      },
      id: "00000000",
      parentId: null,
      timestamp: "2026-08-30T10:00:01.000Z",
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `The full guide lives at [pi.dev/docs](${linkUrl}) — open it for the API reference.`,
          },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.6",
        usage: {
          input: 100,
          output: 40,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 140,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: epoch + 2000,
      },
      id: "00000001",
      parentId: "00000000",
      timestamp: "2026-08-30T10:00:02.000Z",
    },
    {
      type: "message",
      message: {
        role: "user",
        content: "Open the local readme.",
        timestamp: epoch + 3000,
      },
      id: "00000002",
      parentId: "00000001",
      timestamp: "2026-08-30T10:00:03.000Z",
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "The project entry point is [README.md](README.md) in the workspace root.",
          },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.6",
        usage: {
          input: 90,
          output: 30,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: epoch + 4000,
      },
      id: "00000003",
      parentId: "00000002",
      timestamp: "2026-08-30T10:00:04.000Z",
    },
    {
      type: "message",
      message: {
        role: "user",
        content: "Open the notes via their absolute path.",
        timestamp: epoch + 5000,
      },
      id: "00000004",
      parentId: "00000003",
      timestamp: "2026-08-30T10:00:05.000Z",
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `The notes live at [NOTES.md](${notesHref}) on disk.`,
          },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.6",
        usage: {
          input: 90,
          output: 30,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120,
        },
        stopReason: "stop",
        timestamp: epoch + 6000,
      },
      id: "00000005",
      parentId: "00000004",
      timestamp: "2026-08-30T10:00:06.000Z",
    },
  ]
    .map((entry) => JSON.stringify(entry) + "\n")
    .join(""),
);

const port = 9900 + Math.floor(Math.random() * 100);
const args = [
  "--no-sandbox",
  "--disable-gpu",
  `--user-data-dir=${join(testHome, "electron")}`,
  `--remote-debugging-port=${port}`,
  root,
];
const child = spawn(electron, args, {
  cwd: root,
  env: {
    ...process.env,
    PIX_HOME: testHome,
    PIX_PROJECT: project,
    PI_OFFLINE: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
  windowsHide: true,
});

let stderr = "";
child.stderr.on("data", (chunk) => (stderr += String(chunk)));

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
const result = {};
try {
  const target = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    const page = targets.find(
      (item) => item.type === "page" && item.webSocketDebuggerUrl,
    );
    if (!page) throw new Error("Electron page target missing");
    return page;
  });
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await retry(async () => {
    const ready = await cdp.evaluate(
      "window.__pixTest?.state().loading === false && Boolean(document.querySelector('.shell'))",
    );
    if (!ready) throw new Error(`PiX renderer is not ready\n${stderr}`);
  });

  await cdp.evaluate(
    `window.__pixTest.openSession(${JSON.stringify(sessionFile)})`,
  );
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.prompt-node'))")))
      throw new Error("Fixture session graph did not render");
  });

  // Double-click the turn, as gui-test does, to open the chat context.
  await cdp.evaluate(
    "document.querySelector('.prompt-node').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))",
  );
  await retry(async () => {
    if (!(await cdp.evaluate("!window.__pixTest.state().layout.collapsed.chat")))
      throw new Error("Chat did not open");
  });
  // Panel transitions keep moving the link for a few hundred ms after the
  // state flips; let the layout settle before hit-testing coordinates.
  await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 500))");
  // Probe records what the trusted click actually hits and whether the
  // handler cancelled the default action. Bubble phase on document runs after
  // the container's handler, so defaultPrevented reflects our interception.
  await cdp.evaluate(`(() => {
    window.__linkProbe = [];
    document.addEventListener("click", (event) => {
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      window.__linkProbe.push({
        tag: event.target.tagName,
        href: anchor?.getAttribute("href"),
        prevented: event.defaultPrevented,
        trusted: event.isTrusted,
      });
    });
  })()`);
  const link = await retry(async () => {
    const value = await cdp.evaluate(`(() => {
      const a = document.querySelector('.chat .agent-markdown a[href="${linkUrl}"]');
      if (!a) return { missing: true };
      a.scrollIntoView({ block: "center" });
      const r = a.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x, y,
        text: a.textContent.trim(),
        hitLink: Boolean(hit && (hit === a || a.contains(hit))),
        hitTag: hit?.tagName,
        hitClass: String(hit?.className ?? "").slice(0, 80),
      };
    })()`);
    if (value.missing)
      throw new Error("Chat link did not render");
    if (!value.hitLink)
      throw new Error(
        `Click coordinates miss the link (covered by <${value.hitTag} class="${value.hitClass}">)`,
      );
    return value;
  });
  result.chatLinkRendered = link.text;

  // Trusted OS-level click through CDP input: exercises the real event path
  // (hit-testing, modifiers, default action) rather than a synthetic .click().
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: link.x,
    y: link.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: link.x,
    y: link.y,
    button: "left",
    clickCount: 1,
  });

  await retry(async () => {
    const value = await cdp.evaluate(`({
      section: window.__pixTest.state().contentSection,
      tabs: window.__pixTest.state().contentTabs,
      contentOpen: !window.__pixTest.state().layout.collapsed.content,
      webviewSrc: document.querySelector('webview.browser-frame')?.getAttribute('src'),
      browserTabActive: document.querySelector('[data-tool-tab=browser]')?.classList.contains('active'),
      probe: window.__linkProbe
    })`);
    if (
      value.section !== "browser" ||
      !value.tabs.includes("browser") ||
      !value.contentOpen ||
      value.webviewSrc !== linkUrl ||
      !value.browserTabActive
    )
      throw new Error(
        `Chat link did not open in the built-in browser: ${JSON.stringify(value)}`,
      );
    return value;
  });
  result.linkOpenedInApp = true;
  result.probe = await cdp.evaluate("window.__linkProbe");

  // Second turn: a relative link must open the project file in the Files tool.
  await cdp.evaluate(
    "document.querySelectorAll('.prompt-node')[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))",
  );
  await retry(async () => {
    if (!(await cdp.evaluate(
      `Boolean(document.querySelector('.chat .agent-markdown a[href="README.md"]'))`,
    )))
      throw new Error("Second turn did not expose the relative file link");
  });
  await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 500))");
  const fileLink = await retry(async () => {
    const value = await cdp.evaluate(`(() => {
      const a = document.querySelector('.chat .agent-markdown a[href="README.md"]');
      if (!a) return { missing: true };
      a.scrollIntoView({ block: "center" });
      const r = a.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hitLink: Boolean(hit && (hit === a || a.contains(hit))), hitTag: hit?.tagName };
    })()`);
    if (value.missing) throw new Error("File link vanished from the chat");
    if (!value.hitLink)
      throw new Error(`Click coordinates miss the file link (covered by <${value.hitTag}>)`);
    return value;
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: fileLink.x,
    y: fileLink.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: fileLink.x,
    y: fileLink.y,
    button: "left",
    clickCount: 1,
  });
  await retry(async () => {
    const value = await cdp.evaluate(`({
      section: window.__pixTest.state().contentSection,
      fileTab: Boolean(document.querySelector('[data-file-tab="README.md"]')),
      fileTabActive: document.querySelector('[data-file-tab="README.md"]')?.classList.contains('active'),
      editor: Boolean(document.querySelector('.code-editor')),
      editorText: document.querySelector('.code-editor')?.textContent?.slice(0, 60)
    })`);
    if (value.section !== "files" || !value.fileTab || !value.fileTabActive || !value.editor)
      throw new Error(
        `Relative link did not open the file in the Files tool: ${JSON.stringify(value)}`,
      );
    return value;
  });
  result.fileOpenedInTool = true;
  result.editorText = await cdp.evaluate(
    "document.querySelector('.code-editor')?.textContent?.slice(0, 60)",
  );
  result.probe = await cdp.evaluate("window.__linkProbe");

  // Third turn: an absolute-path link (drive letter on Windows, POSIX on
  // macOS) to an in-project file must open in the Files tool the same way.
  // Vue Flow only mounts on-screen nodes, so the third card may have no DOM
  // element to double-click; focus it through the store instead — the chat
  // panel is already open and follows the focused node.
  await cdp.evaluate('window.__pixTest.selectNode("turn:00000004")');
  await retry(async () => {
    if (!(await cdp.evaluate(
      `Boolean(document.querySelector('.chat .agent-markdown a[href=${JSON.stringify(notesHref)}]'))`,
    )))
      throw new Error("Third turn did not expose the absolute-path file link");
  });
  await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 500))");
  const absoluteLink = await retry(async () => {
    const value = await cdp.evaluate(`(() => {
      const a = document.querySelector('.chat .agent-markdown a[href=${JSON.stringify(notesHref)}]');
      if (!a) return { missing: true };
      a.scrollIntoView({ block: "center" });
      const r = a.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hitLink: Boolean(hit && (hit === a || a.contains(hit))), hitTag: hit?.tagName };
    })()`);
    if (value.missing) throw new Error("Absolute-path link vanished from the chat");
    if (!value.hitLink)
      throw new Error(`Click coordinates miss the absolute-path link (covered by <${value.hitTag}>)`);
    return value;
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: absoluteLink.x,
    y: absoluteLink.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: absoluteLink.x,
    y: absoluteLink.y,
    button: "left",
    clickCount: 1,
  });
  await retry(async () => {
    const value = await cdp.evaluate(`({
      section: window.__pixTest.state().contentSection,
      fileTab: Boolean(document.querySelector('[data-file-tab="NOTES.md"]')),
      fileTabActive: document.querySelector('[data-file-tab="NOTES.md"]')?.classList.contains('active'),
      editor: Boolean(document.querySelector('.code-editor'))
    })`);
    if (value.section !== "files" || !value.fileTab || !value.fileTabActive || !value.editor)
      throw new Error(
        `Absolute-path link did not open the file in the Files tool: ${JSON.stringify(value)}`,
      );
    return value;
  });
  result.absolutePathOpenedInTool = true;
  const absoluteShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    join(artifacts, "gui-link-absolute-path.png"),
    Buffer.from(absoluteShot.data, "base64"),
  );
  await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 300))");
  const filesShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    join(artifacts, "gui-link-files.png"),
    Buffer.from(filesShot.data, "base64"),
  );

  await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 400))");
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    join(artifacts, "gui-link-browser.png"),
    Buffer.from(shot.data, "base64"),
  );

  // The settings toggle must exist, be reachable, and default to on.
  await cdp.evaluate("window.__pixTest.settings()");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.settings-page .settings-card'))")))
      throw new Error("Settings page is blank");
  });
  await cdp.evaluate("document.querySelector('[data-settings-category=general]').click()");
  await retry(async () => {
    const value = await cdp.evaluate(`(() => {
      const row = document.querySelector('[data-setting-path=openLinksInApp]');
      const input = row?.querySelector('input.switch');
      return { row: Boolean(row), checked: input?.checked, label: row?.querySelector("strong")?.textContent.trim() };
    })()`);
    if (!value.row || value.checked !== true)
      throw new Error(`openLinksInApp toggle missing or off: ${JSON.stringify(value)}`);
    return value;
  });
  result.settingsToggle = true;

  result.passed = true;
  writeFileSync(
    join(artifacts, "gui-link.json"),
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
