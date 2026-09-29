@echo off
setlocal
set "TOOL_DIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%TOOL_DIR%合并TXT到Excel.ps1"
echo.
pause