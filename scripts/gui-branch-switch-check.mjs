// Run gui-parallel-fixture.mjs with 8 branches, 100 turns, and a 100ms stream
// interval, then: node scripts/gui-branch-switch-check.mjs <debug-port>
// SDK runs are started through the app API; measured selections use real clicks.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import WebSocket from 'ws';

const port = Number(process.argv[2] ?? 9837);
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function click(selector) {
  const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('Missing click target'); const r=e.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
try {
  await send('Runtime.enable');
  await until(`window.__pixTest && !__pixTest.state().loading && !document.querySelector('.booting')`);
  const initial = await evaluate(`__pixTest.state()`);
  const home = dirname(initial.project.path);
  const within = relative(resolve('artifacts'), home);
  assert.ok(within.startsWith('gui-parallel-') && !isAbsolute(within) && !within.startsWith('..'));
  assert.ok(initial.current.graph.runs.length >= 9, 'Eight independent child sessions');
  if (initial.layout.collapsed.chat) await evaluate(`__pixTest.toggle('chat')`);
  for (let i = 0; i < 8; i++) {
    const run = initial.current.graph.runs.find(run => run.branchId === `fixture-${i}`);
    assert.ok(run?.nodeId);
    await evaluate(`window.pix.invoke('agent.control', ${JSON.stringify({ action: 'promptAt', requestId: `switch-check-${i}`, nodeId: run.nodeId, text: `HOLD switch check ${i}` })}).then(() => true)`);
  }
  await until(`__pixTest.state().current.graph.runs.filter(run => run.status === 'running').length === 8`);
  const focus = initial.current.projection.nodes.filter(node => node.branchId === 'fixture-3' && node.title.startsWith('Branch')).at(-1)?.id;
  assert.ok(focus);
  await evaluate(`__pixTest.selectNode(${JSON.stringify(focus)})`);
  await click('.graph-controls button:last-child');
  await new Promise(resolve => setTimeout(resolve, 500));
  // Keep the timing clock in the renderer: pointerdown -> selected DOM/content
  // committed -> one paint opportunity. CDP round trips are outside the sample.
  await evaluate(`(() => {
    window.__switchPerf = { samples: [], longTasks: [], pending: false };
    const state = __pixTest.state();
    const titles = new Map(state.current.projection.nodes.map(node => [node.id, node.title]));
    const observer = new PerformanceObserver(list => __switchPerf.longTasks.push(...list.getEntries().map(entry => entry.duration)));
    observer.observe({ type: 'longtask' });
    window.__switchObserver = observer;
    document.addEventListener('pointerdown', event => {
      const node = event.target.closest('.vue-flow__node');
      if (!node) return;
      const id = node.dataset.id, start = performance.now();
      __switchPerf.pending = true;
      const check = () => {
        if (!document.querySelector('[data-id="' + CSS.escape(id) + '"] .prompt-node.selected') ||
            document.querySelector('.branch-title small')?.textContent !== titles.get(id)) {
          if (performance.now() - start < 5000) { requestAnimationFrame(check); return; }
          __switchPerf.samples.push({ id, timeout: true }); __switchPerf.pending = false; return;
        }
        requestAnimationFrame(() => {
          __switchPerf.samples.push({ id, ms: performance.now()-start, turns: document.querySelectorAll('.chat-turn').length });
          __switchPerf.pending = false;
        });
      };
      requestAnimationFrame(check);
    }, true);
    return true;
  })()`);
  const choices = await evaluate(`(() => {
    const pane = document.querySelector('.vue-flow').getBoundingClientRect();
    const choices = new Map();
    for (const node of document.querySelectorAll('.vue-flow__node')) {
      const match = node.dataset.id.match(/fixture-([0-9]+)/);
      const copy = node.querySelector('.turn-copy strong');
      if (!match || !copy || !copy.textContent.startsWith('Branch')) continue;
      const r=node.getBoundingClientRect();
      if (r.left >= pane.left && r.right <= pane.right && r.top >= pane.top && r.bottom <= pane.bottom)
        choices.set(match[1], node.dataset.id);
    }
    return [...choices.values()];
  })()`);
  assert.ok(choices.length >= 2, `Need visible cards from two branches: ${JSON.stringify(choices)}`);
  for (let i = 0; i < 24; i++) {
    const id = choices[i % choices.length];
    await click(`[data-id="${id}"] .turn-copy strong`);
    await until(`!__switchPerf.pending`);
  }
  const perf = await evaluate(`__switchObserver.disconnect(); __switchPerf`);
  assert.ok(perf.samples.length >= 24);
  assert.ok(perf.samples.every(sample => !sample.timeout && sample.turns <= 40));
  const times = perf.samples.map(sample => sample.ms).sort((a, b) => a-b);
  const warmTimes = perf.samples.slice(choices.length).map(sample => sample.ms).sort((a, b) => a-b);
  const running = await evaluate(`__pixTest.state().current.graph.runs.filter(run => run.status === 'running').length`);
  assert.equal(running, 8, 'Viewing branches must not stop SDK sessions');
  const report = { sessions: running, nodes: initial.current.projection.nodes.length, samples: perf.samples,
    p50Ms: times[Math.floor(times.length * .5)], p95Ms: times[Math.ceil(times.length * .95)-1],
    maxMs: times.at(-1), warmP95Ms: warmTimes[Math.ceil(warmTimes.length * .95)-1], longTasks: perf.longTasks };
  // Exercise reading state with native wheel/click input while all runs stream.
  const viewport = `getComputedStyle(document.querySelector('.vue-flow__transformationpane')).transform`;
  const beforeViewport = await evaluate(viewport);
  const [first, second] = choices;
  const select = async id => {
    await click(`[data-id="${id}"] .turn-copy strong`);
    await until(`!__switchPerf.pending`);
    const title = await evaluate(`document.querySelector('.branch-title small').textContent`);
    const user = await evaluate(`[...document.querySelectorAll('.chat-turn .branch-message.user p')].at(-1)?.textContent`);
    assert.equal(user, title, 'Selected branch history matches its graph card');
  };
  const wheel = async deltaY => {
    const point = await evaluate(`(() => { const r = document.querySelector('.branch-messages').getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', deltaX: 0, deltaY, ...point });
  };
  await select(first);
  await wheel(-1000000);
  await until(`document.querySelector('.branch-messages').scrollTop < 1`);
  await click('.load-earlier-turns');
  await until(`document.querySelectorAll('.chat-turn').length === 80`);
  await wheel(-1000000);
  await until(`document.querySelector('.branch-messages').scrollTop < 1`);
  await wheel(350);
  await until(`document.querySelector('.branch-messages').scrollTop > 300`);
  const savedTop = await evaluate(`document.querySelector('.branch-messages').scrollTop`);
  await select(second);
  assert.equal(await evaluate(`document.querySelectorAll('.chat-turn').length`), 40);
  await select(first);
  await until(`document.querySelectorAll('.chat-turn').length === 80 && Math.abs(document.querySelector('.branch-messages').scrollTop - ${savedTop}) < 2`);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await evaluate(`!!document.querySelector('.node-hover-card')`), false, 'Click must cancel hover preview');
  assert.equal(await evaluate(viewport), beforeViewport, 'Visible branch selection must preserve the viewport');
  assert.ok(Math.abs(await evaluate(`document.querySelector('.branch-messages').scrollTop`) - savedTop) < 2,
    'Background streams must not pull reading position to the bottom');
  report.readingState = { pagination: 'passed', scrollRestoration: 'passed', savedTop, contentMatches: 'passed',
    viewportStable: 'passed', clickPreviewSuppressed: 'passed' };
  for (let i = 0; i < 12; i++) await click(`[data-id="${choices[i % choices.length]}"] .turn-copy strong`);
  const last = choices[11 % choices.length];
  await until(`document.querySelector('[data-id="${last}"] .prompt-node.selected') &&
    document.querySelector('.branch-title small').textContent === document.querySelector('[data-id="${last}"] .turn-copy strong').textContent`);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await evaluate(`document.querySelector('.prompt-node.selected').closest('.vue-flow__node').dataset.id`), last);
  assert.equal(await evaluate(viewport), beforeViewport, 'Rapid clicks must not trigger a stale recenter');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  report.rapidClicks = 12;
  report.rendererErrors = errors;
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(home, 'branch-switch.png'), Buffer.from(screenshot.data, 'base64'));
  writeFileSync(join(home, 'branch-switch-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, samples: report.samples.length, report: join(home, 'branch-switch-report.json') }, null, 2));
  assert.ok(report.p95Ms < 100, `Branch switch p95 ${report.p95Ms}ms exceeds 100ms target`);
} finally {
  socket.close();
}
