const { randomUUID } = require('node:crypto');
const { hash } = require('./operation-journal');
const { PrinterReservations, COMMANDS, publicReservation, problem, ttl } = require('./printer-reservations');

const READS = new Set(['getStatusInfo', 'getParsedStatusInfo', 'getCashDrawerState', 'getSnapshot']);
const RECEIPTS = new Set(['printReceipt', 'printAdvancedReceipt']);

function validateId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(id)) throw problem('INVALID_ID', 'Nieprawidłowy operation_id.', 400);
}

function validateReceipt(receipt, advanced) {
  if (!receipt || !Array.isArray(receipt.items) || !receipt.items.length || receipt.items.length > 500) {
    throw problem('INVALID_RECEIPT', 'Paragon wymaga 1–500 pozycji.', 400);
  }
  const text = (value, max = 80) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
  const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const nonnegative = value => value === 0 || positive(value);
  const discountOk = discount => !discount || ['AMOUNT', 'PERCENT'].includes(discount.type) && nonnegative(discount.value) &&
    (discount.type !== 'PERCENT' || discount.value <= 100) && (discount.description === undefined || text(discount.description));
  for (const item of receipt.items) {
    if (!item || !text(item.name) || !positive(item.quantity) || !nonnegative(item.unitPrice) || !/^[A-GZ]$/.test(item.vatRate) || !discountOk(item.discount)) {
      throw problem('INVALID_RECEIPT', 'Nieprawidłowa pozycja paragonu.', 400);
    }
  }
  if (!Number.isFinite(receipt.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0))) {
    throw problem('INVALID_RECEIPT', 'Kwota paragonu poza zakresem.', 400);
  }
  if (!discountOk(receipt.discount) || receipt.buyerNip && !/^\d{10}$/.test(receipt.buyerNip)) {
    throw problem('INVALID_RECEIPT', 'Nieprawidłowy rabat lub NIP.', 400);
  }
  if (advanced) {
    if (!Array.isArray(receipt.payments) || !receipt.payments.length || receipt.payments.some(p => !p || !text(p.type, 30) ||
      !nonnegative(p.amount) || p.name !== undefined && !text(p.name))) {
      throw problem('INVALID_RECEIPT', 'Nieprawidłowe płatności.', 400);
    }
  } else if (!receipt.payment || !/^\d+(\.\d{1,2})?$/.test(String(receipt.payment.amountPaid))) {
    throw problem('INVALID_RECEIPT', 'Nieprawidłowa płatność.', 400);
  }
}

function validateMutation(name, args) {
  const visit = value => {
    if (typeof value === 'string' && /[\x00-\x1f\x7f]/.test(value)) throw problem('INVALID_DATA', 'Dane zawierają znaki sterujące.', 400);
    if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(args);
  if (name === 'printTestVoidReceipt') validateReceipt({ ...args[0], payments: [{ type: 'CASH', amount: 0 }] }, true);
  if (['cashDeposit', 'cashWithdrawal'].includes(name) &&
    (!/^\d+(\.\d{1,2})?$/.test(String(args[0])) || !Number.isFinite(Number(args[0])) || Number(args[0]) <= 0)) {
    throw problem('INVALID_DATA', 'Nieprawidłowa kwota.', 400);
  }
  if (name === 'printPeriodicReport') {
    for (const key of ['startDate', 'endDate']) {
      const value = args[0]?.[key];
      const date = new Date(value);
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw problem('INVALID_DATA', 'Nieprawidłowa data raportu.', 400);
      }
    }
  }
}

function outcome(record) {
  return {
    ...(record.result || {}), success: record.state === 'fiscal_confirmed' || record.state === 'completed',
    operation_id: record.id, state: record.state, retryable: record.state === 'not_started',
    ...(record.error ? { error: record.error } : {}),
  };
}

class BrokerService {
  constructor(printer, journal, config = {}) {
    this.raw = printer;
    this.journal = journal;
    this.config = config;
    this.busy = null;
    this.reservations = new PrinterReservations(journal, config.now);
    for (const name of READS) this[name] = (...args) => this.exclusive(name, () => printer[name](...args));
    for (const [name, spec] of Object.entries(COMMANDS)) {
      this[name] = (...args) => {
        const options = args[spec.arity] || {};
        return this.execute(name, args.slice(0, spec.arity), options.operationId, null, options.reservationToken);
      };
    }
  }

  status() {
    return { api_version: 2, busy: this.busy, journalHealthy: this.journal.healthy, blockedOperations: this.journal.blocked(),
      serialPort: this.config.serialPort || null,
      reservation: publicReservation(this.reservations.active()),
      diagnosticsOnly: this.config.diagnosticsOnly === true,
      posReservationRequired: this.config.requirePosReservation === true,
      capabilities: { reservations: true, durableOperations: true },
      onlineOperationsEnabled: this.config.onlineEnabled === true,
      branch_id: this.config.branchId || null, environment: this.config.environment || null,
      printer_unique_number: this.config.printerUniqueNumber || null };
  }

