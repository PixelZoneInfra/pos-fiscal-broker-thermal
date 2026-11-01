@echo off
setlocal
cd /d "%~dp0"
node scripts/configure-pos.js
exit /b %errorlevel%
