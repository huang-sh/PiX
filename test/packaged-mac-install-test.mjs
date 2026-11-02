// Validate a real DMG in an isolated installation directory. The production
// guard and native window shutdown run normally; only file-copy destination
// and dialog answers are supplied by the test. /Applications is untouched.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { offerMacInstall, installedMacWindows } from '../out-test/src/main/mac-install.js';
import { HostClient, localHostStatus, localHostInstallInProgress, stopLocalHost } from '../out-test/src/host/client.js';

if (process.platform !== 'darwin') throw new Error('Run this test on macOS');
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const dmg = resolve(process.argv[2] ?? `release/install-validation/PiX-${version}-x64.dmg`);
const root = mkdtempSync('/private/tmp/pix-packaged-install-');
const mount = join(root, 'image'), home = join(root, 'home'), workspace = join(root, 'workspace');
const installed = join(root, 'Applications', 'PiX.app');
const executable = join(installed, 'Contents/MacOS/PiX');
const cli = join(installed, 'Contents/Resources/cli/pix');
const addressFile = join(home, '.pix/run/host.json');
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const originalHome = process.env.PIX_HOME;
process.env.PIX_HOME = home;
const children = [], clients = [];
let mounted = false, desktop, moves = 0;
const env = { ...process.env, HOME: home, ZDOTDIR: home, PIX_HOME: home, PIX_PROJECT: workspace,
  PI_CODING_AGENT_DIR: join(home, '.pix/agent'), PI_OFFLINE: '1', PATH: '/usr/bin:/bin',
  SHELL: '/bin/zsh', ELECTRON_RENDERER_URL: '', PIX_HOST_ENTRY: '' };
