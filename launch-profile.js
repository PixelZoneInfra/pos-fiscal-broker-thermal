const fs = require('node:fs');
const path = require('node:path');

// Only these checked-in launchers may be invoked by the daily restart button.
const launchers = Object.freeze({
  legacy: 'start-pos.cmd',
  diagnostics: 'start-diagnostics.cmd',
  'reservation-test': 'start-reservation-test.cmd',
  'production-reservations': 'start-production-reservations.cmd',
  'online-preview': 'start-online-preview.cmd',
  'online-production': 'start-online-production.cmd',
});
const filename = root => path.join(root, 'local-results', 'broker-profile.json');

function profileFromEnvironment(env) {
  const online = env.FISCAL_ONLINE_ENABLED === 'true';
  const reserved = env.FISCAL_REQUIRE_POS_RESERVATION === 'true';
  if (env.FISCAL_DIAGNOSTICS_ONLY === 'true') {
    if (online || reserved) throw new Error('Nieprawidlowy profil diagnostyczny.');
    return 'diagnostics';
  }
  if (!online && !reserved) return 'legacy';
  const banino = env.FISCAL_BRANCH_ID === '1';
  if (!online) return banino && env.FISCAL_ENVIRONMENT === 'production' ? 'production-reservations' : 'reservation-test';
  if (!reserved || !banino || !['preview', 'production'].includes(env.FISCAL_ENVIRONMENT)) {
    throw new Error('Profil online wymaga rezerwacji i jawnego srodowiska Banina.');
  }
  return `online-${env.FISCAL_ENVIRONMENT}`;
}

function saveProfile(root, profile) {
  if (!Object.hasOwn(launchers, profile)) throw new Error('Nieznany profil startu brokera.');
  const target = filename(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, profile }) + '\n');
  fs.renameSync(temporary, target);
}

function restartLauncher(root) {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(filename(root), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return launchers.legacy;
    throw new Error('Nie mozna odczytac profilu startu. Sprawdz local-results\\broker-profile.json; nie zmieniono trybu.');
  }
  if (saved?.version !== 1 || !Object.hasOwn(launchers, saved.profile)) {
    throw new Error('Nieznany zapisany profil startu. Nie zmieniono trybu brokera.');
  }
  return launchers[saved.profile];
}

module.exports = { profileFromEnvironment, saveProfile, restartLauncher };
