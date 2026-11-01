// Local process controls. No printer commands or document payloads are changed here.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function createControl({ printer, journal, port, transport, root, onStopped,
  waitMs = 180000, pollMs = 100 }) {
  const token = randomBytes(32).toString('hex');
  const instanceId = randomUUID();
  const descriptorPath = path.join(root, 'local-results', 'broker-control.json');
  let state = 'running';
  let inFlight = 0;
  let stopping;
  let finalStatus;
  let finishing;

  const status = () => ({ ...(finalStatus || printer.status()), local_control: {
    version: 1, instance_id: instanceId, state,
    serial_connected: Boolean(port.isOpen && !transport.fault),
  } });
  const reserved = () => printer.reservations.active();
  const error = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });

  function stop() {
    if (stopping) return stopping;
    // A POS can have reserved the printer before committing its sale.
    if (reserved()) return Promise.reject(error('POS_RESERVED', 'POS ma rezerwację drukarki. Dokończ obsługę klienta i spróbuj ponownie.'));
    state = 'draining';
    stopping = (async () => {
      const deadline = Date.now() + waitMs;
      while (printer.busy || inFlight) {
        if (Date.now() >= deadline) throw error('STILL_BUSY', 'Operacja nadal trwa. Broker pozostaje uruchomiony. Spróbuj ponownie po jej zakończeniu.');
        await pause(pollMs);
      }
      if (reserved()) throw error('POS_RESERVED', 'POS właśnie zarezerwował drukarkę. Dokończ obsługę klienta i spróbuj ponownie.');
      finalStatus = printer.status();
      state = 'closing';
      journal.close();
      return { success: true, instance_id: instanceId, state };
    })().catch(cause => {
      if (state === 'draining') { state = 'running'; stopping = undefined; }
      throw cause;
    });
    return stopping;
  }

  function removeDescriptor() {
    try {
      if (JSON.parse(fs.readFileSync(descriptorPath, 'utf8')).instance_id === instanceId) fs.unlinkSync(descriptorPath);
    } catch (cause) { if (cause.code !== 'ENOENT') console.error('Plik sterowania:', cause.message); }
  }

  function finish() {
    if (finishing) return finishing;
    finishing = (async () => {
      if (state !== 'closing') throw new Error('Najpierw poczekaj na zakończenie operacji.');
      if (port.isOpen) await new Promise((resolve, reject) => port.close(cause => cause ? reject(cause) : resolve()));
      removeDescriptor();
      state = 'closed';
      await onStopped();
    })().catch(cause => { finishing = undefined; throw cause; });
    return finishing;
  }

  function attach(api, legacyApi) {
    api.post('/broker/control/stop', async (req, res) => {
      const supplied = req.get('X-Local-Control-Token');
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if (!local || req.get('Origin') !== undefined || typeof supplied !== 'string' ||
        !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
        return res.status(403).json({ success: false, code: 'LOCAL_CONTROL_DENIED' });
      }
      try {
        const result = await stop();
        if (res.destroyed) { await finish(); return; }
        res.once('finish', () => { finish().catch(cause => console.error('Zatrzymanie brokera:', cause.message)); });
        // If the caller disconnects while waiting, still finish the accepted stop.
        res.once('close', () => { finish().catch(cause => console.error('Zatrzymanie brokera:', cause.message)); });
        res.json(result);
      } catch (cause) {
        if (!res.destroyed) res.status(cause.statusCode || 500).json({ success: false, code: cause.code, message: cause.message });
      }
    });
    api.use(require('./browser-access').browserAccess(printer.config?.allowedOrigins));
    api.get('/broker/status', (_req, res) => {
      try { res.json(status()); } catch (cause) { res.status(503).json({ success: false, message: cause.message }); }
    });
    api.use((req, res, next) => {
      if (state !== 'running') return res.status(503).json({ success: false, code: 'BROKER_STOPPING', message: 'Broker kończy pracę. Poczekaj na ponowne uruchomienie.' });
      inFlight++;
      let counted = true;
      const done = () => { if (counted) { counted = false; inFlight--; } };
      res.once('finish', done);
      res.once('close', done);
      next();
    });
    api.use(legacyApi);
    return api;
  }

  function publish(httpPort) {
    fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
    fs.writeFileSync(descriptorPath, JSON.stringify({ version: 1, instance_id: instanceId,
      pid: process.pid, root: path.resolve(root), port: httpPort, token }), { mode: 0o600 });
  }

  return { attach, publish, stop, finish, status, removeDescriptor, get state() { return state; } };
}

module.exports = { createControl };
