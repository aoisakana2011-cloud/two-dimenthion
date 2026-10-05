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
    const probeVoice = Buffer.alloc(44 + 80000 * 2);
    probeVoice.write('RIFF', 0); probeVoice.writeUInt32LE(probeVoice.length - 8, 4); probeVoice.write('WAVE', 8);
    probeVoice.write('fmt ', 12); probeVoice.writeUInt32LE(16, 16); probeVoice.writeUInt16LE(1, 20); probeVoice.writeUInt16LE(1, 22);
    probeVoice.writeUInt32LE(8000, 24); probeVoice.writeUInt32LE(16000, 28); probeVoice.writeUInt16LE(2, 32); probeVoice.writeUInt16LE(16, 34);
    probeVoice.write('data', 36); probeVoice.writeUInt32LE(probeVoice.length - 44, 40);
    await fs.mkdir(path.join(project.assetsRoot, 'voice'), { recursive: true });
    await fs.writeFile(path.join(project.assetsRoot, 'voice', 'mixer-probe.wav'), probeVoice);
    const mainPath = path.join(project.scenesRoot, 'main.tds');
    const mainSource = await fs.readFile(mainPath, 'utf8');
    await fs.writeFile(mainPath, 'asset voice mixer_probe = "asset/voice/mixer-probe.wav"\ncharacter ayaka { name = "綾瀬あやか" }\n' + mainSource, 'utf8');
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
    for (const name of ['ayaka_normal.png', 'ayaka_dere.png', 'sisiter_normal.png', 'sisiter_normal_cutout.png', 'sister_dere.png']) {
      await fs.copyFile(path.resolve(__dirname, `../Title/asset/char/${name}`), path.join(characterDirectory, name));
    }
    const uiAssetDirectory = path.join(project.assetsRoot, 'ui');
    await fs.mkdir(uiAssetDirectory, { recursive: true });
    for (const name of ['dialogue-panel-romance.png', 'speaker-plate-romance.png', 'choice-romance.png']) {
      await fs.copyFile(path.resolve(__dirname, `../Title/asset/ui/${name}`), path.join(uiAssetDirectory, name));
    }
    const generatedUiAssets = [
      ['backgrounds/spring-ensemble-key-visual.png', 'backgrounds/spring-ensemble-key-visual.png'],
      ['portraits/ayaka-volume.png', 'portraits/ayaka-volume.png'],
      ['portraits/sister-volume.png', 'portraits/sister-volume.png'],
      ['buttons/sakura-menu-plate.png', 'buttons/sakura-menu-plate.png'],
      ['buttons/sakura-menu-plate-hover.png', 'buttons/sakura-menu-plate-hover.png'],
      ['buttons/sakura-menu-plate-hover-v2.png', 'buttons/sakura-menu-plate-hover-v2.png'],
      ['logos/spring-late-love-title-v2.png', 'logos/spring-late-love-title-v2.png'],
      ...['save', 'load', 'system', 'sound', 'favorite', 'tips', 'menu-back', 'menu-next', 'menu-auto', 'menu-skip', 'menu-log', 'menu-close', 'menu-hold'].map(name => [`icons/${name}.png`, `icons/${name}.png`]),
    ];
    for (const [sourceName, targetName] of generatedUiAssets) {
      const target = path.join(uiAssetDirectory, ...targetName.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.resolve(__dirname, `../Title/asset/ui/${sourceName}`), target);
    }
    const config = JSON.parse(await fs.readFile(path.resolve(__dirname, '../Title/setting/game-screens.json'), 'utf8'));
    config.controlSkins = {
      ...(config.controlSkins || {}),
      nativeSmoke: {
        type: 'range', track: 'ui/choice-romance.png', fill: 'ui/speaker-plate-romance.png', thumb: 'ui/dialogue-panel-romance.png',
        trackHeight: 8, thumbWidth: 28, thumbHeight: 28,
      },
      nativeToggle: { type: 'checkbox', off: 'ui/choice-romance.png', on: 'ui/speaker-plate-romance.png' },
    };
    for (const skin of Object.values(config.controlSkins)) {
      for (const key of ['track', 'fill', 'thumb', 'thumbHover', 'off', 'on', 'offHover', 'onHover']) {
        if (!skin[key]) continue;
        const relative = skin[key].replace(/^asset[\\/]/, '');
        const target = path.join(project.assetsRoot, ...relative.split('/'));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.resolve(__dirname, '../Title/asset', ...relative.split('/')), target);
      }
    }
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
    await fs.writeFile(titleTemplatePath, titleMarkup.replace('</main>', '<input class="control-smoke-slider" type="range" min="0" max="1" step="0.01" data-setting="audio.bgm" data-skin="nativeSmoke" aria-label="BGM"><input class="control-smoke-toggle" type="checkbox" data-setting="audio.bgmMuted" data-skin="nativeToggle" aria-label="Mute BGM"><img id="package-art" src="asset/ui/screen-badge.png" alt="title art"></main>'), 'utf8');
    await fs.appendFile(titleCssPath, '\n#package-art{position:absolute;left:500px;top:20px;width:96px;height:54px;object-fit:contain;z-index:-1}\n.control-smoke-slider{position:absolute;left:820px;top:110px;width:280px;height:24px}.control-smoke-toggle{position:absolute;left:820px;top:150px;width:24px;height:24px}\n', 'utf8');
    const packagePath = path.join(project.buildRoot, 'main.nsp.json');
    const packaged = await pack(path.join(project.scenesRoot, 'main.tds'), packagePath, { projectRoot: project.projectRoot });
    assert.equal(packaged.native_ui.game_screens, 'ui/game-screens.json');
    const packagedScreens = JSON.parse(await fs.readFile(path.join(path.dirname(packagePath), 'asset', 'ui', 'game-screens.json'), 'utf8'));
    assert.deepEqual(packagedScreens.canvas, { width: 1440, height: 810 }, 'native package receives display dimensions resolved from the shared UI settings');
    assert.equal(packagedScreens.scaleMode, 'contain', 'native package preserves the reference-canvas scaling policy');
    assert.ok(packagedScreens.screens.title.uiTree?.length, 'HTML/CSS is compiled to the renderer-neutral layout tree');
    assert.equal(packagedScreens.controlDefaults['audio.voice'], 0.5, 'native package receives the validated shared control defaults');
    assert.equal(packagedScreens.controlDefaults['audio.voice.ayaka'], 1, 'native package receives character-specific voice defaults');
    assert.equal(packagedScreens.controlDefaults['audio.voice.ayaka.muted'], false, 'native package receives per-character mute defaults');
    assert.equal(packagedScreens.controlDefaults['ui.shortcut.F1'], 'system', 'function-key bindings are delivered as shared player settings');
    assert.equal(packagedScreens.controlDefaults['ui.shortcut.F12'], 'none', 'all twelve keys have an explicit safe default');
    assert.equal(packagedScreens.controlDefaults['ui.fontFamily'], 'default', 'font preference uses an explicit shared safe default');
    const settingsTree = packagedScreens.screens.system.uiTree;
    const settingsControlKeys = [];
    const settingsShortcutRows = [];
    const collectSettingsControls = nodes => { for (const node of nodes || []) { if (node.tag === 'input') settingsControlKeys.push(node.attrs['data-setting']); if ((node.attrs?.class || '').split(/\s+/).includes('shortcut-row')) settingsShortcutRows.push(node); collectSettingsControls(node.children); } };
    collectSettingsControls(settingsTree);
    assert.deepEqual(settingsControlKeys.sort(), ['ui.autoSpeed', 'ui.cursorHideDelay', 'ui.textSpeed'].sort(), 'continuous playback preferences are serialized as shared Native range controls');
    assert.equal(packagedScreens.screens.system.items.filter(item => item.action === 'setting-value').length, 13, 'binary settings and the three font choices compile into actionable Native UI items');
    assert.ok(packagedScreens.screens.system.items.some(item => item.action === 'reset-window-size'), 'the window-size reset is a real cross-runtime screen action');
    assert.equal(settingsShortcutRows.length, 12, 'the two-column shortcut panel is included in the Native screen tree');
    const shortcutButtons = [];
    const collectShortcutButtons = nodes => { for (const node of nodes || []) { if (node.attrs?.['data-action'] === 'shortcut-cycle') shortcutButtons.push(node); collectShortcutButtons(node.children); } };
    collectShortcutButtons(settingsTree);
    assert.equal(shortcutButtons.length, 12, 'each binding is an actionable shared UI control rather than a static label');
    const soundTree = packagedScreens.screens.sound.uiTree;
    const controlKeys = [];
    const collectControls = nodes => { for (const node of nodes || []) { if (node.tag === 'input') controlKeys.push(node.attrs['data-setting']); collectControls(node.children); } };
    collectControls(soundTree);
    assert.ok(controlKeys.includes('audio.bgm') && controlKeys.includes('audio.bgmMuted') && controlKeys.includes('ui.dialogOpacity'), 'the same declarative sliders and toggles reach the Native renderer');
    assert.ok(packagedScreens.screens.title.items.some(item => item.action === 'start'), 'compiled click targets survive native packaging');
    const historyNode = (() => { const visit = nodes => { for (const node of nodes || []) { if (node.attrs?.['data-role'] === 'dialogue-history') return node; const child = visit(node.children); if (child) return child; } return null; }; return visit(packagedScreens.screens.log.uiTree); })();
    assert.ok(historyNode, 'LOG uses the shared renderer-neutral dialogue-history role');
    assert.ok(packagedScreens.screens.pause.items.some(item => item.action === 'hold'), 'HOLD is compiled as a native-operable pause action');
    const pauseIconSources = [];
    const collectPauseIcons = nodes => { for (const node of nodes || []) { if (node.tag === 'img' && (node.attrs?.['class'] || '').split(/\s+/).includes('pause-icon')) pauseIconSources.push(node.attrs.src); collectPauseIcons(node.children); } };
    collectPauseIcons(packagedScreens.screens.pause.uiTree);
    assert.equal(pauseIconSources.length, 14, 'Native receives all fourteen image-based pause menu operation icons');
    for (const source of pauseIconSources) assert.ok((await fs.stat(path.join(path.dirname(packagePath), 'asset', source))).size > 1000, `Native package includes pause icon ${source}`);
    assert.ok(JSON.stringify(packagedScreens.screens.title.uiTree).includes('buttons/sakura-menu-plate.png'), 'the generated title button art is part of the shared Native screen tree');
    assert.ok(JSON.stringify(packagedScreens.screens.title.uiTree).includes('buttons/sakura-menu-plate-hover-v2.png'), 'the clearly illuminated selected-state artwork is compiled into the shared Native screen tree');
    assert.ok(JSON.stringify(packagedScreens.screens.title.uiTree).includes('ui/logos/spring-late-love-title-v2.png'), 'the generated Japanese title logo is part of the common Native title tree');
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'backgrounds', 'spring-ensemble-key-visual.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'buttons', 'sakura-menu-plate.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'buttons', 'sakura-menu-plate-hover-v2.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'logos', 'spring-late-love-title-v2.png'));
    for (const name of ['save', 'load', 'system', 'sound', 'favorite', 'tips']) await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'icons', `${name}.png`));
    assert.ok(JSON.stringify(packagedScreens.screens.title.uiTree).includes('ui/screen-badge.png'), 'asset-relative HTML images are retained in the shared tree');
    const card = packagedScreens.screens.save.uiTree[0].children.find(node => node.attrs?.['data-role'] === 'save-slots')?.children[0];
    assert.equal(card?.children.find(node => node.attrs?.['data-slot-field'] === 'number')?.attrs['data-slot-field'], 'number', 'Native package retains slot-card field bindings');
    assert.equal(card?.slotStateStyles?.corrupt?.['background-color'], '#f7ece7', 'Native receives the common corrupt-slot style table');
    assert.equal(card?.slotStateStyles?.incompatible?.['border-color'], '#aa956b', 'Native receives the common incompatible-slot style table');
    for (const state of ['empty', 'ready', 'corrupt', 'incompatible']) assert.equal(card?.slotStateStyles?.[state]?.opacity, '1', `Native keeps ${state} slot information cards fully opaque`);
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'screen-badge.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'dialogue-panel-romance.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'controls', 'audio', 'volume', 'thumb-hover.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'controls', 'audio', 'volume', 'mute-off-hover.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'choice-romance.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'speaker-plate-romance.png'));
    for (const name of ['choice-romance.png', 'speaker-plate-romance.png', 'dialogue-panel-romance.png']) await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', name));
    const findSkinnedControl = nodes => {
      for (const node of nodes || []) {
        if (node.attrs?.['data-skin'] === 'nativeSmoke') return node;
        const nested = findSkinnedControl(node.children);
        if (nested) return nested;
      }
      return null;
    };
    const titleSmokeControl = findSkinnedControl(packagedScreens.screens.title.uiTree);
    assert.equal(titleSmokeControl?.controlSkin?.type, 'range', 'Native screen tree includes its validated image skin');
    assert.equal(titleSmokeControl?.controlSkin?.thumbWidth, 28);
    const titleSmokeToggle = (() => {
      const find = nodes => { for (const node of nodes || []) { if (node.attrs?.['data-skin'] === 'nativeToggle') return node; const child = find(node.children); if (child) return child; } return null; };
      return find(packagedScreens.screens.title.uiTree);
    })();
    assert.equal(titleSmokeToggle?.controlSkin?.type, 'checkbox', 'Native screen tree includes the matching image checkbox skin');
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
    assert.deepEqual(JSON.parse(saveSmoke.stdout.trim()), { save: true, thumbnail: true, fullFrame: true, text: 'revised' });
    const captureDirectory = path.join(tempRoot, 'native-screen-captures');
    const renderSmoke = spawnSync(exe, [packagePath, '--screen-render-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NOVEL_SCREEN_CAPTURE_DIR: captureDirectory, NOVEL_SAVE_ROOT: path.join(tempRoot, 'native-render-saves'), SDL_AUDIODRIVER: 'dummy', SDL_VIDEODRIVER: 'dummy' },
    });
    assert.equal(renderSmoke.status, 0, renderSmoke.stderr || renderSmoke.error?.message || renderSmoke.stdout);
    const renderedScreens = JSON.parse(renderSmoke.stdout.trim());
    assert.ok(renderedScreens.count >= 5, 'Native captures every authored screen as rendered pixels');
    assert.ok(renderedScreens.captured.includes('title-hover'), 'Native moves the real SDL pointer over GAME START and renders its hover state');
    assert.ok(renderedScreens.captured.includes('pause'), 'Native captures the image-based game menu as rendered pixels');
    for (const screen of renderedScreens.captured) {
      const image = await fs.readFile(path.join(captureDirectory, `${screen}.png`));
      assert.ok(image.length > 2048 && image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), `Native ${screen} is a PNG screen capture`);
    }
    if (process.env.NOVEL_NATIVE_SCREEN_CAPTURE_DIR) {
      await fs.mkdir(process.env.NOVEL_NATIVE_SCREEN_CAPTURE_DIR, { recursive: true });
      for (const screen of renderedScreens.captured) await fs.copyFile(path.join(captureDirectory, `${screen}.png`), path.join(process.env.NOVEL_NATIVE_SCREEN_CAPTURE_DIR, `${screen}.png`));
    }
    assert.notDeepEqual(await fs.readFile(path.join(captureDirectory, 'title.png')), await fs.readFile(path.join(captureDirectory, 'title-hover.png')), 'Native hover rendering changes the captured title pixels');
    const quickSmoke = spawnSync(exe, [packagePath, '--screen-quick-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NOVEL_SAVE_ROOT: path.join(tempRoot, 'quick-saves'), SDL_AUDIODRIVER: 'dummy', SDL_VIDEODRIVER: 'dummy' },
    });
    assert.equal(quickSmoke.status, 0, quickSmoke.stderr || quickSmoke.error?.message || quickSmoke.stdout);
    assert.deepEqual(JSON.parse(quickSmoke.stdout.trim()), { saved: true, restored: true }, 'Native quick save/load uses its own persistent file, independently of numbered slots');
    await fs.mkdir(path.join(project.buildRoot, 'saves'), { recursive: true });
    await fs.writeFile(path.join(project.buildRoot, 'saves', 'slot-1.json'), JSON.stringify({ version: 1, file: 'main.tds', scene: 'main', line: 1, variables: {}, speaker: '語り手', text: '保存した場面', savedAt: Date.now() }));
    await fs.writeFile(path.join(project.buildRoot, 'saves', 'slot-2.json'), JSON.stringify({ version: 1, scene: 'broken', line: 1, variables: {} }));
    await fs.writeFile(path.join(project.buildRoot, 'saves', 'slot-3.json'), JSON.stringify({ version: 1, saveId: 'another-work', file: 'main.tds', scene: 'main', line: 1, variables: {} }));
    await fs.writeFile(path.join(project.buildRoot, 'saves', 'slot-13.json'), JSON.stringify({ version: 1, file: 'main.tds', scene: 'main', line: 1, variables: {}, speaker: '13番目', text: '2ページ目' }));
    await fs.copyFile(path.join(path.dirname(packagePath), 'asset', 'ui', 'screen-badge.png'), path.join(project.buildRoot, 'saves', 'thumb-slot-1.png'));
    const slotSmoke = spawnSync(exe, [packagePath, '--screen-slot-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(slotSmoke.status, 0, slotSmoke.stderr || slotSmoke.error?.message);
    const slotResult = JSON.parse(slotSmoke.stdout.trim());
    assert.equal(slotResult.continueAvailable, true);
    for (const role of ['save-slots', 'load-slots']) {
      assert.equal(slotResult[role].secondState, 'corrupt', `${role} preserves the damaged-slot state for rendering`);
      assert.equal(slotResult[role].thirdState, 'incompatible', `${role} preserves the foreign-project state for rendering`);
      assert.equal(slotResult[role].secondStateStyle, true, `${role} resolves the corrupt slot style in the shared tree`);
      assert.equal(slotResult[role].thirdStateStyle, true, `${role} resolves the incompatible slot style in the shared tree`);
      delete slotResult[role].secondState;
      delete slotResult[role].secondStateStyle;
      delete slotResult[role].thirdStateStyle;
    }
    assert.deepEqual(slotResult['save-slots'], { count: 12, firstStatus: 'saved', secondStatus: 'empty', thirdStatus: 'empty', firstStatusText: '記録あり', secondStatusText: '破損', thirdStatusText: '非対応', thirdState: 'incompatible' });
    assert.deepEqual(slotResult['load-slots'], { count: 12, firstStatus: 'saved', secondStatus: 'empty', thirdStatus: 'empty', firstStatusText: '記録あり', secondStatusText: '破損', thirdStatusText: '非対応', thirdState: 'incompatible' });
    assert.equal(slotResult.thumbnailDisplayed, true, 'Native save/load templates render each slot thumbnail from the user save directory');
    assert.deepEqual(slotResult.secondPage, { save: 12, load: 12 }, 'Native page buttons bind the second page to save slots 13-24');
    assert.deepEqual(slotResult.operations, { locked: true, unlocked: true, copied: true, moved: true, deleteArmed: true, deleted: true }, 'Native slot management persists locks, previews, copies, moves, and confirms deletion');
    const controlSmoke = spawnSync(exe, [packagePath, '--screen-control-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(controlSmoke.status, 0, controlSmoke.stderr || controlSmoke.error?.message);
    const controlResult = JSON.parse(controlSmoke.stdout.trim());
    assert.equal(controlResult.uiSettings['ui.shortcut.F1'], 'save', 'Native stores the remapped key after interacting with the actual screen control');
    assert.equal(controlResult.uiSettings['ui.shortcut.F12'], 'history', 'Native persists the remapped F12 action');
    const preferences = JSON.parse(await fs.readFile(path.join(project.buildRoot, 'saves', 'ui-settings.json'), 'utf8'));
    assert.ok(Math.abs(preferences['audio.bgm'] - 0.75) < 0.03, `Native range interaction should update the stored value: ${controlSmoke.stdout}`);
    assert.equal(preferences['audio.bgmMuted'], true, 'Native checkbox interaction should persist the toggle');
    assert.ok(Math.abs(preferences['audio.voice.ayaka'] - 0.6) < 0.02, 'Native per-character voice level is updated and persisted by the sound screen');
    assert.equal(preferences['audio.voice.ayaka.muted'], false, 'Native per-character mute preference is restored after the active-track test');
    assert.ok(preferences['audio.master'] < 0.15, 'Native pause-menu vertical volume click maps its bottom to minimum');
    assert.equal(preferences['ui.textSpeed'], 0.25, 'Native persists the common dialogue-speed preference');
    const titleBuildRoot = path.resolve(__dirname, '../Title/.novel/build');
    const titlePackage = path.join(titleBuildRoot, 'main.nsp.json');
    const titleScreens = JSON.parse(await fs.readFile(path.join(titleBuildRoot, 'asset/ui/game-screens.json'), 'utf8'));
    const findClass = (nodes, className) => {
      for (const node of nodes || []) {
        if ((node.attrs?.class || '').split(/\s+/).includes(className)) return node;
        const child = findClass(node.children, className);
        if (child) return child;
      }
      return null;
    };
    const voiceCard = findClass(titleScreens.screens.sound.uiTree, 'sound-voice-card');
    const voiceSlider = findClass(voiceCard?.children, 'voice-character-volume');
    const voiceNameplate = findClass(voiceCard?.children, 'sound-character');
    assert.ok(voiceCard && voiceSlider, 'the actual Title project packages portrait cards and an editable per-character slider');
    assert.ok(voiceNameplate && voiceNameplate.rect.y + voiceNameplate.rect.height <= voiceSlider.rect.y
      && voiceNameplate.style['background-color'] === 'rgba(17,25,43,0.70)', 'Native uses the same legible character-name strip above each portrait volume control');
    assert.ok(voiceSlider.rect.x >= voiceCard.rect.x && voiceSlider.rect.x + voiceSlider.rect.width <= voiceCard.rect.x + voiceCard.rect.width
      && voiceSlider.rect.y >= voiceCard.rect.y && voiceSlider.rect.y + voiceSlider.rect.height <= voiceCard.rect.y + voiceCard.rect.height,
    'the actual packaged SDL layout keeps each character volume control inside its portrait card');
    await fs.access(path.join(titleBuildRoot, 'asset/ui/portraits/ayaka-volume.png'));
    const titleCaptureRoot = path.join(tempRoot, 'actual-title-render');
    const titleRenderSmoke = spawnSync(exe, [titlePackage, '--screen-render-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NOVEL_SCREEN_CAPTURE_DIR: titleCaptureRoot, NOVEL_SAVE_ROOT: path.join(tempRoot, 'actual-title-render-saves'), SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(titleRenderSmoke.status, 0, titleRenderSmoke.stderr || titleRenderSmoke.error?.message || titleRenderSmoke.stdout);
    const titleRendered = JSON.parse(titleRenderSmoke.stdout.trim());
    assert.equal(titleRendered.count, 11, 'the actual Title package renders every authored screen in Native');
    for (const screen of ['title', 'system', 'sound', 'load', 'save', 'pause']) {
      const image = await fs.readFile(path.join(titleCaptureRoot, `${screen}.png`));
      assert.ok(image.length > 4096, `actual Title ${screen} screen produced a rendered Native image`);
    }
    const titleInteractionSaveRoot = path.join(tempRoot, 'actual-title-control-saves');
    const titleControlSmoke = spawnSync(exe, [titlePackage, '--screen-control-smoke'], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, NOVEL_SAVE_ROOT: titleInteractionSaveRoot, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(titleControlSmoke.status, 0, titleControlSmoke.stderr || titleControlSmoke.error?.message || titleControlSmoke.stdout);
    const titleControlSettings = JSON.parse(titleControlSmoke.stdout.trim()).uiSettings;
    assert.ok(Math.abs(titleControlSettings['audio.bgm'] - 0.75) < 0.03 && titleControlSettings['audio.bgmMuted'] === true,
      'Native SDL input changes the actual Title project global sound controls');
    assert.ok(Math.abs(titleControlSettings['audio.voice.ayaka'] - 0.4) < 0.03 && titleControlSettings['audio.voice.ayaka.muted'] === true,
      'Native SDL input changes the actual Title project character-specific sound controls');
    const titlePreferences = JSON.parse(await fs.readFile(path.join(titleInteractionSaveRoot, 'ui-settings.json'), 'utf8'));
    assert.equal(titlePreferences['audio.voice.ayaka.muted'], true, 'the actual Title Native player persists character mute changes');
    const restartSmoke = spawnSync(exe, [packagePath, '--screen-shortcut-restart-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(restartSmoke.status, 0, restartSmoke.stderr || restartSmoke.error?.message);
    assert.deepEqual(JSON.parse(restartSmoke.stdout.trim()), { F1: 'save', F12: 'history' }, 'Native reloads customized shortcut bindings in a fresh player process');
    console.log('PASS Native screen fixture and actual Title project: screen captures, mouse-driven audio controls, persistence and shortcuts');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
