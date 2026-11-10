const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { OperationJournal } = require('../operation-journal');
const { recover, journalDirectory, pidExists, portIsFree, windowsProcesses, assertNoBroker } = require('../tools/recover-journal-lock');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker recovery test '));
  const directory = path.join(root, 'appdata', 'fiscal-operations');
  const journal = new OperationJournal(directory);
  journal.save({ id: 'confirmed-original', state: 'fiscal_confirmed', result: { receipt: { documentNumber: 42 } } });
  journal.save({ id: 'cut-during-receipt', state: 'in_progress', requestHash: 'unchanged' });
  journal.close();
  const lockPath = path.join(directory, 'operations.lock');
  const journalPath = path.join(directory, 'operations.jsonl');
  fs.writeFileSync(lockPath, '12345678');
  const original = fs.readFileSync(journalPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { root, directory, isAlive: () => false, freePort: async () => true, processes: async () => [] };
  return { root, directory, lockPath, journalPath, original, options,
    preserved() { assert.equal(fs.readFileSync(lockPath, 'utf8'), '12345678'); assert.deepEqual(fs.readFileSync(journalPath), original); } };
}

test('archives only a stale lock; exact journal and confirmed outcomes survive recovery and restart', async t => {
  const f = fixture(t);
  const result = await recover(f.options);
  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(f.lockPath), false);
  assert.equal(fs.readFileSync(path.join(result.backup, 'operations.lock'), 'utf8'), '12345678');
  assert.deepEqual(fs.readFileSync(path.join(result.backup, 'operations.jsonl')), f.original);
  assert.deepEqual(fs.readFileSync(f.journalPath), f.original);
  const meta = JSON.parse(fs.readFileSync(path.join(result.backup, 'recovery.json'), 'utf8'));
  assert.equal(meta.pid, 12345678);
  assert.match(meta.journalSha256, /^[0-9a-f]{64}$/);
  const reopened = new OperationJournal(f.directory);
  try {
    assert.equal(reopened.get('confirmed-original').state, 'fiscal_confirmed');
    assert.equal(reopened.get('confirmed-original').result.receipt.documentNumber, 42);
    assert.equal(reopened.get('cut-during-receipt').state, 'unknown');
    assert.deepEqual(reopened.blocked(), ['cut-during-receipt']);
  } finally { reopened.close(); }
});

test('a second click with no lock is a no-op and does not replace backups or history', async t => {
  const f = fixture(t);
  const first = await recover(f.options);
  const second = await recover(f.options);
  assert.equal(second.changed, false);
  assert.deepEqual(fs.readFileSync(f.journalPath), f.original);
  assert.deepEqual(fs.readdirSync(path.dirname(first.backup)), [path.basename(first.backup)]);
});

test('live PID is blocked even if API is absent or the PID now belongs to another program', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.lockPath, String(process.pid));
  await assert.rejects(recover({ ...f.options, isAlive: pidExists }), /nadal istnieje/);
  assert.equal(fs.readFileSync(f.lockPath, 'utf8'), String(process.pid));
  assert.deepEqual(fs.readFileSync(f.journalPath), f.original);
  assert.equal(pidExists(process.pid), true);
});

for (const [name, deps, pattern] of [
  ['occupied port', { freePort: async () => false }, /3030 jest zajety/],
  ['uncertain port', { freePort: async () => { throw new Error('timeout fixture'); } }, /timeout fixture/],
  ['unavailable process inventory', { processes: async () => { throw new Error('inventory denied fixture'); } }, /inventory denied/],
  ['another Electron', { processes: async () => [{ ProcessId: 97, Name: 'electron.exe' }] }, /Proces electron/],
  ['unrecognized Node', { processes: async () => [{ ProcessId: 97, Name: 'node.exe', CommandLine: null }] }, /rozpoznac procesu Node/],
]) {
  test(`${name}: no lock or history is removed`, async t => {
    const f = fixture(t);
    await assert.rejects(recover({ ...f.options, ...deps }), pattern);
    f.preserved();
  });
}

for (const content of ['', '0', '-1', '12x', '1.5', '9007199254740992', '4294967296']) {
  test(`invalid PID ${JSON.stringify(content)} is never guessed`, async t => {
    const f = fixture(t);
    fs.writeFileSync(f.lockPath, content);
    await assert.rejects(recover(f.options), /prawidlowego PID/);
    assert.equal(fs.readFileSync(f.lockPath, 'utf8'), content);
    assert.deepEqual(fs.readFileSync(f.journalPath), f.original);
  });
}

test('missing journal is not recreated as an empty history', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.journalPath);
  await assert.rejects(recover(f.options), /Brak prawidlowego operations.jsonl/);
  assert.equal(fs.existsSync(f.journalPath), false);
  assert.equal(fs.readFileSync(f.lockPath, 'utf8'), '12345678');
});

test('corrupt or truncated journal is preserved and still fails closed on broker startup', async t => {
  const f = fixture(t);
  fs.appendFileSync(f.journalPath, '{"partial":');
  const corrupt = fs.readFileSync(f.journalPath);
  await recover(f.options);
  assert.deepEqual(fs.readFileSync(f.journalPath), corrupt);
  assert.throws(() => new OperationJournal(f.directory), /Niepelny|Niepełny/);
  assert.deepEqual(fs.readFileSync(f.journalPath), corrupt);
});

