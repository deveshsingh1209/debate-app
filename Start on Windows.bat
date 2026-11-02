@echo off
rem Double-click this file to start the Debate App on Windows.
rem Option (Command Prompt only): --check  = only verify this PC is ready, start nothing.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  pause
)
exit /b %CODE%
