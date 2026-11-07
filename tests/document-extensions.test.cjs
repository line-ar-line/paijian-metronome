const test = require('node:test');
const assert = require('node:assert/strict');
const { compile, normalize } = require('../score/document.js');

const document = (notation, extra = {}) => ({ format: 'paijian-score', version: 1, title: '连音与间奏', bpm: 80, meter: [3, 4], instrument: '17C', voices: [{ name: '旋律', notation }], ...extra });

test('a tie across a bar sustains one attack and keeps both printed noteheads connected', () => {
  const result = compile(document("1':3~ | 1':2 5"));
  assert.deepEqual(result.playbackNotes.map(n => [n.midi, n.start, n.duration]), [[72, 0, 5], [67, 5, 1]]);
  const first = result.score.bars[0].tokens[0], second = result.score.bars[1].tokens[0];
  assert.equal(first.tieOut, true);
  assert.equal(second.tieIn, true);
  assert.equal(first.sourceId, second.sourceId);
  assert.equal(result.totalBeats, 6);
  const articulated = compile(document("1':3 | 1':2 5"));
  assert.equal(articulated.playbackNotes.length, 3, 'unmarked repeated pitches are still separate attacks');
});

test('chord ties preserve every pitch through several bars without retriggering', () => {
  const result = compile(document('(1,3,5):3~ | (5,3,1):3~ | (1,3,5):2 0'));
  assert.deepEqual(result.playbackNotes.map(n => [n.midi, n.duration]).sort((a, b) => a[0] - b[0]), [[60, 8], [64, 8], [67, 8]]);
  assert.equal(result.totalBeats, 9);
  assert.ok(result.score.bars[1].tokens[0].tieIn && result.score.bars[1].tokens[0].tieOut);
});

test('invalid ties fail rather than joining different notes, rests, or repeat jumps', () => {
  for (const notation of ['1:3~ | 2:3', '1:3~ | 0:3', '0:3~ | 0:3', '1:3~', '~(1,3):3~ | (1,3):3', '(1,3):3~ | (1,5):3']) {
    assert.throws(() => compile(document(notation)), /延音|休止/);
  }
  assert.throws(() => compile(document('1:3~ | 1:3', { repeats: [{ startBar: 2, endBar: 2, times: 2 }] })), /反复/);
  assert.throws(() => compile(document('1:3~ | 1:3', { repeats: [{ startBar: 1, endBar: 1, times: 2 }] })), /反复/);
});

const section = {
  title: '手写间奏', afterBar: 1, description: '只知道音高，不猜时值。',
  voices: [
    { name: '旋律', notation: "5' 3' (1'',5',3') . | 4' 3'" },
    { name: '伴奏', notation: "1 5 1' 5 | (2',7) ." },
  ],
};

test('unmetered notes survive editable round trips and stay out of timed playback', () => {
  const doc = document('1:3 | 2:3', { unmeteredSections: [section] });
  const result = compile(doc);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(result.document))), result.document);
  assert.deepEqual(result.document.unmeteredSections[0], section);
  assert.equal(result.score.stats.unmeteredNotes, 13);
  assert.equal(result.score.unmeteredSections[0].groups.length, 2);
  assert.equal(result.score.unmeteredSections[0].groups[0].columns[3].voices[0].length, 0, 'a blank is not an invented rest');
  assert.deepEqual(result.playbackNotes.map(n => [n.midi, n.start, n.duration]), [[60, 0, 3], [62, 3, 3]]);
  assert.equal(result.totalBeats, 6, 'unknown timing must not contribute fictitious beats');
  assert.match(result.warnings.join(' '), /试听仅含正文/);
});

test('unmetered sections reject missing alignment, timing syntax, and impossible insertion points', () => {
  for (const voices of [
    [{ name: '旋律', notation: '1 2' }, { name: '伴奏', notation: '3' }],
    [{ name: '旋律', notation: '1 | 2' }, { name: '伴奏', notation: '3 4' }],
    [{ name: '旋律', notation: '1:2' }],
    [{ name: '旋律', notation: '~(1,3)' }],
    [{ name: '旋律', notation: '(1,1)' }],
  ]) assert.throws(() => compile(document('1:3', { unmeteredSections: [{ ...section, voices }] })));
  assert.throws(() => compile(document('1:3', { unmeteredSections: [{ ...section, afterBar: 2 }] })), /小节范围/);
});
