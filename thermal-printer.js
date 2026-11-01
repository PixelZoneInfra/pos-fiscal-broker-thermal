const { frame, bodyOf, parseStatus, parseIdentity, parseCounter, parseClock } = require('./thermal-protocol');

// No serial side effects on import. The broker owns the whole-operation lock.
function createPrinter(transport, { delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {

function calculateChecksum(commandPart) {
  let check = 255;
  for (let i = 0; i < commandPart.length; i++) {
    check = check ^ commandPart[i];
  }
  return check.toString(16).toUpperCase().padStart(2, '0');
}

function sendCommand(command, { expectsResponse = false, report = false } = {}) {
    if (expectsResponse) {
        return transport.request(command, '1#X').then(token => `\x1bP${token.value.toString('binary')}\x1b\\`);
    }
    return transport.command(command, { report });
}

const addDelayToQueue = delay;

function expectTransaction(state, open, finished) {
    if (!state.fiscal || state.transactionOpen !== open || state.transactionOk !== finished) {
        throw new Error('Nieoczekiwany stan transakcji fiskalnej.');
    }
}

async function getSnapshot() {
    const hardware = await transport.hardware();
    const transaction = await transport.enq();
    // Read Pe before any other framed query can change command diagnostics.
    const errorText = bodyOf(await transport.request(frame('#n', false), '1#E'), '1#E');
    if (!/^\d{1,3}$/.test(errorText)) throw new Error('Nieprawidłowy kod błędu drukarki.');
    const lastErrorCode = Number(errorText);
    const identity = parseIdentity(await transport.request(frame('2#v', false), '3#R', true));
    const status = await getParsedStatusInfo();
    const counter = parseCounter(await transport.request(frame('50#s'), '50#X', true));
    const clock = parseClock(await transport.request(frame('#c', false), '1#C'));
    return { hardware, transaction, lastErrorCode, identity, status, counter, clock };
}


// === NOWA, KROKOWA IMPLEMENTACJA ZAAWANSOWANEGO PARAGONU ===

/**
 * Krok A: Finalizuje fiskalną część paragonu.
 */
async function endAdvancedTransactionMain({ total, dsp, discount, buyerNip }) {
    const Pn = 0, Pc = 3, Py = 0, Pkb = 0, Pkz = 0; // Pc=3 to kluczowa zmiana
    const Pns = buyerNip ? 1 : 0;
    const Px = discount?.type === 'PERCENT' ? 1 : (discount?.type === 'AMOUNT' ? 3 : 0);
    const Pdsp = dsp < 0 ? 1 : 0;
    const Pxs = discount?.description ? 1 : 0;
    
    // W tym trybie Pfn i Pg są zerowane, płatności idą osobnymi komendami
    const pParams = [Pn, Pc, Py, Pdsp, Px, Pkb, Pkz, Pns, 0, 1, 0, Pxs].join(';');

    const textPart = ['Kasa 1', 'Kasjer', (buyerNip || ''), (discount?.description || '')].join('\r');
    
    const valuePart = [
        total.toFixed(2),
        Math.abs(dsp).toFixed(2),
        (discount?.value || 0).toFixed(2),
        '0.00', // WPLATA - w tym trybie nieistotna
        '0.00/' // RESZTA - nieistotna
    ].join('/');
    
    const partString = `${pParams}$y${textPart}\r${valuePart}`;

    const part = Buffer.from(partString, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([ Buffer.from('\x1b\x50', 'binary'), part, Buffer.from(checksum, 'binary'), Buffer.from('\x1b\\', 'binary') ]);
    return sendCommand(command, { expectsResponse: false });
}

/**
 * Krok B: Stosuje rabat do całego paragonu (od podsumy).
 * Komenda: [th_trdiscntsubtot]
 */
async function applyDiscount(subtotal, discount) {
    console.log('Stosowanie rabatu na paragonie...');
    let Px = 0;
    if (discount.type === 'PERCENT') Px = 1;
    if (discount.type === 'AMOUNT') Px = 3;

    // === POPRAWKA TUTAJ ===
    // Dodajemy parametr Po=16, aby aktywować własny opis rabatu
    const Po = 16;
    const partString = `${Px};${Po}$Y${subtotal.toFixed(2)}/${discount.value.toFixed(2)}/${discount.description || 'Rabat'}\r`;
    
    const part = Buffer.from(partString, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([
        Buffer.from('\x1b\x50', 'binary'),
        part,
        Buffer.from(checksum, 'binary'),
        Buffer.from('\x1b\\', 'binary')
    ]);
    return sendCommand(command, { expectsResponse: false });
}

/**
 * Krok C: Dodaje linię z informacją o płatności.
 * Komenda: [th_trpayment]
 */
async function addPaymentLine({ type, amount, name }) {
    let pfx;
    switch(type) {
        case 'CASH': pfx = 0; break;
        case 'CARD': pfx = 1; break;
		case 'BON': pfx = 3; break; // <-- DODAJ TĘ LINIJKĘ
        default: pfx = 4;
    }
    const partString = `1;${pfx}$b${amount.toFixed(2)}/${name || type}\r`;
    const part = Buffer.from(partString, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([ Buffer.from('\x1b\x50', 'binary'), part, Buffer.from(checksum, 'binary'), Buffer.from('\x1b\\', 'binary') ]);
    return sendCommand(command, { expectsResponse: false });
}

/**
 * Krok D: OSTATECZNA WERSJA - Finalizuje paragon po wszystkich operacjach.
 * Używa komendy [th_trftrend], która jest poprawnym zakończeniem po [th_trpayment].
 */
async function finalizeReceipt() {
    console.log('Finalizowanie wydruku za pomocą poprawnej komendy [th_trftrend]...');
    // Komenda: ESC P 28;Pc $z <checksum> ESC \
    // Pc=0 oznacza standardowe zakończenie z wysuwem papieru
    const part = Buffer.from('28;0$z', 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([
        Buffer.from('\x1b\x50', 'binary'),
        part,
        Buffer.from(checksum, 'binary'),
        Buffer.from('\x1b\\', 'binary')
    ]);
    return sendCommand(command, { expectsResponse: false });
}


// === NOWA, POPRAWNA IMPLEMENTACJA FINALIZACJI ===

/**
 * Etap A: OSTATECZNA WERSJA - Finalizuje fiskalną część paragonu.
 * Wysyła th_trxend1 ($y) z kluczowym parametrem Pc=3.
 * Ta wersja NIE wysyła ponownie informacji o rabacie, a jedynie potwierdza obliczenia.
 */
async function endFiscalPart({ total, dsp, discount, buyerNip }) {
    console.log('Etap A: Zamykanie części fiskalnej paragonu...');
    const Pn = 0, Pc = 3, Py = 0, Pkb = 0, Pkz = 0;
    const Pns = buyerNip ? 1 : 0;
    const Pdsp = dsp < 0 ? 1 : 0;
    
    // === KLUCZOWA POPRAWKA ===
    // Nie deklarujemy na nowo rabatu (Px=0, Pxs=0), ponieważ został już zastosowany w poprzednim kroku.
    const pParams = [Pn, Pc, Py, Pdsp, 0, Pkb, Pkz, Pns, 0, 0, 0, 0].join(';');
    
    const textPart = ['Kasa 1', 'Kasjer', (buyerNip || '')].join('\r');
    
    const valuePart = [
        total.toFixed(2),
        Math.abs(dsp).toFixed(2),
        '0.00', // RABAT - ustawiony na 0, bo już zastosowany
        '0.00', // WPLATA - nieistotna
        '0.00/' // RESZTA - nieistotna
    ].join('/');

    const partString = `${pParams}$y${textPart}\r${valuePart}`;
    const part = Buffer.from(partString, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([ Buffer.from('\x1b\x50', 'binary'), part, Buffer.from(checksum, 'binary'), Buffer.from('\x1b\\', 'binary') ]);
    const state = await sendCommand(command, { expectsResponse: false });
    expectTransaction(state, false, true);
    return state;
}

/**
 * Etap B: Finalizuje wydruk, drukując płatności i obcinając papier.
 * Wysyła th_trftrend ($z) z parametrem 28.
 */
async function finalizePrintout() {
    console.log('Etap B: Finalizowanie wydruku (płatności i ucięcie)...');
    const part = Buffer.from('28;0$z', 'binary'); // 28;Pc $z
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([ Buffer.from('\x1b\x50', 'binary'), part, Buffer.from(checksum, 'binary'), Buffer.from('\x1b\\', 'binary') ]);
    return sendCommand(command, { expectsResponse: false });
}

/**
 * Główna funkcja sterująca drukowaniem zaawansowanego paragonu.
 */
async function printAdvancedReceipt({ items, payments = [], discount = null, buyerNip = null }, { onFiscalClose = async () => {} } = {}) {
    console.log('--- Rozpoczynanie drukowania ZAAWANSOWANEGO paragonu (metoda dwuetapowa $y + $z) ---');
    
    // Krok 1: Start i Pozycje
    await startTransaction();
    if (buyerNip) await setBuyerNip(buyerNip);
	
    // === KLUCZOWA POPRAWKA TUTAJ ===
    // Obliczamy sumę PRZED rabatem na cały paragon, ale PO rabatach na linie
    let calculatedTotal = 0;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let itemTotal = item.quantity * item.unitPrice;
        // Jeśli pozycja ma rabat, odejmujemy go od sumy
        if (item.discount) {
            if (item.discount.type === 'AMOUNT') {
                itemTotal -= item.discount.value;
            } else if (item.discount.type === 'PERCENT') {
                itemTotal *= (1 - item.discount.value / 100);
            }
        }
        calculatedTotal += itemTotal;
        await addReceiptLine(item, i + 1);
    }
    console.log(`Krok 1/5: Transakcja rozpoczęta, dodano pozycje.`);

    // Krok 2: Rabat
    let finalTotal = calculatedTotal;
    if (discount) {
        await applyDiscount(calculatedTotal, discount);
        if (discount.type === 'PERCENT') finalTotal *= (1 - discount.value / 100);
        else if (discount.type === 'AMOUNT') finalTotal -= discount.value;
        if (finalTotal < 0) finalTotal = 0;
        console.log('Krok 2/4: Rabat został zastosowany.');
    }

    // Krok 3: Płatności
    for (const payment of payments) {
        await addPaymentLine(payment);
    }
    console.log('Krok 3/4: Płatności zostały wysłane.');

    // Krok 4: Finalizacja dwuetapowa
    const amountPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const dsp = finalTotal - amountPaid;
    const fiscalState = await endFiscalPart({ total: finalTotal, dsp, discount, buyerNip });
    await onFiscalClose(fiscalState);
    await finalizePrintout();
    console.log('Krok 4/4: Paragon sfinalizowany (fiskalnie i wydruk).');
    
    return { success: true, message: 'Zaawansowany paragon wysłany do drukarki.', total: finalTotal };
}



async function clearState() {
    console.log('Wysyłanie polecenia [th_trcancel] w celu anulowania otwartej transakcji...');
    const part = Buffer.from('0$e', 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([ Buffer.from('\x1b\x50', 'binary'), part, Buffer.from(checksum, 'binary'), Buffer.from('\x1b\\', 'binary') ]);
    await sendCommand(command, { expectsResponse: false });
    console.log('Oczekiwanie 500ms po anulowaniu...');
    await addDelayToQueue(500);
}

async function startTransaction() {
    const part = Buffer.from('0$h', 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([ Buffer.from('\x1b\x50', 'binary'), part, Buffer.from(checksum, 'binary'), Buffer.from('\x1b\\', 'binary') ]);
    const state = await sendCommand(command);
    expectTransaction(state, true, false);
    return state;
}

/**
 * OSTATECZNA WERSJA: Dodaje linię paragonu z opcjonalną obsługą rabatu na pozycję.
 * Komenda: [th_trline]
 */
async function addReceiptLine(item, lineNumber) {
    const { name, quantity, vatRate, unitPrice, discount } = item;
    
    // BRUTTO to zawsze cena przed jakimkolwiek rabatem
    const brutto = (quantity * unitPrice).toFixed(2);
    let commandPart;

    if (discount && discount.value > 0) {
        // --- SCENARIUSZ Z RABATEM NA POZYCJĘ ---
        console.log(`Dodawanie pozycji #${lineNumber} z rabatem: ${name}`);
        
        let Pr = 0; // Rodzaj rabatu
        if (discount.type === 'PERCENT') Pr = 2;
        if (discount.type === 'AMOUNT') Pr = 1;

        // Używamy Po=16, aby móc wysłać własny opis rabatu
        const Po = 16;
        const discountDescription = discount.description || 'Rabat';
        
        // Format: Pi;Pr;Po$l<nazwa>CR<ilość>CR<ptu>/CENA/BRUTTO/RABAT/<OPIS RABATU>CR
        commandPart = `${lineNumber};${Pr};${Po}$l${name}\r${quantity}\r${vatRate}/${unitPrice}/${brutto}/${discount.value.toFixed(2)}/${discountDescription}\r`;

    } else {
        // --- SCENARIUSZ STANDARDOWY (BEZ ZMIAN) ---
        // Format: Pi$l<nazwa>CR<ilość>CR<ptu>/CENA/BRUTTO/
        commandPart = `${lineNumber}$l${name}\r${quantity}\r${vatRate}/${unitPrice}/${brutto}/`;
    }
    
    const part = Buffer.from(commandPart, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([
        Buffer.from('\x1b\x50', 'binary'),
        part,
        Buffer.from(checksum, 'binary'),
        Buffer.from('\x1b\\', 'binary')
    ]);
    
    return sendCommand(command);
}


async function endTransaction({ amountPaid, total }) {
    const part = Buffer.from(`1;0$e001\r${amountPaid}/${total}/`, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([ Buffer.from('\x1b\x50', 'binary'), part, Buffer.from(checksum, 'binary'), Buffer.from('\x1b\\', 'binary') ]);
    const state = await sendCommand(command);
    expectTransaction(state, false, true);
    return state;
}

/**
 * Wysyła do drukarki NIP nabywcy w trakcie otwartej transakcji.
 * Komenda: [th_trnipset]
 */
async function setBuyerNip(nip) {
    console.log(`Dodawanie NIP nabywcy: ${nip}`);
    // Pw=1 oznacza wydruk wyróżniony
    const part = Buffer.from(`1$N${nip}\r`, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([
        Buffer.from('\x1b\x50', 'binary'),
        part,
        Buffer.from(checksum, 'binary'),
        Buffer.from('\x1b\\', 'binary')
    ]);
    return sendCommand(command, { expectsResponse: false });
}

// Zmodyfikowana funkcja printReceipt
async function printReceipt({ items, payment, buyerNip }, { onFiscalClose = async () => {} } = {}) {
    console.log('--- Rozpoczynanie drukowania paragonu ---');
    
    await startTransaction();
    console.log('Krok 1/4: Transakcja rozpoczęta.');

    // KROK 2: Jeśli podano NIP, wysyłamy go teraz
    if (buyerNip) {
        await setBuyerNip(buyerNip);
        console.log('Krok 2/4: NIP nabywcy został wysłany.');
    }

    let calculatedTotal = 0;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const lineNumber = i + 1;
        calculatedTotal += item.quantity * item.unitPrice;
        await addReceiptLine(item, lineNumber);
        console.log(`Krok 3/4: Dodano pozycję #${lineNumber}: ${item.name}`);
    }

    const total = calculatedTotal.toFixed(2);
    const fiscalState = await endTransaction({ amountPaid: payment.amountPaid, total });
    await onFiscalClose(fiscalState);
    console.log('Krok 4/4: Transakcja zakończona.');
    
    return { success: true, message: 'Paragon wysłany do drukarki.', total };
}


/**
 * Drukuje pełny paragon testowy, który na końcu zawsze jest ANULOWANY.
 * Idealne do testowania logiki POS bez konsekwencji fiskalnych.
 */
async function printTestVoidReceipt({ items }) {
    console.log('--- Rozpoczynanie drukowania paragonu testowego (anulowanego) ---');
    
    await clearState();
    await startTransaction();
    console.log('Krok 1/3 (Test): Transakcja rozpoczęta.');

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const lineNumber = i + 1;
        await addReceiptLine(item, lineNumber);
        console.log(`Krok 2/3 (Test): Dodano pozycję #${lineNumber}: ${item.name}`);
    }

    await voidCurrentTransaction();
    console.log('Krok 3/3 (Test): Transakcja ANULOWANA.');
    
    return { success: true, message: 'Paragon testowy (anulowany) wysłany do drukarki.' };
}



/**
 * Drukuje raport dobowy (zerujący).
 * Komenda: [th_dailyrep]
 * Używa wariantu z automatycznym podaniem daty, aby uniknąć konieczności potwierdzania na klawiaturze drukarki.
 */
async function printDailyReport({ cashier, cashRegister } = {}) {
    console.log('Wysyłanie polecenia wydruku raportu dobowego...');
    
    const now = new Date();
    const year = now.getFullYear() % 100; // Dwie ostatnie cyfry roku
    const month = now.getMonth() + 1;      // Miesiące są od 0 do 11
    const day = now.getDate();

    // Budujemy część polecenia, która podlega sumie kontrolnej
    // Format: 1;Py;Pm;Pd#r[<nr_kasy>CR<kasjer>CR]
    let partString = `1;${year};${month};${day}#r`;
    if (cashRegister && cashier) {
        partString += `${cashRegister}\r${cashier}\r`;
    }
    
    const part = Buffer.from(partString, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([
        Buffer.from('\x1b\x50', 'binary'),
        part,
        Buffer.from(checksum, 'binary'),
        Buffer.from('\x1b\\', 'binary')
    ]);

    return sendCommand(command, { report: true });
}

/**
 * Drukuje pełny raport okresowy dla zadanego przedziału dat.
 * Komenda: [th_periodicrep]
 */
async function printPeriodicReport({ startDate, endDate, cashier, cashRegister }) {
    console.log(`Wysyłanie polecenia wydruku raportu okresowego od ${startDate} do ${endDate}...`);

    const start = new Date(startDate);
    const end = new Date(endDate);

    const py1 = start.getFullYear() % 100;
    const pm1 = start.getMonth() + 1;
    const pd1 = start.getDate();

    const py2 = end.getFullYear() % 100;
    const pm2 = end.getMonth() + 1;
    const pd2 = end.getDate();

    let partString = `${py1};${pm1};${pd1};${py2};${pm2};${pd2};0#o`;
    if (cashRegister && cashier) {
        partString += `${cashRegister}\r${cashier}\r`;
    }

    const part = Buffer.from(partString, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([
        Buffer.from('\x1b\x50', 'binary'),
        part,
        Buffer.from(checksum, 'binary'),
        Buffer.from('\x1b\\', 'binary')
    ]);

    return sendCommand(command, { report: true });
}

/**
 * Anuluje bieżącą, otwartą transakcję, drukując paragon "ANULOWANY".
 * Komenda: [th_trcancel]
 * UWAGA: Ta funkcja zakłada, że transakcja została już rozpoczęta!
 */
async function voidCurrentTransaction() {
    console.log('Wysyłanie polecenia anulowania bieżącej transakcji...');
    const part = Buffer.from('0$e', 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([
        Buffer.from('\x1b\x50', 'binary'),
        part,
        Buffer.from(checksum, 'binary'),
        Buffer.from('\x1b\\', 'binary')
    ]);
    return sendCommand(command, { expectsResponse: false });
}

/**
 * Drukuje niefiskalną kopię ostatniego sfinalizowanego paragonu.
 * Komenda: [th_nfbill]
 */
async function reprintLastReceipt() {
    console.log('Wysyłanie polecenia ponownego wydruku ostatniego paragonu...');
    const part = Buffer.from('1#H', 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([
        Buffer.from('\x1b\x50', 'binary'),
        part,
        Buffer.from(checksum, 'binary'),
        Buffer.from('\x1b\\', 'binary')
    ]);
    return sendCommand(command, { expectsResponse: false });
}

/**
 * POPRAWIONA WERSJA: Odczytuje informacje kasowe i parsuje z nich aktualny stan gotówki w kasie.
 * Komenda: [th_scinfo]
 * @returns {Promise<number>} Zwraca stan kasy jako liczba.
 */
async function getCashDrawerState() {
    return (await getParsedStatusInfo()).cashInDrawer;
}

async function getParsedStatusInfo() {
    return parseStatus(await transport.request(frame('23#s'), '2#X', true));
}

/**
 * OSTATECZNA WERSJA: Wysyła poprawną komendę [th_dspdrw] bez sumy kontrolnej,
 * zgodnie ze specyfikacją protokołu Thermal.
 */
async function openCashDrawer() {
    console.log('Wysyłanie poprawnej komendy [th_dspdrw] otwarcia szuflady...');
    
    // Zgodnie ze specyfikacją: ESC P 1 $d ESC \
    // Ta komenda nie wymaga sumy kontrolnej.
    const command = Buffer.from([
        0x1b, 0x50, // ESC P
        0x31,       // Ps = 1 (otwarcie szuflady)
        0x24, 0x64, // Identyfikator komendy: $d
        0x1b, 0x5c  // Terminator: ESC \
    ]);
    
    return sendCommand(command);
}

async function login(cashier, cashRegister) {
    const part = Buffer.from(`0#p${cashier}\r${cashRegister}\r`, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([ Buffer.from('\x1b\x50', 'binary'), part, Buffer.from(checksum, 'binary'), Buffer.from('\x1b\\', 'binary') ]);
    return sendCommand(command);
}

async function logout(cashier, cashRegister) {
    const part = Buffer.from(`0#q${cashier}\r${cashRegister}\r`, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([ Buffer.from('\x1b\x50', 'binary'), part, Buffer.from(checksum, 'binary'), Buffer.from('\x1b\\', 'binary') ]);
    return sendCommand(command);
}

async function cashDeposit(amount) {
    const part = Buffer.from(`0#i${amount}/`, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([ Buffer.from('\x1b\x50', 'binary'), part, Buffer.from(checksum, 'binary'), Buffer.from('\x1b\\', 'binary') ]);
    return sendCommand(command);
}

async function cashWithdrawal(amount) {
    const part = Buffer.from(`0#d${amount}/`, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([ Buffer.from('\x1b\x50', 'binary'), part, Buffer.from(checksum, 'binary'), Buffer.from('\x1b\\', 'binary') ]);
    return sendCommand(command);
}

async function getCashDrawerStateReport() {
    const part = Buffer.from('0#t', 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([ Buffer.from('\x1b\x50', 'binary'), part, Buffer.from(checksum, 'binary'), Buffer.from('\x1b\\', 'binary') ]);
    return sendCommand(command);
}

async function printVoidedReceipt() {
    const part = Buffer.from('0$e', 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([ Buffer.from('\x1b\x50', 'binary'), part, Buffer.from(checksum, 'binary'), Buffer.from('\x1b\\', 'binary') ]);
    return sendCommand(command);
}

async function getStatusInfo() {
    const command = Buffer.from([0x1b, 0x50, 0x23, 0x73, 0x1b, 0x5c]);
    return sendCommand(command, { expectsResponse: true });
}



return {
  getSnapshot,
  async printVoidDocument() {
    await clearState();
    await startTransaction();
    return voidCurrentTransaction();
  },
  login,
  logout,
  cashDeposit,
  cashWithdrawal,
  getCashDrawerStateReport,
  printVoidedReceipt,
  getStatusInfo,
  printReceipt,
  setBuyerNip,
  clearState,
  startTransaction, // Do testów
  printDailyReport,
  printPeriodicReport,
  voidCurrentTransaction,
  printTestVoidReceipt,
  reprintLastReceipt,
  getCashDrawerState,
  printAdvancedReceipt,
  getParsedStatusInfo,
  openCashDrawer
};

}

module.exports = { createPrinter };
