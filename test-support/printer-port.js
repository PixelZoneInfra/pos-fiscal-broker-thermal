const { EventEmitter } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { frame } = require('../thermal-protocol');
const { ThermalTransport } = require('../thermal-transport');
const { createPrinter } = require('../thermal-printer');
const { OperationJournal } = require('../operation-journal');
const { BrokerService } = require('../broker-service');

const receipt = {
  items: [{ name: 'Kawa', quantity: 2, unitPrice: 12, vatRate: 'B' }],
  payments: [{ type: 'CARD', amount: 24, name: 'PayU' }], buyerNip: '1234567890',
};

class PrinterPort extends EventEmitter {
  constructor() {
    super();
    this.isOpen = true;
    this.writes = [];
    this.mutations = [];
    this.uniqueNumber = 'ABC1234567890';
    this.programmedId = 'CUSTOM-ID';
    this.document = 100;
    this.receipts = 7;
    this.openTransaction = false;
    this.trf = true;
    this.commandOk = true;
    this.lastError = 0;
    this.hardwareByte = 0x74;
    this.cash = 0;
    this.fragment = true;
  }

  respond(bytes) {
    if (this.silent) return;
    const response = Buffer.isBuffer(bytes) ? bytes : Buffer.from([bytes]);
    queueMicrotask(() => {
      if (this.fragment && response.length > 4) {
        this.emit('data', response.subarray(0, 1));
        this.emit('data', response.subarray(1, 4));
        this.emit('data', response.subarray(4, -1));
        this.emit('data', response.subarray(-1));
      } else this.emit('data', response);
    });
  }

  write(command, callback) {
    this.writes.push(Buffer.from(command));
    const text = command.toString('binary');
    if (this.disconnectOn && text.includes(this.disconnectOn)) {
      this.isOpen = false;
      queueMicrotask(() => this.emit('close'));
      callback();
      return;
    }
    if (command[0] === 0x05) this.respond(0x68 | (this.commandOk ? 4 : 0) | (this.openTransaction ? 2 : 0) | (this.trf ? 1 : 0));
    else if (command[0] === 0x10) this.respond(this.hardwareByte);
    else if (text.includes('2#v')) this.respond(frame(`3#RPOSNET THERMAL XL2 ONLINE\r20.01\r${this.uniqueNumber}\r`));
    else if (text.includes('23#s')) {
      this.respond(frame(`2#X${this.lastError};1;${this.openTransaction ? 1 : 0};${this.trf ? 1 : 0};1;0;26;11;1/23,00/8/0.0/100/101/101/101/${this.receipts}/0/0/0/0/0/0/0/${this.cash}/${this.programmedId}`));
      this.lastError = 0;
    } else if (text.includes('50#s')) this.respond(frame(`50#X${this.document}/0/0/0/0/0/`));
    else if (text.includes('#c')) this.respond(frame('1#C26;11;1;12;30;0', false));
    else if (text.includes('#n')) this.respond(frame(`1#E${this.lastError}`, false));
    else if (text.includes('#s')) this.respond(frame('1#X0;1;0;1;1;0;26;11;1/23.00/7/0/1/0/0/0/0/0/CUSTOM-ID', false));
    else {
      this.mutations.push(text);
      this.commandOk = !(this.rejectOn && text.includes(this.rejectOn));
      this.lastError = this.commandOk ? 0 : 39;
      if (this.commandOk) {
        if (text.includes('$h')) { this.openTransaction = true; this.trf = false; }
        else if (text.startsWith('\x1bP0$e')) { this.openTransaction = false; this.trf = false; }
        else if (text.includes('$y') || text.includes('1;0$e')) {
          this.openTransaction = false; this.trf = true; this.receipts++; this.document++;
        } else if (text.includes('#r')) { this.receipts = 0; this.document++; }
        else if (text.includes('#i')) this.cash += Number(text.match(/#i([^/]+)/)[1]);
        else if (text.includes('#d')) this.cash -= Number(text.match(/#d([^/]+)/)[1]);
      }
      this.onMutation?.(text);
    }
    callback();
  }

  drain(callback) { callback(); }
}

function setup(t, config = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'thermal-test-'));
  const journal = new OperationJournal(directory);
  const journals = [journal];
  const port = new PrinterPort();
  const transport = new ThermalTransport(port, { timeoutMs: 30, reportTimeoutMs: 60 });
  const raw = createPrinter(transport, { delay: async () => {} });
  const broker = new BrokerService(raw, journal, config);
  t.after(() => { for (const item of journals) item.close(); rmSync(directory, { recursive: true, force: true }); });
  const reopen = () => { const item = new OperationJournal(directory); journals.push(item); return item; };
  return { directory, journal, port, transport, raw, broker, reopen };
}

module.exports = { PrinterPort, receipt, setup };
