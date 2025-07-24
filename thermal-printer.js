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

port.open((err) => {
  if (err) return console.error('❌ Błąd otwierania portu COM3:', err.message);
  console.log('✅ Połączenie z portem COM3 otwarte.');
  processQueue();
});

port.on('error', (err) => {
  console.error('❌ Błąd portu szeregowego:', err.message);
});

/**
 * Oblicza sumę kontrolną (checksum) dla polecenia zgodnie z dokumentacją (XOR).
 * @param {Buffer} commandPart Bufor zawierający część polecenia od znaku po 'ESC P' do końca.
 * @returns {string} Dwuznakowy string HEX reprezentujący sumę kontrolną.
 */
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
    const response = await executeCommand(task.command, task.expectsResponse);
    task.resolve(response);
  } catch (error) {
    task.reject(error);
  } finally {
    isProcessing = false;
    processQueue();
  }
}

function executeCommand(command, expectsResponse) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
        port.removeListener('data', onData);
        reject(new Error('Timeout: Drukarka nie odpowiedziała.'));
    }, 3000); // Wydłużony timeout dla operacji z wydrukiem

    const onData = (chunk) => {
        // Na razie prosta obsługa - pierwsza paczka danych to odpowiedź
        clearTimeout(timeout);
        port.removeListener('data', onData);
        console.log(`Otrzymano odpowiedź (hex): ${chunk.toString('hex')}`);
        resolve('Drukarka odpowiedziała.'); // Można tu będzie zaimplementować pełne parsowanie
    };
    
    if (expectsResponse) {
        port.on('data', onData);
    }

    port.write(command, (err) => {
      if (err) {
        clearTimeout(timeout);
        port.removeListener('data', onData);
        return reject(new Error(`Błąd zapisu do portu: ${err.message}`));
      }
      console.log('Wysłano polecenie (hex):', command.toString('hex'));
      if (!expectsResponse) {
        clearTimeout(timeout);
        resolve('Polecenie wysłane pomyślnie.');
      }
    });
  });
}

function sendCommand(command, { expectsResponse = false } = {}) {
  return new Promise((resolve, reject) => {
    commandQueue.push({ command, expectsResponse, resolve, reject });
    if (!isProcessing) processQueue();
  });
}

// === NOWE FUNKCJE ===

/**
 * Logowanie kasjera.
 * Komenda: [th_login]
 */
async function login(cashier, cashRegister) {
    const part = Buffer.from(`0#p${cashier}\r${cashRegister}\r`, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([
        Buffer.from('\x1b\x50', 'binary'), // ESC P
        part,
        Buffer.from(checksum, 'binary'),
        Buffer.from('\x1b\\', 'binary')   // ESC \
    ]);
    return sendCommand(command);
}

/**
 * Wylogowanie kasjera.
 * Komenda: [th_logout]
 */
async function logout(cashier, cashRegister) {
    const part = Buffer.from(`0#q${cashier}\r${cashRegister}\r`, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([
        Buffer.from('\x1b\x50', 'binary'),
        part,
        Buffer.from(checksum, 'binary'),
        Buffer.from('\x1b\\', 'binary')
    ]);
    return sendCommand(command);
}

/**
 * Wpłata gotówki do kasy (depozyt).
 * Komenda: [th_cashinc]
 */
async function cashDeposit(amount) {
    const part = Buffer.from(`0#i${amount}/`, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([
        Buffer.from('\x1b\x50', 'binary'),
        part,
        Buffer.from(checksum, 'binary'),
        Buffer.from('\x1b\\', 'binary')
    ]);
    return sendCommand(command);
}

/**
 * Wypłata gotówki z kasy.
 * Komenda: [th_cashdec]
 */
async function cashWithdrawal(amount) {
    const part = Buffer.from(`0#d${amount}/`, 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([
        Buffer.from('\x1b\x50', 'binary'),
        part,
        Buffer.from(checksum, 'binary'),
        Buffer.from('\x1b\\', 'binary')
    ]);
    return sendCommand(command);
}

/**
 * Drukuje niefiskalny raport o stanie kasy.
 * Komenda: [th_cashstaterep]
 */
async function getCashDrawerStateReport() {
    const part = Buffer.from('0#t', 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([
        Buffer.from('\x1b\x50', 'binary'),
        part,
        Buffer.from(checksum, 'binary'),
        Buffer.from('\x1b\\', 'binary')
    ]);
    return sendCommand(command);
}

/**
 * Anulowanie transakcji (wydruk paragonu "ANULOWANY").
 * Komenda: [th_trcancel]
 */
async function printVoidedReceipt() {
    // Uwaga: Ta komenda zadziała poprawnie tylko, jeśli wcześniej rozpoczniemy transakcję [th_trinit].
    // Na razie implementujemy samo wysłanie polecenia anulowania.
    const part = Buffer.from('0$e', 'binary');
    const checksum = calculateChecksum(part);
    const command = Buffer.concat([
        Buffer.from('\x1b\x50', 'binary'),
        part,
        Buffer.from(checksum, 'binary'),
        Buffer.from('\x1b\\', 'binary')
    ]);
    return sendCommand(command);
}


/**
 * Odczytuje status z drukarki (zostaje bez zmian).
 * Komenda: [th_scinfo]
 */
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
};