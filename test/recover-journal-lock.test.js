const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { OperationJournal } = require('../operation-journal');
const { recover, journalDirectory, pidExists, windowsPidExists, portIsFree, windowsProcesses, assertNoBroker } = require('../tools/recover-journal-lock');

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

const deniedProbe = code => () => { throw Object.assign(new Error('probe fixture'), { code }); };

function controlFixture(f, overrides = {}) {
  const filename = path.join(f.root, 'local-results', 'broker-control.json');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ version: 1, pid: 12345678, root: f.root, port: 3030,
    instance_id: 'old-instance', token: 'a'.repeat(64), ...overrides }));
  fs.writeFileSync(filename, bytes);
  return { filename, bytes };
}

test('recovery archives stale control metadata together with the lock, including an unrelated protected process', async t => {
  const f = fixture(t);
  const control = controlFixture(f);
  const profilePath = path.join(f.root, 'local-results', 'broker-profile.json');
  const profile = '{"version":1,"profile":"online-production"}';
  fs.writeFileSync(profilePath, profile);
  const copiedAt = fs.statSync(f.lockPath).birthtimeMs;
  const savedAt = new Date(copiedAt - 4 * 24 * 60 * 60 * 1000);
  fs.utimesSync(f.lockPath, savedAt, savedAt);
  const result = await recover({ ...f.options, isAlive: () => true, processes: async () => [{
    ProcessId: 12345678, Name: 'spoolsv.exe', ExecutablePath: null,
    StartedAt: new Date(copiedAt - 90 * 60 * 1000).toISOString(),
  }] });
  assert.equal(result.controlArchived, true);
  assert.equal(fs.existsSync(control.filename), false);
  assert.equal(fs.existsSync(f.lockPath), false);
  assert.deepEqual(fs.readFileSync(path.join(result.backup, 'broker-control.json')), control.bytes);
  assert.deepEqual(fs.readFileSync(f.journalPath), f.original);
  assert.equal(fs.readFileSync(profilePath, 'utf8'), profile);
});

test('a stale control file can be recovered when the PID lock was already removed', async t => {
  const f = fixture(t);
  const control = controlFixture(f);
  fs.unlinkSync(f.lockPath);
  const result = await recover(f.options);
  assert.equal(result.changed, true);
  assert.equal(result.controlArchived, true);
  assert.equal(result.pid, null);
  assert.equal(fs.existsSync(control.filename), false);
  assert.deepEqual(fs.readFileSync(path.join(result.backup, 'broker-control.json')), control.bytes);
  assert.deepEqual(fs.readFileSync(f.journalPath), f.original);
  assert.equal((await recover(f.options)).changed, false);
});

for (const deps of [{ freePort: async () => false }, { processes: async () => [{ ProcessId: 97, Name: 'electron.exe' }] }]) {
  test(`active broker preserves a control-only recovery: ${Object.keys(deps)}`, async t => {
    const f = fixture(t);
    const control = controlFixture(f);
    fs.unlinkSync(f.lockPath);
    await assert.rejects(recover({ ...f.options, ...deps }));
    assert.deepEqual(fs.readFileSync(control.filename), control.bytes);
    assert.deepEqual(fs.readFileSync(f.journalPath), f.original);
  });
}

test('changed control metadata is preserved and the PID lock is not released', async t => {
  const f = fixture(t);
  const control = controlFixture(f);
  let checks = 0;
  await assert.rejects(recover({ ...f.options, processes: async () => {
    if (++checks === 2) controlFixture(f, { instance_id: 'different-instance' });
    return [];
  } }), /zmienily sie/);
  assert.notDeepEqual(fs.readFileSync(control.filename), control.bytes);
  f.preserved();
});

test('malformed or foreign control metadata cannot be moved during recovery', async t => {
  const f = fixture(t);
  const control = controlFixture(f, { root: path.join(f.root, 'different-installation') });
  await assert.rejects(recover(f.options), /nie pasuje/);
  f.preserved();
  fs.writeFileSync(control.filename, '{broken');
  await assert.rejects(recover(f.options), /Nieprawidlowy broker-control/);
  assert.equal(fs.readFileSync(control.filename, 'utf8'), '{broken');
  f.preserved();
});

test('control-only recovery still requires the original journal', async t => {
  const f = fixture(t);
  const control = controlFixture(f);
  fs.unlinkSync(f.lockPath);
  fs.unlinkSync(f.journalPath);
  await assert.rejects(recover(f.options), /Brak prawidlowego operations.jsonl/);
  assert.deepEqual(fs.readFileSync(control.filename), control.bytes);
  assert.equal(fs.existsSync(f.journalPath), false);
});

