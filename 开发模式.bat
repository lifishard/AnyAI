@echo off
chcp 65001 > nul
setlocal
cd /d "%~dp0"

where node > nul 2>&1
if errorlevel 1 goto nonode

node "scripts\dev-desktop.mjs"
echo.
pause
exit /b 0

:nonode
echo.
echo   Node.js not found.
echo   Install it from https://nodejs.org then run this again.
echo.
pause
exit /b 1
