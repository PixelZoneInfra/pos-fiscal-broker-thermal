const { hash } = require('./operation-journal');

const COPY_KIND = 'reprintLastReceipt';
const RESOLUTION_TYPE = 'failed_reprint_closed';

function unchangedCopy(before, after) {
  const deny = reason => ({ can_close: false, reason });
  if (!before?.identity?.uniqueNumber || after?.identity?.uniqueNumber !== before.identity.uniqueNumber) {
    return deny('Podłącz tę samą drukarkę, na której rozpoczęto próbę kopii.');
  }
  if (before.transaction?.transactionOpen !== false || before.status?.isTransactionOpen !== false ||
      after.transaction?.transactionOpen !== false || after.status?.isTransactionOpen !== false) {
    return deny('Drukarka ma otwartą transakcję albo nie potwierdzono jej zamknięcia.');
  }
  if (after.hardware?.online !== true || after.hardware.paperOrBatteryError !== false || after.hardware.mechanismError !== false ||
      after.transaction.fiscal !== true || after.status.isFiscal !== true) {
    return deny('Najpierw przywróć gotowość drukarki i ponownie sprawdź stan.');
  }
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  if (!integer(before.counter?.lastDocumentNumber) || after.counter?.lastDocumentNumber !== before.counter.lastDocumentNumber ||
      !integer(before.status?.receiptsSinceDailyReport) || after.status.receiptsSinceDailyReport !== before.status.receiptsSinceDailyReport ||
      !integer(before.status.ramResets) || after.status.ramResets !== before.status.ramResets) {
    return deny('Liczniki drukarki zmieniły się. Ta próba wymaga pomocy kierownika.');
  }
  if (!before.status.dailyTotals || !after.status.dailyTotals ||
      Object.keys(before.status.dailyTotals).length !== 7 || Object.keys(after.status.dailyTotals).length !== 7 ||
      ![...Object.values(before.status.dailyTotals), ...Object.values(after.status.dailyTotals)].every(Number.isFinite) ||
      hash(before.status.dailyTotals) !== hash(after.status.dailyTotals) ||
      !Number.isFinite(before.status.cashInDrawer) || after.status.cashInDrawer !== before.status.cashInDrawer) {
    return deny('Kwoty na drukarce zmieniły się albo brak pełnych danych. Potrzebna jest weryfikacja kierownika.');
  }
  if (![0, 115].includes(after.lastErrorCode) || ![0, 115].includes(after.status.lastCommandError)) {
    return deny('Drukarka zgłasza inny błąd. Wyjaśnij go przed zamknięciem próby kopii.');
  }
  return { can_close: true, reason: 'Ta sama drukarka, zamknięta transakcja oraz niezmienione liczniki i kwoty.' };
}

function copyRecovery(record, snapshot = record?.reviewEvidence) {
  if (record?.kind !== COPY_KIND) return null;
  const printerError = record.failureDetails?.printerError || record.failureDetails?.observedPrinterError || snapshot?.lastErrorCode || null;
  if (record.state === 'not_started') return { can_close: true, can_retry: true, printer_error: printerError, reason: 'Polecenie kopii nie zostało wysłane do drukarki.' };
  if (record.state !== 'unknown') return { can_close: false, can_retry: false, printer_error: printerError, reason: 'Ta próba nie wymaga zamknięcia albo nadal trwa.' };
  if (!snapshot) return { can_close: false, can_retry: false, printer_error: printerError, reason: 'Najpierw sprawdź aktualny stan drukarki.' };
  return { ...unchangedCopy(record.before, snapshot), can_retry: false, printer_error: printerError };
}

function closeCopyRecord(record, snapshot, actor, automatic = false, printerUniqueNumber = record.before?.identity?.uniqueNumber) {
  return { ...record, state: 'cancelled', ...(snapshot ? { after: snapshot } : {}),
    resolution: { type: RESOLUTION_TYPE, actor, at: new Date().toISOString(), automatic,
      printerUniqueNumber, deviceClosed: Boolean(snapshot), notStarted: record.state === 'not_started',
      reason: automatic ? 'Drukarka odrzuciła kopię kodem 115; odczyty potwierdzają brak zmian.'
        : 'Operator zamknął próbę kopii bez ponownego wydruku; sprawdzono brak skutków fiskalnych.' } };
}

module.exports = { COPY_KIND, RESOLUTION_TYPE, unchangedCopy, copyRecovery, closeCopyRecord };
