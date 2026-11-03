const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('Windows CMD launchers select safe modes, load local config, and support spaces in the folder',
  { skip: process.platform !== 'win32' }, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker cmd test '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, 'npm.cmd'), '@echo off\r\nnode "%~dp0record-env.js" %*\r\n');
    fs.writeFileSync(path.join(directory, 'record-env.js'), `require('fs').writeFileSync('observed.json',JSON.stringify({
      args:process.argv.slice(2),cwd:process.cwd(),diagnostics:process.env.FISCAL_DIAGNOSTICS_ONLY,
      online:process.env.FISCAL_ONLINE_ENABLED,required:process.env.FISCAL_REQUIRE_POS_RESERVATION,
      origins:process.env.FISCAL_ALLOWED_ORIGINS,port:process.env.FISCAL_SERIAL_PORT}));`);
    fs.writeFileSync(path.join(directory, 'broker-local.cmd'), '@echo off\r\nset "FISCAL_ALLOWED_ORIGINS=https://pos.example.test"\r\nset "FISCAL_SERIAL_PORT=COM7"\r\nset "FISCAL_ONLINE_ENABLED=true"\r\n');
    for (const [filename, diagnostics, required] of [
      ['start-diagnostics.cmd', 'true', 'false'], ['start-pos.cmd', 'false', 'false'], ['start-reservation-test.cmd', 'false', 'true'],
    ]) {
      fs.copyFileSync(path.join(__dirname, '..', filename), path.join(directory, filename));
      const child = spawnSync('cmd.exe', ['/d', '/c', filename], { cwd: directory, encoding: 'utf8' });
      assert.equal(child.status, 0, child.stdout + child.stderr);
      const observed = JSON.parse(fs.readFileSync(path.join(directory, 'observed.json'), 'utf8'));
      assert.equal(observed.cwd, directory);
      assert.deepEqual(observed.args, ['start']);
      assert.equal(observed.diagnostics, diagnostics);
      assert.equal(observed.required, required);
      assert.equal(observed.online, 'false');
      assert.equal(observed.origins, 'https://pos.example.test');
      assert.equal(observed.port, 'COM7');
    }
  });
