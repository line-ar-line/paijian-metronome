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
  const maxBeats = LIMITS.maxBars * 4;
  assert.throws(() => buildScore([n(60, maxBeats)]), /超过.*小节/);
  assert.throws(() => buildScore([n(60, 0, 1e100)]), /超过.*小节/);
  assert.throws(() => buildScore([n(60, maxBeats - 1, 2)]), /超过.*小节/);
  const score = buildScore([n(60, maxBeats - 1, 1)]);
  assert.equal(score.bars.length, LIMITS.maxBars);
  assert.equal(score.totalBeats, maxBeats);
});

test('preserves every note in a full melody longer than 256 bars', () => {
  const source = Array.from({ length: 1200 }, (_, index) => n(60 + index % 2 * 2, index, 1));
  const score = buildScore(source);
  assert.equal(score.bars.length, 300);
  assert.equal(score.notes.length, 1200);
  assert.equal(score.stats.inputNotes, 1200);
  assert.equal(score.stats.outputNotes, 1200);
  assert.equal(score.notes.at(-1).sourceId, 'n1199');
  assert.equal(score.notes.at(-1).start, 1199);
  assert.equal(score.sourceEndBeat, 1200);
  assert.equal(score.sourceTotalBeats, 1200);
  assert.equal(score.totalBeats, 1200);
  assert.equal(score.bars.at(-1).tokens.at(-1).sourceId, 'n1199');
});

test('retains leading and trailing silence to the supplied complete song duration', () => {
  const score = buildScore([n(60, 5, 1)], { totalBeats: 17.5 });
  assert.equal(score.sourceEndBeat, 6);
  assert.equal(score.sourceTotalBeats, 17.5);
  assert.equal(score.totalBeats, 20);
  assert.equal(score.bars.length, 5);
  assert.ok(score.bars[0].tokens.every(token => token.midi === null));
  assert.ok(score.bars.at(-1).tokens.every(token => token.midi === null));
  assert.equal(score.notes[0].start, 5);
  for (const bar of score.bars) assert.equal(bar.tokens.reduce((sum, token) => sum + token.duration, 0), 4);
});

test('a supplied duration never shortens an audible final note', () => {
  const score = buildScore([n(60, 4, 2)], { totalBeats: 1 });
  assert.equal(score.sourceTotalBeats, 6);
  assert.equal(score.notes[0].duration, 2);
  assert.equal(score.totalBeats, 8);
});

test('melody simplification preserves the original source tail as rests', () => {
  const score = buildScore([n(48, 0, 12), n(72, 0, 1)]);
  assert.equal(score.stats.removedPolyphony, 1);
  assert.equal(score.notes.length, 1);
  assert.equal(score.notes[0].duration, 1);
  assert.equal(score.sourceEndBeat, 12);
  assert.equal(score.sourceTotalBeats, 12);
  assert.equal(score.bars.length, 3);
  assert.ok(score.bars[2].tokens.every(token => token.midi === null));
});

test('a silent selected part still spans the requested whole piece', () => {
  const score = buildScore([], { totalBeats: 9, meter: [6, 8] });
  assert.equal(score.bars.length, 3);
  assert.equal(score.sourceEndBeat, 0);
  assert.equal(score.sourceTotalBeats, 9);
  assert.equal(score.totalBeats, 9);
  assert.equal(score.notes.length, 0);
  assert.ok(score.bars.flatMap(bar => bar.tokens).every(token => token.midi === null));
});

test('validates whole-piece duration and uses meter-specific resource bounds', () => {
  for (const totalBeats of [NaN, Infinity, -1, '8', null, {}]) assert.throws(() => buildScore([], { totalBeats }), /总时长/);
  assert.throws(() => buildScore([], { totalBeats: 1e100 }), /拒绝转换整个文件/);
  assert.throws(() => buildScore([], { meter: [6, 8], totalBeats: LIMITS.maxBars * 3 + 0.25 }), /超过.*小节/);
  const score = buildScore([], { meter: [6, 8], totalBeats: LIMITS.maxBars * 3 });
  assert.equal(score.bars.length, LIMITS.maxBars);
  assert.equal(score.totalBeats, LIMITS.maxBars * 3);
});

test('accepts 100000 source notes without spread-argument overflow or implicit excerpting', () => {
  const notes = Array.from({ length: LIMITS.maxNotes }, () => n(60));
  const score = buildScore(notes);
  assert.equal(score.stats.inputNotes, LIMITS.maxNotes);
  assert.equal(score.stats.removedPolyphony, LIMITS.maxNotes - 1);
  assert.equal(score.stats.outputNotes, 1);
  assert.equal(score.sourceTotalBeats, 1);
});

test('oversize-file errors reject the whole conversion and never suggest excerpting', () => {
  for (const input of [Array.from({ length: LIMITS.maxNotes + 1 }, () => n(60)), [n(60, LIMITS.maxBars * 4)]]) {
    assert.throws(() => buildScore(input), error => {
      assert.match(error.message, /不完整曲谱|不生成部分曲谱/);
      assert.doesNotMatch(error.message, /截取|裁剪/);
      return true;
    });
  }
});