delete env.ELECTRON_RUN_AS_NODE;
const alive = child => child && child.exitCode === null && child.signalCode === null;
async function until(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error('Timed out waiting for packaged installation');
}
async function launch() {
  desktop = spawn(executable, ['--no-sandbox', '--disable-gpu', `--user-data-dir=${join(home, 'electron')}`],
    { cwd: workspace, env, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(desktop);
  const child = desktop;
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  await until(async () => {
    if (!alive(child)) throw new Error(`Installed application exited: ${stderr}`);
    const status = await localHostStatus();
    return status.host?.verified && status.host.clients >= 1;
  });
}
async function windows() {
  const native = await installedMacWindows([installed]);
  return {
    quit: force => native.quit(force),
    // LaunchServices would discard the isolated environment on reopening.
    reopen: async () => { if (!alive(desktop)) await launch(); },
  };
}
async function copyApp() {
  assert.equal(localHostInstallInProgress(), true, 'replacement must hold the installer lock');
  assert.equal(existsSync(addressFile), false, 'the previous host must release its profile first');
  await until(() => !alive(desktop));
  rmSync(installed, { recursive: true, force: true });
  await exec('/usr/bin/ditto', [join(mount, 'PiX.app'), installed]);
  moves++;
}
// offerMacInstall's native move callback is synchronous like Electron's API.
// Prepare the copy in its async install callback, while keeping the real guard.
const { withStoppedLocalHost } = await import('../out-test/src/host/client.js');
async function install(answers = [], copy = true) {
  const prompts = [];
  const result = await offerMacInstall({ zh: false, windows,
    show: async prompt => { prompts.push(prompt); assert.ok(answers.length, `Unexpected dialog: ${prompt.message}`); return { response: answers.shift() }; },
    install: (id, force, job, quitClients, installer) => withStoppedLocalHost(id, force, async () => {
      // job closes the snapshotted windows before invoking move().
      const ready = await job();
      if (ready && copy) await copyApp();
      return ready;
    }, quitClients, installer),
    move: () => copy,
  });
  assert.equal(result, 'quit');
  assert.equal(answers.length, 0);
  assert.equal(existsSync(join(home, '.pix/run/starting')), false, 'all outcomes release the installation lock');
  return prompts;
}
async function connect() {
  const client = await HostClient.connect(JSON.parse(readFileSync(addressFile, 'utf8')), workspace);
  clients.push(client); return client;
}
try {
  for (const dir of [mount, workspace, join(home, '.pix/agent')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, '.pix/agent/settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }));
  await exec('/usr/bin/hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-mountpoint', mount], { timeout: 60000 });
  mounted = true;
  assert.ok(existsSync(join(mount, 'PiX.app/Contents/Resources/app.asar')));
  assert.ok(existsSync(join(mount, '安装说明 - Install PiX.txt')));
  assert.equal((await install()).length, 0, 'fresh install is silent');
  await launch();
  const created = JSON.parse((await exec(cli, ['new', '--json'], { cwd: workspace, env })).stdout);
  assert.equal(created.type, 'session');
  const savedSession = readFileSync(created.session.path);
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const packageDigest = digest(join(mount, 'PiX.app/Contents/Resources/app.asar'));
  writeFileSync(join(installed, 'obsolete-fixture'), 'previous installation');
  assert.equal((await install()).length, 0, 'idle upgrade must not ask to interrupt tasks');
  assert.equal(moves, 2);
  assert.equal(existsSync(join(installed, 'obsolete-fixture')), false);
  assert.equal(digest(join(installed, 'Contents/Resources/app.asar')), packageDigest);
  assert.deepEqual(readFileSync(created.session.path), savedSession);
  await launch();
  const client = await connect();
  const command = client.invoke('shell.run', { command: 'sleep 60' });
  void command.catch(() => {});
  await until(async () => (await localHostStatus()).host?.commands === 1);
  const pid = JSON.parse(readFileSync(addressFile, 'utf8')).pid;
  for (const answers of [[0], [2, 0]]) {
    await install(answers);
    assert.equal(moves, 2);
    assert.equal(JSON.parse(readFileSync(addressFile, 'utf8')).pid, pid);
    assert.equal((await localHostStatus()).host.commands, 1, 'cancellation preserves the running command');
    assert.ok(alive(desktop));
  }
  await install([2, 1]);
  await command.catch(() => {});
  assert.equal(moves, 3);
  assert.deepEqual(readFileSync(created.session.path), savedSession);
  await launch();
  const previous = desktop;
  const failed = await install([0], false);
  assert.equal(failed[0].message, 'Installation has not finished');
  assert.notEqual(desktop.pid, previous.pid, 'failed replacement restores the old application');
  assert.ok((await localHostStatus()).host?.verified);
  assert.deepEqual(readFileSync(created.session.path), savedSession);
  await stopLocalHost((await localHostStatus()).host.id, false, true, true);
  await until(() => !alive(desktop));
  const report = { passed: true, dmg, packageSha256: packageDigest, isolatedDestination: true,
    nativeMoveToApplicationsTested: false, checks: ['DMG mount and contents', 'fresh installation',
      'packaged launch and CLI session creation', 'idle upgrade without confirmation',
      'busy upgrade cancellation at both prompts', 'confirmed interruption and upgrade',
      'session preservation', 'failed replacement restores application', 'installation locks released'] };
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/packaged-mac-install-test.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await Promise.all(clients.map(client => client.close()));
  if (existsSync(addressFile)) {
    try { await stopLocalHost((await localHostStatus()).host.id, true, true, true); } catch {}
  }
  for (const child of children) if (alive(child)) child.kill('SIGKILL');
  await until(() => children.every(child => !alive(child)), 5000).catch(() => {});
  const socket = join(home, 'Library/Caches/pi-computer-use/bridge.sock');
  if (existsSync(socket)) await new Promise(resolve => {
    const client = createConnection(socket);
    const timer = setTimeout(() => client.destroy(), 1500);
    client.on('error', () => client.destroy());
    client.on('connect', () => client.end(JSON.stringify({ id: 'cleanup', cmd: 'shutdown' }) + '\n'));
    client.on('close', () => { clearTimeout(timer); resolve(); });
  });
  if (mounted) await exec('/usr/bin/hdiutil', ['detach', mount], { timeout: 30000 });
  rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = originalHome;
}
