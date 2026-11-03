const test = require('node:test');
const assert = require('node:assert/strict');
const { createApi } = require('../api');
const { API_CASES } = require('../api-catalog');
const { COMMANDS } = require('../printer-reservations');
const { httpFixture } = require('../test-support/http-fixture');
const { receipt } = require('../test-support/printer-port');

const bodies = {
  receipt: { items: receipt.items, payment: { amountPaid: 24 }, buyerNip: receipt.buyerNip },
  'receipt-advanced': receipt,
  'cashier-login': { cashier: 'Kasjer', register: 'Kasa 1' },
  'cashier-logout': { cashier: 'Kasjer', register: 'Kasa 1' },
  'cash-deposit': { amount: 100 }, 'cash-withdraw': { amount: 20 },
  'daily-report': { cashier: 'Kasjer', register: 'Kasa 1' },
  'periodic-report': { startDate: '2026-10-01', endDate: '2026-11-01' },
  'void-receipt': { items: receipt.items },
};

test('catalog covers every implemented route and every reservable POS command', () => {
  const app = createApi({});
  const actual = app._router.stack.filter(layer => layer.route).flatMap(layer =>
    Object.keys(layer.route.methods).map(method => `${method.toUpperCase()} ${layer.route.path}`));
  assert.deepEqual(actual.sort(), API_CASES.map(entry => `${entry.method} ${entry.path}`).sort());
  assert.deepEqual(API_CASES.filter(entry => entry.command).map(entry => entry.command).sort(),
    Object.values(COMMANDS).map(entry => entry.command).sort());
  assert.equal(API_CASES.find(entry => entry.id === 'cash-report').effect, 'device');
});

for (const entry of API_CASES.filter(entry => entry.command)) {
  test(`POS HTTP regression: ${entry.method} ${entry.path}, legacy + reserved + idempotency`, async t => {
    const { request, broker, port } = await httpFixture(t);
    const body = entry.method === 'GET' ? undefined : bodies[entry.id] || {};
    const first = await request(entry.path, body, { 'X-Operation-Id': `legacy:${entry.id}` }, entry.method);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.success, true);
    assert.equal(first.body.state, entry.effect === 'fiscal' ? 'fiscal_confirmed' : 'completed');
    assert.ok(port.mutations.length);
    const count = port.writes.length;
    assert.deepEqual((await request(entry.path, body, { 'X-Operation-Id': `legacy:${entry.id}` }, entry.method)).body, first.body);
    assert.equal(port.writes.length, count);
    broker.config.requirePosReservation = true;
    assert.equal((await request(entry.path, body, {}, entry.method)).body.code, 'RESERVATION_REQUIRED');
    const grant = await request('/printer/reservations', { operation_id: `reserved:${entry.id}`, command: entry.command });
    assert.equal(grant.status, 201);
    const headers = { 'X-Operation-Id': grant.body.operation_id, 'X-Printer-Reservation-Token': grant.body.token };
    const reserved = await request(entry.path, body, headers, entry.method);
    assert.equal(reserved.status, 200, JSON.stringify(reserved.body));
    assert.equal(reserved.body.success, true);
    assert.equal(broker.getReservation(grant.body.id).state, 'consumed');
    const after = port.writes.length;
    assert.deepEqual((await request(entry.path, body, headers, entry.method)).body, reserved.body);
    assert.equal(port.writes.length, after);
  });
}

test('diagnostics-only blocks EVERY fiscal/cash/device route, including mutating GET, before USB', async t => {
  const { request, port } = await httpFixture(t, { diagnosticsOnly: true, onlineEnabled: true, requirePosReservation: true,
    branchId: 1, environment: 'test', printerUniqueNumber: 'ABC1234567890' });
  for (const entry of API_CASES.filter(entry => entry.command)) {
    const response = await request(entry.path, entry.method === 'GET' ? undefined : bodies[entry.id] || {}, {}, entry.method);
    assert.equal(response.body.code, 'DIAGNOSTICS_ONLY', entry.path);
    assert.equal(response.status, 503);
  }
  const online = await request('/operations/receipt', { operation_id: 'online:diag', branch_id: 1, environment: 'test',
    printer_unique_number: port.uniqueNumber, receipt });
  assert.equal(online.body.code, 'DIAGNOSTICS_ONLY');
  assert.equal((await request('/printer/reservations', { operation_id: 'diag', command: 'receipt' })).body.code, 'DIAGNOSTICS_ONLY');
  assert.equal(port.writes.length, 0);
  assert.equal((await request('/broker/status')).body.diagnosticsOnly, true);
  for (const entry of API_CASES.filter(entry => entry.effect === 'read' && !entry.path.includes(':id'))) {
    assert.equal((await request(entry.path)).status, 200);
  }
  assert.equal(port.mutations.length, 0);
});

test('cached unknown cash operation cannot be presented as a successful deposit', async t => {
  const { request, port } = await httpFixture(t);
  port.rejectOn = '#i';
  const headers = { 'X-Operation-Id': 'cash:unknown' };
  assert.equal((await request('/cash/deposit', { amount: 10 }, headers)).body.state, 'unknown');
  const writes = port.writes.length;
  const cached = await request('/cash/deposit', { amount: 10 }, headers);
  assert.equal(cached.status, 409);
  assert.equal(cached.body.success, false);
  assert.notEqual(cached.body.message, 'Wpłacono 10 do kasy.');
  assert.equal(port.writes.length, writes);
});
