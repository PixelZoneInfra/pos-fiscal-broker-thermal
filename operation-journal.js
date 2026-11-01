const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

class OperationJournal {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.records = new Map();
    this.sequence = 0;
    this.previousHash = '';
    this.healthy = true;
    this.lockPath = path.join(directory, 'operations.lock');
    this.acquireLock();
    try {
      const file = path.join(directory, 'operations.jsonl');
      const exists = fs.existsSync(file);
      const text = exists ? fs.readFileSync(file, 'utf8') : '';
      if (text && !text.endsWith('\n')) throw new Error('Niepełny dziennik; wymagana weryfikacja kopii i operacji.');
      for (const line of text.split('\n').filter(Boolean)) {
        const { digest, ...event } = JSON.parse(line);
        if (event.sequence !== this.sequence + 1 || event.previousHash !== this.previousHash || digest !== hash(event) || !event.record?.id) {
          throw new Error('Uszkodzony dziennik operacji; drukowanie zablokowane.');
        }
        this.sequence = event.sequence;
        this.previousHash = digest;
        this.records.set(event.record.id, event.record);
      }
      this.fd = fs.openSync(file, 'a', 0o600);
      fs.fsyncSync(this.fd);
      if (!exists && process.platform !== 'win32') {
        const dir = fs.openSync(directory, 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
      // A saved intent may already have reached the printer. Never replay it.
      for (const record of [...this.records.values()]) {
        if (record.state === 'in_progress') this.save({ ...record, state: 'unknown', error: 'Broker przerwany przed trwałym zapisem wyniku.' });
      }
    } catch (error) { this.close(); throw error; }
  }

  acquireLock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx', 0o600);
        try { fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        this.ownsLock = true;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(fs.readFileSync(this.lockPath, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Nieprawidłowa blokada dziennika; sprawdź uruchomione procesy.');
        try { process.kill(pid, 0); } catch (probe) {
          if (probe.code === 'ESRCH') throw new Error('Pozostała blokada po awarii. Po zatrzymaniu wszystkich brokerów zweryfikuj PID i usuń operations.lock; zachowaj operations.jsonl.');
        }
        throw new Error('Dziennik jest używany przez inny proces.');
      }
    }
    throw new Error('Nie można zablokować dziennika.');
  }

  get(id) { return this.records.get(id) ? structuredClone(this.records.get(id)) : null; }
  all() { return [...this.records.values()].map(record => structuredClone(record)); }
  blocked() { return [...this.records.values()].filter(r => r.state === 'unknown' || r.state === 'in_progress').map(r => r.id); }

  save(record) {
    if (!this.healthy || this.fd === undefined) throw new Error('Dziennik jest niedostępny; drukowanie zablokowane.');
    const stored = JSON.parse(JSON.stringify({ ...record, updatedAt: new Date().toISOString() }));
    const event = { sequence: this.sequence + 1, previousHash: this.previousHash, record: stored };
    const digest = hash(event);
    try {
      fs.writeFileSync(this.fd, JSON.stringify({ ...event, digest }) + '\n');
      fs.fsyncSync(this.fd);
    } catch (error) { this.healthy = false; throw error; }
    this.sequence = event.sequence;
    this.previousHash = digest;
    this.records.set(record.id, stored);
    return this.get(record.id);
  }

  close() {
    if (this.fd !== undefined) { fs.closeSync(this.fd); this.fd = undefined; }
    if (this.ownsLock) { fs.unlinkSync(this.lockPath); this.ownsLock = false; }
  }
}

module.exports = { OperationJournal, hash };
