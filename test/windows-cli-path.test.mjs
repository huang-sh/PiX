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

test('every NSIS helper failure uses a Unicode report and a localized fallback', () => {
  const source = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8');
  for (const name of ['pixPrepareInstall', 'pixReleaseInstall', 'customInstall', 'customUnInstall']) {
    const body = new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`).exec(source)[1];
    assert.match(body, /Delete "\$PLUGINSDIR\\pix-install-error\.txt"/);
    assert.match(body, /(?:--error-file|-ErrorFile) "\$PLUGINSDIR\\pix-install-error\.txt"/);
    assert.match(body, /!insertmacro pixReadInstallError/);
    assert.doesNotMatch(body, /nsExec::ExecToLog/);
  }
  const reader = /!macro pixReadInstallError\b([\s\S]*?)!macroend/.exec(source)[1];
  assert.match(reader, /FileReadUTF16LE/);
  assert.match(reader, /StrCpy \$1 "\$\(pixErrorUnavailable\)"/);
  for (const message of ['pixErrorUnavailable', 'pixPathInstallError', 'pixPathUninstallError', 'pixReleaseError']) {
    for (const language of [1033, 2052]) assert.match(source, new RegExp(`LangString ${message} ${language} `));
  }
});

test('Windows PATH failures write UTF-16LE reports without changing the exit status or UTF-8 status API', { skip: process.platform !== 'win32' }, async () => {
  const { mkdtempSync, existsSync, realpathSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, win32 } = await import('node:path');
  // Windows PowerShell expands 8.3 names such as RUNNER~1 when normalizing paths.
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'pix-path-error-')));
  const report = join(home, '中文错误报告.txt');
  const run = args => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { encoding: 'utf8' });
  try {
    for (const action of ['install', 'uninstall']) {
      // Invalid Windows path characters fail before any registry mutation.
      const result = run(['-Action', action, '-Directory', 'C:\\中文<目录>', '-ErrorFile', report]);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      const bytes = readFileSync(report);
      assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
      assert.match(bytes.toString('utf16le'), /GetFullPath/);
      rmSync(report);
      const unwritable = run(['-Action', action, '-Directory', 'C:\\中文<目录>', '-ErrorFile', home]);
      assert.equal(unwritable.status, 1, 'failure to write the report must not hide the original failure');
    }
    const directory = join(home, '中文目录');
    const status = run(['-Action', 'status', '-Directory', directory, '-ErrorFile', report]);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(JSON.parse(status.stdout).launcher, win32.join(directory, 'pix.cmd'));
    assert.equal(existsSync(report), false, 'successful calls must not write an error report');
  } finally { rmSync(home, { recursive: true, force: true }); }
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
  assert.match(source, /--error-file "\$PLUGINSDIR\\pix-install-error\.txt"/);
  assert.match(source, /FileReadUTF16LE \$2 \$3/);
});

test('Windows PowerShell installer inspection and shutdown handle JSON arrays without nesting', { skip: process.platform !== 'win32' }, () => {
  const helper = fileURLToPath(new URL('../build/installer-helper.ps1', import.meta.url));
  const body = String.raw`
$ErrorActionPreference='Stop'
function Assert([bool]$value,[string]$message) {if (-not $value) {throw $message}}
$target='C:\Program Files\PiX\PiX.exe'
$other='D:\Other PiX\PiX.exe'
$birth=[datetime]::UtcNow
$global:pixTestProcesses=@()
$global:pixTestStopped=@()
function Get-CimInstance($ClassName,$Filter) {
  if ($ClassName -eq 'Win32_UserProfile') {return}
  if ($Filter -eq "Name='PiX.exe'") {return $global:pixTestProcesses}
  $global:pixTestProcesses | Where-Object {"ProcessId=$($_.ProcessId)" -eq $Filter}
}
function Stop-Process($Id,[switch]$Force,$ErrorAction) {$global:pixTestStopped+=$Id}
function Get-Process($Id) {
  $process=[pscustomobject]@{Id=$Id}
  $process | Add-Member ScriptMethod CloseMainWindow {$global:pixTestStopped+=$this.Id; return $true}
  return $process
}
foreach ($count in 0,1,2) {
  $global:pixTestProcesses=@(for ($i=0; $i -lt $count; $i++) {
    [pscustomobject]@{ProcessId=4100+$i; ExecutablePath=$target; CreationDate=$birth}
  })
  foreach ($targets in ('[]', (ConvertTo-Json -InputObject @($target)), (ConvertTo-Json -InputObject @($other,$target.ToUpper(),$target)))) {
    if ($count -and $targets -eq '[]') {continue}
    $found=& $args[0] -Action inspect -Targets $targets | ConvertFrom-Json
    Assert ($found.processes.Count -eq $count) 'inspection lost processes'
    Assert ($found.homes.Count -eq 0) 'empty homes must remain an array'
    foreach ($action in 'close','kill') {
      $global:pixTestStopped=@()
      $identities=ConvertTo-Json -InputObject @($found.processes)
      $null=& $args[0] -Action $action -Targets $targets -Processes $identities
      Assert (($global:pixTestStopped -join ',') -eq ($global:pixTestProcesses.ProcessId -join ',')) 'shutdown did not visit each identity'
    }
  }
}
foreach ($path in @($other,$null)) {
  $global:pixTestProcesses=@([pscustomobject]@{ProcessId=4200; ExecutablePath=$path; CreationDate=$birth})
  $rejected=$false
  try {$null=& $args[0] -Action inspect -Targets (ConvertTo-Json -InputObject @($target))}
  catch {if ($_.Exception.Message -notlike 'Another PiX installation*') {throw}; $rejected=$true}
  Assert $rejected 'unmatched or unreadable executable must block installation'
}
$global:pixTestProcesses=@([pscustomobject]@{ProcessId=4100; ExecutablePath=$target; CreationDate=$birth})
$identities=ConvertTo-Json -InputObject @(@{pid=4100;birth=[string]$birth.AddSeconds(-1).ToUniversalTime().Ticks})
foreach ($action in 'close','kill') {
  $global:pixTestStopped=@()
  $null=& $args[0] -Action $action -Targets (ConvertTo-Json -InputObject @($target)) -Processes $identities
  Assert ($global:pixTestStopped.Count -eq 0) 'reused PID must not be stopped'
}
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& { ${body} } '${helper.replaceAll("'", "''")}'`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
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
    const blockedHome = join(home, '中文目录');
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
    const report = join(home, 'error.txt');
    const failed = run(['-File', helper, '-Action', 'finish', '-Receipt', receipt, '-ErrorFile', report]);
    assert.notEqual(failed.status, 0);
    const bytes = readFileSync(report);
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
    assert.ok(bytes.toString('utf16le').includes(blockedHome), 'the failure report must preserve the Chinese profile path');
    assert.match(bytes.toString('utf16le'), /Could not release PiX installation locks:\n/);
    assert.equal(existsSync(lock), false, 'a malformed marker must not stop cleanup of other profiles');
    assert.equal(existsSync(receipt), true, 'failed cleanup retains the receipt for retry');
    rmSync(join(blockedLock, 'installer'), { recursive: true });
    writeFileSync(join(blockedLock, 'installer'), 'blocked-reservation');
    rmSync(report);
    const retried = run(['-File', helper, '-Action', 'finish', '-Receipt', receipt, '-ErrorFile', report]);
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.equal(existsSync(blockedLock), false);
    assert.equal(existsSync(receipt), false);
    assert.equal(existsSync(report), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
