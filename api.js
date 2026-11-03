function createApi(printer, express = require('express')) {
const apiApp = express();
apiApp.use(express.json());

// --- ENDPOINTY API ---

apiApp.post('/transaction/receipt', async (req, res) => {
    try {
        const receiptData = req.body;
        if (!receiptData.items || !receiptData.payment) {
            return res.status(400).json({ success: false, message: 'Nieprawidłowe dane paragonu.' });
        }
        const result = await printer.printReceipt(receiptData, { operationId: req.get('X-Operation-Id') });
        res.status(result.state === 'in_progress' ? 202 : result.success ? 200 : 409).json(result);
    } catch (error) {
        console.error('Błąd podczas drukowania paragonu:', error.message);
        res.status(error.statusCode || 500).json({ success: false, message: 'Błąd drukowania paragonu.', error: error.message, code: error.code, ...error.operation });
    }
});

apiApp.post('/cashier/login', async (req, res) => {
  try {
    const { cashier = 'Kasjer 1', register = 'Kasa 1' } = req.body;
    await printer.login(cashier, register);
    res.status(200).json({ success: true, message: `Kasjer '${cashier}' zalogowany.` });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: 'Błąd logowania kasjera.', error: error.message, code: error.code, ...error.operation });
  }
});

apiApp.post('/cashier/logout', async (req, res) => {
  try {
    const { cashier = 'Kasjer 1', register = 'Kasa 1' } = req.body;
    await printer.logout(cashier, register);
    res.status(200).json({ success: true, message: `Kasjer '${cashier}' wylogowany.` });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: 'Błąd wylogowania kasjera.', error: error.message, code: error.code, ...error.operation });
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
    res.status(error.statusCode || 500).json({ success: false, message: 'Błąd wpłaty do kasy.', error: error.message, code: error.code, ...error.operation });
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
        res.status(error.statusCode || 500).json({ success: false, message: 'Błąd wypłaty z kasy.', error: error.message, code: error.code, ...error.operation });
    }
});

apiApp.get('/cash/report', async (req, res) => {
    try {
        await printer.getCashDrawerStateReport();
        res.status(200).json({ success: true, message: 'Polecenie wydruku raportu stanu kasy wysłane.' });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, message: 'Błąd drukowania raportu.', error: error.message, code: error.code, ...error.operation });
    }
});

// === NOWY ENDPOINT DLA ZAAWANSOWANYCH PARAGONÓW ===
apiApp.post('/transaction/receipt-advanced', async (req, res) => {
    try {
        const receiptData = req.body;
        if (!receiptData.items) {
            return res.status(400).json({ success: false, message: 'Nieprawidłowe dane paragonu (brak pozycji).' });
        }
        const result = await printer.printAdvancedReceipt(receiptData, { operationId: req.get('X-Operation-Id') });
        res.status(result.state === 'in_progress' ? 202 : result.success ? 200 : 409).json(result);
    } catch (error) {
        console.error('Błąd podczas drukowania zaawansowanego paragonu:', error.message);
        res.status(error.statusCode || 500).json({ success: false, message: 'Błąd drukowania zaawansowanego paragonu.', error: error.message, code: error.code, ...error.operation });
    }
});

// === NOWY ENDPOINT DO OTWIERANIA SZUFLADY ===
apiApp.post('/cash-drawer/open', async (req, res) => {
    try {
        await printer.openCashDrawer();
        res.status(200).json({ success: true, message: 'Polecenie otwarcia szuflady wysłane.' });
    } catch (error) {
        console.error('Błąd podczas otwierania szuflady:', error.message);
        res.status(error.statusCode || 500).json({ success: false, message: 'Błąd otwierania szuflady.', error: error.message, code: error.code, ...error.operation });
    }
});


// Zmieniamy logikę /transaction/void, aby była kompletna i niezależna
apiApp.post('/transaction/void', async (req, res) => {
    try {
        // Kompletny i bezpieczny proces: wyczyść, rozpocznij, anuluj.
        // Gwarantuje wydruk paragonu "ANULOWANY" nawet jeśli drukarka była w czystym stanie.
        console.log('--- Rozpoczynanie procedury drukowania paragonu ANULOWANEGO ---');
        await printer.printVoidDocument();
        res.status(200).json({ success: true, message: 'Polecenie wydruku paragonu ANULOWANEGO wysłane.' });
    } catch (error) {
        console.error('Błąd podczas anulowania transakcji:', error.message);
        res.status(error.statusCode || 500).json({ success: false, message: 'Błąd anulowania transakcji.', error: error.message, code: error.code, ...error.operation });
    }
});

