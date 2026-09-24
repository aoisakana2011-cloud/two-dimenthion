const { app, BrowserWindow, dialog, Menu } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

Menu.setApplicationMenu(null);

const projectRoot = path.resolve(__dirname, '..');
const serverPath = path.join(__dirname, 'server.js');
let editorServer = null;
let mainWindow = null;
let quitting = false;
let closeSavePending = false;

function startEditorServer() {
  return new Promise((resolve, reject) => {
    const packagedProject = path.join(app.getPath('documents'), 'Novel Script Projects', 'Title');
    editorServer = spawn(process.execPath, [serverPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...(app.isPackaged && !process.env.NOVEL_PROJECT_ROOT ? { NOVEL_PROJECT_ROOT: packagedProject } : {}),
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
  editorServer?.kill();
});
