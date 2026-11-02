import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareLinuxCliHooks } from '../scripts/linux-cli-hooks.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pix package hooks '));
  const stage = join(root, 'stage');
  const app = join(stage, 'opt/PiX');
  const receipt = join(root, 'receipt.json');
  const log = join(root, 'runtime.log');
  const bin = join(root, 'bin');
  prepareLinuxCliHooks(root);
  for (const path of [app, bin, join(stage, 'usr/bin'), join(stage, 'etc/apparmor.d')]) mkdirSync(path, { recursive: true });
  const executable = (path, body) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '#!/bin/sh\n' + body); chmodSync(path, 0o755); };
  const runtime = name => executable(join(app, name), 'printf \'%s\\n\' "$0" "$ELECTRON_RUN_AS_NODE" "$@" > "$PIX_TEST_LOG"\n' +
    'if [ "$PIX_TEST_SIGNAL" = 1 ]; then kill -TERM "$PPID"; fi\n' +
    'if [ "$PIX_TEST_FAIL" = 1 ]; then exit 7; fi\n' +
    'if [ "$2" = --finish ]; then rm -f "$PIX_TEST_RECEIPT"; fi\n');
  const script = name => readFileSync(join(root, name), 'utf8')
    .replaceAll('${sanitizedProductName}', 'PiX').replaceAll('${executable}', 'pix-desktop')
    .replaceAll('/opt/', `${stage}/opt/`).replaceAll('/usr/', `${stage}/usr/`)
    .replaceAll('/etc/apparmor.d', `${stage}/etc/apparmor.d`).replaceAll('/run/pix-install-guard.json', `"${receipt}"`);
  const run = (name, env = {}) => spawnSync('/bin/bash', ['-c', script(name)], { encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, DEBIAN_FRONTEND: 'noninteractive', PIX_TEST_LOG: log, PIX_TEST_RECEIPT: receipt, ...env } });
  return { root, stage, app, receipt, log, executable, runtime, script, run, bin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('Linux preinstall checks legacy and current executables, preserving helper failure and removing temporary code', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  try {
    assert.equal(f.run('before-install.sh').status, 0, 'a fresh installation needs no previous runtime');
    for (const current of [false, true]) {
      f.runtime('pix');
      if (current) f.runtime('pix-desktop');
      const result = f.run('before-install.sh');
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(f.log), 'legacy installations must also run the guard');
      const [runtime, nodeMode, helper, ...args] = readFileSync(f.log, 'utf8').trimEnd().split('\n');
      assert.equal(runtime, join(f.app, current ? 'pix-desktop' : 'pix'));
      assert.equal(nodeMode, '1');
      assert.equal(existsSync(dirname(helper)), false);
      assert.deepEqual(args.filter((_, i) => args[i - 1] === '--target'), [join(f.app, 'pix-desktop'), join(f.app, 'pix')]);
    }
    assert.equal(f.run('before-install.sh', { PIX_TEST_FAIL: '1' }).status, 7, 'a rejected check must stop installation');
    assert.equal(existsSync(dirname(readFileSync(f.log, 'utf8').split('\n')[2])), false);
  } finally { f.cleanup(); }
});

test('Linux preinstall cancellation signals fail the hook even when its runtime returns success', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  try {
    f.runtime('pix-desktop');
    const result = f.run('before-install.sh', { PIX_TEST_SIGNAL: '1' });
    assert.notEqual(result.status, 0, 'SIGTERM must not be swallowed by a cleanup trap');
    assert.equal(existsSync(dirname(readFileSync(f.log, 'utf8').split('\n')[2])), false);
  } finally { f.cleanup(); }
});

test('Linux postinstall always releases reservations and preserves builder and registration failures', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  try {
    f.runtime('pix-desktop');
    for (const name of ['update-alternatives', 'update-mime-database', 'update-desktop-database', 'apparmor_status']) f.executable(join(f.bin, name), 'exit 0\n');
    f.executable(join(f.bin, 'unshare'), 'exit 1\n');
    f.executable(join(f.bin, 'apparmor_parser'), 'if [ "$1" = --replace ]; then\n  if [ "$PIX_TEST_CANCEL" = 1 ]; then kill -TERM "$PPID"; fi\n  exit "${PIX_TEST_APPARMOR_STATUS:-0}"\nfi\n');
    f.executable(join(f.stage, 'usr/bin/ischroot'), 'exit 1\n');
    writeFileSync(join(f.app, 'chrome-sandbox'), 'sandbox');
    mkdirSync(join(f.app, 'resources/cli'), { recursive: true });
    writeFileSync(join(f.app, 'resources/apparmor-profile'), 'profile');
    writeFileSync(join(f.app, 'resources/cli/pix'), 'CLI');
    const link = join(f.stage, 'usr/bin/pix');
    for (const [scenario, status] of [['conflict', 1], ['builder failure', 17], ['cancelled', 1], ['success', 0], ['cleanup failure', 1]]) {
      if (existsSync(link)) rmSync(link);
      if (scenario === 'conflict') writeFileSync(link, 'foreign command');
      writeFileSync(f.receipt, 'reservation');
      const result = f.run('after-install.tpl', { PIX_TEST_APPARMOR_STATUS: scenario === 'builder failure' ? '17' : '0', PIX_TEST_FAIL: scenario === 'cleanup failure' ? '1' : '0', PIX_TEST_CANCEL: scenario === 'cancelled' ? '1' : '0' });
      assert.equal(result.status, status, `${scenario}: ${result.stderr}`);
      assert.ok(existsSync(f.log), `${scenario}: cleanup must run`);
      assert.ok(readFileSync(f.log, 'utf8').includes('\n--finish\n'));
      assert.equal(existsSync(f.receipt), scenario === 'cleanup failure', scenario);
      if (scenario === 'conflict') assert.equal(readFileSync(link, 'utf8'), 'foreign command');
      if (scenario === 'builder failure') assert.equal(existsSync(link), false, 'do not continue registration after builder failure');
      rmSync(f.log);
    }
  } finally { f.cleanup(); }
});
