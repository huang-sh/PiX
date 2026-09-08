// Focused GUI check for the composer slash menu: opens the graph draft node,
// types a pending "/query", and verifies listing, keyboard selection, dynamic
// prompt-template commands, and builtin dispatch against the real renderer.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts");
const testHome = join(artifacts, "gui-home-slash");
const electron = process.env.ELECTRON_BINARY ?? electronBinary(root);
if (!existsSync(electron)) throw new Error("Electron binary not found");
mkdirSync(join(testHome, ".pi", "agent", "prompts"), { recursive: true });
mkdirSync(join(testHome, ".pi", "agent", "extensions"), { recursive: true });
mkdirSync(join(testHome, ".pi", "agent", "skills", "slash-check"), { recursive: true });
writeFileSync(join(testHome, ".pi", "agent", "skills", "slash-check", "SKILL.md"),
  "---\nname: slash-check\ndescription: Slash GUI test skill\n---\nReply with a short greeting.\n");
writeFileSync(join(testHome, ".pi", "agent", "extensions", "slash-check.ts"), `
export default function(pi) {
  pi.registerCommand("slash-check", { description: "Test notification output",
    handler: (_args, ctx) => ctx.ui.notify("Slash command result\\nSecond line", "info") });
  pi.registerCommand("slash-failure", { description: "Test command error",
    handler: () => { throw new Error("Slash command failure"); } });
}
`);
mkdirSync(join(testHome, ".pix"), { recursive: true });
writeFileSync(
  join(testHome, ".pi", "agent", "settings.json"),
  JSON.stringify({ defaultProjectTrust: "always" }),
);
// A global prompt template: selecting it must insert "/review " for arguments
// and show its argument-hint in the menu.
writeFileSync(
  join(testHome, ".pi", "agent", "prompts", "review.md"),
  ['---', 'description: Review the changes', 'argument-hint: "<file>"', '---', '', 'Review $ARGUMENTS', ''].join("\n"),
);
writeFileSync(
  join(testHome, ".pix", "settings.json"),
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

  // Open the draft composer from the selected node, exactly like a user would.
  await cdp.evaluate("document.querySelector('.prompt-node.selected .node-add').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.draft-node textarea'))")))
      throw new Error("Draft composer did not open");
  });

  const type = async (text) => {
    await cdp.evaluate(`(() => {
      const editor = document.querySelector('.draft-node textarea');
      editor.value = ${JSON.stringify(text)};
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  };
  const key = (event) =>
    cdp.evaluate(`document.querySelector('.draft-node textarea').dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(event)}))`);

  // "/" opens the menu; agent commands arrive asynchronously, so retry until
  // the global prompt template shows up next to the builtins.
  await type("/");
  await retry(async () => {
    const value = await cdp.evaluate(`(() => ({
      menu: Boolean(document.querySelector('.slash-menu')),
      review: [...document.querySelectorAll('.slash-item')].some((item) => item.textContent.includes('/review')),
      hint: [...document.querySelectorAll('.slash-item .slash-hint')].some((item) => item.textContent.includes('<file>')),
      badge: [...document.querySelectorAll('.slash-item .slash-badge')].some((item) => item.textContent.trim() === 'prompt'),
      model: [...document.querySelectorAll('.slash-item')].some((item) => item.textContent.includes('/model')),
    }))()`);
    if (!value.menu || !value.review || !value.hint || !value.badge || !value.model)
      throw new Error(`Slash menu incomplete: ${JSON.stringify(value)}`);
    results.menuListsBuiltinsAndPrompts = true;
  });
  await cdp.evaluate("document.querySelector('.draft-node textarea').focus()");
  // The graph centers a newly opened draft with a 280 ms animation.
  await new Promise(resolve => setTimeout(resolve, 500));
  const menuShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(artifacts, "gui-slash-menu.png"), Buffer.from(menuShot.data, "base64"));

  // Move the live graph anchor without typing again: stale DOMRect snapshots
  // used to leave the menu offscreen after panning or resizing the workbench.
  const placeAnchor = (left, top) => cdp.evaluate(`(() => {
    const editor = document.querySelector('.draft-node textarea');
    const pane = editor.closest('.vue-flow__transformationpane');
    window.__slashPaneStyle ??= pane.getAttribute('style');
    const rect = editor.getBoundingClientRect();
    const matrix = new DOMMatrix(getComputedStyle(pane).transform);
    matrix.e += (${left}) - rect.left;
    matrix.f += (${top}) - rect.top;
    pane.style.transform = matrix.toString();
  })()`);
  const checkBounds = (side) => retry(async () => {
    const value = await cdp.evaluate(`(() => {
      const menu = document.querySelector('.slash-menu');
      const rect = menu.getBoundingClientRect();
      const anchor = document.querySelector('.draft-node textarea').getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: innerWidth, height: innerHeight, side: menu.dataset.side,
        follows: menu.dataset.side === 'top' ? Math.abs(rect.bottom + 6 - anchor.top) < 2
          : Math.abs(rect.top - 6 - anchor.bottom) < 2,
        focus: document.activeElement === document.querySelector('.draft-node textarea') };
    })()`);
    if (value.left < 7 || value.top < 7 || value.right > value.width - 7 || value.bottom > value.height - 7
      || !value.follows || !value.focus || (side && value.side !== side)) throw new Error(JSON.stringify(value));
    return true;
  });
  await placeAnchor('innerWidth - 90', 'innerHeight - 110');
  results.rightEdgeClamped = await checkBounds('top');
  await placeAnchor('20', '40');
  results.topEdgeFlipsAndFollowsPan = await checkBounds('bottom');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 360, deviceScaleFactor: 1, mobile: false });
  results.followsViewportResize = await checkBounds('bottom');
  await placeAnchor('innerWidth - 90', 'innerHeight - 110');
  results.smallViewportClamped = await checkBounds();
  await key({ key: 'ArrowUp', bubbles: true });
  results.lastOptionScrollsIntoView = await retry(async () => {
    const visible = await cdp.evaluate(`(() => {
      const item = document.querySelector('.slash-item:last-child');
      const rect = item.getBoundingClientRect();
      const scroll = document.querySelector('.slash-menu-scroll').getBoundingClientRect();
      return { selected: item.getAttribute('aria-selected'), top: rect.top, bottom: rect.bottom,
        scrollTop: scroll.top, scrollBottom: scroll.bottom };
    })()`);
    if (visible.selected !== 'true' || visible.top < visible.scrollTop - 1 || visible.bottom > visible.scrollBottom + 1)
      throw new Error('Last command is clipped: ' + JSON.stringify(visible));
    return true;
  });
  const boundaryShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(artifacts, 'gui-slash-boundary.png'), Buffer.from(boundaryShot.data, 'base64'));
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.evaluate(`document.querySelector('.vue-flow__transformationpane').setAttribute('style', window.__slashPaneStyle)`);

  // Escape closes, and typing reopens.
  await key({ key: "Escape", bubbles: true });
  results.escapeCloses = await retry(async () => {
    if (await cdp.evaluate("Boolean(document.querySelector('.slash-menu'))")) throw new Error("menu still open");
    return true;
  });

  // Selecting the prompt template inserts "/review " and parks the caret.
  await type("/review");
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.slash-menu'))"))) throw new Error("menu did not reopen");
  });
  await key({ key: "Enter", bubbles: true });
  results.dynamicCommandInsertsToken = await retry(async () => {
    const value = await cdp.evaluate(`(() => {
      const editor = document.querySelector('.draft-node textarea');
      return { value: editor.value, caret: editor.selectionStart, menu: Boolean(document.querySelector('.slash-menu')) };
    })()`);
    if (value.value !== "/review " || value.caret !== "/review ".length || value.menu) throw new Error(JSON.stringify(value));
    return true;
  });
  const insertShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(artifacts, "gui-slash-insert.png"), Buffer.from(insertShot.data, "base64"));

  // The chat panel uses the same composer, command catalog, and dispatch path.
  await cdp.evaluate(`window.__pixTest.state().layout.collapsed.chat ? window.__pixTest.toggle('chat') : undefined`);
  await cdp.evaluate(`document.querySelector('.branch-panel .composer-collapsed')?.click()`);
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.branch-panel textarea'))")))
      throw new Error("Chat composer did not open");
  });
  const chatType = text => cdp.evaluate(`(() => {
    const editor = document.querySelector('.branch-panel textarea');
    editor.value = ${JSON.stringify(text)};
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const chatEnter = () => cdp.evaluate(`document.querySelector('.branch-panel textarea')
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await chatType('/');
  await retry(async () => {
    const names = await cdp.evaluate(`Array.from(document.querySelectorAll('.slash-name')).map(e => e.textContent)`);
    if (names[1] !== '/model' || !names.includes('/compact') || !names.includes('/slash-check'))
      throw new Error('Bare slash is missing builtins or extensions: ' + JSON.stringify(names));
  });
  results.chatBareSlashIncludesBuiltins = true;
  for (const name of ['review', 'skill:slash-check', 'slash-check', 'model']) {
    await chatType('/' + name);
    await retry(async () => {
      if (!(await cdp.evaluate(`Array.from(document.querySelectorAll('.slash-name')).some(e => e.textContent === ${JSON.stringify('/' + name)})`)))
        throw new Error('Chat slash command missing: ' + name);
    });
  }
  results.chatListsAllCommandSources = true;
  for (const [name, output] of [['slash-check', 'Slash command result'], ['slash-failure', 'Slash command failure']]) {
    await chatType('/' + name + ' ');
    await chatEnter();
    await retry(async () => {
      if (!(await cdp.evaluate(`document.querySelector('.toast')?.textContent.includes(${JSON.stringify(output)})`)))
        throw new Error('Slash output missing: ' + name + ' ' + JSON.stringify(await cdp.evaluate(`({ toast: document.querySelector('.toast')?.textContent, text: document.querySelector('.branch-panel textarea')?.value, disabled: document.querySelector('.branch-panel .composer-submit')?.disabled, runs: window.__pixTest.state().current?.graph?.runs })`)));
    });
  }
  results.chatShowsExtensionResultsAndErrors = true;
  await chatType('/session ');
  await cdp.evaluate("document.querySelector('.branch-panel .composer-submit').click()");
  await retry(async () => {
    if (!(await cdp.evaluate("window.__pixTest.state().contentSection === 'output'")))
      throw new Error('Chat send button did not execute builtin /session');
  });
  results.chatSendDispatchesBuiltin = true;
  await chatType('/compact');
  await chatEnter();
  await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('[data-compact-dialog] input'))")))
      throw new Error('Compact did not open an in-app dialog');
  });
  await cdp.evaluate("document.querySelector('[data-compact-dialog] button[type=button]').click()");
  results.compactUsesAppDialog = true;

  // "/mod" filters to the model command; Enter dispatches it client-side to
  // the settings screen (fuzzysort ranks "model" ahead of "scoped-models").
  await type("/mod");
  await retry(async () => {
    const value = await cdp.evaluate(`(() => ({
      menu: Boolean(document.querySelector('.slash-menu')),
      modelFirst: document.querySelector('.slash-item')?.textContent.includes('/model'),
    }))()`);
    if (!value.menu || !value.modelFirst) throw new Error(JSON.stringify(value));
  });
  await key({ key: "Enter", bubbles: true });
  results.builtinDispatches = await retry(async () => {
    if (!(await cdp.evaluate("Boolean(document.querySelector('.settings-page'))"))) throw new Error("settings screen did not open");
    return true;
  });

  await cdp.close();
} finally {
  child.kill();
}
const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(JSON.stringify(results, null, 2));
if (failed.length || Object.keys(results).length < 4) {
  console.error(`\nslash GUI test FAILED\n${stderr.slice(-2000)}`);
  process.exit(1);
}
console.log("\nslash GUI test passed");
