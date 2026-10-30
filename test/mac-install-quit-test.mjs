// Exercise macOS's real graceful/forced application termination against an
// isolated fixture that refuses Quit. Never targets the user's installed app.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPackage } from '@electron/asar';
import { installedMacWindows } from '../out-test/src/main/mac-install.js';
import { withStoppedLocalHost } from '../out-test/src/host/client.js';

if (process.platform !== 'darwin') {
  console.log('macOS native installer quit test skipped on this platform');
  process.exit(0);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const home = mkdtempSync('/private/tmp/pix-native-quit-');
const appPath = join(home, 'PiX Quit Test.app'), ready = join(home, 'ready'), quitRequested = join(home, 'quit-requested');
const previousHome = process.env.PIX_HOME;
process.env.PIX_HOME = home;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error('Timed out waiting for native quit fixture');
}
let child;
try {
  execFileSync('/usr/bin/ditto', [join(root, 'node_modules/electron/dist/Electron.app'), appPath]);
  renameSync(join(appPath, 'Contents/MacOS/Electron'), join(appPath, 'Contents/MacOS/PiX'));
  const plist = join(appPath, 'Contents/Info.plist');
  for (const [key, value] of [['CFBundleExecutable', 'PiX'], ['CFBundleIdentifier', `works.earendil.pix.quit-test.${process.pid}`], ['CFBundleName', 'PiX Quit Test']])
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  const source = join(home, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'pix-native-quit-fixture', version: '1.0.0', main: 'main.cjs' }));
  writeFileSync(join(source, 'main.cjs'), `
    const { app } = require('electron');
    let waiting = false;
    app.on('before-quit', event => {
      require('node:fs').writeFileSync(${JSON.stringify(quitRequested)}, 'requested');
      if (!process.argv.includes('--allow-quit')) {
        event.preventDefault();
        if (!waiting) {
          waiting = true;
          setInterval(() => {
            if (!require('node:fs').existsSync(${JSON.stringify(join(home, '.pix/run/starting'))})) app.exit(0);
          }, 50);
        }
      }
    });
    app.whenReady().then(() => require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)));
  `);
  await createPackage(source, join(appPath, 'Contents/Resources/app.asar'));
  child = spawn(join(appPath, 'Contents/MacOS/PiX'), [`--user-data-dir=${join(home, 'user-data')}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', data => errors += data);
  await until(() => { if (child.exitCode !== null) throw new Error(errors); return existsSync(ready); });
  assert.equal(Number(readFileSync(ready, 'utf8')), child.pid);
  await withStoppedLocalHost(undefined, false, async () => {
    const windows = await installedMacWindows([appPath]);
    await assert.rejects(windows.quit(), /still closing/, 'normal installation must not force a window closed');
    assert.equal(existsSync(quitRequested), true, 'the native quit request must actually reach the app');
    assert.equal(alive(child.pid), true);
    await windows.quit(true);
    await until(() => !alive(child.pid));
    assert.equal(existsSync(join(home, '.pix/run/starting')), true, 'window termination must finish before releasing the installer lock');
  });
  rmSync(ready); rmSync(quitRequested);
  child = spawn(join(appPath, 'Contents/MacOS/PiX'), ['--allow-quit', `--user-data-dir=${join(home, 'responsive-user-data')}`], { stdio: ['ignore', 'ignore', 'ignore'] });
  await until(() => existsSync(ready));
  const responsive = await installedMacWindows([appPath]);
  await responsive.quit();
  assert.equal(existsSync(quitRequested), true);
  await until(() => !alive(child.pid));
  console.log(JSON.stringify({ passed: true, normalQuitPreservesUnresponsiveWindow: true, explicitForceClosesUnresponsiveWindow: true, normalQuitClosesResponsiveWindow: true, installerLockCannotDeadlockWindowQuit: true }));
} finally {
  if (child && alive(child.pid)) child.kill('SIGKILL');
  if (child) await until(() => !alive(child.pid), 5000).catch(() => {});
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.PIX_HOME;
  else process.env.PIX_HOME = previousHome;
}
