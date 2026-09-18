@echo off
REM WorkBuddy local assistant chat bridge - portable start (double-click to run)
REM Green/portable: uses bundled node under runtime\node, no system install needed.
REM 注意：经 supervisor.js 启动（守护进程），server.js 被杀后会自动复活。
set NODE_OPTIONS=
set "NODE=%~dp0runtime\node\node.exe"
if not exist "%NODE%" (
  echo [ERROR] runtime\node\node.exe not found. Extract the full package.
  pause
  exit /b 1
)
cd /d "%~dp0"
"%NODE%" supervisor.js
pause
