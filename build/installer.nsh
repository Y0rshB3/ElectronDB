; Vortaq additions to electron-builder's NSIS installer (included through nsis.include).
; Keep this small: it is compiled into every Windows installer and runs on machines we cannot test.
; Registry keys used by electron-builder for appId dev.y0rshb3.electrondb (the ElectronDB-era id,
; kept so Vortaq installs over and updates an ElectronDB installation):
;   HKCU\Software\ed60cf51-f5c8-5d88-9777-022dc431ddb4                        (InstallLocation)
;   HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ed60cf51-f5c8-5d88-9777-022dc431ddb4

; Installing over a broken previous copy. Before copying the new files the installer runs the old
; uninstaller silently. electron-builder's default check aborts the whole install when that old
; uninstaller fails (exit code != 0: files in use, an interrupted earlier run, a missing app folder),
; which leaves the user with no working copy and an entry in "Apps" that cannot be removed.
; Here a failed or missing old uninstaller is only logged: the new files are written over the old
; folder and the registry entries are rewritten, which repairs the installation. Running copies
; were already closed by the installer's own check before this point: with PowerShell it closes
; every process started from the install folder (also ElectronDB.exe when upgrading from
; ElectronDB); without it, only Vortaq.exe. An in-app update always quits the app first.
!macro customUnInstallCheck
  ${if} ${Errors}
    DetailPrint `Previous uninstaller could not be started; installing over the old files.`
    ClearErrors
  ${elseIf} $R0 != 0
    DetailPrint `Previous uninstaller exited with code $R0; installing over the old files.`
  ${endIf}
!macroend

; Copies installed "for all users" by older installers (0.1.8 and earlier offered that choice)
; live in Program Files and HKLM. This per-user installer cannot remove them without admin rights,
; so it says so instead of leaving two copies silently. Never shown in silent mode (in-app update).
!macro customInit
  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
  ${if} $0 != ""
    MessageBox MB_OK|MB_ICONINFORMATION "Hay otra copia de ElectronDB o Vortaq instalada «para todos los usuarios».$\r$\n$\r$\nEsta versión se instala solo para tu usuario. Cuando termine, desinstala la copia antigua desde Configuración > Aplicaciones (pedirá permiso de administrador). Tus conexiones y ajustes no se tocan." /SD IDOK
  ${endIf}
!macroend
