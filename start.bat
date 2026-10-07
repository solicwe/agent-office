@echo off
rem Agent Office for Windows: double-click to install (first time) and open the app.
cd /d "%~dp0"
if "%PORT%"=="" set PORT=3000

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Opening the download page...
  start "" https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  call npm install --no-fund --no-audit
  if errorlevel 1 ( pause & exit /b 1 )
)
if not exist .env copy .env.example .env >nul

start "" cmd /c "timeout /t 3 >nul & start http://localhost:%PORT%"
echo Agent Office: http://localhost:%PORT%   (close this window to stop)
call npm start
pause
