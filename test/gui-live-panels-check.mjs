// Start gui-parallel-fixture.mjs with 8 branches and PIX_GUI_STREAM_LABEL=1.
// Run: node test/gui-live-panels-check.mjs <debug-port> [--resume]
// PIX_GUI_SOAK_MS adds sustained output checks. All panel operations use mouse input.
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
  const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('Missing click target'); const r=e.getBoundingClientRect(); const point = { x:r.x+r.width/2, y:r.y+r.height/2 }; if (!e.contains(document.elementFromPoint(point.x,point.y))) throw Error('Covered click target: '+${JSON.stringify(selector)}); return point; })()`);
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
  const report = { panels: [], errors };
  // Read-only diagnostics; never mutate the stores to operate the panels.
  const diagnostics = `(() => {
    const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
    const session = stores.get('session'), workspace = stores.get('workspace');
    return { events: workspace.events.length, running: session.current.graph.runs.filter(r=>r.status==='running').length,
      liveChars: Object.values(session.branchActivities).reduce((n,a)=>n+(a.activity?.items.reduce((n,i)=>n+i.text.length,0)||0),0),
      heap: performance.memory.usedJSHeapSize };
  })()`;
  const sample = async () => ({ ...await evaluate(diagnostics), heap: (await send('Runtime.getHeapUsage')).usedSize });
  await evaluate(`window.__liveLongTasks = []; new PerformanceObserver(list => __liveLongTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask'})`);
  for (let i = 0; i < (process.argv.includes('--resume') ? 0 : 8); i++) {
    const run = initial.current.graph.runs.find(run => run.branchId === `fixture-${i}`);
    assert.ok(run?.nodeId);
    await evaluate(`window.pix.invoke('agent.control', ${JSON.stringify({ action: 'promptAt', requestId: `live-panels-${i}`, nodeId: run.nodeId, text: `HOLD live panel ${i}` })}).then(() => true)`);
  }
  await until(`__pixTest.state().current.graph.runs.filter(run => run.status === 'running').length === 8`);
  await until(`(${diagnostics}).liveChars > 100000`);
  report.before = await sample();
  console.log('All eight sessions streaming: '+JSON.stringify(report.before));
  const live = await evaluate(`__pixTest.state().current.graph.runs.filter(r=>r.status==='running').map(r=>r.nodeId || 'pending:'+r.runId)`);
  // Setup the viewport once; subsequent view switches and panel operations use mouse input.
  await evaluate(`__pixTest.selectNode(${JSON.stringify(live[3])})`);
  await click('.graph-controls button:last-child');
  await new Promise(resolve=>setTimeout(resolve, 500));
  for (const width of [1280, 900]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await new Promise(resolve=>setTimeout(resolve, 300));
    for (let i = 0; i < 12; i++) {
      const panel = i % 2 ? 'content' : 'chat';
      const selector = panel === 'chat' ? '[data-action="chat-panel"]' : '[data-action="tool-panel"]';
      const before = await evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded') === 'true'`);
      // Renderer-local timing includes layout/paint without CDP round-trip time.
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).addEventListener('pointerdown',()=>window.__panelStart=performance.now(),{once:true})`);
      await click(selector);
      const result = await evaluate(`new Promise(resolve => {
        const started = window.__panelStart ?? performance.now();
        const check = () => {
          const panel = document.querySelector('#${panel}-panel');
          const rect = panel.getBoundingClientRect();
          const expanded = document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')==='true';
          const reached = expanded === ${!before} && (${before} ? rect.width < 2 : rect.width > 100);
          if (reached || performance.now()-started > 2000) resolve({ok:reached,ms:performance.now()-started,width:rect.width,expanded});
          else requestAnimationFrame(check);
        }; requestAnimationFrame(check);
      })`);
      report.panels.push({ panel, windowWidth: width, opening: !before, ...result });
      writeFileSync(join(home,'live-panels-report.json'),JSON.stringify(report,null,2));
      console.log(JSON.stringify(report.panels.at(-1)));
    }
  }
  // Leave chat visible and verify a live response continues to grow on screen.
  if (!await evaluate(`document.querySelector('[data-action="chat-panel"]').getAttribute('aria-expanded')==='true'`)) await click('[data-action="chat-panel"]');
  const text = `.agent-process.live .agent-markdown[data-streaming="true"]`;
  await until(`!!document.querySelector(${JSON.stringify(text)})`);
  const beforeText = await evaluate(`document.querySelector(${JSON.stringify(text)}).textContent`);
  await until(`document.querySelector(${JSON.stringify(text)}).textContent !== ${JSON.stringify(beforeText)}`);
  report.liveOutput = 'passed';
  await send('Emulation.setDeviceMetricsOverride', { width:1280, height:900, deviceScaleFactor:1, mobile:false });
  if (!initial.layout.collapsed.navigator) await click('[data-action="navigator-panel"]');
  if (await evaluate(`document.querySelector('[data-action="tool-panel"]').getAttribute('aria-expanded')==='true'`)) await click('[data-action="tool-panel"]');
  await click('.graph-controls button:last-child');
  await new Promise(resolve=>setTimeout(resolve,500));
  const choices = await evaluate(`(() => {
    const pane=document.querySelector('.vue-flow').getBoundingClientRect();
    return [...document.querySelectorAll('.vue-flow__node')].filter(e=>{
      const r=e.getBoundingClientRect(); return e.querySelector('.turn-copy strong')?.textContent.startsWith('HOLD live panel') &&
        r.left>=pane.left && r.right<=pane.right && r.top>=pane.top && r.bottom<=pane.bottom;
    }).map(e=>({id:e.dataset.id,title:e.querySelector('.turn-copy strong').textContent}));
  })()`);
  assert.ok(choices.length>=2,'At least two running branches must be visible for real click tests');
  report.liveSwitches=[];
  for(let i=0;i<12;i++) {
    const node=choices[i%choices.length];
    await evaluate(`document.querySelector('[data-id="${node.id}"]').addEventListener('pointerdown',()=>window.__liveClickStart=performance.now(),{once:true})`);
    await click(`[data-id="${node.id}"] .turn-copy strong`);
    await until(`document.querySelector('[data-id="${node.id}"] .prompt-node.selected') &&
      document.querySelector('.branch-title small').textContent === ${JSON.stringify(node.title)} &&
      document.querySelector(${JSON.stringify(text)})?.textContent.includes(${JSON.stringify(node.title)})`);
    report.liveSwitches.push(await evaluate(`({ms:performance.now()-__liveClickStart, chars:document.querySelector(${JSON.stringify(text)}).textContent.length,
      status:!!document.querySelector('[data-id="${node.id}"] .node-run-state')})`));
  }
  await click('[data-action="tool-panel"]');
  await until(`document.querySelector('#content-panel').getBoundingClientRect().width>150`);
  if (await evaluate(`!!document.querySelector('[data-tool-section="files"]')`)) await click('[data-tool-section="files"]');
  await until(`!!document.querySelector('.file-workspace')`);
  report.filesPanel = 'passed';
  const soakUntil = Date.now() + Number(process.env.PIX_GUI_SOAK_MS ?? 0);
  report.soak = [];
  while (Date.now() < soakUntil) {
    await new Promise(resolve=>setTimeout(resolve, 5000));
    report.soak.push(await sample());
    console.log('Streaming soak: '+JSON.stringify(report.soak.at(-1)));
  }
  report.after = await sample();
  report.longTasks = await evaluate(`__liveLongTasks`);
  const screenshot = await send('Page.captureScreenshot', { format:'png' });
  writeFileSync(join(home,'live-panels.png'), Buffer.from(screenshot.data,'base64'));
  writeFileSync(join(home,'live-panels-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({ ...report, longTasks: {count:report.longTasks.length,max:Math.max(0,...report.longTasks)}, report:join(home,'live-panels-report.json') },null,2));
  assert.equal(report.after.running,8);
  assert.ok(report.panels.every(p=>p.ok),'Every panel click must take effect');
  assert.ok(report.liveSwitches.every(s=>s.status && s.chars < 40000),'Live views and running indicators stay bounded and scoped');
  assert.equal(errors.length,0);
} finally { socket.close(); }
