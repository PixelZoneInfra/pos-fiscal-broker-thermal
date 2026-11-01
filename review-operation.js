// Local operator tool. It cannot print or connect to USB. Stop Electron first.
const { parseArgs } = require('node:util');
const { OperationJournal } = require('./operation-journal');

function review(journal, options) {
  const record = journal.get(options.id);
  if (!record || record.state !== 'unknown') throw new Error('Weryfikacja dotyczy wyłącznie operacji unknown.');
  if (!options.actor?.trim() || !options.evidence?.trim()) throw new Error('Wymagane --actor i --evidence.');
  if (!['fiscal_confirmed', 'not_fiscalized', 'completed'].includes(options.decision)) throw new Error('Nieprawidłowa decyzja.');
  const isReceipt = ['printReceipt', 'printAdvancedReceipt'].includes(record.kind);
  if (options.decision === 'completed' && isReceipt || options.decision === 'fiscal_confirmed' && !isReceipt) {
    throw new Error('Decyzja nie pasuje do rodzaju operacji.');
  }
  let result = record.result || {};
  if (options.decision === 'fiscal_confirmed') {
    const date = new Date(options.date);
    if (!/^[1-9]\d*$/.test(options.document || '') || !Number.isSafeInteger(Number(options.document)) || !options.printer ||
      !/^\d{4}-\d{2}-\d{2}$/.test(options.date || '') || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== options.date) {
      throw new Error('Wymagane dane z rzeczywistego dokumentu: --document, --printer i --date.');
    }
    if (options.printer !== record.before?.identity?.uniqueNumber) throw new Error('Numer drukarki nie pasuje do zapisanego zamiaru.');
    result = { ...result, receipt: { documentNumber: Number(options.document), printerUniqueNumber: options.printer, fiscalDate: options.date, confirmation: 'operator_review' } };
  }
  if (options['device-closed'] !== true) throw new Error('Potwierdź zamkniętą transakcję na drukarce przez --device-closed.');
  return journal.save({ ...record, result, state: options.decision, error: undefined,
    review: { actor: options.actor, evidence: options.evidence, decision: options.decision, at: new Date().toISOString(), deviceClosed: true } });
}

if (require.main === module) {
  let journal;
  try {
    const { values } = parseArgs({ options: {
      ...Object.fromEntries(['directory', 'id', 'actor', 'evidence', 'decision', 'document', 'printer', 'date'].map(name => [name, { type: 'string' }])),
      'device-closed': { type: 'boolean' },
    } });
    if (!values.directory) throw new Error('Podaj --directory z katalogiem fiscal-operations brokera.');
    journal = new OperationJournal(values.directory);
    console.log(JSON.stringify(review(journal, values), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { journal?.close(); }
}

module.exports = { review };
