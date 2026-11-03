// Optional exact-origin CORS for the browser POS and its new reservation headers.
// Unconfigured: preserve the previous HTTP behavior (no CORS headers).
function browserAccess(origins = []) {
  const allowed = new Set(origins.map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) {
      throw new Error('FISCAL_ALLOWED_ORIGINS wymaga dokładnych originów http(s), bez ścieżki i końcowego /.');
    }
    return value;
  }));
  const headers = ['content-type', 'x-operation-id', 'x-printer-reservation-token'];
  return (req, res, next) => {
    const origin = req.get('Origin');
    if (!origin || allowed.size === 0) return next();
    if (!allowed.has(origin)) return res.status(403).json({ success: false, code: 'ORIGIN_NOT_ALLOWED' });
    res.set('Access-Control-Allow-Origin', origin);
    res.vary('Origin');
    if (req.method !== 'OPTIONS') return next();
    if (!['GET', 'POST'].includes(req.get('Access-Control-Request-Method'))) {
      return res.status(403).json({ success: false, code: 'CORS_METHOD_NOT_ALLOWED' });
    }
    const requested = (req.get('Access-Control-Request-Headers') || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
    if (requested.some(header => !headers.includes(header))) return res.status(403).json({ success: false, code: 'CORS_HEADERS_NOT_ALLOWED' });
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Operation-Id, X-Printer-Reservation-Token');
    if (req.get('Access-Control-Request-Private-Network') === 'true') res.set('Access-Control-Allow-Private-Network', 'true');
    return res.sendStatus(204);
  };
}

module.exports = { browserAccess };
