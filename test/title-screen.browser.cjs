'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');

const root = path.resolve(__dirname, '..');

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-title-browser-'));
  const child = spawn(process.execPath, [path.join(root, 'Edit/server.js'), '--project', path.join(root, 'Title')], {
    cwd: root, env: { ...process.env, PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  let browser;
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Title project server start timeout: ${output}`)), 15000);
      const find = () => { const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } };
      child.stdout.on('data', find); child.stderr.on('data', find); child.once('exit', code => { clearTimeout(timer); reject(Error(`Title project server exited ${code}: ${output}`)); }); find();
    });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const capture = async name => {
      if (!process.env.NOVEL_TITLE_SCREEN_CAPTURE_DIR) return;
      await fs.mkdir(process.env.NOVEL_TITLE_SCREEN_CAPTURE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.NOVEL_TITLE_SCREEN_CAPTURE_DIR, `${name}.png`) });
    };

    await page.goto(`${base}/player.html`);
    await page.waitForFunction(() => document.querySelector('#screen-overlay .title-logo') && !document.querySelector('#screen-overlay').hidden, null, { timeout: 15000 }).catch(async error => {
      const config = await (await page.request.get(`${base}/api/game-screens`)).text();
      throw Error(`Title screen did not open: ${error.message}; player text=${await page.locator('#text').textContent()}; config=${config.slice(0, 1000)}`);
    });
    await page.waitForFunction(() => { const image = document.querySelector('#screen-overlay .title-logo'); return image?.complete && image.naturalWidth > 0; });
    assert.equal(await page.locator('#screen-overlay .title-menu .title-item').count(), 6, 'the actual Title project renders its six semantic menu actions');
    assert.equal(await page.locator('#screen-overlay #title-continue').isDisabled(), true, 'Continue is unavailable without a save');
    assert.equal(await page.locator('#screen-overlay #title-continue').evaluate(node => getComputedStyle(node).opacity), '0.45', 'Browser dims unavailable actions like the Native renderer');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'title-start', 'keyboard focus skips the unavailable Continue action');
    assert.equal(await page.locator('#screen-overlay #title-start').evaluate(node => getComputedStyle(node).outlineStyle), 'none', 'Browser UA focus outline is normalized to the SDL renderer');
    assert.match(await page.locator('#screen-overlay #title-start').evaluate(node => getComputedStyle(node).backgroundImage), /sakura-menu-plate-hover-v2\.png/, 'the shared authored focus state remains visible after normalizing UA chrome');
    await capture('title');

    await page.locator('#screen-overlay #title-system').click();
    await page.locator('#screen-overlay .system-options').waitFor();
    assert.equal(await page.locator('#screen-overlay [data-action="shortcut-cycle"]').count(), 12, 'SYSTEM exposes all configured function-key actions');
    await capture('system');
    await page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.effects"][data-value="false"]').click();
    await page.waitForFunction(async () => (await saveStore.readPreference('ui-settings'))?.['ui.effects'] === false);
    assert.equal(await page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.effects"][data-value="false"]').getAttribute('aria-pressed'), 'true');
    await page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.effects"][data-value="true"]').click();
    await page.waitForFunction(async () => (await saveStore.readPreference('ui-settings'))?.['ui.effects'] === true);
    await page.locator('#screen-overlay [data-action="shortcut-cycle"][data-target="F12"]').click();
    await page.waitForFunction(async () => (await saveStore.readPreference('ui-settings'))?.['ui.shortcut.F12'] === 'system');
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="sound"]').click();
    await page.locator('#screen-overlay .sound-screen').waitFor();
    assert.ok(await page.locator('#screen-overlay input[data-setting="audio.master"]').count(), 'SOUND controls the actual master audio preference');
    assert.equal(await page.locator('#screen-overlay .sound-portrait').count(), 2, 'SOUND shows a portrait for each character-specific voice channel');
    await page.waitForFunction(() => [...document.querySelectorAll('#screen-overlay .sound-portrait')].length === 2 && [...document.querySelectorAll('#screen-overlay .sound-portrait')].every(image => image.complete && image.naturalWidth > 0));
    const portraits = await page.locator('#screen-overlay .sound-portrait').evaluateAll(images => images.map(image => ({ width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height, opacity: getComputedStyle(image).opacity })));
    assert.ok(portraits.every(image => image.width >= 120 && image.height >= 180 && image.opacity === '1'), `character portraits are visible at their authored size: ${JSON.stringify(portraits)}`);
    const voiceCardGeometry = await page.locator('#screen-overlay .sound-voice-card').evaluateAll(cards => cards.map(card => {
      const bounds = node => { const rect = node.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }; };
      const nameplate = card.querySelector('.sound-character');
      return { card: bounds(card), nameplate: bounds(nameplate), nameplateBackground: getComputedStyle(nameplate).backgroundColor, slider: bounds(card.querySelector('.voice-character-volume')) };
    }));
    assert.ok(voiceCardGeometry.every(({ card, nameplate, nameplateBackground, slider }) => nameplate.left >= card.left && nameplate.right <= card.right && nameplate.bottom <= slider.top
      && nameplateBackground.startsWith('rgba(') && Number.parseFloat(nameplateBackground.split(',')[3]) > 0.5
      && slider.left >= card.left && slider.right <= card.right && slider.top >= card.top && slider.bottom <= card.bottom), `each character nameplate and volume control stays legible and contained in its portrait card: ${JSON.stringify(voiceCardGeometry)}`);
    await page.locator('#screen-overlay input[data-setting="audio.bgm"]').fill('0.62');
    await page.waitForFunction(async () => (await saveStore.readPreference('ui-settings'))?.['audio.bgm'] === 0.62);
    await capture('sound');

    await page.locator('#screen-overlay [data-action="open-screen"][data-target="title"]').click();
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.locator('#screen-overlay #title-load').click();
    await page.locator('#screen-overlay [data-slot-index="0"]').waitFor();
    assert.equal(await page.locator('#screen-overlay [data-slot-index]').count(), 12, 'LOAD expands the actual project slot template');
    await capture('load');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.locator('#screen-overlay #title-start').click();
    await page.waitForFunction(() => document.querySelector('#text')?.textContent.includes('目覚まし時計'), null, { timeout: 15000 });
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay .pause-grid').waitFor();
    assert.equal(await page.locator('#screen-overlay .pause-grid .pause-button').count(), 14, 'the in-game menu opens from the actual story player');
    assert.equal(await page.locator('#screen-overlay').evaluate(node => getComputedStyle(node).backgroundImage), 'none', 'transparent pause overlays do not add a Browser-only full-screen tint');
    await capture('pause');
    await page.locator('#screen-overlay [data-action="save"]').click();
    await page.locator('#screen-overlay [data-slot-index="0"]').waitFor();
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"]').isDisabled(), false, 'save actions are live while a story line is active');
    await page.locator('#screen-overlay [data-slot-index="0"]').click();
    await page.locator('#screen-overlay [data-action="slot-commit"]').click();
    await page.waitForFunction(() => document.querySelector('#screen-overlay [data-slot-index="0"]')?.dataset.state === 'ready');
    await page.waitForFunction(() => { const image = document.querySelector('#screen-overlay [data-slot-index="0"] [data-slot-field="thumbnail"]'); return image?.complete && image.naturalWidth > 0; });
    const savedCardGeometry = await page.locator('#screen-overlay [data-slot-index="0"]').evaluate(card => {
      const bounds = field => { const rect = card.querySelector(field).getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; };
      return { card: { left: card.getBoundingClientRect().left, right: card.getBoundingClientRect().right }, text: bounds('[data-slot-field="text"]'), date: bounds('[data-slot-field="saved-at"]'), status: bounds('[data-slot-field="status"]') };
    });
    assert.ok(savedCardGeometry.text.right <= savedCardGeometry.card.right && savedCardGeometry.text.bottom <= savedCardGeometry.date.top
      && savedCardGeometry.date.bottom <= savedCardGeometry.status.top, `saved text, time and status stay in separate card regions: ${JSON.stringify(savedCardGeometry)}`);
    await capture('save');
    await page.locator('#screen-overlay .screen-tabs [data-action="load"]').click();
    await page.waitForFunction(() => document.querySelector('#screen-overlay [data-slot-index="0"]')?.dataset.state === 'ready');
    await page.waitForFunction(() => { const image = document.querySelector('#screen-overlay [data-slot-index="0"] [data-slot-field="thumbnail"]'); return image?.complete && image.naturalWidth > 0; });
    await capture('load-saved');
    await page.locator('#screen-overlay [data-slot-index="0"]').click();
    await page.locator('#screen-overlay [data-action="slot-commit"]').click();
    await page.waitForFunction(() => document.querySelector('#screen-overlay')?.hidden && document.querySelector('#text')?.textContent.includes('目覚まし時計'));
    assert.deepEqual(errors, [], `actual Title project emitted Browser errors: ${errors.join('\n')}`);
    console.log('PASS actual Title project Browser flow: title, keyboard focus, SYSTEM, SOUND persistence, save thumbnail, LOAD round-trip and story MENU');
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null) child.kill();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
