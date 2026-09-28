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
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-game-screens-'));
  const project = seedEmptyProject(path.join(tempRoot, 'project'));
  await fs.writeFile(path.join(project.scenesRoot, 'title.tds'), 'scene title_front { say narrator "TDS title reached" }\n', 'utf8');
  const prototypeScreens = JSON.parse(await fs.readFile(path.join(root, 'Title', 'setting', 'game-screens.json'), 'utf8'));
  await fs.writeFile(path.join(project.settingsRoot, 'game-screens.json'), JSON.stringify(prototypeScreens, null, 2));
  await fs.mkdir(path.join(project.assetsRoot, 'bg'), { recursive: true });
  await fs.copyFile(path.join(root, 'Title', 'asset', 'bg', 'museum-night.png'), path.join(project.assetsRoot, 'bg', 'museum-night.png'));
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
    const playerUi = await (await page.request.get(`${base}/api/player-ui`)).json();
    playerUi.theme.screen.width = 1440;
    playerUi.theme.screen.height = 810;
    await page.request.put(`${base}/api/player-ui`, { data: { theme: playerUi.theme } });
    await page.locator('[data-activity="presentation"]').click();
    await page.locator('[data-presentation-action="game-screens"]').click();
    await page.locator('.game-screen-settings').waitFor().catch(async error => {
      throw Error(`${error.message}\npage errors: ${errors.join('; ')}\nstate: ${await page.evaluate(() => JSON.stringify({ title: document.title, presentation: document.querySelector('.presentation-view')?.className, button: !!document.querySelector('[data-presentation-action="game-screens"]'), body: document.body.innerText.slice(0, 600) }))}`);
    });
    await page.locator('.game-screen-preview-button').first().click();
    await page.locator('.game-screen-inspector input').first().fill('物語を始める');
    await page.locator('.game-screen-toolbar select').selectOption('title');
    await page.locator('.game-screen-inspector textarea').fill(`${prototypeScreens.screens.title.description}\nタイトル画面の仮デザインです。`);
    await page.locator('.game-screen-settings footer button').click();
    await page.getByText('画面設定を保存しました。').waitFor();
    const saved = await (await page.request.get(`${base}/api/game-screens`)).json();
    assert.equal(saved.configured, true);
    assert.deepEqual(saved.screens.canvas, { width: 1440, height: 810 }, 'game screen canvas is derived from the shared player display dimensions');
    const storedScreens = JSON.parse(await fs.readFile(path.join(project.settingsRoot, 'game-screens.json'), 'utf8'));
    assert.equal(Object.hasOwn(storedScreens, 'canvas'), false, 'saving screen layout does not persist a duplicate canvas size');
    assert.equal(saved.screens.screens.title.items[0].label, '物語を始める');
    assert.match(saved.screens.screens.title.description, /タイトル画面の仮デザイン/);
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: '物語を始める' }).waitFor();
    assert.equal(await page.locator('.game-screen-title').textContent(), '二十面相は恋を盗む');
    assert.match(await page.locator('.game-screen-description').textContent(), /美術館/);
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: '作品紹介' }).click();
    assert.match(await page.locator('.game-screen-description').textContent(), /二人の少女/);
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: '戻る' }).click();
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: '物語を始める' }).click();
    await page.locator('#text').filter({ hasText: '新しい作品を始めます。' }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: '物語に戻る' }).waitFor();
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: '操作ガイド' }).click();
    assert.match(await page.locator('.game-screen-description').textContent(), /Enter/);
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'メニューに戻る' }).click();
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: '物語に戻る' }).click();
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
    console.log('PASS browser screens: edit, title/about/start, pause and TDS title-scene entry');
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
