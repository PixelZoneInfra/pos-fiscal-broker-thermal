// Recover only a stale PID lock. Never open the journal for writing or talk to USB.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const appName = require('../package.json').name;
const ROOT = path.resolve(__dirname, '..');

function journalDirectory(env = process.env) {
  if (!env.APPDATA || !path.isAbsolute(env.APPDATA)) {
    throw new Error('Brak prawidlowego APPDATA. Nie zmieniono zadnych plikow.');
  }
  return path.join(env.APPDATA, appName, 'fiscal-operations');
}

function pidExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw new Error(`Nie mozna bezpiecznie sprawdzic PID ${pid}. Nie ruszono blokady.`);
  }
}

// Same PID-file protocol as the existing panel, without replacing its installed code.
function panelLock(root) {
  const data = path.join(root, 'local-results');
  fs.mkdirSync(data, { recursive: true });
  const target = path.join(data, 'broker-panel.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(target, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid));
      fs.fsyncSync(fd);
      return () => {
        if (fs.readFileSync(target, 'utf8') === String(process.pid)) fs.unlinkSync(target);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = fs.readFileSync(target, 'utf8');
      const pid = Number(previous);
      if (!/^[1-9][0-9]*$/.test(previous) || !Number.isSafeInteger(pid) || pid > 0xffffffff || pidExists(pid)) {
        throw new Error('Start, stop lub inne odzyskiwanie nadal pracuje. Poczekaj. Nie ruszono blokady dziennika.');
      }
      if (fs.readFileSync(target, 'utf8') !== previous) throw new Error('Blokada przyciskow zmienila sie. Nie ruszono dziennika.');
      fs.unlinkSync(target);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  throw new Error('Nie mozna uzyskac blokady przyciskow. Nie ruszono dziennika.');
}

function portIsFree(port = 3030) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000, () => socket.destroy(new Error('Port 3030 nie odpowiada jednoznacznie. Nie ruszono blokady.')));
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') resolve(true);
      else reject(error);
    });
  });
}

function windowsProcesses() {
  if (process.platform !== 'win32') return Promise.reject(new Error('Odzyskiwanie stanowiska jest przeznaczone dla Windows.'));
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) return Promise.reject(new Error('Brak katalogu Windows. Nie ruszono blokady.'));
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const source = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$items = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
  Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine,
    @{Name='StartedAt'; Expression={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } }})
