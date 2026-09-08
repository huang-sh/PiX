import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
const root = fileURLToPath(new URL('..', import.meta.url));
const debugPort = 9863;
const home = join(root, 'artifacts', `gui-parallel-shot-${randomUUID()}`);
const fixture = spawn(process.execPath, [join(root, 'test/gui-parallel-fixture.mjs'), home], {
  env: { ...process.env, PIX_GUI_DEBUG_PORT: String(debugPort), PIX_GUI_BRANCHES: '0' }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
const line = JSON.parse(await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('no fixture line')), 30000);
  fixture.stdout.on('data', c => { const s = String(c).trim(); if (s.startsWith('{')) { clearTimeout(t); resolve(s); } });
}));
const pages = await (async () => {
  for (let i = 0; i < 120; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); if (l.some(p => p.type === 'page')) return l; } catch {}
    await new Promise(r => setTimeout(r, 250));
  } throw new Error('no CDP');
})();
const socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
await new Promise(r => socket.once('open', r));
let seq = 0; const pending = new Map();
socket.on('message', b => { const m = JSON.parse(b); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); });
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
const until = async (expression) => { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 200)); } throw new Error('timeout: ' + expression); };
const shot = async (name) => {
  const frame = await send('Page.captureScreenshot', { format: 'png', clip: await evaluate(`(() => { const e = document.querySelector('.chat-composer'); const r = e.getBoundingClientRect(); return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16, scale: 2 }; })()`) });
  writeFileSync(join('artifacts', name), Buffer.from(frame.data, 'base64'));
};
try {
  await until('window.__pixTest && !__pixTest.state().loading && !document.querySelector(".booting")');
  if (await evaluate('__pixTest.state().layout.collapsed.chat')) await evaluate('__pixTest.toggle("chat")');
  await until('(document.getElementById("chat-panel")?.getBoundingClientRect().width ?? 0) > 200');
  await until('Boolean(document.querySelector(".branch-panel .composer-collapsed, .branch-panel textarea"))');
  if (await evaluate('Boolean(document.querySelector(".branch-panel .composer-collapsed"))')) await evaluate('document.querySelector(".branch-panel .composer-collapsed").click()');
  await until('Boolean(document.querySelector(".branch-panel textarea"))');
  await evaluate(`(() => { const e = document.querySelector('.branch-panel textarea'); e.value = 'HOLD stop check one'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until('__pixTest.state().current.graph.runs.some(r => r.status === "running")');
  await new Promise(r => setTimeout(r, 600));
  await shot('stop-expanded.png');
  await evaluate('document.querySelector(".branch-panel .composer-head button").click()');
  await until('Boolean(document.querySelector(".branch-panel .composer-collapsed-stop"))');
  await new Promise(r => setTimeout(r, 400));
  await shot('stop-collapsed.png');
  console.log('shots done');
} finally {
  await fetch(`http://127.0.0.1:${line.port}/shutdown`, { method: 'POST' }).catch(() => {});
  await new Promise(r => { fixture.once('exit', r); setTimeout(r, 5000); });
  socket.close();
  rmSync(home, { recursive: true, force: true });
}
