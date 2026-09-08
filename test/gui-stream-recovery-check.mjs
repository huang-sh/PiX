// Start gui-parallel-fixture.mjs with PIX_GUI_BRANCHES=3, PIX_GUI_TOOL_ROUNDS=3,
// PIX_GUI_STREAM_LABEL=1, PIX_GUI_STREAM_MS=200. Pass its debug and model ports.
import assert from 'node:assert/strict';
import { isAbsolute, relative, resolve } from 'node:path';
import WebSocket from 'ws';

const [debugPort, modelPort] = process.argv.slice(2).map(Number);
const fixture = await (await fetch(`http://127.0.0.1:${modelPort}/state`)).json();
const local = relative(resolve('artifacts'), fixture.home);
assert.ok(local.startsWith('gui-parallel-') && !isAbsolute(local) && !local.startsWith('..'));
const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
await new Promise(resolve => socket.once('open', resolve));
let sequence = 0;
const pending = new Map();
const errors = [];
socket.on('message', bytes => {
  const message = JSON.parse(bytes);
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id); clearTimeout(request.timer);
  message.error ? request.reject(message.error) : request.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(Error(`Timeout: ${method}`)); }, 15000);
  pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expression})))()`, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value === undefined ? undefined : JSON.parse(result.result.value);
}
async function until(expression) {
  const deadline = Date.now() + 15000;
  while (!await evaluate(expression)) {
    assert.ok(Date.now() < deadline, `UI did not converge: ${expression}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
try {
  await send('Runtime.enable');
  await until(`window.__pixTest && !__pixTest.state().loading`);
  assert.equal(await evaluate(`__pixTest.state().project.path`), fixture.cwd, 'CDP must target this isolated fixture');
  await evaluate(`(() => {
    const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
    window.recoverySession = stores.get('session');
    window.patchStats = { patches: 0, full: 0, wireBytes: 0, fullBytes: 0 };
    window.pix.onEvent(event => {
      if (event.type !== 'sessions') return;
      if (event.payload.current) patchStats.full++;
      if (event.payload.patch) {
        patchStats.patches++;
        patchStats.wireBytes += JSON.stringify(event).length;
        patchStats.fullBytes += JSON.stringify(recoverySession.current).length;
      }
    });
    stores.get('layout').setCollapsed('chat', false);
    window.originalAgentEvent = recoverySession.onAgentEvent;
    // Fault injection: only one branch misses starts. Other branch events and
    // every cumulative update still travel through the real Electron IPC.
    recoverySession.onAgentEvent = event => {
      if (event.branchId === 'fixture-0' && ['agent_start', 'message_start', 'tool_execution_start'].includes(event.type)) return;
      return originalAgentEvent(event);
    };
    return true;
  })()`);
  for (let i = 0; i < 3; i++) await evaluate(`(async () => {
    const run = recoverySession.current.graph.runs.find(run => run.branchId === 'fixture-${i}');
    await recoverySession.promptAt(run.nodeId, 'HOLD recovery ${i}'); return true;
  })()`);
  await until(`recoverySession.current.graph.runs.filter(r => r.status === 'running').length === 3`);
  for (let i = 0; i < 6; i++) {
    const branch = i % 3;
    await evaluate(`(async () => {
      const run = recoverySession.current.graph.runs.find(run => run.branchId === 'fixture-${branch}');
      await recoverySession.selectNode(run.nodeId); return true;
    })()`);
    await until(`document.querySelector('.agent-process.live')?.textContent.includes('[HOLD recovery ${branch}')`);
    const before = await evaluate(`recoverySession.selectedActivity.items.at(-1).text.length`);
    await until(`recoverySession.selectedActivity.items.at(-1).text.length > ${before}`);
    assert.equal(await evaluate(`recoverySession.selectedRun.status`), 'running');
  }
  assert.equal(await evaluate(`recoverySession.branchActivities['fixture-0'].activity.partial`), true);
  const stats = await evaluate('patchStats');
  assert.ok(stats.patches > 0, 'real IPC must use session patches');
  assert.ok(stats.wireBytes < stats.fullBytes / 2, JSON.stringify(stats));
  // A reload loses the wire baseline and stream starts. It must resync through
  // session.snapshot without closing any of the three model requests.
  await send('Page.reload');
  await until(`window.__pixTest && !__pixTest.state().loading`);
  await evaluate(`(() => {
    const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
    window.recoverySession = stores.get('session');
    stores.get('layout').setCollapsed('chat', false);
    return true;
  })()`);
  await until(`recoverySession.current.graph.runs.filter(r => r.status === 'running').length === 3`);
  await evaluate(`recoverySession.selectNode(recoverySession.current.graph.runs.find(r => r.branchId === 'fixture-2').nodeId).then(() => true)`);
  await until(`document.querySelector('.agent-process.live')?.textContent.includes('[HOLD recovery 2')`);
  assert.equal((await (await fetch(`http://127.0.0.1:${modelPort}/state`)).json()).held.length, 3);
  for (let i = 0; i < 3; i++) await fetch(`http://127.0.0.1:${modelPort}/release/${encodeURIComponent(`HOLD recovery ${i}`)}`);
  await until(`recoverySession.current.graph.runs.every(r => r.status !== 'running')`);
  await until(`!document.querySelector('.agent-process.live')`);
  assert.ok(await evaluate(`document.querySelector('.branch-messages').textContent.includes('Finished HOLD recovery 2.')`));
  assert.deepEqual(errors, []);
  console.log('PASS: three parallel runs, missing lifecycle recovery, six live node switches, reload/resync, final output and idle state');
  console.log(JSON.stringify(stats));
} finally {
  await evaluate(`(() => { if (window.originalAgentEvent) recoverySession.onAgentEvent = originalAgentEvent; return true; })()`).catch(() => {});
  // This script only owns the isolated fixture checked above.
  await fetch(`http://127.0.0.1:${modelPort}/shutdown`, { method: 'POST' });
  socket.close();
}
