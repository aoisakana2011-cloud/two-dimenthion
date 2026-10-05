'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compileScreenDocument, compileGameScreens } = require('../Edit/screen-document');
const { validateGameScreens, withSaveLoadScreens } = require('../Edit/game-screens');

test('screen HTML lays out flex menus into shared absolute geometry', () => {
  const { tree } = compileScreenDocument(
    '<main><nav class="menu"><button id="start" data-action="start">Start</button><button id="load" data-action="load">Load</button></nav></main>',
    'main{width:100%;height:100%}.menu{position:absolute;left:100px;top:40px;width:200px;display:flex;flex-direction:column;gap:10px}button{height:40px}',
    { width: 800, height: 450 },
  );
  const menu = tree[0].children[0];
  assert.deepEqual(menu.rect, { x: 100, y: 40, width: 200, height: 90 });
  assert.deepEqual(menu.children.map(node => node.rect), [
    { x: 100, y: 40, width: 200, height: 40 },
    { x: 100, y: 90, width: 200, height: 40 },
  ]);
});

test('slot roles expand with grid placement and compile to actionable items', () => {
  const source = '<main><section class="slots" data-role="save-slots" data-count="4"></section><button id="back" data-action="back">Back</button></main>';
  const stylesheet = '.slots{position:absolute;left:10px;top:20px;width:500px;height:200px;display:grid;grid-template-columns:repeat(2,1fr);grid-auto-rows:80px;gap:10px}';
  const result = compileGameScreens({ version: 1, initial: 'title', titleScene: { file: 'main.tds', scene: 'title' }, stylesheet: 'screens/ui.css', screens: { title: { title: '', background: '', items: [{ id: 'start', type: 'button', label: 'Start', action: 'start', x: 0, y: 0, width: 100, height: 40 }], template: 'screens/title.html' } } }, {
    'screens/ui.css': stylesheet,
    'screens/title.html': source,
  }, { width: 800, height: 450 });
  const screen = result.screens.title;
  assert.equal(screen.role, 'save-slots');
  assert.deepEqual(screen.slotLayout, { x: 10, y: 20, width: 500, height: 200, rowHeight: 80, gap: 0, count: 4 });
  assert.equal(screen.items.length, 5);
  assert.equal(screen.items[0].slotIndex, 0);
  assert.equal(screen.items[4].action, 'back');
  assert.deepEqual(screen.items.slice(0,4).map(item => [item.x, item.y]), [[10,20],[265,20],[10,110],[265,110]]);
});

test('one slot card template expands into independent, bindable cards', () => {
  const markup = '<main><div class="slots" data-role="load-slots" data-count="3"><button class="card"><span class="number" data-slot-field="number"></span><span class="excerpt" data-slot-field="text"></span></button></div></main>';
  const css = '.slots{position:absolute;left:20px;top:30px;width:600px;height:120px;display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.card{position:relative;width:100%;height:100px}.number{position:absolute;left:8px;top:8px;width:30px;height:20px}.excerpt{position:absolute;left:45px;top:8px;width:120px;height:60px}';
  const { tree } = compileScreenDocument(markup, css, { width: 800, height: 450 });
  const cards = tree[0].children[0].children;
  assert.deepEqual(cards.map(card => card.attrs['data-slot-index']), ['0', '1', '2']);
  assert.deepEqual(cards.map(card => card.rect.x), [20, 223.33333333333334, 426.6666666666667]);
  assert.equal(cards[1].children[1].attrs['data-slot-field'], 'text');
  assert.equal(cards[1].children[1].rect.x, cards[1].rect.x + 45);
  assert.notStrictEqual(cards[0].children[0], cards[1].children[0]);
  assert.throws(() => compileScreenDocument('<main><span data-slot-field="text"></span></main>', ''), /テンプレート内/);
  assert.throws(() => compileScreenDocument('<main><div data-role="save-slots"><button><button data-action="quit">X</button></button></div></main>', ''), /別のrole|1つだけ/);
  assert.throws(() => compileScreenDocument('<main><div data-role="save-slots"><button><span data-slot-field="secret"></span></button></div></main>', ''), /未対応のセーブ枠フィールド/);
});