test('unwritable backup location leaves the original PID lock and journal intact', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'lock-recovery-backups'), 'not a directory');
  await assert.rejects(recover(f.options));
  f.preserved();
});

test('existing live control-button lock prevents recovery while restart/stop is running', async t => {
  const f = fixture(t);
  const control = path.join(f.root, 'local-results', 'broker-panel.lock');
  fs.mkdirSync(path.dirname(control));
  fs.writeFileSync(control, String(process.pid));
  await assert.rejects(recover(f.options), /Start, stop/);
  assert.equal(fs.readFileSync(control, 'utf8'), String(process.pid));
  f.preserved();
});

test('two recovery requests cannot both enter the critical section', async t => {
  const f = fixture(t);
  let proceed;
  const held = new Promise(resolve => { proceed = resolve; });
  const first = recover({ ...f.options, freePort: async () => { await held; return true; } });
  await assert.rejects(recover(f.options), /Start, stop/);
  proceed();
  assert.equal((await first).changed, true);
});

test('a process that appears after backup blocks the final rename', async t => {
  const f = fixture(t);
  let count = 0;
  await assert.rejects(recover({ ...f.options, processes: async () => ++count === 1 ? [] : [{ ProcessId: 97, Name: 'electron.exe' }] }), /Proces electron/);
  f.preserved();
});

test('a changed PID lock is not replaced or deleted after the checks', async t => {
  const f = fixture(t);
  let count = 0;
  await assert.rejects(recover({ ...f.options, processes: async () => {
    if (++count === 2) fs.writeFileSync(f.lockPath, '87654321');
    return [];
  } }), /zmienily sie/);
  assert.equal(fs.readFileSync(f.lockPath, 'utf8'), '87654321');
  assert.deepEqual(fs.readFileSync(f.journalPath), f.original);
});

test('a changed journal is not cleared or silently backed up as an older version', async t => {
  const f = fixture(t);
  let count = 0;
  await assert.rejects(recover({ ...f.options, processes: async () => {
    if (++count === 2) fs.appendFileSync(f.journalPath, 'concurrent change fixture\n');
    return [];
  } }), /zmienily sie/);
  assert.equal(fs.readFileSync(f.lockPath, 'utf8'), '12345678');
  assert.equal(fs.readFileSync(f.journalPath, 'utf8'), f.original.toString() + 'concurrent change fixture\n');
});

test('a multiply-linked lock is refused instead of moving a different owner file', async t => {
  const f = fixture(t);
  fs.linkSync(f.lockPath, path.join(f.directory, 'other-link'));
  await assert.rejects(recover(f.options), /Nieprawidlowy plik/);
  f.preserved();
});

test('process matching excludes this tool, accepts identifiable unrelated Node, blocks other broker tools', () => {
  const root = path.join(os.tmpdir(), 'installed broker');
  assert.doesNotThrow(() => assertNoBroker([
    { ProcessId: process.pid, Name: 'node.exe', CommandLine: root },
    { ProcessId: 97, Name: 'node.exe', ExecutablePath: 'C:\\nodejs\\node.exe', CommandLine: 'node C:\\unrelated\\service.js' },
  ], root));
  assert.throws(() => assertNoBroker([{ ProcessId: 97, Name: 'node.exe', CommandLine: 'node review-operation.js' }], root), /Proces node/);
});

test('the TCP check uses a real listening socket and never sends a device command', async t => {
  const server = net.createServer(socket => { socket.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => { if (server.listening) server.close(); });
  assert.equal(await portIsFree(port), false);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await portIsFree(port), true);
});

test('default data path uses the actual package name and rejects absent/relative APPDATA', () => {
  assert.equal(journalDirectory({ APPDATA: os.tmpdir() }), path.join(os.tmpdir(), 'pos-fiscal-broker-thermal', 'fiscal-operations'));
  assert.throws(() => journalDirectory({}), /APPDATA/);
  assert.throws(() => journalDirectory({ APPDATA: 'relative-data' }), /APPDATA/);
});

test('Windows process inventory uses real CIM and sees the test Node process without changing it',
  { skip: process.platform !== 'win32' }, async () => {
    const processes = await windowsProcesses();
    assert.ok(processes.some(row => row.ProcessId === process.pid && row.Name.toLowerCase() === 'node.exe'));
  });

test('Windows cscript executes the actual VBS in a folder with spaces and keeps an empty fixture unchanged',
  { skip: process.platform !== 'win32' }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker VBS odzyskiwanie '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'tools'));
    fs.copyFileSync(path.join(__dirname, '..', 'Odzyskaj po awarii.vbs'), path.join(root, 'Odzyskaj po awarii.vbs'));
    fs.copyFileSync(path.join(__dirname, '..', 'tools', 'recover-journal-lock.js'), path.join(root, 'tools', 'recover-journal-lock.js'));
    fs.copyFileSync(path.join(__dirname, '..', 'package.json'), path.join(root, 'package.json'));
    const appData = path.join(root, 'fake appdata');
    fs.mkdirSync(appData);
    const result = spawnSync('cscript.exe', ['//NoLogo', path.join(root, 'Odzyskaj po awarii.vbs')], {
      env: { ...process.env, APPDATA: appData }, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Brak operations.lock/);
    assert.deepEqual(fs.readdirSync(appData), []);
    assert.equal(fs.existsSync(path.join(root, 'local-results', 'broker-panel.lock')), false);
  });
