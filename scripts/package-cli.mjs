import { chmodSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

// Launch the CLI with the application's embedded runtime, never system Node.
export function writePackagedCli(resources, platform, executableName = 'PiX') {
  const dir = join(resources, 'cli');
  mkdirSync(dir, { recursive: true });
  if (platform === 'win32') {
    const path = join(dir, 'pix.cmd');
    writeFileSync(path, `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0..\\..\\${executableName}.exe" "%~dp0..\\app.asar\\out\\main\\pix-cli.js" %*\r\nexit /b %errorlevel%\r\n`);
    copyFileSync(new URL('../build/cli/path.ps1', import.meta.url), join(dir, 'path.ps1'));
    return path;
  }
  const path = join(dir, 'pix');
  const executable = platform === 'darwin' ? `../../MacOS/${executableName}` : `../../${executableName}`;
  writeFileSync(path, `#!/bin/sh\n# PiX packaged CLI\nset -eu\nCLI_SCRIPT=$0\nwhile [ -L "$CLI_SCRIPT" ]; do\n  CLI_DIR=$(CDPATH= cd -- "$(dirname -- "$CLI_SCRIPT")" && pwd -P)\n  CLI_SCRIPT=$(readlink "$CLI_SCRIPT")\n  case "$CLI_SCRIPT" in /*) ;; *) CLI_SCRIPT=$CLI_DIR/$CLI_SCRIPT ;; esac\ndone\nCLI_DIR=$(CDPATH= cd -- "$(dirname -- "$CLI_SCRIPT")" && pwd -P)\nexport ELECTRON_RUN_AS_NODE=1\nexec "$CLI_DIR/${executable}" "$CLI_DIR/../app.asar/out/main/pix-cli.js" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}
