@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0broker-local.cmd" call "%~dp0broker-local.cmd"
set "FISCAL_DIAGNOSTICS_ONLY=false"
set "FISCAL_ONLINE_ENABLED=false"
set "FISCAL_REQUIRE_POS_RESERVATION=true"
echo Test rezerwacji: nie otwieraj obecnego POS. Polecenia wymagaja tokenu.
call npm start
exit /b %errorlevel%