test('save-slot state selectors compile into the renderer-neutral card style table', () => {
  const { tree } = compileScreenDocument(
    '<main><div class="slots" data-role="load-slots" data-count="2"><button class="save-slot"><span data-slot-field="status"></span></button></div></main>',
    '.slots{position:absolute;left:0;top:0;width:400px;height:100px;display:grid;grid-template-columns:repeat(2,1fr)}.save-slot[data-state="empty"],.save-slot[data-state="ready"],.save-slot[data-state="corrupt"],.save-slot[data-state="incompatible"]{opacity:1}.save-slot[data-state="corrupt"]{background-color:#f7ece7;border-color:#bf806d}.save-slot[data-state="incompatible"]{background-color:#f2efe7;border-color:#aa956b}',
    { width: 800, height: 450 },
  );
  const cards = tree[0].children[0].children;
  assert.equal(cards[0].slotStateStyles.corrupt['background-color'], '#f7ece7');
  assert.equal(cards[0].slotStateStyles.incompatible['border-color'], '#aa956b');
  for (const state of ['empty', 'ready', 'corrupt', 'incompatible']) assert.equal(cards[0].slotStateStyles[state].opacity, '1');
  assert.deepEqual(cards[1].slotStateStyles, cards[0].slotStateStyles);
  assert.throws(() => compileScreenDocument('<main><button class="not-a-slot">x</button></main>', '.not-a-slot[data-state="corrupt"]{color:#ffffff}'), /save-slot template root/);
  assert.throws(() => compileScreenDocument('<main><div data-role="load-slots" data-count="1"><button class="save-slot"><span class="status"></span></button></div></main>', '.status[data-state="corrupt"]{color:#ffffff}'), /save-slot template root/);
});

test('document compiler rejects executable markup, event handlers and external resources', () => {
  assert.throws(() => compileScreenDocument('<main><script>alert(1)</script></main>', ''), /未対応の要素/);
  assert.throws(() => compileScreenDocument('<main><button onclick="alert(1)">x</button></main>', ''), /未対応の属性/);
  assert.throws(() => compileScreenDocument('<main></main>', 'main{background-image:url(https://example.invalid/x.png)}'), /外部参照/);
  assert.throws(() => compileScreenDocument('<main><img src="../secret.png"></main>', ''), /asset内/);
});

test('shared screen CSS rejects unsupported renderer features without silently dropping them', () => {
  const markup = '<main><section class="panel"><button data-action="start">Start</button></section></main>';
  const css = '.panel{background-color:#111111;color:#ffffff;border:1px solid #333333}.panel:hover{background-color:#222222}';
  assert.doesNotThrow(() => compileScreenDocument(markup, css));
  assert.throws(() => compileScreenDocument(markup, '.panel{border-radius:12px}'), /共通画面では未対応のCSS/);
  assert.throws(() => compileScreenDocument(markup, '.panel > button:hover{color:#ffffff}'), /未対応のCSSセレクター/);
  assert.throws(() => compileScreenDocument(markup, '.panel{mask-image:url(https://example.invalid/a.png)}'), /未対応|外部参照/);
  assert.throws(() => compileScreenDocument('<main><button id=bad data-action="start">X</button></main>', ''), /引用符/);
  const result = compileGameScreens({ version: 1, initial: 'title', stylesheet: 'ui.css', screens: { title: { template: 'title.html' } } }, { 'title.html': markup, 'ui.css': css });
  assert.equal(Object.hasOwn(result.screens.title, 'webDocument'), false);
  const containsStart = nodes => nodes.some(node => node.attrs?.['data-action'] === 'start' || containsStart(node.children || []));
  assert.equal(containsStart(result.screens.title.uiTree), true);
});

test('focused controls receive shared state styles in the compiled UI tree', () => {
  const { tree } = compileScreenDocument(
    '<main><button class="menu-item" data-action="start">Start</button></main>',
    '.menu-item:hover{background-color:#112233}.menu-item:focus-visible{border:2px solid #aabbcc}',
    { width: 800, height: 450 },
  );
  const button = tree[0].children[0];
  assert.equal(button.hoverStyle['background-color'], '#112233');
  assert.equal(button.focusStyle.border, '2px solid #aabbcc');
});

