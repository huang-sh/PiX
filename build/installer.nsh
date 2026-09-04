!include "LogicLib.nsh"

; Record the language picked in the setup wizard so PiX can adopt it as its
; interface language on first launch. SettingsService.applyInstallerLanguage
; consumes the value once (and deletes it), so choices made later in the app's
; Settings page are never overridden — not even by a reinstall, which simply
; writes a fresh value.
!macro customInstall
  WriteRegStr HKCU "Software\PiX" "installerLanguage" "$LANGUAGE"
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
