const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseMidi } = require('../score/midi.js');
const { buildScore } = require('../score/score-model.js');
require('../score/examples.js');

test('Ode to Joy includes every note of the complete published 16-bar soprano', () => {
  const source = fs.readFileSync(path.join(__dirname, '../sources/mutopia-528-ode.ly'), 'utf8');
  assert.match(source, /copyright = "Public Domain"/);
  assert.match(source, /\\skip 1\*16/);
  const soprano = source.match(/sop\s*=\s*\\transpose c c'\{([\s\S]*?)\n\}/)[1];
  const pitches = { c: 48, d: 50, e: 52, f: 53, g: 55, a: 57, b: 59 };
  let start = 0;
  let duration = 1;
  const expected = [];
  for (const match of soprano.matchAll(/\b([a-g])([',]*)([1248])?(\.)?(?![A-Za-z])/g)) {
    if (match[3]) duration = 4 / Number(match[3]) * (match[4] ? 1.5 : 1);
    const octave = Array.from(match[2]).reduce((n, symbol) => n + (symbol === "'" ? 12 : -12), 0);
    // Source transposes up one octave; our arrangement transposes G major up5 to C.
    expected.push({ midi: pitches[match[1]] + octave + 12 + 5, start, duration });
    start += duration;
  }
  const ode = globalThis.ScoreExamples.find(example => example.id === 'ode');
  assert.equal(expected.length, 62);
  assert.equal(start, 64);
  assert.deepEqual(ode.notes.map(({ midi, start, duration }) => ({ midi, start, duration })), expected);
  const score = buildScore(ode.notes);
  assert.equal(score.bars.length, 16);
  assert.equal(score.stats.outputNotes, 62);
  assert.equal(score.stats.unplayable, 0);
  assert.equal(score.totalBeats, 64);
});

test('downloadable example MIDI files preserve complete built-in arrangements', () => {
  for (const example of globalThis.ScoreExamples) {
    const midi = parseMidi(fs.readFileSync(path.join(__dirname, `../examples/${example.id}.mid`)));
    const expected = example.notes.map(({ midi, start, duration }) => ({ midi, start, duration }));
    const actual = midi.tracks[0].notes.map(({ midi, start, duration }) => ({ midi, start, duration }));
    assert.deepEqual(actual, expected);
    assert.equal(midi.totalBeats, example.notes.at(-1).start + example.notes.at(-1).duration);
  }
});
