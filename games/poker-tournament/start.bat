@echo off
setlocal
title Poker Night server
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

echo Building the website...
call npm run build --silent || goto :fail

rem Find Tailscale on PATH or in its default install folder.
set "TS="
where tailscale >nul 2>nul && set "TS=tailscale"
if not defined TS if exist "%ProgramFiles%\Tailscale\tailscale.exe" set "TS=%ProgramFiles%\Tailscale\tailscale.exe"

if defined TS (
  echo Opening Tailscale Funnel...
  "%TS%" funnel --bg 3000 >nul || echo   WARNING: Tailscale Funnel did not start. The site only works on this PC until it does - see SETUP.md.
) else (
  echo   WARNING: Tailscale is not installed. The site only works on this PC - see SETUP.md.
)

node --disable-warning=ExperimentalWarning src\server\index.ts

if defined TS "%TS%" funnel --https=443 off >nul 2>nul
echo.
echo Server stopped and Funnel closed. You can close this window.
pause
exit /b 0

:fail
echo.
echo Something went wrong - see the messages above.
pause
exit /b 1
