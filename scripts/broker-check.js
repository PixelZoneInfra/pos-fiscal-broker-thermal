// Explicit operator actions only. Default: five read-only endpoints, no retries.
const { parseArgs } = require('node:util');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { API_CASES } = require('../api-catalog');

function check(condition, message) { if (!condition) throw new Error(message); }
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, /^(token|tokenHash)$/i.test(key) ? '[redacted]' : redact(item)]));
  return value;
}

async function run(options, output = console.log) {
  const report = { startedAt: new Date().toISOString(), mode: options.mode || 'diagnostics', case: options.case, steps: [] };
  try {
    const base = new URL(options.url || 'http://127.0.0.1:3030');
    check(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && !base.username && !base.password &&
      base.pathname === '/' && !base.search && !base.hash, 'Dozwolone jest wyłącznie lokalne API HTTP brokera.');
    const send = async (method, route, body, headers = {}) => {
      const response = await fetch(new URL(route, base), { method, headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(135000) });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`HTTP ${response.status}: odpowiedź nie jest JSON. Sprawdź wersję i port brokera.`); }
      const result = { status: response.status, body: data };
      report.steps.push({ method, route, ...redact(result) });
      return result;
    };
    const status = await send('GET', '/broker/status');
    check(status.status === 200 && status.body.api_version === 2 && status.body.capabilities?.reservations === true,
      'To nie jest kompletna wersja brokera z rezerwacjami. Nie wysłano poleceń urządzenia.');
    const inspect = ['operation', 'reservation', 'broker-status', 'reconcile'].includes(options.case);
    if (!inspect) check(status.body.journalHealthy && status.body.blockedOperations?.length === 0 && !status.body.busy,
      'Broker jest zajęty albo wymaga wyjaśnienia poprzedniej operacji. Przerwij test; zapis można odczytać przez --case operation --id ID.');

    if (options.mode === 'reservations') {
      check(!options.case, 'Nie łącz --mode reservations z --case.');
      check(!status.body.diagnosticsOnly && !status.body.onlineOperationsEnabled && !status.body.reservation,
        'Test rezerwacji wymaga trybu POS z wyłączonym online, zamkniętych klientów i wolnej drukarki.');
      let lease;
      try {
        const grant = await send('POST', '/printer/reservations', { operation_id: `probe:${randomUUID()}`, command: 'receipt-advanced' });
        check(grant.status === 201, 'Nie udało się zarezerwować drukarki.');
        lease = grant.body;
        const headers = { 'X-Printer-Reservation-Token': lease.token };
        const publicRecord = await send('GET', `/printer/reservations/${encodeURIComponent(lease.id)}`);
        check(publicRecord.body.state === 'reserved' && !publicRecord.body.token && !publicRecord.body.tokenHash, 'Nieprawidłowy publiczny stan rezerwacji.');
        const second = await send('POST', '/printer/reservations', { operation_id: `probe:${randomUUID()}`, command: 'receipt' });
        check(second.status === 409 && second.body.code === 'PRINTER_RESERVED', 'Druga rezerwacja nie została zablokowana.');
        const diagnostics = await send('GET', '/device/diagnostics');
        check(diagnostics.status === 409 && diagnostics.body.code === 'PRINTER_RESERVED', 'Odczyt USB nie respektuje rezerwacji.');
        const wrong = await send('POST', `/printer/reservations/${encodeURIComponent(lease.id)}/renew`, {}, { 'X-Printer-Reservation-Token': 'x'.repeat(43) });
        check(wrong.status === 403, 'Nieprawidłowy token odnowił rezerwację.');
        check((await send('POST', `/printer/reservations/${encodeURIComponent(lease.id)}/renew`, { ttl_ms: 60000 }, headers)).status === 200, 'Nie udało się odnowić rezerwacji.');
        check((await send('POST', `/printer/reservations/${encodeURIComponent(lease.id)}/release`, {}, headers)).body.state === 'released', 'Nie udało się zwolnić rezerwacji.');
        lease = null;
        const short = await send('POST', '/printer/reservations', { operation_id: `probe:${randomUUID()}`, command: 'receipt', ttl_ms: 1000 });
        check(short.status === 201, 'Nie udało się utworzyć krótkiej rezerwacji.');
        lease = short.body;
        await new Promise(resolve => setTimeout(resolve, 1150));
        check((await send('GET', `/printer/reservations/${encodeURIComponent(lease.id)}`)).body.state === 'expired', 'Nieużywana rezerwacja nie wygasła.');
        lease = null;
      } finally {
        if (lease) await send('POST', `/printer/reservations/${encodeURIComponent(lease.id)}/release`, {}, { 'X-Printer-Reservation-Token': lease.token });
      }
    } else if (options.case) {
      check(!options.mode || options.mode === 'diagnostics', 'Nieznany tryb.');
      const entry = API_CASES.find(item => item.id === options.case);
      check(entry, 'Nieznany --case. Użyj --list.');
      check(!entry.id.startsWith('reservation-'), 'Do testów sterowania rezerwacją użyj --mode reservations.');
      const deviceAction = ['fiscal', 'cash', 'device', 'daily', 'disabled'].includes(entry.effect);
      if (deviceAction) {
        check(options['allow-device-action'] === true, 'Polecenie może drukować lub zmienić kasę. Wymagane --allow-device-action.');
        check(!status.body.diagnosticsOnly, 'Wyłącz tryb diagnostyczny dopiero przed uzgodnionym testem urządzenia.');
        check(typeof options['operation-id'] === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(options['operation-id']), 'Podaj stałe --operation-id tej jednej próby.');
      }
      if (entry.effect === 'daily') check(options['allow-daily-report'] === true, 'Raport dobowy wykonaj przy rzeczywistym zamknięciu dnia; wymagane --allow-daily-report.');
      check(!entry.path.includes(':id') || options.id, 'Podaj --id odczytywanej operacji.');
      let body = options.payload ? JSON.parse(fs.readFileSync(options.payload, 'utf8').replace(/^\uFEFF/, '')) : undefined;
      check(!entry.body || body && typeof body === 'object', 'Podaj --payload ze świadomie przygotowanym JSON.');
      const operationId = options['operation-id'];
      const headers = operationId ? { 'X-Operation-Id': operationId } : {};
      let cached = false;
      if (deviceAction && entry.effect !== 'disabled') {
        if (entry.id === 'online-receipt') {
          check(!body.operation_id || body.operation_id === operationId, 'ID w JSON różni się od --operation-id.');
          body.operation_id = operationId;
        }
        const known = await send('GET', `/operations/${encodeURIComponent(operationId)}`);
        check([200, 404].includes(known.status), 'Nie można ustalić poprzedniego wyniku. Nie ponawiaj wydruku.');
        if (known.status === 200 && known.body.state !== 'not_started') {
          check(['fiscal_confirmed', 'completed'].includes(known.body.state), `STOP: zapisany stan ${known.body.state}; nie wysłano ponownie polecenia.`);
          cached = true;
          report.cached = true;
          output('Wynik jest zapisany. Broker porówna treść żądania i zwróci wynik bez ponownego wydruku.');
        }
        if (options.reserve && !cached) {
          check(entry.command, 'Zlecenie online nie używa rezerwacji POS.');
          const grant = await send('POST', '/printer/reservations', { operation_id: operationId, command: entry.command });
          check(grant.status === 201, 'Nie przyznano rezerwacji. Nie wysłano polecenia urządzenia.');
          headers['X-Printer-Reservation-Token'] = grant.body.token;
        }
      }
      const route = entry.path.replace(':id', encodeURIComponent(options.id || ''));
      const result = await send(entry.method, route, entry.method === 'POST' ? body || {} : undefined, headers);
      check(entry.effect === 'disabled' ? result.status === 410 : result.status === 200, `HTTP ${result.status}: ${result.body.error || result.body.message || result.body.code}`);
      if (deviceAction && entry.effect !== 'disabled') check(result.body.success === true, `Wynik ${result.body.state || 'nieznany'}; nie ponawiaj automatycznie.`);
    } else {
      check(!options.mode || options.mode === 'diagnostics', 'Nieznany tryb.');
      for (const entry of API_CASES.filter(item => item.effect === 'read' && !item.path.includes(':id') && item.id !== 'broker-status')) {
        check((await send(entry.method, entry.path)).status === 200, `Nieprawidłowy odczyt ${entry.path}.`);
      }
    }
    report.success = true;
    output('Odczyty/odpowiedzi HTTP zgodne. Wydruk i zgodność z urządzeniem potwierdza operator.');
  } catch (error) {
    report.success = false;
    report.error = error.message;
    output(`STOP: ${error.message}`);
  } finally { report.finishedAt = new Date().toISOString(); }
  return report;
}

async function main() {
  const { values } = parseArgs({ options: {
    ...Object.fromEntries(['url', 'mode', 'case', 'payload', 'operation-id', 'id', 'report'].map(key => [key, { type: 'string' }])),
    ...Object.fromEntries(['reserve', 'allow-device-action', 'allow-daily-report', 'list'].map(key => [key, { type: 'boolean' }])),
  } });
  if (values.list) { console.table(API_CASES); return; }
  const report = await run(values);
  const filename = values.report || path.join('local-results', `broker-${Date.now()}-${randomUUID()}.json`);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, JSON.stringify(redact(report), null, 2) + '\n', { mode: 0o600 });
  console.log(`Wynik lokalny: ${path.resolve(filename)}`);
  if (!report.success) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run, redact };