test('shared screen controls require a declared safe key, matching type and bounded values', () => {
  const settings = require('../Edit/screen-document').parseControlSettings('audio.master=0.8\naudio.bgmMuted=false\nui.dialogOpacity=0.65');
  assert.deepEqual(settings, { 'audio.master': 0.8, 'audio.bgmMuted': false, 'ui.dialogOpacity': 0.65 });
  assert.throws(() => require('../Edit/screen-document').parseControlSettings('anything.secret=1'), /不正/);
  assert.throws(() => require('../Edit/screen-document').parseControlSettings('audio.master=1.1'), /audio\.master/);
  assert.throws(() => require('../Edit/screen-document').parseControlSettings('audio.master=0.5\naudio.master=0.6'), /重複/);
  assert.throws(() => compileScreenDocument('<main><input type="range" data-setting="runtime.command" /></main>', '', { width: 800, height: 450 }, [], { 'audio.master': 1 }), /対応する/);
  assert.throws(() => compileScreenDocument('<main><input type="checkbox" data-setting="audio.master" /></main>', '', { width: 800, height: 450 }, [], { 'audio.master': 1 }), /boolean/);
  const characterControls = require('../Edit/screen-document').parseControlSettings('audio.voice.ayaka=0.8\naudio.voice.ayaka.muted=false');
  assert.deepEqual(characterControls, { 'audio.voice.ayaka': 0.8, 'audio.voice.ayaka.muted': false });
  assert.throws(() => require('../Edit/screen-document').parseControlSettings('audio.voice.bad-id=1'), /不正|未対応/);
  const characterInputs = compileScreenDocument('<main><input type="range" data-setting="audio.voice.ayaka"/><input type="checkbox" data-setting="audio.voice.ayaka.muted"/></main>', '', undefined, [], characterControls).tree[0].children;
  assert.deepEqual(characterInputs.map(node => node.attrs['data-setting']), ['audio.voice.ayaka', 'audio.voice.ayaka.muted']);
  const result = compileScreenDocument('<main><input class="volume" type="range" min="0" max="1" step="0.01" data-setting="audio.master" aria-label="Master" /></main>', '.volume{position:absolute;left:10px;top:20px;width:200px;height:24px;accent-color:#94b5e8}', { width: 800, height: 450 }, [], { 'audio.master': 1 });
  assert.equal(result.tree[0].children[0].attrs['data-setting'], 'audio.master');
  assert.equal(result.tree[0].children[0].rect.width, 200);
});

test('function-key bindings are validated and compile as shared clickable controls', () => {
  const { parseControlSettings, shortcutActions } = require('../Edit/screen-document');
  const defaults = parseControlSettings('ui.shortcut.F1=system\nui.shortcut.F12=none');
  assert.deepEqual(defaults, { 'ui.shortcut.F1': 'system', 'ui.shortcut.F12': 'none' });
  assert.deepEqual(shortcutActions, ['none','system','save','load','replay-voice','auto','clear-text','fullscreen','skip','quick-save','history','quick-load']);
  assert.throws(() => parseControlSettings('ui.shortcut.F13=save'), /不正|未対応/);
  assert.throws(() => parseControlSettings('ui.shortcut.F1=run-arbitrary-code'), /invalid shortcut action/);
  assert.throws(() => compileScreenDocument('<main><button data-action="shortcut-cycle" data-target="F13">x</button></main>'), /shortcut-cycle/);
  const { tree } = compileScreenDocument('<main><button class="bind" data-action="shortcut-cycle" data-target="F1">System</button></main>', '.bind{position:absolute;left:10px;top:10px;width:120px;height:28px}', { width: 800, height: 450 });
  assert.equal(tree[0].children[0].attrs['data-action'], 'shortcut-cycle');
  assert.equal(tree[0].children[0].attrs['data-target'], 'F1');
});

