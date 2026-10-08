@echo off
rem Agent Office for Windows: double-click to install (first time) and open the app.
cd /d "%~dp0"
if "%PORT%"=="" set PORT=3000

where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto nonode
goto haveNode
:nonode
(
  echo Node.js 22.13 or newer is required. Opening the download page...
  start "" https://nodejs.org/
  pause
  exit /b 1
)
:haveNode

if not exist node_modules (
  call npm install --no-fund --no-audit
  if errorlevel 1 ( pause & exit /b 1 )
)
if not exist .env copy .env.example .env >nul

rem Open the app signed in as the owner (the token is created on first start).
start "" cmd /c "timeout /t 4 >nul & for /f %%t in (data\owner-token.txt) do start http://localhost:%PORT%/owner?token=%%t"
echo Agent Office: http://localhost:%PORT%   (close this window to stop)
call npm start
pause
