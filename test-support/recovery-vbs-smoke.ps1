$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repository = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('pos-fiscal-broker recovery ' + [guid]::NewGuid())
$previousAppData = $env:APPDATA
$previousFixture = $env:PIXELZONE_RECOVERY_FIXTURE
$keeper = $null
try {
  New-Item -ItemType Directory -Path (Join-Path $fixture 'tools') -Force | Out-Null
  Copy-Item (Join-Path $repository 'Odzyskaj po awarii.vbs') $fixture
  Copy-Item (Join-Path $repository 'package.json') $fixture
  Copy-Item (Join-Path $repository 'operation-journal.js') $fixture
  Copy-Item (Join-Path $repository 'tools/recover-journal-lock.js') (Join-Path $fixture 'tools')
  $env:APPDATA = Join-Path $fixture 'fake appdata'
  $env:PIXELZONE_RECOVERY_FIXTURE = $fixture
  New-Item -ItemType Directory -Path $env:APPDATA | Out-Null
  $initialize = @'
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.PIXELZONE_RECOVERY_FIXTURE;
const { OperationJournal } = require(path.join(root, 'operation-journal'));
const directory = path.join(process.env.APPDATA, 'pos-fiscal-broker-thermal', 'fiscal-operations');
const journal = new OperationJournal(directory);
journal.save({ id: 'confirmed-fixture', state: 'fiscal_confirmed', result: { receipt: { documentNumber: 42 } } });
journal.save({ id: 'interrupted-fixture', state: 'in_progress' });
journal.close();
fs.writeFileSync(path.join(directory, 'operations.lock'), String(process.pid));
'@
  node -e $initialize
  if ($LASTEXITCODE -ne 0) { throw 'Cannot initialize recovery fixture.' }
  $directory = Join-Path $env:APPDATA 'pos-fiscal-broker-thermal/fiscal-operations'
  $journalPath = Join-Path $directory 'operations.jsonl'
  $lockPath = Join-Path $directory 'operations.lock'
  $before = (Get-FileHash $journalPath -Algorithm SHA256).Hash

  # Real VBS -> Node -> Windows PowerShell/CIM. The waiting cscript parent must
  # not be classified as a broker merely because its path contains the repo name.
  $output = & cscript.exe //NoLogo (Join-Path $fixture 'Odzyskaj po awarii.vbs')
  if ($LASTEXITCODE -ne 0) { throw "VBS recovery failed: $output" }
  if (Test-Path $lockPath) { throw 'Stale operations.lock was not removed from AppData.' }
  if ((Get-FileHash $journalPath -Algorithm SHA256).Hash -ne $before) { throw 'Original journal changed.' }
  $backups = @(Get-ChildItem (Join-Path $directory 'lock-recovery-backups') -Directory)
  if ($backups.Count -ne 1) { throw 'Expected one recovery backup.' }
  if ((Get-FileHash (Join-Path $backups[0].FullName 'operations.jsonl') -Algorithm SHA256).Hash -ne $before) { throw 'Backup differs from original journal.' }
  $output = & cscript.exe //NoLogo (Join-Path $fixture 'Odzyskaj po awarii.vbs')
  if ($LASTEXITCODE -ne 0 -or $output -notmatch 'Brak operations.lock') { throw "Second recovery was not a no-op: $output" }

  # An alive broker-shaped process without an API must still prevent removal.
  $resetLock = @'
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.env.APPDATA, 'pos-fiscal-broker-thermal', 'fiscal-operations', 'operations.lock'), String(process.pid));
'@
  node -e $resetLock
  if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare the live-process fixture.' }
  $lockBefore = Get-Content -Raw $lockPath
  $keeperScript = Join-Path $fixture 'simulated-broker.js'
  Set-Content -Path $keeperScript -Encoding utf8 -Value @'
require('node:fs').writeFileSync(require('node:path').join(__dirname, 'keeper-ready'), String(process.pid));
setInterval(() => {}, 1000);
'@
  $nodePath = (Get-Command node.exe).Source
  $keeper = Start-Process -FilePath $nodePath -ArgumentList ('"' + $keeperScript + '"') -PassThru -WindowStyle Hidden
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not (Test-Path (Join-Path $fixture 'keeper-ready'))) {
    if ($keeper.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Fixture process did not start.' }
    Start-Sleep -Milliseconds 100
  }
  $output = & cscript.exe //NoLogo (Join-Path $fixture 'Odzyskaj po awarii.vbs')
  if ($LASTEXITCODE -eq 0 -or $output -notmatch 'Proces node.exe') { throw "Expected live-process refusal: $output" }
  if (-not (Test-Path $lockPath) -or (Get-Content -Raw $lockPath) -ne $lockBefore) { throw 'Live-process test changed the lock.' }
  if ((Get-FileHash $journalPath -Algorithm SHA256).Hash -ne $before) { throw 'Live-process test changed the journal.' }
  Write-Output 'Windows VBS/CIM recovery passed: stale lock removed, journal preserved, live process refused.'
}
finally {
  if ($keeper -and -not $keeper.HasExited) { Stop-Process -InputObject $keeper -Force }
  $env:APPDATA = $previousAppData
  $env:PIXELZONE_RECOVERY_FIXTURE = $previousFixture
  if (Test-Path $fixture) { Remove-Item $fixture -Recurse -Force }
}
exit 0
