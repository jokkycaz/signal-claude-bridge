@echo off
title Claude Signal Bridge - Shutdown

echo Stopping Docker bridge container...
cd /d C:\users\jokky\documents\claude-signal-bridge
docker compose down

echo Stopping PTY Host...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3101"') do taskkill /PID %%p /F 2>nul

echo.
echo Claude Signal Bridge stopped.
pause
