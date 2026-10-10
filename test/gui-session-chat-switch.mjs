// Run after `npm run build`: verify a same-project session switch cannot
// rehydrate the workspace (which would collapse an open chat panel).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = process.cwd();
mkdirSync(join(root, "artifacts"), { recursive: true });
const home = mkdtempSync(join(root, "artifacts", "chat-switch-"));
const project = join(home, "project");
mkdirSync(join(project, ".pi"), { recursive: true });
mkdirSync(join(home, ".pix"), { recursive: true });
cpSync(join(root, "test", "workspace", ".pi", "sessions"), join(project, ".pi", "sessions"), { recursive: true });
writeFileSync(join(home, ".pix", "gui.settings.json"), JSON.stringify({ openLastSessionOnStartup: true, closeToTray: false }));
const port = 11000 + Math.floor(Math.random() * 1000);
const child = spawn(electronBinary(root), ["--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${join(home, "electron")}`, root], {
  cwd: root,
  windowsHide: true,
  env: { ...process.env, ELECTRON_RENDERER_URL: "", PIX_HOME: home, PIX_PROJECT: project, PI_OFFLINE: "1", ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", data => (stderr += String(data)));
let socket;
let sequence = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
  return value.result.value;
}
async function until(expression) {
  const deadline = Date.now() + 20000;
  while (!await evaluate(expression)) {
    if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`Timed out: ${expression}\n${stderr.slice(-1500)}`);
    await sleep(60);
  }
}
async function click(selector) {
  const point = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}
try {
  const deadline = Date.now() + 30000;
  let page;
  while (!page && Date.now() < deadline) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(value => value.type === "page"); }
    catch { await sleep(100); }
  }
  assert.ok(page, `Electron page did not open: ${stderr}`);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => socket.once("open", resolve));
  socket.on("message", data => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  await until(`window.__pixTest && !__pixTest.state().loading && __pixTest.state().current`);
  await click('[data-action="chat-panel"]');
  await until(`!__pixTest.state().layout.collapsed.chat`);
  await click('[data-action="navigator-panel"]');
  await until(`document.querySelector('.project-main')`);
  if (await evaluate(`document.querySelector('.project-main').getAttribute('aria-expanded') === 'false'`)) await evaluate(`document.querySelector('.project-main').click()`);
  await until(`document.querySelectorAll('.session-item').length >= 2`);
  const firstPath = await evaluate(`__pixTest.state().current.session.path`);
  assert.ok(await evaluate(`Boolean(document.querySelector('.session-item:not(.active)'))`));
  await evaluate(`document.querySelector('.session-item:not(.active)').click()`);
  await until(`__pixTest.state().current.session.path !== ${JSON.stringify(firstPath)} && !__pixTest.state().loading`);
  assert.equal(await evaluate(`__pixTest.state().layout.collapsed.chat`), false, "normal switch must keep chat expanded");
  // Start a real session.open through the navigator, wait one microtask for its
  // loading state, then click the other row before that open has completed.
  const overlap = await evaluate(`(async () => {
    document.querySelector('.session-item:not(.active)').click();
    await Promise.resolve();
    const loading = __pixTest.state().loading;
    document.querySelector('.session-item.active').click();
    return loading;
  })()`);
  assert.equal(overlap, true, "first navigator click must really be opening a session");
  await until(`__pixTest.state().current.session.path !== ${JSON.stringify(firstPath)} && !__pixTest.state().loading`);
  assert.equal(await evaluate(`__pixTest.state().layout.collapsed.chat`), false, "overlapping real opens must keep chat expanded");
  // Renaming another session in the same project must not cancel a pending
  // session.open only in the renderer: the main process would still select it.
  const concurrent = await evaluate(`(async () => {
    const currentPath = __pixTest.state().current.session.path;
    document.querySelector('.session-item:not(.active)').click();
    await Promise.resolve();
    const opening = __pixTest.state().loading;
    const renaming = __pixTest.renameSession(currentPath);
    const duringRename = __pixTest.state().loading;
    await renaming;
    return { currentPath, opening, duringRename };
  })()`);
  assert.equal(concurrent.opening, true, "the session open must be in flight when renaming starts");
  assert.equal(concurrent.duringRename, true, "renaming must not cancel the open in just one process");
  await until(`document.querySelector('[data-rename-dialog]')`);
  await until(`__pixTest.state().current.session.path !== ${JSON.stringify(concurrent.currentPath)} && !__pixTest.state().loading`);
  const visiblePath = await evaluate(`__pixTest.state().current.session.path`);
  const backendPath = await evaluate(`(async () => (await window.pix.invoke('session.snapshot')).session.path)()`);
  assert.equal(backendPath, visiblePath, "renderer and main process must select the same session after renaming");
  await evaluate(`document.querySelector('[data-action="rename-cancel"]').click()`);
  assert.equal(await evaluate(`__pixTest.state().layout.collapsed.chat`), false, "renaming during an open must keep chat expanded");

  // Creating a new session does supersede the old open, in both processes.
  const priorPaths = await evaluate(`__pixTest.state().sessions.map(item => item.path)`);
  const creating = await evaluate(`(async () => {
    document.querySelector('.session-item:not(.active)').click();
    await Promise.resolve();
    const opening = __pixTest.state().loading;
    document.querySelector('[data-action="create-project-session"]').click();
    return opening;
  })()`);
  assert.equal(creating, true, "creation must overlap a real session open");
  await until(`!__pixTest.state().loading && __pixTest.state().current && !${JSON.stringify(priorPaths)}.includes(__pixTest.state().current.session.path)`);
  const createdPath = await evaluate(`__pixTest.state().current.session.path`);
  assert.equal(await evaluate(`(async () => (await window.pix.invoke('session.snapshot')).session.path)()`), createdPath,
    "new session must be selected in both processes");
  console.log("Same-project switches and creation keep renderer/main session selection in sync");
} finally {
  socket?.close();
  child.kill();
}
