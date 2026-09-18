@echo off
title wbchat-guardian
REM Outer guard (cmd process, NOT node).
REM Check = is port 8790 listening (not "is node running", which caused
REM duplicate supervisors fighting over the port).
REM If port is down: kill all node (clear zombie supervisors), then start
REM exactly one supervisor.js. Started by start.bat. Keep it running.

set "NODE=%~dp0runtime\node\node.exe"
cd /d "%~dp0"
if not exist "%NODE%" (
  echo [guardian] ERROR: runtime\node\node.exe not found
  pause
  exit /b 1
)

:loop
netstat -ano | findstr /C:":8790" | findstr /C:"LISTENING" >nul 2>&1
if errorlevel 1 (
  echo [%TIME%] 8790 DOWN, cleaning node and rebuilding...
  taskkill /F /IM node.exe >nul 2>&1
  ping -n 2 127.0.0.1 >nul
  start "" /MIN "%NODE%" "%~dp0supervisor.js"
) else (
  echo [%TIME%] 8790 OK
)
ping -n 6 127.0.0.1 >nul
goto loop