test('Windows PID 4836: a denied Node probe uses CIM instead of guessing the process is alive or absent', () => {
  for (const exists of [false, true]) {
    let queried;
    const result = pidExists(4836, { platform: 'win32', probe: deniedProbe('EPERM'),
      fallback: pid => { queried = pid; return exists; } });
    assert.equal(queried, 4836);
    assert.equal(result, exists);
  }
  assert.equal(pidExists(4836, { platform: 'win32', probe: deniedProbe('ESRCH'),
    fallback: () => { throw new Error('must not query CIM'); } }), false);
  assert.throws(() => pidExists(4836, { platform: 'linux', probe: deniedProbe('EPERM'),
    fallback: () => false }), /4836 \(EPERM\)/);
});

test('Windows CIM PID query is hidden, read-only, exact and strictly validates its reply', () => {
  const env = { SystemRoot: os.tmpdir() };
  const run = (executable, args, options) => {
    assert.equal(path.basename(executable), 'powershell.exe');
    assert.equal(options.windowsHide, true);
    const source = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    assert.match(source, /Get-CimInstance.*-Filter "ProcessId = 4836" -ErrorAction Stop/);
    assert.doesNotMatch(source, /Stop-Process|Terminate|taskkill/);
    return '\ufeff{"pid":4836,"exists":false}\r\n';
  };
  assert.equal(windowsPidExists(4836, { run, env }), false);
  assert.equal(windowsPidExists(4836, { run: () => '{"pid":4836,"exists":true}', env }), true);
  for (const reply of ['', 'null', '{"pid":4837,"exists":false}', '{"pid":4836,"exists":"false"}']) {
    assert.throws(() => windowsPidExists(4836, { run: () => reply, env }));
  }
  for (const pid of [0, -1, 1.5, '4836', 0x100000000]) {
    assert.throws(() => windowsPidExists(pid, { run: () => { throw new Error('must not run'); }, env }), /Nieprawidlowy PID/);
  }
  assert.throws(() => windowsPidExists(4836, { env: {} }), /katalogu Windows/);
});

test('recovery archives a stale lock and preserves the journal after Node denies the PID probe', async t => {
  const f = fixture(t);
  const result = await recover({ ...f.options, isAlive: pid => pidExists(pid, {
    platform: 'win32', probe: deniedProbe('EPERM'), fallback: () => false }) });
  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(f.lockPath), false);
  assert.deepEqual(fs.readFileSync(f.journalPath), f.original);
  assert.equal(fs.readFileSync(path.join(result.backup, 'operations.lock'), 'utf8'), '12345678');
});

test('a failed Windows PID query preserves the lock and journal and reports both failures', async t => {
  const f = fixture(t);
  await assert.rejects(recover({ ...f.options, isAlive: pid => pidExists(pid, {
    platform: 'win32', probe: deniedProbe('EPERM'), fallback: deniedProbe('EACCES') }) }), /Node: EPERM; Windows CIM: EACCES/);
  f.preserved();
});

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

test('a stale PID reused by the recovery Node process is not mistaken for a broker', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.lockPath, String(process.pid));
  const result = await recover({ ...f.options, isAlive: pidExists,
    processes: async () => [{ ProcessId: process.pid, Name: 'node.exe',
      ExecutablePath: process.execPath, CommandLine: `node "${path.join(f.root, 'tools', 'recover-journal-lock.js')}"` }] });
  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(f.lockPath), false);
  assert.deepEqual(fs.readFileSync(f.journalPath), f.original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.backup, 'recovery.json'), 'utf8')).ownerState, 'reused_by_recovery');
  assert.equal(pidExists(process.pid), true);
});

function recoveryWrapper(root, overrides = {}) {
  return { ProcessId: process.ppid, Name: 'wscript.exe', ExecutablePath: 'C:\\Windows\\System32\\wscript.exe',
    CommandLine: `"C:\\Windows\\System32\\wscript.exe" "${path.join(root, 'Odzyskaj po awarii.vbs')}"`, ...overrides };
}

test('the exact waiting VBS parent is excluded, including when Windows reused the stale PID for it', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.lockPath, String(process.ppid));
  const result = await recover({ ...f.options, isAlive: pidExists,
    processes: async () => [recoveryWrapper(f.root)] });
  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(f.lockPath), false);
  assert.deepEqual(fs.readFileSync(f.journalPath), f.original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.backup, 'recovery.json'), 'utf8')).ownerState, 'reused_by_recovery');
});

