@echo off
setlocal
set "FISCAL_LAUNCH_PROFILE=managed"
cd /d "%~dp0"
if exist "%~dp0broker-local.cmd" call "%~dp0broker-local.cmd"
set "FISCAL_DIAGNOSTICS_ONLY=false"
set "FISCAL_ONLINE_ENABLED=false"
set "FISCAL_REQUIRE_POS_RESERVATION=false"
echo Tryb obecnego POS: polecenia urzadzenia dozwolone. Online wylaczone.
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo BLAD: Brak node_modules\electron\dist\electron.exe. Uzyj obecnego folderu brokera.
  exit /b 2
)
echo Uruchamiam bezposrednio Electron. Oczekuje na API port 3030.
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
set "BROKER_START_EXIT=%errorlevel%"
echo Electron zakonczyl prace. Kod: %BROKER_START_EXIT%
exit /b %BROKER_START_EXIT%
