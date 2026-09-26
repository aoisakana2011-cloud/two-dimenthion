'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(child, getOutput) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw Error(`Electron exited before starting the editor:\n${getOutput()}`);
    const match = /Desktop editor: (http:\/\/127\.0\.0\.1:\d+)/.exec(getOutput());
    if (match) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(`Electron startup timed out:\n${getOutput()}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-recent-startup-smoke-'));
  const project = seedEmptyProject(path.join(tempRoot, 'remembered-project'));
  const recentFile = path.join(tempRoot, 'profile', 'recent.json');
  const debugPort = await availablePort();
  await fs.mkdir(path.dirname(recentFile), { recursive: true });
  await fs.writeFile(recentFile, JSON.stringify({ paths: [project.projectRoot] }));

  const env = { ...process.env, PORT: '0', NOVEL_EDITOR_RECENT_FILE: recentFile };
  delete env.NOVEL_PROJECT_ROOT;
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = spawn(require('electron'), [`--remote-debugging-port=${debugPort}`, path.join(__dirname, '..', 'Edit', 'electron-main.js')], {
    cwd: path.resolve(__dirname, '..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collect = (chunk) => { output = (output + String(chunk)).slice(-16_000); };
  electron.stdout.on('data', collect);
  electron.stderr.on('data', collect);
  let browser;
  try {
    const editorUrl = await waitForServer(electron, () => output);
    const activeProject = await (await fetch(`${editorUrl}/api/project`)).json();
    assert.equal(activeProject.projectRoot, project.projectRoot, 'the server starts directly in the most recently opened project');

    const deadline = Date.now() + 15_000;
    while (!browser && Date.now() < deadline) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`); }
      catch { await new Promise((resolve) => setTimeout(resolve, 150)); }
    }
    assert.ok(browser, `Electron DevTools did not become available:\n${output}`);
    let page;
    const pageDeadline = Date.now() + 10_000;
    while (!page && Date.now() < pageDeadline) {
      page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith(editorUrl));
      if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(page, 'Electron opened the editor window');
    assert.equal(new URL(page.url()).searchParams.has('welcome'), false, 'startup opens the ordinary editor');
    assert.equal(await page.locator('#project-picker').count(), 0, 'the custom folder picker is removed');
    await page.waitForFunction(() => Boolean(document.querySelector('#scene-name')?.value));
    console.log(`PASS Electron recent-project startup: ${activeProject.projectRoot}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopChild(electron);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
