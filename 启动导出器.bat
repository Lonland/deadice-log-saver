@echo off
setlocal
set "APP_DIR=%~dp0runtime"
set "APP_URL=http://localhost:40777/"
set "PORT=40777"

if not exist "%APP_DIR%\napiLoader.bat" (
  echo Runtime file not found: %APP_DIR%\napiLoader.bat
  pause
  exit /b 1
)

echo Starting QQ TRPG Log Exporter...
echo.
echo If QQ asks you to log in, please log in normally.
echo This window will wait for the local export page to become ready.
echo.

cd /d "%APP_DIR%"
start "QQ TRPG Log Exporter Runtime" "%APP_DIR%\napiLoader.bat"

echo Waiting for http://localhost:%PORT%/ ...
for /l %%i in (1,1,120) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT%/' -TimeoutSec 1; if ($r.StatusCode -ge 200) { exit 0 } } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 (
    echo Export page is ready.
    start "" "%APP_URL%"
    exit /b 0
  )
  timeout /t 1 /nobreak >nul
)

echo.
echo The export page did not start within 120 seconds.
echo Please check the runtime window for errors.
echo If QQ is still waiting for login, finish login first, then open:
echo %APP_URL%
echo.
pause
exit /b 1
