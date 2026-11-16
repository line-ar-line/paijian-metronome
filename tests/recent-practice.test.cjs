const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRecentPractice } = require('../score/recent-practice.js');
test('recent practice retains the latest twenty unique IDs and merges another tab on write', () => {
  let raw = null;
  const storage = { getItem: () => raw, setItem: (_, value) => { raw = value; } };
  const a = createRecentPractice(() => storage), b = createRecentPractice(() => storage);
  for (let i = 0; i < 25; i++) assert.equal(a.record(`mutopia-${i}`), true);
  assert.equal(b.record('xu'), true); assert.equal(a.record('mutopia-24'), true);
  const ids = b.getState().ids;
  assert.equal(ids.length, 20); assert.deepEqual(ids.slice(0, 2), ['mutopia-24', 'xu']);
  assert.equal(new Set(ids).size, 20);
});
test('unreadable history is preserved and unavailable storage cannot break playback callers', () => {
  let raw = '{damaged';
  const history = createRecentPractice(() => ({ getItem: () => raw, setItem: (_, value) => { raw = value; } }));
  assert.equal(history.record('xu'), false); assert.equal(raw, '{damaged');
  assert.ok(history.getState().error);
  assert.equal(createRecentPractice(() => { throw Error('disabled'); }).record('xu'), false);
  assert.equal(history.record('../secret'), false);
});
