@echo off
rem Starts Mis Finanzas locally and opens it in the browser. Double-click to run.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required: https://nodejs.org
  pause
  exit /b 1
)
node scripts\serve.mjs --open
pause
