const { app, BrowserWindow } = require('electron');
const express = require('express');
const path = require('path');
const printer = require('./thermal-printer');

const API_PORT = 3030;

function createWindow() {
  const mainWindow = new BrowserWindow({ width: 800, height: 600 });
  mainWindow.loadFile('index.html');
}

const apiApp = express();
apiApp.use(express.json());

// --- ENDPOINTY API ---

apiApp.post('/transaction/receipt', async (req, res) => {
    try {
        const receiptData = req.body;
        if (!receiptData.items || !receiptData.payment) {
            return res.status(400).json({ success: false, message: 'Nieprawidłowe dane paragonu.' });
        }
        const result = await printer.printReceipt(receiptData);
        res.status(200).json(result);
    } catch (error) {
        console.error('Błąd podczas drukowania paragonu:', error.message);
        res.status(500).json({ success: false, message: 'Błąd drukowania paragonu.', error: error.message });
    }
});

apiApp.post('/cashier/login', async (req, res) => {
  try {
    const { cashier = 'Kasjer 1', register = 'Kasa 1' } = req.body;
    await printer.login(cashier, register);
    res.status(200).json({ success: true, message: `Kasjer '${cashier}' zalogowany.` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Błąd logowania kasjera.', error: error.message });
  }
});

apiApp.post('/cashier/logout', async (req, res) => {
  try {
    const { cashier = 'Kasjer 1', register = 'Kasa 1' } = req.body;
    await printer.logout(cashier, register);
    res.status(200).json({ success: true, message: `Kasjer '${cashier}' wylogowany.` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Błąd wylogowania kasjera.', error: error.message });
  }
});

apiApp.post('/cash/deposit', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || isNaN(parseFloat(amount))) {
        return res.status(400).json({ success: false, message: 'Nieprawidłowa lub brakująca kwota.' });
    }
    await printer.cashDeposit(amount);
    res.status(200).json({ success: true, message: `Wpłacono ${amount} do kasy.` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Błąd wpłaty do kasy.', error: error.message });
  }
});

apiApp.post('/cash/withdraw', async (req, res) => {
    try {
        const { amount } = req.body;
        if (!amount || isNaN(parseFloat(amount))) {
            return res.status(400).json({ success: false, message: 'Nieprawidłowa lub brakująca kwota.' });
        }
        await printer.cashWithdrawal(amount);
        res.status(200).json({ success: true, message: `Wypłacono ${amount} z kasy.` });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Błąd wypłaty z kasy.', error: error.message });
    }
});

apiApp.get('/cash/report', async (req, res) => {
    try {
        await printer.getCashDrawerStateReport();
        res.status(200).json({ success: true, message: 'Polecenie wydruku raportu stanu kasy wysłane.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Błąd drukowania raportu.', error: error.message });
    }
});

// Zmieniamy logikę /transaction/void, aby była kompletna i niezależna
apiApp.post('/transaction/void', async (req, res) => {
    try {
        // Kompletny i bezpieczny proces: wyczyść, rozpocznij, anuluj.
        // Gwarantuje wydruk paragonu "ANULOWANY" nawet jeśli drukarka była w czystym stanie.
        console.log('--- Rozpoczynanie procedury drukowania paragonu ANULOWANEGO ---');
        await printer.clearState();
        await printer.startTransaction();
        await printer.voidCurrentTransaction();
        res.status(200).json({ success: true, message: 'Polecenie wydruku paragonu ANULOWANEGO wysłane.' });
    } catch (error) {
        console.error('Błąd podczas anulowania transakcji:', error.message);
        res.status(500).json({ success: false, message: 'Błąd anulowania transakcji.', error: error.message });
    }
});

apiApp.get('/status', async (req, res) => {
    try {
      const statusData = await printer.getStatusInfo();
      res.status(200).json({ success: true, message: 'Odczytano status drukarki.', data: statusData });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Błąd odczytu statusu.', error: error.message });
    }
});

// Endpoint do testowania błędu (do usunięcia po testach)
apiApp.post('/test/break-printer', async (req, res) => {
    console.log('--- Rozpoczynanie symulacji błędu ---');
    try {
        await printer.startTransaction();
        res.status(200).json({ success: true, message: 'Symulacja błędu zakończona. Drukarka jest teraz w stanie otwartej transakcji.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Błąd podczas symulacji.', error: error.message });
    }
});

// === NOWY ENDPOINT DLA RAPORTÓW ===
apiApp.post('/reports/daily', async (req, res) => {
    try {
        const { cashier, cashRegister } = req.body || {};
        await printer.printDailyReport({ cashier, cashRegister });
        res.status(200).json({ success: true, message: 'Polecenie wydruku raportu dobowego wysłane.' });
    } catch (error) {
        console.error('Błąd podczas drukowania raportu dobowego:', error.message);
        res.status(500).json({ success: false, message: 'Błąd drukowania raportu dobowego.', error: error.message });
    }
});

apiApp.post('/reports/periodic', async (req, res) => {
    try {
        const { startDate, endDate, cashier, cashRegister } = req.body;
        if (!startDate || !endDate) {
            return res.status(400).json({ success: false, message: 'Brak daty początkowej lub końcowej.' });
        }
        await printer.printPeriodicReport({ startDate, endDate, cashier, cashRegister });
        res.status(200).json({ success: true, message: 'Polecenie wydruku raportu okresowego wysłane.' });
    } catch (error) {
        console.error('Błąd podczas drukowania raportu okresowego:', error.message);
        res.status(500).json({ success: false, message: 'Błąd drukowania raportu okresowego.', error: error.message });
    }
});

// === ENDPOINTY TESTOWE ===
apiApp.post('/test/void-receipt', async (req, res) => {
    try {
        const receiptData = req.body;
        if (!receiptData.items) {
            return res.status(400).json({ success: false, message: 'Nieprawidłowe dane paragonu testowego.' });
        }
        const result = await printer.printTestVoidReceipt(receiptData);
        res.status(200).json(result);
    } catch (error) {
        console.error('Błąd podczas drukowania paragonu testowego:', error.message);
        res.status(500).json({ success: false, message: 'Błąd drukowania paragonu testowego.', error: error.message });
    }
});

// === Inicjalizacja Aplikacji ===
app.whenReady().then(() => {
  createWindow();

  // NIE wywołujemy już żadnej specjalnej konfiguracji.
  // Po prostu uruchamiamy serwer API.
  // Logika otwierania portu jest teraz w całości w thermal-printer.js.
  apiApp.listen(API_PORT, () => {
    console.log(`🚀 Serwer API nasłuchuje na http://localhost:${API_PORT}`);
  });
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});