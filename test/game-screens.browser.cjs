'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');
const { defaultGameScreens } = require('../Edit/game-screens');

const root = path.resolve(__dirname, '..');

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-game-screens-'));
  const project = seedEmptyProject(path.join(tempRoot, 'project'));
  await fs.writeFile(path.join(project.scenesRoot, 'title.tds'), 'scene title_front { say narrator "TDS title reached" }\n', 'utf8');
  const prototypeScreens = JSON.parse(await fs.readFile(path.join(root, 'Title', 'setting', 'game-screens.json'), 'utf8'));
  await fs.writeFile(path.join(project.settingsRoot, 'game-screens.json'), JSON.stringify(prototypeScreens, null, 2));
  await fs.mkdir(path.join(project.assetsRoot, 'bg'), { recursive: true });
  await fs.copyFile(path.join(root, 'Title', 'asset', 'bg', 'title.png'), path.join(project.assetsRoot, 'bg', 'title.png'));
  await fs.copyFile(path.join(root, 'Title', 'asset', 'bg', 'near_home.jpg'), path.join(project.assetsRoot, 'bg', 'near_home.jpg'));
  await fs.copyFile(path.join(root, 'Title', 'asset', 'bg', 'school.jpg'), path.join(project.assetsRoot, 'bg', 'school.jpg'));
  await fs.mkdir(path.join(project.assetsRoot, 'ui'), { recursive: true });
  await fs.copyFile(path.join(root, 'Title', 'asset', 'ui', 'choice-romance.png'), path.join(project.assetsRoot, 'ui', 'choice-romance.png'));
  await fs.mkdir(path.join(project.assetsRoot, 'char'), { recursive: true });
  for (const name of ['ayaka_normal.png', 'ayaka_dere.png', 'sisiter_normal.png', 'sister_dere.png']) {
    await fs.copyFile(path.join(root, 'Title', 'asset', 'char', name), path.join(project.assetsRoot, 'char', name));
  }
  for (const name of new Set([prototypeScreens.stylesheet, prototypeScreens.controlSettings, ...Object.values(prototypeScreens.screens).map(screen => screen.template)].filter(Boolean))) {
    const target = path.join(project.settingsRoot, ...name.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, 'Title', 'setting', ...name.split('/')), target);
  }
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
    const captureScreen = async name => {
      if (!process.env.NOVEL_SCREEN_CAPTURE_DIR) return;
      await fs.mkdir(process.env.NOVEL_SCREEN_CAPTURE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.NOVEL_SCREEN_CAPTURE_DIR, `${name}.png`) });
    };
    await page.goto(base);
    const playerUi = await (await page.request.get(`${base}/api/player-ui`)).json();
    playerUi.theme.screen.width = 1440;
    playerUi.theme.screen.height = 810;
    await page.request.put(`${base}/api/player-ui`, { data: { theme: playerUi.theme } });
    await page.locator('[data-activity="presentation"]').click();
    await page.locator('[data-presentation-action="game-screens"]').click();
    await page.locator('.game-screen-settings').waitFor().catch(async error => {
      throw Error(`${error.message}\npage errors: ${errors.join('; ')}\nstate: ${await page.evaluate(() => JSON.stringify({ title: document.title, presentation: document.querySelector('.presentation-view')?.className, button: !!document.querySelector('[data-presentation-action="game-screens"]'), body: document.body.innerText.slice(0, 600) }))}`);
    });
    await page.locator('.game-screen-toolbar select[aria-label="編集する画面"]').selectOption('save');
    assert.equal(await page.locator('.game-screen-preview [data-slot-index="0"] [data-slot-field="number"]').textContent(), '01', 'editor preview preserves authored card fields');
    assert.equal(await page.locator('.game-screen-preview [data-slot-index="0"] [data-slot-field="status"]').textContent(), '記録あり');
    await page.locator('.game-screen-toolbar select[aria-label="編集する画面"]').selectOption('title');
    assert.equal(await page.locator('.game-screen-toolbar button').filter({ hasText: 'HTML/CSSが正本' }).isDisabled(), true, 'template-backed screens cannot switch to a JSON-only visual editor');
    const apiScreens = await (await page.request.get(`${base}/api/game-screens`)).json();
    const titleHtmlPath = prototypeScreens.screens.title.template;
    await page.locator('.game-screen-inspector textarea[aria-label="画面HTML"]').fill(apiScreens.documents[titleHtmlPath].replace('はじめから', '物語を始める'));
    const sharedCss = await page.locator('.game-screen-inspector textarea[aria-label="共通CSS"]').inputValue();
    await page.locator('.game-screen-inspector textarea[aria-label="共通CSS"]').fill(`${sharedCss}\n.title-menu{background:linear-gradient(90deg,#101820,#304050);border-radius:12px}\n.menu-button:hover{color:#ffffff;background-color:#315f80}`);
    await page.locator('.game-screen-settings footer button').click();
    await page.getByText('画面設定を保存しました。').waitFor().catch(async error => {
      throw Error(`${error.message}\neditor status: ${await page.locator('.game-screen-status').textContent()}`);
    });
    const saved = await (await page.request.get(`${base}/api/game-screens`)).json();
    assert.equal(saved.configured, true);
    assert.deepEqual(saved.screens.canvas, { width: 1440, height: 810 }, 'game screen canvas is derived from the shared player display dimensions');
    const storedScreens = JSON.parse(await fs.readFile(path.join(project.settingsRoot, 'game-screens.json'), 'utf8'));
    assert.equal(Object.hasOwn(storedScreens, 'canvas'), false, 'saving screen layout does not persist a duplicate canvas size');
    assert.equal(Object.hasOwn(storedScreens.screens.title, 'items'), false, 'HTML-backed button data is not duplicated into the editable screen manifest');
    assert.equal(Object.hasOwn(storedScreens.screens.save, 'slotLayout'), false, 'HTML-backed slot geometry remains in HTML/CSS only');
    assert.match(saved.screens.screens.title.items.find(item => item.action === 'start').label, /物語を始める/);
    assert.match(saved.documents[titleHtmlPath], /物語を始める/);
    assert.ok(saved.screens.screens.title.uiTree, 'the shared UI tree is available to player and editor preview');
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay [data-action="start"]').filter({ hasText: '物語を始める' }).waitFor().catch(async error => {
      throw Error(`${error.message}\nplayer errors: ${errors.join('; ')}\noverlay: ${await page.locator('#screen-overlay').evaluate(node => node.outerHTML.slice(0, 5000))}\nrealm: ${JSON.stringify(await page.evaluate(() => ({ doc: typeof NovelScreenDocument, player: typeof gameScreenConfig, tree: typeof gameScreenConfig === 'undefined' ? null : gameScreenConfig.screens.title.uiTree, active: typeof activeGameScreen === 'undefined' ? null : activeGameScreen })))}\nconfig: ${JSON.stringify((await (await page.request.get(`${base}/api/game-screens`)).json()).screens.screens.title.items)}`);
    });
    await captureScreen('title');
    assert.equal(await page.locator('#screen-overlay .title-menu').count(), 1, 'custom HTML layout is rendered by the player');
    assert.match(await page.locator('#screen-overlay .title-menu').evaluate(node => getComputedStyle(node).backgroundImage), /linear-gradient/);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'start', 'the first available menu action receives keyboard focus');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'load');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'start');
    await page.locator('#screen-overlay [data-action="quit"]').click();
    await page.waitForURL(base + '/');
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="system"]').click();
    await page.locator('#screen-overlay .system-options').waitFor();
    assert.ok(await page.locator('#screen-overlay .setting-row').count() >= 1, 'the system screen exposes its editable controls');
    await captureScreen('system');
    await page.locator('#screen-overlay .screen-tabs [data-action="open-screen"][data-target="sound"]').click();
    await page.locator('#screen-overlay .volume-panel').waitFor();
    assert.ok(await page.locator('#screen-overlay input[data-setting="audio.bgm"]').count(), 'sound screen has a real BGM control');
    await captureScreen('sound');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .system-options').waitFor();
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="about"]').click();
    assert.match(await page.locator('#screen-overlay').innerText(), /入学式の日/);
    await captureScreen('extra');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.locator('#screen-overlay [data-action="start"]').filter({ hasText: '物語を始める' }).click();
    await page.locator('#text').filter({ hasText: '新しい作品を始めます。' }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="resume"]').first().waitFor();
    await captureScreen('pause');
    await page.locator('#screen-overlay [data-action="save"]').first().click();
    await page.locator('#screen-overlay [data-slot-index]').first().waitFor();
    assert.equal(await page.locator('#screen-overlay [data-slot-index]').count(), 12, 'the HTML save-slots role expands into the configured 12-slot grid');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"]').isDisabled(), false, 'save slot is enabled while a scenario line is active');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="number"]').textContent(), '01');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="status"]').textContent(), '空き');
    const slotRects = await page.locator('#screen-overlay [data-slot-index]').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { index: node.dataset.slotIndex, x: r.x, y: r.y, w: r.width, h: r.height, inline: node.style.cssText, parent: node.parentElement.getBoundingClientRect().toJSON() }; }));
    assert.equal(new Set(slotRects.map(rect => `${rect.x},${rect.y}`)).size, 12, `save-slot cards must occupy separate CSS grid cells: ${JSON.stringify(slotRects)}`);
    const overlaps = slotRects.flatMap((a, i) => slotRects.slice(i + 1).filter(b => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).map(b => [a.index, b.index]));
    assert.equal(overlaps.length, 0, `CSS grid cells must not overlap: ${JSON.stringify(slotRects)}`);
    await page.locator('#screen-overlay [data-slot-index="0"]').click();
    await page.locator('#screen-overlay .game-screen-notice').filter({ hasText: '保存しました' }).waitFor();
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="status"]').textContent(), '記録あり');
    assert.match(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="text"]').textContent(), /新しい作品を始めます/);
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="load"]').first().click();
    await captureScreen('load');
    assert.equal(await page.locator('#screen-overlay [data-slot-index]').count(), 12, 'load screen uses the same custom slot layout and count');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"]').isDisabled(), false, 'saved slots become loadable');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="status"]').textContent(), '記録あり');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="system"]').click();
    assert.ok(await page.locator('#screen-overlay .system-options').count());
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="resume"]').first().click();
    await page.locator('#screen-overlay').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#text').textContent(), '新しい作品を始めます。');
    assert.equal(errors.length, 0, errors.join('\n'));
    const screensForTdsTitle = (await (await page.request.get(`${base}/api/game-screens`)).json()).screens;
    screensForTdsTitle.titleScene = { file: 'title.tds', scene: 'title_front' };
    const titleConfigResponse = await page.request.put(`${base}/api/game-screens`, { data: { screens: screensForTdsTitle } });
    assert.equal(titleConfigResponse.status(), 200, 'TDS title configuration is accepted by the game-screen settings contract');
    await page.goto(`${base}/player.html`);
    await page.locator('#text').filter({ hasText: 'TDS title reached' }).waitFor();
    assert.equal(await page.locator('#screen-overlay').isHidden(), true, 'configured TDS title runs as the entry scene instead of showing the JSON overlay');
    assert.equal(errors.length, 0, errors.join('\n'));
    const legacyResponse = await page.request.put(`${base}/api/game-screens`, { data: { screens: defaultGameScreens() } });
    assert.equal(legacyResponse.status(), 200, 'legacy JSON-only screens remain accepted');
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'はじめから' }).waitFor();
    assert.equal(await page.locator('#screen-overlay .game-screen-button').count(), 1, 'JSON-only screens keep their prior Browser renderer');
    await page.goto(base);
    await page.locator('[data-activity="presentation"]').click();
    await page.locator('[data-presentation-action="game-screens"]').click();
    await page.locator('.game-screen-settings').waitFor();
    await page.locator('.game-screen-toolbar button').filter({ hasText: 'HTML/CSSで編集' }).click();
    await page.locator('.game-screen-inspector textarea[aria-label="画面HTML"]').waitFor();
    await page.locator('.game-screen-settings footer button').click();
    await page.getByText('画面設定を保存しました。').waitFor();
    const migrated = await (await page.request.get(`${base}/api/game-screens`)).json();
    assert.ok(migrated.screens.screens.title.uiTree, 'legacy settings migrate to the shared HTML/CSS rendering format');
    assert.match(migrated.documents[migrated.screens.screens.title.template], /data-action="start"/);
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay [data-action="start"]').filter({ hasText: 'はじめから' }).waitFor();
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS browser screens: HTML/CSS edit, live preview, actions, save slots, legacy fallback/migration, TDS title entry');
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
