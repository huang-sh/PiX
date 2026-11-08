import { chmodSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildInstallGuard } from './install-guard-bundle.mjs';

// Launch the CLI with the application's embedded runtime, never system Node.
export function writePackagedCli(resources, platform, executableName = 'PiX') {
  const dir = join(resources, 'cli');
  mkdirSync(dir, { recursive: true });
  const guard = new URL('../build/generated/install-guard.cjs', import.meta.url);
  if (existsSync(guard)) copyFileSync(guard, join(dir, 'install-guard.cjs'));
  else buildInstallGuard(dir);
  copyFileSync(new URL('../build/installer-helper.ps1', import.meta.url), join(dir, 'installer-helper.ps1'));
  if (platform === 'win32') {
    const path = join(dir, 'pix.cmd');
    writeFileSync(path, `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0..\\..\\${executableName}.exe" "%~dp0..\\app.asar\\out\\main\\pix-cli.js" %*\r\nexit /b %errorlevel%\r\n`);
    writeFileSync(join(dir, 'pixie.cmd'), `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0..\\..\\${executableName}.exe" "%~dp0..\\app.asar\\out\\main\\pix-cli.js" pixie %*\r\nexit /b %errorlevel%\r\n`);
    copyFileSync(new URL('../build/cli/path.ps1', import.meta.url), join(dir, 'path.ps1'));
    return path;
  }
  const path = join(dir, 'pix');
  const executable = platform === 'darwin' ? `../../MacOS/${executableName}` : `../../${executableName}`;
  const script = extra => `#!/bin/sh\n# PiX packaged CLI\nset -eu\nCLI_SCRIPT=$0\nwhile [ -L "$CLI_SCRIPT" ]; do\n  CLI_DIR=$(CDPATH= cd -- "$(dirname -- "$CLI_SCRIPT")" && pwd -P)\n  CLI_SCRIPT=$(readlink "$CLI_SCRIPT")\n  case "$CLI_SCRIPT" in /*) ;; *) CLI_SCRIPT=$CLI_DIR/$CLI_SCRIPT ;; esac\ndone\nCLI_DIR=$(CDPATH= cd -- "$(dirname -- "$CLI_SCRIPT")" && pwd -P)\nexport ELECTRON_RUN_AS_NODE=1\nexec "$CLI_DIR/${executable}" "$CLI_DIR/../app.asar/out/main/pix-cli.js" ${extra}"$@"\n`;
  writeFileSync(path, script(''));
  chmodSync(path, 0o755);
  const pixie = join(dir, 'pixie');
  writeFileSync(pixie, script('pixie '));
  chmodSync(pixie, 0o755);
  return path;
}
