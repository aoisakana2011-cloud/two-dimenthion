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
  await fs.writeFile(path.join(project.scenesRoot, 'main.tds'), 'asset bg test_background = "asset/ui/backgrounds/spring-ensemble-key-visual.png"\nscene main {\n  bg test_background\n  say narrator "新しい作品を始めます。"\n  say narrator "skip-stop-line"\n  say narrator "auto-start-line"\n  say narrator "auto-intermediate-line"\n  say narrator "auto-finish-line"\n}\n', 'utf8');
  await fs.writeFile(path.join(project.scenesRoot, 'title.tds'), 'scene title_front { say narrator "TDS title reached" }\n', 'utf8');
  const prototypeScreens = JSON.parse(await fs.readFile(path.join(root, 'Title', 'setting', 'game-screens.json'), 'utf8'));
  await fs.writeFile(path.join(project.settingsRoot, 'game-screens.json'), JSON.stringify(prototypeScreens, null, 2));
  for (const skin of Object.values(prototypeScreens.controlSkins || {})) {
    for (const key of ['track', 'fill', 'thumb', 'thumbHover', 'off', 'on', 'offHover', 'onHover']) {
      if (!skin[key]) continue;
      const relative = skin[key].replace(/^asset[\\/]/, '');
      const target = path.join(project.assetsRoot, ...relative.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(root, 'Title', 'asset', ...relative.split('/')), target);
    }
  }
  await fs.mkdir(path.join(project.assetsRoot, 'bg'), { recursive: true });
  await fs.copyFile(path.join(root, 'Title', 'asset', 'bg', 'title.png'), path.join(project.assetsRoot, 'bg', 'title.png'));
  await fs.copyFile(path.join(root, 'Title', 'asset', 'bg', 'near_home.jpg'), path.join(project.assetsRoot, 'bg', 'near_home.jpg'));
  await fs.copyFile(path.join(root, 'Title', 'asset', 'bg', 'school.jpg'), path.join(project.assetsRoot, 'bg', 'school.jpg'));
  await fs.mkdir(path.join(project.assetsRoot, 'ui'), { recursive: true });
  await fs.copyFile(path.join(root, 'Title', 'asset', 'ui', 'choice-romance.png'), path.join(project.assetsRoot, 'ui', 'choice-romance.png'));
  for (const name of ['backgrounds/spring-ensemble-key-visual.png', 'portraits/ayaka-volume.png', 'portraits/sister-volume.png', 'buttons/sakura-menu-plate.png', 'buttons/sakura-menu-plate-hover-v2.png', 'logos/spring-late-love-title-v2.png']) {
    const target = path.join(project.assetsRoot, 'ui', ...name.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, 'Title', 'asset', 'ui', ...name.split('/')), target);
  }
  await fs.mkdir(path.join(project.assetsRoot, 'ui', 'icons'), { recursive: true });
  for (const name of ['save', 'load', 'system', 'sound', 'favorite', 'tips', 'menu-back', 'menu-next', 'menu-auto', 'menu-skip', 'menu-log', 'menu-close', 'menu-hold']) {
    await fs.copyFile(path.join(root, 'Title', 'asset', 'ui', 'icons', `${name}.png`), path.join(project.assetsRoot, 'ui', 'icons', `${name}.png`));
  }
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
    const scaleMode = page.locator('.game-screen-toolbar select[aria-label="画面サイズへの適応"]');
    assert.equal(await scaleMode.inputValue(), 'contain', 'screen-size adaptation defaults to aspect-preserving contain');
    const previewRatio = page.locator('.game-screen-toolbar select[aria-label="プレビュー画面比率"]');
    await previewRatio.selectOption('4:3');
    await scaleMode.selectOption('cover');
    const coverPreview = await page.locator('.game-screen-preview > *').first().evaluate(node => ({
      left: Number.parseFloat(node.style.left), top: Number.parseFloat(node.style.top),
      transform: NovelScreenDocument.canvasTransform(node.parentElement.clientWidth, node.parentElement.clientHeight, { width: 1440, height: 810 }, 'cover'),
      ratio: getComputedStyle(node.parentElement).aspectRatio,
      backgroundSize: getComputedStyle(node.parentElement).backgroundSize,
    }));
    assert.equal(coverPreview.ratio, '4 / 3');
    assert.equal(coverPreview.backgroundSize.split(',').at(-1).trim(), 'cover', 'editor preview keeps screen backgrounds proportional like Browser and Native playback');
    assert.ok(coverPreview.transform.offsetX < 0, 'cover preview crops horizontally for a 4:3 viewport');
    assert.ok(Math.abs(coverPreview.left - coverPreview.transform.offsetX) < 1, 'editor places the authored canvas at the same cover offset used by playback');
    await scaleMode.selectOption('contain');
    const containPreview = await page.locator('.game-screen-preview > *').first().evaluate(node => ({
      top: Number.parseFloat(node.style.top),
      transform: (() => { const preview = document.querySelector('.game-screen-preview'); return NovelScreenDocument.canvasTransform(preview.clientWidth, preview.clientHeight, { width: 1440, height: 810 }, 'contain'); })(),
    }));
    assert.ok(containPreview.transform.offsetY > 0, 'contain preview letterboxes a 16:9 canvas in a 4:3 viewport');
    assert.ok(Math.abs(containPreview.top - containPreview.transform.offsetY) < 1, 'letterbox offset is reflected in editor layout');
    await scaleMode.selectOption('cover');
    assert.equal(await page.locator('.game-screen-preview [data-slot-index="0"] [data-slot-field="number"]').textContent(), '01', 'editor preview preserves authored card fields');
    assert.equal(await page.locator('.game-screen-preview [data-slot-index="0"] [data-slot-field="status"]').textContent(), '記録あり');
    await page.locator('.game-screen-toolbar select[aria-label="編集する画面"]').selectOption('title');
    assert.equal(await page.locator('.game-screen-toolbar button').filter({ hasText: 'HTML/CSSが正本' }).isDisabled(), true, 'template-backed screens cannot switch to a JSON-only visual editor');
    const apiScreens = await (await page.request.get(`${base}/api/game-screens`)).json();
    const titleHtmlPath = prototypeScreens.screens.title.template;
    const transparentButtonStyle = await page.locator('.game-screen-preview #title-start').evaluate(node => {
      const style = getComputedStyle(node);
      return { backgroundImage: style.backgroundImage, textColor: getComputedStyle(node.querySelector('.title-main')).color, borderWidth: style.borderTopWidth };
    });
    assert.match(transparentButtonStyle.backgroundImage, /sakura-menu-plate\.png/, 'the title uses the generated sakura button artwork');
    assert.equal(transparentButtonStyle.textColor, 'rgb(98, 73, 87)', 'menu labels remain independently rendered on the generated plate');
    assert.equal(transparentButtonStyle.borderWidth, '0px', 'title rows have no extra rectangular outline');
    const generatedButtonImage = await page.locator('.game-screen-preview #title-start').evaluate(async node => {
      const source = getComputedStyle(node).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
      if (!source) throw Error('Title button background image URL is missing');
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 1, 1);
      return { width: image.naturalWidth, height: image.naturalHeight, cornerPixel: Array.from(context.getImageData(0, 0, 1, 1).data) };
    });
    assert.ok(generatedButtonImage.width > 100 && generatedButtonImage.height > 30, 'generated button art loads from the project asset route');
    assert.ok(generatedButtonImage.cornerPixel[3] > 245, 'the generated pearl button surface is an intentional solid button face, not a transparent sprite');
    await page.locator('.game-screen-inspector textarea[aria-label="画面HTML"]').fill(apiScreens.documents[titleHtmlPath].replace('GAME START', '物語を始める'));
    const sharedCss = await page.locator('.game-screen-inspector textarea[aria-label="共通CSS"]').inputValue();
    await page.locator('.game-screen-inspector textarea[aria-label="共通CSS"]').fill(`${sharedCss}\n.title-menu{background-color:rgba(16,24,32,0.85);border:1px solid #304050}\n.title-item:hover{color:#ffffff;background-color:#315f80}`);
    await page.locator('.game-screen-settings footer button').click();
    await page.getByText('画面設定を保存しました。').waitFor().catch(async error => {
      throw Error(`${error.message}\neditor status: ${await page.locator('.game-screen-status').textContent()}`);
    });
    const saved = await (await page.request.get(`${base}/api/game-screens`)).json();
    assert.equal(saved.configured, true);
    assert.deepEqual(saved.screens.canvas, { width: 1440, height: 810 }, 'game screen canvas is derived from the shared player display dimensions');
    assert.equal(saved.screens.scaleMode, 'cover', 'screen-size adaptation mode is persisted through the editor');
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
    await page.evaluate(async () => {
      await saveStore.writeSlot(20, JSON.stringify({ version: 1, scene: 'damaged', line: 0, variables: {} }));
      await saveStore.writeSlot(21, JSON.stringify({ version: 1, saveId: 'another-work', file: 'main.tds', scene: 'main', line: 1, variables: {} }));
    });
    await page.reload();
    await page.locator('#screen-overlay .title-menu').waitFor();
    const titleLogo = page.locator('#screen-overlay .title-logo');
    assert.equal(await titleLogo.getAttribute('alt'), '春、遅刻から始まる恋', 'the title artwork keeps its accessible exact story name');
    await page.waitForFunction(() => { const image = document.querySelector('#screen-overlay .title-logo'); return image?.complete && image.naturalWidth > 0; });
    const titleLogoAlpha = await titleLogo.evaluate(async image => {
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
      let left = width, top = height, right = 0, bottom = 0, edgePixels = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (!data[(y * width + x) * 4 + 3]) continue;
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        if (!x || !y || x === width - 1 || y === height - 1) edgePixels++;
      }
      return { width, height, left, top, right, bottom, edgePixels };
    });
    assert.ok(titleLogoAlpha.left > 0 && titleLogoAlpha.top > 0 && titleLogoAlpha.right < titleLogoAlpha.width - 1 && titleLogoAlpha.bottom < titleLogoAlpha.height - 1 && titleLogoAlpha.edgePixels === 0, `generated logo has clean transparent padding and no edge speckle: ${JSON.stringify(titleLogoAlpha)}`);
    assert.ok(await titleLogo.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.right > window.innerWidth * 0.85 && rect.top > window.innerHeight * 0.35;
    }), 'the generated title logo occupies the lower-right title-art area');
    await captureScreen('title');
    assert.equal(await page.locator('#screen-overlay .title-menu').count(), 1, 'custom HTML layout is rendered by the player');
    assert.match(await page.locator('#screen-overlay .title-menu').evaluate(node => getComputedStyle(node).backgroundColor), /rgba\(16, 24, 32, 0\.85\)/);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'start', 'the first available menu action receives keyboard focus');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'load', 'directional navigation follows screen geometry');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'start');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'load');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'start');
    const playerTitleStart = page.locator('#screen-overlay #title-start');
    await playerTitleStart.evaluate(node => node.blur());
    await page.mouse.move(1270, 710);
    const normalPlayerButtonImage = await playerTitleStart.evaluate(node => getComputedStyle(node).backgroundImage);
    await playerTitleStart.hover();
    const activePlayerButtonImage = await playerTitleStart.evaluate(node => getComputedStyle(node).backgroundImage);
    assert.match(activePlayerButtonImage, /sakura-menu-plate-hover-v2\.png/, 'Browser player hover switches to the clearly illuminated selected-state image');
    assert.notEqual(activePlayerButtonImage, normalPlayerButtonImage, 'Browser player applies a distinct image for the active button');
    await page.locator('#screen-overlay [data-action="quit"]').click();
    await page.waitForURL(base + '/');
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay .title-menu').waitFor();
    assert.equal(await page.locator('#player-controls').isVisible(), false, 'story shortcuts do not appear behind the title screen');
    await page.keyboard.press('F1');
    await page.locator('#screen-overlay .system-options').waitFor();
    assert.equal(await page.locator('#screen-overlay .screen-title').evaluate(node => getComputedStyle(node).marginTop), '0px', 'portable heading reset prevents Browser user-agent margins from shifting text away from Native geometry');
    const f1Binding = page.locator('#screen-overlay [data-action="shortcut-cycle"][data-target="F1"]');
    assert.match(await f1Binding.textContent(), /システム/);
    await f1Binding.click();
    assert.match(await page.locator('#screen-overlay [data-action="shortcut-cycle"][data-target="F1"]').textContent(), /セーブ/, 'the SYSTEM page cycles the actual F1 binding and redraws its label');
    await page.waitForFunction(async () => (await saveStore.readPreference('ui-settings'))?.['ui.shortcut.F1'] === 'save');
    await page.keyboard.press('F1');
    await page.locator('#screen-overlay .save-slot-grid').waitFor();
    assert.equal(await page.evaluate(() => activeGameScreen), 'save', 'remapped F1 opens the Save screen, not the hard-coded SYSTEM screen');
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.keyboard.press('F1');
    await page.locator('#screen-overlay .save-slot-grid').waitFor();
    assert.equal(await page.evaluate(() => activeGameScreen), 'save', 'the remapped key still opens Save after reloading the Browser player');
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="system"]').click();
    await page.locator('#screen-overlay .system-options').waitFor();
    for (let index = 0; index < 11; index++) await page.locator('#screen-overlay [data-action="shortcut-cycle"][data-target="F1"]').click();
    assert.match(await page.locator('#screen-overlay [data-action="shortcut-cycle"][data-target="F1"]').textContent(), /システム/, 'cycling can restore the original binding');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="system"]').click();
    await page.locator('#screen-overlay .system-options').waitFor();
    assert.equal(await page.locator('#player-controls').isVisible(), false, 'story Save/Load shortcuts are hidden behind a custom game screen');
    assert.equal(await page.locator('#screen-overlay .shortcut-row').count(), 12, 'the system screen exposes twelve editable function-key bindings');
    assert.equal(await page.locator('#screen-overlay .screen-tabs .tab-button').count(), 6, 'system page has the same six top navigation tabs as the reference');
    await page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.fontFamily"][data-value="mincho"]').click();
    await page.waitForFunction(async () => (await saveStore.readPreference('ui-settings'))?.['ui.fontFamily'] === 'mincho');
    await page.reload();
    await page.locator('#screen-overlay .title-menu').waitFor();
    assert.equal(await page.locator('#stage').evaluate(node => getComputedStyle(node).fontFamily), 'serif', 'the selected font is restored when the Browser player restarts');
    await page.keyboard.press('F1');
    await page.locator('#screen-overlay .system-options').waitFor();
    await page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.fontFamily"][data-value="default"]').click();
    assert.equal(await page.locator('#stage').evaluate(node => node.style.fontFamily), '', 'selecting Default restores the authored project font');
    await page.waitForFunction(() => [...document.querySelectorAll('#screen-overlay .screen-tabs .tab-icon')].length === 6 && [...document.querySelectorAll('#screen-overlay .screen-tabs .tab-icon')].every(node => node.complete && node.naturalWidth > 0));
    assert.deepEqual(await page.locator('#screen-overlay .screen-tabs .tab-icon').evaluateAll(nodes => nodes.map(node => ({ source: node.getAttribute('src'), loaded: node.complete && node.naturalWidth > 0 }))), [
      { source: '/asset/ui/icons/save.png', loaded: true }, { source: '/asset/ui/icons/load.png', loaded: true },
      { source: '/asset/ui/icons/system.png', loaded: true }, { source: '/asset/ui/icons/sound.png', loaded: true },
      { source: '/asset/ui/icons/favorite.png', loaded: true }, { source: '/asset/ui/icons/tips.png', loaded: true },
    ], 'the six image-based navigation icons load as transparent project assets');
    assert.deepEqual(await page.locator('#screen-overlay input[data-setting]').evaluateAll(nodes => nodes.map(node => node.dataset.setting).sort()), ['ui.autoSpeed', 'ui.cursorHideDelay', 'ui.textSpeed'].sort(), 'continuous preferences remain native range controls');
    assert.equal(await page.locator('#screen-overlay [data-action="setting-value"]').count(), 13, 'five binary settings and three typeface choices are actionable buttons');
    await page.locator('#screen-overlay input[data-setting="ui.textSpeed"]').fill('0');
    const fullscreenToggle = page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.fullscreen"][data-value="true"]');
    await fullscreenToggle.click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    const windowMode = page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.fullscreen"][data-value="false"]');
    await windowMode.click();
    await page.waitForFunction(() => !document.fullscreenElement);
    const effectsOff = page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.effects"][data-value="false"]');
    const effectsOn = page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.effects"][data-value="true"]');
    await effectsOff.click();
    assert.equal(await effectsOff.getAttribute('aria-pressed'), 'true', 'the selected effects value is visibly and accessibly reflected');
    assert.equal(await effectsOn.getAttribute('aria-pressed'), 'false');
    await effectsOn.click();
    assert.equal(await effectsOn.getAttribute('aria-pressed'), 'true', 'selecting the opposite value updates the visible state');
    await captureScreen('system');
    const fontMincho = page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.fontFamily"][data-value="mincho"]');
    await fontMincho.click();
    assert.equal(await fontMincho.getAttribute('aria-pressed'), 'true', 'font selection updates the checked state');
    assert.equal(await page.locator('#stage').evaluate(node => getComputedStyle(node).fontFamily), 'serif', 'font selection affects the shared game stage, not only the control label');
    await page.waitForFunction(async () => (await saveStore.readPreference('ui-settings'))?.['ui.fontFamily'] === 'mincho');
    await page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.fontFamily"][data-value="default"]').click();
    assert.equal(await page.locator('#stage').evaluate(node => node.style.fontFamily), '', 'default restores the authored player font stack');
    await page.evaluate(() => { window.__novelResizeRequest = null; window.__novelResizeExpected = [playerTheme.screen.width + Math.max(0, outerWidth - innerWidth), playerTheme.screen.height + Math.max(0, outerHeight - innerHeight)]; window.resizeTo = (width, height) => { window.__novelResizeRequest = [width, height]; }; });
    await page.locator('#screen-overlay [data-action="reset-window-size"]').click();
    assert.deepEqual(await page.evaluate(() => window.__novelResizeRequest), await page.evaluate(() => window.__novelResizeExpected), 'window-size reset requests this project’s authored content viewport, including host chrome');
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="sound"]').click();
    await page.locator('#screen-overlay .volume-panel').waitFor();
    assert.equal(await page.locator('#screen-overlay .novel-skinned-control[data-skin="volume"]').count(), 7, 'global and character voice sliders use the shared art skin');
    assert.equal(await page.locator('#screen-overlay .novel-skinned-control[data-skin="mute"]').count(), 5, 'global and character mute checkboxes use the shared art skin');
    const volumeSkin = page.locator('#screen-overlay .novel-skinned-control[data-skin="volume"]').nth(1);
    await volumeSkin.hover({ position: { x: 140, y: 12 } });
    assert.match(await volumeSkin.locator('.novel-skin-thumb').getAttribute('data-asset-source'), /thumb-hover\.png$/, 'hover swaps the slider thumb artwork');
    const muteSkin = page.locator('#screen-overlay .novel-skinned-control[data-skin="mute"]').first();
    await muteSkin.hover();
    assert.match(await muteSkin.locator('.novel-skin-checkbox').getAttribute('data-asset-source'), /mute-off-hover\.png$/, 'hover swaps the unchecked control artwork');
    await muteSkin.click();
    assert.match(await muteSkin.locator('.novel-skin-checkbox').getAttribute('data-asset-source'), /mute-on-hover\.png$/, 'checked hover uses its own artwork state');
    await muteSkin.click();
    await captureScreen('sound-control-skins');
    assert.ok(await page.locator('#screen-overlay input[data-setting="audio.bgm"]').count(), 'the sound page exposes actual runtime audio controls');
    assert.ok(await page.locator('#screen-overlay [data-target="sound"]').count() >= 1, 'sound is a separate top-level page, like the reference');
    await captureScreen('sound');
    await page.locator('#screen-overlay input[data-setting="audio.bgm"]').fill('0.42');
    assert.equal(await page.locator('#screen-overlay input[data-setting="audio.bgm"]').inputValue(), '0.42');
    const ayakaVoice = page.locator('#screen-overlay input[data-setting="audio.voice.ayaka"]');
    const sisterVoice = page.locator('#screen-overlay input[data-setting="audio.voice.sister"]');
    assert.equal(await ayakaVoice.count(), 1);
    assert.equal(await sisterVoice.count(), 1);
    await ayakaVoice.fill('0.36');
    const ayakaMute = page.locator('#screen-overlay input[data-setting="audio.voice.ayaka.muted"]');
    await ayakaMute.locator('xpath=..').click();
    assert.equal(await ayakaMute.isChecked(), true, 'speaker-specific mute is an independent real checkbox');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .system-options').waitFor();
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.keyboard.press('F1');
    await page.locator('#screen-overlay input[data-setting="ui.textSpeed"]').waitFor();
    assert.equal(await page.locator('#screen-overlay input[data-setting="ui.textSpeed"]').inputValue(), '0', 'text speed preference persists after reopening SYSTEM');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .title-menu').waitFor();
    assert.equal(await page.locator('#player-controls').isVisible(), false, 'story shortcuts stay hidden while navigating between custom screens');
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="system"]').click();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="sound"]').click();
    assert.equal(await page.locator('#screen-overlay input[data-setting="audio.bgm"]').inputValue(), '0.42', 'image-skinned slider value persists after leaving and reopening settings');
    assert.equal(await page.locator('#screen-overlay input[data-setting="audio.voice.ayaka"]').inputValue(), '0.36', 'character voice level persists independently of the common voice bus');
    assert.equal(await page.locator('#screen-overlay input[data-setting="audio.voice.sister"]').inputValue(), '1', 'another speaker retains its distinct default');
    assert.equal(await page.locator('#screen-overlay input[data-setting="audio.voice.ayaka.muted"]').isChecked(), true, 'speaker mute persists independently');
    const muteInput = page.locator('#screen-overlay input[data-setting="audio.bgmMuted"]');
    await muteInput.focus();
    await page.keyboard.press('Space');
    assert.equal(await muteInput.isChecked(), true, 'image-skinned checkbox remains keyboard-operable');
    await page.keyboard.press('Space');
    assert.equal(await muteInput.isChecked(), false, 'keyboard can restore the checkbox state');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="about"]').click();
    assert.match(await page.locator('#screen-overlay').innerText(), /入学式の日/);
    await captureScreen('extra');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.locator('#screen-overlay [data-action="start"]').filter({ hasText: '物語を始める' }).click();
    await page.waitForFunction(() => { const text = document.querySelector('#text')?.textContent || ''; return text.length > 0 && text.length < '新しい作品を始めます。'.length; });
    assert.notEqual(await page.locator('#text').textContent(), '新しい作品を始めます。', 'low text-speed setting reveals dialogue progressively');
    await page.locator('#dialogue').click();
    await page.locator('#text').filter({ hasText: '新しい作品を始めます。' }).waitFor();
    assert.equal(await page.locator('#player-controls').isVisible(), true, 'Save/Load shortcuts appear during the story');
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="resume"]').first().waitFor();
    assert.equal(await page.locator('#player-controls').isVisible(), false, 'Save/Load shortcuts are hidden under the pause screen');
    assert.equal(await page.locator('#screen-overlay .pause-grid button.pause-button > img.pause-icon').count(), 14, 'every pause action uses a dedicated image node rather than a font glyph');
    await page.waitForFunction(() => [...document.querySelectorAll('#screen-overlay .pause-grid button.pause-button > img.pause-icon')].every(node => node.complete && node.naturalWidth > 0), null, { timeout: 10000 });
    await captureScreen('pause');
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="log"] .pause-icon').click();
    await page.locator('#screen-overlay [data-role="dialogue-history"] .history-entry').waitFor();
    assert.match(await page.locator('#screen-overlay [data-role="dialogue-history"]').innerText(), /新しい作品を始めます/);
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="hold"]').click();
    await page.locator('#screen-overlay').waitFor({ state: 'hidden' });
    await page.locator('#next').click();
    assert.equal(await page.locator('#text').textContent(), '新しい作品を始めます。', 'HOLD suppresses ordinary dialogue clicks');
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="hold"]').click();
    assert.equal(await page.locator('#text').textContent(), '新しい作品を始めます。', 'disabling HOLD does not itself consume a dialogue advance');
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="resume"]').first().waitFor();
    await page.locator('#screen-overlay [data-action="quick-save"]').click();
    await page.locator('#screen-overlay .game-screen-notice').filter({ hasText: 'クイックセーブしました' }).waitFor();
    const quickLoadNavigation = page.waitForNavigation();
    await page.locator('#screen-overlay [data-action="quick-load"]').click();
    await quickLoadNavigation;
    await page.locator('#text').filter({ hasText: '新しい作品を始めます。' }).waitFor();
    await page.waitForFunction(() => document.querySelector('#screen-overlay')?.hidden === true);
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="resume"]').first().waitFor();
    await page.locator('#screen-overlay [data-action="save"]').first().click();
    await page.locator('#screen-overlay [data-slot-index]').first().waitFor();
    assert.equal(await page.locator('#screen-overlay [data-slot-index]').count(), 12, 'the HTML save-slots role expands into the configured 12-slot grid');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"]').isDisabled(), false, 'save slot is enabled while a scenario line is active');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="number"]').textContent(), '01');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="status"]').textContent(), '空き');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="1"] [data-slot-field="thumbnail"]').getAttribute('src'), null, 'an empty save card has no broken blank image URL');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="1"] [data-slot-field="thumbnail"]').evaluate(node => getComputedStyle(node).display), 'none', 'empty cards do not render an image placeholder frame');
    const slotRects = await page.locator('#screen-overlay [data-slot-index]').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { index: node.dataset.slotIndex, x: r.x, y: r.y, w: r.width, h: r.height, inline: node.style.cssText, parent: node.parentElement.getBoundingClientRect().toJSON() }; }));
    assert.equal(new Set(slotRects.map(rect => `${rect.x},${rect.y}`)).size, 12, `save-slot cards must occupy separate CSS grid cells: ${JSON.stringify(slotRects)}`);
    const overlaps = slotRects.flatMap((a, i) => slotRects.slice(i + 1).filter(b => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).map(b => [a.index, b.index]));
    assert.equal(overlaps.length, 0, `CSS grid cells must not overlap: ${JSON.stringify(slotRects)}`);
    await page.locator('#screen-overlay [data-slot-index="0"]').click();
    await page.locator('#screen-overlay [data-action="slot-commit"]').click();
    await page.locator('#screen-overlay .game-screen-notice').filter({ hasText: '保存しました' }).waitFor();
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="status"]').textContent(), '記録あり');
    assert.ok(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="thumbnail"]').getAttribute('src'), 'a saved card binds its captured thumbnail');
    assert.notEqual(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="thumbnail"]').evaluate(node => getComputedStyle(node).display), 'none', 'a saved card reveals its thumbnail when the screen is refreshed');
    assert.match(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="text"]').textContent(), /新しい作品を始めます/);
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="load"]').first().click();
    await captureScreen('load');
    assert.equal(await page.locator('#screen-overlay [data-slot-index]').count(), 12, 'load screen uses the same custom slot layout and count');
    await page.locator('#screen-overlay [data-action="slot-page"][data-target="1"]').click();
    assert.equal(await page.locator('#screen-overlay [data-slot-index="12"] [data-slot-field="number"]').textContent(), '13', 'second save page binds the first card to save slot 13');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="20"] [data-slot-field="status"]').textContent(), '破損', 'Browser preserves the corrupt-save state in the card UI');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="21"] [data-slot-field="status"]').textContent(), '非対応', 'Browser distinguishes saves belonging to another work');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="20"]').getAttribute('data-state'), 'corrupt');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="21"]').getAttribute('data-state'), 'incompatible');
    for (const index of ['12', '20', '21']) assert.equal(await page.locator(`#screen-overlay [data-slot-index="${index}"]`).evaluate(node => getComputedStyle(node).opacity), '1', `disabled ${index} card remains legible without fading its thumbnail or status text`);
    assert.equal(await page.locator('#screen-overlay [data-slot-index="20"]').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(247, 236, 231)', 'the Browser applies the authored corrupt-card state style');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="21"]').evaluate(node => getComputedStyle(node).borderTopColor), 'rgb(170, 149, 107)', 'the Browser applies the authored incompatible-card state style');
    assert.equal(await page.locator('#screen-overlay [data-action="slot-page"][data-target="1"]').evaluate(node => node.classList.contains('slot-page-active')), true, 'page selection is visually reflected');
    await page.locator('#screen-overlay [data-action="slot-page"][data-target="0"]').click();
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"]').isDisabled(), false, 'saved slots become loadable');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="status"]').textContent(), '記録あり');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="system"]').click();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="sound"]').click();
    assert.ok(await page.locator('#screen-overlay input[data-setting="audio.voice"]').count(), 'runtime voice volume remains functional on the sound page');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="resume"]').first().click();
    await page.locator('#screen-overlay').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#player-controls').isVisible(), true, 'story shortcuts return after leaving the screen menu');
    assert.equal(await page.locator('#text').textContent(), '新しい作品を始めます。');
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="system"]').click();
    await page.locator('#screen-overlay input[data-setting="ui.cursorHideDelay"]').fill('0.333333');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="resume"]').first().click();
    await page.waitForTimeout(5400);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('player-cursor-hidden')), true, 'cursor timeout hides the pointer after the configured five seconds');
    await page.mouse.move(50, 50);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('player-cursor-hidden')), false, 'pointer activity restores the cursor and restarts its timeout');
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="skip"]').click();
    await page.locator('#text').filter({ hasText: 'skip-stop-line' }).waitFor();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#text').textContent(), 'skip-stop-line', 'read-only skip stops at the first unseen line instead of consuming it');
    await page.locator('#next').click();
    await page.locator('#text').filter({ hasText: 'auto-start-line' }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="system"]').click();
    const autoSpeed = page.locator('#screen-overlay input[data-setting="ui.autoSpeed"]');
    await autoSpeed.fill('1');
    assert.equal(await autoSpeed.inputValue(), '1', 'auto speed control reaches its maximum setting');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="auto"]').click();
    await page.locator('#text').filter({ hasText: 'auto-finish-line' }).waitFor({ timeout: 7000 });
    assert.equal(await page.locator('#text').textContent(), 'auto-finish-line', 'auto playback uses the selected speed and advances through the next dialogue');
    assert.equal(errors.length, 0, errors.join('\n'));
    const screensForTdsTitle = (await (await page.request.get(`${base}/api/game-screens`)).json()).screens;
    screensForTdsTitle.titleScene = { file: 'title.tds', scene: 'title_front' };
    const titleConfigResponse = await page.request.put(`${base}/api/game-screens`, { data: { screens: screensForTdsTitle } });
    assert.equal(titleConfigResponse.status(), 200, 'TDS title configuration is accepted by the game-screen settings contract');
    await page.goto(`${base}/player.html`);
    await page.locator('#text').filter({ hasText: 'TDS title reached' }).waitFor().catch(async error => {
      throw Error(`${error.message}\nTDS title debug: ${JSON.stringify(await page.evaluate(() => ({ text: document.querySelector('#text')?.textContent, scene: document.querySelector('#scene')?.textContent, overlay: document.querySelector('#screen-overlay')?.textContent?.slice(0, 200), pageErrors: window.__pageErrors || [] })))}`);
    });
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
