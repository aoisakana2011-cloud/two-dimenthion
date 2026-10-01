'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pack } = require('../tools/pack');
const { seedEmptyProject } = require('../tools/project-layout');

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-game-screens-native-'));
  try {
    const project = seedEmptyProject(path.join(tempRoot, 'project'));
    const uiTheme = JSON.parse(await fs.readFile(path.resolve(__dirname, '../Title/setting/player-ui.json'), 'utf8'));
    uiTheme.screen.width = 1440;
    uiTheme.screen.height = 810;
    await fs.writeFile(path.join(project.settingsRoot, 'player-ui.json'), JSON.stringify(uiTheme, null, 2));
    await fs.appendFile(project.settingFile, 'native_ui_theme = player-ui.json\n');
    const imagePath = path.join(project.assetsRoot, 'bg', 'title.png');
    await fs.copyFile(path.resolve(__dirname, '../Title/asset/bg/title.png'), imagePath);
    await fs.copyFile(path.resolve(__dirname, '../Title/asset/bg/near_home.jpg'), path.join(project.assetsRoot, 'bg', 'near_home.jpg'));
    await fs.copyFile(path.resolve(__dirname, '../Title/asset/bg/school.jpg'), path.join(project.assetsRoot, 'bg', 'school.jpg'));
    const characterDirectory = path.join(project.assetsRoot, 'char');
    await fs.mkdir(characterDirectory, { recursive: true });
    for (const name of ['ayaka_normal.png', 'ayaka_dere.png', 'sisiter_normal.png', 'sister_dere.png']) {
      await fs.copyFile(path.resolve(__dirname, `../Title/asset/char/${name}`), path.join(characterDirectory, name));
    }
    const uiAssetDirectory = path.join(project.assetsRoot, 'ui');
    await fs.mkdir(uiAssetDirectory, { recursive: true });
    for (const name of ['dialogue-panel-romance.png', 'speaker-plate-romance.png', 'choice-romance.png']) {
      await fs.copyFile(path.resolve(__dirname, `../Title/asset/ui/${name}`), path.join(uiAssetDirectory, name));
    }
    const config = JSON.parse(await fs.readFile(path.resolve(__dirname, '../Title/setting/game-screens.json'), 'utf8'));
    await fs.writeFile(path.join(project.settingsRoot, 'game-screens.json'), JSON.stringify(config, null, 2));
    for (const name of new Set([config.stylesheet, config.controlSettings, ...Object.values(config.screens).map(screen => screen.template)].filter(Boolean))) {
      const target = path.join(project.settingsRoot, ...name.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.resolve(__dirname, '../Title/setting', ...name.split('/')), target);
    }
    const titleTemplatePath = path.join(project.settingsRoot, ...config.screens.title.template.split('/'));
    const titleCssPath = path.join(project.settingsRoot, ...config.stylesheet.split('/'));
    await fs.mkdir(path.join(project.assetsRoot, 'ui'), { recursive: true });
    await fs.copyFile(path.resolve(__dirname, '../Title/asset/ui/speaker-plate-romance.png'), path.join(project.assetsRoot, 'ui', 'screen-badge.png'));
    const titleMarkup = await fs.readFile(titleTemplatePath, 'utf8');
    await fs.writeFile(titleTemplatePath, titleMarkup.replace('</main>', '<input class="control-smoke-slider" type="range" min="0" max="1" step="0.01" data-setting="audio.bgm" aria-label="BGM"><input class="control-smoke-toggle" type="checkbox" data-setting="audio.bgmMuted" aria-label="Mute BGM"><img id="package-art" src="asset/ui/screen-badge.png" alt="title art"></main>'), 'utf8');
    await fs.appendFile(titleCssPath, '\n#package-art{position:absolute;left:500px;top:20px;width:96px;height:54px;object-fit:contain;z-index:-1}\n.control-smoke-slider{position:absolute;left:820px;top:110px;width:280px;height:24px}.control-smoke-toggle{position:absolute;left:820px;top:150px;width:24px;height:24px}\n', 'utf8');
    const packagePath = path.join(project.buildRoot, 'main.nsp.json');
    const packaged = await pack(path.join(project.scenesRoot, 'main.tds'), packagePath, { projectRoot: project.projectRoot });
    assert.equal(packaged.native_ui.game_screens, 'ui/game-screens.json');
    const packagedScreens = JSON.parse(await fs.readFile(path.join(path.dirname(packagePath), 'asset', 'ui', 'game-screens.json'), 'utf8'));
    assert.deepEqual(packagedScreens.canvas, { width: 1440, height: 810 }, 'native package receives display dimensions resolved from the shared UI settings');
    assert.ok(packagedScreens.screens.title.uiTree?.length, 'HTML/CSS is compiled to the renderer-neutral layout tree');
    assert.equal(packagedScreens.controlDefaults['audio.voice'], 0.5, 'native package receives the validated shared control defaults');
    const soundTree = packagedScreens.screens.sound.uiTree;
    const controlKeys = [];
    const collectControls = nodes => { for (const node of nodes || []) { if (node.tag === 'input') controlKeys.push(node.attrs['data-setting']); collectControls(node.children); } };
    collectControls(soundTree);
    assert.ok(controlKeys.includes('audio.bgm') && controlKeys.includes('audio.bgmMuted') && controlKeys.includes('ui.dialogOpacity'), 'the same declarative sliders and toggles reach the Native renderer');
    assert.ok(packagedScreens.screens.title.items.some(item => item.action === 'start'), 'compiled click targets survive native packaging');
    assert.ok(JSON.stringify(packagedScreens.screens.title.uiTree).includes('asset/ui/choice-romance.png'), 'title button art is retained in the Native UI tree');
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'bg', 'title.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'bg', 'school.jpg'));
    assert.ok(JSON.stringify(packagedScreens.screens.title.uiTree).includes('ui/screen-badge.png'), 'asset-relative HTML images are retained in the shared tree');
    const card = packagedScreens.screens.save.uiTree[0].children.find(node => node.attrs?.['data-role'] === 'save-slots')?.children[0];
    assert.equal(card?.children.find(node => node.attrs?.['data-slot-field'] === 'number')?.attrs['data-slot-field'], 'number', 'Native package retains slot-card field bindings');
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'screen-badge.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'dialogue-panel-romance.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'choice-romance.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'speaker-plate-romance.png'));
    const exe = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
    const smoke = spawnSync(exe, [packagePath, '--screen-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(smoke.status, 0, smoke.stderr || smoke.error?.message);
    const saveSmoke = spawnSync(exe, [packagePath, '--screen-save-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NOVEL_SAVE_ROOT: path.join(tempRoot, 'capture-saves'), SDL_AUDIODRIVER: 'dummy', SDL_VIDEODRIVER: 'dummy' },
    });
    assert.equal(saveSmoke.status, 0, saveSmoke.stderr || saveSmoke.error?.message || saveSmoke.stdout);
    assert.deepEqual(JSON.parse(saveSmoke.stdout.trim()), { save: true, thumbnail: true, text: 'revised' });
    if (process.platform === 'win32' && process.env.NOVEL_SKIP_WEBVIEW_SMOKE !== '1') {
      const webSmoke = spawnSync(exe, [packagePath, '--screen-web-smoke'], {
        encoding: 'utf8', timeout: 20000, windowsHide: true,
        env: { ...process.env, NOVEL_SAVE_ROOT: path.join(tempRoot, 'user-data'), SDL_AUDIODRIVER: 'dummy', SDL_VIDEODRIVER: 'windows' },
      });
      assert.equal(webSmoke.status, 0, webSmoke.stderr || webSmoke.error?.message || webSmoke.stdout);
      assert.deepEqual(JSON.parse(webSmoke.stdout.trim()), { webReady: true, imageLoaded: true, activeScreen: 'sound', bgmVolume: 0.37, resized: true });
      const webSettings = JSON.parse(await fs.readFile(path.join(tempRoot, 'user-data', 'ui-settings.json'), 'utf8'));
      assert.equal(webSettings['audio.bgm'], 0.37, 'WebView2 range changes are persisted outside the build output');
    }
    await fs.mkdir(path.join(project.buildRoot, 'saves'), { recursive: true });
    await fs.writeFile(path.join(project.buildRoot, 'saves', 'slot-1.json'), JSON.stringify({ version: 1, file: 'main.tds', scene: 'main', line: 1, variables: {}, speaker: '語り手', text: '保存した場面', savedAt: Date.now() }));
    await fs.writeFile(path.join(project.buildRoot, 'saves', 'slot-2.json'), JSON.stringify({ version: 1, scene: 'broken', line: 1, variables: {} }));
    await fs.writeFile(path.join(project.buildRoot, 'saves', 'slot-3.json'), JSON.stringify({ version: 1, saveId: 'another-work', file: 'main.tds', scene: 'main', line: 1, variables: {} }));
    const slotSmoke = spawnSync(exe, [packagePath, '--screen-slot-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(slotSmoke.status, 0, slotSmoke.stderr || slotSmoke.error?.message);
    const slotResult = JSON.parse(slotSmoke.stdout.trim());
    assert.equal(slotResult.continueAvailable, true);
    assert.deepEqual(slotResult['save-slots'], { count: 12, firstStatus: 'saved', secondStatus: 'empty', thirdStatus: 'empty', thirdState: 'incompatible' });
    assert.deepEqual(slotResult['load-slots'], { count: 12, firstStatus: 'saved', secondStatus: 'empty', thirdStatus: 'empty', thirdState: 'incompatible' });
    const controlSmoke = spawnSync(exe, [packagePath, '--screen-control-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(controlSmoke.status, 0, controlSmoke.stderr || controlSmoke.error?.message);
    const preferences = JSON.parse(await fs.readFile(path.join(project.buildRoot, 'saves', 'ui-settings.json'), 'utf8'));
    assert.ok(Math.abs(preferences['audio.bgm'] - 0.75) < 0.03, `Native range interaction should update the stored value: ${controlSmoke.stdout}`);
    assert.equal(preferences['audio.bgmMuted'], true, 'Native checkbox interaction should persist the toggle');
    console.log('PASS native game screen package: title/menu descriptions and background render');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
