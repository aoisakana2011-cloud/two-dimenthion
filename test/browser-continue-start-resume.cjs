'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-browser-continue-start-'));
  let server, browser;
  try {
    const project = seedEmptyProject(path.join(temporary, 'project'));
    await fs.writeFile(path.join(project.scenesRoot, 'main.tds'), [
      'fn initialize() -> int {',
      '  start()',
      '  return 7',
      '}',
      'global int ready = initialize()',
      'scene main {',
      '  goto saved',
      '}',
      'scene saved {',
      '  say narrator str(ready)',
      '}',
      '',
    ].join('\n'), 'utf8');
    const screenPath = path.join(project.settingsRoot, 'game-screens.json');
    const screens = JSON.parse(await fs.readFile(screenPath, 'utf8'));
    screens.screens.title.items.push({ id: 'continue', type: 'button', label: 'Continue', action: 'continue', x: 64, y: 220, width: 300, height: 56 });
    await fs.writeFile(screenPath, JSON.stringify(screens, null, 2) + '\n', 'utf8');

    server = spawn(process.execPath, [path.join(root, 'Edit', 'server.js'), '--project', project.projectRoot], {
      cwd: root,
      env: { ...process.env, PORT: '0', NOVEL_EDITOR_RECENT_FILE: path.join(temporary, 'recent.json') },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    server.stdout.on('data', chunk => { output += String(chunk); });
    server.stderr.on('data', chunk => { output += String(chunk); });
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`server startup timed out: ${output}`)), 15_000);
      const check = () => {
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      };
      server.stdout.on('data', check);
      server.once('exit', code => { clearTimeout(timer); reject(Error(`server exited ${code}: ${output}`)); });
      check();
    });

    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    await page.goto(`${base}/player.html`);
    await page.waitForFunction(() => Boolean(document.querySelector('#screen-overlay .game-screen-button'))).catch(async error => {
      throw Error(`${error.message}\nPlayer state: ${JSON.stringify(await page.evaluate(() => ({ text: document.body.innerText, hidden: document.querySelector('#screen-overlay')?.hidden, overlay: document.querySelector('#screen-overlay')?.outerHTML, errors: [...document.querySelectorAll('.game-screen-error')].map(node => node.textContent) })))}\nServer: ${output}`);
    });
    assert.equal(await page.getByRole('button', { name: 'Continue' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Start' }).click();
    await page.locator('#text').getByText('7').waitFor();
    assert.equal(await page.evaluate(() => currentExecution.scene), 'saved');

    await page.evaluate(async () => saveGameToSlot(0, document.querySelector('#screen-overlay')));
    await page.waitForFunction(async () => Boolean(await saveStore.readSlot(0)));
    const saved = await page.evaluate(async () => JSON.parse(await saveStore.readSlot(0)));
    assert.equal(saved.scene, 'saved', 'the fixture must save after leaving the entry scene');

    await page.goto(`${base}/player.html`);
    await page.getByRole('button', { name: 'Continue' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Continue' }).isDisabled(), false);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.locator('#text').getByText('7').waitFor();
    await page.waitForFunction(() => currentExecution?.scene === 'saved');
    assert.equal(await page.locator('#screen-overlay').isHidden(), true,
      'resuming beyond the entry scene must suppress the global initializer start() instead of reopening Title');
    assert.deepEqual(errors, []);
    console.log('PASS Browser Continue resumes a non-entry save without reopening the global start screen');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server && server.exitCode === null) {
      if (process.platform === 'win32') require('node:child_process').spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true });
      else server.kill('SIGTERM');
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