ConvertTo-Json -InputObject $items -Compress
`;
  return new Promise((resolve, reject) => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      { windowsHide: true, encoding: 'utf8', timeout: 12000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(new Error('Nie udalo sie sprawdzic procesow Windows. Nie ruszono blokady.'));
        try {
          const rows = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
          if (!Array.isArray(rows) || rows.some(row => !Number.isSafeInteger(row.ProcessId) || !row.Name)) throw new Error();
          resolve(rows);
        } catch { reject(new Error('Nieprawidlowy wynik sprawdzania procesow. Nie ruszono blokady.')); }
      });
  });
}

function ownRecoveryWrapper(row, root, parentPid = process.ppid) {
  if (row?.ProcessId !== parentPid || !/^(wscript|cscript)\.exe$/i.test(row.Name || '') ||
    !/[\\/](wscript|cscript)\.exe$/i.test(row.ExecutablePath || '')) return false;
  // Shell.Run waits for Node, so the VBS host is still alive during recovery.
  // Exclude only our direct parent executing this exact VBS, not every script host.
  const args = (row.CommandLine || '').match(/"[^"]*"|\S+/g)?.map(arg => arg.replace(/^"|"$/g, '')) || [];
  const script = args.slice(1).find(arg => !arg.startsWith('//'));
  return script?.toLowerCase() === path.join(path.resolve(root), 'Odzyskaj po awarii.vbs').toLowerCase();
}

function assertNoBroker(rows, root, ownPid = process.pid, parentPid = process.ppid) {
  if (!Array.isArray(rows)) throw new Error('Brak pewnej listy procesow. Nie ruszono blokady.');
  const normalizedRoot = path.resolve(root).toLowerCase();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.ProcessId) || typeof row.Name !== 'string') throw new Error('Nieprawidlowa lista procesow. Nie ruszono blokady.');
    if (row.ProcessId === ownPid || ownRecoveryWrapper(row, root, parentPid)) continue;
    const name = row.Name.toLowerCase();
    const command = typeof row.CommandLine === 'string' ? row.CommandLine.toLowerCase() : '';
    const executable = typeof row.ExecutablePath === 'string' ? row.ExecutablePath.toLowerCase() : '';
    if (name === 'electron.exe' || name === `${appName}.exe` ||
      executable.includes('pos-fiscal-broker') || command.includes('pos-fiscal-broker') ||
      executable.includes(normalizedRoot + path.sep) || command.includes(normalizedRoot) ||
      /review-operation\.js|recover-journal-lock\.js/.test(command)) {
      throw new Error(`Proces ${row.Name} (PID ${row.ProcessId}) moze uzywac brokera. Zamknij go normalnie lub uruchom ponownie Windows. Nie ruszono blokady.`);
    }
    if (name === 'node.exe' && (!command || !executable)) {
      throw new Error(`Nie mozna rozpoznac procesu Node PID ${row.ProcessId}. Nie ruszono blokady.`);
    }
  }
}

function lockOwnerState(pid, original, rows, root, isAlive) {
  if (!isAlive(pid)) return 'absent';
  const owner = rows.find(row => row.ProcessId === pid);
  // These processes are known not to open operations.lock. Windows can reuse an
  // old broker PID for the very Node/VBS processes doing this recovery.
  if (pid === process.pid || ownRecoveryWrapper(owner, root)) return 'reused_by_recovery';
  const startedAt = Date.parse(owner?.StartedAt);
  const lockTime = Math.max(original.stat.birthtimeMs, original.stat.mtimeMs);
  // Do not infer reuse from a different executable alone. Require evidence that
  // it started after the lock existed, allowing one second for timestamp precision.
  if (Number.isFinite(startedAt) && startedAt > lockTime + 1000) return 'reused_after_lock';
  throw new Error(`Nie mozna potwierdzic, ze PID ${pid} z operations.lock jest osierocony. Nie ruszono blokady.`);
}

function readRegular(filename, maxSize) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.nlink !== 1 || (maxSize && stat.size > maxSize)) {
    throw new Error(`Nieprawidlowy plik ${path.basename(filename)}. Nie ruszono blokady.`);
  }
  return { bytes: fs.readFileSync(filename), stat };
}

function unchanged(filename, original) {
  const current = readRegular(filename);
  if (current.stat.dev !== original.stat.dev || current.stat.ino !== original.stat.ino ||
    !current.bytes.equals(original.bytes)) throw new Error('Pliki zmienily sie podczas sprawdzania. Nie ruszono blokady.');
}

function saveExclusive(filename, bytes) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

async function recover({ root = ROOT, directory = journalDirectory(),
  isAlive = pidExists, freePort = portIsFree, processes = windowsProcesses } = {}) {
  const release = panelLock(root);
  try {
    const lockPath = path.join(directory, 'operations.lock');
    let original;
    try { original = readRegular(lockPath, 64); }
    catch (error) {
      if (error.code === 'ENOENT') return { changed: false, directory,
        message: `Brak operations.lock w:\n${directory}\n\nNie ma blokady do odzyskania. Nie usunieto zadnych danych. Jesli start nadal nie dziala, sprawdz local-results\\broker-start.log.` };
      throw error;
    }
    const text = original.bytes.toString('utf8').trim();
    const pid = Number(text);
    if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(pid) || pid > 0xffffffff) {
      throw new Error('operations.lock nie zawiera prawidlowego PID. Nie zmieniono pliku; potrzebna jest weryfikacja.');
    }
    const check = async () => {
      if (!await freePort()) throw new Error('Port 3030 jest zajety. Broker lub inna aplikacja nadal dziala. Nie ruszono blokady.');
      const rows = await processes();
      assertNoBroker(rows, root);
      return lockOwnerState(pid, original, rows, root, isAlive);
    };
    const ownerState = await check();
    const journalPath = path.join(directory, 'operations.jsonl');
    let journal;
    try { journal = readRegular(journalPath); }
    catch { throw new Error('Brak prawidlowego operations.jsonl obok blokady. Nie ruszono plikow. Sprawdz, czy dziennik nie zostal przeniesiony lub usuniety.'); }
    const backupParent = path.join(directory, 'lock-recovery-backups');
    fs.mkdirSync(backupParent, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(backupParent).isDirectory() || fs.lstatSync(backupParent).isSymbolicLink()) throw new Error('Nieprawidlowy katalog kopii. Nie ruszono blokady.');
    const backup = path.join(backupParent, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
    fs.mkdirSync(backup, { mode: 0o700 });
    saveExclusive(path.join(backup, 'operations.jsonl'), journal.bytes);
    saveExclusive(path.join(backup, 'recovery.json'), JSON.stringify({ version: 1, action: 'archive_stale_pid_lock', pid, ownerState,
      time: new Date().toISOString(), journalSha256: createHash('sha256').update(journal.bytes).digest('hex') }, null, 2) + '\n');
    // Repeat checks after creating the backup. Keep the original lock present until the final rename.
    await check();
    unchanged(journalPath, journal);
    unchanged(lockPath, original);
    fs.renameSync(lockPath, path.join(backup, 'operations.lock'));
    return { changed: true, directory, backup, pid,
      message: `Odzyskano osierocona blokade PID ${pid}.\n\nBlokada i kopia dziennika:\n${backup}\n\nOryginalny operations.jsonl zachowano bez zmian.\nTeraz kliknij Uruchom na nowo, potem Sprawdz stan.\n\nNie powtarzaj niepewnego paragonu. Operacja przerwana przez zanik zasilania moze wymagac osobnej weryfikacji. Broker nie zostal uruchomiony automatycznie.` };
  } finally { release(); }
}

if (require.main === module) {
  const resultPath = process.argv[2];
  const writeResult = message => fs.writeFileSync(resultPath, '\ufeff' + message.replace(/\n/g, '\r\n'), 'utf16le');
  Promise.resolve().then(() => {
    if (process.platform !== 'win32') throw new Error('Ten przycisk jest przeznaczony dla Windows.');
    return recover();
  }).then(result => writeResult(result.message)).catch(error => {
    try { writeResult(error.message); } catch { /* VBS reports a missing result. */ }
    process.exitCode = 1;
  });
}

module.exports = { recover, journalDirectory, pidExists, portIsFree, windowsProcesses, assertNoBroker };
