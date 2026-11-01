const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');
const { hash } = require('./operation-journal');

// Public command names are stable; arguments preserve the legacy JS interfaces.
const COMMANDS = {
  printReceipt: { command: 'receipt', arity: 1 },
  printAdvancedReceipt: { command: 'receipt-advanced', arity: 1 },
  login: { command: 'cashier-login', arity: 2 },
  logout: { command: 'cashier-logout', arity: 2 },
  cashDeposit: { command: 'cash-deposit', arity: 1 },
  cashWithdrawal: { command: 'cash-withdraw', arity: 1 },
  getCashDrawerStateReport: { command: 'cash-report', arity: 0 },
  printDailyReport: { command: 'daily-report', arity: 1 },
  printPeriodicReport: { command: 'periodic-report', arity: 1 },
  printVoidDocument: { command: 'void-document', arity: 0 },
  printTestVoidReceipt: { command: 'void-receipt', arity: 1 },
  reprintLastReceipt: { command: 'reprint-last', arity: 0 },
  openCashDrawer: { command: 'drawer-open', arity: 0 },
};

function problem(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

function ttl(value = 60000) {
  if (!Number.isInteger(value) || value < 1000 || value > 300000) {
    throw problem('INVALID_TTL', 'ttl_ms musi wynosić 1000–300000.', 400);
  }
  return value;
}

function publicReservation(record) {
  if (!record) return null;
  return { id: record.id, operation_id: record.operationId, command: record.command,
    state: record.state, expires_at: new Date(record.expiresAt).toISOString(),
    printer_unique_number: record.printerUniqueNumber };
}

class PrinterReservations {
  constructor(journal, now = () => Date.now()) {
    this.journal = journal;
    this.now = now;
    const active = journal.all().filter(r => r.kind === 'printer_reservation' && r.state === 'reserved');
    if (active.length > 1) throw new Error('W dzienniku są sprzeczne rezerwacje drukarki.');
    this.current = active[0] || null;
    this.active();
  }

  active() {
    if (this.current && this.journal.healthy && this.now() >= this.current.expiresAt) {
      this.journal.save({ ...this.current, state: 'expired' });
      this.current = null;
    }
    return this.current;
  }

  get(id) {
    this.active();
    const record = this.journal.get(id);
    return record?.kind === 'printer_reservation' ? record : null;
  }

  hasToken(record, token) {
    if (!record || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    return timingSafeEqual(Buffer.from(record.tokenHash, 'hex'), Buffer.from(hash(token), 'hex'));
  }

  authorize(token, operationId, command) {
    const active = this.active();
    if (!active) {
      if (token !== undefined) throw problem('INVALID_RESERVATION', 'Rezerwacja wygasła lub została zużyta.');
      return null;
    }
    if (token === undefined) throw problem('PRINTER_RESERVED', 'Drukarka jest zarezerwowana dla POS.');
    if (!this.hasToken(active, token)) throw problem('INVALID_RESERVATION_TOKEN', 'Nieprawidłowy token rezerwacji.', 403);
    if (active.operationId !== operationId || active.command !== command) {
      throw problem('RESERVATION_MISMATCH', 'Rezerwacja dotyczy innej operacji lub polecenia.');
    }
    return active;
  }

  create(operationId, command, printerUniqueNumber, ttlMs) {
    const duration = ttl(ttlMs);
    if (this.active()) throw problem('PRINTER_RESERVED', 'Drukarka ma aktywną rezerwację.');
    const token = randomBytes(32).toString('base64url');
    const record = this.journal.save({ id: `reservation:${randomUUID()}`, kind: 'printer_reservation',
      operationId, command, printerUniqueNumber, tokenHash: hash(token),
      state: 'reserved', createdAt: new Date(this.now()).toISOString(), expiresAt: this.now() + duration });
    this.current = record;
    return { ...publicReservation(record), token };
  }

  consume(record) {
    // One use, persisted before the operation. Expiry can never interrupt execution.
    const consumed = this.journal.save({ ...record, state: 'consumed' });
    this.current = null;
    return consumed;
  }

  renew(id, token, ttlMs) {
    const duration = ttl(ttlMs);
    const record = this.get(id);
    if (!this.hasToken(record, token)) throw problem('INVALID_RESERVATION_TOKEN', 'Nieprawidłowy token rezerwacji.', 403);
    if (record.state !== 'reserved' || this.current?.id !== id) throw problem('RESERVATION_NOT_ACTIVE', 'Rezerwacja nie jest aktywna.');
    this.current = this.journal.save({ ...record, expiresAt: this.now() + duration });
    return publicReservation(this.current);
  }

  release(id, token) {
    const record = this.get(id);
    if (!this.hasToken(record, token)) throw problem('INVALID_RESERVATION_TOKEN', 'Nieprawidłowy token rezerwacji.', 403);
    if (record.state === 'consumed') throw problem('RESERVATION_CONSUMED', 'Rezerwacja została zużyta; sprawdź wynik operacji.');
    if (record.state !== 'reserved') return publicReservation(record);
    const released = this.journal.save({ ...record, state: 'released' });
    this.current = null;
    return publicReservation(released);
  }
}

module.exports = { PrinterReservations, COMMANDS, publicReservation, problem, ttl };
