#define MyAppName "QQ跑团Log导出器"
#define MyAppVersion "1.0.0"
#define SourceDir SourcePath

[Setup]
AppId={{D4F5B77D-6249-4562-94B7-548CB0E9BB9A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppName}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
OutputDir={#SourceDir}\dist
OutputBaseFilename=QQ跑团Log导出器-Setup-{#MyAppVersion}
UninstallDisplayIcon={app}\runtime\napimain.exe
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式:"; Flags: unchecked

[Dirs]
Name: "{app}\TXT整合Excel工具\待整合TXT"; Flags: uninsneveruninstall
Name: "{app}\runtime\cache"; Flags: uninsneveruninstall
Name: "{app}\runtime\logs"; Flags: uninsneveruninstall

[Files]
Source: "{#SourceDir}\启动导出器.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\使用说明.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "{#SourceDir}\runtime\native\*"; DestDir: "{app}\runtime\native"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\runtime\node_modules\*"; DestDir: "{app}\runtime\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\runtime\plugins\*"; DestDir: "{app}\runtime\plugins"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\runtime\worker\*"; DestDir: "{app}\runtime\worker"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\installer\config\napcat.json"; DestDir: "{app}\runtime\config"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "{#SourceDir}\installer\config\plugins.json"; DestDir: "{app}\runtime\config"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "{#SourceDir}\TXT整合Excel工具\合并TXT到Excel.ps1"; DestDir: "{app}\TXT整合Excel工具"; Flags: ignoreversion
Source: "{#SourceDir}\TXT整合Excel工具\开始整合.bat"; DestDir: "{app}\TXT整合Excel工具"; Flags: ignoreversion
Source: "{#SourceDir}\TXT整合Excel工具\使用说明.md"; DestDir: "{app}\TXT整合Excel工具"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}\QQ跑团Log导出器"; Filename: "{app}\启动导出器.bat"; WorkingDir: "{app}"
Name: "{autoprograms}\{#MyAppName}\TXT整合到 Excel"; Filename: "{app}\TXT整合Excel工具\开始整合.bat"; WorkingDir: "{app}\TXT整合Excel工具"
Name: "{autoprograms}\{#MyAppName}\使用说明"; Filename: "{app}\使用说明.md"
Name: "{autodesktop}\QQ跑团Log导出器"; Filename: "{app}\启动导出器.bat"; WorkingDir: "{app}"; Tasks: desktopicon
