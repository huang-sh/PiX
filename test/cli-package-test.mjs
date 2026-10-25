// Install the distributable into an empty directory, outside the repository.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'pix-cli-package-'));
const install = join(home, 'install'), cwd = join(home, 'workspace');
mkdirSync(install); mkdirSync(cwd);
const npm = join(dirname(process.execPath), 'npm');
let hostPid;
async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: home, env: { ...process.env, PIX_HOME: home, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '';
    child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Package test timed out: ${command}`)); }, 180000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); code ? reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`)) : resolve(stdout); });
  });
}
try {
  const packed = JSON.parse(await run(npm, ['pack', join(root, 'server'), '--json', '--pack-destination', home]));
  assert.ok(packed[0].files.some(file => file.path === 'dist/cli/index.js'));
  assert.ok(packed[0].files.some(file => file.path.startsWith('skills/')));
  await run(npm, ['install', '--prefix', install, join(home, packed[0].filename), '--omit=dev', '--no-audit', '--no-fund']);
  assert.equal(existsSync(join(install, 'node_modules/electron')), false);
  assert.equal(existsSync(join(install, 'node_modules/vue')), false);
  const entry = join(install, 'node_modules/@pix/server/bin/pix.mjs');
  assert.match(await run(process.execPath, [entry, '--help']), /shared agent host/);
  const rows = JSON.parse(await run(process.execPath, [entry, 'sessions', '--json', '--cwd', cwd]));
  assert.deepEqual(rows.sessions, []);
  const status = JSON.parse(await run(process.execPath, [entry, 'host', 'status', '--cwd', cwd])); hostPid = status.pid;
  const created = JSON.parse(await run(process.execPath, [entry, 'new', '--json', '--cwd', cwd]));
  assert.equal(created.type, 'session');
  const tree = JSON.parse(await run(process.execPath, [entry, 'tree', created.session.path, '--json', '--cwd', cwd]));
  assert.deepEqual(tree.snapshot.projection.nodes, []);
  await run(process.execPath, [entry, 'host', 'stop', '--cwd', cwd]);
  console.log(JSON.stringify({ passed: true, package: packed[0].filename, electron: false, vue: false, checks: ['clean npm install', 'CLI help', 'standalone host startup', 'new session', 'tree', 'host stop'] }));
} finally {
  if (!hostPid) { try { hostPid = JSON.parse(readFileSync(join(home, '.pix/run/host.json'), 'utf8')).pid; } catch {} }
  if (hostPid) { try { process.kill(hostPid, 'SIGTERM'); } catch {} }
  rmSync(home, { recursive: true, force: true });
}
