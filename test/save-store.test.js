'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../Edit/save-store');

function memoryStorage() {
  const entries = new Map();
  return {
    get length() { return entries.size; },
    key(index) { return [...entries.keys()][index] ?? null; },
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, String(value)); },
    removeItem(key) { entries.delete(key); },
  };
}

test('save store falls back safely and imports valid legacy slots without overwriting newer data', async () => {
  const storage = memoryStorage();
  const old = JSON.stringify({ version: 1, file: 'main.tds', scene: 'main', line: 1, variables: {}, text: 'legacy' });
  storage.setItem('old:slot:0', old);
  storage.setItem('old:slot:1', '{broken');
  const invalidLegacy = [
    { version: 1, file: 7, scene: 'main', line: 1, variables: {} },
    { version: 1, file: 'main.tds', scene: 'not-a-scene!', line: 1, variables: {} },
    { version: 1, file: 'main.tds', scene: 'main', line: 0, variables: {} },
    { version: 1, file: 'main.tds', scene: 'main', line: 1, variables: [] },
    { version: 1, file: 'main.tds', scene: 'main', line: 1, variables: {}, saveId: 12 },
    { version: 1, file: 'main.tds', scene: 'main', line: 1, variables: {}, locals: [null] },
    { version: 1, file: 'main.tds', scene: 'main', line: 1, variables: {}, locals: [{}], readonlyLocals: [] },
    { version: 1, file: 'main.tds', scene: 'main', line: 1, variables: {}, locals: [{}], readonlyLocals: [[1]] },
  ];
  invalidLegacy.forEach((value, index) => storage.setItem(`old:slot:${index + 2}`, JSON.stringify(value)));
  storage.setItem('old:ui-settings', JSON.stringify({ 'audio.bgm': 0.4 }));
  const indexedDb = { open() { throw Error('unavailable'); } };
  const store = await open({ namespace: 'story:game', legacyPrefix: 'old', indexedDb, storage });
  assert.equal(store.backend, 'localStorage');
  assert.equal(await store.readSlot(0), old);
  assert.equal(await store.readSlot(1), null);
  for (let index = 0; index < invalidLegacy.length; index++) {
    assert.equal(await store.readSlot(index + 2), null, `invalid legacy record ${index} is not imported`);
    assert.equal(storage.getItem(`old:slot:${index + 2}`), JSON.stringify(invalidLegacy[index]), `invalid legacy record ${index} is preserved`);
  }
  assert.deepEqual(await store.readPreference('ui-settings'), { 'audio.bgm': 0.4 });
  await store.writeSlot(0, 'new');
  const reopened = await open({ namespace: 'story:game', legacyPrefix: 'old', indexedDb, storage });
  assert.equal(await reopened.readSlot(0), 'new');
  await reopened.writeSlot(1, '');
  assert.equal(await reopened.readSlot(1), '', 'an empty persisted payload remains distinguishable from an empty slot so the Player can report it as corrupt');
  await reopened.deleteSlot(0);
  assert.equal(await reopened.readSlot(0), null);
  await reopened.writeSlot(119, 'page-ten');
  assert.equal(await reopened.readSlot(119), 'page-ten');
  await assert.rejects(reopened.readSlot(120), /セーブ枠は0〜119の範囲/);
});

test('slot copy and move preserve snapshots and never overwrite an occupied destination', async () => {
  const storage = memoryStorage();
  const store = await open({ namespace: 'transfer-test', indexedDb: null, storage });
  const original = JSON.stringify({ version: 1, scene: 'intro', line: 12, text: 'checkpoint' });
  await store.writeSlot(2, original);
  await store.writeSlot(4, 'occupied');
  assert.equal(await store.transferSlot(2, 4), false);
  assert.equal(await store.readSlot(4), 'occupied');
  assert.equal(await store.transferSlot(2, 3), true);
  assert.equal(await store.readSlot(2), original);
  assert.equal(await store.readSlot(3), original);
  assert.equal(await store.transferSlot(3, 5, { move: true }), true);
  assert.equal(await store.readSlot(3), null);
  assert.equal(await store.readSlot(5), original);
  await assert.rejects(store.transferSlot(5, 5), /別のセーブ枠/);
  await assert.rejects(store.transferSlot(0, 120), /セーブ枠は0〜119の範囲/);
});

test('legacy migration preserves an existing empty payload as damaged current data', async () => {
  const storage = memoryStorage();
  const currentKey = 'current:slot:0';
  const legacy = JSON.stringify({ version: 1, file: 'main.tds', scene: 'main', line: 1, variables: {}, text: 'legacy' });
  storage.setItem(currentKey, '');
  storage.setItem('old:slot:0', legacy);
  const store = await open({ namespace: 'current', legacyPrefix: 'old', indexedDb: null, storage });
  assert.equal(await store.readSlot(0), '', 'migration must not replace present bytes, even when malformed');
});

test('legacy preferences never replace an existing falsey value in the current namespace', async () => {
  const storage = memoryStorage();
  storage.setItem('old:ui-settings', JSON.stringify({ 'audio.bgm': 0.4 }));
  storage.setItem('current:pref:ui-settings', JSON.stringify(false));
  const store = await open({ namespace: 'current', legacyPrefix: 'old', indexedDb: null, storage });
  assert.equal(await store.readPreference('ui-settings'), false);
  assert.equal(storage.getItem('old:ui-settings'), JSON.stringify({ 'audio.bgm': 0.4 }), 'legacy source remains untouched');
});
