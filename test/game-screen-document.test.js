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

test('document compiler rejects executable markup, event handlers and external resources', () => {
  assert.throws(() => compileScreenDocument('<main><script>alert(1)</script></main>', ''), /未対応の要素/);
  assert.throws(() => compileScreenDocument('<main><button onclick="alert(1)">x</button></main>', ''), /未対応の属性/);
  assert.throws(() => compileScreenDocument('<main></main>', 'main{background-image:url(https://example.invalid/x.png)}'), /外部参照/);
  assert.throws(() => compileScreenDocument('<main><img src="../secret.png"></main>', ''), /asset内/);
});

test('modern decoration stays editable while unsafe CSS and loose attributes are rejected', () => {
  const markup = '<main><section class="panel"><button data-action="start">Start</button></section></main>';
  const css = '.panel{background:linear-gradient(90deg,#111111,#333333);border-radius:12px;box-shadow:0 4px 18px #00000088}.panel > button:hover{transform:scale(1.05);transition:transform 150ms}';
  assert.doesNotThrow(() => compileScreenDocument(markup, css));
  assert.throws(() => compileScreenDocument(markup, '.panel{mask-image:url(https://example.invalid/a.png)}'), /未対応|外部参照/);
  assert.throws(() => compileScreenDocument('<main><button id=bad data-action="start">X</button></main>', ''), /引用符/);
  const result = compileGameScreens({ version: 1, initial: 'title', stylesheet: 'ui.css', screens: { title: { template: 'title.html' } } }, { 'title.html': markup, 'ui.css': css });
  assert.match(result.screens.title.webDocument.markup, /data-action="start"/);
});

test('shared screen controls require a declared safe key, matching type and bounded values', () => {
  const settings = require('../Edit/screen-document').parseControlSettings('audio.master=0.8\naudio.bgmMuted=false\nui.dialogOpacity=0.65');
  assert.deepEqual(settings, { 'audio.master': 0.8, 'audio.bgmMuted': false, 'ui.dialogOpacity': 0.65 });
  assert.throws(() => require('../Edit/screen-document').parseControlSettings('anything.secret=1'), /不正/);
  assert.throws(() => require('../Edit/screen-document').parseControlSettings('audio.master=1.1'), /audio\.master/);
  assert.throws(() => require('../Edit/screen-document').parseControlSettings('audio.master=0.5\naudio.master=0.6'), /重複/);
  assert.throws(() => compileScreenDocument('<main><input type="range" data-setting="runtime.command" /></main>', '', { width: 800, height: 450 }, [], { 'audio.master': 1 }), /対応する/);
  assert.throws(() => compileScreenDocument('<main><input type="checkbox" data-setting="audio.master" /></main>', '', { width: 800, height: 450 }, [], { 'audio.master': 1 }), /Muted/);
  const result = compileScreenDocument('<main><input class="volume" type="range" min="0" max="1" step="0.01" data-setting="audio.master" aria-label="Master" /></main>', '.volume{position:absolute;left:10px;top:20px;width:200px;height:24px;accent-color:#94b5e8}', { width: 800, height: 450 }, [], { 'audio.master': 1 });
  assert.equal(result.tree[0].children[0].attrs['data-setting'], 'audio.master');
  assert.equal(result.tree[0].children[0].rect.width, 200);
});

test('screen actions must target defined screens and only one HTML root is accepted', () => {
  assert.throws(() => compileScreenDocument('<main><button data-action="open-screen" data-target="missing">Go</button></main>', '', { width: 800, height: 450 }, ['title']), /遷移先がありません/);
  assert.throws(() => compileScreenDocument('<main></main><footer></footer>', ''), /1つのルート要素/);
  const noStart = { version: 1, initial: 'title', screens: { title: { template: 'screens/title.html', background: '' } } };
  assert.throws(() => compileGameScreens(noStart, { 'screens/title.html': '<main><p>Missing start</p></main>' }, { width: 800, height: 450 }), /ゲーム開始/);
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
  assert.equal(compiled.screens.load.items.find(item => item.action === 'back').label, '戻る');
});
