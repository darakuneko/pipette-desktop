; Installer hooks of the NSIS installer (bundle > windows > nsis >
; installerHooks in tauri.windows.conf.json).
;
; Pipette up to 0.4 was an Electron app installed by an electron-builder
; installer, under its own uninstall entry and in another folder. Before
; copying its files, this installer removes that installation so the PC is
; left with one Pipette. The user data (%APPDATA%\pipette-desktop) stays: the
; old uninstaller deletes it only when given --delete-app-data, which is not
; passed here.

; electron-builder names the uninstall entry after the UUID v5 of the appId
; (app.pipette.desktop) in its namespace 50e065bc-3134-11e6-9bab-38c9862bdaf3,
; without braces.
!define PIPETTE_ELECTRON_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ea2785fe-f9f8-5f54-9882-47312c59a4b9"

!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $1
  Push $2
  Push $3

  ; An installation for all users lives under HKLM and Program Files, which
  ; this per-user installer has no rights to change.
  ReadRegStr $0 HKLM "${PIPETTE_ELECTRON_UNINSTKEY}" "UninstallString"
  ${If} $0 != ""
    MessageBox MB_OK|MB_ICONSTOP "Pipette 0.4 is installed for all users. Uninstall it from Settings > Apps first (your data is kept), then run this installer again." /SD IDOK
    Abort "Pipette 0.4 is installed for all users."
  ${EndIf}

  ReadRegStr $0 HKCU "${PIPETTE_ELECTRON_UNINSTKEY}" "UninstallString"
  ${If} $0 != ""
    ; The value is the quoted path of the uninstaller followed by its
    ; arguments ("...\Uninstall Pipette.exe" /currentuser).
    StrCpy $1 $0 1
    ${If} $1 == "$\""
      StrCpy $1 $0 "" 1
      ${StrLoc} $2 $1 "$\"" ">"
      StrCpy $1 $1 $2
    ${Else}
      StrCpy $1 $0
    ${EndIf}

    ${If} ${FileExists} "$1"
      DetailPrint "Uninstalling Pipette 0.4"
      ${GetParent} "$1" $3
      ; The uninstaller deletes its own folder, so it runs from a copy. _?=
      ; makes that copy work on the installation folder and finish before
      ; ExecWait returns. Run silently, it closes a running Pipette 0.4.
      InitPluginsDir
      CopyFiles /SILENT "$1" "$PLUGINSDIR\pipette-0.4-uninstaller.exe"
      ClearErrors
      ExecWait '"$PLUGINSDIR\pipette-0.4-uninstaller.exe" /S /currentuser _?=$3' $2
      ${If} ${Errors}
        StrCpy $2 "error"
      ${EndIf}
      Delete "$PLUGINSDIR\pipette-0.4-uninstaller.exe"

      ReadRegStr $0 HKCU "${PIPETTE_ELECTRON_UNINSTKEY}" "UninstallString"
      ${If} $2 != 0
      ${OrIf} $0 != ""
        MessageBox MB_OK|MB_ICONSTOP "Pipette 0.4 could not be uninstalled. Uninstall it from Settings > Apps (your data is kept), then run this installer again." /SD IDOK
        Abort "Pipette 0.4 could not be uninstalled."
      ${EndIf}
    ${Else}
      ; The entry points at an uninstaller that is gone (the folder was
      ; deleted by hand): nothing is left to remove.
      DetailPrint "Pipette 0.4 is registered but its uninstaller is missing: $1"
    ${EndIf}
  ${EndIf}

  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
