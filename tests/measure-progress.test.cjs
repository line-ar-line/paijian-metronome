const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../score/score-model.js');
const { compile, measureProgress } = require('../score/document.js');

test('an unfinished measure reports beats while full-score validation remains strict', () => {
  assert.deepEqual(measureProgress('', [4, 4]), { beats: 0, capacity: 4 });
  assert.deepEqual(measureProgress('1 2:0.5', [4, 4]), { beats: 1.5, capacity: 4 });
  assert.deepEqual(measureProgress('1:3 2:3', [4, 4]), { beats: 6, capacity: 4 });
  assert.throws(() => compile({ format: 'paijian-score', version: 1, title: '', bpm: 80, meter: [4, 4], instrument: '17C', voices: [{ name: '旋律', notation: '1 2:0.5' }], repeats: [], credits: [] }), /有 1.5 拍，需要 4 拍/);
});

test('chords and glissandi count once and compound meter keeps quarter-note units', () => {
  assert.deepEqual(measureProgress("~(1,3,5):1.5 (2,4,6):0.5 0", [6, 8]), { beats: 3, capacity: 3 });
  assert.deepEqual(measureProgress("1':3~", [3, 4]), { beats: 3, capacity: 3 });
  for (const notation of ['1:', '8', '1:0.3', '(1,1)', '~(1)']) assert.throws(() => measureProgress(notation, [4, 4]));
});
