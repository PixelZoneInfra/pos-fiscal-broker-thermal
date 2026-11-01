const test = require('node:test');
const assert = require('node:assert/strict');
const { BrokerService } = require('../broker-service');
const { hash } = require('../operation-journal');
const { receipt, setup } = require('../test-support/printer-port');
const { httpFixture } = require('../test-support/http-fixture');

const reserve = (broker, id = 'pos:1', command = 'receipt-advanced', ttl_ms = 60000) =>
  broker.reservePrinter({ operation_id: id, command, ttl_ms });
const options = lease => ({ operationId: lease.operation_id, reservationToken: lease.token });

test('reservation probes readiness but cannot print; persisted token is private and bound to one ID/command', async t => {
  const { broker, port, journal } = setup(t);
  const lease = await reserve(broker);
  assert.equal(port.mutations.length, 0);
  assert.equal(lease.state, 'reserved');
  assert.equal(lease.printer_unique_number, port.uniqueNumber);
  assert.equal(broker.getReservation(lease.id).token, undefined);
  assert.equal(broker.getReservation(lease.id).tokenHash, undefined);
  assert.ok(journal.get(lease.id).tokenHash);
  assert.equal(JSON.stringify(journal.get(lease.id)).includes(lease.token), false);
  assert.equal(broker.getOperation(lease.id), null);
  for (const call of [() => broker.getSnapshot(), () => broker.printDailyReport(), () => broker.openCashDrawer(), () => reserve(broker, 'pos:2')]) {
    await assert.rejects(call(), e => e.code === 'PRINTER_RESERVED');
  }
  await assert.rejects(broker.printAdvancedReceipt(receipt, { ...options(lease), operationId: 'pos:other' }), e => e.code === 'RESERVATION_MISMATCH');
  await assert.rejects(broker.openCashDrawer(options(lease)), e => e.code === 'RESERVATION_MISMATCH');
  await assert.rejects(broker.printAdvancedReceipt(receipt, { ...options(lease), reservationToken: 'x'.repeat(43) }), e => e.code === 'INVALID_RESERVATION_TOKEN');
  assert.equal(port.mutations.length, 0);
  assert.equal((await broker.printAdvancedReceipt(receipt, options(lease))).state, 'fiscal_confirmed');
  assert.equal(broker.getReservation(lease.id).state, 'consumed');
  assert.equal(journal.get('pos:1').reservationId, lease.id);
  assert.equal(broker.status().reservation, null);
  const count = port.writes.length;
  assert.equal((await broker.printAdvancedReceipt(receipt, options(lease))).success, true);
  assert.equal(port.writes.length, count);
  await assert.rejects(broker.printAdvancedReceipt(receipt, { operationId: 'pos:2', reservationToken: lease.token }), e => e.code === 'INVALID_RESERVATION');
});

test('renewal, authenticated release and unused expiry do not affect fiscal state', async t => {
  let now = Date.now();
  const { broker, port } = setup(t, { now: () => now });
  const first = await reserve(broker, 'pos:1', 'receipt-advanced', 1000);
  now += 500;
  const renewed = broker.renewReservation(first.id, first.token, 2000);
  assert.equal(Date.parse(renewed.expires_at), now + 2000);
  assert.throws(() => broker.releaseReservation(first.id, 'x'.repeat(43)), e => e.statusCode === 403);
  assert.equal(broker.releaseReservation(first.id, first.token).state, 'released');
  assert.equal(broker.releaseReservation(first.id, first.token).state, 'released');
  const second = await reserve(broker, 'pos:2', 'receipt-advanced', 1000);
  now += 1001;
  assert.equal(broker.status().reservation, null);
  assert.equal(broker.getReservation(second.id).state, 'expired');
  assert.throws(() => broker.renewReservation(second.id, second.token), e => e.code === 'RESERVATION_NOT_ACTIVE');
  await assert.rejects(broker.printAdvancedReceipt(receipt, options(second)), e => e.code === 'INVALID_RESERVATION');
  assert.equal(port.mutations.length, 0);
  const third = await reserve(broker, 'pos:2');
  assert.equal((await broker.printAdvancedReceipt(receipt, options(third))).success, true);
});

