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
    'include "helper.tds" as helper',
    'global int counter = 0',
    'scene main {',
    '  start()',
    '  helper.checkpoint()',
    '  set counter = counter + 1',
    '  choice "continue?" {',
    '    "yes" {',
    '      int local_counter = 7',
    '      volume bgm 0.24',
    '      dialog opacity 0.42',
    '      say narrator "checkpoint"',
    '      set local_counter = local_counter + 1',
    '      start()',
    '      say narrator str(local_counter)',
    '      say narrator str(runtime.state.audio.volume("bgm")) + ":" + str(runtime.state.ui.dialog_opacity())',
    '    }',
    '  }',
    '  for iteration from 1 to 2 {',
    '    say narrator "loop " + str(iteration)',
    '  }',
    '}',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(project.scenesRoot, 'helper.tds'), [
    'fn checkpoint() -> none {',
    '  say narrator "inside helper"',
    '}',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(project.settingsRoot, 'game-screens.json'), JSON.stringify({
    version: 1, initial: 'title', saveId: 'browser-load-fixture',
    controlDefaults: { 'ui.shortcut.F9': 'quick-save' },
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
    await page.goto(base);
    await page.evaluate(async ({ legacyPrefix }) => {
      localStorage.setItem(`${legacyPrefix}:ui-settings`, JSON.stringify({ 'audio.bgm': 0.4 }));
      const request = indexedDB.open('novel-script-user-data', 1);
      request.onupgradeneeded = () => {
        for (const name of ['snapshots', 'metadata', 'thumbnails', 'preferences']) request.result.createObjectStore(name);
      };
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('preferences', 'readwrite');
        tx.objectStore('preferences').put(false, 'browser-load-fixture:game:pref:ui-settings');
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
      db.close();
    }, { legacyPrefix: `novel-script:${encodeURIComponent(project.projectRoot)}:game` });
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'Start' }).waitFor();
    assert.equal(await page.evaluate(() => saveStore.readPreference('ui-settings')), false, 'a falsey current preference must survive legacy migration in the actual IndexedDB backend');
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'Start' }).click();
    await page.locator('#text').filter({ hasText: 'inside helper' }).waitFor();
    await page.locator('#player-controls [data-action="save"]').click();
    const helperSaveSlot = page.locator('.game-save-slot').first();
    await helperSaveSlot.waitFor();
    await helperSaveSlot.click();
    const functionSaveError = page.locator('.game-screen-error');
    await functionSaveError.waitFor();
    assert.match(await functionSaveError.textContent(), /\u95a2\u6570\u306e\u5b9f\u884c\u4e2d\u306f\u4fdd\u5b58\u3067\u304d\u307e\u305b\u3093/);
    assert.equal(await page.evaluate(() => saveStore.readSlot(0)), null, 'saving inside an included function must not create a broken resumable snapshot');
    await page.reload();
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'Start' }).click();
    await page.locator('#text').filter({ hasText: 'inside helper' }).waitFor();
    await page.locator('#next').click();
    await page.locator('#choices .choice').first().click();
    await page.locator('#text').filter({ hasText: 'checkpoint' }).waitFor();
    await page.locator('#player-controls [data-action="save"]').click();
    const slot = page.locator('.game-save-slot').first();
    await slot.waitFor();
    assert.equal(await slot.isDisabled(), false, 'save slot is active at a dialogue instruction');
    await slot.click();
    await page.locator('.game-screen-notice').waitFor();
    const stored = await page.evaluate(async () => {
      const encoded = await saveStore.readSlot(0);
      return encoded ? JSON.parse(encoded) : null;
    });
    assert.equal(stored.version, 1);
    assert.equal(stored.saveId, 'browser-load-fixture');
    assert.equal(stored.scene, 'main');
    assert.equal(stored.text, 'checkpoint');
    assert.deepEqual(stored.variables.counter, { __novelInteger: '1' }, '64-bit integer values are stored losslessly');
    assert.deepEqual(stored.locals[0].local_counter, { __novelInteger: '7' }, 'active choice-local variables are persisted alongside globals');
    assert.equal(stored.sceneState.audio.volumeOverrides.bgm, 0.24, 'the Browser snapshot stores the persistent channel override');
    assert.equal(stored.sceneState.ui.dialogOpacity, 0.42, 'the Browser snapshot stores dialogue opacity');
    await page.evaluate(async snapshot => saveStore.writeSlot(0, JSON.stringify({ ...snapshot, saveId: '' })), stored);
    await page.locator('#screen-overlay .game-screen-button').first().click();
    await page.locator('#screen-overlay').waitFor({ state: 'hidden' });
    await page.locator('#player-controls [data-action="load"]').click();
    const loadSlot = page.locator('.game-save-slot').first();
    await loadSlot.waitFor();
    assert.equal(await loadSlot.isDisabled(), false);
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), loadSlot.click()]);
    await page.locator('#text').filter({ hasText: 'checkpoint' }).waitFor();
    await page.locator('#next').click();
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'Start' }).waitFor();
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'Start' }).click();
    await page.locator('#screen-overlay').waitFor({ state: 'hidden' });
    await page.locator('#text').filter({ hasText: '8' }).waitFor();
    await page.locator('#next').click();
    await page.locator('#text').filter({ hasText: '0.24:0.42' }).waitFor();
    await page.locator('#next').click();
    await page.locator('#text').filter({ hasText: 'loop 1' }).waitFor();
    const priorSlotBeforeLoopSave = await page.evaluate(() => saveStore.readSlot(0));
    await page.locator('#player-controls [data-action="save"]').click();
    await page.locator('.game-save-slot').first().click();
    const loopSlotError = page.locator('#screen-overlay .game-screen-error');
    await loopSlotError.waitFor();
    assert.match(await loopSlotError.textContent(), /loop\u306e\u5b9f\u884c\u4e2d\u306f\u4fdd\u5b58\u3067\u304d\u307e\u305b\u3093/);
    assert.equal(await page.evaluate(() => saveStore.readSlot(0)), priorSlotBeforeLoopSave, 'slot save inside a loop must not overwrite the existing snapshot');
    await page.evaluate(() => saveQuickGame());
    const loopQuickError = page.locator('#stage .player-toast-error');
    await loopQuickError.waitFor();
    assert.match(await loopQuickError.textContent(), /Quick Save.*loop\u306e\u5b9f\u884c\u4e2d\u306f\u4fdd\u5b58\u3067\u304d\u307e\u305b\u3093/);
    assert.equal(await page.evaluate(() => saveStore.readPreference('quick-save')), null, 'quick save inside a loop must not write its preference snapshot');
    await page.evaluate(async snapshot => saveStore.writeSlot(0, JSON.stringify({ ...snapshot, scene: 'not-a-scene' })), stored);
    await page.reload();
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'Start' }).click();
    await page.locator('#player-controls [data-action="load"]').click();
    const invalidSceneSlot = page.locator('.game-save-slot').first();
    await invalidSceneSlot.waitFor();
    assert.equal(await invalidSceneSlot.isDisabled(), true, 'a snapshot with an invalid scene identifier is classified as corrupt');
    await page.evaluate(() => saveStore.writeSlot(0, ''));
    await page.reload();
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'Start' }).waitFor();
    assert.equal(await page.evaluate(() => saveSlotState(0)), 'corrupt', 'an empty persisted payload is corrupt, not an empty slot');
    await page.evaluate(() => saveStore.writeSlot(0, '{}'));
    await page.reload();
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'Start' }).waitFor();
    assert.equal(await page.evaluate(() => saveSlotState(0)), 'corrupt', 'a parsed object with missing version is malformed, not incompatible');
    await page.evaluate(() => saveStore.writeSlot(0, JSON.stringify({ version: 1, file: 'main.tds', scene: 'main', line: 1, variables: {}, readonlyLocals: [[]] })));
    await page.reload();
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'Start' }).waitFor();
    assert.equal(await page.evaluate(() => saveSlotState(0)), 'corrupt', 'malformed local frame metadata is rejected before restore');
    await page.evaluate(() => saveStore.writeSlot(0, JSON.stringify({ version: 2, file: 'main.tds', scene: 'main', line: 1, variables: {} })));
    await page.reload();
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'Start' }).waitFor();
    assert.equal(await page.evaluate(() => saveSlotState(0)), 'incompatible', 'a valid integer version newer than v1 is incompatible');
    await page.evaluate(() => saveStore.writeSlot(0, '{"version":1,"file":"main.tds","scene":"main","line":1.1e1,"variables":{}}'));
    await page.reload();
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'Start' }).waitFor();
    assert.equal(await page.evaluate(() => saveSlotState(0)), 'ready', 'a finite integral JSON number source line remains loadable');
    await page.evaluate(() => saveStore.writeSlot(0, '{"version":1,"file":"main.tds","scene":"main","line":9007199254740992,"variables":{}}'));
    await page.reload();
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'Start' }).waitFor();
    assert.equal(await page.evaluate(() => saveSlotState(0)), 'corrupt', 'source line above Number.MAX_SAFE_INTEGER is not loadable');
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
