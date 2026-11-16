$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repository = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('pos-fiscal-broker recovery ' + [guid]::NewGuid())
$previousAppData = $env:APPDATA
$previousFixture = $env:PIXELZONE_RECOVERY_FIXTURE
$previousRepository = $env:PIXELZONE_RECOVERY_REPOSITORY
$keeper = $null
try {
  New-Item -ItemType Directory -Path (Join-Path $fixture 'tools') -Force | Out-Null
  Copy-Item (Join-Path $repository 'Odzyskaj po awarii.vbs') $fixture
  Copy-Item (Join-Path $repository 'package.json') $fixture
  Copy-Item (Join-Path $repository 'operation-journal.js') $fixture
  Copy-Item (Join-Path $repository 'tools/recover-journal-lock.js') (Join-Path $fixture 'tools')
  Copy-Item (Join-Path $repository 'tools/broker-panel.js') (Join-Path $fixture 'tools')
  foreach ($name in @('launch-profile.js', 'start-online-production.cmd')) {
    Copy-Item (Join-Path $repository $name) $fixture
  }
  $env:APPDATA = Join-Path $fixture 'fake appdata'
  $env:PIXELZONE_RECOVERY_FIXTURE = $fixture
  $env:PIXELZONE_RECOVERY_REPOSITORY = $repository
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
  $output = (& cscript.exe //NoLogo (Join-Path $fixture 'Odzyskaj po awarii.vbs')) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw "VBS recovery failed: $output" }
  if (Test-Path $lockPath) { throw 'Stale operations.lock was not removed from AppData.' }
  if ((Get-FileHash $journalPath -Algorithm SHA256).Hash -ne $before) { throw 'Original journal changed.' }
  $backups = @(Get-ChildItem (Join-Path $directory 'lock-recovery-backups') -Directory)
  if ($backups.Count -ne 1) { throw 'Expected one recovery backup.' }
  if ((Get-FileHash (Join-Path $backups[0].FullName 'operations.jsonl') -Algorithm SHA256).Hash -ne $before) { throw 'Backup differs from original journal.' }
  $output = (& cscript.exe //NoLogo (Join-Path $fixture 'Odzyskaj po awarii.vbs')) -join "`n"
  if ($LASTEXITCODE -ne 0 -or $output -notmatch 'Brak operations.lock') { throw "Second recovery was not a no-op: $output" }

  # An alive broker-shaped process without an API must still prevent removal.
  $resetLock = @'
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.env.APPDATA, 'pos-fiscal-broker-thermal', 'fiscal-operations', 'operations.lock'), String(process.pid));
'@
  node -e $resetLock
  if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare the live-process fixture.' }

  # Reproduce the production failure: process.kill(pid, 0) can throw EPERM.
  # Only this isolated copied helper is instrumented; it must use real CIM.
  $helper = Join-Path $fixture 'tools/recover-journal-lock.js'
  $denyProbe = @'
process.kill = () => {
  require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', 'pid-probe-denied'), 'EPERM');
  throw Object.assign(new Error('denied PID probe fixture'), { code: 'EPERM' });
};
'@
  [IO.File]::WriteAllText($helper, $denyProbe + "`n" + [IO.File]::ReadAllText($helper))
  $output = (& cscript.exe //NoLogo (Join-Path $fixture 'Odzyskaj po awarii.vbs')) -join "`n"
  if ($LASTEXITCODE -ne 0 -or (Test-Path $lockPath)) { throw "Denied Node probe did not recover through CIM: $output" }
  if (-not (Test-Path (Join-Path $fixture 'pid-probe-denied'))) { throw 'Denied Node probe was not exercised.' }
  if ((Get-FileHash $journalPath -Algorithm SHA256).Hash -ne $before) { throw 'CIM fallback changed the journal.' }
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
  $output = (& cscript.exe //NoLogo (Join-Path $fixture 'Odzyskaj po awarii.vbs')) -join "`n"
  if ($LASTEXITCODE -eq 0 -or $output -notmatch 'Proces node.exe') { throw "Expected live-process refusal: $output" }
  if (-not (Test-Path $lockPath) -or (Get-Content -Raw $lockPath) -ne $lockBefore) { throw 'Live-process test changed the lock.' }
  if ((Get-FileHash $journalPath -Algorithm SHA256).Hash -ne $before) { throw 'Live-process test changed the journal.' }
  Stop-Process -InputObject $keeper -Force
  $keeper.WaitForExit()
  $keeper = $null

  # Full operator flow after a crash. Use the real recovery VBS, CMD, process panel,
  # journal and HTTP controls, with a Node fixture in place of Electron/USB.
  # Match the production incident: the old PID now belongs to an unrelated live
  # Windows process (this PowerShell), and copying reset the lock's CreationTime.
  Set-Content -Path $lockPath -NoNewline -Encoding ascii -Value ([string]$PID)
  (Get-Item $lockPath).LastWriteTime = (Get-Date).AddDays(-4)
  $output = (& cscript.exe //NoLogo (Join-Path $fixture 'Odzyskaj po awarii.vbs')) -join "`n"
  if ($LASTEXITCODE -ne 0 -or (Test-Path $lockPath)) { throw "Pre-restart recovery failed: $output" }
  $panelPath = Join-Path $fixture 'tools/broker-panel.js'
  [IO.File]::WriteAllText($panelPath, $denyProbe + "`n" + [IO.File]::ReadAllText($panelPath))
  $controlPath = Join-Path $fixture 'local-results/broker-control.json'
  @{version=1; pid=$PID; root=$fixture; port=3030; instance_id='stale-instance'; token=('a' * 64)} |
    ConvertTo-Json -Compress | Set-Content -Path $controlPath -Encoding utf8
  @{version=1; profile='online-production'} | ConvertTo-Json -Compress |
    Set-Content -Path (Join-Path $fixture 'local-results/broker-profile.json') -Encoding utf8
  $packagePath = Join-Path $fixture 'package.json'
  $package = Get-Content -Raw $packagePath | ConvertFrom-Json
  $package.main = 'fixture-main.js'
  $package | ConvertTo-Json | Set-Content -Path $packagePath -Encoding utf8
  $fakeElectron = Join-Path $fixture 'node_modules/electron/dist/electron.exe'
  New-Item -ItemType Directory -Path (Split-Path -Parent $fakeElectron) -Force | Out-Null
  Copy-Item $nodePath $fakeElectron
  Set-Content -Path (Join-Path $fixture 'fixture-main.js') -Encoding utf8 -Value @'
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const repo = process.env.PIXELZONE_RECOVERY_REPOSITORY;
const express = require(path.join(repo, 'node_modules', 'express'));
const { OperationJournal } = require('./operation-journal');
const { createControl } = require(path.join(repo, 'broker-control'));
const { saveProfile, profileFromEnvironment } = require('./launch-profile');
const journal = new OperationJournal(path.join(process.env.APPDATA, 'pos-fiscal-broker-thermal', 'fiscal-operations'));
fs.writeFileSync(path.join(root, 'fake-broker.pid'), String(process.pid));
const printer = { config: {}, busy: null, reservations: { active: () => null }, status: () => ({
  api_version: 2, busy: null, journalHealthy: journal.healthy, blockedOperations: journal.blocked(),
  serialPort: 'MOCK', environment: process.env.FISCAL_ENVIRONMENT, branch_id: Number(process.env.FISCAL_BRANCH_ID),
  onlineOperationsEnabled: process.env.FISCAL_ONLINE_ENABLED === 'true',
  posReservationRequired: process.env.FISCAL_REQUIRE_POS_RESERVATION === 'true', diagnosticsOnly: false,
}) };
let server;
const control = createControl({ root, printer, journal, port: { isOpen: false }, transport: {},
  onStopped: () => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
  }),
});
server = control.attach(express(), express()).listen(3030, '127.0.0.1', () => {
  control.publish(3030);
  saveProfile(root, profileFromEnvironment(process.env));
});
'@
  # Invoke the exact Node commands used by the three GUI VBS buttons. Read their
  # UTF-16 result files without displaying a blocking MsgBox on the CI desktop.
  $panelResult = Join-Path $fixture 'panel-result.txt'
  node $panelPath restart $panelResult
  $panelExit = $LASTEXITCODE
  $output = Get-Content -Raw -Encoding Unicode $panelResult
  if ($panelExit -ne 0 -or $output -notmatch 'Uruchomiono broker') { throw "Restart after recovery failed: $output" }
  $status = Invoke-RestMethod -Uri 'http://127.0.0.1:3030/broker/status' -TimeoutSec 5
  if ($status.environment -ne 'production' -or $status.branch_id -ne 1 -or -not $status.onlineOperationsEnabled -or -not $status.posReservationRequired) { throw 'Restart changed the production profile.' }
  if ($status.blockedOperations -notcontains 'interrupted-fixture') { throw 'Restart lost the unresolved operation.' }
  node $panelPath status $panelResult
  $panelExit = $LASTEXITCODE
  $output = Get-Content -Raw -Encoding Unicode $panelResult
  if ($panelExit -ne 0 -or $output -notmatch 'Broker odpowiada') { throw "Status button failed: $output" }
  node $panelPath stop $panelResult
  $panelExit = $LASTEXITCODE
  $output = Get-Content -Raw -Encoding Unicode $panelResult
  if ($panelExit -ne 0) { throw "Shutdown after recovery failed: $output" }
  if ((Test-Path $lockPath) -or (Test-Path $controlPath)) { throw 'Shutdown left a journal lock or a control descriptor.' }
  Write-Output 'Windows recovery/restart passed: copied lock, live unrelated reused PID, denied Node probes, production profile, unresolved journal and normal shutdown.'
}
finally {
  if ($keeper -and -not $keeper.HasExited) { Stop-Process -InputObject $keeper -Force }
  $fakePidPath = Join-Path $fixture 'fake-broker.pid'
  if (Test-Path $fakePidPath) {
    $fakePid = [int](Get-Content -Raw $fakePidPath)
    $fakeProcess = Get-Process -Id $fakePid -ErrorAction SilentlyContinue
    if ($fakeProcess -and $fakeProcess.Path -eq (Join-Path $fixture 'node_modules/electron/dist/electron.exe')) {
      Stop-Process -InputObject $fakeProcess -Force
    }
  }
  $env:APPDATA = $previousAppData
  $env:PIXELZONE_RECOVERY_FIXTURE = $previousFixture
  $env:PIXELZONE_RECOVERY_REPOSITORY = $previousRepository
  if (Test-Path $fixture) { Remove-Item $fixture -Recurse -Force }
}
exit 0
