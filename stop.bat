@echo off
title Claude Signal Bridge - Shutdown

echo Stopping Docker bridge container...
cd /d "%~dp0"
docker compose down

echo Stopping PTY Host...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3101"') do taskkill /PID %%p /F 2>nul

echo.
echo Claude Signal Bridge stopped.
pause
