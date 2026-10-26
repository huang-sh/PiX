// End-to-end: real CLI processes, WebSocket transport, Pi SDK and filesystem tools.
// A deterministic HTTP model controls scheduling; no external credentials needed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { electronBinary } from './lib/electron-binary.mjs';
import { terminalScreen } from './lib/terminal-screen.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// Canonical short paths match the GUI's project normalization and Unix socket limits.
const home = realpathSync(mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'pix-cli-e2e-')));
const cwd = join(home, 'workspace');
const agent = join(home, '.pix', 'agent');
mkdirSync(cwd); mkdirSync(agent, { recursive: true });
mkdirSync(join(agent, 'extensions'));
writeFileSync(join(agent, 'extensions', 'cli-input.ts'), `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default function(pi) {
  pi.registerCommand('cli-input', {handler: async (_args, ctx) => {
    const value = await ctx.ui.input('CLI input test');
    ctx.ui.notify('Answered: ' + value);
  }});
  pi.registerCommand('cli-confirm', {handler: async (_args, ctx) => {
    const value = await ctx.ui.confirm('CLI confirm test', 'Explicit approval is required');
    writeFileSync(join(ctx.cwd, 'confirmation.txt'), String(value));
  }});
  pi.registerCommand('cli-select', {handler: async (_args, ctx) => {
    const value = await ctx.ui.select('CLI select test', ['first', 'second']);
    writeFileSync(join(ctx.cwd, 'selection.txt'), String(value));
  }});
}`);
const env = { ...process.env, PIX_HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PIX_HOST_LINGER_MS: '60000' };
const held = new Map();
const requests = [];
const children = new Set();
let desktop, gui, hostPid, terminal, screen;
const server = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    const userIndex = input.messages.findLastIndex(m => m.role === 'user');
    const user = input.messages[userIndex];
    const text = typeof user.content === 'string' ? user.content : user.content.map(c => c.text ?? '').join('');
    requests.push({ text, messages: input.messages });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const id = randomUUID();
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'cli-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const finish = () => { emit({ role: 'assistant', content: `DONE ${text}` }); emit({}, 'stop'); res.end('data: [DONE]\n\n'); };
    if (text.startsWith('HOLD')) {
      emit({ role: 'assistant', content: 'Waiting. ' });
      held.set(text, finish);
      res.on('close', () => held.delete(text));
    } else if (text.startsWith('WRITE') && !input.messages.slice(userIndex + 1).some(m => m.role === 'tool')) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: `write-${id}`, type: 'function', function: {
        name: 'write', arguments: JSON.stringify({ path: 'agent-output.txt', content: 'written by the real Pi write tool\n' }),
      } }] });
      emit({}, 'tool_calls'); res.end('data: [DONE]\n\n');
    } else if (text === 'FAIL') {
      res.destroy();
    } else if (text === 'RETRY' && requests.filter(request => request.text === text).length === 1) {
      emit({ role: 'assistant', content: '' });
      res.write('data: {"error":{"message":"503 service unavailable","type":"server_error","code":"503"}}\n\n');
      res.end();
    } else finish();
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { 'cli-local': {
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-test-only',
  models: [{ id: 'cli-model', name: 'CLI Test Model', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'cli-local', defaultModel: 'cli-model', defaultProjectTrust: 'always', enabledExtensions: [], retry: { enabled: false } }));
writeFileSync(join(home, '.pix', 'gui.settings.json'), JSON.stringify({ language: 'en', closeToTray: false }));

async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out waiting for integration state');
}
function start(args, input) {
  const child = spawn(process.execPath, [join(root, 'bin/pix.mjs'), '--cwd', cwd, ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  child.stdin.end(input);
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${args.join(' ')}\n${stderr}`)); }, 45000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); children.delete(child); resolve({ code, stdout, stderr,
      events: stdout.trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { text: line }; } }) }); });
  });
  return { child, result };
}
async function cli(args, input, code = 0) {
  const result = await start(args, input).result;
  assert.equal(result.code, code, JSON.stringify({ args, ...result }).slice(0, 4000));
  return result;
}
const final = result => result.events.findLast(event => event.type === 'result');

async function openGui() {
  const portServer = createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  desktop = spawn(electronBinary(root), ['--no-sandbox', '--disable-gpu', `--user-data-dir=${join(home, 'electron')}`, `--remote-debugging-port=${port}`, root], {
    cwd: root, env: { ...env, PIX_PROJECT: cwd, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', ELECTRON_RENDERER_URL: '' }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = ''; desktop.stderr.on('data', x => errors += x);
  const page = await until(async () => {
    if (desktop.exitCode !== null) throw new Error(`Electron exited: ${errors}`);
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page => page.type === 'page' && !page.url.startsWith('devtools:')); } catch { return; }
  });
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let id = 0; const pending = new Map();
  socket.on('message', data => {
    const message = JSON.parse(data);
    if (message.id) { const handler = pending.get(message.id); pending.delete(message.id); handler?.(message); }
  });
  const evaluate = expression => new Promise((resolve, reject) => {
    const key = ++id;
    pending.set(key, message => {
      if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
      else resolve(message.result.result?.value);
    });
    socket.send(JSON.stringify({ id: key, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  await until(() => evaluate('Boolean(window.pix) && document.readyState === "complete" && Boolean(document.querySelector("#app")?.children.length)'));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    pending.set(key, message => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result));
    socket.send(JSON.stringify({ id: key, method, params }));
  });
  return { evaluate, send, close: () => socket.close() };
}
try {
  console.error('Concurrent cold starts');
  // Concurrent cold starts must discover exactly one host.
  await Promise.all([cli(['sessions', '--json']), cli(['sessions', '--json']), cli(['sessions', '--json'])]);
  const status = (await cli(['host', 'status'])).events[0]; hostPid = status.pid;
  assert.equal(status.sessions, 0);
  console.error('Automatic retry completion');
  const settings = readFileSync(join(agent, 'settings.json'), 'utf8');
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ ...JSON.parse(settings), retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }));
  const recovered = final(await cli(['run', 'RETRY', '--json']));
  assert.equal(requests.filter(request => request.text === 'RETRY').length, 2);
  assert.equal(recovered.snapshot.projection.nodes.find(node => node.id === recovered.nodeId).hasError, false);
  assert.ok(recovered.snapshot.entries.some(entry => entry.message?.stopReason === 'error'), 'failed attempt remains in raw history');
  assert.ok(recovered.snapshot.entries.some(entry => entry.message?.stopReason === 'stop'), 'the final successful response determines the CLI result');
  writeFileSync(join(agent, 'settings.json'), settings);
  const initial = final(await cli(['run', 'WRITE root', '--json']));
  assert.ok(initial, 'run returns a settled result');
  const path = initial.session, rootNode = initial.nodeId;
  assert.equal(readFileSync(join(cwd, 'agent-output.txt'), 'utf8'), 'written by the real Pi write tool\n');
  assert.ok(initial.snapshot.entries.some(entry => entry.message?.role === 'toolResult'));
  assert.equal((await cli(['host', 'status'])).events[0].pid, hostPid);
  console.error('Running main request deduplication');
  const mainPath = (await cli(['new'])).events[0].session.path;
  const main = (await cli(['run', 'HOLD main retry', '--session', mainPath, '--json', '--detach', '--request-id', 'main-retry'])).events[0];
  await until(() => held.has('HOLD main retry'));
  const mainRetry = (await cli(['run', 'HOLD main retry', '--session', mainPath, '--json', '--detach', '--request-id', 'main-retry'])).events[0];
  assert.equal(mainRetry.runId, main.runId);
  assert.equal(requests.filter(request => request.text === 'HOLD main retry').length, 1);
  const blocked = await cli(['run', 'must not branch from a live node', '--session', mainPath, '--json'], undefined, 1);
  assert.match(blocked.events.find(event => event.type === 'error').message, /not running/);
  held.get('HOLD main retry')();
  await until(async () => !(await cli(['host', 'status'])).events[0].running.length);
  console.error('This becomes');
  // This becomes a historical node, so subsequent work forks from it.
  await cli(['run', 'main next', '--session', path, '--json']);
  const a = start(['fork', rootNode, 'HOLD branch A', '--session', path, '--json']);
  const b = start(['fork', rootNode, 'HOLD branch B', '--session', path, '--json']);
  await until(() => held.has('HOLD branch A') && held.has('HOLD branch B'));
  assert.equal((await cli(['host', 'status'])).events[0].running.length, 1);
  const tree = (await cli(['tree', path, '--json'])).events[0].snapshot;
  assert.equal(tree.graph.runs.filter(run => run.status === 'running').length, 2);
  assert.equal(tree.projection.nodes.filter(node => node.title.startsWith('HOLD')).length, 2);
  const branchA = tree.graph.runs.find(run => tree.projection.nodes.find(node => node.id === run.nodeId)?.title === 'HOLD branch A');
  await cli(['stop', path, '--branch', branchA.branchId, '--run-id', branchA.runId]);
  await a.result; // Interrupted client must exit; sibling stays alive.
  assert.ok(held.has('HOLD branch B'));
  held.get('HOLD branch B')();
  const branchB = final(await b.result);
  assert.ok(branchB);
  const bRequest = requests.find(request => request.text === 'HOLD branch B');
  assert.ok(!JSON.stringify(bRequest.messages).includes('main next'), 'branch context excludes main descendants');
  assert.ok(!JSON.stringify(bRequest.messages).includes('HOLD branch A'), 'branch context excludes its sibling');
  console.error('A nested fork');
  // A nested fork uses the same existing PiX graph.
  await cli(['run', 'branch B next', '--session', path, '--node', branchB.nodeId, '--json']);
  const nested = final(await cli(['fork', branchB.nodeId, 'nested branch', '--session', path, '--json']));
  assert.equal(nested.snapshot.projection.nodes.find(node => node.id === nested.nodeId).parentId, branchB.nodeId);
  console.error('Accepted work');
  // Accepted work survives the short-lived submitting process.
  const detached = (await cli(['fork', rootNode, 'HOLD detached', '--session', path, '--json', '--detach', '--request-id', 'detach-retry'])).events[0];
  await until(() => held.has('HOLD detached'));
  const retry = (await cli(['fork', rootNode, 'HOLD detached', '--session', path, '--json', '--detach', '--request-id', 'detach-retry'])).events[0];
  assert.equal(retry.runId, detached.runId);
  assert.equal(requests.filter(request => request.text === 'HOLD detached').length, 1);
  held.get('HOLD detached')();
  await until(async () => !(await cli(['host', 'status'])).events[0].running.length);
  console.error('Interactive PTY');
  // A real terminal and VT parser exercise the Pi TUI, not raw output strings.
  // Keep extension-owned state in its own session: the later graph-export
  // check deliberately uses a graph with no third-party export adapters.
  const tuiInitial = final(await cli(['run', 'WRITE TUI root', '--json']));
  const tuiPath = tuiInitial.session, tuiRoot = tuiInitial.nodeId;
  await cli(['run', 'TUI main next', '--session', tuiPath, '--json']);
  const { spawn: spawnPty } = await import('node-pty');
  terminal = spawnPty(process.execPath, [join(root, 'bin/pix.mjs'), '--cwd', cwd, 'chat', '--session', tuiPath], {
    cwd: root, env, cols: 100, rows: 30, name: 'xterm-256color',
  });
  screen = terminalScreen(terminal);
  const terminalExit = new Promise(resolve => terminal.onExit(resolve));
  await until(() => screen.viewport.includes('enter send'));
  assert.ok(screen.text.includes('CLI Test Model') || screen.text.includes('cli-local/cli-model'));
  terminal.write('interactive first\r');
  await until(() => screen.text.includes('DONE interactive first') && screen.viewport.includes('Ready'));
  terminal.write('/tree\r');
  await until(() => screen.viewport.includes('Session Tree'));
  terminal.write('\x1b[1;3D\x1b[1;3D');
  await until(() => !screen.viewport.split('Session Tree')[1]?.includes('interactive first'));
  terminal.write('\x1b[1;3C');
  await until(() => screen.viewport.split('Session Tree')[1]?.includes('interactive first'));
  terminal.write('L');
  await until(() => screen.viewport.includes('Label (empty removes it)'));
  terminal.write('TUI bookmark\r');
  await until(() => screen.viewport.includes('TUI bookmark') && !screen.viewport.includes('Saving label'));
  const labeledTui = (await cli(['tree', tuiPath, '--json', '--filter', 'labeled'])).events[0];
  assert.equal(labeledTui.matchingNodeIds.length, 1);
  assert.ok(labeledTui.snapshot.projection.nodes.some(node => node.label === 'TUI bookmark'));
  terminal.write('\x0c');
  await until(() => screen.viewport.includes('Session Tree · labeled'));
  terminal.write('\x05');
  await until(() => screen.viewport.includes('No matching tasks'));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(screen.viewport.includes('Session Tree'), 'an empty filter does not close the tree');
  terminal.write('\x01');
  await until(() => screen.viewport.includes('Session Tree · all'));

  terminal.write('\x1b');
  await until(() => !screen.viewport.includes('Session Tree'));
  terminal.write('HOLD tree focus\r');
  await until(() => held.has('HOLD tree focus'));
  terminal.write('/tree\r');
  await until(() => screen.viewport.includes('Session Tree'));
  terminal.write('\x12');
  await until(() => screen.viewport.includes('Session Tree · running'));
  held.get('HOLD tree focus')();
  await until(() => !held.has('HOLD tree focus') && screen.viewport.includes(' · ready'));
  terminal.write('\x05');
  await until(() => screen.viewport.includes('Session Tree · errors'));
  terminal.write('\x01\x1b');
  await until(() => !screen.viewport.includes('Session Tree'));
  terminal.write('/model\r');
  await until(() => screen.viewport.includes('Select model'));
  terminal.write('CLI Test\r');
  await until(() => screen.viewport.includes('Model: cli-local/cli-model'));
  // A terminal resize must reflow the editor, transcript and footer correctly.
  screen.resize(44, 24);
  await until(() => screen.viewport.includes('PiX') || screen.text.includes('DONE interactive first'));
  terminal.write('/help\r');
  await until(() => screen.text.includes('ctrl+o expand tools'));
  screen.resize(100, 30);
  terminal.write(`/node ${tuiRoot}\r`);
  await until(() => screen.viewport.includes('Continue from: WRITE TUI root'));
  terminal.write('HOLD interactive\r');
  await until(() => held.has('HOLD interactive'));
  terminal.write('draft while busy\r');
  await until(() => screen.viewport.includes('your draft stays in the editor') && screen.viewport.includes('draft while busy'));
  assert.ok(!requests.some(request => request.text === 'draft while busy'));
  terminal.write('\x03');
  await until(() => !held.has('HOLD interactive'));
  await until(() => (screen.viewport.includes('interrupted') || screen.viewport.includes('aborted')) && screen.viewport.includes(' · ready'));
  terminal.write('\x03');
  await until(() => !screen.viewport.includes('draft while busy'));
  console.error('TUI dialogs');
  terminal.write('/cli-input\r');
  await until(() => screen.viewport.includes('CLI input test'));
  terminal.write('TUI accepted\r');
  await until(() => screen.viewport.includes('Ready'));
  assert.equal((await cli(['dialogs'])).events[0].length, 0);
  terminal.write('/cli-confirm\r');
  await until(() => screen.viewport.includes('CLI confirm test'));
  terminal.write('\r');
  await until(() => existsSync(join(cwd, 'confirmation.txt')) && screen.viewport.includes(' · ready'));
  assert.equal(readFileSync(join(cwd, 'confirmation.txt'), 'utf8'), 'false', 'confirmation defaults to cancellation');
  terminal.write('/cli-select\r');
  await until(() => screen.viewport.includes('CLI select test'));
  terminal.write('\x1b[B\r');
  await until(() => existsSync(join(cwd, 'selection.txt')) && screen.viewport.includes(' · ready'));
  assert.equal(readFileSync(join(cwd, 'selection.txt'), 'utf8'), 'second');
  console.error('TUI input and tools');
  terminal.write('\x1b[200~中文 input\nsecond line\x1b[201~\r');
  await until(() => requests.some(request => request.text === '中文 input\nsecond line'));
  await until(() => screen.text.includes('DONE 中文 input') && screen.viewport.includes(' · ready'));
  terminal.write('WRITE TUI tools\r');
  await until(() => screen.text.includes('DONE WRITE TUI tools') && screen.viewport.includes(' · ready'));
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  writeFileSync(join(root, 'artifacts/cli-tui-screen.txt'), screen.viewport);
  console.error('TUI detachment');
  terminal.write('HOLD TUI detach\r');
  await until(() => held.has('HOLD TUI detach'));
  terminal.write('/exit\r');
  assert.equal((await terminalExit).exitCode, 0);
  assert.ok(held.has('HOLD TUI detach'), 'TUI exit detaches without cancelling its task');
  held.get('HOLD TUI detach')();
  screen.dispose(); screen = undefined;
  terminal = undefined;
  console.error('Actual Electron');
  // Actual Electron GUI uses the very same host and sees CLI-created branches.
  gui = await openGui();
  await until(() => gui.evaluate(`window.__pixTest?.state().project?.path === ${JSON.stringify(cwd)} && !window.__pixTest.state().loading`));
  await gui.evaluate(`window.__pixTest.openSession(${JSON.stringify(path)})`);
  const open = await gui.evaluate(`window.pix.invoke('session.snapshot')`);
  assert.ok(open.projection.nodes.some(node => node.id === nested.nodeId));
  await gui.evaluate(`window.hostEvents=[]; window.pix.onEvent(e=>window.hostEvents.push(e)); true`);
  // Real GUI menu -> label dialog -> shared Host -> CLI, then reverse direction.
  const card = `[data-id="${rootNode}"] .prompt-node`;
  await until(() => gui.evaluate(`Boolean(document.querySelector(${JSON.stringify(card)})) && !document.querySelector('.booting')`));
  const point = await gui.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(card)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+15}})()`);
  await gui.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', clickCount: 1, ...point });
  await gui.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', clickCount: 1, ...point });
  await until(() => gui.evaluate(`Boolean(document.querySelector('[data-action="node-edit-label"]'))`));
  await gui.evaluate(`document.querySelector('[data-action="node-edit-label"]').click()`);
  await until(() => gui.evaluate(`Boolean(document.querySelector('[data-action="node-label-input"]'))`));
  await gui.send('Input.insertText', { text: 'GUI bookmark' });
  await gui.evaluate(`document.querySelector('[data-action="node-label-save"]').click()`);
  await until(() => gui.evaluate(`!document.querySelector('[data-action="node-label-input"]')`));
  assert.equal((await cli(['tree', path, '--json'])).events[0].snapshot.projection.nodes.find(n => n.id === rootNode)?.label, 'GUI bookmark');
  // Saving a label changes the card height and may move it. Select from its
  // current bounds rather than reusing the pre-edit context-menu coordinates.
  await gui.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const selectionPoint = await gui.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(card)}).getBoundingClientRect();return{x:r.x+25,y:r.y+15}})()`);
  await gui.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...selectionPoint });
  await gui.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...selectionPoint });
  await until(() => gui.evaluate(`document.querySelector(${JSON.stringify(card)}).classList.contains('selected')`));
  const primary = await gui.evaluate(`/Mac/i.test(navigator.platform)`) ? 4 : 2;
  await gui.send('Input.dispatchKeyEvent', { type:'keyDown', key:'L', code:'KeyL', windowsVirtualKeyCode:76, modifiers:primary | 8 });
  await gui.send('Input.dispatchKeyEvent', { type:'keyUp', key:'L', code:'KeyL', windowsVirtualKeyCode:76, modifiers:primary | 8 });
  await until(() => gui.evaluate(`document.querySelector('[data-action="node-label-input"]')?.value==='GUI bookmark'`));
  const shortcutPicture = await gui.send('Page.captureScreenshot');
  writeFileSync(join(root, 'artifacts/graph-label-shortcut-gui.png'), Buffer.from(shortcutPicture.data, 'base64'));
  await gui.send('Input.dispatchKeyEvent', { type:'keyDown', key:'a', code:'KeyA', windowsVirtualKeyCode:65, modifiers:primary });
  await gui.send('Input.dispatchKeyEvent', { type:'keyUp', key:'a', code:'KeyA', windowsVirtualKeyCode:65, modifiers:primary });
  await gui.send('Input.insertText', { text:'GUI shortcut bookmark' });
  await gui.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, text:'\r', unmodifiedText:'\r' });
  await gui.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 });
  await until(() => gui.evaluate(`!document.querySelector('[data-action="node-label-input"]')`));
  assert.equal((await cli(['tree', path, '--json'])).events[0].snapshot.projection.nodes.find(n => n.id === rootNode)?.label, 'GUI shortcut bookmark');

  await cli(['label', nested.nodeId, 'CLI branch bookmark', '--session', path]);
  await until(() => gui.evaluate(`window.hostEvents.some(e=>e.type==='sessions' && e.payload.current?.projection.nodes.some(n=>n.label==='CLI branch bookmark'))`));
  await gui.evaluate(`(()=>{const e=document.querySelector('[data-action="graph-filter"]');e.value='labeled';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(() => gui.evaluate(`document.querySelector('[data-action="graph-filter"]').value==='labeled'`));
  assert.equal((await cli(['tree', path, '--json', '--filter', 'labeled'])).events[0].matchingNodeIds.length, 2);
  await gui.send('Input.dispatchMouseEvent', {type:'mouseMoved', x:20, y:90});
  await new Promise(resolve => setTimeout(resolve, 600));
  const picture = await gui.send('Page.captureScreenshot');
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  writeFileSync(join(root, 'artifacts/graph-labels-gui.png'), Buffer.from(picture.data, 'base64'));
  await gui.evaluate(`(()=>{const e=document.querySelector('[data-action="graph-filter"]');e.value='all';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);

  // Main history must regain its label menu as soon as its own run settles,
  // even while a sibling keeps the graph's global delete guard active.
  const mainMenu = start(['run', 'HOLD main menu', '--session', path, '--json']);
  const otherMenu = start(['fork', rootNode, 'HOLD other menu', '--session', path, '--json']);
  await until(() => held.has('HOLD main menu') && held.has('HOLD other menu'));
  await until(() => gui.evaluate(`window.__pixTest.state().current?.graph.runs.filter(run=>run.status==='running').length===2`));
  async function openLabelMenu() {
    const menuPoint = await gui.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(card)}).getBoundingClientRect();return{x:r.x+25,y:r.y+15}})()`);
    await gui.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'right',clickCount:1,...menuPoint});
    await gui.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'right',clickCount:1,...menuPoint});
    await until(() => gui.evaluate(`Boolean(document.querySelector('[data-action="node-edit-label"]'))`));
  }
  async function dismissMenu() {
    await gui.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await gui.send('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await until(() => gui.evaluate(`!document.querySelector('[data-action="node-edit-label"]')`));
  }
  await openLabelMenu();
  assert.equal(await gui.evaluate(`document.querySelector('[data-action="node-edit-label"]').hasAttribute('data-disabled')`), true);
  await dismissMenu();
  held.get('HOLD main menu')(); await mainMenu.result;
  assert.ok(held.has('HOLD other menu'));
  await until(() => gui.evaluate(`window.__pixTest.state().current?.graph.runs.find(run=>run.branchId==='main')?.status==='idle'`));
  await openLabelMenu();
  await until(() => gui.evaluate(`!document.querySelector('[data-action="node-edit-label"]').hasAttribute('data-disabled')`));
  await dismissMenu();
  held.get('HOLD other menu')(); await otherMenu.result;
  const other = (await cli(['new', '--json'])).events[0].session.path;
  await cli(['run', 'other session', '--session', other, '--json']);
  assert.equal((await gui.evaluate(`window.pix.invoke('session.snapshot')`)).session.path, path, 'CLI selection does not move GUI');
  const failure = await cli(['run', 'FAIL', '--session', other, '--json'], undefined, 1);
  assert.ok(failure.events.some(event => event.type === 'error'));
  await cli(['run', 'recovered after model failure', '--session', other, '--json']);
  const input = await cli(['run', '/cli-input', '--session', other, '--json'], undefined, 1);
  assert.match(input.events.find(event => event.type === 'error').message, /needs input/);
  const pending = (await cli(['dialogs'])).events[0].find(dialog => dialog.title === 'CLI input test');
  assert.ok(pending.sessionPath);
  assert.equal((await cli(['respond', pending.id, 'accepted'])).events[0], true);
  assert.equal((await cli(['respond', pending.id, 'accepted'])).events[0], false, 'input requests finish only once');
  await until(async () => !(await cli(['host', 'status'])).events[0].running.length);
  await cli(['fork', rootNode, 'GUI live branch', '--session', path, '--json']);
  await until(() => gui.evaluate(`window.hostEvents.some(e=>e.type==='sessions' && e.payload.current?.projection.nodes.some(n=>n.title==='GUI live branch'))`));
  const guiPid = (await cli(['host', 'status'])).events[0].pid;
  assert.equal(guiPid, hostPid);
  console.error('A GUI-started');
  // A GUI-started run survives quitting the entire Electron process.
  await gui.evaluate(`window.pix.invoke('agent.control', {action:'promptAt', requestId:'gui-detach', nodeId:${JSON.stringify(rootNode)}, text:'HOLD GUI quit'})`);
  await until(() => held.has('HOLD GUI quit'));
  const guiQuit = async () => {
    try { await gui.evaluate("void window.pix.invoke('app.quit'); true"); } catch {}
    gui?.close(); gui = undefined;
  };
  const exited = new Promise(resolve => desktop.once('exit', resolve));
  await guiQuit(); await exited; desktop = undefined;
  assert.ok(held.has('HOLD GUI quit'));
  // Reopen while the model is silent: saved progress must appear without a
  // new token, and reconnecting must never submit the prompt again.
  gui = await openGui();
  await gui.evaluate(`window.hostEvents=[]; window.pix.onEvent(e=>window.hostEvents.push(e)); true`);
  await gui.evaluate(`window.__pixTest.openSession(${JSON.stringify(path)})`);
  await until(() => gui.evaluate(`window.hostEvents.some(e=>e.type==='agent' && e.payload.type==='message_update' && JSON.stringify(e.payload.message).includes('Waiting.'))`));
  assert.equal(requests.filter(request => request.text === 'HOLD GUI quit').length, 1);
  const reopenedExit = new Promise(resolve => desktop.once('exit', resolve));
  await guiQuit(); await reopenedExit; desktop = undefined;
  held.get('HOLD GUI quit')();
  await until(async () => !(await cli(['host', 'status'])).events[0].running.length);
  console.error('Stop/restart');
  // Stop/restart persists the full tree and releases its owner lock.
  const beforeRestart = (await cli(['tree', path, '--json'])).events[0].snapshot.projection.nodes.map(n => n.id).sort();
  await cli(['host', 'stop']);
  await until(() => { try { process.kill(hostPid, 0); return false; } catch { return true; } });
  // Start the bundled Electron host first, then attach the standalone CLI.
  gui = await openGui();
  const reopened = await gui.evaluate(`window.pix.invoke('session.open', {path:${JSON.stringify(path)}})`);
  if (reopened.graph?.storageError || reopened.graph?.runs.some(run => run.error)) console.error(JSON.stringify({home, storageError:reopened.graph?.storageError, errors:reopened.graph?.runs.filter(run=>run.error).map(run=>run.error)}));
  const exported = await gui.evaluate(`window.pix.invoke('agent.control', {action:'exportJsonl'})`);
  assert.ok(readFileSync(exported.path, 'utf8').includes('GUI live branch'));
  const afterRestart = (await cli(['tree', path, '--json'])).events[0].snapshot.projection.nodes.map(n => n.id).sort();
  assert.deepEqual(afterRestart, beforeRestart);
  const restoredLabels = (await cli(['tree', path, '--json', '--filter', 'labeled'])).events[0];
  assert.equal(restoredLabels.matchingNodeIds.length, 2);
  assert.ok(readFileSync(exported.path, 'utf8').includes('CLI branch bookmark'));
  await cli(['label', nested.nodeId, '--session', path]);
  assert.equal((await cli(['tree', path, '--json', '--filter', 'labeled'])).events[0].matchingNodeIds.length, 1);

  hostPid = (await cli(['host', 'status'])).events[0].pid;
  const guiExit = new Promise(resolve => desktop.once('exit', resolve));
  await gui.evaluate("void window.pix.invoke('app.quit'); true");
  gui.close(); gui = undefined;
  await guiExit; desktop = undefined;
  await cli(['host', 'stop']);
  console.log(JSON.stringify({ passed: true, cases: ['cold-start race', 'automatic retry success', 'running main request deduplication', 'live node admission', 'real SDK write tool', 'parallel CLI branches', 'independent stop', 'branch context isolation', 'nested branch', 'detach and request deduplication', 'interactive PTY and Ctrl+C', 'model error recovery', 'one-shot extension input', 'GUI/CLI shared host', 'independent client views', 'GUI live updates', 'GUI quit preserves run', 'GUI reopen restores silent stream without replay', 'restart persistence'],
    tuiChecks: ['tree stays focused after a running task settles', 'tree label editing and empty filters', 'GUI menu label editing', 'native GUI label shortcut and Enter to save', 'label menu restores while sibling keeps running', 'bidirectional GUI/CLI labels', 'restart and export labels', 'native tree search and fold/unfold', 'model fuzzy search', 'narrow terminal resize', 'draft preservation',
      'cancel and continue', 'native input/select/confirm dialogs', 'confirmation defaults to cancel', 'CJK multiline paste',
      'native tool cards', 'exit preserves accepted work'], modelRequests: requests.length, home }));
} finally {
  if (screen) {
    mkdirSync(join(root, 'artifacts'), { recursive: true });
    writeFileSync(join(root, 'artifacts/cli-tui-last-screen.txt'), screen.viewport);
    writeFileSync(join(root, 'artifacts/cli-tui-last.raw'), screen.raw);
  }
  screen?.dispose(); terminal?.kill(); gui?.close(); desktop?.kill('SIGTERM');
  for (const child of children) child.kill('SIGTERM');
  for (const release of held.values()) release();
  if (hostPid) {
    try { process.kill(hostPid, 'SIGTERM'); } catch {}
    await until(() => !existsSync(join(home, '.pix', 'run', 'host.json')), 5000).catch(error => console.error(`Host cleanup: ${error.message}`));
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (!process.env.PIX_KEEP_TEST_HOME) rmSync(home, { recursive: true, force: true });
}
