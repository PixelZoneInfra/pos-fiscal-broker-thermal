const test = require('node:test');
const assert = require('node:assert/strict');
const { createApi } = require('../api');
const { receipt, setup } = require('../test-support/printer-port');

async function api(t, config) {
  const fixture = setup(t, config);
  const server = createApi(fixture.broker).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body, headers = {}) => {
    const response = await fetch(base + route, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...fixture, request };
}

test('legacy HTTP contract preserves total/success and accepts a stable optional operation ID', async t => {
  const { request, port } = await api(t);
  assert.equal((await request('/transaction/receipt-advanced', {})).status, 400);
  const first = await request('/transaction/receipt-advanced', receipt, { 'X-Operation-Id': 'http:1' });
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);
  assert.equal(first.body.total, 24);
  assert.equal(first.body.state, 'fiscal_confirmed');
  const count = port.writes.length;
  assert.deepEqual((await request('/transaction/receipt-advanced', receipt, { 'X-Operation-Id': 'http:1' })).body, first.body);
  assert.equal(port.writes.length, count);
  assert.equal((await request('/operations/http:1')).body.state, 'fiscal_confirmed');
  assert.equal((await request('/operations/missing')).status, 404);
  assert.equal((await request('/test/break-printer', {})).status, 410);
  assert.equal(port.writes.length, count);
});

test('HTTP unknown result stays false, is inspectable, and blocks other legacy endpoints', async t => {
  const { request, port } = await api(t);
  port.rejectOn = '$l';
  const failed = await request('/transaction/receipt-advanced', receipt, { 'X-Operation-Id': 'http:2' });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.state, 'unknown');
  assert.equal(failed.body.success, false);
  assert.equal((await request('/reports/daily', {})).status, 409);
  assert.deepEqual((await request('/broker/status')).body.blockedOperations, ['http:2']);
  assert.equal((await request('/operations/http:2/reconcile', {})).body.state, 'unknown');
  assert.equal((await request('/cash-drawer/open', {})).status, 409);
});

test('new HTTP contract is off by default, validates assignment, and returns the persisted result', async t => {
  const { request, broker, port } = await api(t);
  const data = { operation_id: 'http:online', branch_id: 1, environment: 'test', printer_unique_number: port.uniqueNumber, receipt };
  assert.equal((await request('/operations/receipt', data)).status, 503);
  Object.assign(broker.config, { onlineEnabled: true, requirePosReservation: true, branchId: 1, environment: 'test', printerUniqueNumber: port.uniqueNumber });
  assert.equal((await request('/operations/receipt', { ...data, branch_id: 2 })).status, 409);
  const printed = await request('/operations/receipt', data);
  assert.equal(printed.body.state, 'fiscal_confirmed');
  const count = port.writes.length;
  assert.deepEqual((await request('/operations/receipt', data)).body, printed.body);
  assert.equal(port.writes.length, count);
  assert.equal((await request('/device/diagnostics')).body.identity.uniqueNumber, port.uniqueNumber);
});

test('HTTP copy recovery checks fresh evidence, records the employee, and never exposes sale cancellation', async t => {
  const { request, raw, journal, port } = await api(t);
  const before = await raw.getSnapshot();
  journal.save({ id: 'pos:old-copy', kind: 'reprintLastReceipt', state: 'unknown', before });
  journal.save({ id: 'pos:real-sale', kind: 'printAdvancedReceipt', state: 'unknown', before });
  assert.equal((await request('/broker/status')).body.capabilities.copyRecovery, true);
  assert.equal((await request('/operations/pos:old-copy')).body.copyRecovery.can_close, false);
  const checked = await request('/operations/pos:old-copy/reconcile', {});
  assert.equal(checked.body.copyRecovery.can_close, true);
  const data = { actor: 'Kasjer Banino', expected_updated_at: checked.body.updatedAt, printer_unique_number: port.uniqueNumber };
  assert.equal((await request('/operations/pos:old-copy/close-failed-copy', {})).status, 400);
  assert.equal((await request('/operations/pos:old-copy/close-failed-copy', { ...data, expected_updated_at: 'old' })).status, 409);
  assert.equal((await request('/operations/pos:real-sale/close-failed-copy', data)).body.code, 'COPY_ONLY');
  const closed = await request('/operations/pos:old-copy/close-failed-copy', data);
  assert.equal(closed.status, 200);
  assert.equal(closed.body.operation.state, 'cancelled');
  assert.equal(closed.body.operation.resolution.actor, 'Kasjer Banino');
  assert.deepEqual(closed.body.blockedOperations, ['pos:real-sale']);
  assert.equal(port.mutations.length, 0);
  assert.equal((await request('/cash-drawer/open', {})).status, 409);
});
