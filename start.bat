@echo off
title Claude Signal Bridge

:: Load config from .env
for /f "tokens=1,2 delims==" %%a in (.env) do set %%a=%%b

:: Start the PTY host in Windows Terminal
echo Starting Claude PTY Host...
wt -w 0 nt --title "Claude Signal Bridge" -d "%~dp0host" cmd /k "set BRIDGE_SECRET=%BRIDGE_SECRET%&& set PROJECT_DIR=%PROJECT_DIR%&& node index.js"

:: Give the host a moment to start
timeout /t 3 /nobreak >nul

:: Start the Docker container
echo Starting Docker bridge container...
cd /d "%~dp0"
docker compose up --build -d

echo.
echo Claude Signal Bridge is running!
echo   PTY Host: http://127.0.0.1:3101
echo   Settings: http://127.0.0.1:3100
echo.
pause
