const test = require('node:test');
const assert = require('node:assert/strict');
const { Decoder, frame, parseStatus, parseCounter, parseIdentity, parseClock } = require('../thermal-protocol');
const { ThermalTransport } = require('../thermal-transport');
const { PrinterPort } = require('../test-support/printer-port');

test('decoder handles every split and coalesced frames/status bytes', () => {
  const data = Buffer.concat([frame('3#RX\r1\rABC\r'), Buffer.from([0x6d, 0x74]), frame('50#X123/0/0/0/0/0/')]);
  for (let split = 1; split < data.length; split++) {
    const decoder = new Decoder();
    const tokens = [...decoder.feed(data.subarray(0, split)), ...decoder.feed(data.subarray(split))];
    assert.deepEqual(tokens.map(t => t.type), ['frame', 'enq', 'dle', 'frame']);
    assert.equal(parseIdentity(tokens[0]).uniqueNumber, 'ABC');
    assert.equal(parseCounter(tokens[3]).lastDocumentNumber, 123);
  }
});

test('fixed VAT slots support comma, integer, exempt and inactive rates', () => {
  const token = new Decoder().feed(frame('2#X0;1;0;1;1;0;26;11;1/23,00/8/0.0/100/101/101/101/42/1/2/3/4/5/6/7/12,50/CUSTOM'))[0];
  const parsed = parseStatus(token);
  assert.deepEqual(parsed.vatRates, { A: 23, B: 8, C: 0, D: 'zwolniona', E: 'nieaktywna', F: 'nieaktywna', G: 'nieaktywna' });
  assert.equal(parsed.receiptsSinceDailyReport, 42);
  assert.equal(parsed.cashInDrawer, 12.5);
  assert.equal(parsed.uniqueId, 'CUSTOM');
  assert.equal(parsed.lastWriteDate, '2026-11-01');
});

test('corrupt checksums and invalid RTC dates are rejected', () => {
  const token = new Decoder().feed(frame('3#RX\r1\rABC\r'))[0];
  token.value[4] ^= 1;
  assert.throws(() => parseIdentity(token), /suma kontrolna/);
  const clock = new Decoder().feed(frame('1#C26;2;30;12;0;0', false))[0];
  assert.throws(() => parseClock(clock), /data RTC/);
});

test('Thermal status accepts zero totals with a trailing decimal separator reported by a physical XL2', () => {
  // Numeric forms from the field report; cash amount and device ID are anonymized.
  const token = new Decoder().feed(frame('2#X0;1;0;1;1;0;26;11;1/23.00/08.00/05.00/00.00/101/101/100/0/0./0./0./0./0./0./0./12.50/TEST123'))[0];
  const status = parseStatus(token);
  assert.equal(status.lastCommandError, 0);
  assert.equal(status.isFiscal, true);
  assert.equal(status.isTransactionOpen, false);
  assert.equal(status.lastTransactionOk, true);
  assert.equal(status.receiptsSinceDailyReport, 0);
  assert.deepEqual(status.dailyTotals, { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 });
  assert.equal(status.cashInDrawer, 12.5);
  assert.equal(status.vatRates.B, 8);
  assert.equal(status.vatRates.C, 5);
});

test('trailing separators remain strict: missing or malformed numbers are rejected, not coerced to zero', () => {
  const statusWithCash = cash => new Decoder().feed(frame(`2#X0;1;0;1;1;0;26;11;1/23/8/5/0/101/101/100/0/0./0./0./0./0./0./0./${cash}/TEST123`))[0];
  for (const [value, expected] of [['0.', 0], ['0,', 0], ['12.', 12], ['12,', 12], ['12.50', 12.5], ['12,50', 12.5], ['-12.', -12]]) {
    assert.equal(parseStatus(statusWithCash(value)).cashInDrawer, expected);
  }
  for (const value of ['', '.', ',', '0..', '0.,', '12x', '1e2', 'NaN', 'Infinity', '--1', '1 2']) {
    assert.throws(() => parseStatus(statusWithCash(value)), /Nieprawidłowa liczba/);
  }
});

test('transport assembles fragmented responses, checks CRC and never reuses a timed-out stream', async () => {
  const port = new PrinterPort();
  const transport = new ThermalTransport(port, { timeoutMs: 10 });
  assert.equal(parseIdentity(await transport.request(frame('2#v', false), '3#R', true)).uniqueNumber, port.uniqueNumber);
  port.silent = true;
  await assert.rejects(transport.request(frame('2#v', false), '3#R', true), /Timeout/);
  const count = port.writes.length;
  port.silent = false;
  await assert.rejects(transport.enq(), /Timeout/);
  assert.equal(port.writes.length, count);
});

test('unexpected/coalesced extra responses poison the stream instead of being assigned to another request', async () => {
  const port = new PrinterPort();
  port.respond = () => queueMicrotask(() => port.emit('data', Buffer.from([0x6d, 0x6d])));
  const transport = new ThermalTransport(port);
  await assert.rejects(transport.enq(), /Nieoczekiwana/);
  await assert.rejects(transport.enq(), /Nieoczekiwana/);
});

test('write success with CMD=0 is a printer error, not a successful command', async () => {
  const port = new PrinterPort();
  port.rejectOn = '$l';
  const transport = new ThermalTransport(port);
  await assert.rejects(transport.command(frame('1$lKawa\r1\rB/12/12/')), /odrzuciła polecenie: 39/);
});
