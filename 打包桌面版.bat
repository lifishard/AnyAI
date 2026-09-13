@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 goto nonode
node "scripts\build-desktop.mjs" --install %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
:nonode
echo Node.js is required. Install Node.js 20 or newer, then retry.
pause
exit /b 1
