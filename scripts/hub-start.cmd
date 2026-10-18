@echo off
rem How LucidHub starts Poker Night in the background: build, open the Funnel, run the server.
rem Same steps as start.bat, without the prompts. To run it yourself, use start.bat instead.
setlocal
cd /d "%~dp0.."

if not exist ".env" (
  echo No .env file found. Copy .env.example to .env and fill it in - see SETUP.md.
  exit /b 1
)
if not exist "node_modules" (
  echo Installing dependencies ^(first run only^)...
  call npm install || exit /b 1
)

echo Building the website...
call npm run build --silent || exit /b 1

set "TS="
where tailscale >nul 2>nul && set "TS=tailscale"
if not defined TS if exist "%ProgramFiles%\Tailscale\tailscale.exe" set "TS=%ProgramFiles%\Tailscale\tailscale.exe"
if defined TS (
  "%TS%" funnel --bg 3000 >nul || echo WARNING: Tailscale Funnel did not start. The site only works on this PC until it does.
) else (
  echo WARNING: Tailscale is not installed. The site only works on this PC - see SETUP.md.
)

node --disable-warning=ExperimentalWarning src\server\index.ts