test('a reused unrelated PID is accepted only with a start time later than the original lock', async t => {
  const f = fixture(t);
  const stat = fs.statSync(f.lockPath);
  const result = await recover({ ...f.options, isAlive: () => true,
    processes: async () => [{ ProcessId: 12345678, Name: 'notepad.exe', ExecutablePath: 'C:\\Windows\\notepad.exe',
      CommandLine: 'notepad.exe', StartedAt: new Date(Math.max(stat.birthtimeMs, stat.mtimeMs) + 2000).toISOString() }] });
  assert.equal(result.changed, true);
  assert.deepEqual(fs.readFileSync(f.journalPath), f.original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.backup, 'recovery.json'), 'utf8')).ownerState, 'reused_after_lock');
});

test('copied stale lock: a new CreationTime cannot make the old saved PID look current', async t => {
  const f = fixture(t);
  const copiedAt = fs.statSync(f.lockPath).birthtimeMs;
  const savedAt = new Date(copiedAt - 4 * 24 * 60 * 60 * 1000);
  const processStartedAt = new Date(copiedAt - 90 * 60 * 1000);
  fs.utimesSync(f.lockPath, savedAt, savedAt);
  const result = await recover({ ...f.options, isAlive: () => true, processes: async () => [{
    ProcessId: 12345678, Name: 'spoolsv.exe', ExecutablePath: 'C:\\Windows\\System32\\spoolsv.exe',
    StartedAt: processStartedAt.toISOString(),
  }] });
  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(f.lockPath), false);
  assert.deepEqual(fs.readFileSync(f.journalPath), f.original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.backup, 'recovery.json'), 'utf8')).ownerState, 'reused_after_lock');
});

test('a copied lock is preserved when the reused PID belongs to an actual Electron broker', async t => {
  const f = fixture(t);
  const copiedAt = fs.statSync(f.lockPath).birthtimeMs;
  const savedAt = new Date(copiedAt - 4 * 24 * 60 * 60 * 1000);
  fs.utimesSync(f.lockPath, savedAt, savedAt);
  await assert.rejects(recover({ ...f.options, isAlive: () => true, processes: async () => [{
    ProcessId: 12345678, Name: 'electron.exe', ExecutablePath: 'C:\\broker\\electron.exe',
    StartedAt: new Date(copiedAt - 90 * 60 * 1000).toISOString(),
  }] }), /Proces electron/);
  f.preserved();
});

for (const startedAt of [undefined, 'invalid', '2000-01-01T00:00:00Z']) {
  test(`an existing lock PID without proven reuse (${startedAt}) is still refused`, async t => {
    const f = fixture(t);
    await assert.rejects(recover({ ...f.options, isAlive: () => true,
      processes: async () => [{ ProcessId: 12345678, Name: 'notepad.exe', StartedAt: startedAt }] }), /Nie mozna potwierdzic/);
    f.preserved();
  });
}

test('a live PID missing from the inventory cannot be treated as stale', async t => {
  const f = fixture(t);
  await assert.rejects(recover({ ...f.options, isAlive: () => true }), /Nie mozna potwierdzic/);
  f.preserved();
});

test('a live broker is refused even with a PID recycled after the old lock', async t => {
  const f = fixture(t);
  await assert.rejects(recover({ ...f.options, isAlive: () => true,
    processes: async () => [recoveryWrapper(f.root), { ProcessId: 12345678, Name: 'electron.exe',
      StartedAt: new Date(Date.now() + 2000).toISOString() }] }), /Proces electron/);
  f.preserved();
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

test('script host exclusion requires the actual parent, its executable and the exact VBS entry point', () => {
  const root = path.join(os.tmpdir(), 'pos-fiscal-broker with spaces');
  assert.doesNotThrow(() => assertNoBroker([recoveryWrapper(root)], root));
  assert.doesNotThrow(() => assertNoBroker([recoveryWrapper(root, { Name: 'cscript.exe',
    ExecutablePath: 'C:\\Windows\\System32\\cscript.exe',
    CommandLine: `cscript.exe //NoLogo "${path.join(root, 'Odzyskaj po awarii.vbs')}"` })], root));
  for (const row of [
    recoveryWrapper(root, { ProcessId: 97 }),
    recoveryWrapper(root, { ExecutablePath: null }),
    recoveryWrapper(root, { CommandLine: `wscript.exe "${path.join(root, 'Uruchom na nowo.vbs')}"` }),
    recoveryWrapper(root, { CommandLine: `wscript.exe "other.vbs" "${path.join(root, 'Odzyskaj po awarii.vbs')}"` }),
  ]) assert.throws(() => assertNoBroker([row], root), /Proces wscript/);
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

test('Windows real CIM fallback recognizes this Node and a missing PID even when Node probes are denied',
  { skip: process.platform !== 'win32' }, () => {
    assert.equal(pidExists(process.pid, { platform: 'win32', probe: deniedProbe('EPERM') }), true);
    assert.equal(pidExists(2147483647, { platform: 'win32', probe: deniedProbe('EPERM') }), false);
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
