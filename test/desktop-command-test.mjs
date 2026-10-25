// Actual packaged macOS application: first launch, fresh login shell, shared
// host, explicit cleanup, opt-out, and manual reinstall. No system files change.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
if (process.platform !== 'darwin') throw new Error('Run on macOS with a packaged PiX.app');
const app = resolve(process.argv[2] ?? 'release/cli-installation/mac/PiX.app');
const executable = join(app, 'Contents/MacOS/PiX');
const launcher = join(app, 'Contents/Resources/cli/pix');
// macOS's default temporary directory is too long for the bundled helper's
// Unix-domain socket (sockaddr_un limits it to 104 bytes).
const home = mkdtempSync('/tmp/pix-desktop-command-');
const workspace = join(home, 'workspace'); mkdirSync(workspace);
mkdirSync(join(home, '.pix/agent'), { recursive: true });
writeFileSync(join(home, '.pix/agent/settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }));
const original = 'export PIX_PRESERVED_CONFIG="kept"';
writeFileSync(join(home, '.zprofile'), original);
const env = { ...process.env, HOME: home, ZDOTDIR: home, PIX_HOME: home, PIX_PROJECT: workspace,
  PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', PI_OFFLINE: '1', ELECTRON_RENDERER_URL: '' };
let desktop, connection;
async function until(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out waiting for desktop command installation');
}
async function command(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
    child.once('error', reject);
    child.once('exit', code => code ? reject(new Error(`${file} exited ${code}: ${stderr}\n${stdout}`)) : resolve(stdout));
  });
}
async function open() {
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  desktop = spawn(executable, ['--no-sandbox', '--disable-gpu', `--user-data-dir=${join(home, 'electron')}`, `--remote-debugging-port=${port}`], { cwd: workspace, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; desktop.stderr.on('data', x => stderr += x);
  const page = await until(async () => {
    if (desktop.exitCode !== null) throw new Error(stderr);
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(page => page.type === 'page'); } catch {}
  });
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 0; const pending = new Map();
  ws.on('message', data => { const value = JSON.parse(data); if (value.id) { pending.get(value.id)?.(value); pending.delete(value.id); } });
  const evaluate = expression => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('Desktop evaluation timed out')); }, 10000);
    pending.set(key, value => {
      clearTimeout(timer);
      value.error || value.result?.exceptionDetails ? reject(new Error(JSON.stringify(value))) : resolve(value.result?.result?.value);
    });
    ws.send(JSON.stringify({ id: key, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  connection = ws;
  // Preload is available before loadFile completes. Wait for the rendered app
  // so a quick opt-out check cannot quit in the middle of window startup.
  await until(() => evaluate('Boolean(window.pix) && document.readyState === "complete" && Boolean(document.querySelector("#app")?.children.length)'));
  return evaluate;
}
async function close(evaluate) {
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Desktop did not quit normally')), 15000);
    desktop.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  await evaluate("void window.pix.invoke('app.quit'); true");
  connection.close(); connection = undefined;
  const result = await exited;
  assert.equal(result.code, 0, `Desktop exited with ${result.signal ?? result.code}`);
  desktop = undefined;
}
try {
  let evaluate = await open();
  const userCommand = join(home, '.pix/bin/pix');
  await until(() => existsSync(userCommand));
  // A fresh login shell loads the installed PATH; the app runs with no Node in PATH.
  const help = await command('/bin/zsh', ['-lic', 'command -v pix; pix --help; printf "\\nPRESERVED=%s\\n" "$PIX_PRESERVED_CONFIG"']);
  assert.ok(help.includes(userCommand)); assert.match(help, /shared agent host/); assert.match(help, /PRESERVED=kept/);
  assert.equal((await command('/bin/sh', ['-c', 'command -v node || true'])).trim(), '');
  const created = JSON.parse(await command(userCommand, ['new', '--json']));
  assert.equal(created.type, 'session');
  const status = JSON.parse(await command(userCommand, ['host', 'status']));
  assert.ok(status.clients >= 2, 'the CLI and GUI use one packaged host');
  await close(evaluate);
  assert.equal(JSON.parse(await command(userCommand, ['command', 'uninstall'])).installed, false);
  assert.equal(existsSync(userCommand), false);
  assert.equal(readFileSync(join(home, '.zprofile'), 'utf8'), original);
  assert.equal(existsSync(join(home, '.zshrc')), false);
  evaluate = await open();
  assert.equal(existsSync(userCommand), false, 'GUI respects explicit command removal');
  await close(evaluate);
  assert.equal(JSON.parse(await command(launcher, ['command', 'install'])).installed, true);
  assert.equal(JSON.parse(await command(userCommand, ['command', 'status'])).installed, true);
  await command(userCommand, ['host', 'stop']);
  await command(userCommand, ['command', 'uninstall']);
  const report = { passed: true, app, checks: ['actual packaged first launch', 'fresh zsh login PATH', 'no system Node', 'CLI/GUI shared host', 'cleanup preserves original shell file', 'explicit removal opt-out', 'manual reinstall'] };
  mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/desktop-command-test.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  connection?.close(); desktop?.kill('SIGKILL');
  try { const address = JSON.parse(readFileSync(join(home, '.pix/run/host.json'), 'utf8')); process.kill(address.pid, 'SIGTERM'); } catch {}
  // The bundled computer-use extension can start its own detached helper.
  // Shut down only the socket in this test's private HOME before removing it.
  const socket = join(home, 'Library/Caches/pi-computer-use/bridge.sock');
  if (existsSync(socket)) await new Promise(resolve => {
    const client = createConnection(socket);
    const timer = setTimeout(() => client.destroy(), 1500);
    client.on('error', () => client.destroy());
    client.on('connect', () => client.end(JSON.stringify({ id: 'cleanup', cmd: 'shutdown' }) + '\n'));
    client.on('close', () => { clearTimeout(timer); resolve(); });
  });
  rmSync(home, { recursive: true, force: true });
}
