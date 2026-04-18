@echo off
title Claude Signal Bridge

:: Load config from .env
for /f "tokens=1,2 delims==" %%a in (.env) do set %%a=%%b

:: Start all PTY hosts from profiles.json
echo Starting Claude PTY Hosts...
cd /d "%~dp0host"
node launch-profiles.js
if errorlevel 1 (
    echo.
    echo ERROR: No profiles found. Start the Docker container first to create profiles.json,
    echo or create it manually at data\profiles.json
    echo.
    pause
    exit /b 1
)

:: Give hosts a moment to start
timeout /t 5 /nobreak >nul

:: Start the Docker container
echo Starting Docker bridge container...
cd /d "%~dp0"
docker compose up -d

echo.
echo Claude Signal Bridge is running!
echo   Settings: http://127.0.0.1:%WEB_PORT%
echo.
pause