test('expiry/release/renewal cannot interrupt a claimed document or admit another sale', async t => {
  let now = Date.now();
  const { broker, raw, port } = setup(t, { now: () => now });
  const lease = await reserve(broker, 'pos:1', 'receipt-advanced', 1000);
  const original = raw.printAdvancedReceipt;
  let continuePrint, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { continuePrint = resolve; });
  raw.printAdvancedReceipt = async (...args) => { entered(); await held; return original(...args); };
  const printing = broker.printAdvancedReceipt(receipt, options(lease));
  await started;
  now += 1000000;
  assert.equal(broker.getReservation(lease.id).state, 'consumed');
  assert.throws(() => broker.releaseReservation(lease.id, lease.token), e => e.code === 'PRINTER_BUSY');
  assert.throws(() => broker.renewReservation(lease.id, lease.token), e => e.code === 'PRINTER_BUSY');
  await assert.rejects(reserve(broker, 'pos:2'), e => e.code === 'PRINTER_BUSY');
  continuePrint();
  assert.equal((await printing).state, 'fiscal_confirmed');
  assert.equal(port.receipts, 8);
});

test('unexpired reservation survives broker restart and still requires its original token', async t => {
  const { broker, raw, journal, reopen } = setup(t);
  const lease = await reserve(broker);
  journal.close();
  const restarted = new BrokerService(raw, reopen());
  assert.equal(restarted.status().reservation.id, lease.id);
  await assert.rejects(restarted.openCashDrawer(), e => e.code === 'PRINTER_RESERVED');
  assert.equal((await restarted.printAdvancedReceipt(receipt, options(lease))).success, true);
});

test('unknown after reserved fiscal close blocks work after expiry and restart', async t => {
  let now = Date.now();
  const { broker, port, journal, raw, reopen } = setup(t, { now: () => now });
  const lease = await reserve(broker, 'pos:1', 'receipt-advanced', 1000);
  port.disconnectOn = '28;0$z';
  await assert.rejects(broker.printAdvancedReceipt(receipt, options(lease)), e => e.operation.state === 'unknown');
  now += 1000000;
  assert.throws(() => broker.releaseReservation(lease.id, lease.token), e => e.code === 'RESERVATION_CONSUMED');
  await assert.rejects(reserve(broker, 'pos:2'), e => e.code === 'REVIEW_REQUIRED');
  journal.close();
  const restarted = new BrokerService(raw, reopen(), { now: () => now });
  assert.equal((await restarted.printAdvancedReceipt(receipt, options(lease))).state, 'unknown');
  await assert.rejects(reserve(restarted, 'pos:2'), e => e.code === 'REVIEW_REQUIRED');
});

test('a different printer after the POS database commit is refused before printing', async t => {
  const { broker, port } = setup(t);
  const lease = await reserve(broker);
  port.uniqueNumber = 'DIFFERENT';
  await assert.rejects(broker.printAdvancedReceipt(receipt, options(lease)), e => e.operation.state === 'not_started');
  assert.equal(port.mutations.length, 0);
  assert.equal(broker.getReservation(lease.id).state, 'consumed');
});

test('restart after consuming token but before durable print intent cannot reuse the old token', async t => {
  const { broker, raw, port, journal, reopen } = setup(t);
  const lease = await reserve(broker);
  broker.reservations.consume(journal.get(lease.id));
  journal.save({ id: lease.operation_id, kind: 'printAdvancedReceipt', state: 'not_started',
    payloadHash: hash({ name: 'printAdvancedReceipt', args: [receipt], assignment: null }) });
  journal.close();
  const restarted = new BrokerService(raw, reopen());
  await assert.rejects(restarted.printAdvancedReceipt(receipt, options(lease)), e => e.code === 'INVALID_RESERVATION');
  assert.equal(port.mutations.length, 0);
  const fresh = await reserve(restarted);
  assert.equal((await restarted.printAdvancedReceipt(receipt, options(fresh))).success, true);
  assert.equal(port.receipts, 8);
});

