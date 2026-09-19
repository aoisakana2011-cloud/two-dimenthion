const { spawn } = require('node:child_process');
const path = require('node:path');

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const electron = spawn(require('electron'), [path.join(__dirname, 'electron-main.js')], {
  cwd: path.resolve(__dirname, '..'),
  env: environment,
  stdio: 'inherit',
  windowsHide: false,
});

electron.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
