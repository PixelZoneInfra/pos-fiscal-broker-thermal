@echo off
setlocal
set "FISCAL_LAUNCH_PROFILE=managed"
cd /d "%~dp0"
if exist "%~dp0broker-local.cmd" call "%~dp0broker-local.cmd"
set "FISCAL_ENVIRONMENT=preview"
set "FISCAL_BRANCH_ID=1"
set "FISCAL_DIAGNOSTICS_ONLY=false"
set "FISCAL_ONLINE_ENABLED=true"
set "FISCAL_REQUIRE_POS_RESERVATION=true"

echo Test Website Preview na drukarce Banino. Polecenia fiskalne sa RZECZYWISTE.
echo POS musi miec FISCAL_ONLINE_AUTOMATIC=false. Uruchom po zamknieciu starego brokera.
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo BLAD: Brak Electron. Uruchom setup-windows.cmd albo uzyj przygotowanego folderu brokera.
  exit /b 2
)

echo Uruchamiam Electron. Pozostaw to okno otwarte; zatrzymuj przez Zamknij.vbs.
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
set "BROKER_START_EXIT=%errorlevel%"

echo Electron zakonczyl prace. Kod: %BROKER_START_EXIT%
exit /b %BROKER_START_EXIT%
