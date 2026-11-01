const { Decoder, bodyOf, frame } = require('./thermal-protocol');

class ThermalTransport {
  constructor(port, { timeoutMs = 5000, reportTimeoutMs = 120000 } = {}) {
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.reportTimeoutMs = reportTimeoutMs;
    this.decoder = new Decoder();
    this.pending = null;
    this.fault = null;
    port.on('data', chunk => {
      try {
        const tokens = this.decoder.feed(chunk);
        // A second response without a second request is unsafe to attribute.
        if (!this.pending || tokens.length > 1 || tokens.length === 1 &&
          (this.decoder.buffer.length || !this.pending.match?.(tokens[0]))) {
          throw new Error('Nieoczekiwana odpowiedź; wymagane ponowne połączenie.');
        }
        if (tokens.length) this.pending.receive(tokens[0]);
      } catch (error) { this.fail(error); }
    });
    port.on('error', error => this.fail(error));
    port.on('close', () => this.fail(new Error('Port drukarki został zamknięty.')));
  }

  fail(error) {
    this.fault = error;
    this.pending?.reject(error);
  }

  exchange(command, match = null, timeoutMs = this.timeoutMs) {
    if (this.fault) return Promise.reject(this.fault);
    if (!this.port.isOpen) return Promise.reject(new Error('Port drukarki nie jest otwarty.'));
    if (this.pending) return Promise.reject(new Error('Równoległe polecenie portu jest zabronione.'));
    return new Promise((resolve, reject) => {
      let written = false, response;
      const finish = () => {
        if (!written || match && !response) return;
        cleanup();
        resolve(response);
      };
      const cleanup = () => { clearTimeout(timer); this.pending = null; };
      const abort = error => { cleanup(); reject(error); };
      const timer = setTimeout(() => this.fail(new Error('Timeout odpowiedzi drukarki; wynik wymaga sprawdzenia.')), timeoutMs);
      this.pending = { match, reject: abort, receive: token => {
        if (response) return this.fail(new Error('Powtórzona odpowiedź drukarki.'));
        response = token;
        finish();
      } };
      try {
        this.port.write(command, error => {
          if (error) return this.fail(error);
          this.port.drain(error => {
            if (error) return this.fail(error);
            if (this.fault) return;
            written = true;
            finish();
          });
        });
      } catch (error) { this.fail(error); }
    });
  }

  async request(command, prefix, checked = false) {
    const token = await this.exchange(command, t => t.type === 'frame' && t.value.toString('binary').startsWith(prefix));
    try { bodyOf(token, prefix, checked); } catch (error) { this.fail(error); throw error; }
    return token;
  }

  async enq(timeoutMs) {
    const token = await this.exchange(Buffer.from([0x05]), t => t.type === 'enq', timeoutMs);
    return { fiscal: !!(token.value & 8), commandOk: !!(token.value & 4), transactionOpen: !!(token.value & 2), transactionOk: !!(token.value & 1) };
  }

  async hardware() {
    const token = await this.exchange(Buffer.from([0x10]), t => t.type === 'dle');
    const state = { online: !!(token.value & 4), paperOrBatteryError: !!(token.value & 2), mechanismError: !!(token.value & 1) };
    if (!state.online || state.paperOrBatteryError || state.mechanismError) {
      throw Object.assign(new Error('Drukarka offline, brak papieru lub błąd mechanizmu.'), { hardware: state });
    }
    return state;
  }

  async command(command, { report = false } = {}) {
    await this.exchange(command);
    const state = await this.enq(report ? this.reportTimeoutMs : this.timeoutMs);
    if (!state.commandOk) {
      const error = await this.request(frame('#n', false), '1#E');
      throw Object.assign(new Error(`Drukarka odrzuciła polecenie: ${bodyOf(error, '1#E')}.`), { printerError: bodyOf(error, '1#E') });
    }
    await this.hardware();
    return state;
  }
}

module.exports = { ThermalTransport };
