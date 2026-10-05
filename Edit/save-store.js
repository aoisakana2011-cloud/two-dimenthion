'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NovelSaveStore = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const DATABASE = 'novel-script-user-data';
  const STORES = ['snapshots', 'metadata', 'thumbnails', 'preferences'];
  const requestResult = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || Error('IndexedDB request failed'));
  });
  const transactionDone = transaction => new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || Error('Save transaction was aborted'));
    transaction.onerror = () => reject(transaction.error || Error('Save transaction failed'));
  });
  async function openDatabase(indexedDb) {
    const request = indexedDb.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const store of STORES) if (!database.objectStoreNames.contains(store)) database.createObjectStore(store);
    };
    return requestResult(request);
  }
  async function open({ namespace, legacyPrefix, indexedDb = globalThis.indexedDB, storage = globalThis.localStorage }) {
    if (typeof namespace !== 'string' || !namespace || namespace.length > 512) throw Error('Invalid save namespace');
    let database = null;
    if (indexedDb) {
      try { database = await openDatabase(indexedDb); }
      catch (error) { if (!storage) throw error; }
    }
    const prefix = `${namespace}:`;
    const slotKey = index => {
      if (!Number.isInteger(index) || index < 0 || index >= 120) throw Error('Save slot must be between 0 and 119');
      return `${prefix}slot:${index}`;
    };
    const preferenceKey = name => `${prefix}pref:${name}`;
    const get = async (store, key) => database
      ? requestResult(database.transaction(store, 'readonly').objectStore(store).get(key))
      : storage.getItem(key);
    const writeSlot = async (index, encoded, metadata = {}, thumbnail = null) => {
      if (typeof encoded !== 'string' || encoded.length > 8_000_000) throw Error('Invalid save snapshot size');
      const key = slotKey(index);
      if (!database) { storage.setItem(key, encoded); return; }
      const tx = database.transaction(['snapshots', 'metadata', 'thumbnails'], 'readwrite');
      const done = transactionDone(tx);
      tx.objectStore('snapshots').put(encoded, key);
      tx.objectStore('metadata').put(metadata, key);
      if (thumbnail instanceof Blob) tx.objectStore('thumbnails').put(thumbnail, key);
      else tx.objectStore('thumbnails').delete(key);
      await done;
    };
    const readSlot = async index => (await get('snapshots', slotKey(index))) || null;
    const readThumbnail = async index => database ? (await get('thumbnails', slotKey(index))) || null : null;
    const readMetadata = async index => database ? (await get('metadata', slotKey(index))) || null : null;
    const deleteSlot = async index => {
      const key = slotKey(index);
      if (!database) { storage.removeItem(key); return; }
      const tx = database.transaction(['snapshots', 'metadata', 'thumbnails'], 'readwrite');
      const done = transactionDone(tx);
      for (const store of ['snapshots', 'metadata', 'thumbnails']) tx.objectStore(store).delete(key);
      await done;
    };
    const transferSlot = async (source, destination, { move = false } = {}) => {
      if (source === destination) throw Error('Source and destination save slots must differ');
      const sourceKey = slotKey(source), destinationKey = slotKey(destination);
      if (!database) {
        const encoded = storage.getItem(sourceKey);
        if (typeof encoded !== 'string' || storage.getItem(destinationKey) !== null) return false;
        storage.setItem(destinationKey, encoded);
        if (move) storage.removeItem(sourceKey);
        return true;
      }
      // Copy/move is a single database transaction: other readers can never
      // observe a half-moved slot, and a competing write cannot claim dest.
      const tx = database.transaction(['snapshots', 'metadata', 'thumbnails'], 'readwrite');
      const done = transactionDone(tx);
      const snapshots = tx.objectStore('snapshots'), metadataStore = tx.objectStore('metadata'), thumbnails = tx.objectStore('thumbnails');
      const values = {};
      let pending = 4, transferred = false;
      const finishRead = () => {
        if (--pending !== 0) return;
        if (typeof values.encoded !== 'string' || values.destination != null) return;
        snapshots.put(values.encoded, destinationKey);
        if (values.metadata != null) metadataStore.put(values.metadata, destinationKey);
        else metadataStore.delete(destinationKey);
        if (values.thumbnail instanceof Blob) thumbnails.put(values.thumbnail, destinationKey);
        else thumbnails.delete(destinationKey);
        if (move) { snapshots.delete(sourceKey); metadataStore.delete(sourceKey); thumbnails.delete(sourceKey); }
        transferred = true;
      };
      const read = (store, key, name) => {
        const request = store.get(key);
        request.onsuccess = () => { values[name] = request.result; finishRead(); };
        request.onerror = () => { try { tx.abort(); } catch {} };
      };
      read(snapshots, sourceKey, 'encoded'); read(snapshots, destinationKey, 'destination');
      read(metadataStore, sourceKey, 'metadata'); read(thumbnails, sourceKey, 'thumbnail');
      await done;
      return transferred;
    };
    const readPreference = async name => {
      const value = await get('preferences', preferenceKey(name));
      if (database) return value ?? null;
      try { return value ? JSON.parse(value) : null; } catch { return null; }
    };
    const writePreference = async (name, value) => {
      if (!database) { storage.setItem(preferenceKey(name), JSON.stringify(value)); return; }
      const tx = database.transaction('preferences', 'readwrite');
      const done = transactionDone(tx);
      tx.objectStore('preferences').put(value, preferenceKey(name));
      await done;
    };
    if (legacyPrefix && storage) {
      const candidates = [];
      for (let cursor = 0; cursor < storage.length; cursor++) {
        const oldKey = storage.key(cursor);
        if (!oldKey?.startsWith(`${legacyPrefix}:slot:`)) continue;
        const index = Number(oldKey.slice(`${legacyPrefix}:slot:`.length));
        if (Number.isInteger(index) && index >= 0 && index < 120) candidates.push(index);
      }
      for (const index of candidates) {
        if (await readSlot(index)) continue;
        const encoded = storage.getItem(`${legacyPrefix}:slot:${index}`);
        if (!encoded) continue;
        try {
          const value = JSON.parse(encoded);
          if (value?.version !== 1 || !value.file || !value.scene || !Number.isInteger(value.line) || !value.variables || typeof value.variables !== 'object') continue;
          await writeSlot(index, encoded, { scene: value.scene, speaker: value.speaker || '', text: value.text || '', savedAt: value.savedAt || 0 });
        } catch { /* Preserve damaged legacy data for manual recovery. */ }
      }
      const oldPreferences = storage.getItem(`${legacyPrefix}:ui-settings`);
      if (oldPreferences && !await readPreference('ui-settings')) {
        try { await writePreference('ui-settings', JSON.parse(oldPreferences)); } catch { /* Keep the old preference untouched. */ }
      }
    }
    return { backend: database ? 'indexeddb' : 'localStorage', readSlot, writeSlot, readThumbnail, readMetadata, deleteSlot, transferSlot, readPreference, writePreference, close: () => database?.close() };
  }
  return { open };
});
