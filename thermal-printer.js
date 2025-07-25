const { SerialPort } = require('serialport');

const port = new SerialPort({
  path: 'COM3',
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  autoOpen: false, 
});

const commandQueue = [];
let isProcessing = false;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

port.open((err) => {
  if (err) return console.error('❌ Błąd otwierania portu COM3:', err.message);
  console.log('✅ Połączenie z portem COM3 otwarte.');
  processQueue();
});

port.on('error', (err) => {
  console.error('❌ Błąd portu szeregowego:', err.message);
});

function calculateChecksum(commandPart) {
  let check = 255;
  for (let i = 0; i < commandPart.length; i++) {
    check = check ^ commandPart[i];
  }
  return check.toString(16).toUpperCase().padStart(2, '0');
}

async function processQueue() {
    if (isProcessing || commandQueue.length === 0) return;
    isProcessing = true;
    const task = commandQueue.shift();
    try {
        if (task.type === 'delay') {
            await delay(task.duration);
            task.resolve();
        } else {
            const response = await executeCommand(task.command, task.expectsResponse);
            task.resolve(response);
        }
    } catch (error) {
        // Teraz to zadziała, bo każdy task ma .reject
        task.reject(error);
    } finally {
        isProcessing = false;
        processQueue();
    }
}

function executeCommand(command, expectsResponse) {
  return new Promise((resolve, reject) => {
    // Ta funkcja jest wywoływana tylko dla poleceń, które OCZEKUJĄ odpowiedzi
    const onData = (chunk) => {
        port.removeListener('data', onData);
        clearTimeout(timeoutId);
        console.log(`Otrzymano odpowiedź (hex): ${chunk.toString('hex')}`);
        // === KLUCZOWA POPRAWKA TUTAJ ===
        // Zwracamy faktyczne dane, a nie ogólny komunikat
        resolve(chunk.toString('binary')); 
    };

    const timeoutId = setTimeout(() => {
        port.removeListener('data', onData);
        reject(new Error('Timeout: Drukarka nie odpowiedziała.'));
    }, 5000);

    port.on('data', onData);
    
    port.write(command, (err) => {
      if (err) {
        port.removeListener('data', onData);
        clearTimeout(timeoutId);
        return reject(new Error(`Błąd zapisu do portu: ${err.message}`));
      }
      console.log('Wysłano polecenie (hex):', command.toString('hex'));
    });
  });
}

// Uproszczona funkcja do wysyłania - teraz wszystkie polecenia przechodzą przez kolejkę
function sendCommand(command, { expectsResponse = false } = {}) {
  return new Promise(async (resolve, reject) => {
      // Dla poleceń bez odpowiedzi, po prostu wysyłamy i kończymy
      if (!expectsResponse) {
          port.write(command, (err) => {
              if (err) return reject(new Error(`Błąd zapisu do portu: ${err.message}`));
              console.log('Wysłano polecenie (hex):', command.toString('hex'));
              resolve('Polecenie wysłane pomyślnie.');
          });
      } else {
          // Dla poleceń z odpowiedzią, używamy kolejki
          commandQueue.push({ command, expectsResponse, resolve, reject });
          if (!isProcessing) processQueue();
      }
  });
}

// POPRAWKA: Teraz dodajemy też `reject`
function addDelayToQueue(duration) {
    return new Promise((resolve, reject) => {
        commandQueue.push({ type: 'delay', duration, resolve, reject });
        if (!isProcessing) processQueue();
    });
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
    return sendCommand(command);
}

