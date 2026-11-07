const test = require('node:test');
const assert = require('node:assert/strict');
const { pitchInfo, buildScore, suggestTranspose, LIMITS } = require('../score/score-model.js');

const n = (midi, start = 0, duration = 1, velocity = 0.8) => ({ midi, start, duration, velocity });

test('maps MIDI pitches to C-based numerals and octave dots', () => {
  assert.deepEqual([60, 62, 64, 65, 67, 69, 71].map(midi => pitchInfo(midi).degree), ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(pitchInfo(60).octave, 0);
  assert.equal(pitchInfo(72).octave, 1);
  assert.equal(pitchInfo(84).octave, 2);
  assert.equal(pitchInfo(59, '21C').octave, -1);
  assert.equal(pitchInfo(88).degree, '3');
});

test('preserves accidentals and distinguishes range limits without folding', () => {
  assert.deepEqual([pitchInfo(61).degree, pitchInfo(61).accidental, pitchInfo(61).playable], ['1', '#', false]);
  assert.equal(pitchInfo(53, '21C').playable, true);
  assert.equal(pitchInfo(52, '21C').playable, false);
  assert.equal(pitchInfo(59).playable, false);
  assert.equal(pitchInfo(88).playable, true);
  assert.equal(pitchInfo(89).playable, false);
  const score = buildScore([n(48), n(61, 1), n(89, 2)]);
  assert.deepEqual(score.notes.map(note => note.midi), [48, 61, 89]);
  assert.equal(score.stats.unplayable, 3);
});

test('inserts rests and preserves every measure duration, including final padding', () => {
  const score = buildScore([n(60, 1, 1), n(64, 5, 0.5)]);
  assert.equal(score.totalBeats, 8);
  assert.equal(score.bars.length, 2);
  assert.equal(score.bars[0].tokens[0].degree, '0');
  assert.equal(score.bars[1].tokens.at(-1).midi, null);
  for (const bar of score.bars) {
    assert.equal(bar.tokens.reduce((sum, token) => sum + token.duration, 0), 4);
    assert.equal(bar.tokens[0].start, bar.start);
    for (let i = 1; i < bar.tokens.length; i++) assert.equal(bar.tokens[i].start, bar.tokens[i - 1].start + bar.tokens[i - 1].duration);
  }
});

test('splits sustained notes across bar lines with correct ties and one sound note', () => {
  const score = buildScore([n(67, 3, 3.25)]);
  const tokens = score.bars.flatMap(bar => bar.tokens).filter(token => token.midi !== null);
  assert.deepEqual(tokens.map(token => token.duration), [1, 2, 0.25]);
  assert.deepEqual(tokens.map(token => [token.tieIn, token.tieOut]), [[false, true], [true, true], [true, false]]);
  assert.equal(new Set(tokens.map(token => token.sourceId)).size, 1);
  assert.equal(score.notes.length, 1);
  assert.equal(score.notes[0].duration, 3.25);
});

test('handles six-eight as three quarter-note beats per measure', () => {
  const score = buildScore([n(60, 0, 4)], { meter: [6, 8] });
  assert.equal(score.barBeats, 3);
  assert.equal(score.totalBeats, 6);
  assert.equal(score.bars[0].tokens[0].duration, 3);
  assert.equal(score.bars[1].tokens[0].duration, 1);
  assert.equal(score.bars[1].tokens[0].tieIn, true);
});

test('selects the highest simultaneous note and discloses clipped overlaps', () => {
  const score = buildScore([n(60, 0, 4), n(67, 0, 3), n(64, 1, 1)]);
  assert.deepEqual(score.notes.map(note => [note.midi, note.start, note.duration]), [[67, 0, 1], [64, 1, 1]]);
  assert.equal(score.stats.removedPolyphony, 1);
  assert.equal(score.stats.clippedOverlaps, 1);
  assert.equal(score.warnings.length, 2);
});

test('quantizes endpoints, preserves short notes, and reports rhythmic changes', () => {
  const score = buildScore([n(60, 0.12, 0.32), n(62, 0.51, 0.05)]);
  assert.deepEqual(score.notes.map(note => [note.start, note.duration]), [[0, 0.5], [0.5, 0.25]]);
  assert.equal(score.stats.quantized, 2);
  assert.match(score.warnings[0], /十六分/);
  assert.equal(buildScore([n(60, 0, 0.75)]).stats.quantized, 0);
});

test('transposes globally and recommends an in-range diatonic pitch shift', () => {
  const source = [n(61), n(63, 1), n(65, 2), n(66, 3), n(68, 4), n(70, 5), n(72, 6)];
  assert.deepEqual(suggestTranspose(source), { transpose: -1, playable: 7, total: 7 });
  const score = buildScore(source, { transpose: -1 });
  assert.equal(score.stats.unplayable, 0);
  assert.deepEqual(score.notes.map(note => note.degree), ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(suggestTranspose([n(60), n(64, 1), n(67, 2)]).transpose, 0);
});

test('does not mutate input notes or caller settings', () => {
  const source = [Object.freeze(n(67, 1, 3)), Object.freeze(n(60, 0, 2))];
  Object.freeze(source);
  const options = Object.freeze({ meter: Object.freeze([3, 4]), transpose: 1 });
  const score = buildScore(source, options);
  assert.equal(source[0].midi, 67);
  assert.deepEqual(options.meter, [3, 4]);
  assert.equal(score.notes[0].midi, 61);
});

test('handles empty input without synthesizing a spurious measure', () => {
  assert.equal(buildScore([]).bars.length, 0);
  assert.equal(buildScore([]).totalBeats, 0);
  assert.deepEqual(suggestTranspose([]), { transpose: 0, playable: 0, total: 0 });
});

test('rejects malformed pitches, timing, meter and unsupported quantization', () => {
  for (const midi of [NaN, Infinity, -1, 128, 60.5, '60', null]) assert.throws(() => pitchInfo(midi));
  for (const note of [null, n(60, -1), n(60, NaN), n(60, 0, 0), n(60, 0, Infinity), n(60, 0, 1, 2)]) assert.throws(() => buildScore([note]));
  assert.throws(() => buildScore('notes'));
  assert.throws(() => buildScore([n(60)], { meter: [0, 4] }));
  assert.throws(() => buildScore([n(60)], { meter: [4, 3] }));
  assert.throws(() => buildScore([n(60)], { grid: 1 / 3 }));
  assert.throws(() => buildScore([n(0)], { transpose: -1 }));
  assert.throws(() => buildScore([n(60)], { instrument: '__proto__' }));
});

test('bounds oversized inputs before allocating or rendering huge scores', () => {
  assert.throws(() => buildScore(Array.from({ length: LIMITS.maxNotes + 1 }, () => n(60))), /音符超过/);
  assert.throws(() => buildScore([n(60, 1024)]), /超过.*小节/);
  assert.throws(() => buildScore([n(60, 0, 1e100)]), /超过.*小节/);
  assert.throws(() => buildScore([n(60, 1023, 2)]), /超过.*小节/);
  const score = buildScore([n(60, 1023, 1)]);
  assert.equal(score.bars.length, LIMITS.maxBars);
  assert.equal(score.totalBeats, 1024);
});
