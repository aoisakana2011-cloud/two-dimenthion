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
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-slot-card-'));
  let server, browser;
  try {
    const project = seedEmptyProject(path.join(temporary, 'project'));
    const screensRoot = path.join(root, 'Title', 'setting');
    const config = JSON.parse(await fs.readFile(path.join(screensRoot, 'game-screens.json'), 'utf8'));
    await fs.writeFile(path.join(project.settingsRoot, 'game-screens.json'), JSON.stringify(config));
    for (const name of new Set([config.stylesheet, config.controlSettings, ...Object.values(config.screens).map(screen => screen.template)].filter(Boolean))) {
      const target = path.join(project.settingsRoot, ...name.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(screensRoot, ...name.split('/')), target);
    }
    const source = path.join(root, 'Title', 'asset', 'bg');
    const backgrounds = path.join(project.assetsRoot, 'bg');
    await fs.mkdir(backgrounds, { recursive: true });
    for (const file of ['title.png', 'near_home.jpg', 'school.jpg']) await fs.copyFile(path.join(source, file), path.join(backgrounds, file));
    server = spawn(process.execPath, [path.join(root, 'Edit', 'server.js'), '--project', project.projectRoot], {
      cwd: root, env: { ...process.env, PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    server.stdout.on('data', chunk => { output += chunk; });
    server.stderr.on('data', chunk => { output += chunk; });
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`server timeout: ${output}`)), 15000);
      const check = () => { const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } };
      server.stdout.on('data', check); server.once('exit', code => { clearTimeout(timer); reject(Error(`server exit ${code}: ${output}`)); }); check();
    });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/player.html`);
    assert.equal(await page.locator('#screen-overlay [data-action="continue"]').isDisabled(), true);
    await page.locator('#screen-overlay [data-action="start"]').click();
    await page.locator('#text').filter({ hasText: '新しい作品を始めます。' }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="save"]').first().click();
    const slot = page.locator('#screen-overlay [data-slot-index="0"]');
    await slot.waitFor();
    assert.equal(await page.locator('#screen-overlay [data-slot-index]').count(), 12);
    assert.equal(await slot.locator('[data-slot-field="number"]').textContent(), '01');
    assert.equal(await slot.locator('[data-slot-field="status"]').textContent(), '空き');
    assert.equal(await slot.isDisabled(), false);
    await slot.click();
    await page.locator('#screen-overlay .game-screen-notice').waitFor();
    assert.equal(await slot.locator('[data-slot-field="status"]').textContent(), '記録あり');
    assert.match(await slot.locator('[data-slot-field="text"]').textContent(), /新しい作品を始めます/);
    assert.ok((await slot.locator('[data-slot-field="saved-at"]').textContent()).length > 0);
    assert.equal(await page.evaluate(async () => (await saveStore.readThumbnail(0))?.type), 'image/png');
    assert.match(await page.evaluate(async () => (await saveStore.readMetadata(0))?.text), /新しい作品/);
    if (process.env.NOVEL_SCREEN_CAPTURE_DIR) {
      await fs.mkdir(process.env.NOVEL_SCREEN_CAPTURE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.NOVEL_SCREEN_CAPTURE_DIR, 'save-card.png') });
    }
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="load"]').first().click();
    const load = page.locator('#screen-overlay [data-slot-index="0"]');
    await load.waitFor();
    assert.equal(await load.isDisabled(), false);
    assert.equal(await page.locator('#screen-overlay [data-slot-index="1"]').isDisabled(), true);
    await page.evaluate(async () => {
      await saveStore.writeSlot(1, JSON.stringify({ version: 1, scene: 'broken', line: 1, variables: {} }));
      const foreign = JSON.parse(await saveStore.readSlot(0)); foreign.saveId = 'another-work';
      await saveStore.writeSlot(2, JSON.stringify(foreign));
    });
    await page.reload();
    await page.locator('#screen-overlay [data-action="continue"]').waitFor();
    await page.locator('#screen-overlay [data-action="load"]').first().click();
    assert.equal(await page.locator('#screen-overlay [data-slot-index="1"]').isDisabled(), true, 'malformed save files are not shown as loadable');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="2"]').isDisabled(), true, 'saves from another work are not loadable');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="1"] [data-slot-field="status"]').textContent(), '破損');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="2"] [data-slot-field="status"]').textContent(), '非対応');
    assert.match(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="thumbnail"]').getAttribute('src'), /^blob:/);
    await load.click();
    await page.locator('#screen-overlay', { hasText: '' }).waitFor({ state: 'hidden' });
    await page.locator('#text').filter({ hasText: '新しい作品を始めます。' }).waitFor();
    await page.goto(`${base}/player.html`);
    assert.equal(await page.locator('#screen-overlay [data-action="continue"]').isDisabled(), false);
    await page.locator('#screen-overlay [data-action="continue"]').click();
    await page.locator('#text').filter({ hasText: '新しい作品を始めます。' }).waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS Browser save-card template, bound fields, save and load');
  } finally {
    await browser?.close();
    if (server) { server.kill(); await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 2000); } }); }
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
