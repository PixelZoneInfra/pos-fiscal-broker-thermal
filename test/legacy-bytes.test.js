const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrinter } = require('../thermal-printer');
const fixture = require('./fixtures/legacy-command-bytes.json');

// Captured independently from main bff216b, not recomputed by the new builders.
process.env.TZ = 'UTC';
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [2026, 10, 1, 12, 0, 0])); }
}

for (const sample of fixture.cases) {
  test(`legacy bytes, framing, checksum and order: ${sample.name}`, async () => {
    const actual = [];
    const printer = createPrinter({ async command(bytes) {
      actual.push(bytes.toString('hex'));
      const start = bytes.toString('binary').includes('$h');
      return { fiscal: true, commandOk: true, transactionOpen: start, transactionOk: !start };
    } }, { delay: async () => {} });
    global.Date = FixedDate;
    try { await printer[sample.method](...sample.args); }
    finally { global.Date = RealDate; }
    const expected = sample.removedInitialCancel ? sample.frames.slice(1) : sample.frames;
    assert.deepEqual(actual, expected);
  });
}
