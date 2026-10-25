param(
  [Parameter(Mandatory=$true)][ValidateSet('install', 'uninstall', 'status')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Directory,
  [ValidateSet('User', 'Machine')][string]$Scope = 'User'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$Directory = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
if ($Action -eq 'status') {
  $all = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $found = $false
  foreach ($part in $all.Split(';')) {
    if ([string]::Equals([Environment]::ExpandEnvironmentVariables($part.Trim().Trim('"')).TrimEnd('\'), $Directory, [StringComparison]::OrdinalIgnoreCase)) { $found = $true }
  }
  @{ installed = $found; launcher = [IO.Path]::Combine($Directory, 'pix.cmd') } | ConvertTo-Json -Compress
  exit 0
}
$base = if ($Scope -eq 'Machine') { [Microsoft.Win32.Registry]::LocalMachine } else { [Microsoft.Win32.Registry]::CurrentUser }
$environmentPath = if ($Scope -eq 'Machine') { 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment' } else { 'Environment' }
$environment = $base.CreateSubKey($environmentPath)
$state = $base.CreateSubKey('Software\PiX\Command')
try {
  $hadPath = $environment.GetValueNames() -contains 'Path'
  $originalPathExisted = $state.GetValue('PathExisted', [int]$hadPath)
  $raw = [string]$environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = if ($environment.GetValueNames() -contains 'Path') { $environment.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
  $previous = [string]$state.GetValue('AddedPath', '')
  $parts = [Collections.Generic.List[string]]::new()
  if ($raw.Length -gt 0) { foreach ($part in $raw.Split(';')) { $parts.Add($part) } }
  function SamePath([string]$a, [string]$b) {
    return [string]::Equals([Environment]::ExpandEnvironmentVariables($a.Trim().Trim('"')).TrimEnd('\'), $b, [StringComparison]::OrdinalIgnoreCase)
  }
  # Remove only an entry this installer previously added, including upgrades
  # that move the application. Keep all unrelated PATH spelling and variables.
  if ($previous -and ($Action -eq 'install' -or (SamePath $previous $Directory))) {
    for ($i = $parts.Count - 1; $i -ge 0; $i--) { if (SamePath $parts[$i] $previous) { $parts.RemoveAt($i) } }
    $state.DeleteValue('AddedPath', $false)
    $state.DeleteValue('PathExisted', $false)
  }
  if ($Action -eq 'install') {
    $exists = $false
    foreach ($part in $parts) { if (SamePath $part $Directory) { $exists = $true } }
    if (-not $exists) { $parts.Add($Directory); $state.SetValue('AddedPath', $Directory); $state.SetValue('PathExisted', $originalPathExisted) }
  }
  $next = [string]::Join(';', $parts)
  if ($Action -eq 'uninstall' -and $previous -and (SamePath $previous $Directory) -and $next -eq '' -and $originalPathExisted -eq 0) {
    $environment.DeleteValue('Path', $false)
  } elseif ($next -ne $raw) { $environment.SetValue('Path', $next, $kind) }
} finally {
  $environment.Close()
  $state.Close()
}
if ($Action -eq 'uninstall') {
  $key = $base.OpenSubKey('Software\PiX\Command')
  $empty = $key -and $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0
  if ($key) { $key.Close() }
  if ($empty) { $base.DeleteSubKey('Software\PiX\Command', $false) }
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PiXEnvironment {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wparam, string lparam, uint flags, uint timeout, out UIntPtr result);
}
'@
$result = [UIntPtr]::Zero
[void][PiXEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
