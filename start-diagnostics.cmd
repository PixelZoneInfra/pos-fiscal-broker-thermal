@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0broker-local.cmd" call "%~dp0broker-local.cmd"
set "FISCAL_DIAGNOSTICS_ONLY=true"
set "FISCAL_ONLINE_ENABLED=false"
set "FISCAL_REQUIRE_POS_RESERVATION=false"
echo Tryb odczytowy: drukowanie i operacje kasowe zablokowane.
call npm start
exit /b %errorlevel%
