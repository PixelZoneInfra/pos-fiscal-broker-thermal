// POSNET Thermal Online, POT-I-DEV-10 v4530, sections 3.1 and 3.8.
const START = Buffer.from([0x1b, 0x50]);
const END = Buffer.from([0x1b, 0x5c]);

function checksum(body) {
  return [...body].reduce((value, byte) => value ^ byte, 255)
    .toString(16).toUpperCase().padStart(2, '0');
}

function frame(body, checked = true) {
  const bytes = Buffer.from(body, 'binary');
  return Buffer.concat([START, bytes, checked ? Buffer.from(checksum(bytes)) : Buffer.alloc(0), END]);
}

class Decoder {
  constructor() { this.buffer = Buffer.alloc(0); }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const tokens = [];
    while (this.buffer.length) {
      const byte = this.buffer[0];
      if (byte >= 0x60 && byte <= 0x6f || byte >= 0x70 && byte <= 0x77) {
        tokens.push({ type: byte < 0x70 ? 'enq' : 'dle', value: byte });
        this.buffer = this.buffer.subarray(1);
      } else if (byte === 0x1b) {
        if (this.buffer.length === 1) break;
        if (this.buffer[1] !== 0x50) throw new Error('Nieprawidłowy początek ramki Thermal.');
        const end = this.buffer.indexOf(END, 2);
        if (end === -1) {
          if (this.buffer.length > 65536) throw new Error('Zbyt długa ramka Thermal.');
          break;
        }
        if (end > 65536) throw new Error('Zbyt długa ramka Thermal.');
        tokens.push({ type: 'frame', value: Buffer.from(this.buffer.subarray(2, end)) });
        this.buffer = this.buffer.subarray(end + END.length);
      } else {
        throw new Error('Nieoczekiwany bajt odpowiedzi Thermal.');
      }
    }
    return tokens;
  }
}

function bodyOf(token, prefix, checked = false) {
  if (token.type !== 'frame') throw new Error('Oczekiwano ramki Thermal.');
  let body = token.value;
  if (checked) {
    const data = body.subarray(0, -2);
    if (body.length < 3 || body.subarray(-2).toString().toUpperCase() !== checksum(data)) {
      throw new Error('Nieprawidłowa suma kontrolna odpowiedzi.');
    }
    body = data;
  }
  const text = body.toString('binary');
  if (!text.startsWith(prefix)) throw new Error(`Oczekiwano odpowiedzi ${prefix}.`);
  return text.slice(prefix.length).trim();
}

function number(value) {
  const text = String(value).trim().replace(',', '.');
  // Thermal can omit fractional zeroes: "0." is a complete numeric value.
  if (!/^-?\d+(\.\d*)?$/.test(text)) throw new Error('Nieprawidłowa liczba w odpowiedzi.');
  const result = Number(text);
  if (!Number.isFinite(result)) throw new Error('Liczba poza zakresem.');
  return result;
}

function integer(value) {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Nieprawidłowy licznik.');
  return result;
}

function parseStatus(token) {
  const fields = bodyOf(token, '2#X', true).split('/').map(x => x.trim());
  if (fields.length !== 18) throw new Error('Nieprawidłowy format th_scinfo Ps=23.');
  const flags = fields[0].split(';').map(integer);
  if (flags.length !== 9 || flags.slice(1, 4).some(x => x > 1)) throw new Error('Nieprawidłowe flagi statusu.');
  const letters = [...'ABCDEFG'];
  const rates = fields.slice(1, 8).map(number);
  const totals = fields.slice(9, 16).map(number);
  return {
    lastCommandError: flags[0], isFiscal: flags[1] === 1,
    isTransactionOpen: flags[2] === 1, lastTransactionOk: flags[3] === 1,
    ramResets: flags[5],
    lastWriteDate: `20${String(flags[6]).padStart(2, '0')}-${String(flags[7]).padStart(2, '0')}-${String(flags[8]).padStart(2, '0')}`,
    vatRates: Object.fromEntries(letters.map((key, i) => [key, rates[i] === 100 ? 'zwolniona' : rates[i] === 101 ? 'nieaktywna' : rates[i]])),
    receiptsSinceDailyReport: integer(fields[8]),
    dailyTotals: Object.fromEntries(letters.map((key, i) => [key, totals[i]])),
    cashInDrawer: number(fields[16]),
    // Compatibility field: this can be programmed with th_progid; it is NOT the fiscal identity.
    uniqueId: fields[17], programmedId: fields[17],
  };
}

function parseIdentity(token) {
  const parts = bodyOf(token, '3#R', true).split('\r');
  if (parts.length !== 3 || parts.some(x => !x.trim())) throw new Error('Nieprawidłowy format th_getrealid.');
  return { model: parts[0].trim(), firmware: parts[1].trim(), uniqueNumber: parts[2].trim() };
}

function parseCounter(token) {
  const parts = bodyOf(token, '50#X', true).split('/').map(x => x.trim());
  if (parts.at(-1) === '') parts.pop();
  if (parts.length !== 6) throw new Error('Nieprawidłowy format th_scnt.');
  return { lastDocumentNumber: integer(parts[0]), totalsZero: integer(parts[1]) === 1, invoiceCount: integer(parts[2]) };
}

function parseClock(token) {
  const values = bodyOf(token, '1#C').split(';').map(integer);
  if (values.length !== 6) throw new Error('Nieprawidłowy zegar RTC.');
  let [year, month, day, hour, minute, second] = values;
  if (year < 100) year += 2000;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second !== 0) {
    throw new Error('Nieprawidłowa data RTC.');
  }
  // Printer-local time, minute precision; do not invent a UTC offset or receipt timestamp.
  return { localTime: date.toISOString().slice(0, 19), precision: 'minute', source: 'th_rtcget' };
}

module.exports = { Decoder, checksum, frame, bodyOf, parseStatus, parseIdentity, parseCounter, parseClock };
