const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { descriptorProcessAlive } = require('../tools/broker-panel');

const root = path.join(os.tmpdir(), 'pos-fiscal-broker-install');
const local = { pid: 4836, root };
const spooler = { ProcessId: 4836, Name: 'spoolsv.exe', ExecutablePath: 'C:\\Windows\\System32\\spoolsv.exe',
  CommandLine: 'C:\\Windows\\System32\\spoolsv.exe' };
const options = owner => ({ root, platform: 'win32', isAlive: () => true, processes: async () => owner ? [owner] : [] });

test('a stale control PID reused by the Windows spooler does not block broker restart', async () => {
  assert.equal(await descriptorProcessAlive(local, options(spooler)), false);
});

test('an identifiable unrelated Node process also cannot impersonate the stopped broker', async () => {
  assert.equal(await descriptorProcessAlive(local, options({ ProcessId: 4836, Name: 'node.exe',
    ExecutablePath: 'C:\\nodejs\\node.exe', CommandLine: 'node C:\\unrelated\\worker.js' })), false);
});

for (const owner of [
  { ...spooler, Name: 'electron.exe' },
  { ...spooler, Name: 'pos-fiscal-broker-thermal.exe' },
  { ...spooler, Name: 'node.exe', CommandLine: `node "${path.join(root, 'main.js')}"` },
  { ...spooler, Name: 'node.exe', CommandLine: null },
  { ...spooler, ExecutablePath: null },
  { ...spooler, ExecutablePath: 'relative.exe' },
  null,
]) {
  test(`possible broker or unknown owner remains fenced: ${JSON.stringify(owner)}`, async () => {
    assert.equal(await descriptorProcessAlive(local, options(owner)), true);
  });
}

test('an absent PID needs no inventory and Windows query errors are not treated as absence', async () => {
  const denied = async () => { throw new Error('CIM denied fixture'); };
  assert.equal(await descriptorProcessAlive(local, { ...options(spooler), isAlive: () => false, processes: denied }), false);
  await assert.rejects(descriptorProcessAlive(local, { ...options(spooler), processes: denied }), /CIM denied/);
  await assert.rejects(descriptorProcessAlive(local, { ...options(spooler), processes: async () => null }), /pewnej listy/);
});

test('a descriptor PID reused by this Node panel is not a running broker', async () => {
  const own = { ProcessId: process.pid, Name: 'node.exe', ExecutablePath: 'C:\\nodejs\\node.exe',
    CommandLine: `node "${path.join(root, 'tools', 'broker-panel.js')}" restart` };
  assert.equal(await descriptorProcessAlive({ ...local, pid: process.pid }, options(own)), false);
});
