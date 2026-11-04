const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { profileFromEnvironment, saveProfile, restartLauncher } = require('../launch-profile');

test('restart keeps the selected production, preview, reservations or legacy profile across processes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker profile '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(restartLauncher(root), 'start-pos.cmd');
  for (const [environment, online, profile, launcher] of [
    ['production', 'true', 'online-production', 'start-online-production.cmd'],
    ['preview', 'true', 'online-preview', 'start-online-preview.cmd'],
    ['production', 'false', 'production-reservations', 'start-production-reservations.cmd'],
  ]) {
    const selected = profileFromEnvironment({ FISCAL_ENVIRONMENT: environment, FISCAL_BRANCH_ID: '1',
      FISCAL_ONLINE_ENABLED: online, FISCAL_REQUIRE_POS_RESERVATION: 'true' });
    assert.equal(selected, profile);
    saveProfile(root, selected);
    assert.equal(restartLauncher(root), launcher);
  }
  saveProfile(root, profileFromEnvironment({ FISCAL_ONLINE_ENABLED: 'false', FISCAL_REQUIRE_POS_RESERVATION: 'false' }));
  assert.equal(restartLauncher(root), 'start-pos.cmd');
});

test('invalid profiles fail closed and never replace the selected profile', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker profile '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  saveProfile(root, 'online-production');
  assert.throws(() => saveProfile(root, 'constructor'));
  assert.equal(restartLauncher(root), 'start-online-production.cmd');
  for (const value of ['broken json', '{"version":2,"profile":"legacy"}', '{"version":1,"profile":"x & calc.exe"}']) {
    fs.writeFileSync(path.join(root, 'local-results', 'broker-profile.json'), value);
    assert.throws(() => restartLauncher(root));
  }
  for (const env of [
    { FISCAL_ONLINE_ENABLED: 'true' },
    { FISCAL_ONLINE_ENABLED: 'true', FISCAL_REQUIRE_POS_RESERVATION: 'true', FISCAL_ENVIRONMENT: 'production', FISCAL_BRANCH_ID: '2' },
    { FISCAL_DIAGNOSTICS_ONLY: 'true', FISCAL_ONLINE_ENABLED: 'true' },
  ]) assert.throws(() => profileFromEnvironment(env));
});
