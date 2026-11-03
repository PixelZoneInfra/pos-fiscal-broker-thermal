const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createApi } = require('../api');
const { createControl } = require('../broker-control');
const { setup } = require('../test-support/printer-port');
const { describe, sameRoot } = require('../tools/broker-panel');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, options = {}) {
  const f = setup(t, { allowedOrigins: ['https://pos.example'] });
  const events = [];
  f.port.close = callback => { events.push('port-close'); f.port.isOpen = false; callback(); };
  const control = createControl({ printer: f.broker, journal: f.journal, port: f.port,
    transport: f.transport, root: f.directory, pollMs: 2, waitMs: 2000,
    onStopped: async () => { events.push('stopped'); }, ...options });
  const app = express();
  const legacy = createApi(f.broker);
  const server = control.attach(app, legacy).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); }));
  control.publish(server.address().port);
  const descriptor = JSON.parse(fs.readFileSync(path.join(f.directory, 'local-results', 'broker-control.json'), 'utf8'));
  const request = async (route, method = 'GET', headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers });
    return { status: response.status, body: await response.json() };
  };
  return { ...f, control, descriptor, events, request, legacy,
    stop: () => request('/broker/control/stop', 'POST', { 'X-Local-Control-Token': descriptor.token }) };
}

test('employee status reads only broker metadata, keeps CORS and never queries USB', async t => {
  const f = await fixture(t);
  const response = await f.request('/broker/status');
  assert.equal(response.status, 200);
  assert.equal(response.body.local_control.state, 'running');
  assert.equal(response.body.local_control.serial_connected, true);
  assert.equal(response.body.local_control.instance_id, f.descriptor.instance_id);
  assert.equal(JSON.stringify(response.body).includes(f.descriptor.token), false);
  assert.equal(f.port.writes.length, 0);
  const cors = await fetch(`http://127.0.0.1:${f.descriptor.port}/broker/status`, { headers: { Origin: 'https://pos.example' } });
  assert.equal(cors.headers.get('Access-Control-Allow-Origin'), 'https://pos.example');
  f.transport.fault = new Error('Disconnected');
  assert.equal((await f.request('/broker/status')).body.local_control.serial_connected, false);
});

test('stop rejects missing/wrong token and browser Origin, leaving the broker running', async t => {
  const f = await fixture(t);
  for (const headers of [{}, { 'X-Local-Control-Token': '0'.repeat(64) },
    { 'X-Local-Control-Token': f.descriptor.token, Origin: 'https://pos.example' },
    { 'X-Local-Control-Token': f.descriptor.token, Origin: 'null' }]) {
    assert.equal((await f.request('/broker/control/stop', 'POST', headers)).status, 403);
  }
  assert.equal(f.control.state, 'running');
  assert.notEqual(f.journal.fd, undefined);
  assert.equal(f.port.writes.length, 0);
});

test('stop drains a whole running operation, rejects new commands and preserves its saved outcome', async t => {
  const f = await fixture(t);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const running = f.broker.exclusive('receipt-test', async () => {
    await held;
    f.journal.save({ id: 'completed-before-stop', state: 'completed', kind: 'test' });
  });
  const stopping = f.stop();
  while (f.control.state !== 'draining') await pause(2);
  assert.equal((await f.request('/cash-drawer/open', 'POST')).status, 503);
  assert.notEqual(f.journal.fd, undefined);
  assert.deepEqual(f.events, []);
  release();
  await running;
  assert.equal((await stopping).status, 200);
  while (f.control.state !== 'closed') await pause(2);
  assert.deepEqual(f.events, ['port-close', 'stopped']);
  assert.equal(fs.existsSync(f.journal.lockPath), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'local-results', 'broker-control.json')), false);
  assert.equal(f.reopen().get('completed-before-stop').state, 'completed');
  assert.equal(f.port.writes.length, 0);
});

