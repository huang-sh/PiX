// Real main-process quit flow. Only the native dialog response is controlled;
// both windows, host, shell command and shutdown signals run normally.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { electronBinary } from './lib/electron-binary.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'pix-full-quit-e2e-'));
const addressFile = join(home, '.pix/run/host.json');
const processes = [], connections = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(50); }
  throw new Error('Timed out waiting for full PiX quit');
}
class Rpc {
  constructor(url) {
    this.socket = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.socket.on('error', () => {});
    this.socket.on('message', data => {
      const message = JSON.parse(String(data)), job = this.pending.get(message.id);
      if (!job) return;
      this.pending.delete(message.id);
      message.error ? job.reject(new Error(JSON.stringify(message.error))) : job.resolve(message.result);
    });
    this.socket.on('close', () => { for (const job of this.pending.values()) job.reject(new Error('Closed')); this.pending.clear(); });
  }
  async open() { await once(this.socket, 'open'); return this; }
  send(method, params = {}, host = false) {
    const id = host ? String(++this.id) : ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(host ? { type: 'request', id, method, ...params } : { id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { this.socket.close(); }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const address = () => JSON.parse(readFileSync(addressFile, 'utf8'));
async function status() {
  const host = address();
  const rpc = await new Rpc(`ws://127.0.0.1:${host.port}/?token=${encodeURIComponent(host.token)}`).open();
  try { return await rpc.send('status', {}, true); }
  finally { rpc.close(); }
}

mkdirSync(join(home, '.pix/agent'), { recursive: true });
writeFileSync(join(home, '.pix/agent/settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }));
writeFileSync(join(home, '.pix/gui.settings.json'), JSON.stringify({ language: 'en', closeToTray: false }));
const wrapper = join(home, 'main.cjs');
writeFileSync(wrapper, `
const { app, dialog } = require('electron');
const fs = require('node:fs'), path = require('node:path');
app.getAppPath = () => ${JSON.stringify(root)};
let prompt = 0;
dialog.showMessageBox = async options => {
  const prefix = path.join(process.env.PIX_QUIT_TEST_DIR, String(++prompt));
  fs.writeFileSync(prefix + '.prompt.json', JSON.stringify(options));
  while (!fs.existsSync(prefix + '.answer')) {
    if (options.signal?.aborted) return { response: options.cancelId ?? 0, checkboxChecked: false };
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return { response: Number(fs.readFileSync(prefix + '.answer', 'utf8')), checkboxChecked: false };
};
import(${JSON.stringify(new URL('../out/main/index.js', import.meta.url).href)});
`);
async function launch(name, hostEntry = '') {
  const dir = join(home, name); mkdirSync(dir);
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(electronBinary(root), [wrapper, '--no-sandbox', '--disable-gpu', `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`], {
    env: { ...process.env, PIX_HOME: home, PIX_PROJECT: root, PI_CODING_AGENT_DIR: join(home, '.pix/agent'), PI_OFFLINE: '1', PIX_QUIT_TEST_DIR: dir, ELECTRON_RENDERER_URL: '', PIX_HOST_ENTRY: hostEntry },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  processes.push(child);
  let errors = ''; child.stderr.on('data', value => errors += value);
  let page;
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`PiX test main exited: ${errors}`);
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page => page.type === 'page'); return Boolean(page); } catch { return false; }
  });
  const rpc = await new Rpc(page.webSocketDebuggerUrl).open(); connections.push(rpc);
  await until(() => rpc.evaluate("window.__pixTest?.state().loading === false && Boolean(document.querySelector('.shell'))"));
  return { child, rpc, dir };
}

let hostPid;
try {
  const first = await launch('first'), second = await launch('second');
  hostPid = address().pid;
  await first.rpc.evaluate("void window.pix.invoke('shell.run', {command:'sleep 60'}).catch(() => {}); true");
  await until(async () => (await status()).commands === 1);
  await first.rpc.evaluate("void window.pix.invoke('app.quit'); true");
  await until(() => existsSync(join(first.dir, '1.prompt.json')));
  const prompt = JSON.parse(readFileSync(join(first.dir, '1.prompt.json'), 'utf8'));
  assert.equal(prompt.defaultId, 0);
  assert.match(prompt.detail, /Shell commands: 1/);
  writeFileSync(join(first.dir, '1.answer'), '0');
  await delay(200);
  assert.equal(first.child.exitCode, null, 'cancellation preserves the original GUI');
  assert.equal(second.child.exitCode, null);
  assert.equal(address().pid, hostPid);
  assert.equal((await status()).commands, 1, 'cancellation must leave the shell command running');
  await second.rpc.evaluate("void window.pix.invoke('app.quit'); true");
  await until(() => existsSync(join(second.dir, '1.prompt.json')));
  assert.equal(second.child.exitCode, null, 'a peer waiting for confirmation must remain open');
  await first.rpc.evaluate("void window.pix.invoke('app.quit'); true");
  await until(() => existsSync(join(first.dir, '2.prompt.json')));
  writeFileSync(join(first.dir, '2.answer'), '1');
  await until(() => first.child.exitCode !== null && second.child.exitCode !== null);
  assert.equal(existsSync(join(second.dir, '1.answer')), false,
    'confirmed full quit must dismiss another window\'s pending confirmation without needing an answer');
  await until(() => !existsSync(addressFile) && !alive(hostPid));
  await delay(500);
  assert.equal(existsSync(addressFile), false, 'peer windows must not respawn the background host');

  // One real host hangs during cleanup. Cancelling the failed quit must show
  // a verified recovery view, from which the user can explicitly force restart.
  const slowEntry = join(home, 'slow-host.mjs'), marker = join(home, 'cleanup-started');
  writeFileSync(slowEntry, `
    import { existsSync, writeFileSync } from 'node:fs';
    import { serveLocalHost } from ${JSON.stringify(new URL('../server/dist/host/local-host.js', import.meta.url).href)};
    const host = await serveLocalHost();
    const close = host.owner.closeAll.bind(host.owner);
    host.owner.closeAll = async () => {
      if (!existsSync(${JSON.stringify(marker)})) {
        writeFileSync(${JSON.stringify(marker)}, 'cleaning');
        await new Promise(() => {});
      }
      return close();
    };
  `);
  const third = await launch('slow-cleanup', slowEntry);
  hostPid = address().pid;
  const stuckPid = hostPid;
  await third.rpc.evaluate("void window.pix.invoke('app.quit'); true");
  await until(() => existsSync(join(third.dir, '1.prompt.json')));
  const failure = JSON.parse(readFileSync(join(third.dir, '1.prompt.json'), 'utf8'));
  assert.equal(failure.message, 'The background host has not stopped');
  writeFileSync(join(third.dir, '1.answer'), '0');
  await until(() => third.rpc.evaluate("window.__pixTest?.state().hostRecovery?.host?.verified === true && window.__pixTest.state().hostRecovery.host.stopping === true"));
  assert.equal(await third.rpc.evaluate("document.querySelector('[data-action=host-force]').disabled"), false);
  await third.rpc.evaluate("document.querySelector('[data-action=host-force]').click()");
  await until(() => third.rpc.evaluate("Boolean(document.querySelector('[data-action=host-force-confirm]'))"));
  await third.rpc.evaluate("document.querySelector('[data-action=host-force-confirm]').click()");
  await until(() => third.rpc.evaluate("window.__pixTest?.state().hostRecovery === null && window.__pixTest.state().loading === false"));
  hostPid = address().pid;
  assert.notEqual(hostPid, stuckPid);
  assert.equal(alive(stuckPid), false);
  await third.rpc.evaluate("void window.pix.invoke('app.quit'); true").catch(() => {});
  await until(() => third.child.exitCode !== null && !alive(hostPid) && !existsSync(addressFile));
  console.log(JSON.stringify({ passed: true, cancelPreservesWindowAndCommand: true, fullQuitClosesBothWindows: true, peerQuitPromptDismissed: true, hostProcessExited: true, noHostRespawn: true, slowShutdownRemainsRecoverable: true, forcedRecoveryFromStuckCleanup: true }));
} finally {
  for (const rpc of connections) rpc.close();
  for (const child of processes) if (child.exitCode === null) child.kill('SIGKILL');
  const cleanupPids = new Set([hostPid]);
  if (existsSync(addressFile)) { try { cleanupPids.add(address().pid); } catch {} }
  for (const pid of cleanupPids) if (pid && alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  if (existsSync(addressFile)) await until(() => !existsSync(addressFile), 10000).catch(() => {});
  rmSync(home, { recursive: true, force: true });
}
