const { test } = require('node:test');
const assert = require('node:assert/strict');
const { insert, locate } = require('../score/notation-tools.js');
test('toolbar insertion respects notation tokens and replaces selections without damaging chords', () => {
  const text = "1 ~(1, 3',5):2 | 0";
  const token = locate(text, 0, 1);
  assert.equal(token.text, "~(1, 3',5):2");
  const after = insert(text, token.start + 2, token.start + 2, '2:0.5');
  assert.equal(after.value, "1 ~(1, 3',5):2 2:0.5 | 0");
  assert.equal(insert(text, token.start, token.end, '(2,4):2').value, '1 (2,4):2 | 0');
  assert.equal(locate(text, 1, 0).text, '0');
  assert.equal(locate(text, 2, 0), undefined);
});