test('screen controls bind validated image skins without changing their setting semantics', () => {
  const skins = {
    romanceVolume: { type: 'range', track: 'asset/ui/volume/track.png', fill: 'ui/volume/fill.png', thumb: 'ui/volume/thumb.png', thumbHover: 'ui/volume/thumb-hover.png', trackHeight: 8, thumbWidth: 28, thumbHeight: 30 },
    romanceMute: { type: 'checkbox', off: 'ui/volume/mute-off.png', on: 'ui/volume/mute-on.png' },
  };
  const controls = { 'audio.bgm': 0.75, 'audio.bgmMuted': false };
  const { tree } = compileScreenDocument(
    '<main><input type="range" min="0" max="1" step="0.01" data-setting="audio.bgm" data-skin="romanceVolume" aria-label="BGM"><input type="checkbox" data-setting="audio.bgmMuted" data-skin="romanceMute" aria-label="Mute"></main>',
    '', { width: 800, height: 450 }, [], controls, skins,
  );
  const [range, checkbox] = tree[0].children;
  assert.equal(range.controlSkin.type, 'range');
  assert.equal(range.controlSkin.track, 'ui/volume/track.png');
  assert.equal(checkbox.controlSkin.type, 'checkbox');
  assert.equal(range.attrs['data-setting'], 'audio.bgm');
  assert.throws(() => compileScreenDocument('<main><input type="range" data-setting="audio.bgm" data-skin="missing"></main>', '', undefined, [], controls, skins), /スキンがありません/);
  assert.throws(() => compileScreenDocument('<main><input type="checkbox" data-setting="audio.bgmMuted" data-skin="romanceVolume"></main>', '', undefined, [], controls, skins), /input typeが一致/);
  assert.throws(() => validateGameScreens({ version: 1, initial: 'title', screens: { title: { template: 'screens/title.html' } }, controlSkins: { unsafe: { type: 'range', track: '../escape.png', fill: 'ui/fill.png', thumb: 'ui/thumb.png' } } }), /相対パス/);
});

test('vertical range skins preserve orientation for both renderers and reject unknown axes', () => {
  const skins = { vertical: { type: 'range', orientation: 'vertical', track: 'ui/track.png', fill: 'ui/fill.png', thumb: 'ui/thumb.png' } };
  const { tree } = compileScreenDocument(
    '<main><input type="range" data-setting="audio.master" data-skin="vertical" /></main>',
    '', undefined, [], { 'audio.master': 0.5 }, skins,
  );
  assert.equal(tree[0].children[0].controlSkin.orientation, 'vertical');
  assert.throws(() => compileScreenDocument('<main></main>', '', undefined, [], {}, { invalid: { ...skins.vertical, orientation: 'diagonal' } }), /horizontalまたはvertical/);
});

test('boolean setting-value buttons are limited to declared safe settings and compile to equivalent values', () => {
  const config = { version: 1, initial: 'system', titleScene: { file: 'main.tds', scene: 'title' }, screens: { system: { template: 'system.html' } } };
  const { screens } = compileGameScreens(config, {
    'system.html': '<main><button data-action="setting-value" data-target="ui.effects" data-value="false">なし</button></main>',
  });
  assert.deepEqual(screens.system.items.map(({ action, target, value }) => ({ action, target, value })), [
    { action: 'setting-value', target: 'ui.effects', value: false },
  ]);
  assert.throws(() => compileGameScreens(config, {
    'system.html': '<main><button data-action="setting-value" data-target="runtime.secret" data-value="true">bad</button></main>',
  }), /設定値/);
  assert.throws(() => compileGameScreens(config, {
    'system.html': '<main><button data-action="setting-value" data-target="ui.effects" data-value="perhaps">bad</button></main>',
  }), /設定値/);
});

test('font-family choices are a safe persisted enum and window reset is a recognized action', () => {
  const config = { version: 1, initial: 'system', titleScene: { file: 'main.tds', scene: 'title' }, controlSettings: 'ui-controls.txt', screens: { system: { template: 'system.html' } } };
  const { screens, controlDefaults } = compileGameScreens(config, {
    'ui-controls.txt': 'ui.fontFamily=default',
    'system.html': '<main><button data-action="setting-value" data-target="ui.fontFamily" data-value="mincho">明朝</button><button data-action="reset-window-size">戻す</button></main>',
  });
  assert.equal(controlDefaults['ui.fontFamily'], 'default');
  assert.deepEqual(screens.system.items.map(({ action, target, value }) => ({ action, target, value })), [
    { action: 'setting-value', target: 'ui.fontFamily', value: 'mincho' },
    { action: 'reset-window-size', target: undefined, value: undefined },
  ]);
  assert.throws(() => compileGameScreens(config, { 'ui-controls.txt': 'ui.fontFamily=Comic Sans', 'system.html': '<main></main>' }), /許可された選択肢/);
});