async function addReceiptLine(item, lineNumber) {
    const { name, quantity, vatRate, unitPrice } = item;
    const lineTotal = (quantity * unitPrice).toFixed(2);
    const part = Buffer.from(`${lineNumber}$l${name}\r${quantity}\r${vatRate}/${unitPrice}/${lineTotal}/`, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([ Buffer.from('\x1b\x50', 'binary'), part, Buffer.from(checksum, 'binary'), Buffer.from('\x1b\\', 'binary') ]);
    return sendCommand(command);
}

async function endTransaction({ amountPaid, total }) {
    const part = Buffer.from(`1;0$e001\r${amountPaid}/${total}/`, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([ Buffer.from('\x1b\x50', 'binary'), part, Buffer.from(checksum, 'binary'), Buffer.from('\x1b\\', 'binary') ]);
    return sendCommand(command);
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
async function printReceipt({ items, payment, buyerNip }) { // Dodano parametr buyerNip
    console.log('--- Rozpoczynanie drukowania paragonu ---');
    await clearState();
    
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
    await endTransaction({ amountPaid: payment.amountPaid, total });
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

    // Raport dobowy to długa operacja, nie oczekujemy bezpośredniej odpowiedzi
    return sendCommand(command, { expectsResponse: false });
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

    return sendCommand(command, { expectsResponse: false });
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
    console.log('Wysyłanie polecenia odczytu informacji kasowych...');
    const command = Buffer.from([0x1b, 0x50, 0x23, 0x73, 0x1b, 0x5c]);
    const rawResponse = await sendCommand(command, { expectsResponse: true });

    try {
        // Nowa, bezpieczna metoda parsowania
        const parts = rawResponse.split('/');
        if (parts.length < 3) { // Muszą być co najmniej 3 części: ... / CASH / num_id
            throw new Error('Odpowiedź ma nieoczekiwaną strukturę (za mało części).');
        }
        
        // Pole CASH jest zawsze przedostatnie
        const cashValueString = parts[parts.length - 2].trim();
        const cashValue = parseFloat(cashValueString);

        if (isNaN(cashValue)) {
            throw new Error(`Nie udało się sparsować wartości gotówki. Otrzymano: "${cashValueString}"`);
        }
        
        console.log(`Odczytano stan kasy: ${cashValue}`);
        return cashValue;
    } catch (error) {
        console.error('Błąd parsowania odpowiedzi [th_scinfo]:', error);
        console.error('Surowa odpowiedź, która spowodowała błąd:', rawResponse);
        throw new Error('Otrzymano nieprawidłowy format odpowiedzi od drukarki.');
    }
}


/**
 * POPRAWIONA WERSJA 3: Odczytuje i PARSUJE informacje kasowe do czytelnego obiektu JSON.
 */
async function getParsedStatusInfo() {
    console.log('Wysyłanie polecenia odczytu i parsowania informacji kasowych...');
    const command = Buffer.from([0x1b, 0x50, 0x23, 0x73, 0x1b, 0x5c]);
    const rawResponse = await sendCommand(command, { expectsResponse: true });

    try {
        const cleanResponse = rawResponse.replace(/^.*?#X/, '').replace(/\x1b\\$/, '');
        const parts = cleanResponse.split('/');
        
        if (parts.length < 4) {
            throw new Error('Odpowiedź ma nieoczekiwaną strukturę.');
        }

        const flags = parts[0].split(';');
        
        let ratesEndIndex = 1;
        while (parts[ratesEndIndex] && parts[ratesEndIndex].includes('.')) {
            ratesEndIndex++;
        }

        const vatRatesRaw = parts.slice(1, ratesEndIndex);
        const receiptCounter = parseInt(parts[ratesEndIndex], 10);
        
        const totalsAndRest = parts.slice(ratesEndIndex + 1);
        const uniqueId = totalsAndRest.pop();
        const cashInDrawer = parseFloat(totalsAndRest.pop());
        const dailyTotalsRaw = totalsAndRest;

        const parseRate = (rateStr) => {
            if (!rateStr) return 'niezdefiniowana';
            const val = parseFloat(rateStr);
            if (val === 100) return "zwolniona";
            if (val === 101) return "nieaktywna";
            return val;
        };
        
        // === POPRAWKA TUTAJ ===
        // Dodajemy .padStart(2, '0'), aby zawsze mieć dwie cyfry roku (np. "0" -> "00")
        const year = String(flags[6]).padStart(2, '0');
        const month = String(flags[7]).padStart(2, '0');
        const day = String(flags[8]).padStart(2, '0');
        
        const statusObject = {
            lastCommandError: parseInt(flags[0], 10),
            isFiscal: parseInt(flags[1], 10) === 1,
            isTransactionOpen: parseInt(flags[2], 10) === 1,
            lastTransactionOk: parseInt(flags[3], 10) === 1,
            ramResets: parseInt(flags[5], 10),
            lastWriteDate: `20${year}-${month}-${day}`, // Teraz wynik będzie poprawny: "2000-01-01"
            vatRates: {
                A: parseRate(vatRatesRaw[0]),
                B: parseRate(vatRatesRaw[1]),
                C: parseRate(vatRatesRaw[2]),
                D: parseRate(vatRatesRaw[3]),
                E: parseRate(vatRatesRaw[4]),
                F: parseRate(vatRatesRaw[5]),
                G: parseRate(vatRatesRaw[6]),
            },
            receiptsSinceDailyReport: receiptCounter,
            dailyTotals: {
                A: parseFloat(dailyTotalsRaw[0]) || 0,
                B: parseFloat(dailyTotalsRaw[1]) || 0,
                C: parseFloat(dailyTotalsRaw[2]) || 0,
                D: parseFloat(dailyTotalsRaw[3]) || 0,
                E: parseFloat(dailyTotalsRaw[4]) || 0,
                F: parseFloat(dailyTotalsRaw[5]) || 0,
                G: parseFloat(dailyTotalsRaw[6]) || 0,
            },
            cashInDrawer: cashInDrawer,
            uniqueId: uniqueId,
        };

        return statusObject;

    } catch (error) {
        console.error('Błąd parsowania odpowiedzi [th_scinfo]:', error);
        console.error('Surowa odpowiedź, która spowodowała błąd:', rawResponse);
        throw new Error('Otrzymano nieprawidłowy format odpowiedzi od drukarki.');
    }
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



module.exports = {
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
  getParsedStatusInfo
};