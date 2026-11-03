const test = require('node:test');
const assert = require('node:assert/strict');
const { browserAccess } = require('../browser-access');
const { httpFixture } = require('../test-support/http-fixture');

test('browser preflight explicitly permits the two new headers and never operates USB', async t => {
  const origin = 'https://pos.example.test';
  const { base, port } = await httpFixture(t, { allowedOrigins: [origin] });
  for (const route of ['/transaction/receipt-advanced', '/printer/reservations', '/cash/report']) {
    const response = await fetch(base + route, { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': route === '/cash/report' ? 'GET' : 'POST',
      'Access-Control-Request-Headers': 'content-type,x-operation-id,x-printer-reservation-token',
      'Access-Control-Request-Private-Network': 'true',
    } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.match(response.headers.get('Access-Control-Allow-Headers'), /X-Printer-Reservation-Token/);
    assert.equal(response.headers.get('Access-Control-Allow-Private-Network'), 'true');
  }
  assert.equal(port.writes.length, 0);
});

test('configured browser origin/header rejection precedes any receipt or cash command', async t => {
  const { base, port } = await httpFixture(t, { allowedOrigins: ['https://pos.example.test'] });
  const foreign = await fetch(base + '/cash-drawer/open', { method: 'POST', headers: { Origin: 'https://other.example.test' } });
  assert.equal(foreign.status, 403);
  const extra = await fetch(base + '/cash/report', { method: 'OPTIONS', headers: {
    Origin: 'https://pos.example.test', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
  } });
  assert.equal(extra.status, 403);
  assert.equal(port.writes.length, 0);
  const status = await fetch(base + '/broker/status', { headers: { Origin: 'https://pos.example.test' } });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('Access-Control-Allow-Origin'), 'https://pos.example.test');
  assert.equal(status.headers.get('Vary'), 'Origin');
});

test('browser origin configuration rejects wildcards and paths', () => {
  for (const origin of ['*', 'null', 'https://pos.example.test/', 'https://pos.example.test/path', 'file:///pos']) {
    assert.throws(() => browserAccess([origin]));
  }
});
