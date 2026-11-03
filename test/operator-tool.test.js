const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run, redact } = require('../scripts/broker-check');
const { httpFixture } = require('../test-support/http-fixture');
const { receipt } = require('../test-support/printer-port');

test('operator tool defaults to exactly the five reads and never sends a printer command', async t => {
  const { base, port } = await httpFixture(t, { diagnosticsOnly: true });
  const report = await run({ url: base }, () => {});
  assert.equal(report.success, true, report.error);
  assert.deepEqual(report.steps.map(step => `${step.method} ${step.route}`), [
    'GET /broker/status', 'GET /status', 'GET /status/parsed', 'GET /cash/state', 'GET /device/diagnostics',
  ]);
  assert.equal(port.mutations.length, 0);
});

test('operator tool validates version, action consent, stable ID and separate daily-report consent before mutations', async t => {
  const { base, port } = await httpFixture(t);
  for (const args of [
    { case: 'drawer-open' },
    { case: 'drawer-open', 'allow-device-action': true },
    { case: 'daily-report', 'allow-device-action': true, 'operation-id': 'daily:1' },
    { case: 'online-receipt', reserve: true, 'allow-device-action': true, 'operation-id': 'online:1' },
  ]) assert.equal((await run({ url: base, ...args }, () => {})).success, false);
  assert.equal(port.mutations.length, 0);
  assert.equal((await run({ url: 'http://example.com', case: 'drawer-open' }, () => {})).success, false);
});

test('operator tool reserved action and cached replay preserve ID/content and redact lease token', async t => {
  const { base, directory, port } = await httpFixture(t, { requirePosReservation: true });
  const payload = path.join(directory, 'receipt.json');
  fs.writeFileSync(payload, '\uFEFF' + JSON.stringify(receipt));
  const args = { url: base, case: 'receipt-advanced', payload, reserve: true, 'operation-id': 'operator:1', 'allow-device-action': true };
  const first = await run(args, () => {});
  assert.equal(first.success, true, first.error);
  assert.equal(first.steps.find(step => step.route === '/printer/reservations').body.token, '[redacted]');
  const count = port.writes.length;
  const second = await run(args, () => {});
  assert.equal(second.success, true);
  assert.equal(second.cached, true);
  assert.equal(port.writes.length, count);
  fs.writeFileSync(payload, JSON.stringify({ ...receipt, buyerNip: '9876543210' }));
  assert.equal((await run(args, () => {})).success, false);
  assert.equal(port.writes.length, count);
  assert.deepEqual(redact({ nested: { token: 'secret', tokenHash: 'hash', state: 'reserved' } }),
    { nested: { token: '[redacted]', tokenHash: '[redacted]', state: 'reserved' } });
});

test('operator reservation rehearsal exercises grant/read/renew/release/expiry without physical mutations', async t => {
  const { base, port, broker } = await httpFixture(t, { requirePosReservation: true });
  const result = await run({ url: base, mode: 'reservations' }, () => {});
  assert.equal(result.success, true, result.error);
  assert.equal(broker.status().reservation, null);
  assert.equal(port.mutations.length, 0);
});

test('operator tool can inspect unknown without replaying or clearing the block', async t => {
  const { base, broker, port } = await httpFixture(t);
  port.rejectOn = '$l';
  await assert.rejects(broker.printAdvancedReceipt(receipt, { operationId: 'unclear' }));
  const writes = port.writes.length;
  const report = await run({ url: base, case: 'operation', id: 'unclear' }, () => {});
  assert.equal(report.success, true);
  assert.equal(port.writes.length, writes);
  assert.deepEqual(broker.status().blockedOperations, ['unclear']);
});
