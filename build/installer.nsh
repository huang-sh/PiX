!include "LogicLib.nsh"

Var pixGuardRuntime
Var pixGuardEnv
Var pixGuardOwner
Var pixGuardUi
Var pixGuardLanguage
Var pixGuardTargets

LangString pixErrorUnavailable 1033 "Installer helper failed (exit code $0). No readable error report was produced."
LangString pixErrorUnavailable 2052 "安装辅助程序执行失败（退出码 $0），未能生成可读取的错误报告。"
LangString pixPathInstallError 1033 "PiX CLI PATH registration failed"
LangString pixPathInstallError 2052 "PiX 命令行 PATH 注册失败"
LangString pixPathUninstallError 1033 "PiX CLI PATH cleanup failed"
LangString pixPathUninstallError 2052 "PiX 命令行 PATH 清理失败"
LangString pixReleaseError 1033 "Could not release PiX installation locks"
LangString pixReleaseError 2052 "无法释放 PiX 安装锁"

; All installer helpers write errors as UTF-16LE. Never display nsExec's
; ANSI-decoded output, including when a helper cannot start or write a report.
!macro pixReadInstallError
  StrCpy $1 ""
  ClearErrors
  FileOpen $2 "$PLUGINSDIR\pix-install-error.txt" r
  ${IfNot} ${Errors}
    ${Do}
      FileReadUTF16LE $2 $3
      ${IfThen} ${Errors} ${|} ${ExitDo} ${|}
      StrCpy $1 "$1$3"
    ${Loop}
    FileClose $2
  ${EndIf}
  ${If} $1 == ""
    StrCpy $1 "$(pixErrorUnavailable)"
  ${EndIf}
  ClearErrors
!macroend

!macro pixPrepareInstall
  StrCpy $pixGuardRuntime "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${IfNot} ${FileExists} "$pixGuardRuntime"
  ${AndIf} $perMachineInstallationFolder != ""
    StrCpy $pixGuardRuntime "$perMachineInstallationFolder\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
  ${IfNot} ${FileExists} "$pixGuardRuntime"
  ${AndIf} $perUserInstallationFolder != ""
    StrCpy $pixGuardRuntime "$perUserInstallationFolder\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
  ${If} ${FileExists} "$pixGuardRuntime"
    InitPluginsDir
    File /oname=$PLUGINSDIR\install-guard.cjs "${BUILD_RESOURCES_DIR}\generated\install-guard.cjs"
    File /oname=$PLUGINSDIR\installer-helper.ps1 "${BUILD_RESOURCES_DIR}\installer-helper.ps1"
    System::Call 'kernel32::GetCurrentProcessId() i .r0'
    StrCpy $pixGuardOwner $0
    StrCpy $pixGuardUi "windows"
    ${If} ${Silent}
      StrCpy $pixGuardUi "silent"
    ${EndIf}
    StrCpy $pixGuardLanguage "en"
    ${If} $LANGUAGE == 2052
      StrCpy $pixGuardLanguage "zh-CN"
    ${EndIf}
    ReadEnvStr $pixGuardEnv "ELECTRON_RUN_AS_NODE"
    StrCpy $pixGuardTargets '--target "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    ${If} $perMachineInstallationFolder != ""
      StrCpy $pixGuardTargets '$pixGuardTargets --target "$perMachineInstallationFolder\${APP_EXECUTABLE_FILENAME}"'
    ${EndIf}
    ${If} $perUserInstallationFolder != ""
      StrCpy $pixGuardTargets '$pixGuardTargets --target "$perUserInstallationFolder\${APP_EXECUTABLE_FILENAME}"'
    ${EndIf}
    System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
    Delete "$PLUGINSDIR\pix-install-error.txt"
    nsExec::ExecToStack '"$pixGuardRuntime" "$PLUGINSDIR\install-guard.cjs" --prepare $pixGuardTargets --error-file "$PLUGINSDIR\pix-install-error.txt" --receipt "$PLUGINSDIR\pix-install.json" --owner-pid "$pixGuardOwner" --ui "$pixGuardUi" --language "$pixGuardLanguage"'
    Pop $0
    Pop $1
    ${If} $pixGuardEnv == ""
      System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0)'
    ${Else}
      System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "$pixGuardEnv")'
    ${EndIf}
    ${If} $0 != 0
      ${If} $0 != 2
        !insertmacro pixReadInstallError
        DetailPrint "$1"
        MessageBox MB_OK|MB_ICONEXCLAMATION "$1" /SD IDOK
      ${EndIf}
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro pixReleaseInstall
  ${If} ${FileExists} "$PLUGINSDIR\pix-install.json"
    Delete "$PLUGINSDIR\pix-install-error.txt"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-helper.ps1" -Action finish -Receipt "$PLUGINSDIR\pix-install.json" -ErrorFile "$PLUGINSDIR\pix-install-error.txt"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      !insertmacro pixReadInstallError
      DetailPrint "$(pixReleaseError): $1"
    ${EndIf}
  ${EndIf}
