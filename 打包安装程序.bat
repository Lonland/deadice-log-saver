@echo off
setlocal
set "PROJECT_DIR=%~dp0"
set "ISCC="

if not exist "%PROJECT_DIR%runtime\node_modules\" (
  echo Missing runtime\node_modules.
  echo Restore the runtime dependencies before building the installer.
  pause
  exit /b 1
)

for %%P in ("%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" "%ProgramFiles%\Inno Setup 6\ISCC.exe" "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe") do (
  if exist "%%~P" set "ISCC=%%~P"
)
if not defined ISCC (
  where ISCC.exe >nul 2>nul && set "ISCC=ISCC.exe"
)

if not defined ISCC (
  echo Cannot find Inno Setup 6 compiler (ISCC.exe).
  echo Install Inno Setup 6, then run this script again.
  pause
  exit /b 1
)

"%ISCC%" "%PROJECT_DIR%安装程序.iss"
if errorlevel 1 (
  echo Installer build failed.
  pause
  exit /b 1
)

echo.
echo Installer created in the dist folder.
pause