  async exclusive(label, run, access = {}) {
    if (this.busy) throw problem('PRINTER_BUSY', 'Drukarka wykonuje inną operację.');
    this.reservations.authorize(access.token, access.operationId, access.command);
    this.busy = label;
    try { return await run(); } finally { this.busy = null; }
  }

  getOperation(id) {
    validateId(id);
    const record = this.journal.get(id);
    return record?.kind === 'printer_reservation' ? null : record;
  }

  assertWritable() {
    if (this.config.diagnosticsOnly) throw problem('DIAGNOSTICS_ONLY', 'Tryb diagnostyczny blokuje polecenia zmieniające stan drukarki.', 503);
    if (this.busy) throw problem('PRINTER_BUSY', 'Drukarka wykonuje inną operację.');
    if (!this.journal.healthy || this.journal.blocked().length) {
      throw problem('REVIEW_REQUIRED', 'Poprzednia operacja wymaga weryfikacji. Drukowanie jest zablokowane.');
    }
  }

  validateDevice(snapshot, expectedIdentity) {
    if (!snapshot.transaction.fiscal || !snapshot.status.isFiscal) throw new Error('Drukarka nie jest w trybie fiskalnym.');
    if (snapshot.transaction.transactionOpen || snapshot.status.isTransactionOpen) throw new Error('Drukarka ma otwartą transakcję; nie zostanie automatycznie anulowana.');
    if (snapshot.status.lastCommandError) throw new Error(`Drukarka zgłasza poprzedni błąd ${snapshot.status.lastCommandError}.`);
    if (expectedIdentity && snapshot.identity.uniqueNumber !== expectedIdentity) throw new Error('Podłączono inną drukarkę fiskalną.');
  }

  async reservePrinter(request) {
    this.assertWritable();
    validateId(request?.operation_id);
    if (request.operation_id.startsWith('reservation:')) throw problem('INVALID_ID', 'Zastrzeżony prefiks identyfikatora.', 400);
    const spec = Object.entries(COMMANDS).find(([, value]) => value.command === request.command);
    if (!spec) throw problem('INVALID_COMMAND', 'Nieznane polecenie rezerwacji.', 400);
    ttl(request.ttl_ms);
    const existing = this.journal.get(request.operation_id);
    if (existing && (existing.kind !== spec[0] || existing.state !== 'not_started')) {
      throw problem('OPERATION_ALREADY_RECORDED', 'Operacja ma zapisany wynik. Odczytaj /operations/:id przed dalszym działaniem.');
    }
    return this.exclusive(`reserve:${request.operation_id}`, async () => {
      const before = await this.raw.getSnapshot();
      this.validateDevice(before, this.config.printerUniqueNumber);
      return this.reservations.create(request.operation_id, request.command, before.identity.uniqueNumber, request.ttl_ms);
    });
  }

  getReservation(id) { validateId(id); return publicReservation(this.reservations.get(id)); }

  renewReservation(id, token, ttlMs) {
    this.assertWritable();
    if (this.busy) throw problem('PRINTER_BUSY', 'Drukarka wykonuje inną operację.');
    return this.reservations.renew(id, token, ttlMs);
  }

  releaseReservation(id, token) {
    if (this.busy) throw problem('PRINTER_BUSY', 'Drukarka wykonuje inną operację.');
    return this.reservations.release(id, token);
  }

  async submitReceipt(request) {
    if (!this.config.onlineEnabled) throw problem('ONLINE_DISABLED', 'Zlecenia online są wyłączone.', 503);
    if (!this.config.requirePosReservation) throw problem('POS_RESERVATION_NOT_REQUIRED', 'Przed zleceniami online włącz obowiązek rezerwacji dla POS.', 503);
    if (!request || typeof request !== 'object') throw problem('INVALID_DATA', 'Brak danych zlecenia.', 400);
    if (!Number.isInteger(this.config.branchId) || this.config.branchId < 1 || !this.config.environment || !this.config.printerUniqueNumber) {
      throw problem('DEVICE_NOT_CONFIGURED', 'Brak pełnego przypisania stanowiska.', 503);
    }
    if (request.branch_id !== this.config.branchId || request.environment !== this.config.environment ||
      request.printer_unique_number !== this.config.printerUniqueNumber) {
      throw problem('DEVICE_MISMATCH', 'Zlecenie jest przeznaczone dla innego stanowiska.');
    }
    validateId(request.operation_id);
    return this.execute('printAdvancedReceipt', [request.receipt], request.operation_id, {
      branchId: request.branch_id, environment: request.environment, printerUniqueNumber: request.printer_unique_number,
    });
  }

