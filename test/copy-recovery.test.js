const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BrokerService } = require('../broker-service');
const { unchangedCopy } = require('../copy-recovery');
const { receipt, setup } = require('../test-support/printer-port');

async function pending(fixture, changes = {}) {
  const before = await fixture.raw.getSnapshot();
  return fixture.journal.save({ id: 'pos:copy-timeout', kind: 'reprintLastReceipt', state: 'unknown',
    createdAt: '2026-11-17T13:36:36.226Z', before, error: 'Timeout odpowiedzi drukarki; wynik wymaga sprawdzenia.', failureDetails: {}, ...changes });
}
const options = record => ({ actor: 'Pracownik Banino', expected_updated_at: record.updatedAt,
  printer_unique_number: record.before?.identity?.uniqueNumber || 'ABC1234567890' });

test('old timed-out copy is checked and closed durably without any print or journal deletion', async t => {
  const f = setup(t);
  f.port.uniqueNumber = 'EAO 2402426691';
  const old = await pending(f);
  assert.equal(f.broker.getOperation(old.id).copyRecovery.can_close, false);
  f.port.lastError = 115; f.port.commandOk = false;
  const checked = await f.broker.reconcile(old.id);
  assert.equal(checked.state, 'unknown');
  assert.equal(checked.copyRecovery.can_close, true);
  assert.equal(checked.copyRecovery.printer_error, 115);
  const file = path.join(f.directory, 'operations.jsonl');
  const prefix = fs.readFileSync(file, 'utf8');
  const result = await f.broker.closeFailedCopy(old.id, options(checked));
  assert.equal(result.operation.state, 'cancelled');
  assert.equal(result.operation.resolution.type, 'failed_reprint_closed');
  assert.equal(result.operation.resolution.actor, 'Pracownik Banino');
  assert.equal(result.operation.resolution.printerUniqueNumber, f.port.uniqueNumber);
  assert.equal(result.operation.resolution.deviceClosed, true);
  assert.equal(result.operation.resolution.automatic, false);
  assert.equal(result.operation.receipt, undefined);
  assert.deepEqual(result.blockedOperations, []);
  assert.equal(f.port.mutations.length, 0);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(prefix));
  const writes = f.port.writes.length;
  assert.deepEqual(await f.broker.closeFailedCopy(old.id, options(checked)), result);
  assert.equal(f.port.writes.length, writes);
  f.journal.close();
  const restarted = new BrokerService({}, f.reopen());
  assert.equal(restarted.getOperation(old.id).state, 'cancelled');
  assert.deepEqual(restarted.status().blockedOperations, []);
});

test('only the selected copy closes; a real unknown receipt keeps the printer fenced', async t => {
  const f = setup(t), copy = await pending(f);
  const sale = f.journal.save({ id: 'pos:real-sale', kind: 'printAdvancedReceipt', state: 'unknown', before: copy.before });
  const result = await f.broker.closeFailedCopy(copy.id, options(copy));
  assert.deepEqual(result.blockedOperations, [sale.id]);
  assert.deepEqual(f.journal.get(sale.id), sale);
  await assert.rejects(f.broker.printDailyReport(), e => e.code === 'REVIEW_REQUIRED');
  assert.equal(f.port.mutations.length, 0);
});

for (const kind of ['printAdvancedReceipt', 'printReceipt', 'cashDeposit', 'cashWithdrawal', 'printDailyReport']) {
  test(`copy cleanup refuses ${kind} before USB I/O`, async t => {
    const f = setup(t), record = await pending(f, { kind });
    const writes = f.port.writes.length;
    await assert.rejects(f.broker.closeFailedCopy(record.id, options(record)), e => e.code === 'COPY_ONLY');
    assert.equal(f.port.writes.length, writes);
    assert.equal(f.journal.get(record.id).state, 'unknown');
  });
}

test('stale review, wrong configured device, missing attribution and in-progress operations cannot close', async t => {
  const f = setup(t), record = await pending(f);
  const writes = f.port.writes.length;
  for (const change of [{ expected_updated_at: 'old' }, { printer_unique_number: 'OTHER' }, { actor: '' }, { actor: 'x\r' }]) {
    await assert.rejects(f.broker.closeFailedCopy(record.id, { ...options(record), ...change }));
  }
  f.journal.save({ ...record, state: 'in_progress' });
  await assert.rejects(f.broker.closeFailedCopy(record.id, options(record)), e => e.code === 'INVALID_STATE');
  assert.equal(f.port.writes.length, writes);
});