test('polyphonic mode preserves simultaneous notes and overlapping unequal durations', () => {
  const input = [n(72, 0, 0.5), n(60, 0, 4), n(67, 0, 2), n(74, 0.5, 1), n(76, 1.5, 1)];
  const score = buildScore(input, { mode: 'polyphonic' });
  assert.equal(score.notes.length, input.length);
  assert.equal(score.stats.outputNotes, input.length);
  assert.equal(score.stats.removedPolyphony, 0);
  assert.equal(score.stats.clippedOverlaps, 0);
  assert.equal(score.stats.maxPolyphony, 3);
  assert.equal(score.stats.voiceCount, 3);
  for (let index = 0; index < input.length; index++) {
    const output = score.notes.find(note => note.sourceId === `n${index}`);
    assert.equal(output.midi, input[index].midi);
    assert.equal(output.start, input[index].start);
    assert.equal(output.duration, input[index].duration);
    const segments = score.bars.flatMap(bar => bar.tokens).filter(token => token.sourceId === output.sourceId);
    assert.equal(segments.reduce((sum, token) => sum + token.duration, 0), output.duration);
    assert.ok(segments.every(token => token.voiceIndex === output.voiceIndex));
  }
  assert.equal(score.notes.find(note => note.sourceId === 'n1').duration, 4);
});

test('polyphonic lane assignment keeps a simple high melody and held bass stable', () => {
  const score = buildScore([n(76, 0, 0.5), n(48, 0, 2), n(77, 0.5, 0.5), n(79, 1, 1), n(79, 2, 1), n(50, 2, 2)], { mode: 'polyphonic' });
  assert.ok(score.notes.filter(note => note.midi > 70).every(note => note.voiceIndex === 0));
  assert.ok(score.notes.filter(note => note.midi < 60).every(note => note.voiceIndex === 1));
  assert.equal(score.stats.voiceCount, 2);
  for (const bar of score.bars) for (const lane of bar.voices) {
    assert.equal(lane.tokens.reduce((sum, token) => sum + token.duration, 0), bar.duration);
    for (let i = 1; i < lane.tokens.length; i++) assert.equal(lane.tokens[i].start, lane.tokens[i - 1].start + lane.tokens[i - 1].duration);
  }
});

test('polyphonic independent rests and cross-bar ties preserve every source note', () => {
  const score = buildScore([n(72, 1, 0.5), n(60, 1, 8), n(74, 5, 1)], { mode: 'polyphonic', totalBeats: 12 });
  const bass = score.notes.find(note => note.midi === 60);
  const tokens = score.bars.flatMap(bar => bar.tokens).filter(token => token.sourceId === bass.sourceId);
  assert.equal(tokens.reduce((sum, token) => sum + token.duration, 0), 8);
  assert.equal(tokens[0].tieIn, false);
  assert.equal(tokens[0].tieOut, true);
  assert.equal(tokens.at(-1).tieIn, true);
  assert.equal(tokens.at(-1).tieOut, false);
  assert.ok(score.bars[0].voices.every(lane => lane.tokens[0].midi === null));
  assert.equal(score.totalBeats, 12);
  assert.equal(score.notes.length, 3);
});

test('identical source pitches remain distinct simultaneous voices', () => {
  const score = buildScore([n(60), n(60), n(60)], { mode: 'polyphonic' });
  assert.equal(score.notes.length, 3);
  assert.deepEqual(new Set(score.notes.map(note => note.sourceId)), new Set(['n0', 'n1', 'n2']));
  assert.equal(new Set(score.notes.map(note => note.voiceIndex)).size, 3);
  assert.equal(score.stats.maxPolyphony, 3);
});

test('polyphonic mode retains a complete 12000-note piece beyond old source limits', () => {
  const source = Array.from({ length: 12000 }, (_, index) => n(60, index * 0.25, 0.25));
  const score = buildScore(source, { mode: 'polyphonic' });
  assert.equal(score.notes.length, 12000);
  assert.equal(score.stats.removedPolyphony, 0);
  assert.equal(score.stats.voiceCount, 1);
  assert.equal(score.bars.length, 750);
  assert.equal(score.sourceTotalBeats, 3000);
  assert.equal(score.notes.at(-1).sourceId, 'n11999');
});

test('unreasonable simultaneous-voice counts reject the entire polyphonic file', () => {
  const accepted = buildScore(Array.from({ length: LIMITS.maxVoices }, () => n(60)), { mode: 'polyphonic' });
  assert.equal(accepted.notes.length, LIMITS.maxVoices);
  assert.equal(accepted.stats.maxPolyphony, LIMITS.maxVoices);
  assert.throws(() => buildScore(Array.from({ length: LIMITS.maxVoices + 1 }, () => n(60)), { mode: 'polyphonic' }), /拒绝转换整个文件，不省略任何音符/);
  assert.throws(() => buildScore([n(60)], { mode: 'unknown' }), /模式/);
  assert.equal(buildScore([n(60), n(67)]).notes.length, 1, 'legacy default remains melody mode');
});
