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
  let server, browser, fallbackContext;
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
    await page.locator('#text').filter({ hasText: 'Write your story here.' }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="save"]').first().click();
    const slot = page.locator('#screen-overlay [data-slot-index="0"]');
    await slot.waitFor();
    assert.equal(await page.locator('#screen-overlay [data-slot-index]').count(), 12);
    assert.equal(await slot.locator('[data-slot-field="number"]').textContent(), '01');
    assert.equal(await slot.locator('[data-slot-field="status"]').textContent(), '空き');
    assert.equal(await slot.isDisabled(), false);
    await slot.click();
    await page.locator('#screen-overlay [data-action="slot-commit"]').click();
    await page.locator('#screen-overlay .game-screen-notice').waitFor();
    const savedPosition = await page.evaluate(async () => {
      const saved = JSON.parse(await saveStore.readSlot(0));
      return { file: saved.file, scene: saved.scene, line: saved.line };
    });
    assert.equal(await slot.locator('[data-slot-field="status"]').textContent(), '記録あり');
    assert.match(await slot.locator('[data-slot-field="text"]').textContent(), /Write your story here/);
    assert.ok((await slot.locator('[data-slot-field="saved-at"]').textContent()).length > 0);
    assert.equal(await page.evaluate(async () => (await saveStore.readThumbnail(0))?.type), 'image/png');
    assert.ok(await slot.locator('[data-slot-field="thumbnail"]').evaluate(image => image.complete && image.naturalWidth > 0), 'save card displays the captured game frame');
    const thumbnailDiff = await page.evaluate(async () => {
      const saved = await createImageBitmap(await saveStore.readThumbnail(0));
      const withoutDialogue = await createImageBitmap(await captureSaveThumbnail(false));
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(saved, 0, 0); const withPixels = context.getImageData(0, 0, 320, 180).data;
      context.clearRect(0, 0, 320, 180); context.drawImage(withoutDialogue, 0, 0); const withoutPixels = context.getImageData(0, 0, 320, 180).data;
      let changed = 0;
      for (let i = 0; i < withPixels.length; i += 4) if (Math.abs(withPixels[i] - withoutPixels[i]) + Math.abs(withPixels[i + 1] - withoutPixels[i + 1]) + Math.abs(withPixels[i + 2] - withoutPixels[i + 2]) > 36) changed++;
      return { changed, width: saved.width, height: saved.height, textValue: document.querySelector('#text').textContent };
    });
    assert.equal(thumbnailDiff.width, 320);
    assert.equal(thumbnailDiff.height, 180);
    assert.ok(thumbnailDiff.changed > 100, 'save preview must composite dialogue text on the underlying scene: ' + JSON.stringify(thumbnailDiff));
    assert.match(await page.evaluate(async () => (await saveStore.readMetadata(0))?.text), /Write your story/);
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
    const protectedSlot = page.locator('#screen-overlay [data-slot-index="0"]');
    await protectedSlot.click();
    await page.locator('#screen-overlay [data-action="slot-lock"]').click();
    await page.waitForFunction(() => document.querySelector('#screen-overlay [data-action="slot-lock"]')?.textContent === 'ロック解除');
    assert.match(await protectedSlot.locator('[data-slot-field="status"]').textContent(), /🔒/);
    await page.waitForFunction(() => !document.querySelector('#screen-overlay [data-action="slot-copy"]')?.disabled);
    await page.locator('#screen-overlay [data-action="slot-copy"]').click();
    await page.waitForFunction(async () => Boolean(await saveStore.readSlot(3)));
    assert.ok(await page.evaluate(async () => Boolean(await saveStore.readSlot(3))), 'copy skips damaged and foreign saves');
    await page.locator('#screen-overlay [data-slot-index="0"]').click();
    assert.equal(await page.locator('#screen-overlay [data-action="slot-move"]').isDisabled(), true);
    await page.locator('#screen-overlay [data-action="slot-lock"]').click();
    await page.waitForFunction(() => document.querySelector('#screen-overlay [data-action="slot-lock"]')?.textContent === 'ロック');
    await page.waitForFunction(() => !document.querySelector('#screen-overlay [data-action="slot-move"]')?.disabled);
    await page.locator('#screen-overlay [data-action="slot-move"]').click();
    await page.waitForFunction(async () => await saveStore.readSlot(0) === null);
    assert.equal(await page.evaluate(async () => await saveStore.readSlot(0)), null);
    const copiedSlot = page.locator('#screen-overlay [data-slot-index="3"]');
    await copiedSlot.click();
    await page.locator('#screen-overlay [data-action="slot-lock"]').click();
    await page.waitForFunction(() => document.querySelector('#screen-overlay [data-action="slot-lock"]')?.textContent === 'ロック');
    await page.locator('#screen-overlay [data-action="slot-delete"]').click();
    assert.ok(await page.evaluate(async () => Boolean(await saveStore.readSlot(3))), 'first delete click only arms confirmation');
    await page.locator('#screen-overlay [data-action="slot-delete"]').click();
    await page.waitForFunction(async () => await saveStore.readSlot(3) === null);
    assert.equal(await page.evaluate(async () => await saveStore.readSlot(3)), null);
    const movedSlot = page.locator('#screen-overlay [data-slot-index="4"]');
    await movedSlot.click();
    await page.locator('#screen-overlay [data-action="slot-commit"]').click();
    await page.locator('#screen-overlay', { hasText: '' }).waitFor({ state: 'hidden' });
    await page.locator('#text').filter({ hasText: 'Write your story here.' }).waitFor();
    await page.goto(`${base}/player.html`);
    assert.equal(await page.locator('#screen-overlay [data-action="continue"]').isDisabled(), false);
    await page.locator('#screen-overlay [data-action="continue"]').click();
    await page.locator('#text').filter({ hasText: 'Write your story here.' }).waitFor();
    await page.waitForFunction(expected => {
      const execution = currentExecution;
      return execution && execution.file === expected.file && execution.scene === expected.scene && execution.line === expected.line;
    }, savedPosition);
    assert.deepEqual(errors, []);

    fallbackContext = await browser.newContext();
    await fallbackContext.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', {
        configurable: true,
        value: { open() { throw new DOMException('IndexedDB disabled for fallback coverage', 'SecurityError'); } },
      });
    });
    let fallbackPage = await fallbackContext.newPage();
    fallbackPage.setDefaultTimeout(10000);
    const fallbackErrors = [];
    fallbackPage.on('pageerror', error => fallbackErrors.push(error.message));
    await fallbackPage.goto(`${base}/player.html`);
    await fallbackPage.locator('#screen-overlay [data-action="start"]').waitFor();
    assert.equal(await fallbackPage.evaluate(() => saveStore.backend), 'localStorage', 'a rejected IndexedDB open selects the localStorage backend');
    await fallbackPage.locator('#screen-overlay [data-action="start"]').click();
    await fallbackPage.locator('#text').filter({ hasText: 'Write your story here.' }).waitFor();
    await fallbackPage.keyboard.press('Escape');
    await fallbackPage.locator('#screen-overlay [data-action="save"]').first().click();
    const fallbackSlot = fallbackPage.locator('#screen-overlay [data-slot-index="0"]');
    await fallbackSlot.waitFor();
    await fallbackSlot.click();
    await fallbackPage.locator('#screen-overlay [data-action="slot-commit"]').click();
    await fallbackPage.locator('#screen-overlay .game-screen-notice').waitFor();
    assert.match(await fallbackPage.locator('#screen-overlay .data-hint').textContent(), /Browser storage fallbackを使用中のため、再読み込み後はthumbnail preview/,
      'the save screen explains why the fallback backend cannot keep thumbnail previews');
    const fallbackSavedPosition = await fallbackPage.evaluate(async () => ({
      execution: { file: currentExecution.file, scene: currentExecution.scene, line: currentExecution.line },
      encoded: await saveStore.readSlot(0),
      thumbnail: await saveStore.readThumbnail(0),
      metadata: await saveStore.readMetadata(0),
    }));
    assert.ok(fallbackSavedPosition.encoded, 'localStorage fallback persists the snapshot');
    assert.equal(fallbackSavedPosition.thumbnail, null, 'localStorage fallback has no persistent thumbnail store');
    assert.equal(fallbackSavedPosition.metadata, null, 'localStorage fallback has no separate metadata store');
    assert.match(await fallbackSlot.locator('[data-slot-field="thumbnail"]').getAttribute('src'), /^blob:/,
      'the freshly saved thumbnail is shown from the current page memory');
    const fallbackStorageState = await fallbackContext.storageState();
    await fallbackContext.close();
    fallbackContext = await browser.newContext({ storageState: fallbackStorageState });
    await fallbackContext.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', {
        configurable: true,
        value: { open() { throw new DOMException('IndexedDB disabled for fallback coverage', 'SecurityError'); } },
      });
    });
    fallbackPage = await fallbackContext.newPage();
    fallbackPage.setDefaultTimeout(10000);
    fallbackPage.on('pageerror', error => fallbackErrors.push(error.message));
    await fallbackPage.goto(`${base}/player.html`);
    await fallbackPage.locator('#screen-overlay [data-action="start"]').waitFor();
    assert.equal(await fallbackPage.evaluate(() => saveStore.backend), 'localStorage');
    await fallbackPage.locator('#screen-overlay [data-action="load"]').click();
    const reloadedFallbackSlot = fallbackPage.locator('#screen-overlay [data-slot-index="0"]');
    await reloadedFallbackSlot.waitFor();
    assert.match(await fallbackPage.locator('#screen-overlay .data-hint').textContent(), /Browser storage fallbackを使用中のため、再読み込み後はthumbnail preview/,
      'the load screen explains that thumbnails do not survive reload in this backend');
    assert.equal(await reloadedFallbackSlot.isDisabled(), false, 'the fallback snapshot remains loadable after reload');
    assert.equal(await reloadedFallbackSlot.locator('[data-slot-field="thumbnail"]').getAttribute('src'), null,
      'the fallback UI does not claim a thumbnail persisted across reload');
    await reloadedFallbackSlot.click();
    await fallbackPage.locator('#screen-overlay [data-action="slot-commit"]').click();
    await fallbackPage.locator('#screen-overlay').waitFor({ state: 'hidden' });
    await fallbackPage.waitForFunction(expected => {
      const execution = currentExecution;
      return execution && execution.file === expected.file && execution.scene === expected.scene && execution.line === expected.line;
    }, fallbackSavedPosition.execution);
    assert.deepEqual(fallbackErrors, [], `localStorage fallback emitted Browser errors: ${fallbackErrors.join('\n')}`);
    console.log('PASS Browser save-card template, bound fields, save and load');
  } finally {
    await fallbackContext?.close();
    await browser?.close();
    if (server) { server.kill(); await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 2000); } }); }
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