const changes = {
  identity: s => { s.identity.uniqueNumber = 'OTHER'; },
  document: s => { s.counter.lastDocumentNumber++; },
  receipts: s => { s.status.receiptsSinceDailyReport++; },
  cash: s => { s.status.cashInDrawer++; },
  totals: s => { s.status.dailyTotals.B++; },
  reset: s => { s.status.ramResets++; },
  open: s => { s.transaction.transactionOpen = true; },
  statusOpen: s => { s.status.isTransactionOpen = true; },
  offline: s => { s.hardware.online = false; },
  paper: s => { s.hardware.paperOrBatteryError = true; },
  error: s => { s.lastErrorCode = 39; },
  statusError: s => { s.status.lastCommandError = 39; },
  missingCash: s => { delete s.status.cashInDrawer; },
  missingTotals: s => { delete s.status.dailyTotals.G; },
  missingCounter: s => { delete s.counter.lastDocumentNumber; },
};
for (const [name, change] of Object.entries(changes)) {
  test(`fresh ${name} evidence blocks cleanup even after a previously safe check`, async t => {
    const f = setup(t), record = await pending(f);
    const reviewed = await f.broker.reconcile(record.id);
    assert.equal(reviewed.copyRecovery.can_close, true);
    const after = structuredClone(record.before); change(after);
    assert.equal(unchangedCopy(record.before, after).can_close, false);
    f.raw.getSnapshot = async () => after;
    await assert.rejects(f.broker.closeFailedCopy(record.id, options(reviewed)), e => e.code === 'COPY_REVIEW_REQUIRED');
    assert.equal(f.journal.get(record.id).state, 'unknown');
    assert.equal(f.port.mutations.length, 0);
  });
}

test('explicit 115 rejection of a copy is a durable failed result, releases only its fence and never repeats #H', async t => {
  const f = setup(t);
  f.port.rejectOn = '#H'; f.port.rejectCode = 115;
  await assert.rejects(f.broker.reprintLastReceipt({ operationId: 'pos:115' }), e =>
    e.operation.state === 'cancelled' && e.operation.success === false && e.operation.retryable === false);
  assert.equal(f.journal.get('pos:115').resolution.automatic, true);
  assert.deepEqual(f.journal.blocked(), []);
  const writes = f.port.writes.length;
  assert.equal((await f.broker.reprintLastReceipt({ operationId: 'pos:115' })).success, false);
  assert.equal(f.port.writes.length, writes);
  assert.equal(f.port.mutations.filter(s => s.includes('1#H')).length, 1);
  f.port.rejectOn = null;
  assert.equal((await f.broker.printAdvancedReceipt(receipt)).success, true);
});

test('115 on a real sale still stays unknown and never releases the fence', async t => {
  const f = setup(t);
  f.port.rejectOn = '$l'; f.port.rejectCode = 115;
  await assert.rejects(f.broker.printAdvancedReceipt(receipt, { operationId: 'pos:real115' }), e => e.operation.state === 'unknown');
  assert.deepEqual(f.journal.blocked(), ['pos:real115']);
  assert.equal(f.journal.get('pos:real115').resolution, undefined);
});

test('copy timeout, another error, changed counters or unavailable evidence never auto-settle', async t => {
  for (const mode of ['timeout', 'other-error', 'changed', 'read-failure']) {
    const f = setup(t);
    f.raw.reprintLastReceipt = async () => {
      if (mode === 'changed') f.port.document++;
      if (mode === 'read-failure') f.raw.getSnapshot = async () => { throw Error('USB lost'); };
      throw Object.assign(Error(mode), mode === 'timeout' ? {} : { printerError: mode === 'other-error' ? '39' : '115' });
    };
    await assert.rejects(f.broker.reprintLastReceipt({ operationId: `pos:${mode}` }), e => e.operation.state === 'unknown');
    assert.deepEqual(f.journal.blocked(), [`pos:${mode}`]);
    assert.equal(f.journal.get(`pos:${mode}`).resolution, undefined);
  }
});

test('closing a never-sent reserved copy uses its recorded device and performs no USB command', async t => {
  const f = setup(t, { requirePosReservation: true });
  const reservation = await f.broker.reservePrinter({ operation_id: 'pos:never-sent', command: 'reprint-last' });
  f.raw.getSnapshot = async () => { throw Error('USB offline'); };
  await assert.rejects(f.broker.reprintLastReceipt({ operationId: 'pos:never-sent', reservationToken: reservation.token }), e => e.operation.state === 'not_started');
  const record = f.broker.getOperation('pos:never-sent');
  assert.equal(record.copyRecovery.can_retry, true);
  assert.equal(record.before, undefined);
  const writes = f.port.writes.length;
  const closed = await f.broker.closeFailedCopy(record.id, options(record));
  assert.equal(closed.operation.state, 'cancelled');
  assert.equal(closed.operation.resolution.notStarted, true);
  assert.equal(f.port.writes.length, writes);
});

test('cleanup keeps exclusive ownership, refuses live reservations, and refuses failed journal persistence', async t => {
  const f = setup(t), record = await pending(f);
  let release;
  f.raw.getSnapshot = () => new Promise(resolve => { release = () => resolve(record.before); });
  const close = f.broker.closeFailedCopy(record.id, options(record));
  await assert.rejects(f.broker.getSnapshot(), e => e.code === 'PRINTER_BUSY');
  release(); await close;
  f.journal.save({ ...record, state: 'unknown' });
  f.raw.getSnapshot = async () => record.before;
  const reservations = f.broker.reservations;
  const reservation = reservations.create('pos:another', 'drawer-open', f.port.uniqueNumber);
  await assert.rejects(f.broker.closeFailedCopy(record.id, options(record)), e => e.code === 'PRINTER_RESERVED');
  reservations.release(reservation.id, reservation.token);
  f.journal.save = () => { f.journal.healthy = false; throw Error('Disk full'); };
  await assert.rejects(f.broker.closeFailedCopy(record.id, options(f.journal.get(record.id))), /Disk full/);
  assert.equal(f.journal.get(record.id).state, 'unknown');
  assert.equal(f.port.mutations.length, 0);
});
