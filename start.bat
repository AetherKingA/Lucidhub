@echo off
setlocal
title LucidHub
cd /d "%~dp0"

rem Already running (e.g. the desktop shortcut was clicked twice)? Just open the dashboard.
curl.exe -s -o nul --max-time 2 http://127.0.0.1:3100/api/health && (
  start "" http://localhost:3100
  exit /b 0
)

if not exist ".env" (
  echo.
  echo   No .env file found. Copy .env.example to .env and fill it in - see SETUP.md.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies ^(first run only^)...
  call npm install || goto :fail
)

echo Building the dashboard...
call npm run build --silent || goto :fail

rem Opens the dashboard in your browser once the hub is up. Game servers set to
rem "start with LucidHub" (Poker Night...) start too, and stop when this window closes.
set OPEN_DASHBOARD=1
node --disable-warning=ExperimentalWarning src\server\index.ts

echo.
echo LucidHub stopped. You can close this window.
pause
exit /b 0

:fail
echo.
echo Something went wrong - see the messages above.
pause
exit /b 1
