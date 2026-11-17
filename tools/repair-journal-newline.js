// Verify the entire existing hash chain; repair only its absent final LF.
// Never remove/truncate records, resolve operations, start the broker or talk to USB.
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { randomUUID, createHash } = require('node:crypto');
const { hash } = require('../operation-journal');
const { journalDirectory, portIsFree, windowsProcesses, assertNoBroker } = require('./recover-journal-lock');
const ROOT = path.resolve(__dirname, '..');

function verify(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw Error('Dziennik nie jest prawidlowym UTF-8. Nie zmieniono pliku.'); }
  let sequence = 0, previousHash = '';
  const records = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); }
    catch { throw Error(`Wpis ${sequence + 1} jest niepelny albo nie jest prawidlowym JSON. Nie zmieniono pliku; potrzebna jest weryfikacja kopii.`); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error(`Nieprawidlowy wpis ${sequence + 1}. Nie zmieniono pliku.`);
    const { digest, ...event } = row;
    if (event.sequence !== sequence + 1 || event.previousHash !== previousHash || digest !== hash(event) ||
        typeof event.record?.id !== 'string' || !event.record.id) {
      throw Error(`Niezgodny lancuch lub suma kontrolna we wpisie ${sequence + 1}. Nie zmieniono pliku; potrzebna jest weryfikacja kopii.`);
    }
    sequence = event.sequence; previousHash = digest; records.set(event.record.id, event.record);
  }
  return { sequence, lastHash: previousHash, operations: records.size,
    blockedOperations: [...records.values()].filter(r => ['unknown', 'in_progress'].includes(r.state)).map(r => r.id),
    needsNewline: bytes.length > 0 && bytes.at(-1) !== 0x0a };
}

function regular(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.nlink !== 1) throw Error(`Nieprawidlowy plik ${path.basename(filename)}. Nie zmieniono dziennika.`);
  return { stat, bytes: fs.readFileSync(filename) };
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
function save(filename, bytes) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

async function repair({ root = ROOT, directory = journalDirectory(), apply = false,
  freePort = portIsFree, processes = windowsProcesses } = {}) {
  const filename = path.join(directory, 'operations.jsonl');
  // Check mode does not even create a lock or backup.
  if (!apply) return { ...verify(regular(filename).bytes), changed: false, filename };
  const checkStopped = async () => {
    if (!await freePort()) throw Error('Port 3030 jest zajety. Najpierw zamknij broker. Nie zmieniono dziennika.');
    assertNoBroker(await processes(), root);
  };
  await checkStopped();
  const lockPath = path.join(directory, 'operations.lock');
  let lock;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); }
  catch (e) {
    if (e.code === 'EEXIST') throw Error('Istnieje operations.lock. Najpierw uzyj Odzyskaj po awarii.vbs przy wylaczonym brokerze. Nie zmieniono dziennika.');
    throw e;
  }
  let lockStat, backup;
  try {
    fs.writeFileSync(lock, String(process.pid)); fs.fsyncSync(lock); lockStat = fs.fstatSync(lock);
    const original = regular(filename);
    const report = verify(original.bytes);
    if (!report.needsNewline) return { ...report, changed: false, filename };
    const parent = path.join(directory, 'journal-newline-backups');
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(parent).isDirectory() || fs.lstatSync(parent).isSymbolicLink()) throw Error('Nieprawidlowy katalog kopii. Nie zmieniono dziennika.');
    backup = path.join(parent, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
    fs.mkdirSync(backup, { mode: 0o700 });
    save(path.join(backup, 'operations.jsonl'), original.bytes);
    const repaired = Buffer.concat([original.bytes, Buffer.from('\n')]);
    save(path.join(backup, 'repair.json'), JSON.stringify({ version: 1, action: 'append_missing_final_lf',
      preparedAt: new Date().toISOString(), filename, sequence: report.sequence, lastHash: report.lastHash,
      originalSha256: checksum(original.bytes), expectedSha256: checksum(repaired),
      blockedOperations: report.blockedOperations, addedBytes: 1 }, null, 2) + '\n');
    await checkStopped();
    const heldLock = regular(lockPath);
    if (!sameFile(lockStat, heldLock.stat) || heldLock.bytes.toString() !== String(process.pid)) throw Error('Blokada zmienila sie. Nie zmieniono dziennika.');
    const fd = fs.openSync(filename, 'r+');
    try {
      const currentStat = fs.lstatSync(filename);
      if (!currentStat.isFile() || currentStat.nlink !== 1 || !sameFile(currentStat, original.stat) ||
          !sameFile(currentStat, fs.fstatSync(fd)) || !fs.readFileSync(fd).equals(original.bytes)) {
        throw Error('Dziennik zmienil sie podczas sprawdzania. Nie dopisano nowej linii.');
      }
      // Append one byte using the verified file descriptor. Never re-encode existing JSON.
      if (fs.writeSync(fd, Buffer.from('\n'), 0, 1, original.bytes.length) !== 1) throw Error('Nie potwierdzono zapisu koncowej nowej linii.');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const after = regular(filename);
    if (!sameFile(after.stat, original.stat) || !after.bytes.equals(repaired)) throw Error('Nie potwierdzono wyniku naprawy. Zachowaj kopie i sprawdz dziennik.');
    verify(after.bytes);
    save(path.join(backup, 'completed.json'), JSON.stringify({ completedAt: new Date().toISOString(), sha256: checksum(after.bytes) }) + '\n');
    return { ...report, changed: true, needsNewline: false, filename, backup };
  } catch (error) {
    if (backup) error.backup = backup;
    throw error;
  } finally {
    try {
      const now = regular(lockPath);
      if (lockStat && sameFile(now.stat, lockStat) && now.bytes.toString() === String(process.pid)) fs.unlinkSync(lockPath);
    } finally { fs.closeSync(lock); }
  }
}

if (require.main === module) {
  Promise.resolve().then(() => {
    if (process.argv.slice(2).some(arg => arg !== '--repair')) throw Error('Uzycie: node tools/repair-journal-newline.js [--repair]');
    return repair({ apply: process.argv.includes('--repair') });
  }).then(result => {
    console.log(`Sprawdzono obecny lancuch: ${result.sequence} wpisow, ${result.operations} operacji.`);
    if (result.changed) {
      console.log('NAPRAWIONO: dopisano wylacznie 1 bajt nowej linii. Zadnego wpisu ani wyniku nie zmieniono.');
      console.log('Kopia oryginalu:', result.backup);
      console.log('Teraz uzyj dotychczasowego przycisku lub skryptu uruchamiania brokera.');
    } else console.log(result.needsNewline
      ? 'Brakuje tylko koncowej nowej linii. Aby zrobic kopie i ja dopisac: node tools/repair-journal-newline.js --repair'
      : 'Plik jest spojny i ma poprawne zakonczenie. Nie wymaga tej naprawy.');
    console.log(`Operacje unknown/in_progress zachowano: ${result.blockedOperations.length}. Naprawa nie potwierdza zadnego wydruku.`);
  }).catch(error => { console.error(error.message); if (error.backup) console.error('Kopia oryginalu:', error.backup); process.exitCode = 1; });
}

module.exports = { verify, repair };
