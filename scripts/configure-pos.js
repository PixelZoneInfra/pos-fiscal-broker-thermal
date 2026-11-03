const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');

function originFromAddress(address) {
  let url;
  try { url = new URL(address.trim()); } catch { throw new Error('Wklej caly adres strony POS zaczynajacy sie od https:// lub http://.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(url.hostname)) {
    throw new Error('Nieprawidlowy adres strony POS.');
  }
  // Copying the whole browser address is enough; paths, queries and fragments are not saved.
  return url.origin;
}

function configure(directory, address) {
  const origin = originFromAddress(address);
  const filename = path.join(directory, 'broker-local.cmd');
  const previous = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '@echo off\r\n';
  const lines = [...previous.matchAll(/^[ \t]*set[ \t]+"FISCAL_ALLOWED_ORIGINS=([^"\r\n]*)"[ \t]*\r?$/gim)];
  const last = lines.at(-1);
  const origins = last ? last[1].split(',').map(value => value.trim()).filter(Boolean) : [];
  for (const value of origins) {
    if (originFromAddress(value) !== value) throw new Error('Istniejaca konfiguracja adresow wymaga sprawdzenia. Nic nie zmieniono.');
  }
  if (!origins.includes(origin)) origins.push(origin);
  const eol = previous.includes('\r\n') ? '\r\n' : '\n';
  const line = `set "FISCAL_ALLOWED_ORIGINS=${origins.join(',')}"`;
  const next = last ? previous.slice(0, last.index) + line + (last[0].endsWith('\r') ? '\r' : '') + previous.slice(last.index + last[0].length)
    : previous + (previous.endsWith('\n') ? '' : eol) + line + eol;
  if (fs.existsSync(filename)) fs.copyFileSync(filename, filename + '.bak');
  fs.writeFileSync(filename, next, { mode: 0o600 });
  return origin;
}

async function main() {
  console.log('Otworz swoj POS w przegladarce. Skopiuj caly adres z paska adresu (Ctrl+L, Ctrl+C).');
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const address = await input.question('Wklej adres tutaj i nacisnij Enter: ');
    const origin = configure(path.join(__dirname, '..'), address);
    console.log(`Gotowe. Zapisano adres POS: ${origin}`);
    console.log('Nie zmieniono portu, komend drukarki ani ustawien innych aplikacji.');
  } finally { input.close(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { originFromAddress, configure };
