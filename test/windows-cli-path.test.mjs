// Runs on the Windows CI account, restoring the original registry values in
// finally. Does not depend on external PowerShell modules or administrator rights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const script = fileURLToPath(new URL('../build/cli/path.ps1', import.meta.url));

test('Windows PATH install, upgrade and uninstall preserve values and ownership', { skip: process.platform !== 'win32' }, () => {
  const body = `
$ErrorActionPreference='Stop'
$envKey=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$statePath='Software\\PiX\\Command'
$state=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($statePath)
if ($state -and $state.ValueCount) { throw 'Refusing to run against an existing PiX CLI installation' }
if ($state) {$state.Close()}
$existed=$envKey.GetValueNames() -contains 'Path'
$old=$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$kind=if ($existed) {$envKey.GetValueKind('Path')} else {[Microsoft.Win32.RegistryValueKind]::ExpandString}
function Assert([bool]$value,[string]$message) {if (-not $value) {throw $message}}
function ReadPath {return [string]$envKey.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}
try {
  $baseline='%USERPROFILE%\\tools;C:\\Other tools;'
  $envKey.SetValue('Path',$baseline,[Microsoft.Win32.RegistryValueKind]::ExpandString)
  & $args[0] -Action install -Directory 'C:\\PiX One\\resources\\cli'
  & $args[0] -Action install -Directory 'C:\\PiX One\\resources\\cli'
  Assert ((ReadPath).Split(';').Where({$_ -eq 'C:\\PiX One\\resources\\cli'}).Count -eq 1) 'duplicate PATH entry'
  & $args[0] -Action install -Directory 'C:\\PiX Two\\resources\\cli'
  Assert (-not (ReadPath).Contains('PiX One')) 'upgrade left stale path'
  & $args[0] -Action uninstall -Directory 'C:\\PiX One\\resources\\cli'
  Assert ((ReadPath).Contains('PiX Two')) 'old uninstaller removed new path'
  & $args[0] -Action uninstall -Directory 'C:\\PiX Two\\resources\\cli'
  Assert ((ReadPath) -ceq $baseline) 'PATH did not round trip exactly'
  Assert ($envKey.GetValueKind('Path') -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) 'REG_EXPAND_SZ changed'
  $preexisting='C:\\PiX One\\resources\\cli'
  $envKey.SetValue('Path',$preexisting)
  & $args[0] -Action install -Directory $preexisting
  & $args[0] -Action uninstall -Directory $preexisting
  Assert ((ReadPath) -ceq $preexisting) 'removed preexisting PATH'
  $envKey.DeleteValue('Path')
  & $args[0] -Action install -Directory 'C:\\PiX One\\resources\\cli'
  & $args[0] -Action uninstall -Directory 'C:\\PiX One\\resources\\cli'
  Assert (-not ($envKey.GetValueNames() -contains 'Path')) 'did not restore absent PATH'
} finally {
  if ($existed) {$envKey.SetValue('Path',$old,$kind)} else {$envKey.DeleteValue('Path',$false)}
  $envKey.Close()
  [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($statePath,$false)
}
`;
  // Execute the helper in a child process each time, matching NSIS and avoiding
  // duplicate Add-Type definitions when the test calls it repeatedly.
  const rewritten = body.replaceAll('& $args[0] -Action', '& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $args[0] -Action');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& { ${rewritten} } '${script.replaceAll("'", "''")}'`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('NSIS wires installation and removal to the same PATH helper and scope', () => {
  const source = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8');
  assert.match(source, /-Action install -Directory/);
  assert.match(source, /-Action uninstall -Directory/);
  assert.equal(source.match(/\$installMode == "all"/g).length, 2);
});

test('NSIS reserves installation only after uninstall elevation and before modifying installed files', () => {
  const source = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8');
  const builder = readFileSync(new URL('../node_modules/app-builder-lib/templates/nsis/uninstaller.nsh', import.meta.url), 'utf8');
  // Silent uninstall calls this hook before initMultiUser can launch the UAC child.
  assert.ok(builder.indexOf('call un.checkAppRunning') < builder.indexOf('!insertmacro initMultiUser'));
  const check = /!macro customCheckAppRunning\b([\s\S]*?)!macroend/.exec(source)[1];
  assert.doesNotMatch(check, /!insertmacro pixPrepareInstall/);
  const uninstall = /!macro customUnInstall\b([\s\S]*?)!macroend/.exec(source)[1];
  assert.match(uninstall, /\$\{IfNot\} \$\{isUpdated\}\s+!insertmacro pixPrepareInstall\s+\$\{EndIf\}/);
  assert.ok(uninstall.indexOf('!insertmacro pixPrepareInstall') < uninstall.indexOf('-Action uninstall'));
  assert.ok(builder.indexOf('!insertmacro customUnInstall') < builder.indexOf('# delete the installed files'));
});

test('Windows installer helper parses natively and releases only matching installation reservations', { skip: process.platform !== 'win32' }, async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const helper = fileURLToPath(new URL('../build/installer-helper.ps1', import.meta.url));
  const home = mkdtempSync(join(tmpdir(), 'pix-installer-receipt-'));
  const lock = join(home, '.pix/run/starting');
  const receipt = join(home, 'receipt.json');
  const run = args => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8' });
  try {
    const parsed = run(['-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${helper.replaceAll("'", "''")}',[ref]$null,[ref]$e); if($e.Count){$e | Out-String | Write-Error; exit 1}`]);
    assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), String(process.pid));
    writeFileSync(join(lock, 'installer'), 'real-reservation');
    for (const token of ['different-installer', 'real-reservation']) {
      writeFileSync(receipt, JSON.stringify({ownerPid: process.pid, reservations: [{home, ownerPid: process.pid, token}]}));
      const result = run(['-File', helper, '-Action', 'finish', '-Receipt', receipt]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(lock), token !== 'real-reservation');
      assert.equal(existsSync(receipt), false);
    }
    const blockedHome = join(home, 'blocked');
    const blockedLock = join(blockedHome, '.pix/run/starting');
    mkdirSync(join(blockedLock, 'installer'), { recursive: true });
    writeFileSync(join(blockedLock, 'pid'), String(process.pid));
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), String(process.pid));
    writeFileSync(join(lock, 'installer'), 'real-reservation');
    writeFileSync(receipt, JSON.stringify({ ownerPid: process.pid, reservations: [
      { home: blockedHome, ownerPid: process.pid, token: 'blocked-reservation' },
      { home, ownerPid: process.pid, token: 'real-reservation' },
    ] }));
    const failed = run(['-File', helper, '-Action', 'finish', '-Receipt', receipt]);
    assert.notEqual(failed.status, 0);
    assert.equal(existsSync(lock), false, 'a malformed marker must not stop cleanup of other profiles');
    assert.equal(existsSync(receipt), true, 'failed cleanup retains the receipt for retry');
    rmSync(join(blockedLock, 'installer'), { recursive: true });
    writeFileSync(join(blockedLock, 'installer'), 'blocked-reservation');
    const retried = run(['-File', helper, '-Action', 'finish', '-Receipt', receipt]);
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.equal(existsSync(blockedLock), false);
    assert.equal(existsSync(receipt), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
