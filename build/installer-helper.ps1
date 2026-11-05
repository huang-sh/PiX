param(
  [ValidateSet('inspect','close','kill','show','finish')][string]$Action,
  [string]$Targets, [string]$Processes, [string]$Title, [string]$Detail, [string]$Buttons, [string]$Receipt, [string]$ErrorFile
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
try {
  if ($Action -eq 'finish') {
    if (Test-Path -LiteralPath $Receipt -PathType Leaf) {
      $saved=Get-Content -LiteralPath $Receipt -Raw -Encoding UTF8 | ConvertFrom-Json
      $failures=@()
      foreach ($item in $saved.reservations) {
        try {
          $lock=Join-Path $item.home '.pix\run\starting'
          if ((Test-Path -LiteralPath (Join-Path $lock 'installer')) -and
              [IO.File]::ReadAllText((Join-Path $lock 'pid')) -eq [string]$saved.ownerPid -and
              [IO.File]::ReadAllText((Join-Path $lock 'installer')) -ceq $item.token) {
            Remove-Item -LiteralPath $lock -Recurse -Force
          }
        } catch { $failures+="$($item.home): $($_.Exception.Message)" }
      }
      if ($failures.Count) { throw ("Could not release PiX installation locks:`n"+($failures -join "`n")) }
      Remove-Item -LiteralPath $Receipt -Force
    }
    'true'
  } elseif ($Action -eq 'inspect') {
    # Windows PowerShell 5.1 emits a JSON array as one pipeline object; @(...)
    # would wrap it in another array and break path membership checks.
    $paths=$Targets | ConvertFrom-Json
    $named=@(Get-CimInstance Win32_Process -Filter "Name='PiX.exe'")
    if (@($named | Where-Object {-not $_.ExecutablePath -or $paths -inotcontains $_.ExecutablePath}).Count) {
      Write-Error -ErrorId 'PiXOtherInstallation' -Message 'Another PiX installation is running. Quit it completely before updating.'
    }
    $items=@($named | ForEach-Object {
      @{pid=[int]$_.ProcessId; birth=[string]$_.CreationDate.ToUniversalTime().Ticks}
    })
    $homes=@(Get-CimInstance Win32_UserProfile | Where-Object {$_.Loaded -and $_.LocalPath} | ForEach-Object {$_.LocalPath})
    @{processes=$items; homes=$homes} | ConvertTo-Json -Compress -Depth 5
  } elseif ($Action -eq 'show') {
    Add-Type -AssemblyName System.Windows.Forms
    $form=New-Object System.Windows.Forms.Form
    $form.Text=$Title; $form.Width=640; $form.Height=370
    $form.StartPosition='CenterScreen'; $form.TopMost=$true
    $form.FormBorderStyle='FixedDialog'; $form.MinimizeBox=$false; $form.MaximizeBox=$false
    $text=New-Object System.Windows.Forms.TextBox
    $text.Multiline=$true; $text.ReadOnly=$true; $text.ScrollBars='Vertical'
    $text.Text=$Detail; $text.SetBounds(20,20,580,230); $form.Controls.Add($text)
    $labels=$Buttons | ConvertFrom-Json
    $form.Tag=0
    for ($i=0; $i -lt $labels.Count; $i++) {
      $button=New-Object System.Windows.Forms.Button
      $button.Text=$labels[$i]; $button.Tag=$i; $button.SetBounds((20+$i*195),270,185,36)
      $button.Add_Click({$this.FindForm().Tag=[int]$this.Tag; $this.FindForm().Close()})
      $form.Controls.Add($button)
      if ($i -eq 0) {$form.AcceptButton=$button; $form.CancelButton=$button}
    }
    $form.Add_Shown({[void]$this.AcceptButton.Focus()})
    [void]$form.ShowDialog()
    [int]$form.Tag | ConvertTo-Json -Compress
    $form.Dispose()
  } else {
    $paths=$Targets | ConvertFrom-Json
    $items=$Processes | ConvertFrom-Json
    foreach ($item in $items) {
      if ($item.pid -le 0) {throw 'Invalid PiX process identity'}
      $current=Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$item.pid)"
      if (-not $current -or $paths -inotcontains $current.ExecutablePath -or [string]$current.CreationDate.ToUniversalTime().Ticks -ne $item.birth) {continue}
      if ($Action -eq 'kill') {Stop-Process -Id $item.pid -Force -ErrorAction Stop}
      else {[void](Get-Process -Id $item.pid).CloseMainWindow()}
    }
    'true'
  }
} catch {
  # NSIS reads UTF-16LE explicitly; keep console output UTF-8 for Node callers.
  if ($ErrorFile) {
    try { [IO.File]::WriteAllText($ErrorFile, $_.Exception.Message, [Text.Encoding]::Unicode) }
    catch { [Console]::Error.WriteLine($_.Exception.Message) }
  }
  throw
}