test('strict mode blocks unreserved POS while legacy mode remains usable', async t => {
  const { broker, port } = setup(t, { requirePosReservation: true });
  await assert.rejects(broker.printAdvancedReceipt(receipt), e => e.code === 'RESERVATION_REQUIRED');
  await assert.rejects(broker.cashDeposit(10), e => e.code === 'RESERVATION_REQUIRED');
  assert.equal(port.writes.length, 0);
  const lease = await reserve(broker);
  assert.equal((await broker.printAdvancedReceipt(receipt, options(lease))).success, true);
  const cashLease = await reserve(broker, 'cash:1', 'cash-deposit');
  assert.equal((await broker.cashDeposit(10, options(cashLease))).state, 'completed');
});

test('online mode requires strict POS configuration and cannot bypass a cashier reservation', async t => {
  const { broker, port } = setup(t, { onlineEnabled: true, branchId: 1, environment: 'test', printerUniqueNumber: 'ABC1234567890' });
  const request = { operation_id: 'online:1', branch_id: 1, environment: 'test', printer_unique_number: port.uniqueNumber, receipt };
  await assert.rejects(broker.submitReceipt(request), e => e.code === 'POS_RESERVATION_NOT_REQUIRED');
  broker.config.requirePosReservation = true;
  const lease = await reserve(broker);
  await assert.rejects(broker.submitReceipt(request), e => e.code === 'PRINTER_RESERVED');
  broker.releaseReservation(lease.id, lease.token);
  assert.equal((await broker.submitReceipt(request)).state, 'fiscal_confirmed');
});

test('reservation validation, durable grant failure and preflight failure cannot mutate USB', async t => {
  const { broker, journal, port } = setup(t);
  for (const ttl_ms of [0, 999, 300001, 1.5, '60000']) {
    await assert.rejects(reserve(broker, 'pos:1', 'receipt-advanced', ttl_ms), e => e.code === 'INVALID_TTL');
  }
  await assert.rejects(reserve(broker, 'pos:1', 'bogus'), e => e.code === 'INVALID_COMMAND');
  port.openTransaction = true;
  await assert.rejects(reserve(broker), /otwartą transakcję/);
  assert.equal(broker.status().reservation, null);
  port.openTransaction = false;
  const save = journal.save.bind(journal);
  journal.save = record => { if (record.kind === 'printer_reservation') throw new Error('Disk full'); return save(record); };
  await assert.rejects(reserve(broker), /Disk full/);
  assert.equal(broker.status().reservation, null);
  assert.equal(port.mutations.length, 0);
});

test('reservation HTTP handshake keeps token out of public responses and supports all control endpoints', async t => {
  const { request, port } = await httpFixture(t, { requirePosReservation: true });
  const grant = await request('/printer/reservations', { operation_id: 'http:reserved', command: 'drawer-open', ttl_ms: 60000 });
  assert.equal(grant.status, 201);
  const lease = grant.body;
  const headers = { 'X-Operation-Id': lease.operation_id, 'X-Printer-Reservation-Token': lease.token };
  assert.equal((await request(`/printer/reservations/${lease.id}`)).body.token, undefined);
  assert.equal((await request('/broker/status')).body.reservation.tokenHash, undefined);
  assert.equal((await request(`/printer/reservations/${lease.id}/renew`, {}, headers)).status, 200);
  assert.equal((await request('/cash-drawer/open', {}, headers)).body.state, 'completed');
  assert.equal((await request(`/printer/reservations/${lease.id}/release`, {}, headers)).body.code, 'RESERVATION_CONSUMED');
  assert.equal((await request('/cash-drawer/open', {}, headers)).body.state, 'completed');
  assert.equal(port.mutations.length, 1);
  const next = (await request('/printer/reservations', { operation_id: 'http:cancel', command: 'receipt' })).body;
  assert.equal((await request(`/printer/reservations/${next.id}/release`, {}, { 'X-Printer-Reservation-Token': next.token })).body.state, 'released');
});