!macroend

; A separate first section also runs in elevated and silent installs, where
; electron-builder skips CHECK_APP_RUNNING. Never use its name-based taskkill.
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Section "-PiX task check"
      ${If} ${Silent}
      ${AndIf} $hasPerMachineInstallation == "1"
      ${AndIfNot} ${UAC_IsAdmin}
        ; The default install section elevates and restarts us first.
      ${Else}
        !insertmacro pixPrepareInstall
      ${EndIf}
    SectionEnd
  !endif
!macroend

!macro customCheckAppRunning
  ; Override the builder's name-based taskkill. Uninstall preflight runs below,
  ; after initMultiUser has completed UAC elevation.
!macroend

!ifdef BUILD_UNINSTALLER
  Function un.onUninstSuccess
    !insertmacro pixReleaseInstall
  FunctionEnd
  Function un.onUninstFailed
    !insertmacro pixReleaseInstall
  FunctionEnd
  Function un.onGUIEnd
    !insertmacro pixReleaseInstall
  FunctionEnd
!else
  Function .onInstFailed
    !insertmacro pixReleaseInstall
  FunctionEnd
  Function .onGUIEnd
    !insertmacro pixReleaseInstall
  FunctionEnd
!endif

; Record the language picked in the setup wizard so PiX can adopt it as its
; interface language on first launch. SettingsService.applyInstallerLanguage
; consumes the value once (and deletes it), so choices made later in the app's
; Settings page are never overridden — not even by a reinstall, which simply
; writes a fresh value.
!macro customInstall
  WriteRegStr HKCU "Software\PiX" "installerLanguage" "$LANGUAGE"
  StrCpy $2 "User"
  ${If} $installMode == "all"
    StrCpy $2 "Machine"
  ${EndIf}
  InitPluginsDir
  Delete "$PLUGINSDIR\pix-install-error.txt"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\cli\path.ps1" -Action install -Directory "$INSTDIR\resources\cli" -Scope $2 -ErrorFile "$PLUGINSDIR\pix-install-error.txt"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    !insertmacro pixReadInstallError
    DetailPrint "$(pixPathInstallError): $1"
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(pixPathInstallError): $1"
    Abort
  ${EndIf}
  !insertmacro pixReleaseInstall
!macroend

; electron-builder's finish page launches the app through the Start Menu
; shortcut ($launchLink). If that .lnk disappears between the install section
; and the Finish click (antivirus, Start Menu cleanup, manual delete), Windows
; reports "Windows cannot find ...PiX.lnk" and the app never starts. Launch the
; installed executable directly instead — the same fallback electron-builder
; itself uses when the shortcut is missing at install time.
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    !insertmacro pixPrepareInstall
  ${EndIf}
  StrCpy $2 "User"
  ${If} $installMode == "all"
    StrCpy $2 "Machine"
  ${EndIf}
  InitPluginsDir
  Delete "$PLUGINSDIR\pix-install-error.txt"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\cli\path.ps1" -Action uninstall -Directory "$INSTDIR\resources\cli" -Scope $2 -ErrorFile "$PLUGINSDIR\pix-install-error.txt"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    !insertmacro pixReadInstallError
    DetailPrint "$(pixPathUninstallError): $1"
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(pixPathUninstallError): $1"
    Abort
  ${EndIf}
  DeleteRegValue HKCU "Software\PiX" "installerLanguage"
  DeleteRegKey /ifempty HKCU "Software\PiX"
!macroend

; Complete the install path on the directory page: browsing to a parent
; folder such as D:\Programs immediately becomes D:\Programs\PiX in the
; field, unless the path already ends with the app folder (case-insensitive).
; electron-builder applies the same completion silently after this page
; (instFilesPre), so this only makes the correction visible and predictable.
Function .onVerifyInstDir
  StrLen $0 "${APP_FILENAME}"
  IntOp $0 $0 + 1
  StrCpy $1 $INSTDIR "" -$0
  ${If} $1 == "\${APP_FILENAME}"
  ${OrIf} $INSTDIR == "${APP_FILENAME}"
    Return
  ${EndIf}
  StrCpy $2 $INSTDIR 1 -1
  ${If} $2 == "\"
    StrCpy $INSTDIR "$INSTDIR${APP_FILENAME}"
  ${Else}
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
FunctionEnd