  async execute(name, args, suppliedId, assignment = null, reservationToken) {
    const id = suppliedId === undefined ? `local:${randomUUID()}` : suppliedId;
    validateId(id);
    if (id.startsWith('reservation:')) throw problem('INVALID_ID', 'Zastrzeżony prefiks identyfikatora.', 400);
    if (RECEIPTS.has(name)) validateReceipt(args[0], name === 'printAdvancedReceipt');
    else validateMutation(name, args);
    const payloadHash = hash({ name, args, assignment });
    const previous = this.journal.get(id);
    if (previous && previous.payloadHash !== payloadHash) throw problem('OPERATION_CONFLICT', 'Ten operation_id ma inną treść.');
    // A known result (including unknown) is a read, never another fiscal attempt.
    if (previous && previous.state !== 'not_started') return outcome(previous);
    this.assertWritable();
    if (!assignment && this.config.requirePosReservation && reservationToken === undefined) {
      throw problem('RESERVATION_REQUIRED', 'Najpierw zarezerwuj drukarkę dla tej operacji POS.');
    }
    if (reservationToken !== undefined && suppliedId === undefined) throw problem('OPERATION_ID_REQUIRED', 'Rezerwacja wymaga X-Operation-Id.', 400);
    const command = COMMANDS[name].command;
    return this.exclusive(id, async () => {
      const reservation = this.reservations.authorize(reservationToken, id, command);
      let record = this.journal.save(previous || { id, kind: name, payloadHash, assignment, state: 'not_started', createdAt: new Date().toISOString() });
      let intentSaved = false;
      try {
        if (reservation) {
          this.reservations.consume(reservation);
          record = this.journal.save({ ...record, reservationId: reservation.id });
        }
        const before = await this.raw.getSnapshot();
        const expectedIdentity = reservation?.printerUniqueNumber || assignment?.printerUniqueNumber || this.config.printerUniqueNumber;
        this.validateDevice(before, expectedIdentity);
        // Must reach durable storage BEFORE the first mutation on the device.
        record = this.journal.save({ ...record, before, state: 'in_progress', error: undefined });
        intentSaved = true;
        const hooks = { onFiscalClose: state => {
          record = this.journal.save({ ...record, fiscalCloseAcknowledged: state });
        } };
        const value = await this.raw[name](...args, ...(RECEIPTS.has(name) ? [hooks] : []));
        const after = await this.raw.getSnapshot();
        if (after.identity.uniqueNumber !== before.identity.uniqueNumber || after.transaction.transactionOpen || after.status.isTransactionOpen) {
          throw new Error('Nie można potwierdzić zamknięcia na tej samej drukarce.');
        }
        let result = value && typeof value === 'object' ? value : {};
        if (RECEIPTS.has(name)) {
          if (!after.transaction.transactionOk || !after.status.lastTransactionOk ||
            after.counter.lastDocumentNumber !== before.counter.lastDocumentNumber + 1 ||
            after.status.receiptsSinceDailyReport !== before.status.receiptsSinceDailyReport + 1) {
            throw new Error('Brak jednoznacznego przyrostu numeru dokumentu i licznika fiskalnego.');
          }
          result = { ...result, receipt: {
            documentNumber: after.counter.lastDocumentNumber,
            dailyReceiptNumber: after.status.receiptsSinceDailyReport,
            printerUniqueNumber: after.identity.uniqueNumber,
            printerClockBefore: before.clock, printerClockAfter: after.clock,
            confirmation: 'thermal_status_and_counters',
          } };
        }
        record = this.journal.save({ ...record, after, result, state: RECEIPTS.has(name) ? 'fiscal_confirmed' : 'completed' });
        return outcome(record);
      } catch (error) {
        // A failed durable intent write never permits I/O. A failed result write is never success.
        if (this.journal.healthy) {
          record = this.journal.save({ ...record, state: intentSaved ? 'unknown' : 'not_started', error: error.message,
            failureDetails: { printerError: error.printerError, hardware: error.hardware } });
        }
        throw Object.assign(error, { operation: outcome({ ...record, state: intentSaved ? 'unknown' : 'not_started', error: error.message }), statusCode: 503 });
      }
    }, { token: reservationToken, operationId: id, command });
  }

  async reconcile(id) {
    validateId(id);
    return this.exclusive(`review:${id}`, async () => {
      const record = this.getOperation(id);
      if (!record) throw problem('NOT_FOUND', 'Nieznana operacja.', 404);
      // Evidence only. TRF alone cannot attribute a receipt to this operation.
      const evidence = await this.raw.getSnapshot();
      return this.journal.save({ ...record, reviewEvidence: evidence });
    });
  }
}

module.exports = { BrokerService, validateReceipt, outcome };
