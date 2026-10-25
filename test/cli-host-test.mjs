// End-to-end: real CLI processes, WebSocket transport, Pi SDK and filesystem tools.
// A deterministic HTTP model controls scheduling; no external credentials needed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { electronBinary } from './lib/electron-binary.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'pix-cli-e2e-'));
const cwd = join(home, 'workspace');
const agent = join(home, '.pix', 'agent');
mkdirSync(cwd); mkdirSync(agent, { recursive: true });
mkdirSync(join(agent, 'extensions'));
writeFileSync(join(agent, 'extensions', 'cli-input.ts'), `export default function(pi) {
  pi.registerCommand('cli-input', {handler: async (_args, ctx) => {
    const value = await ctx.ui.input('CLI input test');
    ctx.ui.notify('Answered: ' + value);
  }});
}`);
const env = { ...process.env, PIX_HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PIX_HOST_LINGER_MS: '60000' };
const held = new Map();
const requests = [];
const children = new Set();
let desktop, gui, hostPid, terminal;
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
  await until(() => evaluate('Boolean(window.pix)'));
  return { evaluate, close: () => socket.close() };
}
try {
  console.error('Concurrent cold starts');
  // Concurrent cold starts must discover exactly one host.
  await Promise.all([cli(['sessions', '--json']), cli(['sessions', '--json']), cli(['sessions', '--json'])]);
  const status = (await cli(['host', 'status'])).events[0]; hostPid = status.pid;
  assert.equal(status.sessions, 0);
  const initial = final(await cli(['run', 'WRITE root', '--json']));
  assert.ok(initial, 'run returns a settled result');
  const path = initial.session, rootNode = initial.nodeId;
  assert.equal(readFileSync(join(cwd, 'agent-output.txt'), 'utf8'), 'written by the real Pi write tool\n');
  assert.ok(initial.snapshot.entries.some(entry => entry.message?.role === 'toolResult'));
  assert.equal((await cli(['host', 'status'])).events[0].pid, hostPid);
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
  // A real terminal exercises readline, branch following and Ctrl+C.
  const { spawn: spawnPty } = await import('node-pty');
  terminal = spawnPty(process.execPath, [join(root, 'bin/pix.mjs'), '--cwd', cwd, 'chat', '--session', path], {
    cwd: root, env, cols: 100, rows: 30, name: 'xterm-256color',
  });
  let terminalText = '';
  terminal.onData(chunk => terminalText += chunk);
  const terminalExit = new Promise(resolve => terminal.onExit(resolve));
  await until(() => terminalText.includes('pix>'));
  terminal.write('interactive first\r');
  await until(() => terminalText.includes('DONE interactive first'));
  terminal.write(`/node ${rootNode}\r`);
  await new Promise(resolve => setTimeout(resolve, 100));
  terminal.write('HOLD interactive\r');
  await until(() => held.has('HOLD interactive'));
  const promptsBeforeAbort = (terminalText.match(/pix>/g) ?? []).length;
  terminal.write('\x03');
  await until(() => !held.has('HOLD interactive'));
  await until(() => (terminalText.match(/pix>/g) ?? []).length > promptsBeforeAbort);
  terminal.write('/exit\r');
  assert.equal((await terminalExit).exitCode, 0);
  terminal = undefined;
  console.error('Actual Electron');
  // Actual Electron GUI uses the very same host and sees CLI-created branches.
  gui = await openGui();
  const open = await gui.evaluate(`window.pix.invoke('session.open', {path:${JSON.stringify(path)}})`);
  assert.ok(open.projection.nodes.some(node => node.id === nested.nodeId));
  await gui.evaluate(`window.hostEvents=[]; window.pix.onEvent(e=>window.hostEvents.push(e)); true`);
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
  held.get('HOLD GUI quit')();
  await until(async () => !(await cli(['host', 'status'])).events[0].running.length);
  console.error('Stop/restart');
  // Stop/restart persists the full tree and releases its owner lock.
  const beforeRestart = (await cli(['tree', path, '--json'])).events[0].snapshot.projection.nodes.map(n => n.id).sort();
  await cli(['host', 'stop']);
  await until(() => { try { process.kill(hostPid, 0); return false; } catch { return true; } });
  // Start the bundled Electron host first, then attach the standalone CLI.
  gui = await openGui();
  await gui.evaluate(`window.pix.invoke('session.open', {path:${JSON.stringify(path)}})`);
  const exported = await gui.evaluate(`window.pix.invoke('agent.control', {action:'exportJsonl'})`);
  assert.ok(readFileSync(exported.path, 'utf8').includes('GUI live branch'));
  const afterRestart = (await cli(['tree', path, '--json'])).events[0].snapshot.projection.nodes.map(n => n.id).sort();
  assert.deepEqual(afterRestart, beforeRestart);
  hostPid = (await cli(['host', 'status'])).events[0].pid;
  const guiExit = new Promise(resolve => desktop.once('exit', resolve));
  await gui.evaluate("void window.pix.invoke('app.quit'); true");
  gui.close(); gui = undefined;
  await guiExit; desktop = undefined;
  await cli(['host', 'stop']);
  console.log(JSON.stringify({ passed: true, cases: ['cold-start race', 'real SDK write tool', 'parallel CLI branches', 'independent stop', 'branch context isolation', 'nested branch', 'detach and request deduplication', 'interactive PTY and Ctrl+C', 'model error recovery', 'one-shot extension input', 'GUI/CLI shared host', 'independent client views', 'GUI live updates', 'GUI quit preserves run', 'restart persistence'], modelRequests: requests.length, home }));
} finally {
  terminal?.kill(); gui?.close(); desktop?.kill('SIGTERM');
  for (const child of children) child.kill('SIGTERM');
  for (const release of held.values()) release();
  if (hostPid) { try { process.kill(hostPid, 'SIGTERM'); } catch {} }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (!process.env.PIX_KEEP_TEST_HOME) rmSync(home, { recursive: true, force: true });
}
