'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { defaultGameScreens, validateGameScreens } = require('../Edit/game-screens');

test('default game screens define a usable title start and pause resume action', () => {
  const screens = validateGameScreens(defaultGameScreens());
  assert.equal(screens.initial, 'title');
  assert.ok(screens.screens.title.items.some(item => item.action === 'start'));
  assert.ok(screens.screens.pause.items.some(item => item.action === 'resume'));
});

test('game screen validation rejects absent start actions and unresolved screen links', () => {
  const noStart = defaultGameScreens();
  noStart.screens.title.items = [];
  assert.throws(() => validateGameScreens(noStart), /開始画面/);

  const badLink = defaultGameScreens();
  badLink.screens.title.items.push({ id: 'load', type: 'button', label: 'Load', action: 'open-screen', target: 'missing', x: 10, y: 10, width: 200, height: 40 });
  assert.throws(() => validateGameScreens(badLink), /遷移先画面/);
});

test('game screen validation rejects traversal paths and invalid geometry', () => {
  const traversal = defaultGameScreens();
  traversal.screens.title.background = '../outside.png';
  assert.throws(() => validateGameScreens(traversal), /作品フォルダー外/);

  const invalidSize = defaultGameScreens();
  invalidSize.screens.title.items[0].width = 0;
  assert.throws(() => validateGameScreens(invalidSize), /width/);
});

test('Title prototype provides reachable title, pause menu, about, and guide screens', () => {
  const file = path.join(__dirname, '..', 'Title', 'asset', 'ui', 'game-screens.json');
  const config = validateGameScreens(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(config.initial, 'title');
  assert.ok(config.screens.title.items.some(item => item.action === 'start'));
  assert.ok(config.screens.pause.items.some(item => item.action === 'resume'));
  for (const screen of Object.values(config.screens)) {
    for (const item of screen.items) {
      if (item.action === 'open-screen') assert.ok(config.screens[item.target], `${screen.title} links to missing ${item.target}`);
    }
  }
  assert.equal(config.screens.title.background, 'bg/museum-night.png');
  assert.match(config.screens.title.description, /美術館/);
  assert.match(config.screens.pause.description, /一時停止/);
});

