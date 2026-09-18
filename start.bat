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
REM 防重复：已经有守卫在跑就不再开第二个（避免多 supervisor 抢 8790）
tasklist /FI "WINDOWTITLE eq wbchat-guardian*" 2>nul | find /I "cmd.exe" >nul
if errorlevel 1 (
  start "" /MIN "%~dp0guardian.bat"
  echo [OK] 守卫已启动，服务几秒内上线：http://127.0.0.1:8790
) else (
  echo [OK] 守卫已在运行，无需重复启动
)
echo       关闭本窗口不会停止服务；如需彻底关闭，结束 wbchat-guardian 窗口和 node.exe 进程。
pause
