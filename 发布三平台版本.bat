@echo off
chcp 65001 >nul 2>&1
node "%~dp0scripts\sync-github.mjs" --release %*
set "RC=%ERRORLEVEL%"
pause
exit /b %RC%
