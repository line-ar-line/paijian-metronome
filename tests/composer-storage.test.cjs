const test = require('node:test');
const assert = require('node:assert/strict');
const { DRAFT_KEY, blankDocument, starterDocument, createDraftStore, safeFilename, restoreDocument } = require('../score/composer.js');

function memoryStorage(initial = null) {
  const data = new Map(initial === null ? [] : [[DRAFT_KEY, initial]]);
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('unfinished notation is saved verbatim and recovered without requiring a compilable score', () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage);
  const document = starterDocument();
  document.voices[0].notation = "~(1,3,5):2 |\n  1' not finished (";
  document.title = '还在写的一首曲子';
  store.create(document);
  assert.deepEqual(createDraftStore(storage).current().document, document);
});

test('corrupt saved data is not overwritten while a new in-memory draft remains recoverable', () => {
  const original = '{this was damaged';
  const storage = memoryStorage(original);
  const store = createDraftStore(storage);
  assert.ok(store.error);
  const document = starterDocument();
  assert.throws(() => store.create(document));
  assert.equal(storage.getItem(DRAFT_KEY), original);
  assert.deepEqual(store.current().document, document);
});

test('quota errors preserve the latest edits in memory and the last saved version on disk', () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage);
  store.create(starterDocument());
  const saved = storage.getItem(DRAFT_KEY);
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const document = store.current().document;
  document.voices[0].notation = '1:4 | 2:4';
  assert.throws(() => store.update(document), /QuotaExceededError/);
  assert.equal(storage.getItem(DRAFT_KEY), saved);
  assert.deepEqual(store.current().document, document);
});

test('two open tabs cannot silently overwrite each other; the losing tab retains its own exportable draft', () => {
  const storage = memoryStorage();
  const first = createDraftStore(storage);
  first.create(starterDocument());
  const second = createDraftStore(storage);
  const firstEdit = first.current().document;
  firstEdit.title = '第一个标签页的修改';
  first.update(firstEdit);
  const secondEdit = second.current().document;
  secondEdit.title = '另一个标签页也在写';
  assert.throws(() => second.update(secondEdit), /另一个标签页/);
  assert.equal(createDraftStore(storage).current().document.title, firstEdit.title);
  assert.equal(second.current().document.title, secondEdit.title);
});

test('disabled browser storage still retains a draft for explicit JSON export', () => {
  const store = createDraftStore({ getItem() { throw new Error('SecurityError'); } });
  assert.throws(() => store.create(blankDocument()), /SecurityError/);
  assert.equal(store.current().document.format, 'paijian-score');
});

test('download names cannot escape a ZIP directory or split an emoji surrogate pair', () => {
  assert.equal(safeFilename('../CON:<x>?'), '..-CON--x--');
  assert.equal(safeFilename('CON'), '曲谱-CON');
  assert.equal(safeFilename('  '), '曲谱-未命名');
  const name = safeFilename('a'.repeat(79) + '🎵🎹');
  assert.equal(name, 'a'.repeat(79) + '🎵');
  assert.equal(Buffer.from(name).toString(), name);
});

test('JSON restoration retains unfinished metadata while refusing malformed document structures', () => {
  const document = starterDocument();
  document.bpm = 0;
  document.repeats = [{ startBar: 0, endBar: 0, times: 1 }];
  document.credits = Array.from({ length: 13 }, (_, i) => `尚待整理的署名 ${i}`);
  assert.deepEqual(restoreDocument(JSON.parse(JSON.stringify(document))), document);
  assert.throws(() => restoreDocument({ ...document, voices: [{ name: 'bad', notation: {} }] }), /声部/);
  assert.throws(() => restoreDocument({ ...document, bpm: '0' }), /速度/);
  assert.throws(() => restoreDocument({ ...document, repeats: [{ startBar: 1, endBar: 2, times: 'bad' }] }), /反复/);
});
