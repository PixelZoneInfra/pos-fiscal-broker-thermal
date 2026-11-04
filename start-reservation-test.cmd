@echo off
setlocal
set "FISCAL_LAUNCH_PROFILE=managed"
cd /d "%~dp0"
if exist "%~dp0broker-local.cmd" call "%~dp0broker-local.cmd"
set "FISCAL_DIAGNOSTICS_ONLY=false"
set "FISCAL_ONLINE_ENABLED=false"
set "FISCAL_REQUIRE_POS_RESERVATION=true"
echo Test rezerwacji: tylko zaktualizowany POS z obsluga tokenow. Online wylaczone.
call npm start
exit /b %errorlevel%
