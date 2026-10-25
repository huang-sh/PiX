import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writePackagedCli } from '../scripts/package-cli.mjs';
import { prepareLinuxCliHooks } from '../scripts/linux-cli-hooks.mjs';

test('packaged Unix launchers preserve arguments, exit status and symlink invocation without system Node', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), "pix-launchers-"));
  try {
    for (const platform of ['darwin', 'linux']) {
      const resources = join(root, `${platform} app ' space`, platform === 'darwin' ? 'Contents/Resources' : 'resources');
      const executable = platform === 'darwin' ? join(resources, '../MacOS/PiX') : join(resources, '../pix-desktop');
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, '#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = 1 ] || exit 99\nprintf \'%s\\n\' "$@"\nexit 7\n'); chmodSync(executable, 0o755);
      const cli = writePackagedCli(resources, platform, platform === 'darwin' ? 'PiX' : 'pix-desktop');
      const link = join(root, `pix-${platform}`); symlinkSync(cli, link);
      const result = spawnSync(link, ['run', 'space and $dollar', '--json'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
      assert.equal(result.status, 7, result.stderr);
      const [entry, ...args] = result.stdout.trimEnd().split('\n');
      assert.equal(resolve(entry), join(realpathSync(resources), 'app.asar/out/main/pix-cli.js'));
      assert.deepEqual(args, ['run', 'space and $dollar', '--json']);
    }
    const windows = join(root, 'windows/resources');
    const cmd = writePackagedCli(windows, 'win32');
    assert.match(readFileSync(cmd, 'utf8'), /setlocal\r\nset "ELECTRON_RUN_AS_NODE=1"/);
    assert.match(readFileSync(cmd, 'utf8'), /pix-cli\.js" %\*/);
    assert.ok(existsSync(join(windows, 'cli/path.ps1')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Linux installation hooks preserve builder behavior and only remove the owned CLI link', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pix-linux-hooks-'));
  try {
    prepareLinuxCliHooks(root);
    const install = readFileSync(join(root, 'after-install.tpl'), 'utf8');
    const remove = readFileSync(join(root, 'after-remove.tpl'), 'utf8');
    assert.match(install, /chrome-sandbox/); assert.match(install, /apparmor_parser/);
    assert.match(remove, /apparmor_parser/);
    const stage = join(root, 'stage'); mkdirSync(stage);
    const target = join(stage, 'opt/PiX/resources/cli/pix'); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, 'CLI');
    mkdirSync(join(stage, 'usr/bin'), { recursive: true });
    // Run only our hook extension, with package paths confined to the fixture.
    const customInstall = install.slice(install.indexOf('# Register the terminal command')).replaceAll('/usr/bin', `${stage}/usr/bin`).replaceAll('/opt/', `${stage}/opt/`).replaceAll('${sanitizedProductName}', 'PiX');
    const customRemove = remove.slice(remove.indexOf('# Leave a replacement')).replaceAll('/usr/bin', `${stage}/usr/bin`).replaceAll('/opt/', `${stage}/opt/`).replaceAll('${sanitizedProductName}', 'PiX');
    const run = script => spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8' });
    assert.equal(run(customInstall).status, 0);
    assert.equal(run(customInstall).status, 0);
    assert.equal(readFileSync(join(stage, 'usr/bin/pix'), 'utf8'), 'CLI');
    // Simulate an old RPM's post-uninstall removing the new link mid-upgrade.
    rmSync(join(stage, 'usr/bin/pix'));
    const posttrans = readFileSync(join(root, 'rpm-posttrans.sh'), 'utf8').replaceAll('/usr/bin', `${stage}/usr/bin`).replaceAll('/opt/', `${stage}/opt/`);
    assert.equal(run(posttrans).status, 0);
    assert.equal(readFileSync(join(stage, 'usr/bin/pix'), 'utf8'), 'CLI');
    assert.equal(run(customRemove).status, 0);
    assert.equal(existsSync(join(stage, 'usr/bin/pix')), false);
    writeFileSync(join(stage, 'usr/bin/pix'), 'foreign command');
    assert.notEqual(run(customInstall).status, 0);
    assert.equal(run(customRemove).status, 0);
    assert.equal(readFileSync(join(stage, 'usr/bin/pix'), 'utf8'), 'foreign command');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows packaged cmd launcher forwards quoted arguments and the runtime exit code', { skip: process.platform !== 'win32' }, async () => {
  const { copyFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'pix cmd test '));
  try {
    copyFileSync(process.execPath, join(root, 'PiX.exe'));
    const resources = join(root, 'resources');
    const entry = join(resources, 'app.asar/out/main/pix-cli.js');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(7);');
    const cli = writePackagedCli(resources, 'win32');
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cli}" run "hello & world" --json"`], { encoding: 'utf8', windowsVerbatimArguments: true });
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), ['run', 'hello & world', '--json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