test('screen actions must target defined screens and only one HTML root is accepted', () => {
  assert.throws(() => compileScreenDocument('<main><button data-action="open-screen" data-target="missing">Go</button></main>', '', { width: 800, height: 450 }, ['title']), /遷移先がありません/);
  assert.throws(() => compileScreenDocument('<main></main><footer></footer>', ''), /1つのルート要素/);
  const noStart = { version: 1, initial: 'title', screens: { title: { template: 'screens/title.html', background: '' } } };
  assert.throws(() => compileGameScreens(noStart, { 'screens/title.html': '<main><p>Missing start</p></main>' }, { width: 800, height: 450 }), /ゲーム開始/);
});

test('reference canvas scales without distortion and centers letterboxed layouts', () => {
  const transform = require('../Edit/screen-document').canvasTransform;
  assert.deepEqual(transform(1600, 900, { width: 1280, height: 720 }), { scaleX: 1.25, scaleY: 1.25, offsetX: 0, offsetY: 0 });
  assert.deepEqual(transform(1600, 1000, { width: 1280, height: 720 }), { scaleX: 1.25, scaleY: 1.25, offsetX: 0, offsetY: 50 });
  assert.deepEqual(transform(1000, 1600, { width: 1280, height: 720 }), { scaleX: 0.78125, scaleY: 0.78125, offsetX: 0, offsetY: 518.75 });
  assert.deepEqual(transform(1600, 1000, { width: 1280, height: 720 }, 'stretch'), { scaleX: 1.25, scaleY: 1.3888888888888888, offsetX: 0, offsetY: 0 });
  assert.throws(() => transform(0, 900, { width: 1280, height: 720 }), /正の有限値/);
  assert.throws(() => transform(1600, 900, { width: 1280, height: 720 }, 'unknown'), /未対応/);
  const config = require('../Edit/game-screens').defaultGameScreens();
  assert.equal(validateGameScreens({ ...config, scaleMode: 'cover' }).scaleMode, 'cover');
  assert.throws(() => validateGameScreens({ ...config, scaleMode: 'distort' }), /scaleMode/);
});

test('viewport CSS units resolve against the authored reference canvas, not their parent as pixels', () => {
  const { tree } = compileScreenDocument(
    '<main><section class="viewport-box"></section></main>',
    'main{width:100%;height:100%}.viewport-box{position:absolute;left:10vw;top:10vh;width:50vw;height:25vh}',
    { width: 1280, height: 720 },
  );
  assert.deepEqual(tree[0].children[0].rect, { x: 128, y: 72, width: 640, height: 180 });
});

test('the sample project screen templates compile with all navigation targets and slot geometry', () => {
  const root = path.resolve(__dirname, '..', 'Title', 'setting');
  const source = JSON.parse(fs.readFileSync(path.join(root, 'game-screens.json'), 'utf8'));
  const names = new Set([source.stylesheet, source.controlSettings, ...Object.values(source.screens).map(screen => screen.template)].filter(Boolean));
  const documents = Object.fromEntries([...names].map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
  assert.equal(Object.hasOwn(source.screens.title, 'items'), false, 'HTML-backed screen source does not duplicate legacy button definitions');
  const compiled = compileGameScreens(withSaveLoadScreens(validateGameScreens(source)), documents, { width: 1280, height: 720 });
  assert.equal(compiled.screens.title.uiTree.length, 1);
  assert.deepEqual(compiled.screens.title.items.map(item => item.action), ['continue', 'start', 'load', 'open-screen', 'open-screen', 'quit']);
  assert.equal(compiled.screens.save.items.filter(item => item.slotIndex !== undefined).length, 12);
  assert.equal(compiled.screens.load.items.find(item => item.action === 'back').label, 'ゲームに戻る');
  assert.equal(compiled.screens.system.uiTree[0].children[0].attrs.class, 'screen-dimmer');
  const heading = (() => { const find = nodes => { for (const node of nodes || []) { if (node.tag === 'h1' && node.attrs.class === 'screen-title') return node; const nested = find(node.children); if (nested) return nested; } return null; }; return find(compiled.screens.system.uiTree); })();
  assert.equal(heading?.style.margin, '0', 'the shared screen tree neutralizes Browser heading defaults to match Native layout');
  assert.equal(compiled.screens.sound.items.filter(item => item.action === 'open-screen').length >= 3, true);
});
