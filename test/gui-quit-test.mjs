// Real main-process quit flow. Only the native dialog response is controlled;
// both windows, host, shell command and shutdown signals run normally.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { electronBinary } from './lib/electron-binary.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const peerQuitRounds = Number(process.env.PIX_QUIT_TEST_ROUNDS ?? 1);
assert.ok(Number.isInteger(peerQuitRounds) && peerQuitRounds >= 1 && peerQuitRounds <= 20);
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
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path');
// These include deliberately stuck recovery states; keep them off the user's desktop.
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
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
async function launch(name, hostEntry = '', recovery = false, ready = true) {
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
  if (!ready) {
    await until(() => rpc.evaluate('Boolean(window.pix) && document.readyState === "complete"'));
    return { child, rpc, dir };
  }
  try {
    await until(async () => {
      const state = await rpc.evaluate("({loading:window.__pixTest?.state().loading, recovery:Boolean(window.__pixTest?.state().hostRecovery), shell:Boolean(document.querySelector('.shell'))})");
      assert.ok(recovery || !state.recovery, 'normal startup must not enter host recovery');
      return state.loading === false && (recovery ? state.recovery : state.shell);
    });
  } catch (cause) {
    const state = await rpc.evaluate("({loading:window.__pixTest?.state().loading, recovery:window.__pixTest?.state().hostRecovery, shell:Boolean(document.querySelector('.shell'))})").catch(() => null);
    throw new Error(`PiX test view did not initialize (${name}): ${JSON.stringify(state)}\n${errors}`, { cause });
  }
  return { child, rpc, dir };
}

