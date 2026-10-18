@echo off
setlocal
title LucidHub
cd /d "%~dp0"

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

node --disable-warning=ExperimentalWarning src\server\index.ts

echo.
echo Hub stopped. You can close this window.
pause
exit /b 0

:fail
echo.
echo Something went wrong - see the messages above.
pause
exit /b 1
