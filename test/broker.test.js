const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { OperationJournal } = require('../operation-journal');
const { BrokerService } = require('../broker-service');
const { review } = require('../review-operation');
const { receipt, setup } = require('../test-support/printer-port');

test('confirmed advanced receipt has hardware identity, separate counters, NIP and a durable cached result', async t => {
  const { broker, port, journal, reopen } = setup(t);
  const result = await broker.printAdvancedReceipt(receipt, { operationId: 'paid:1' });
  assert.equal(result.success, true);
  assert.equal(result.state, 'fiscal_confirmed');
  assert.equal(result.total, 24);
  assert.equal(result.receipt.documentNumber, 101);
  assert.equal(result.receipt.dailyReceiptNumber, 8);
  assert.equal(result.receipt.printerUniqueNumber, 'ABC1234567890');
  assert.equal(result.receipt.printerClockAfter.precision, 'minute');
  assert.equal(result.receipt.fiscalDate, undefined);
  assert.ok(port.mutations.some(x => x.includes('1$N1234567890\r')));
  assert.ok(!port.mutations.some(x => x.includes('0$e')));
  const before = port.writes.length;
  assert.deepEqual(await broker.printAdvancedReceipt(receipt, { operationId: 'paid:1' }), result);
  assert.equal(port.writes.length, before);
  journal.close();
  const reopened = reopen();
  const restarted = new BrokerService({}, reopened);
  assert.deepEqual(await restarted.printAdvancedReceipt(receipt, { operationId: 'paid:1' }), result);
  assert.equal(reopened.get('paid:1').fiscalCloseAcknowledged.transactionOk, true);
});

test('same operation ID with a different receipt is rejected before device I/O', async t => {
  const { broker, port } = setup(t);
  await broker.printAdvancedReceipt(receipt, { operationId: 'paid:2' });
  const count = port.writes.length;
  await assert.rejects(broker.printAdvancedReceipt({ ...receipt, buyerNip: '9876543210' }, { operationId: 'paid:2' }), e => e.code === 'OPERATION_CONFLICT');
  assert.equal(port.writes.length, count);
});

test('document lock covers every command, footer and final evidence; parallel sale, report, drawer and status refuse', async t => {
  const { broker, port } = setup(t);
  const first = broker.printAdvancedReceipt(receipt, { operationId: 'paid:3' });
  await assert.rejects(broker.printAdvancedReceipt(receipt, { operationId: 'paid:3' }), e => e.code === 'PRINTER_BUSY');
  for (const call of [
    () => broker.printAdvancedReceipt(receipt), () => broker.printDailyReport(),
    () => broker.openCashDrawer(), () => broker.getParsedStatusInfo(),
  ]) await assert.rejects(call(), e => e.code === 'PRINTER_BUSY');
  assert.equal((await first).success, true);
  assert.equal(port.mutations.filter(x => x.includes('$h')).length, 1);
  assert.equal(port.mutations.filter(x => x.includes('#r')).length, 0);
  await broker.printDailyReport();
  await broker.printAdvancedReceipt(receipt, { operationId: 'paid:4' });
  assert.equal(port.receipts, 1);
  assert.equal(broker.status().busy, null);
});

test('offline or wrong physical printer is not_started and can retry the same ID after a safe preflight', async t => {
  const { broker, port } = setup(t, { printerUniqueNumber: 'ABC1234567890' });
  port.hardwareByte = 0x76;
  await assert.rejects(broker.printAdvancedReceipt(receipt, { operationId: 'paid:5' }), e => e.operation.state === 'not_started');
  assert.equal(port.mutations.length, 0);
  port.hardwareByte = 0x74;
  port.uniqueNumber = 'OTHER';
  await assert.rejects(broker.printAdvancedReceipt(receipt, { operationId: 'paid:5' }), /inną drukarkę/);
  assert.equal(port.mutations.length, 0);
  port.uniqueNumber = 'ABC1234567890';
  assert.equal((await broker.printAdvancedReceipt(receipt, { operationId: 'paid:5' })).state, 'fiscal_confirmed');
});

