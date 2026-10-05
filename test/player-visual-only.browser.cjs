'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-visual-only-'));
  const project = seedEmptyProject(path.join(tempRoot, 'project'));
  const pixel = path.resolve(__dirname, '../native/engine_data/ui/dialogue_box.png');
  const video = path.resolve(__dirname, '../build/audit-smoke/assets/clip.mp4');
  const animatedCard = path.join(tempRoot, 'animated-card.gif');
  const gifEncode = spawnSync(process.env.FFMPEG_EXE || 'ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32:r=10:d=0.2', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=10:d=0.2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', '-loop', '0', animatedCard], { encoding: 'utf8', timeout: 20000 });
  assert.equal(gifEncode.status, 0, gifEncode.stderr || gifEncode.error?.message);
  await fs.copyFile(pixel, path.join(project.assetsRoot, 'bg', 'room.png'));
  await fs.copyFile(animatedCard, path.join(project.assetsRoot, 'image', 'card.gif'));
  await fs.copyFile(pixel, path.join(project.assetsRoot, 'char', 'hero.png'));
  await fs.copyFile(video, path.join(project.assetsRoot, 'video', 'op.mp4'));
  await fs.mkdir(path.join(project.assetsRoot, 'ui'), { recursive: true });
  await fs.copyFile(pixel, path.join(project.assetsRoot, 'ui', 'dialogue.png'));
  await fs.copyFile(pixel, path.join(project.assetsRoot, 'ui', 'nameplate.png'));
  const playerUi = JSON.parse(await fs.readFile(path.resolve(__dirname, '../Title/setting/player-ui.json'), 'utf8'));
  playerUi.dialog.image = 'ui/dialogue.png';
  playerUi.dialog.nameplate.image = 'ui/nameplate.png';
  await fs.writeFile(path.join(project.settingsRoot, 'player-ui.json'), JSON.stringify(playerUi), 'utf8');
  await fs.appendFile(project.settingFile, '\nnative_ui_theme = player-ui.json\n', 'utf8');
  await fs.writeFile(path.join(project.scenesRoot, 'main.tds'), `
asset bg room = "asset/bg/room.png"
asset image card = "asset/image/card.gif"
asset video op = "asset/video/op.mp4"
character hero {
  name = "Hero"
  pose normal = "asset/char/hero.png"
}
scene main {
  bg room --only
  say narrator "background only"
  show hero.normal center --only
  say narrator "character only"
  show image card center --only
  say narrator "image only"
  play video "op.mp4" --only
  say narrator "restored after video"
  play video op async opacity 0.4
  move bg by x+5 over 120
  camera zoom 1.25 at 640 360 over 120
  dialog visible false
  wait 80
  camera reset over 120
  dialog visible true
  say narrator "effects complete"
}
`, 'utf8');

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
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const source = await fs.readFile(path.join(project.scenesRoot, 'main.tds'), 'utf8');
    const compiledResponse = await page.request.post(`${base}/api/compile`, { data: { name: 'main.tds', source } });
    const compiled = await compiledResponse.json();
    assert.equal(compiled.ok, true, JSON.stringify(compiled));
    await page.goto(`${base}/player.html?debug=visual-only-test`);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#dialogue'), '::before').backgroundImage.includes('/asset/ui/dialogue.png'));
    assert.equal((await page.request.get(`${base}/asset/ui/dialogue.png`)).status(), 200, 'dialogue artwork resolves from the project asset root');
    assert.equal((await page.request.get(`${base}/asset/ui/nameplate.png`)).status(), 200, 'speaker artwork resolves from the project asset root');
    await page.evaluate(async () => {
      const context = getBgmAudioContext();
      if (context?.state === 'suspended') await context.resume();
    });
    await page.waitForFunction(() => {
      const gain = audioBuses?.master?.gain?.value;
      return Number.isFinite(gain) && Math.abs(gain - 0.5) < 0.02;
    }, null, { timeout: 5000 });
    const testMasterGain = await page.evaluate(() => audioBuses?.master.gain.value);
    assert.ok(Math.abs(testMasterGain - 0.5) < 0.02, `test playback master output is half volume (got ${testMasterGain})`);
    const waitForMode = async kind => page.waitForFunction(expected => document.querySelector('#stage').dataset.visualOnly === expected, kind)
      .catch(async error => { throw Error(`${error.message}\ntext: ${await page.locator('#text').textContent()}\nstate: ${await page.evaluate(() => typeof runtime === 'undefined' ? 'no runtime' : JSON.stringify({ revision: runtime.sceneState.revision, background: runtime.sceneState.background, only: runtime.sceneState.visualOnly }))}\nerrors: ${errors.join('; ')}`); });
    const stageLayerVisibility = () => page.evaluate(() => Object.fromEntries(['background', 'video-layer', 'characters', 'images', 'bottom-fog', 'dialogue', 'player-controls'].map(id => [id, getComputedStyle(document.getElementById(id)).visibility])));

    const dialogueStacking = await page.evaluate(() => ({
      panel: getComputedStyle(document.querySelector('#dialogue'), '::before').zIndex,
      speaker: getComputedStyle(document.querySelector('#speaker')).zIndex,
      text: getComputedStyle(document.querySelector('#text')).zIndex,
    }));
    assert.deepEqual(dialogueStacking, { panel: '0', speaker: '1', text: '1' }, 'dialogue text and speaker must paint above the decorative panel background');

    await waitForMode('background');
    let visibility = await stageLayerVisibility();
    assert.equal(visibility.background, 'visible');
    assert.equal(visibility['video-layer'], 'hidden');
    assert.equal(visibility.characters, 'hidden');
    assert.equal(visibility.images, 'hidden');
    assert.equal(visibility['bottom-fog'], 'hidden');
    assert.equal(visibility.dialogue, 'visible', 'static --only keeps dialogue UI usable');
    assert.equal(visibility['player-controls'], 'visible', 'static --only keeps player controls usable');
    await page.locator('#next').click();

    await waitForMode('character');
    visibility = await stageLayerVisibility();
    assert.equal(visibility.background, 'hidden');
    assert.equal(visibility['video-layer'], 'hidden');
    assert.equal(visibility.characters, 'visible');
    assert.equal(visibility.images, 'hidden');
    assert.equal(visibility['bottom-fog'], 'hidden');
    assert.equal(visibility.dialogue, 'visible');
    assert.equal(visibility['player-controls'], 'visible');
    await page.locator('#next').click();

    await waitForMode('image');
    visibility = await stageLayerVisibility();
    assert.equal(visibility.background, 'hidden');
    assert.equal(visibility['video-layer'], 'hidden');
    assert.equal(visibility.characters, 'hidden');
    assert.equal(visibility.images, 'visible');
    assert.equal(visibility['bottom-fog'], 'hidden');
    assert.equal(visibility.dialogue, 'visible');
    assert.equal(visibility['player-controls'], 'visible');
    assert.equal(await page.locator('#images .visual-only-target').count(), 1);
    await page.waitForFunction(() => {
      const image = document.querySelector('#images .visual-only-target');
      return image?.complete && image.naturalWidth === 32 && image.currentSrc.endsWith('/asset/image/card.gif');
    });
    await page.locator('#next').click();

    await waitForMode('video');
    visibility = await stageLayerVisibility();
    for (const id of ['background', 'characters', 'images', 'dialogue', 'player-controls']) assert.equal(visibility[id], 'hidden', `video-only hides ${id}`);
    assert.equal(visibility['video-layer'], 'visible');
    assert.equal(visibility['bottom-fog'], 'hidden');
    assert.equal(await page.locator('#video-layer > video').count(), 1);
    await page.waitForFunction(() => !document.querySelector('#stage').dataset.visualOnly && runtime.sceneState.video === null);
    assert.equal(await page.locator('#video-layer > video').count(), 0, 'the screen returns to the retained scene when video playback finishes');
    await page.locator('#next').click();
    await page.waitForFunction(() => document.querySelector('#video-layer video')?.style.opacity === '0.4');
    const videoStacking = await page.evaluate(() => ({ video: getComputedStyle(document.querySelector('#video-layer video')).zIndex, characters: getComputedStyle(document.querySelector('#characters .actor')).zIndex, dialogue: getComputedStyle(document.querySelector('#dialogue')).zIndex }));
    assert.deepEqual(videoStacking, { video: '100000000', characters: '200000001', dialogue: '500000000' }, 'semi-transparent video is behind characters and the dialogue UI');
    await page.waitForFunction(() => Math.abs(runtime.sceneState.camera.zoom - 1.25) < 0.001);
    await page.waitForFunction(() => document.querySelector('#dialogue').hidden);
    await page.waitForFunction(() => !document.querySelector('#dialogue').hidden && Math.abs(runtime.sceneState.camera.zoom - 1) < 0.001);
    assert.deepEqual(errors, []);
    console.log('PASS Browser layered video, opacity, camera, dialogue visibility, --only rendering and cleanup');
  } finally {
    if (browser) await browser.close();
    child.kill();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
