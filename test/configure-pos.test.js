const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { originFromAddress, configure } = require('../scripts/configure-pos');

test('POS configuration accepts a whole page address and never saves its path/query', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(configure(directory, ' https://POS.example.test/staff/pos/v2?code=private#page '), 'https://pos.example.test');
  const content = fs.readFileSync(path.join(directory, 'broker-local.cmd'), 'utf8');
  assert.match(content, /set "FISCAL_ALLOWED_ORIGINS=https:\/\/pos\.example\.test"/);
  assert.equal(content.includes('private'), false);
  assert.equal(content.includes('/staff'), false);
});

test('POS configuration preserves device settings, previous origins and a backup', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'broker-local.cmd');
  const old = '@echo off\r\nset "FISCAL_SERIAL_PORT=COM7"\r\nset "FISCAL_ALLOWED_ORIGINS=https://old.example.test"\r\nset "FISCAL_PRINTER_UNIQUE_NUMBER=ABC123"\r\n';
  fs.writeFileSync(filename, old);
  configure(directory, 'https://pos.example.test/staff/pos/v2');
  const next = fs.readFileSync(filename, 'utf8');
  assert.equal(fs.readFileSync(filename + '.bak', 'utf8'), old);
  assert.ok(next.includes('set "FISCAL_SERIAL_PORT=COM7"\r\n'));
  assert.ok(next.includes('https://old.example.test,https://pos.example.test'));
  assert.ok(next.endsWith('set "FISCAL_PRINTER_UNIQUE_NUMBER=ABC123"\r\n'));
  configure(directory, 'https://pos.example.test/another-page');
  assert.equal(fs.readFileSync(filename, 'utf8'), next);
});

test('POS configuration rejects credentials and CMD metacharacters in origins without writing files', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const value of ['file:///C:/pos', 'javascript:alert(1)', 'https://user:password@pos.example.test', 'https://a&b.example.test', 'not-a-url']) {
    assert.throws(() => configure(directory, value));
  }
  assert.equal(fs.readdirSync(directory).length, 0);
  assert.equal(originFromAddress('http://localhost:3000/staff'), 'http://localhost:3000');
});