test('foreign open transaction is never silently cancelled', async t => {
  const { broker, port } = setup(t);
  port.openTransaction = true;
  await assert.rejects(broker.printAdvancedReceipt(receipt), /otwartą transakcję/);
  await assert.rejects(broker.printVoidDocument(), /otwartą transakcję/);
  assert.equal(port.mutations.length, 0);
});

test('printer line error gives unknown and fences all mutations; diagnostics cannot clear it', async t => {
  const { broker, port, journal } = setup(t);
  port.rejectOn = '$l';
  await assert.rejects(broker.printAdvancedReceipt(receipt, { operationId: 'bad:1' }), e => e.operation.state === 'unknown');
  assert.ok(port.openTransaction);
  assert.equal(journal.get('bad:1').failureDetails.printerError, '39');
  const writes = port.writes.length;
  assert.equal((await broker.printAdvancedReceipt(receipt, { operationId: 'bad:1' })).state, 'unknown');
  for (const call of [() => broker.printDailyReport(), () => broker.openCashDrawer(), () => broker.printVoidDocument()]) {
    await assert.rejects(call(), e => e.code === 'REVIEW_REQUIRED');
  }
  assert.equal(port.writes.length, writes);
  await broker.reconcile('bad:1');
  assert.equal(journal.get('bad:1').state, 'unknown');
  assert.equal(journal.get('bad:1').reviewEvidence.transaction.transactionOpen, true);
});

test('USB disconnect after fiscal close keeps fiscal evidence without success or a second print', async t => {
  const { broker, port, journal, reopen } = setup(t);
  port.disconnectOn = '28;0$z';
  await assert.rejects(broker.printAdvancedReceipt(receipt, { operationId: 'lost:1' }), e => e.operation.state === 'unknown');
  assert.equal(port.receipts, 8);
  assert.ok(journal.get('lost:1').fiscalCloseAcknowledged.transactionOk);
  journal.close();
  const reopened = reopen();
  const restarted = new BrokerService({}, reopened);
  assert.equal((await restarted.printAdvancedReceipt(receipt, { operationId: 'lost:1' })).success, false);
  await assert.rejects(restarted.printDailyReport(), e => e.code === 'REVIEW_REQUIRED');
});

