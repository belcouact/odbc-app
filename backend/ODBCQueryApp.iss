; Inno Setup script for ODBCQueryApp.
;
; Builds a per-user installer (no admin rights, no UAC prompt) that unpacks
; the PyInstaller onedir build into %LOCALAPPDATA%\Programs\ODBCQueryApp,
; adds Start Menu / desktop shortcuts and an "Apps & features" entry.
;
; The app self-updates by swapping its install folder, so the script:
;   - installs to a user-writable location (the updater must rename that
;     folder — it cannot do that under Program Files without elevation),
;   - has the launcher carry unins000.exe/.dat across swaps (launcher.py),
;   - deletes the whole install folder on uninstall via [UninstallDelete],
;     because a self-updated folder no longer matches the uninstall log.
;
; Build:  ISCC.exe ODBCQueryApp.iss     (release.py does this automatically)
; Output: dist\ODBCQueryApp-Setup-<version>.exe — the file to share.

#define MyAppName "ODBCQueryApp"
; Read the version from the built exe; FileVersion is four-part ("2.2.1.0"),
; so drop a trailing ".0" for a clean installer name.
#define RawVer GetVersionNumbersString(AddBackslash(SourcePath) + "dist\ODBCQueryApp\ODBCQueryApp.exe")
#define MyAppVersion (Copy(RawVer, Len(RawVer)-1, 2) == ".0" ? Copy(RawVer, 1, Len(RawVer)-2) : RawVer)

[Setup]
AppId={{D4A6F2E1-7C3B-4E85-9F0D-2B8C5A1E6D94}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
DefaultDirName={localappdata}\Programs\{#MyAppName}
; Stay on the same folder for reinstalls/upgrade runs.
UsePreviousAppDir=yes
; Per-user install: no elevation needed to install or to let the app swap
; its own folder later.
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=ODBCQueryApp-Setup-{#MyAppVersion}
SetupIconFile=app_icon.ico
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\ODBCQueryApp.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; The app must not be running while its files are replaced. Restart Manager
; cannot close it (see [Code] below), so we terminate it ourselves instead of
; leaving Setup stuck on the "files in use" page.
CloseApplications=no
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; \
    GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "dist\ODBCQueryApp\*"; DestDir: "{app}"; \
    Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\ODBCQueryApp.exe"; \
    Comment: "Query ODBC data sources"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\ODBCQueryApp.exe"; \
    Tasks: desktopicon

[Run]
Filename: "{app}\ODBCQueryApp.exe"; Description: "{cm:LaunchProgram,{#MyAppName}}"; \
    Flags: nowait postinstall skipifsilent

; A self-update replaces files behind the uninstaller's back, so the logged
; file list alone would leave the folder half-populated. Delete the whole
; folder — plus any swapped-aside "<install>.<version>.old" leftovers.
[UninstallDelete]
Type: filesandordirs; Name: "{app}"
Type: filesandordirs; Name: "{localappdata}\Programs\{#MyAppName}.*.old"

[Code]
{ The app is a headless windowed exe: it only serves HTTP and opens a browser
  tab, so it has no top-level window for the Restart Manager to send WM_CLOSE
  to. CloseApplications therefore cannot stop it, and the wizard's "files in
  use" page just hangs while the install folder stays locked. Terminate the
  running instance directly (taskkill) so its files are released first. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Attempt: Integer;
begin
  Result := '';
  for Attempt := 1 to 20 do
  begin
    if not Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM ODBCQueryApp.exe',
                '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      Exit;  { taskkill unavailable: let Setup try its own file-in-use handling }
    { taskkill exits 128 ("process not found") once nothing is left to kill. }
    if ResultCode = 128 then
      Exit;
    Sleep(500);
  end;
  Result := 'ODBCQueryApp could not be closed automatically. ' +
            'End ODBCQueryApp.exe in Task Manager, then run Setup again.';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    if MsgBox('Also remove settings, logs and cached update data?',
              mbConfirmation, MB_YESNO) = IDYES then
      DelTree(ExpandConstant('{userappdata}\ODBCQueryApp'), True, True, True);
end;
