'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { removeStartupWorkspace } = require('../Edit/packaged-project');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  const appRoot = path.resolve(process.argv[2] || 'release/Novel Script Editor-win32-x64');
  const executable = path.join(appRoot, 'NovelScriptEditor.exe');
  await fs.access(executable);
  const port = await availablePort();
  const env = { ...process.env, PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NOVEL_PROJECT_ROOT;

  let child;
  let startupWorkspace = '';
  let output = '';
  try {
    child = spawn(executable, [], { cwd: appRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (chunk) => { output = (output + String(chunk)).slice(-12_000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Packaged editor did not report its server URL.\n${output}`)), 20_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); reject(Error(`Packaged editor exited before startup (code=${code}, signal=${signal}).\n${output}`)); });
      const poll = setInterval(() => {
        const match = /Desktop editor: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (!match) return;
        clearInterval(poll);
        clearTimeout(timer);
        resolve(match[1]);
      }, 100);
    });
    const response = await fetch(url);
    const html = await response.text();
    assert.equal(response.status, 200, `editor page request failed: ${response.status}`);
    assert.match(html, /app-shell/, 'packaged editor HTML was not served');
    const project = await (await fetch(`${url}/api/project`)).json();
    startupWorkspace = project.projectRoot;
    assert.equal(path.dirname(startupWorkspace), os.tmpdir());
    assert.match(path.basename(startupWorkspace), /^novel-editor-startup-/);
    assert.equal(project.recent?.includes(startupWorkspace), false, 'internal startup workspaces must not appear in recent projects');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(child.exitCode, null, 'desktop process must remain alive while its window is open');
    console.log(`PASS packaged desktop startup: ${url}, PID ${child.pid}, temporary workspace ${startupWorkspace}`);
  } finally {
    if (child && child.exitCode === null) {
      const stopped = new Promise((resolve) => child.once('exit', resolve));
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
      await stopped;
    }
    if (startupWorkspace) removeStartupWorkspace(os.tmpdir(), startupWorkspace);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
