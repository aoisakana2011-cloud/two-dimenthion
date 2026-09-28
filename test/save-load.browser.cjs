'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

const root = path.resolve(__dirname, '..');

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-save-load-'));
  const project = seedEmptyProject(path.join(tempRoot, 'project'));
  await fs.writeFile(path.join(project.scenesRoot, 'main.tds'), [
    'global int counter = 0',
    'scene main {',
    '  set counter = counter + 1',
    '  choice "continue?" {',
    '    "yes" {',
    '      int local_counter = 7',
    '      say narrator "checkpoint"',
    '      set local_counter = local_counter + 1',
    '      say narrator str(local_counter)',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(project.settingsRoot, 'game-screens.json'), JSON.stringify({
    version: 1, initial: 'title',
    screens: { title: { title: 'Test', items: [{ id: 'start', type: 'button', label: 'Start', action: 'start', x: 30, y: 30, width: 180, height: 48 }] } },
  }, null, 2), 'utf8');
  const child = spawn(process.execPath, [path.join(root, 'Edit/server.js'), '--project', project.projectRoot], {
    cwd: root, env: { ...process.env, PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  let browser;
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`server start timeout: ${output}`)), 15000);
      const find = () => { const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } };
      child.stdout.on('data', find); child.stderr.on('data', find); child.once('exit', code => { clearTimeout(timer); reject(Error(`server exited ${code}: ${output}`)); }); find();
    });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'Start' }).click();
    await page.locator('#choices .choice').first().click();
    await page.locator('#text').filter({ hasText: 'checkpoint' }).waitFor();
    await page.locator('#player-controls [data-action="save"]').click();
    const slot = page.locator('.game-save-slot').first();
    await slot.waitFor();
    assert.equal(await slot.isDisabled(), false, 'save slot is active at a dialogue instruction');
    await slot.click();
    await page.locator('.game-screen-notice').waitFor();
    const stored = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(item => item.includes(':game:slot:'));
      return key ? JSON.parse(localStorage.getItem(key)) : null;
    });
    assert.equal(stored.version, 1);
    assert.equal(stored.scene, 'main');
    assert.equal(stored.text, 'checkpoint');
    assert.deepEqual(stored.variables.counter, { __novelInteger: '1' }, '64-bit integer values are stored losslessly');
    assert.deepEqual(stored.locals[0].local_counter, { __novelInteger: '7' }, 'active choice-local variables are persisted alongside globals');
    await page.locator('#screen-overlay .game-screen-button').first().click();
    await page.locator('#screen-overlay').waitFor({ state: 'hidden' });
    await page.locator('#player-controls [data-action="load"]').click();
    const loadSlot = page.locator('.game-save-slot').first();
    await loadSlot.waitFor();
    assert.equal(await loadSlot.isDisabled(), false);
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), loadSlot.click()]);
    await page.locator('#text').filter({ hasText: 'checkpoint' }).waitFor();
    await page.locator('#next').click();
    await page.locator('#text').filter({ hasText: '8' }).waitFor();
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS browser save/load: slot persistence, dialogue resume, variables and scene cursor');
  } finally {
    await browser?.close();
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
