@echo off
setlocal
set "FISCAL_LAUNCH_PROFILE=managed"
cd /d "%~dp0"
if exist "%~dp0broker-local.cmd" call "%~dp0broker-local.cmd"
set "FISCAL_ENVIRONMENT=production"
set "FISCAL_BRANCH_ID=1"
set "FISCAL_DIAGNOSTICS_ONLY=false"
set "FISCAL_ONLINE_ENABLED=true"
set "FISCAL_REQUIRE_POS_RESERVATION=true"
echo Produkcja Banino: rezerwacje POS i rzeczywiste paragony online.
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo BLAD: Brak Electron. Uzyj przygotowanego folderu brokera.
  exit /b 2
)
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b %errorlevel%
