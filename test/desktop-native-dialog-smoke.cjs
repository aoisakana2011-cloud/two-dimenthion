'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

const repo = path.resolve(__dirname, '..');
const dialogHelper = path.join(__dirname, 'desktop-native-folder-dialog.ps1');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForCdp(port, child) {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error(`Packaged editor exited before DevTools became available (code=${child.exitCode})`);
    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw Error(`Packaged editor DevTools did not start: ${lastError || endpoint}`);
}

async function waitForInspector(port, child) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error(`Packaged editor exited before the main-process inspector became available (code=${child.exitCode})`);
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((entry) => entry.type === 'node' && entry.webSocketDebuggerUrl);
        if (target) return target.webSocketDebuggerUrl;
      }
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw Error(`Packaged editor main-process inspector did not start: ${lastError || endpoint}`);
}

class InspectorClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Node inspector websocket timed out')), 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('Node inspector websocket failed')); }, { once: true });
    });
    const client = new InspectorClient(socket);
    await client.send('Runtime.enable');
    return client;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(Error(`Node inspector request timed out: ${method}`));
      }, 10_000);
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Node inspector evaluation failed');
    return response.result?.value;
  }

  close() { this.socket.close(); }
}

function runDialogHelper(processId, action, folderPath) {
  const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', dialogHelper, '-ProcessId', String(processId), '-Action', action];
  if (folderPath) args.push('-FolderPath', folderPath);
  const result = spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 35_000, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`Native dialog automation (${action}) failed:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

async function main() {
  if (process.platform !== 'win32') throw Error('The real native folder dialog smoke test requires Windows.');
  const supplied = path.resolve(process.argv[2] || path.join(repo, 'release', 'Novel Script Editor-win32-x64'));
  const executable = supplied.toLowerCase().endsWith('.exe') ? supplied : path.join(supplied, 'NovelScriptEditor.exe');
  const appRoot = path.dirname(executable);
  await fs.access(executable);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-dialog-smoke-'));
  const profile = path.join(tempRoot, 'user-data');
  const selectedProject = path.join(tempRoot, 'Selected Project');
  const layout = seedEmptyProject(selectedProject);
  const marker = `REAL_NATIVE_FOLDER_SELECTION_${process.pid}`;
  const unreachable = `native_dialog_only_unreachable_${process.pid}`;
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), [
    'scene main {',
    `  say narrator "${marker}"`,
    '  goto selected_scene',
    '}',
    'scene selected_scene { wait 1 }',
    `scene ${unreachable} { wait 1 }`,
    '',
  ].join('\n'));

  const debugPort = await availablePort();
  const inspectorPort = await availablePort();
  const serverPort = await availablePort();
  const env = { ...process.env, PORT: String(serverPort) };
  delete env.NOVEL_PROJECT_ROOT;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NOVEL_TEMP_STARTUP_WORKSPACE;

  let child;
  let browser;
  let inspector;
  let page;
  try {
    child = spawn(executable, [
      `--remote-debugging-port=${debugPort}`,
      '--remote-allow-origins=*',
      `--inspect=127.0.0.1:${inspectorPort}`,
      `--user-data-dir=${profile}`,
    ], { cwd: appRoot, env, windowsHide: false, stdio: ['ignore', 'ignore', 'ignore'] });
    await waitForCdp(debugPort, child);
    inspector = await InspectorClient.connect(await waitForInspector(inspectorPort, child));
    const mainState = JSON.parse(await inspector.evaluate(`(() => { const { app, BrowserWindow, ipcMain } = process.mainModule.require('electron'); const win = BrowserWindow.getAllWindows()[0]; return JSON.stringify({ pid: process.pid, main: process.mainModule.filename, electron: process.versions.electron, ready: app.isReady(), windows: BrowserWindow.getAllWindows().length, visible: win?.isVisible(), focused: win?.isFocused(), selectHandler: ipcMain._invokeHandlers?.has('novel-editor:select-folder') }); })()`));
    assert.equal(mainState.selectHandler, true, `packaged main process did not register the folder IPC handler: ${JSON.stringify(mainState)}`);
    await inspector.evaluate(`(() => { const d = process.mainModule.require('electron').dialog; const original = d.showOpenDialog; globalThis.__nativeDialogProbe = { called: false, settled: false }; d.showOpenDialog = (...args) => { globalThis.__nativeDialogProbe.called = true; return Promise.resolve(original(...args)).then((value) => { globalThis.__nativeDialogProbe.settled = true; globalThis.__nativeDialogProbe.result = value; return value; }, (error) => { globalThis.__nativeDialogProbe.settled = true; globalThis.__nativeDialogProbe.error = String(error); throw error; }); }; return 'instrumented'; })()`);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const context = browser.contexts()[0];
    assert.ok(context, 'packaged Electron did not expose a browser context');
    page = context.pages()[0] || await context.waitForEvent('page', { timeout: 30_000 });
    assert.ok(page, 'packaged Electron window did not expose a page');
    await page.waitForSelector('#editor', { timeout: 30_000 });
    assert.equal(await page.evaluate(() => typeof window.novelDesktop?.selectFolder === 'function'), true, 'packaged preload did not expose the real folder-dialog bridge');
    await page.evaluate(() => {
      window.__nativeDialogWorkspaceEvents = [];
      window.addEventListener('novel-editor:workspace-ready', (event) => window.__nativeDialogWorkspaceEvents.push(event.detail));
    });
    const initialProject = await page.evaluate(async () => (await (await fetch('/api/project')).json()).projectRoot);
    await inspector.evaluate(`(() => { globalThis.__nativeDialogProbe = { called: false, settled: false }; return true; })()`);

    await page.bringToFront();
    await page.evaluate(() => {
      window.__nativeDialogResult = { settled: false, value: undefined };
      window.novelDesktop.selectFolder().then(
        (value) => { window.__nativeDialogResult = { settled: true, value }; },
        (error) => { window.__nativeDialogResult = { settled: true, error: String(error) }; },
      );
    });
    let dialogSnapshot;
    try { dialogSnapshot = runDialogHelper(child.pid, 'inspect'); }
    catch (error) {
      const nativeBridgeState = await page.evaluate(() => window.__nativeDialogResult);
      const nativeMainState = await inspector.evaluate('JSON.stringify(globalThis.__nativeDialogProbe)');
      throw Error(`${error.message}\nNative bridge state: ${JSON.stringify(nativeBridgeState)}\nNative main state: ${nativeMainState}`);
    }
    console.log(`Native dialog UIA: ${JSON.stringify({ Name: dialogSnapshot.Name, ClassName: dialogSnapshot.ClassName, Controls: dialogSnapshot.Controls.filter(({ AutomationId }) => ['1152', '1', '2'].includes(AutomationId)).map(({ Name, ClassName, Type, AutomationId, Enabled }) => ({ Name, ClassName, Type, AutomationId, Enabled })) })}`);
    const cancelled = runDialogHelper(child.pid, 'cancel');
    assert.equal(cancelled.Action, 'cancel');
    await page.waitForFunction(() => window.__nativeDialogResult?.settled === true);
    assert.equal(await page.evaluate(() => window.__nativeDialogResult.value), null, 'cancelling the OS dialog must return no selected path');
    await page.waitForFunction(async (expected) => (await (await fetch('/api/project')).json()).projectRoot === expected, initialProject);
    assert.equal(await page.evaluate(() => window.__nativeDialogWorkspaceEvents.length), 0, 'cancelling the OS dialog must leave the current workspace untouched');

    await page.locator('[data-menu="file"]').click();
    await page.locator('[data-menu-action="open-project"]').click();
    const selected = runDialogHelper(child.pid, 'select', selectedProject);
    assert.equal(selected.Folder, selectedProject);
    await page.waitForFunction(async (expected) => (await (await fetch('/api/project')).json()).projectRoot === expected, selectedProject);
    await page.waitForFunction((expected) => window.__nativeDialogWorkspaceEvents.some((event) => event.projectRoot === expected && event.scenes.includes('main.tds')), selectedProject);
    await page.waitForFunction((expected) => document.querySelector('#editor')?.value.includes(expected), marker);
    await page.waitForFunction((expected) => document.querySelector('#result')?.textContent.includes(expected), unreachable);
    assert.equal(await page.locator('#scene-name').inputValue(), 'main.tds');
    console.log(`PASS real packaged folder dialog: cancel preserved ${initialProject}; selected ${selectedProject}; workspace and diagnostics refreshed`);
  } finally {
    if (page) await page.evaluate(() => window.close()).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    inspector?.close();
    await stopProcess(child);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