// === NOWY ENDPOINT DO PONOWNEGO WYDRUKU ===
apiApp.post('/transaction/reprint-last', async (req, res) => {
    try {
        await printer.reprintLastReceipt();
        res.status(200).json({ success: true, message: 'Polecenie ponownego wydruku wysłane.' });
    } catch (error) {
        console.error('Błąd podczas ponownego drukowania paragonu:', error.message);
        res.status(error.statusCode || 500).json({ success: false, message: 'Błąd ponownego drukowania paragonu.', error: error.message, code: error.code, ...error.operation });
    }
});

// === NOWY ENDPOINT DO ODCZYTU STANU KASY ===
apiApp.get('/cash/state', async (req, res) => {
    try {
        const cashAmount = await printer.getCashDrawerState();
        res.status(200).json({ success: true, cashAmount: cashAmount });
    } catch (error) {
        console.error('Błąd podczas odczytu stanu kasy:', error.message);
        res.status(error.statusCode || 500).json({ success: false, message: 'Błąd odczytu stanu kasy.', error: error.message, code: error.code, ...error.operation });
    }
});

// === NOWY ENDPOINT Z PARSOWANIEM ===
apiApp.get('/status/parsed', async (req, res) => {
    try {
        const parsedStatus = await printer.getParsedStatusInfo();
        res.status(200).json({ success: true, status: parsedStatus });
    } catch (error) {
        console.error('Błąd podczas odczytu parsowanego statusu:', error.message);
        res.status(error.statusCode || 500).json({ success: false, message: 'Błąd odczytu i parsowania statusu.', error: error.message, code: error.code, ...error.operation });
    }
});


apiApp.get('/status', async (req, res) => {
    try {
      const statusData = await printer.getStatusInfo();
      res.status(200).json({ success: true, message: 'Odczytano status drukarki.', data: statusData });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, message: 'Błąd odczytu statusu.', error: error.message, code: error.code, ...error.operation });
    }
});

// Deliberately leaving a fiscal transaction open is incompatible with safe operation.
apiApp.post('/test/break-printer', (req, res) => {
    res.status(410).json({ success: false, message: 'Endpoint wyłączony. Użyj symulatora w testach.' });
});

// === NOWY ENDPOINT DLA RAPORTÓW ===
apiApp.post('/reports/daily', async (req, res) => {
    try {
        const { cashier, cashRegister } = req.body || {};
        await printer.printDailyReport({ cashier, cashRegister });
        res.status(200).json({ success: true, message: 'Polecenie wydruku raportu dobowego wysłane.' });
    } catch (error) {
        console.error('Błąd podczas drukowania raportu dobowego:', error.message);
        res.status(error.statusCode || 500).json({ success: false, message: 'Błąd drukowania raportu dobowego.', error: error.message, code: error.code, ...error.operation });
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
        res.status(error.statusCode || 500).json({ success: false, message: 'Błąd drukowania raportu okresowego.', error: error.message, code: error.code, ...error.operation });
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
        res.status(error.statusCode || 500).json({ success: false, message: 'Błąd drukowania paragonu testowego.', error: error.message, code: error.code, ...error.operation });
    }
});


apiApp.get('/broker/status', (req, res) => res.json(printer.status()));

const operationRoute = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
        res.status(error.statusCode || 503).json({ success: false, error: error.message, code: error.code, ...error.operation });
    }
};

apiApp.get('/device/diagnostics', operationRoute(async (req, res) => {
    res.json(await printer.getSnapshot());
}));

apiApp.post('/operations/receipt', operationRoute(async (req, res) => {
    const result = await printer.submitReceipt(req.body);
    res.status(result.state === 'in_progress' ? 202 : result.success ? 200 : 409).json(result);
}));

apiApp.get('/operations/:id', operationRoute(async (req, res) => {
    const record = printer.getOperation(req.params.id);
    res.status(record ? 200 : 404).json(record || { success: false, code: 'NOT_FOUND' });
}));

apiApp.post('/operations/:id/reconcile', operationRoute(async (req, res) => {
    res.json(await printer.reconcile(req.params.id));
}));

return apiApp;
}

module.exports = { createApi };
