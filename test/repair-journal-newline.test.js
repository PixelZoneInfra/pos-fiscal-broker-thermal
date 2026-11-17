const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { OperationJournal } = require('../operation-journal');
const { repair, verify } = require('../tools/repair-journal-newline');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker newline repair '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const j = new OperationJournal(directory);
  j.save({ id: 'pos:old', state: 'unknown', kind: 'reprintLastReceipt', error: 'Timeout', note: 'Zażółć gęślą jaźń' });
  j.save({ id: 'pos:paid', state: 'fiscal_confirmed', result: { receipt: { documentNumber: 6124, printerUniqueNumber: 'EAO 2402426691' } } });
  j.save({ id: 'pos:intent', state: 'in_progress', kind: 'printAdvancedReceipt' }); j.close();
  const filename = path.join(directory, 'operations.jsonl'), original = fs.readFileSync(filename);
  const options = { directory, root: __dirname, apply: true, freePort: async () => true, processes: async () => [] };
  return { directory, filename, original, options };
}

test('missing LF is verified, backed up byte-for-byte and repaired with exactly one byte; no operation is resolved', async t => {
  const f = fixture(t), missing = f.original.subarray(0, -1); fs.writeFileSync(f.filename, missing);
  assert.throws(() => new OperationJournal(f.directory), /Niepełny/);
  const result = await repair(f.options);
  assert.equal(result.changed, true); assert.equal(result.sequence, 3);
  assert.deepEqual(result.blockedOperations, ['pos:old', 'pos:intent']);
  assert.deepEqual(fs.readFileSync(f.filename), f.original);
  assert.deepEqual(fs.readFileSync(path.join(result.backup, 'operations.jsonl')), missing);
  assert.equal(fs.existsSync(path.join(f.directory, 'operations.lock')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.backup, 'repair.json'))).addedBytes, 1);
  const j = new OperationJournal(f.directory);
  try {
    assert.equal(j.get('pos:old').state, 'unknown'); assert.equal(j.get('pos:intent').state, 'unknown');
    assert.equal(j.get('pos:paid').result.receipt.documentNumber, 6124);
  } finally { j.close(); }
});

test('check mode only reads, and repeated repair of a healthy file is a no-op', async t => {
  const f = fixture(t); fs.writeFileSync(f.filename, f.original.subarray(0, -1));
  assert.equal((await repair({ ...f.options, apply: false })).needsNewline, true);
  assert.deepEqual(fs.readdirSync(f.directory), ['operations.jsonl']);
  const first = await repair(f.options); assert.equal((await repair(f.options)).changed, false);
  assert.deepEqual(fs.readdirSync(path.dirname(first.backup)), [path.basename(first.backup)]);
});

for (const problem of ['partial-json', 'changed-digest', 'sequence-gap', 'lost-middle-record', 'utf16', 'bom']) {
  test(`${problem} is preserved without adding LF or clearing a block`, async t => {
    const f = fixture(t), lines = f.original.toString().trimEnd().split('\n');
    let bytes;
    if (problem === 'partial-json') bytes = Buffer.from(lines.join('\n').slice(0, -12));
    if (problem === 'changed-digest') { lines[0] = lines[0].replace('Timeout', 'Edited'); bytes = Buffer.from(lines.join('\n')); }
    if (problem === 'sequence-gap') { lines[1] = lines[1].replace('"sequence":2', '"sequence":5'); bytes = Buffer.from(lines.join('\n')); }
    if (problem === 'lost-middle-record') bytes = Buffer.from([lines[0], lines[2]].join('\n'));
    if (problem === 'utf16') bytes = Buffer.from(lines.join('\n'), 'utf16le');
    if (problem === 'bom') bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\n'))]);
    fs.writeFileSync(f.filename, bytes); await assert.rejects(repair(f.options));
    assert.deepEqual(fs.readFileSync(f.filename), bytes);
    assert.equal(fs.existsSync(path.join(f.directory, 'operations.lock')), false);
    assert.equal(fs.existsSync(path.join(f.directory, 'journal-newline-backups')), false);
  });
}

test('invalid UTF-8 is refused rather than normalized into different journal bytes', () => {
  assert.throws(() => verify(Buffer.from([0xff, 0x7d])), /UTF-8/);
});
test('a live journal lock is preserved and no file is changed', async t => {
  const f = fixture(t), j = new OperationJournal(f.directory);
  const before = fs.readFileSync(f.filename);
  try { await assert.rejects(repair(f.options), /operations.lock/); assert.deepEqual(fs.readFileSync(f.filename), before); }
  finally { j.close(); }
});
test('API, process uncertainty, and another broker block repair before touching the journal', async t => {
  for (const deps of [
    { freePort: async () => false }, { processes: async () => { throw Error('CIM unavailable'); } },
    { processes: async () => [{ ProcessId: 987654, Name: 'electron.exe' }] },
  ]) {
    const f = fixture(t); fs.writeFileSync(f.filename, f.original.subarray(0, -1));
    await assert.rejects(repair({ ...f.options, ...deps }));
    assert.deepEqual(fs.readFileSync(f.filename), f.original.subarray(0, -1));
    assert.equal(fs.existsSync(path.join(f.directory, 'operations.lock')), false);
  }
});
test('a change or a new broker after the backup cancels the append', async t => {
  for (const mode of ['file', 'broker']) {
    const f = fixture(t), missing = f.original.subarray(0, -1); fs.writeFileSync(f.filename, missing);
    let count = 0;
    await assert.rejects(repair({ ...f.options, processes: async () => {
      if (++count === 2) {
        if (mode === 'file') fs.appendFileSync(f.filename, 'external change');
        else return [{ ProcessId: 987654, Name: 'electron.exe' }];
      } return [];
    } }));
    assert.deepEqual(fs.readFileSync(f.filename), mode === 'file' ? Buffer.concat([missing, Buffer.from('external change')]) : missing);
    assert.equal(fs.existsSync(path.join(f.directory, 'operations.lock')), false);
  }
});
test('backup failure and multiply-linked files leave the original bytes intact', async t => {
  const f = fixture(t), missing = f.original.subarray(0, -1); fs.writeFileSync(f.filename, missing);
  fs.writeFileSync(path.join(f.directory, 'journal-newline-backups'), 'not a directory');
  await assert.rejects(repair(f.options)); assert.deepEqual(fs.readFileSync(f.filename), missing);
  fs.unlinkSync(path.join(f.directory, 'journal-newline-backups'));
  fs.linkSync(f.filename, path.join(f.directory, 'other-link'));
  await assert.rejects(repair(f.options), /Nieprawidlowy/); assert.deepEqual(fs.readFileSync(f.filename), missing);
});
test('CLI check mode locates the same AppData journal and is read-only, even with spaces in the path', t => {
  const f = fixture(t), appData = path.join(f.directory, 'App Data');
  const target = path.join(appData, 'pos-fiscal-broker-thermal', 'fiscal-operations'); fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'operations.jsonl'), f.original.subarray(0, -1));
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'repair-journal-newline.js')],
    { env: { ...process.env, APPDATA: appData }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Brakuje tylko/);
  assert.deepEqual(fs.readdirSync(target), ['operations.jsonl']);
});