test('stop also waits for admitted HTTP handlers before they acquire the printer', async t => {
  const f = await fixture(t);
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.legacy.get('/waiting-test', async (_req, res) => {
    entered();
    await new Promise(resolve => { release = resolve; });
    res.json({ success: true });
  });
  const active = f.request('/waiting-test');
  await started;
  const stopping = f.stop();
  while (f.control.state !== 'draining') await pause(2);
  assert.equal(f.broker.busy, null);
  assert.notEqual(f.journal.fd, undefined);
  release();
  assert.equal((await active).status, 200);
  assert.equal((await stopping).status, 200);
});

test('an unused POS reservation refuses shutdown without interrupting the checkout', async t => {
  const f = await fixture(t);
  f.broker.reservations.create('sale-1', 'receipt', 'ABC1234567890', 60000);
  const result = await f.stop();
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'POS_RESERVED');
  assert.equal(f.control.state, 'running');
  assert.notEqual(f.journal.fd, undefined);
  assert.deepEqual(f.events, []);
});

test('an accepted stop still closes cleanly if its HTTP client disconnects while waiting', async t => {
  const f = await fixture(t);
  let release;
  const running = f.broker.exclusive('report-test', () => new Promise(resolve => { release = resolve; }));
  const req = require('node:http').request({ host: '127.0.0.1', port: f.descriptor.port,
    method: 'POST', path: '/broker/control/stop', headers: { 'X-Local-Control-Token': f.descriptor.token } });
  req.on('error', () => {});
  req.end();
  while (f.control.state !== 'draining') await pause(2);
  req.destroy();
  await pause(10);
  release();
  await running;
  const deadline = Date.now() + 1000;
  while (f.control.state !== 'closed' && Date.now() < deadline) await pause(2);
  assert.equal(f.control.state, 'closed');
  assert.equal(fs.existsSync(f.journal.lockPath), false);
  assert.deepEqual(f.events, ['port-close', 'stopped']);
});

test('a reservation granted during draining also cancels shutdown', async t => {
  const f = await fixture(t);
  let release;
  const operation = f.broker.exclusive('reserve:test', async () => {
    await new Promise(resolve => { release = resolve; });
    f.broker.reservations.create('sale-2', 'receipt', 'ABC1234567890', 60000);
  });
  const stopping = f.stop();
  while (f.control.state !== 'draining') await pause(2);
  release();
  await operation;
  assert.equal((await stopping).body.code, 'POS_RESERVED');
  assert.equal(f.control.state, 'running');
  assert.notEqual(f.journal.fd, undefined);
});

test('timeout refuses shutdown, keeps the journal open and never kills the running operation', async t => {
  const f = await fixture(t, { waitMs: 15 });
  f.broker.busy = 'long-report';
  const response = await f.stop();
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'STILL_BUSY');
  assert.equal(f.broker.busy, 'long-report');
  assert.equal(f.control.state, 'running');
  assert.notEqual(f.journal.fd, undefined);
  assert.deepEqual(f.events, []);
  f.broker.busy = null;
});

test('restart cleanup never erases ambiguous fiscal operations', async t => {
  const f = await fixture(t);
  f.journal.save({ id: 'needs-review', state: 'unknown', kind: 'printReceipt' });
  assert.equal((await f.stop()).status, 200);
  while (f.control.state !== 'closed') await pause(2);
  assert.equal(f.reopen().get('needs-review').state, 'unknown');
});

test('employee messages distinguish stopped, disconnected and blocked states without claiming printer readiness', () => {
  assert.match(describe(null), /wyłączony/);
  const text = describe({ serialPort: 'COM3', journalHealthy: true, blockedOperations: ['a'],
    local_control: { serial_connected: false, state: 'running' } });
  assert.match(text, /BRAK/);
  assert.match(text, /Restart nie usuwa/);
  assert.match(text, /nie sprawdza papieru/);
  assert.equal(sameRoot('/different-broker-folder'), false);
});
