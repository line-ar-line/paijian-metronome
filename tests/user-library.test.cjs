const assert = require('node:assert/strict');
const test = require('node:test');
const { createUserLibrary, STORAGE_KEY } = require('../score/user-library.js');

function memoryStorage(initial = null) {
  let raw = initial;
  return { getItem: () => raw, setItem: (key, value) => { assert.equal(key, STORAGE_KEY); raw = value; }, removeItem: () => { raw = null; } };
}
function events() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, event) { for (const listener of listeners.get(type) || []) listener(event); },
  };
}

test('favorites persist stable source IDs, deduplicate, and expose immutable snapshots', () => {
  const storage = memoryStorage();
  const store = createUserLibrary({ storage });
  assert.deepEqual(store.getState(), { ids: [], count: 0, error: '' });
  assert.deepEqual(store.toggle('mutopia-528'), { ok: true, favorite: true, error: '' });
  assert.equal(store.set('heixiu-rhapsody', true).ok, true);
  store.set('mutopia-528', true);
  store.getState().ids.push('not-a-real-favorite');
  assert.equal(store.getState().count, 2);
  const reloaded = createUserLibrary({ storage });
  assert.equal(reloaded.has('mutopia-528'), true);
  assert.equal(reloaded.has('heixiu-rhapsody'), true);
  assert.equal(reloaded.has('not-a-real-favorite'), false);
  assert.equal(reloaded.toggle('mutopia-528').favorite, false);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), { version: 1, ids: ['heixiu-rhapsody'] });
});

test('a stale tab merges the latest saved IDs when adding or removing one favorite', () => {
  const storage = memoryStorage();
  const first = createUserLibrary({ storage });
  const second = createUserLibrary({ storage });
  first.set('mutopia-528', true);
  second.set('heixiu-rhapsody', true);
  assert.deepEqual(new Set(second.getState().ids), new Set(['mutopia-528', 'heixiu-rhapsody']));
  first.set('mutopia-528', false);
  assert.deepEqual(first.getState().ids, ['heixiu-rhapsody']);
});

test('storage events update other tabs, ignore unrelated storage, and handle clear', () => {
  const storage = memoryStorage();
  const eventTarget = events();
  const store = createUserLibrary({ storage, eventTarget });
  const snapshots = [];
  const unsubscribe = store.subscribe(snapshot => snapshots.push(snapshot));
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ids: ['mutopia-528'] }));
  eventTarget.dispatch('storage', { key: 'other-setting', storageArea: storage });
  eventTarget.dispatch('storage', { key: STORAGE_KEY, storageArea: memoryStorage() });
  assert.equal(store.has('mutopia-528'), false);
  eventTarget.dispatch('storage', { key: STORAGE_KEY, storageArea: storage });
  assert.equal(store.has('mutopia-528'), true);
  assert.equal(snapshots.length, 1);
  unsubscribe();
  storage.removeItem(STORAGE_KEY);
  eventTarget.dispatch('storage', { key: null, storageArea: storage });
  assert.equal(store.getState().count, 0);
  assert.equal(snapshots.length, 1);
  store.destroy();
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ids: ['mutopia-528'] }));
  eventTarget.dispatch('pageshow', {});
  assert.equal(store.getState().count, 0);
});

test('a failed write retains saved favorites and reports failure rather than temporary success', () => {
  const storage = memoryStorage(JSON.stringify({ version: 1, ids: ['mutopia-528'] }));
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const store = createUserLibrary({ storage });
  assert.equal(store.toggle('heixiu-rhapsody').ok, false);
  assert.equal(store.has('heixiu-rhapsody'), false);
  assert.equal(store.has('mutopia-528'), true);
  assert.match(store.getState().error, /未能保存/);
  assert.deepEqual(store.toggle('mutopia-528'), { ok: false, favorite: true, error: store.getState().error });
});

test('blocked or corrupted storage is handled without deleting the original data', () => {
  const blocked = createUserLibrary({ getStorage: () => { throw new Error('SecurityError'); } });
  assert.match(blocked.getState().error, /无法读取/);
  assert.equal(blocked.toggle('mutopia-528').ok, false);
  for (const raw of ['{broken json', JSON.stringify({ version: 2, ids: [] }), JSON.stringify({ version: 1, ids: ['../secret'] })]) {
    const storage = memoryStorage(raw);
    const store = createUserLibrary({ storage });
    assert.match(store.getState().error, /原记录未被覆盖/);
    assert.equal(store.toggle('mutopia-528').ok, false);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
  }
});

test('invalid favorite operations and broken subscribers do not corrupt saved data', () => {
  const storage = memoryStorage();
  const store = createUserLibrary({ storage });
  assert.equal(store.set('../not-an-id', true).ok, false);
  assert.equal(store.set('mutopia-528', 'true').ok, false);
  assert.equal(storage.getItem(STORAGE_KEY), null);
  let notified = false;
  store.subscribe(() => { throw new Error('subscriber failure'); });
  store.subscribe(() => { notified = true; });
  assert.equal(store.set('example:twinkle', true).ok, true);
  assert.equal(notified, true);
  assert.equal(store.has('example:twinkle'), true);
});
