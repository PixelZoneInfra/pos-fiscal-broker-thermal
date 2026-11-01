@echo off
setlocal
cd /d "%~dp0"
node -e "if(Number(process.versions.node.split('.')[0])<20)process.exit(1)"
if errorlevel 1 (
  echo Wymagany Node.js co najmniej 20 do uruchomienia testow.
  exit /b 1
)
call npm ci
if errorlevel 1 exit /b 1
call npm test
if errorlevel 1 exit /b 1
echo Przygotowanie zakonczone. Broker NIE zostal uruchomiony.
