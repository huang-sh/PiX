import { buildSync } from 'esbuild';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildInstallGuard(output) {
  const result = buildSync({ entryPoints: [fileURLToPath(new URL('../src/installer/index.ts', import.meta.url))], bundle: true,
    platform: 'node', format: 'cjs', target: 'node22', write: false, minify: true, logLevel: 'error' });
  const code = result.outputFiles[0].text;
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'install-guard.cjs'), code);
  copyFileSync(new URL('../build/installer-helper.ps1', import.meta.url), join(output, 'installer-helper.ps1'));
  return code;
}
