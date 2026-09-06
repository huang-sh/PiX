// Start scripts/gui-parallel-fixture.mjs, then run this check. Use
// PIX_GUI_NATIVE_BRANCHES=12 for MiniMap or PIX_GUI_BRANCHES=100 for GraphOverview.
// Only real mouse input changes the UI; __pixTest is read-only.
import assert from 'node:assert/strict';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
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
  } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
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
    if (Date.now() - start > 15000) throw new Error(`UI timeout: ${expression}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function click(selector, xRatio = 0.5, yRatio = 0.5) {
  const point = await evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)}), r = e.getBoundingClientRect();
    const x = Math.round(r.x + r.width * ${xRatio}), y = Math.round(r.y + r.height * ${yRatio});
    if (!e.contains(document.elementFromPoint(x, y))) throw Error('Click target is covered: ' + ${JSON.stringify(selector)});
    return { x, y };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
const minimap = '.vue-flow__minimap, .graph-overview';
const toggle = '.graph-controls button[aria-pressed]';
const center = '.graph-controls button:last-child';
const viewport = `(() => {
  const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.vue-flow__transformationpane')).transform);
  return { x: m.e, y: m.f, zoom: m.a };
})()`;

try {
  const cwd = await evaluate('__pixTest.state().project.path');
  const home = relative(resolve('artifacts'), dirname(cwd));
  assert.ok(home.startsWith('gui-parallel-') && !isAbsolute(home) && !home.startsWith('..'), 'Only run against an isolated fixture');
  await send('Runtime.enable');
  await send('Page.reload', { ignoreCache: true });
  await until(`!!document.querySelector('.vue-flow__node') && !document.querySelector('.booting')`);
  const count = await evaluate('__pixTest.state().current.projection.nodes.length');
  if (await evaluate(`!!document.querySelector(${JSON.stringify(minimap)})`)) await click(toggle);
  await until(`!document.querySelector(${JSON.stringify(minimap)})`);
  await click(toggle);
  await until(`!!document.querySelector(${JSON.stringify(minimap)})`);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(toggle)}).ariaPressed`), 'true');
  const before = await evaluate(viewport);
  const target = count >= 500 ? '.graph-overview' : '.vue-flow__minimap svg';
  // For the SVG minimap, verify its click event translates into the exact
  // graph coordinates, not screen coordinates or a second zoom operation.
  const worldPoint = count < 500 ? await evaluate(`(() => {
    const svg = document.querySelector('.vue-flow__minimap svg'), r = svg.getBoundingClientRect();
    const p = new DOMPoint(Math.round(r.x + r.width * 0.25), Math.round(r.y + r.height * 0.25)).matrixTransform(svg.getScreenCTM().inverse());
    return { x: p.x, y: p.y };
  })()`) : null;
  await click(target, 0.25, 0.25);
  await until(`Math.hypot((${viewport}).x - ${before.x}, (${viewport}).y - ${before.y}) > 10`);
  const after = await evaluate(viewport);
  assert.equal(after.zoom, before.zoom, 'Minimap navigation preserves zoom');
  if (worldPoint) {
    const size = await evaluate(`(() => { const r = document.querySelector('.session-flow').getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
    assert.ok(Math.abs((size.width / 2 - after.x) / after.zoom - worldPoint.x) < 3, `Click centers the graph X coordinate: ${JSON.stringify({ before, after, size, worldPoint })}`);
    assert.ok(Math.abs((size.height / 2 - after.y) / after.zoom - worldPoint.y) < 3, 'Click centers the graph Y coordinate');
  }
  await click(center);
  await until(`(() => {
    const id = __pixTest.state().current.projection.activeNodeId;
    const node = document.querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (!node) return false;
    const r = node.getBoundingClientRect(), pane = document.querySelector('.session-flow').getBoundingClientRect();
    return Math.hypot(r.x + r.width / 2 - pane.x - pane.width / 2, r.y + r.height / 2 - pane.y - pane.height / 2) < 2;
  })()`);
  await click(toggle);
  await until(`!document.querySelector(${JSON.stringify(minimap)})`);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(toggle)}).ariaPressed`), 'false');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log(JSON.stringify({ nodes: count, overview: count >= 500, toggles: 'passed', clickNavigation: 'passed', centerCurrent: 'passed', errors }));
} finally { socket.close(); }
