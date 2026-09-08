// GUI regression for the composer stop control: submits held streaming runs
// through the chat composer, then verifies the send→stop morph, Enter gating
// while stopping, and unlock after branchAbort — including the collapsed-bar
// stop button. Spawns gui-parallel-fixture.mjs (local deterministic model).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('..', import.meta.url));
const debugPort = 9861;
const home = join(root, 'artifacts', `gui-parallel-stop-${randomUUID()}`);
const fixture = spawn(process.execPath, [join(root, 'scripts', 'gui-parallel-fixture.mjs'), home], {
  env: { ...process.env, PIX_GUI_DEBUG_PORT: String(debugPort), PIX_GUI_BRANCHES: '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
  windowsHide: true,
});
const fixtureLine = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('fixture did not start')), 30000);
  fixture.stdout.on('data', chunk => {
    const line = String(chunk).trim();
    if (!line.startsWith('{')) return;
    clearTimeout(timer);
    try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
  });
});
const model = `http://127.0.0.1:${fixtureLine.port}`;
const requests = async () => (await (await fetch(`${model}/state`)).json()).requests;

// Electron's remote debugging port comes up a few seconds after the fixture prints.
const pages = await (async () => {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      if (list.some(page => page.type === 'page')) return list;
    } catch {}
    assert.ok(Date.now() < deadline, 'Electron CDP endpoint never came up');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
})();
const socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
await new Promise(resolve => socket.once('open', resolve));
let sequence = 0;
const pending = new Map();
socket.on('message', bytes => {
  const message = JSON.parse(bytes);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id); clearTimeout(request.timer);
  message.error ? request.reject(message.error) : request.resolve(message.result);
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression) {
  const deadline = Date.now() + 30000;
  while (!await evaluate(expression)) {
    assert.ok(Date.now() < deadline, `UI timeout: ${expression}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function click(selector) {
  // DOM clicks match the other GUI checks: splitter panel transitions make
  // synthetic mouse coordinates unreliable right after expanding a panel.
  await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('Missing click target: ' + ${JSON.stringify(selector)}); e.click(); })()`);
}
const buttonState = () => evaluate(`(() => { const b = document.querySelector('.branch-panel .composer-submit');
  return b && { label: b.getAttribute('aria-label'), disabled: b.disabled, icon: b.querySelector('svg')?.getAttribute('class') }; })()`);
const runningExpr = `__pixTest.state().current.graph.runs.some(r => r.status === 'running')`;
const running = () => evaluate(runningExpr);

try {
  await send('Runtime.enable');
  await until(`window.__pixTest && !__pixTest.state().loading && !document.querySelector('.booting')`);
  if (await evaluate(`__pixTest.state().layout.collapsed.chat`)) await evaluate(`__pixTest.toggle('chat')`);
  await until(`(document.getElementById('chat-panel')?.getBoundingClientRect().width ?? 0) > 200`);
  // The last session opens asynchronously after boot; the footer renders with it.
  await until(`Boolean(document.querySelector('.branch-panel .composer-collapsed, .branch-panel .prompt-composer textarea'))`);
  if (await evaluate(`Boolean(document.querySelector('.branch-panel .composer-collapsed'))`))
    await click('.branch-panel .composer-collapsed');
  await until(`Boolean(document.querySelector('.branch-panel textarea'))`);
  const send0 = await buttonState();
  assert.match(send0.label, /Enter to send/);
  assert.match(send0.icon, /lucide-arrow-up/);

  // A held streaming run must morph the send button into the stop control.
  const before = (await requests()).length;
  await evaluate(`(() => { const e = document.querySelector('.branch-panel textarea');
    e.value = 'HOLD stop check one'; e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until(`(${runningExpr})`);
  const stopping = await buttonState();
  assert.equal(stopping.label, 'Stop generating');
  assert.equal(stopping.disabled, false);
  assert.match(stopping.icon, /lucide-square/);

  // Enter must not deliver while the button is the stop control.
  await evaluate(`(() => { const e = document.querySelector('.branch-panel textarea');
    e.value = 'queued while running'; e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal((await requests()).length, before + 1);
  assert.equal(await evaluate(`document.querySelector('.branch-panel textarea').value`), 'queued while running');

  // Stopping from the button must abort the held stream and unlock the composer.
  await click('.branch-panel .composer-submit');
  await until(`!(${runningExpr})`);
  const settled = (await requests()).find(request => request.text === 'HOLD stop check one');
  assert.equal(settled.status, 'aborted');
  const send1 = await buttonState();
  assert.match(send1.label, /Enter to send/);
  assert.match(send1.icon, /lucide-arrow-up/);

  // The collapsed composer bar keeps a stop control for graph-started runs.
  await evaluate(`(() => { const e = document.querySelector('.branch-panel textarea');
    e.value = 'HOLD stop check two'; e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until(`(${runningExpr})`);
  await click('.branch-panel .composer-head button');
  await until(`Boolean(document.querySelector('.branch-panel .composer-collapsed'))`);
  const collapsedStop = await evaluate(`(() => { const b = document.querySelector('.branch-panel .composer-collapsed-stop');
    return b && { label: b.getAttribute('aria-label'), icon: b.querySelector('svg')?.getAttribute('class') }; })()`);
  assert.equal(collapsedStop.label, 'Stop generating');
  assert.match(collapsedStop.icon, /lucide-square/);
  await click('.branch-panel .composer-collapsed-stop');
  await until(`!(${runningExpr})`);
  assert.equal((await requests()).find(request => request.text === 'HOLD stop check two').status, 'aborted');
  await click('.branch-panel .composer-collapsed');
  await until(`Boolean(document.querySelector('.branch-panel .composer-submit'))`);
  assert.match((await buttonState()).label, /Enter to send/);

  console.log('stop-button GUI check passed');
} finally {
  await fetch(`${model}/shutdown`, { method: 'POST' }).catch(() => fixture.kill());
  await new Promise(resolve => { fixture.once('exit', resolve); setTimeout(resolve, 5000); });
  socket.close();
  rmSync(home, { recursive: true, force: true });
}
