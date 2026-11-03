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
      origins:process.env.FISCAL_ALLOWED_ORIGINS,port:process.env.FISCAL_SERIAL_PORT,
      environment:process.env.FISCAL_ENVIRONMENT,branch:process.env.FISCAL_BRANCH_ID}));`);
    // A real executable receives the app directory, as Electron's CLI does.
    // Node is the fixture executable so no printer or graphical session is needed.
    const fakeElectron = path.join(directory, 'node_modules', 'electron', 'dist', 'electron.exe');
    fs.mkdirSync(path.dirname(fakeElectron), { recursive: true });
    fs.copyFileSync(process.execPath, fakeElectron);
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ main: 'record-env.js' }));
    fs.writeFileSync(path.join(directory, 'broker-local.cmd'), '@echo off\r\nset "FISCAL_ALLOWED_ORIGINS=https://pos.example.test"\r\nset "FISCAL_SERIAL_PORT=COM7"\r\nset "FISCAL_ONLINE_ENABLED=false"\r\nset "FISCAL_ENVIRONMENT=production"\r\nset "FISCAL_BRANCH_ID=99"\r\n');
    for (const [filename, diagnostics, required, online = 'false'] of [
      ['start-diagnostics.cmd', 'true', 'false'], ['start-pos.cmd', 'false', 'false'], ['start-reservation-test.cmd', 'false', 'true'],
      ['start-online-preview.cmd', 'false', 'true', 'true'],
    ]) {
      fs.copyFileSync(path.join(__dirname, '..', filename), path.join(directory, filename));
      const child = spawnSync('cmd.exe', ['/d', '/c', filename], { cwd: directory, encoding: 'utf8' });
      assert.equal(child.status, 0, child.stdout + child.stderr);
      const observed = JSON.parse(fs.readFileSync(path.join(directory, 'observed.json'), 'utf8'));
      assert.equal(observed.cwd, directory);
      assert.deepEqual(observed.args, ['start-pos.cmd', 'start-online-preview.cmd'].includes(filename) ? [] : ['start']);
      assert.equal(observed.diagnostics, diagnostics);
      assert.equal(observed.required, required);
      assert.equal(observed.online, online);
      if (filename === 'start-online-preview.cmd') {
        assert.equal(observed.environment, 'preview');
        assert.equal(observed.branch, '1');
      }
      assert.equal(observed.origins, 'https://pos.example.test');
      assert.equal(observed.port, 'COM7');
    }
  });
