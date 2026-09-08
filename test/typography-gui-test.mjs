// Real Chromium CSS/layout checks. Run after npm run build; no user data or API calls.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "pix-typography-"));
const workspace = join(home, "workspace");
const artifacts = join(root, "artifacts");
for (const path of [artifacts, join(home, ".pi", "agent"), join(home, ".pix"), join(workspace, ".pi", "sessions")])
  mkdirSync(path, { recursive: true });
writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
writeFileSync(join(home, ".pix", "settings.json"), JSON.stringify({ language: "zh-CN", openLastSessionOnStartup: false }));
const text = "中文阅读应该清晰舒适，English text should feel natural. PiX 支持分支会话、文件编辑和工具调用。";
const sessionFile = join(workspace, ".pi", "sessions", "typography.jsonl");
const timestamp = new Date().toISOString();
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
writeFileSync(sessionFile, [
  { type: "session", version: 3, id: "823f88f0-fb22-42cb-abcd-dc983145b642", cwd: workspace, timestamp },
  { type: "message", id: "user0001", parentId: null, timestamp, message: { role: "user", content: text, timestamp: Date.now() } },
  { type: "message", id: "reply001", parentId: "user0001", timestamp, message: {
    role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-5.6", usage, stopReason: "stop", timestamp: Date.now(),
    content: [{ type: "text", text: `# 中文与 English\n\n${text}\n\n## 阅读与排版 Typography\n\n- 中英混排：${text}\n- 行内代码：\`const 中文 = 'Hello PiX'\`\n\n\`\`\`typescript\n// 中文注释 English comment\nconst greeting = '你好，PiX';\nconsole.log(greeting);\n\`\`\`` }],
  } },
].map(entry => JSON.stringify(entry)).join("\n") + "\n");
const port = 10000 + Math.floor(Math.random() * 1000);
const args = ["--no-sandbox", "--disable-gpu", `--user-data-dir=${join(home, "electron")}`, `--remote-debugging-port=${port}`, root];
const env = { ...process.env, PIX_HOME: home, PIX_PROJECT: workspace, PI_OFFLINE: "1", ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
const electron = process.env.ELECTRON_BINARY ?? electronBinary(root);
const xvfb = process.platform === "linux" && String(spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout).trim();
const child = xvfb ? spawn(xvfb, ["-a", electron, ...args], { cwd: root, env }) : spawn(electron, args, { cwd: root, env, windowsHide: true });
let stderr = "";
child.stderr.on("data", chunk => { stderr += String(chunk); });
let socket;
let id = 0;
const pending = new Map();
async function retry(fn) {
  const deadline = Date.now() + 30000;
  let error;
  do {
    if (child.exitCode !== null) throw new Error(`Electron exited: ${stderr}`);
    try { return await fn(); } catch (cause) { error = cause; }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw error;
}
function send(method, params = {}) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(requestId, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
try {
  const target = await retry(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find(item => item.type === "page" && item.webSocketDebuggerUrl);
    assert.ok(page); return page;
  });
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  await send("Page.enable");
  await retry(async () => assert.equal(await evaluate("window.__pixTest?.state().loading === false && Boolean(document.querySelector('.shell'))"), true));
  await evaluate(`window.__pixTest.openSession(${JSON.stringify(sessionFile)})`);
  await evaluate("window.__pixTest.state().layout.collapsed.chat ? window.__pixTest.toggle('chat') : undefined");
  await retry(async () => assert.equal(await evaluate("Boolean(document.querySelector('.final-response .paragraph-node') && document.querySelector('.final-response pre code'))"), true));
  await evaluate("document.querySelector('.composer-collapsed')?.click()");
  await retry(async () => assert.equal(await evaluate("Boolean(document.querySelector('.chat-composer textarea'))"), true));

  const report = [];
  for (const theme of ['light', 'dark', 'teal']) {
    await evaluate("window.__pixTest.settings()");
    await retry(async () => assert.equal(await evaluate("Boolean(document.querySelector('[data-settings-category=appearance]'))"), true));
    await evaluate("document.querySelector('[data-settings-category=appearance]').click()");
    await retry(async () => assert.equal(await evaluate("Boolean(document.querySelector('[data-setting-path=theme] select'))"), true));
    await evaluate(`(() => { const input = document.querySelector('[data-setting-path=theme] select'); input.value = ${JSON.stringify(theme)}; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await retry(async () => assert.equal(await evaluate(`document.documentElement.dataset.theme === ${JSON.stringify(theme)} && !document.querySelector('[data-setting-path=theme] select').disabled`), true));
    await evaluate("document.querySelector('.settings-page > aside > button').click()");
    await retry(async () => assert.equal(await evaluate("Boolean(document.querySelector('.chat-composer textarea'))"), true));
    for (const density of ["comfortable", "compact"]) {
      const measurements = await evaluate(`(() => {
        const root = document.documentElement;
        root.dataset.density = ${JSON.stringify(density)};
        const metrics = selector => {
          const element = document.querySelector(selector);
          if (!element) throw new Error('Missing ' + selector);
          const style = getComputedStyle(element);
          return { size: parseFloat(style.fontSize), line: parseFloat(style.lineHeight), family: style.fontFamily };
        };
        const result = {
          ui: metrics('html'), user: metrics('.branch-message.user > p'),
          reply: metrics('.final-response .paragraph-node'), input: metrics('.chat-composer textarea'),
          heading: metrics('.final-response h1'), code: metrics('.final-response pre code'),
          codeLabel: metrics('.final-response .code-header-title'),
          codeMenu: (() => {
            // The real ⋯ menu renders inside .markstream-vue (CodeBlockShell).
            const host = document.querySelector('.final-response .markstream-vue');
            const menu = document.createElement('div');
            menu.className = 'code-more-menu';
            const item = document.createElement('button');
            item.className = 'text-xs';
            menu.append(item); host.append(menu);
            const size = parseFloat(getComputedStyle(item).fontSize);
            menu.remove();
            return { size };
          })(),
          inline: metrics('.final-response .inline-code'), caption: metrics('.node-context-usage b'),
          graph: metrics('.turn-copy p'), navigation: metrics('.project-main strong'),
        };
        // Clone real rendered Markdown (including scoped style attributes), then
        // check the hover/process overrides and narrow layouts without touching Vue state.
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px';
        document.body.append(host);
        try {
          for (const variant of ['process-item', 'node-hover-card']) {
            host.className = variant;
            host.replaceChildren(document.querySelector('.final-response .agent-markdown').cloneNode(true));
            result[variant] = { size: parseFloat(getComputedStyle(host.querySelector('.paragraph-node')).fontSize) };
          }
          host.className = '';
          const editor = document.createElement('div');
          editor.className = 'code-editor';
          editor.innerHTML = '<pre>9999\\n10000</pre><textarea class="file-editor">中文注释 English comment\\nconst value = 1;</textarea>';
          host.replaceChildren(editor);
          result.gutter = { size: parseFloat(getComputedStyle(editor.firstChild).fontSize), line: getComputedStyle(editor.firstChild).lineHeight, width: editor.firstChild.getBoundingClientRect().width };
          result.editor = { size: parseFloat(getComputedStyle(editor.lastChild).fontSize), line: getComputedStyle(editor.lastChild).lineHeight, family: getComputedStyle(editor.lastChild).fontFamily };
          const sameRow = (parent, selectors) => {
            const boxes = selectors.map(selector => parent.querySelector(selector).getBoundingClientRect());
            const centers = boxes.map(box => box.top + box.height / 2);
            return boxes.every(box => box.width > 0 && box.height > 0)
              && Math.max(...centers) - Math.min(...centers) <= 1
              && boxes.every((box, index) => !index || box.left >= boxes[index - 1].right - 1);
          };
          const node = document.querySelector('.prompt-node').cloneNode(true);
          host.replaceChildren(node);
          node.querySelector('.node-context-usage b').textContent = '2%';
          node.querySelector('.node-context-usage em').textContent = '1M';
          node.querySelector('.node-thinking-value span').textContent = 'high';
          result.nodeRows = ['Zai / GLM-5.3', 'Anthropic / Claude Sonnet with a very long model name'].map(model => {
            node.querySelector('.node-model-value span').textContent = model;
            return { model, sameRow: sameRow(node, ['.node-context-usage', '.node-model-value', '.node-thinking-value']) };
          });
          result.narrow = [];
          for (const variant of ['chat-composer', 'draft-node']) {
            for (const width of [310, 320, 356, 360, 480]) {
              for (const working of ['', 'Pi is working…', 'Pi 正在处理…']) {
                host.style.width = width + 'px';
                const composer = document.createElement('div');
                composer.className = variant;
                composer.style.width = '100%';
                composer.append(document.querySelector('.chat-composer .prompt-composer').cloneNode(true));
                host.replaceChildren(composer);
                if (working) {
                  const status = document.createElement('span');
                  status.textContent = working;
                  composer.querySelector('.prompt-composer > footer').prepend(status);
                }
                composer.querySelector('.node-model-select > span').textContent = 'Anthropic / Claude Sonnet with a very long model name';
                composer.querySelector('.node-thinking-select > span').textContent = 'xhigh';
                const box = composer.getBoundingClientRect();
                result.narrow.push({ variant, width, working,
                  sameRow: sameRow(composer, ['.composer-attach', '.node-model-select', '.node-thinking-select', '.composer-submit']),
                  fits: [...composer.querySelectorAll('textarea, button')].every(el => { const r = el.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1; }) });
              }
            }
          }
        } finally { host.remove(); }
        return result;
      })()`);
      report.push({ theme, density, ...measurements });
      assert.equal(measurements.reply.size, 15, "assistant body");
      assert.equal(measurements.user.size, 15, "user body");
      assert.equal(measurements.input.size, 15, "composer");
      assert.equal(measurements.reply.line, 26.25, "body line height");
      assert.equal(measurements.reply.family, measurements.ui.family, "Markdown must share UI fonts");
      assert.equal(measurements.user.family, measurements.ui.family);
      assert.equal(measurements.input.family, measurements.ui.family);
      assert.equal(measurements.heading.size, 24, "Markdown heading override");
      assert.equal(measurements.code.size, 13, "code block");
      assert.ok(measurements.code.line >= 20, "code line spacing");
      assert.ok(measurements.inline.size >= 13, "inline code");
      assert.equal(measurements.codeLabel.size, 12, "code language label");
      assert.equal(measurements.codeMenu.size, 12, "code ⋯ menu items");
      assert.equal(measurements.code.family, measurements.editor.family, "code block font");
      assert.equal(measurements.inline.family, measurements.editor.family, "inline code font");
      assert.equal(measurements.caption.size, 12, "node caption");
      assert.equal(measurements.graph.family, measurements.ui.family, "graph font");
      assert.equal(measurements.navigation.family, measurements.ui.family, "navigation font");
      assert.equal(measurements['process-item'].size, 14);
      assert.equal(measurements['node-hover-card'].size, 14);
      assert.equal(measurements.gutter.size, measurements.editor.size);
      assert.equal(measurements.gutter.line, measurements.editor.line, "line numbers must align");
      assert.equal(measurements.editor.size, 13);
      assert.ok(measurements.gutter.width >= 52);
      assert.ok(measurements.nodeRows.every(item => item.sameRow), 'node context, model and thinking must share one row without overlap');
      assert.ok(measurements.narrow.every(item => item.sameRow), 'composer attachment, model, thinking and send must share one row without overlap');
      assert.ok(measurements.narrow.every(item => item.fits), "narrow composer controls must fit");
    }
    const screenshot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(artifacts, `typography-${theme}.png`), Buffer.from(screenshot.data, "base64"));
  }
  await send("DOM.enable"); await send("CSS.enable");
  const doc = await send("DOM.getDocument");
  const fonts = {};
  for (const selector of ['.final-response .paragraph-node', '.turn-copy p', '.chat-composer textarea', '.node-footer']) {
    const element = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    fonts[selector] = (await send("CSS.getPlatformFontsForNode", { nodeId: element.nodeId })).fonts;
  }
  writeFileSync(join(artifacts, "typography-checks.json"), JSON.stringify({ passed: true, report, fonts }, null, 2));
  console.log(JSON.stringify({ passed: true, combinations: report.length, fonts }, null, 2));
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) {
    const diagnostics = await evaluate("({ state: window.__pixTest?.state(), html: document.querySelector('.chat')?.outerHTML, text: document.body.innerText.slice(-4000) })").catch(() => null);
    writeFileSync(join(artifacts, 'typography-failure.json'), JSON.stringify(diagnostics, null, 2));
    const screenshot = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    if (screenshot) writeFileSync(join(artifacts, 'typography-failure.png'), Buffer.from(screenshot.data, 'base64'));
  }
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    await evaluate("setTimeout(() => window.pix.invoke('app.quit'), 50)").catch(() => {});
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
  }
  socket?.close();
  for (const request of pending.values()) request.reject(new Error("Test ended"));
  pending.clear();
  if (child.exitCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    if (process.platform === "win32") {
      const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
      if (killed.status !== 0) throw new Error(killed.error?.message || killed.stderr || 'Failed to stop test Electron');
    }
    else child.kill("SIGTERM");
    await exited;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
