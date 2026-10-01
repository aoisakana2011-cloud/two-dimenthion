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
  storage.setItem('old:ui-settings', JSON.stringify({ 'audio.bgm': 0.4 }));
  const indexedDb = { open() { throw Error('unavailable'); } };
  const store = await open({ namespace: 'story:game', legacyPrefix: 'old', indexedDb, storage });
  assert.equal(store.backend, 'localStorage');
  assert.equal(await store.readSlot(0), old);
  assert.equal(await store.readSlot(1), null);
  assert.deepEqual(await store.readPreference('ui-settings'), { 'audio.bgm': 0.4 });
  await store.writeSlot(0, 'new');
  const reopened = await open({ namespace: 'story:game', legacyPrefix: 'old', indexedDb, storage });
  assert.equal(await reopened.readSlot(0), 'new');
  await reopened.deleteSlot(0);
  assert.equal(await reopened.readSlot(0), null);
  await assert.rejects(reopened.readSlot(100), /0 and 99/);
});
