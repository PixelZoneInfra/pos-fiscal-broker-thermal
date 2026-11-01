const { app, BrowserWindow } = require('electron');
const path = require('node:path');

// Do this before opening COM3 or the journal.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let journal;
  let server;
  app.whenReady().then(() => {
    const { SerialPort } = require('serialport');
    const { ThermalTransport } = require('./thermal-transport');
    const { createPrinter } = require('./thermal-printer');
    const { OperationJournal } = require('./operation-journal');
    const { BrokerService } = require('./broker-service');
    const { createApi } = require('./api');

    journal = new OperationJournal(path.join(app.getPath('userData'), 'fiscal-operations'));
    const port = new SerialPort({
      path: process.env.FISCAL_SERIAL_PORT || 'COM3', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', autoOpen: false,
    });
    const transport = new ThermalTransport(port);
    const printer = new BrokerService(createPrinter(transport), journal, {
      onlineEnabled: process.env.FISCAL_ONLINE_ENABLED === 'true',
      diagnosticsOnly: process.env.FISCAL_DIAGNOSTICS_ONLY === 'true',
      requirePosReservation: process.env.FISCAL_REQUIRE_POS_RESERVATION === 'true',
      allowedOrigins: (process.env.FISCAL_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
      serialPort: port.path,
      branchId: Number(process.env.FISCAL_BRANCH_ID),
      environment: process.env.FISCAL_ENVIRONMENT,
      printerUniqueNumber: process.env.FISCAL_PRINTER_UNIQUE_NUMBER,
    });
    port.open(error => {
      if (error) console.error(`Błąd otwarcia ${port.path}:`, error.message);
    });
    server = createApi(printer).listen(3030, '127.0.0.1', () => {
      console.log('API: http://127.0.0.1:3030; dziennik:', path.join(app.getPath('userData'), 'fiscal-operations'));
    });
    server.on('error', error => { console.error('Nie można uruchomić API:', error.message); app.quit(); });
    const createWindow = () => {
      const window = new BrowserWindow({ width: 800, height: 600 });
      window.loadFile('index.html');
    };
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  }).catch(error => {
    console.error('Broker nie został uruchomiony:', error.message);
    app.quit();
  });
  app.on('will-quit', () => { server?.close(); journal?.close(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
