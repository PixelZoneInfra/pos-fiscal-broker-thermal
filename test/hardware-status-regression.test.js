const test = require('node:test');
const assert = require('node:assert/strict');
const { frame } = require('../thermal-protocol');
const { httpFixture } = require('../test-support/http-fixture');
const { run } = require('../scripts/broker-check');

test('check:broker completes read-only diagnostics when XL2 returns trailing decimal zeroes', async t => {
  const { port, base } = await httpFixture(t, { diagnosticsOnly: true });
  const originalWrite = port.write.bind(port);
  port.write = (command, callback) => {
    const text = command.toString('binary');
    let response;
    if (text.includes('23#s')) {
      response = frame('2#X0;1;0;1;1;0;26;11;1/23.00/08.00/05.00/00.00/101/101/100/0/0./0./0./0./0./0./0./12.50/TEST123');
    } else if (text.includes('#s') && !text.includes('50#s')) {
      // Original unparsed status shape from the field report, with private values replaced.
      response = frame('1#X0;1;0;1;1;0;26;11;1/23.00/08.00/05.00/00.00/0/0./0./0./0./0./12.50/TEST123', false);
    }
    if (!response) return originalWrite(command, callback);
    port.writes.push(Buffer.from(command));
    port.respond(response);
    callback();
  };
  const report = await run({ url: base }, () => {});
  assert.equal(report.success, true, report.error);
  assert.deepEqual(report.steps.map(step => step.status), [200, 200, 200, 200, 200]);
  const parsed = report.steps.find(step => step.route === '/status/parsed').body.status;
  assert.equal(parsed.cashInDrawer, 12.5);
  assert.equal(parsed.dailyTotals.A, 0);
  assert.equal(port.mutations.length, 0);
});
