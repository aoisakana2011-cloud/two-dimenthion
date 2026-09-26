const { app, BrowserWindow, dialog, Menu, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { prepareStartupWorkspace, removeStartupWorkspace } = require('./packaged-project');
const { findStartupProject } = require('./recent-projects');

Menu.setApplicationMenu(null);

const projectRoot = path.resolve(__dirname, '..');
const serverPath = path.join(__dirname, 'server.js');
let editorServer = null;
let mainWindow = null;
let quitting = false;
let closeSavePending = false;
let startupWorkspace = '';
let temporaryStartupWorkspace = false;

async function startEditorServer() {
  const selectedProject = await findStartupProject(process.env.NOVEL_PROJECT_ROOT);
  temporaryStartupWorkspace = !selectedProject;
  const projectRoot = selectedProject || (startupWorkspace = prepareStartupWorkspace(app.getPath('temp')));
  return new Promise((resolve, reject) => {
    editorServer = spawn(process.execPath, [serverPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NOVEL_PROJECT_ROOT: projectRoot,
        ...(temporaryStartupWorkspace ? { NOVEL_TEMP_STARTUP_WORKSPACE: '1' } : {}),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const readOutput = (chunk) => {
      output += String(chunk);
      const match = output.match(/Novel Script Editor:\s*(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        console.log(`Desktop editor: ${match[1]}`);
        resolve(match[1]);
      }
    };
    editorServer.stdout.on('data', readOutput);
    editorServer.stderr.on('data', readOutput);
    editorServer.once('error', reject);
    editorServer.once('exit', (code) => {
      if (!quitting) reject(new Error('エディターサーバーが終了しました (code: ' + (code ?? 'unknown') + ')'));
    });
  });
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    icon: path.join(__dirname, 'assets', 'desktop-icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#181818', symbolColor: '#cccccc', height: 34 },
    backgroundColor: '#1f1f1f',
    title: '.tds Edit',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (closeSavePending) return;
    closeSavePending = true;
    mainWindow.setEnabled(false);
    mainWindow.webContents.executeJavaScript('window.novelEditorApi?.saveAll ? window.novelEditorApi.saveAll() : Promise.resolve()')
      .then(() => {
        quitting = true;
        mainWindow.destroy();
      })
      .catch(async (error) => {
        closeSavePending = false;
        if (!mainWindow.isDestroyed()) mainWindow.setEnabled(true);
        await dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'Save failed',
          message: 'The editor could not save your changes. The window will stay open.',
          detail: error instanceof Error ? error.message : String(error),
        });
      });
  });
  const editorUrl = new URL(url);
  editorUrl.searchParams.set('desktop', '1');
  mainWindow.loadURL(editorUrl.toString());
}

ipcMain.handle('novel-editor:select-folder', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'フォルダーを開く',
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0] || null;
});

app.whenReady().then(async () => {
  try {
    createWindow(await startEditorServer());
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: '.tds Edit を起動できません',
      message: error instanceof Error ? error.message : String(error),
    });
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault();
    mainWindow.close();
    return;
  }
  quitting = true;
  if (startupWorkspace) {
    event.preventDefault();
    const workspace = startupWorkspace;
    startupWorkspace = '';
    const cleanup = () => {
      removeStartupWorkspace(app.getPath('temp'), workspace);
      app.quit();
    };
    if (editorServer?.pid && editorServer.exitCode === null) {
      editorServer.once('exit', cleanup);
      editorServer.kill();
    } else cleanup();
    return;
  }
  editorServer?.kill();
});
