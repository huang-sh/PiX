// Start gui-parallel-fixture.mjs with PIX_GUI_BRANCHES=1000, then run this.
// Uses real Electron mouse/keyboard events; __pixTest is read only.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import WebSocket from 'ws';

const targets = await (await fetch('http://127.0.0.1:9827/json/list')).json();
const socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(resolve => socket.once('open', resolve));
let sequence = 0;
const pending = new Map(), errors = [];
socket.on('message', bytes => {
  const message = JSON.parse(bytes);
  if (message.id) {
    const task = pending.get(message.id); pending.delete(message.id);
    if (task) { clearTimeout(task.timer); message.error ? task.reject(message.error) : task.resolve(message.result); }
  } else if (message.method === 'Runtime.exceptionThrown' || message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message);
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
  const start = Date.now();
  while (!await evaluate(expression)) {
    if (Date.now() - start > 30000) throw new Error(`UI timeout: ${expression}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function click(selector) {
  await evaluate(`window.__treePhase=${JSON.stringify(selector)}`);
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing element');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
try {
  await send('Runtime.enable'); await send('Runtime.discardConsoleEntries'); errors.length = 0;
  const start = Date.now(); await send('Page.reload', { ignoreCache: true });
  await until(`!!document.querySelector('[data-id="turn:root"] .node-add') && !document.querySelector('.booting')`);
  const reloadMs = Date.now() - start;
  const state = await evaluate(`(()=>{let s=__pixTest.state();return {cwd:s.project.path,nodes:s.current.projection.nodes.length,runs:s.current.graph.runs.length,sessions:s.sessions.length}})()`);
  const home = dirname(state.cwd), within = relative(resolve('artifacts'), home);
  assert.ok(within && !isAbsolute(within) && !within.startsWith('..') && within.startsWith('gui-parallel-'));
  assert.ok(state.nodes >= 5001); assert.equal(state.sessions, 1);
  const initial = await evaluate(`({nodes:document.querySelectorAll('.vue-flow__node').length,edges:document.querySelectorAll('.vue-flow__edge').length})`);
  assert.ok(initial.nodes < 100 && initial.edges < 100);
  await evaluate(`window.__treePerf={long:[],phases:[],peakNodes:0,frames:[],last:0};window.__treeObserver=new PerformanceObserver(l=>{__treePerf.long.push(...l.getEntries().map(e=>e.duration));__treePerf.phases.push(...l.getEntries().map(e=>({duration:e.duration,phase:window.__treePhase})));});__treeObserver.observe({type:'longtask'});window.__treeTick=()=>{__treePerf.peakNodes=Math.max(__treePerf.peakNodes,document.querySelectorAll('.vue-flow__node').length);let now=performance.now();if(__treePerf.last)__treePerf.frames.push(now-__treePerf.last);__treePerf.last=now;window.__treeRaf=requestAnimationFrame(__treeTick)};__treeTick();true`);
  await click('[data-id="turn:root"] .node-add');
  await until(`!!document.querySelector('.draft-node textarea')`);
  await click('.draft-node textarea'); await send('Input.insertText', { text: 'Draft survives leaving the viewport' });
  await click('.graph-controls button:last-child');
  await until(`!document.querySelector('.draft-node textarea') && !!document.querySelector('[data-id="turn:root"] .node-add')`);
  await click('[data-id="turn:root"] .node-add');
  await until(`document.querySelector('.draft-node textarea')?.value === 'Draft survives leaving the viewport'`);
  await click('.graph-controls button:last-child');
  await until(`!!document.querySelector('[data-id="turn:root"] .node-add')`);
  if (!await evaluate(`!!document.querySelector('.graph-overview')`)) await click('.graph-controls button');
  await until(`!!document.querySelector('.graph-overview')`);
  await click('.graph-overview');
  const pane = await evaluate(`(()=>{let r=document.querySelector('.session-flow').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...pane, deltaX: 0, deltaY: 500 });
  await click('.graph-controls button:last-child');
  await until(`!!document.querySelector('[data-id="turn:root"] .node-add')`);
  await new Promise(resolve => setTimeout(resolve, 400));
  const performance = await evaluate(`(()=>{cancelAnimationFrame(__treeRaf);__treeObserver.disconnect();let a=__treePerf.frames.sort((a,b)=>a-b);return{phases:__treePerf.phases,peakNodes:__treePerf.peakNodes,samples:a.length,frameP50:a[Math.floor(a.length*.5)],frameP95:a[Math.floor(a.length*.95)],frameMax:a.at(-1),longTasks:__treePerf.long,heapBytes:performance.memory?.usedJSHeapSize}})()`);
  const screenshot = await send('Page.captureScreenshot');
  writeFileSync(join(home, 'large-tree.png'), Buffer.from(screenshot.data, 'base64'));
  const report = { ...state, reloadMs, initial, performance, errors, draftRetained: true };
  writeFileSync(join(home, 'large-tree-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(errors.length, 0);
  assert.ok(performance.peakNodes < 100, 'Viewport navigation never mounts the full tree');
  assert.ok(Math.max(0, ...performance.longTasks) < 1000, 'No second-long interaction stall');
} finally { socket.close(); }