let hostPid;
try {
  const startingEntry = join(home, 'starting-host.mjs');
  const startingMarker = join(home, 'host-starting'), startGate = join(home, 'allow-host-start');
  writeFileSync(startingEntry, `
    import { existsSync, writeFileSync } from 'node:fs';
    import { serveLocalHost } from ${JSON.stringify(new URL('../server/dist/host/local-host.js', import.meta.url).href)};
    writeFileSync(${JSON.stringify(startingMarker)}, String(process.pid));
    while (!existsSync(${JSON.stringify(startGate)})) await new Promise(resolve => setTimeout(resolve, 25));
    await serveLocalHost();
  `);
  const starting = await launch('quit-during-startup', startingEntry, false, false);
  await until(() => existsSync(startingMarker));
  hostPid = Number(readFileSync(startingMarker, 'utf8'));
  assert.equal(existsSync(addressFile), false);
  await starting.rpc.evaluate("void window.pix.invoke('app.quit'); true");
  await delay(200);
  writeFileSync(startGate, 'ready');
  await until(() => starting.child.exitCode !== null && !alive(hostPid) && !existsSync(addressFile));
  assert.equal(existsSync(join(starting.dir, '1.prompt.json')), false, 'quitting during idle startup needs no retry dialog');

  for (let round = 0; round < peerQuitRounds; round++) {
    const first = await launch(`first-${round}`), second = await launch(`second-${round}`);
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
    await until(() => first.child.exitCode !== null && second.child.exitCode !== null).catch(error => {
      const details = [first, second].map(item => ({ exitCode: item.child.exitCode, signal: item.child.signalCode,
        prompts: readdirSync(item.dir).filter(name => name.endsWith('.prompt.json'))
          .map(name => JSON.parse(readFileSync(join(item.dir, name), 'utf8'))) }));
      const log = join(home, '.pix/log/main.log');
      throw new Error(`${error.message}\n${JSON.stringify(details)}\n${existsSync(log) ? readFileSync(log, 'utf8') : ''}`, { cause: error });
    });
    assert.equal(existsSync(join(second.dir, '1.answer')), false,
      'confirmed full quit must dismiss another window\'s pending confirmation without needing an answer');
    await until(() => !existsSync(addressFile) && !alive(hostPid));
    await delay(500);
    assert.equal(existsSync(addressFile), false, 'peer windows must not respawn the background host');
  }

  // Starting a window during normal idle cleanup must continue automatically.
  const drainingEntry = join(home, 'draining-host.mjs'), drainingMarker = join(home, 'draining-started');
  writeFileSync(drainingEntry, `
    import { existsSync, writeFileSync } from 'node:fs';
    import { serveLocalHost } from ${JSON.stringify(new URL('../server/dist/host/local-host.js', import.meta.url).href)};
    const host = await serveLocalHost();
    const close = host.owner.closeAll.bind(host.owner);
    host.owner.closeAll = async () => {
      if (!existsSync(${JSON.stringify(drainingMarker)})) {
        writeFileSync(${JSON.stringify(drainingMarker)}, 'cleaning');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      return close();
    };
  `);
  const draining = spawn(process.execPath, [drainingEntry], {
    env: { ...process.env, PIX_HOME: home, PI_CODING_AGENT_DIR: join(home, '.pix/agent'), PI_OFFLINE: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  processes.push(draining);
  await until(() => existsSync(addressFile));
  const drainingManager = await new Rpc(`ws://127.0.0.1:${address().port}/?token=${encodeURIComponent(address().token)}`).open();
  connections.push(drainingManager);
  await drainingManager.send('shutdown', {}, true);
  await until(() => existsSync(drainingMarker));
  const continued = await launch('normal-cleanup', drainingEntry);
  hostPid = address().pid;
  assert.notEqual(hostPid, draining.pid);
  assert.equal(await continued.rpc.evaluate("window.__pixTest.state().hostRecovery"), null);
  assert.equal(existsSync(join(continued.dir, '1.prompt.json')), false);
  await continued.rpc.evaluate("void window.pix.invoke('app.quit'); true").catch(() => {});
  await until(() => continued.child.exitCode !== null && !alive(hostPid) && !existsSync(addressFile));

  // Cleanup finishes just after Quit times out. Waiting for the user's retry
  // decision must not restart the stopped host or reconnect the desktop.
  const delayedQuitEntry = join(home, 'delayed-quit-host.mjs'), delayedQuitMarker = join(home, 'delayed-quit-started');
  writeFileSync(delayedQuitEntry, `
    import { existsSync, writeFileSync } from 'node:fs';
    import { serveLocalHost } from ${JSON.stringify(new URL('../server/dist/host/local-host.js', import.meta.url).href)};
    const host = await serveLocalHost();
    const close = host.owner.closeAll.bind(host.owner);
    host.owner.closeAll = async () => {
      if (!existsSync(${JSON.stringify(delayedQuitMarker)})) {
        writeFileSync(${JSON.stringify(delayedQuitMarker)}, 'cleaning');
        await new Promise(resolve => setTimeout(resolve, 13000));
      }
      return close();
    };
  `);
  const delayedQuit = await launch('delayed-quit', delayedQuitEntry);
  hostPid = address().pid;
  const delayedQuitPid = hostPid;
  await delayedQuit.rpc.evaluate("void window.pix.invoke('app.quit'); true");
  await until(() => existsSync(join(delayedQuit.dir, '1.prompt.json')), 15000);
  assert.equal(JSON.parse(readFileSync(join(delayedQuit.dir, '1.prompt.json'), 'utf8')).message, 'The background host has not stopped');
  await until(() => !existsSync(addressFile) && !alive(delayedQuitPid), 5000);
  await delay(500);
  assert.equal(existsSync(addressFile), false, 'the pending quit must not spawn another host');
  assert.equal(delayedQuit.child.exitCode, null);
  writeFileSync(join(delayedQuit.dir, '1.answer'), '1');
  await until(() => delayedQuit.child.exitCode !== null && !existsSync(addressFile));
  assert.equal(existsSync(join(delayedQuit.dir, '2.prompt.json')), false, 'retrying the completed shutdown must finish directly');

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
  await until(() => existsSync(join(third.dir, '1.prompt.json')), 15000);
  const failure = JSON.parse(readFileSync(join(third.dir, '1.prompt.json'), 'utf8'));
  assert.equal(failure.message, 'The background host has not stopped');
  writeFileSync(join(third.dir, '1.answer'), '0');
  // The failed controller attempt should show recovery without another full
  // connection timeout in the renderer.
  await until(() => third.rpc.evaluate("window.__pixTest?.state().hostRecovery?.host?.verified === true && window.__pixTest.state().hostRecovery.host.stopping === true"), 45000);
  assert.equal(await third.rpc.evaluate("document.querySelector('[data-action=host-force]').disabled"), false);
  await third.rpc.evaluate("document.querySelector('[data-action=host-force]').click()");
  await until(() => third.rpc.evaluate("Boolean(document.querySelector('[data-action=host-force-confirm]'))"));
  assert.equal(await third.rpc.evaluate("document.querySelector('[data-action=host-force-confirm]').textContent.includes('Stop tasks')"), false);
  await third.rpc.evaluate("document.querySelector('[data-action=host-force-confirm]').click()");
  await until(() => third.rpc.evaluate("window.__pixTest?.state().hostRecovery === null && window.__pixTest.state().loading === false"));
  hostPid = address().pid;
  assert.notEqual(hostPid, stuckPid);
  assert.equal(alive(stuckPid), false);
  await third.rpc.evaluate("void window.pix.invoke('app.quit'); true").catch(() => {});
  await until(() => third.child.exitCode !== null && !alive(hostPid) && !existsSync(addressFile));
  // An unattached recovery window cannot receive host.shutdown. Once the
  // installer owns the stopped profile, native Quit must bypass that lock.
  const incompatibleEntry = join(home, 'incompatible-host.mjs');
  writeFileSync(incompatibleEntry, `
    import { writeFileSync } from 'node:fs';
    import { serveLocalHost, hostAddressFile } from ${JSON.stringify(new URL('../server/dist/host/local-host.js', import.meta.url).href)};
    const host = await serveLocalHost();
    writeFileSync(hostAddressFile(), JSON.stringify({...host.address, version:'999.0.0'}));
  `);
  // Publish the incompatible address before the GUI can inspect it. Launching
  // both together lets the GUI attach in the gap before the version rewrite.
  const incompatible = spawn(process.execPath, [incompatibleEntry], {
    env: { ...process.env, PIX_HOME: home, PI_CODING_AGENT_DIR: join(home, '.pix/agent'), PI_OFFLINE: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  processes.push(incompatible);
  let incompatibleErrors = ''; incompatible.stderr.on('data', value => incompatibleErrors += value);
  await until(() => {
    if (incompatible.exitCode !== null) throw new Error(`Incompatible host fixture exited: ${incompatibleErrors}`);
    try { return address().version === '999.0.0'; } catch { return false; }
  });
  const fourth = await launch('idle-recovery', incompatibleEntry, true);
  hostPid = address().pid;
  const installing = join(home, '.pix/run/starting');
  mkdirSync(installing);
  writeFileSync(join(installing, 'pid'), String(process.pid));
  const manager = await new Rpc(`ws://127.0.0.1:${address().port}/?token=${encodeURIComponent(address().token)}`).open();
  await manager.send('shutdown', {}, true); manager.close();
  await until(() => !existsSync(addressFile) && !alive(hostPid));
  writeFileSync(join(installing, 'installer'), '00000000-0000-4000-8000-000000000001');
  if (process.platform === 'linux') fourth.child.kill('SIGTERM');
  else await fourth.rpc.evaluate("void window.pix.invoke('app.quit'); true").catch(() => {});
  await until(() => fourth.child.exitCode !== null, 5000);
  assert.equal(existsSync(join(fourth.dir, '1.prompt.json')), false, 'an idle installer quit must show no additional UI');
  assert.equal(existsSync(installing), true, 'the GUI must not release the native installer reservation');
  rmSync(installing, { recursive: true });
  assert.equal(existsSync(addressFile), false);
  console.log(JSON.stringify({ passed: true, peerQuitRounds, cancelPreservesWindowAndCommand: true, fullQuitClosesBothWindows: true, peerQuitPromptDismissed: true, hostProcessExited: true, noHostRespawn: true, idleCleanupContinuesAutomatically: true, failedQuitRetryWithoutRespawn: true, slowShutdownRemainsRecoverable: true, forcedRecoveryFromStuckCleanup: true, idleRecoveryQuitDuringInstall: true }));
} finally {
  for (const rpc of connections) rpc.close();
  for (const child of processes) if (child.exitCode === null) child.kill('SIGKILL');
  const cleanupPids = new Set([hostPid]);
  if (existsSync(addressFile)) { try { cleanupPids.add(address().pid); } catch {} }
  for (const pid of cleanupPids) if (pid && alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  if (existsSync(addressFile)) await until(() => !existsSync(addressFile), 10000).catch(() => {});
  rmSync(home, { recursive: true, force: true });
}
