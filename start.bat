@echo off
rem Agent Office for Windows: double-click to install (first time) and open the window.
cd /d "%~dp0"
if "%PORT%"=="" set PORT=3000

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Opening the download page...
  start "" https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  call npm install --no-fund --no-audit
  if errorlevel 1 ( pause & exit /b 1 )
)

if not exist office.local.json (
  call npm run setup
  if errorlevel 1 ( pause & exit /b 1 )
)

start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%"
echo Agent Office: http://localhost:%PORT%   (close this window to stop)
echo Open your AI in the project selected during setup, then start a new task.
call npm start
pause
