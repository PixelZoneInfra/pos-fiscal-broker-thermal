const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'local-results');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameRoot = root => typeof root === 'string' &&
  (process.platform === 'win32' ? path.resolve(root).toLowerCase() === ROOT.toLowerCase() : path.resolve(root) === ROOT);
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

function request(route, { method = 'GET', token, timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 3030, path: route, method,
      headers: token ? { 'X-Local-Control-Token': token } : {} }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy(new Error('Nieprawidłowa odpowiedź brokera.')); });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { reject(new Error('Port 3030 odpowiada w nieznanym formacie. Nie zatrzymano żadnego procesu.')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Broker nie odpowiada. Nie zatrzymano procesu. Sprawdź plik local-results\\broker-start.log.')), timeout);
    req.once('close', () => clearTimeout(timer));
    req.once('error', reject);
    req.end();
  });
}

function descriptor() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'broker-control.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Nie można odczytać pliku sterowania brokera. Nie zatrzymano procesu.'); }
}

async function inspect() {
  try {
    const response = await request('/broker/status');
    if (response.status !== 200 || response.body.api_version !== 2) throw new Error('Na porcie 3030 działa inna lub nieprawidłowa aplikacja. Nie zatrzymano jej.');
    return response.body;
  } catch (error) { if (error.code === 'ECONNREFUSED') return null; throw error; }
}

function describe(status) {
  if (!status) return 'Broker jest wyłączony.\n\nAby go włączyć, kliknij „Uruchom na nowo”.';
  const lines = ['Broker odpowiada.', `Port drukarki: ${status.serialPort || 'brak danych'}.`];
  const local = status.local_control;
  if (local) {
    lines.push(`Połączenie z portem USB/COM: ${local.serial_connected ? 'otwarte' : 'BRAK — sprawdź drukarkę i kabel'}.`);
    if (local.state !== 'running') lines.push('Broker właśnie kończy pracę.');
  }
  lines.push(status.busy ? 'Trwa operacja drukarki — poczekaj.' : 'Brak bieżącej operacji drukarki.');
  if (!status.journalHealthy || status.blockedOperations?.length) {
    lines.push('UWAGA: drukowanie jest zablokowane. Potrzebna jest weryfikacja poprzedniej operacji. Restart nie usuwa tej blokady.');
  }
  if (status.reservation) lines.push('Drukarka jest zarezerwowana przez POS.');
  if (status.diagnosticsOnly) lines.push('Włączony tryb diagnostyczny — sprzedaż jest zablokowana.');
  if (!local) lines.push('Działa starsza wersja bez przycisków sterowania.');
  lines.push('\nTen test nie drukuje i nie sprawdza papieru w drukarce.');
  return lines.join('\n');
}

// One-time upgrade: show the OLD hidden window so the user can close it normally.
// Verify the listening executable before touching its window. Never terminate a process.
async function revealOldWindow() {
  if (process.platform !== 'win32') return false;
  const source = `
$ErrorActionPreference = 'Stop'
$expected = [IO.Path]::GetFullPath((Join-Path $env:PIXELZONE_BROKER_ROOT 'node_modules\\electron\\dist\\electron.exe'))
$ownerIds = @(Get-NetTCPConnection -LocalPort 3030 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
if ($ownerIds.Count -ne 1) { exit 1 }
$targetId = [int]$ownerIds[0]
$target = Get-Process -Id $targetId
if (-not [string]::Equals($target.Path, $expected, [StringComparison]::OrdinalIgnoreCase)) { exit 1 }
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class BrokerWindows {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
$script:found = $false
$callback = [BrokerWindows+Callback]{ param($handle, $unused)
  [uint32]$windowOwner = 0
  [void][BrokerWindows]::GetWindowThreadProcessId($handle, [ref]$windowOwner)
  $class = New-Object Text.StringBuilder 256
  [void][BrokerWindows]::GetClassName($handle, $class, 256)
  if ($windowOwner -eq $targetId -and $class.ToString().StartsWith('Chrome_WidgetWin')) {
    [void][BrokerWindows]::ShowWindowAsync($handle, 9)
    [void][BrokerWindows]::SetForegroundWindow($handle)
    $script:found = $true
  }
  return $true
}
[void][BrokerWindows]::EnumWindows($callback, [IntPtr]::Zero)
if (-not $script:found) { exit 1 }
exit 0
`;
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], {
      windowsHide: true, env: { ...process.env, PIXELZONE_BROKER_ROOT: ROOT }, stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', () => resolve(false));
    child.on('exit', code => resolve(code === 0));
    child.stdin.on('error', () => {});
    child.stdin.end(source.replace(/\n/g, '\r\n'));
  });
}

