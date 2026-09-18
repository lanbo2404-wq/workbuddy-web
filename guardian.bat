@echo off
REM ⚠️ 外层守卫（cmd 进程，不是 node）
REM 网页助理做"杀进程测试"时会把 server.js / supervisor.js（都是 node.exe）全杀掉，
REM 但只要本 cmd 守卫还活着，就会每 5 秒检查一次，发现没有 node 就立刻把 supervisor 拉起来。
REM 因此：哪怕网页助理把自己住的房子连监护人一起拆了，5 秒内也会被重建。
REM 由 start.bat 启动，常驻即可。

set "NODE=%~dp0runtime\node\node.exe"
if not exist "%NODE%" (
  echo [guardian] ERROR: runtime\node\node.exe 不存在
  pause
  exit /b 1
)

:loop
tasklist /FI "IMAGENAME eq node.exe" 2>nul | find /I "node.exe" >nul
if errorlevel 1 (
  echo [%TIME%] [guardian] 未检测到 node，启动 supervisor.js ...
  start "" /MIN "%NODE%" "%~dp0supervisor.js"
) else (
  echo [%TIME%] [guardian] node 运行中，无需动作
)
timeout /t 5 /nobreak >nul
goto loop
