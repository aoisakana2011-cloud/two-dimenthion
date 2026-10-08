'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultGameScreens, validateGameScreens, withSaveLoadScreens } = require('../Edit/game-screens');

test('legacy front-end settings gain save and load slot screens without mutating the source', () => {
  const source = {
    version: 1,
    initial: 'title',
    screens: {
      title: { items: [{ id: 'start', type: 'button', label: 'Start', action: 'start', x: 0, y: 0, width: 100, height: 40 }] },
      pause: { items: [{ id: 'resume', type: 'button', label: 'Resume', action: 'resume', x: 10, y: 10, width: 100, height: 40 }] },
    },
  };
  const upgraded = withSaveLoadScreens(validateGameScreens(source));
  assert.equal(source.screens.save, undefined, 'compatibility normalization does not mutate the persisted config');
  assert.equal(Object.values(upgraded.screens).find(screen => screen.role === 'save-slots')?.slotLayout.count, 8);
  assert.equal(Object.values(upgraded.screens).find(screen => screen.role === 'load-slots')?.slotLayout.count, 8);
  assert.deepEqual(upgraded.screens.pause.items.map(item => item.action), ['resume', 'save', 'load']);
  assert.deepEqual(Object.values(defaultGameScreens().screens).filter(screen => screen.role).map(screen => screen.role), ['save-slots', 'load-slots']);
});

test('front-end validation constrains title scene paths, slot geometry, and button display modes', () => {
  const config = defaultGameScreens();
  config.titleScene = { file: '../outside.tds', scene: 'title' };
  assert.throws(() => validateGameScreens(config));
  config.titleScene = { file: 'title.tds', scene: 'title' };
  const startItem = config.screens.title.items[0];
  config.screens.title.items = [];
  assert.throws(() => validateGameScreens(config), /ゲーム開始/);
  config.screens.title.items = [startItem];
  config.screens.save.slotLayout.count = 101;
  assert.throws(() => validateGameScreens(config));
  config.screens.save.slotLayout.count = 8;
  config.screens.title.items[0].display = 'animation';
  assert.throws(() => validateGameScreens(config));
});

test('HTML template screens may omit legacy JSON buttons while JSON-only screens still require them', () => {
  const templated = {
    version: 1,
    initial: 'title',
    screens: { title: { template: 'screens/title.html', background: '' } },
  };
  assert.deepEqual(validateGameScreens(templated).screens.title.items, []);
  assert.throws(() => validateGameScreens({
    version: 1,
    initial: 'title',
    screens: { title: { background: '', items: [] } },
  }), /ゲーム開始/);
});