async function stop(status) {
  const local = descriptor();
  if (!status) {
    if (local && sameRoot(local.root) && alive(local.pid)) throw new Error('Proces brokera jeszcze działa, ale API nie odpowiada. Nie uruchomiono drugiej kopii. Sprawdź plik local-results\\broker-start.log.');
    return false;
  }
  if (!status.local_control) {
    const revealed = await revealOldWindow();
    throw new Error(revealed ? 'Pokazano okno poprzedniej wersji brokera.\n\nDokończ obsługę klienta, zamknij to okno krzyżykiem, a potem kliknij „Uruchom na nowo”. To potrzebne tylko przy pierwszym przejściu na te pliki.' :
      'Działa poprzednia wersja brokera.\n\nDokończ obsługę klienta i zamknij poprzednie okno brokera krzyżykiem. Potem kliknij „Uruchom na nowo”. Nie zatrzymano żadnego procesu na siłę.');
  }
  if (!local || !sameRoot(local.root) || local.port !== 3030 || local.instance_id !== status.local_control.instance_id ||
    !Number.isSafeInteger(local.pid) || !/^[a-f0-9]{64}$/.test(local.token)) {
    throw new Error('Broker działa z innego folderu albo brakuje jego pliku sterowania. Użyj przycisków z folderu uruchomionej wersji. Nie zatrzymano procesu.');
  }
  const result = await request('/broker/control/stop', { method: 'POST', token: local.token, timeout: 195000 });
  if (result.status !== 200 || !result.body.success || result.body.instance_id !== local.instance_id) {
    throw new Error(result.body.message || 'Broker odmówił zatrzymania. Pozostaje uruchomiony.');
  }
  const deadline = Date.now() + 30000;
  while (alive(local.pid)) {
    if (Date.now() >= deadline) throw new Error('Broker kończy pracę dłużej niż zwykle. Nie uruchomiono drugiej kopii. Poczekaj i sprawdź stan.');
    await pause(200);
  }
  return true;
}

async function launch() {
  if (process.platform !== 'win32') throw new Error('Te przyciski są przeznaczone dla Windows.');
  if (!fs.existsSync(path.join(ROOT, 'start-pos.cmd'))) throw new Error('Brak start-pos.cmd. Rozpakuj paczkę do obecnego folderu brokera.');
  fs.mkdirSync(DATA, { recursive: true });
  let exited = false;
  let exitCode;
  let startError;
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'call start-pos.cmd >> local-results\\broker-start.log 2>&1'], {
      cwd: ROOT, detached: true, windowsHide: true, stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('error', error => { startError = error; });
    child.once('exit', code => { exited = true; exitCode = code; });
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await pause(500);
    const status = await inspect();
    if (status) {
      const local = descriptor();
      if (!local || !sameRoot(local.root) || local.instance_id !== status.local_control?.instance_id) {
        throw new Error('Na porcie 3030 pojawiła się inna wersja. Sprawdź, z którego folderu uruchomiono broker.');
      }
      return status;
    }
    if (startError) throw new Error(`Nie udało się uruchomić brokera: ${startError.message}`);
    if (exited) throw new Error(`Broker zakończył start bez działającego API (kod ${exitCode}). Sprawdź plik local-results\\broker-start.log.`);
  }
  throw new Error('Broker nie uruchomił się w ciągu 45 sekund. Sprawdź plik local-results\\broker-start.log. Nie usuwaj plików dziennika operacji.');
}

function lock() {
  fs.mkdirSync(DATA, { recursive: true });
  const target = path.join(DATA, 'broker-panel.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(target, String(process.pid), { flag: 'wx' }); return () => fs.unlinkSync(target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = Number(fs.readFileSync(target, 'utf8')); } catch { throw new Error('Nie można odczytać blokady przycisków sterowania.'); }
      if (!Number.isSafeInteger(previous) || previous < 1 || alive(previous)) {
        throw new Error('Przycisk uruchamiania lub zatrzymywania nadal pracuje. Poczekaj na jego końcowy komunikat. Ten komunikat nie oznacza drukowania paragonu.');
      }
      fs.unlinkSync(target);
    }
  }
  throw new Error('Nie można rozpocząć polecenia.');
}

async function run(action) {
  if (!['status', 'stop', 'restart'].includes(action)) throw new Error('Nieznany przycisk.');
  if (action === 'status') return describe(await inspect());
  const unlock = lock();
  try {
    await stop(await inspect());
    if (action === 'stop') return 'Broker jest wyłączony.\n\nAby go włączyć, kliknij „Uruchom na nowo”.';
    return 'Uruchomiono broker w tle.\n\n' + describe(await launch());
  } finally { unlock(); }
}

if (require.main === module) {
  run(process.argv[2]).then(message => {
    fs.writeFileSync(process.argv[3], '\ufeff' + message.replace(/\n/g, '\r\n'), 'utf16le');
  }).catch(error => {
    try { fs.writeFileSync(process.argv[3], '\ufeff' + error.message.replace(/\n/g, '\r\n'), 'utf16le'); }
    catch { /* VBS displays its own missing-result message. */ }
    process.exitCode = 1;
  });
}

module.exports = { describe, sameRoot, request, inspect, run };
