'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-ui-controls-'));
  const project = seedEmptyProject(path.join(tempRoot, 'project'));
  const settings = project.settingsRoot;
  const screens = path.join(settings, 'screens');
  await fs.mkdir(screens, { recursive: true });
  const config = {
    version: 1, initial: 'title', stylesheet: 'screens/shared.css', controlSettings: 'screens/ui-controls.txt',
    controlSkins: {
      romanceVolume: { type: 'range', track: 'ui/controls/audio/volume/track.png', fill: 'ui/controls/audio/volume/fill.png', thumb: 'ui/controls/audio/volume/thumb.png', thumbHover: 'ui/controls/audio/volume/thumb-hover.png', trackHeight: 8, thumbWidth: 28, thumbHeight: 28 },
      romanceVolumeVertical: { type: 'range', orientation: 'vertical', track: 'ui/controls/audio/volume/track.png', fill: 'ui/controls/audio/volume/fill.png', thumb: 'ui/controls/audio/volume/thumb.png', trackHeight: 8, thumbWidth: 28, thumbHeight: 28 },
      romanceToggle: { type: 'checkbox', off: 'ui/controls/audio/volume/track.png', on: 'ui/controls/audio/volume/fill.png' },
    },
    canvas: { width: 1280, height: 720 },
    screens: {
      title: { background: '', template: 'screens/title.html' },
      sound: { background: '', template: 'screens/sound.html' },
    },
  };
  const uiAssetDirectory = path.join(project.assetsRoot, 'ui', 'controls', 'audio', 'volume');
  await fs.mkdir(uiAssetDirectory, { recursive: true });
  const skinSource = path.resolve(__dirname, '../Title/asset/ui/controls/audio/volume/volume-controls-concept-v1.png');
  for (const name of ['track.png', 'fill.png', 'thumb.png', 'thumb-hover.png']) await fs.copyFile(skinSource, path.join(uiAssetDirectory, name));
  await fs.writeFile(path.join(settings, 'game-screens.json'), JSON.stringify(config, null, 2));
  await fs.writeFile(path.join(screens, 'ui-controls.txt'), 'audio.master=1\naudio.bgm=1\naudio.se=1\naudio.voice=0.5\naudio.bgmMuted=false\naudio.seMuted=false\naudio.voiceMuted=false\nui.dialogOpacity=1\n');
  await fs.writeFile(path.join(screens, 'shared.css'), [
    'main{position:relative;width:100%;height:100%;background-color:#101820}',
    '.open{position:absolute;left:20px;top:20px;width:180px;height:50px}',
    '.master{position:absolute;left:30px;top:60px;width:300px;height:24px}',
    '.slider{position:absolute;left:30px;top:100px;width:300px;height:24px;accent-color:#94b5e8}',
    '.mute{position:absolute;left:30px;top:150px;width:24px;height:24px}',
    '.opacity{position:absolute;left:30px;top:200px;width:300px;height:24px}',
    '.vertical{position:absolute;left:360px;top:20px;width:32px;height:180px}',
  ].join('\n'));
  await fs.writeFile(path.join(screens, 'title.html'), '<main><button class="open" data-action="open-screen" data-target="sound">Sound settings</button><button data-action="start">Start</button></main>');
  await fs.writeFile(path.join(screens, 'sound.html'), '<main><input class="master" type="range" min="0" max="1" step="0.01" data-setting="audio.master" aria-label="Master volume"><input class="slider" type="range" min="0" max="1" step="0.01" data-setting="audio.bgm" data-skin="romanceVolume" aria-label="BGM volume"><input class="vertical" type="range" min="0" max="1" step="0.01" data-setting="audio.voice" data-skin="romanceVolumeVertical" aria-label="Vertical voice volume"><input class="mute" type="checkbox" data-setting="audio.bgmMuted" data-skin="romanceToggle" aria-label="Mute BGM"><input class="opacity" type="range" min="0" max="1" step="0.01" data-setting="ui.dialogOpacity" aria-label="Message opacity"></main>');
  const child = spawn(process.execPath, [path.resolve(__dirname, '../Edit/server.js'), '--project', project.projectRoot], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
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
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay button[data-target="sound"]').waitFor().catch(async error => {
      throw Error(`${error.message}\napi: ${JSON.stringify(await (await page.request.get(`${base}/api/game-screens`)).json())}\nerrors: ${errors.join('; ')}\noverlay: ${await page.locator('#screen-overlay').evaluate(node => node.outerHTML.slice(0, 2000))}`);
    });
    await page.locator('#screen-overlay button[data-target="sound"]').click();
    await page.evaluate(() => primeBgmAudioContext());
    await page.locator('#screen-overlay input[data-setting="audio.master"]').fill('0.5');
    const slider = page.locator('#screen-overlay input[data-setting="audio.bgm"]');
    await page.locator('#screen-overlay .novel-skinned-control[data-skin="romanceVolume"]').click({ position: { x: 150, y: 12 } });
    assert.ok(Math.abs(Number(await slider.inputValue()) - 0.5) < 0.03, 'skinned slider click geometry maps to its value range');
    await slider.fill('0.37');
    const vertical = page.locator('#screen-overlay .novel-skinned-control[data-skin="romanceVolumeVertical"]');
    await vertical.click({ position: { x: 16, y: 18 } });
    assert.ok(Number(await page.locator('#screen-overlay input[data-setting="audio.voice"]').inputValue()) > 0.85, 'vertical slider top maps to maximum');
    await vertical.click({ position: { x: 16, y: 162 } });
    assert.ok(Number(await page.locator('#screen-overlay input[data-setting="audio.voice"]').inputValue()) < 0.15, 'vertical slider bottom maps to minimum');
    await page.locator('#screen-overlay input[data-setting="audio.voice"]').fill('0.72');
    await page.locator('#screen-overlay .novel-skinned-control[data-skin="romanceToggle"]').click();
    assert.equal(await page.locator('#screen-overlay input[data-setting="audio.bgmMuted"]').isChecked(), true, 'skinned checkbox keeps native keyboard/form state');
    assert.equal(await page.locator('#screen-overlay .novel-skinned-control[data-skin="romanceToggle"] img').count(), 1);
    await page.locator('#screen-overlay input[data-setting="ui.dialogOpacity"]').fill('0.62');
    await page.waitForTimeout(80);
    const liveMix = await page.evaluate(() => ({ master: audioBuses.master.gain.value, bgm: audioBuses.bgm.gain.value }));
    assert.ok(Math.abs(liveMix.master - 0.5) < 0.02, `master mix changes should apply live: ${JSON.stringify(liveMix)}`);
    assert.ok(liveMix.bgm < 0.02, `muting BGM should silence the live channel bus: ${JSON.stringify(liveMix)}`);
    const saved = await page.evaluate(() => saveStore.readPreference('ui-settings'));
    assert.equal(saved['audio.bgm'], 0.37);
    assert.equal(saved['audio.bgmMuted'], true);
    assert.equal(saved['audio.master'], 0.5);
    assert.equal(saved['ui.dialogOpacity'], 0.62);
    await page.reload();
    await page.locator('#screen-overlay button[data-target="sound"]').click();
    assert.equal(await page.locator('#screen-overlay input[data-setting="audio.bgm"]').inputValue(), '0.37');
    assert.equal(await page.locator('#screen-overlay input[data-setting="audio.master"]').inputValue(), '0.5');
    assert.equal(await page.locator('#screen-overlay input[data-setting="audio.bgmMuted"]').isChecked(), true);
    assert.equal(await page.locator('#screen-overlay input[data-setting="ui.dialogOpacity"]').inputValue(), '0.62');
    assert.equal(await page.locator('#screen-overlay input[data-setting="audio.voice"]').inputValue(), '0.72');
    assert.deepEqual(errors, []);
    console.log('PASS Browser screen controls: image-skinned range interaction, toggle, persistence and restore');
  } finally {
    if (browser) await browser.close();
    child.kill();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
