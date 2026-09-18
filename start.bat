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
REM 启动外层 cmd 守卫（常驻），由它来拉起并看护 supervisor.js
REM 这样即使网页助理把 node 全杀光，cmd 守卫也能把服务重建
start "" /MIN "%~dp0guardian.bat"
echo [OK] 已启动守护（guardian.bat），服务将在几秒内上线：http://127.0.0.1:8790
echo       关闭本窗口不会停止服务；如需彻底关闭，结束 guardian.bat 与 node.exe 进程即可。
pause
