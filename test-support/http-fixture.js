const { createApi } = require('../api');
const { setup } = require('./printer-port');

async function httpFixture(t, config) {
  const fixture = setup(t, config);
  const server = createApi(fixture.broker).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body, headers = {}, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + route, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...fixture, request, base };
}

module.exports = { httpFixture };