test('intent exists on disk before first USB mutation and simulated restart never replays it', async t => {
  const { broker, port, journal, directory, reopen } = setup(t);
  port.onMutation = () => {
    const events = fs.readFileSync(path.join(directory, 'operations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).record.state, 'in_progress');
    assert.equal(events.at(-1).record.id, 'intent:1');
  };
  await broker.printAdvancedReceipt(receipt, { operationId: 'intent:1' });
  const record = journal.get('intent:1');
  journal.save({ ...record, state: 'in_progress', result: undefined });
  journal.close();
  const reopened = reopen();
  assert.equal(reopened.get('intent:1').state, 'unknown');
  const restarted = new BrokerService({}, reopened);
  assert.equal((await restarted.printAdvancedReceipt(receipt, { operationId: 'intent:1' })).state, 'unknown');
});

test('journal fsync failure before intent prohibits print; failure after close prohibits success', async t => {
  const first = setup(t);
  const save = first.journal.save.bind(first.journal);
  first.journal.save = record => {
    if (record.state === 'in_progress') { first.journal.healthy = false; throw new Error('Disk full'); }
    return save(record);
  };
  await assert.rejects(first.broker.printAdvancedReceipt(receipt), /Disk full/);
  assert.equal(first.port.mutations.length, 0);
  const second = setup(t);
  const save2 = second.journal.save.bind(second.journal);
  second.journal.save = record => {
    if (record.state === 'fiscal_confirmed') { second.journal.healthy = false; throw new Error('Disk full'); }
    return save2(record);
  };
  await assert.rejects(second.broker.printAdvancedReceipt(receipt), e => e.operation.state === 'unknown' && e.operation.success === false);
  assert.equal(second.port.receipts, 8);
  await assert.rejects(second.broker.printDailyReport(), e => e.code === 'REVIEW_REQUIRED');
});

test('corrupt/truncated journal and another writer fail closed', t => {
  const { journal, directory } = setup(t);
  assert.throws(() => new OperationJournal(directory), /inny proces/);
  journal.save({ id: 'x', state: 'in_progress' });
  journal.close();
  fs.appendFileSync(path.join(directory, 'operations.jsonl'), '{');
  assert.throws(() => new OperationJournal(directory), /Niepełny dziennik/);
});

test('unclean process exit leaves an explicit stale-lock gate; preserved intent recovers to unknown', t => {
  const { journal, directory, reopen } = setup(t);
  journal.close();
  const code = `const {OperationJournal}=require('./operation-journal'); const j=new OperationJournal(process.argv[1]); j.save({id:'crash',state:'in_progress'}); process.exit(0);`;
  assert.equal(spawnSync(process.execPath, ['-e', code, directory], { cwd: path.join(__dirname, '..') }).status, 0);
  assert.throws(() => new OperationJournal(directory), /blokada po awarii/);
  fs.unlinkSync(path.join(directory, 'operations.lock'));
  const recovered = reopen();
  assert.equal(recovered.get('crash').state, 'unknown');
});

test('paper failure during a document is unknown and never acknowledged as fiscal success', async t => {
  const { broker, port } = setup(t);
  port.onMutation = text => { if (text.includes('$l')) port.hardwareByte = 0x76; };
  await assert.rejects(broker.printAdvancedReceipt(receipt), e => e.operation.state === 'unknown' && !e.operation.success);
  assert.ok(!port.mutations.some(text => text.includes('$y')));
});

test('unexpected document/receipt counter advance is unknown even with TRF set', async t => {
  const { broker, port } = setup(t);
  port.onMutation = text => { if (text.includes('$y')) port.document += 1; };
  await assert.rejects(broker.printAdvancedReceipt(receipt), e => e.operation.state === 'unknown');
});

test('completed reports keep exclusive ownership while the device is still executing', async t => {
  const { broker, raw } = setup(t);
  const original = raw.printDailyReport;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  raw.printDailyReport = async (...args) => { await held; return original(...args); };
  const report = broker.printDailyReport();
  await assert.rejects(broker.printAdvancedReceipt(receipt), e => e.code === 'PRINTER_BUSY');
  release();
  await report;
  assert.equal((await broker.printAdvancedReceipt(receipt)).success, true);
});

test('invalid fiscal payloads are refused before any device query', async t => {
  const { broker, port } = setup(t);
  for (const change of [
    { items: [] }, { items: [{ ...receipt.items[0], name: 'Kawa\x1bP0$e' }] },
    { items: [{ ...receipt.items[0], quantity: -1 }] }, { payments: [] },
    { buyerNip: '123\r456' }, { discount: { type: 'PERCENT', value: 101 } },
  ]) await assert.rejects(broker.printAdvancedReceipt({ ...receipt, ...change }), e => e.statusCode === 400);
  assert.equal(port.writes.length, 0);
});

test('invalid cash, cashier and report data fail before the journal intent and USB', async t => {
  const { broker, port } = setup(t);
  for (const call of [() => broker.cashDeposit('10/1'), () => broker.cashWithdrawal(-1),
    () => broker.login('Kasjer\r0$e', 'Kasa'),
    () => broker.printPeriodicReport({ startDate: '2026-02-30', endDate: '2026-11-01' })]) {
    await assert.rejects(call(), e => e.statusCode === 400);
  }
  assert.equal(port.writes.length, 0);
});

test('operator review requires attribution and evidence, appends decision, and never reprints resolved ID', async t => {
  const { broker, port, journal } = setup(t);
  port.rejectOn = '$l';
  await assert.rejects(broker.printAdvancedReceipt(receipt, { operationId: 'review:1' }));
  assert.throws(() => review(journal, { id: 'review:1', decision: 'fiscal_confirmed' }), /actor/);
  assert.throws(() => review(journal, { id: 'review:1', actor: 'Operator', evidence: 'Sprawdzono kopię', decision: 'fiscal_confirmed', 'device-closed': true, printer: 'OTHER', document: '101', date: '2026-11-01' }), /nie pasuje/);
  review(journal, { id: 'review:1', actor: 'Operator', evidence: 'Serwis anulował otwartą transakcję; brak fiskalizacji w kopii', decision: 'not_fiscalized', 'device-closed': true });
  assert.equal(journal.blocked().length, 0);
  const count = port.writes.length;
  const result = await broker.printAdvancedReceipt(receipt, { operationId: 'review:1' });
  assert.equal(result.state, 'not_fiscalized');
  assert.equal(result.retryable, false);
  assert.equal(port.writes.length, count);
});

test('online API enforces enabled flag, branch, environment and printer', async t => {
  const { broker, port } = setup(t);
  const request = { operation_id: 'online:1', branch_id: 1, environment: 'test', printer_unique_number: port.uniqueNumber, receipt };
  await assert.rejects(broker.submitReceipt(request), e => e.code === 'ONLINE_DISABLED');
  Object.assign(broker.config, { onlineEnabled: true, branchId: 1, environment: 'test', printerUniqueNumber: port.uniqueNumber });
  for (const change of [{ branch_id: 2 }, { environment: 'production' }, { printer_unique_number: 'OTHER' }]) {
    await assert.rejects(broker.submitReceipt({ ...request, ...change }), e => e.code === 'DEVICE_MISMATCH');
  }
  assert.equal(port.mutations.length, 0);
  assert.equal((await broker.submitReceipt(request)).success, true);
});

test('legacy simple receipt, cash, drawer, reports and discount bytes remain supported', async t => {
  const { broker, port } = setup(t);
  await broker.login('Kasjer', 'Kasa 1');
  await broker.cashDeposit(100);
  await broker.cashWithdrawal(20);
  assert.equal(await broker.getCashDrawerState(), 80);
  await broker.openCashDrawer();
  assert.ok(port.mutations.some(x => x === '\x1bP1$d\x1b\\'));
  const simple = await broker.printReceipt({ items: receipt.items, payment: { amountPaid: 24 } });
  assert.equal(simple.total, '24.00');
  assert.equal(simple.success, true);
  await broker.getCashDrawerStateReport();
  await broker.printVoidDocument();
  await broker.printTestVoidReceipt({ items: receipt.items });
  await broker.reprintLastReceipt();
  assert.equal((await broker.getStatusInfo()).startsWith('\x1bP1#X'), true);
  await broker.printPeriodicReport({ startDate: '2026-10-01', endDate: '2026-11-01' });
  await broker.logout('Kasjer', 'Kasa 1');
  const result = await broker.printAdvancedReceipt({
    items: [{ name: 'Kawa', quantity: 2, unitPrice: 12, vatRate: 'B', discount: { type: 'AMOUNT', value: 2 } }],
    discount: { type: 'PERCENT', value: 10, description: 'Rabat' },
    payments: [{ type: 'CASH', amount: 10 }, { type: 'BON', amount: 9.8 }],
  });
  assert.equal(result.total, 19.8);
  assert.ok(port.mutations.some(x => x.includes('1;1;16$lKawa\r2\rB/12/24.00/2.00/Rabat\r')));
  assert.ok(port.mutations.some(x => x.includes('1;16$Y22.00/10.00/Rabat\r')));
  assert.ok(port.mutations.some(x => x.includes('1;3$b9.80/BON\r')));
});
