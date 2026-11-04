const { app, BrowserWindow } = require('electron');
const path = require('node:path');

// Do this before opening COM3 or the journal.
if (!app.requestSingleInstanceLock()) {
  console.error('START ZATRZYMANY: Inna kopia brokera jest juz uruchomiona. Nowa kopia nie otworzy portu 3030.');
  app.quit();
} else {
  let journal;
  let server;
  let control;
  let quitting = false;
  let window;
  app.whenReady().then(() => {
    console.log('Electron gotowy. Otwieram lokalny dziennik i port drukarki.');
    const { SerialPort } = require('serialport');
    const { ThermalTransport } = require('./thermal-transport');
    const { createPrinter } = require('./thermal-printer');
    const { OperationJournal } = require('./operation-journal');
    const { BrokerService } = require('./broker-service');
    const { createApi } = require('./api');
    const { createControl } = require('./broker-control');
    const { profileFromEnvironment, saveProfile } = require('./launch-profile');
    // Direct npm/Electron starts keep their existing configuration contract. Bundled launchers
    // explicitly opt into persistent daily-restart profiles before any device is opened.
    const launchProfile = process.env.FISCAL_LAUNCH_PROFILE === 'managed' ? profileFromEnvironment(process.env) : null;

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
    });
    port.open(error => {
      if (error) console.error(`Błąd otwarcia ${port.path}:`, error.message);
    });
    control = createControl({ printer, journal, port, transport, root: __dirname,
      onStopped: async () => {
        await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeIdleConnections?.();
        });
        quitting = true;
        app.quit();
      },
    });
    server = control.attach(require('express')(), createApi(printer)).listen(3030, '127.0.0.1', () => {
      control.publish(3030);
      if (launchProfile) saveProfile(__dirname, launchProfile);
      console.log('API: http://127.0.0.1:3030; dziennik:', path.join(app.getPath('userData'), 'fiscal-operations'));
    });
    server.on('error', error => {
      console.error('Nie można uruchomić API:', error.message);
      // This server never accepted a command if binding failed.
      quitting = true;
      app.quit();
    });
    window = new BrowserWindow({ width: 800, height: 600, show: false, skipTaskbar: true });
    window.loadFile('index.html');
    window.on('close', event => { if (!quitting) { event.preventDefault(); app.quit(); } });
  }).catch(error => {
    console.error('Broker nie został uruchomiony:', error.message);
    quitting = true;
    app.quit();
  });
  app.on('before-quit', event => {
    if (quitting || !control) return;
    event.preventDefault();
    control.stop().then(() => control.finish()).catch(error => {
      console.error('Broker nadal działa:', error.message);
      require('electron').dialog.showErrorBox('Broker nadal działa', error.message);
    });
  });
  app.on('will-quit', () => { server?.close(); journal?.close(); control?.removeDescriptor(); });
}
