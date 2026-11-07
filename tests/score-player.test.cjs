const test = require('node:test');
const assert = require('node:assert/strict');
const { ScorePlayer, midiFrequency, normalizeScore } = require('../score/player.js');

class Parameter {
  constructor() { this.events = []; }
  setValueAtTime(value, time) { this.events.push({ type: 'value', value, time }); }
  exponentialRampToValueAtTime(value, time) { this.events.push({ type: 'ramp', value, time }); }
  setTargetAtTime(value, time, constant) { this.events.push({ type: 'target', value, time, constant }); }
  cancelScheduledValues(time) { this.events.push({ type: 'cancel', time }); }
}
class Node {
  constructor() { this.gain = new Parameter(); this.frequency = new Parameter(); this.stops = []; }
  connect(node) { this.connected = node; }
  disconnect() { this.disconnected = true; }
  start(time) { this.startTime = time; }
  stop(time) { this.stops.push(time); }
}
class Context {
  constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000; this.destination = {}; this.oscillators = []; this.gains = []; }
  createGain() { const node = new Node(); this.gains.push(node); return node; }
  createOscillator() { const node = new Node(); this.oscillators.push(node); return node; }
  async resume() { this.state = 'running'; }
}
function setup() {
  const context = new Context();
  const notes = [], states = [], progress = [], errors = [], active = [];
  const player = new ScorePlayer({ onNote: n => notes.push(n), onActiveNotes: n => active.push(n), onStateChange: s => states.push(s), onProgress: p => progress.push(p), onError: e => errors.push(e) }, { createContext: () => context, manualClock: true });
  return { context, player, notes, states, progress, errors, active };
}
function advance(f, seconds, visuals = true, step = 0.025) {
  const end = f.context.currentTime + seconds;
  while (f.context.currentTime < end - 1e-10) {
    f.context.currentTime = Math.min(end, f.context.currentTime + step);
    f.player._schedule();
    if (visuals) f.player._flushVisuals();
  }
}
const melody = [{ midi: 60, start: 0, duration: 1 }, { midi: 64, start: 1.5, duration: 2 }, { midi: 67, start: 4, duration: 1 }];

test('MIDI pitch conversion gives concert A and middle C', () => {
  assert.equal(midiFrequency(69), 440);
  assert.ok(Math.abs(midiFrequency(60) - 261.6255653) < 1e-6);
});

test('normalization sorts safely, preserves source indices and metadata, and retains trailing rests', () => {
  const source = [{ midi: 67, start: 3, duration: 1, id: 'last' }, { midi: 60, start: 0, duration: 1, id: 'first' }];
  const score = normalizeScore(source, { bpm: 80, totalBeats: 8, volume: 0 });
  assert.deepEqual(score.entries.map(e => e.index), [1, 0]);
  assert.deepEqual(score.entries.map(e => e.note.id), ['first', 'last']);
  assert.equal(score.totalBeats, 8);
  assert.equal(score.volume, 0);
  assert.equal(source[0].id, 'last');
  assert.equal(normalizeScore(melody, { totalBeats: 1 }).totalBeats, 5);
});

test('invalid notes, unbounded time and pathological polyphony are rejected helpfully', () => {
  assert.throws(() => normalizeScore([]), /没有可播放/);
  assert.throws(() => normalizeScore([{ midi: 60, start: NaN, duration: 1 }]), /开始位置/);
  assert.throws(() => normalizeScore([{ midi: 60, start: 0, duration: Infinity }]), /时值/);
  assert.throws(() => normalizeScore([{ midi: 128, start: 0, duration: 1 }]), /音高/);
  assert.throws(() => normalizeScore([{ midi: 60, start: 49152, duration: 1 }]), /长度范围/);
  assert.throws(() => normalizeScore(Array.from({ length: 65 }, () => ({ midi: 60, start: 0, duration: 1 }))), /同时发声/);
  assert.throws(() => normalizeScore(melody, { bpm: Infinity }), /速度/);
});

test('all 100000 melody notes survive validation without an argument-spread overflow', () => {
  const notes = Array.from({ length: 100000 }, (_, index) => ({ midi: 60, start: index / 4, duration: 0.25 }));
  const score = normalizeScore(notes);
  assert.equal(score.entries.length, 100000);
  assert.equal(score.totalBeats, 25000);
  assert.equal(score.entries.at(-1).index, 99999);
  assert.throws(() => normalizeScore([...notes, { midi: 60, start: 25000, duration: 0.25 }]), error => /100000/.test(error.message) && /拒绝整首播放/.test(error.message) && !/裁剪|截取|片段/.test(error.message));
});

test('a melody beyond 10000 notes starts without allocating audio voices for the entire score', async () => {
  const f = setup();
  const notes = Array.from({ length: 10001 }, (_, index) => ({ midi: 60, start: index / 4, duration: 0.25 }));
  assert.equal(await f.player.play(notes, { bpm: 120 }), true);
  assert.equal(f.player._score.entries.length, 10001);
  assert.equal(f.context.oscillators.length, 3);
  assert.equal(f.progress[0].totalBeats, 2500.25);
  f.player.stop();
});

test('the complete duration bound accepts long leading and trailing rests and rejects excess as a whole', () => {
  const source = [{ midi: 60, start: 49150, duration: 1 }];
  const score = normalizeScore(source, { totalBeats: 49152 });
  assert.equal(score.totalBeats, 49152);
  assert.equal(score.entries[0].note.start, 49150);
  assert.throws(() => normalizeScore(source, { totalBeats: 49152.25 }), /拒绝整首播放/);
  assert.throws(() => normalizeScore([{ midi: 60, start: 49151, duration: 2 }]), /拒绝整首播放/);
});

test('audio clock schedules pitches, fractional rests and original sustained durations', async () => {
  const f = setup();
  await f.player.play(melody, { bpm: 120 });
  advance(f, 2.6);
  const fundamentals = f.context.oscillators.filter((_, index) => index % 3 === 0);
  assert.deepEqual(fundamentals.map(o => Math.round(o.startTime * 1000)), [40, 790, 2040]);
  assert.deepEqual(fundamentals.map(o => Math.round((o.stops[0] - o.startTime) * 1000)), [502, 1002, 502]);
  assert.deepEqual(fundamentals.map(o => o.frequency.events[0].value), melody.map(n => midiFrequency(n.midi)));
  assert.deepEqual(f.notes.map(n => n.index), [0, 1, 2]);
  assert.equal(f.player.isPlaying, false);
  assert.equal(f.states.at(-1).reason, 'ended');
});

test('a sustained or tied note is plucked once and remains allocated for its full duration', async () => {
  const f = setup();
  await f.player.play([{ midi: 60, start: 0, duration: 8 }], { bpm: 120 });
  advance(f, 3);
  assert.equal(f.context.oscillators.length, 3);
  assert.equal(f.context.oscillators[0].stops[0], 4.042);
  assert.equal(f.player.isPlaying, true);
  f.player.stop();
});

test('leading and trailing rests preserve timing and completion reports the final beat', async () => {
  const f = setup();
  await f.player.play([{ midi: 60, start: 2, duration: 1 }], { bpm: 120, totalBeats: 5 });
  assert.equal(f.context.oscillators.length, 0);
  advance(f, 0.8);
  assert.equal(f.notes.length, 0);
  assert.equal(f.context.oscillators.length, 0);
  advance(f, 1.2);
  assert.equal(f.player.isPlaying, true);
  assert.equal(f.notes.length, 1);
  advance(f, 0.6);
  assert.equal(f.player.isPlaying, false);
  assert.deepEqual(f.progress.at(-1), { beat: 5, totalBeats: 5 });
  assert.equal(f.states.at(-1).reason, 'ended');
});

test('visual notes wait for audible output rather than scheduling lookahead', async () => {
  const f = setup();
  f.context.baseLatency = 0.02;
  f.context.outputLatency = 0.03;
  await f.player.play([{ midi: 60, start: 0, duration: 1 }]);
  advance(f, 0.06);
  assert.equal(f.notes.length, 0);
  advance(f, 0.04);
  assert.equal(f.notes.length, 1);
  f.player.stop();
});

test('stop silences and cancels queued voices with no later callbacks', async () => {
  const f = setup();
  await f.player.play([{ midi: 60, start: 0, duration: 0.125 }, { midi: 62, start: 0.125, duration: 0.125 }], { bpm: 120 });
  assert.equal(f.context.oscillators.length, 6);
  const master = f.player._master;
  f.player.stop();
  assert.equal(master.gain.events.at(-1).value, 0);
  assert.ok(f.context.oscillators.every(o => o.disconnected && o.stops.at(-1) === undefined));
  advance(f, 1);
  assert.equal(f.notes.length, 0);
  assert.equal(f.states.at(-1).reason, 'stop');
});

test('a stop during audio resume cancels an otherwise late start', async () => {
  const f = setup();
  f.context.state = 'suspended';
  let finish;
  f.context.resume = () => new Promise(resolve => { finish = () => { f.context.state = 'running'; resolve(); }; });
  const pending = f.player.play(melody);
  f.player.stop();
  finish();
  assert.equal(await pending, false);
  assert.equal(f.player.isPlaying, false);
  assert.equal(f.context.oscillators.length, 0);
});

test('second async play supersedes first without double audio and accepts pending volume changes', async () => {
  const f = setup();
  f.context.state = 'suspended';
  const finishes = [];
  f.context.resume = () => new Promise(resolve => finishes.push(resolve));
  const first = f.player.play(melody, { bpm: 60 });
  const second = f.player.play([{ midi: 69, start: 0, duration: 1 }], { bpm: 120 });
  f.player.setVolume(0);
  f.context.state = 'running';
  finishes[1]();
  assert.equal(await second, true);
  finishes[0]();
  assert.equal(await first, false);
  assert.equal(f.context.oscillators.length, 3);
  assert.equal(f.context.oscillators[0].frequency.events[0].value, 440);
  assert.equal(f.player._master.gain.events[0].value, 0);
  f.player.stop();
});

test('audio suspension stops with an explicit reason and permits restart', async () => {
  const f = setup();
  await f.player.play(melody);
  f.context.state = 'suspended';
  f.context.onstatechange();
  assert.equal(f.player.isPlaying, false);
  assert.equal(f.states.at(-1).reason, 'interrupted');
  assert.equal(await f.player.play(melody), true);
  f.player.stop();
});

test('a missed scheduling deadline stops without playing missed notes in a burst', async () => {
  const f = setup();
  await f.player.play(melody, { bpm: 120 });
  const before = f.context.oscillators.length;
  f.context.currentTime = 2;
  f.player._schedule();
  assert.equal(f.context.oscillators.length, before);
  assert.equal(f.states.at(-1).reason, 'stalled');
});

test('hidden-tab completion works without animation frames and keeps final progress', async () => {
  const f = setup();
  await f.player.play(melody, { bpm: 120, totalBeats: 7 });
  advance(f, 3.7, false);
  assert.equal(f.player.isPlaying, false);
  assert.equal(f.states.at(-1).reason, 'ended');
  assert.deepEqual(f.progress.at(-1), { beat: 7, totalBeats: 7 });
});

test('invalid play reports a readable error without starting audio', async () => {
  const f = setup();
  assert.equal(await f.player.play([]), false);
  assert.match(f.errors[0].message, /没有可播放的音符/);
  assert.equal(f.states.at(-1).reason, 'error');
  assert.equal(f.context.oscillators.length, 0);
});

test('zero note velocity is silent while timeline and note callbacks still advance', async () => {
  const f = setup();
  await f.player.play([{ midi: 60, start: 0, duration: 1, velocity: 0 }], { bpm: 120, volume: 0 });
  advance(f, 0.6);
  assert.equal(f.context.oscillators.length, 0);
  assert.equal(f.notes.length, 1);
  assert.ok(f.active.every(update => update.notes.length === 0));
  assert.equal(f.states.at(-1).reason, 'ended');
});

test('all chord voices start together, retain their durations and become active together', async () => {
  const f = setup();
  const chord = [60, 64, 67].map((midi, index) => ({ midi, start: 0, duration: index + 1, sourceId: `chord-${index}` }));
  await f.player.play(chord, { bpm: 120 });
  assert.equal(f.context.oscillators.length, 9);
  const fundamentals = f.context.oscillators.filter((_, index) => index % 3 === 0);
  assert.deepEqual(fundamentals.map(voice => voice.startTime), [0.04, 0.04, 0.04]);
  assert.deepEqual(fundamentals.map(voice => Math.round(voice.stops[0] * 1000)), [542, 1042, 1542]);
  advance(f, 0.1);
  assert.deepEqual(f.active.at(-1).notes.map(note => note.sourceId), ['chord-0', 'chord-1', 'chord-2']);
  assert.deepEqual(f.notes.map(event => event.index), [0, 1, 2]);
  advance(f, 0.5);
  assert.deepEqual(f.active.at(-1).notes.map(note => note.sourceId), ['chord-1', 'chord-2']);
  f.player.stop();
  assert.deepEqual(f.active.at(-1).notes, []);
});

test('sustained bass stays active and is never clipped or reattacked by following melody notes', async () => {
  const f = setup();
  await f.player.play([
    { midi: 48, start: 0, duration: 4, sourceId: 'bass' },
    { midi: 72, start: 1, duration: 1, sourceId: 'first' },
    { midi: 74, start: 2, duration: 1, sourceId: 'second' },
  ], { bpm: 120, totalBeats: 5 });
  const bassVoice = f.context.oscillators[0];
  advance(f, 0.1);
  assert.deepEqual(f.active.at(-1).notes.map(note => note.sourceId), ['bass']);
  advance(f, 0.5);
  assert.deepEqual(f.active.at(-1).notes.map(note => note.sourceId), ['bass', 'first']);
  advance(f, 0.5);
  assert.deepEqual(f.active.at(-1).notes.map(note => note.sourceId), ['bass', 'second']);
  advance(f, 0.5);
  assert.deepEqual(f.active.at(-1).notes.map(note => note.sourceId), ['bass']);
  assert.equal(bassVoice.stops.length, 1);
  assert.equal(Math.round(bassVoice.stops[0] * 1000), 2042);
  assert.equal(f.context.oscillators.length, 9);
  advance(f, 0.5);
  assert.deepEqual(f.active.at(-1).notes, []);
  assert.equal(f.player.isPlaying, true, 'trailing rest is still playing');
  advance(f, 0.5);
  assert.equal(f.states.at(-1).reason, 'ended');
});

test('hidden-tab callbacks recover the full current chord without stale expired-note flashes', async () => {
  const f = setup();
  await f.player.play([
    { midi: 48, start: 0, duration: 8, sourceId: 'bass' },
    { midi: 60, start: 0, duration: 0.25, sourceId: 'expired-a' },
    { midi: 62, start: 1, duration: 0.25, sourceId: 'expired-b' },
    { midi: 64, start: 2, duration: 1, sourceId: 'current' },
  ], { bpm: 120 });
  advance(f, 1.15, false);
  f.player._flushVisuals();
  assert.deepEqual(f.active.at(-1).notes.map(note => note.sourceId), ['bass', 'current']);
  assert.deepEqual(f.notes.map(event => event.note.sourceId), ['bass', 'current']);
  advance(f, 0.5);
  assert.deepEqual(f.active.at(-1).notes.map(note => note.sourceId), ['bass']);
  f.player.stop();
});

test('active callbacks honor output latency and clear immediately on stop without later updates', async () => {
  const f = setup();
  f.context.baseLatency = 0.02;
  f.context.outputLatency = 0.03;
  await f.player.play([{ midi: 60, start: 0, duration: 4, sourceId: 'held' }], { bpm: 120 });
  advance(f, 0.06);
  assert.deepEqual(f.active.at(-1).notes, []);
  advance(f, 0.04);
  assert.equal(f.active.at(-1).notes[0].sourceId, 'held');
  f.player.stop();
  assert.deepEqual(f.active.at(-1).notes, []);
  const count = f.active.length;
  advance(f, 1);
  assert.equal(f.active.length, count);
});

test('all 64 chord notes are preserved while summed synthesis peaks remain below clipping', async () => {
  const f = setup();
  const chord = Array.from({ length: 64 }, (_, index) => ({ midi: 48 + index % 24, start: 0, duration: 2, sourceId: `voice-${index}`, velocity: 1 }));
  const normalized = normalizeScore(chord);
  assert.equal(normalized.peakPolyphony, 64);
  assert.ok(normalized.voiceGain > 0 && normalized.voiceGain < 1);
  assert.equal(normalizeScore(melody).voiceGain, 1, 'ordinary monophonic volume is preserved');
  await f.player.play(chord, { bpm: 120, volume: 1 });
  assert.equal(f.context.oscillators.length, 64 * 3);
  assert.equal(f.player._master.gain.events[0].value, 1);
  const allPartialPeakSum = f.context.gains.slice(1).reduce((sum, gain) => sum + Math.max(...gain.gain.events.filter(event => 'value' in event).map(event => event.value)), 0);
  assert.ok(allPartialPeakSum <= 0.851, `summed peak envelope ${allPartialPeakSum} must have headroom`);
  advance(f, 0.1);
  assert.equal(f.active.at(-1).notes.length, 64);
  assert.equal(f.notes.length, 64);
  f.player.stop();
  assert.ok(f.context.oscillators.every(voice => voice.disconnected));
});

test('polyphonic normalization counts held-note overlap and permits clean boundary handoffs', () => {
  const notes = [{ midi: 48, start: 0, duration: 4 }, { midi: 60, start: 1, duration: 1 }, { midi: 62, start: 2, duration: 1 }];
  assert.equal(normalizeScore(notes).peakPolyphony, 2);
  assert.equal(normalizeScore([{ midi: 60, start: 0, duration: 1 }, { midi: 60, start: 1, duration: 1 }]).peakPolyphony, 1);
});

test('seeking preserves absolute timing, original note identity and trailing rests', async () => {
  const f = setup();
  const source = [
    { midi: 67, start: 5, duration: 1, sourceId: 'later' },
    { midi: 60, start: 0, duration: 1, sourceId: 'past' },
    { midi: 48, start: 3, duration: 3, sourceId: 'held', measure: 2, tied: true },
    { midi: 62, start: 2, duration: 2, sourceId: 'boundary' },
    { midi: 64, start: 4, duration: 0.5, sourceId: 'target' },
  ];
  const original = structuredClone(source);
  assert.equal(await f.player.play(source, { bpm: 120, startBeat: 4, totalBeats: 10 }), true);
  assert.deepEqual(f.progress[0], { beat: 4, totalBeats: 10 });
  assert.deepEqual(f.player._score.entries.map(entry => entry.index), [2, 4, 0]);
  assert.deepEqual(f.player._score.entries[0].note, { ...source[2], start: 4, duration: 2, velocity: 1 });
  advance(f, 0.1);
  assert.deepEqual(f.active.at(-1).notes.map(note => note.sourceId), ['held', 'target']);
  assert.ok(f.active.at(-1).beat >= 4);
  advance(f, 1.6);
  const fundamentals = f.context.oscillators.filter((_, index) => index % 3 === 0);
  assert.deepEqual(fundamentals.map(voice => Math.round(voice.startTime * 1000)), [40, 40, 540]);
  assert.deepEqual(fundamentals.map(voice => Math.round((voice.stops[0] - voice.startTime) * 1000)), [1002, 252, 502]);
  assert.deepEqual(f.notes.map(event => event.index), [2, 4, 0]);
  assert.equal(f.player.isPlaying, true, 'the full-song trailing rest is retained');
  advance(f, 1.4);
  assert.deepEqual(f.progress.at(-1), { beat: 10, totalBeats: 10 });
  assert.equal(f.states.at(-1).reason, 'ended');
  assert.ok(f.progress.every(event => event.beat >= 4 && event.totalBeats === 10));
  assert.deepEqual(source, original, 'seeking must not mutate caller-owned notes');
});

test('seek normalization keeps whole-score validation and volume headroom', () => {
  assert.equal(normalizeScore(melody).startBeat, 0);
  assert.deepEqual(normalizeScore(melody).entries, normalizeScore(melody, { startBeat: 0 }).entries);
  const source = [...Array.from({ length: 8 }, (_, index) => ({ midi: 48 + index, start: 0, duration: 1 })), { midi: 72, start: 4, duration: 1 }];
  assert.equal(normalizeScore(source, { startBeat: 4 }).voiceGain, normalizeScore(source).voiceGain);
  assert.throws(() => normalizeScore([{ midi: 128, start: 0, duration: 1 }, ...melody], { startBeat: 4 }), /音高/);
});

test('invalid seek targets report a Chinese error without starting audio', async () => {
  for (const startBeat of [NaN, Infinity, -Infinity, -1, '2', null]) {
    const f = setup();
    assert.equal(await f.player.play(melody, { startBeat }), false);
    assert.match(f.errors[0].message, /播放起点.*有效拍数/);
    assert.equal(f.player._context, null);
    assert.equal(f.states.at(-1).reason, 'error');
  }
});

test('seeking to or past the end finishes successfully without creating audio or clocks', async () => {
  for (const startBeat of [10, 100]) {
    const f = setup();
    f.player._dependencies.manualClock = false;
    f.player._dependencies.createContext = () => { assert.fail('end seek must not create audio'); };
    assert.equal(await f.player.play(melody, { startBeat, totalBeats: 10 }), true);
    assert.equal(f.player.isPlaying, false);
    assert.equal(f.player._score.startBeat, 10);
    assert.equal(f.player._score.entries.length, 0);
    assert.deepEqual(f.progress, [{ beat: 10, totalBeats: 10 }]);
    assert.deepEqual(f.active, [{ notes: [], beat: 10 }]);
    assert.deepEqual(f.states, [{ state: 'stopped', reason: 'ended' }]);
    assert.equal(f.player._timer, null);
    assert.equal(f.player._worker, null);
    assert.equal(f.context.oscillators.length, 0);
  }
});

test('seeking into leading, internal and trailing rests keeps their remaining silence', async () => {
  const source = [{ midi: 60, start: 2, duration: 1 }, { midi: 64, start: 6, duration: 1 }];
  for (const [startBeat, expectedIndices] of [[1, [0, 1]], [4, [1]], [8, []]]) {
    const f = setup();
    assert.equal(await f.player.play(source, { bpm: 120, startBeat, totalBeats: 10 }), true);
    advance(f, 0.15);
    assert.equal(f.context.oscillators.length, 0);
    assert.equal(f.notes.length, 0);
    assert.ok(f.progress.at(-1).beat >= startBeat);
    advance(f, (10 - startBeat) * 0.5 - 0.1);
    assert.deepEqual(f.notes.map(event => event.index), expectedIndices);
    assert.deepEqual(f.progress.at(-1), { beat: 10, totalBeats: 10 });
    assert.equal(f.states.at(-1).reason, 'ended');
  }
});

test('seeking within a tiny remaining slice of a valid held note preserves its tail', async () => {
  const f = setup();
  const startBeat = 8 - 1 / 4096;
  assert.equal(await f.player.play([{ midi: 60, start: 0, duration: 8, sourceId: 'tie' }], { bpm: 120, startBeat }), true);
  assert.equal(f.player._score.entries[0].note.duration, 1 / 4096);
  assert.equal(f.context.oscillators.length, 3);
  assert.ok(Math.abs(f.context.oscillators[0].startTime - 0.04) < 1e-10);
  assert.ok(Math.abs(f.context.oscillators[0].stops[0] - (0.042 + 1 / 8192)) < 1e-10);
  advance(f, 0.1);
  assert.equal(f.states.at(-1).reason, 'ended');
  assert.equal(f.errors.length, 0);
});

test('seek progress never precedes the target during startup latency or immediate pause', async () => {
  const f = setup();
  f.context.baseLatency = 0.02;
  f.context.outputLatency = 0.03;
  await f.player.play(melody, { bpm: 120, startBeat: 2 });
  advance(f, 0.02);
  f.player.stop('pause');
  assert.ok(f.progress.every(event => event.beat === 2 && event.totalBeats === 5));
  assert.ok(f.active.every(event => event.beat === 2));
  assert.equal(f.notes.length, 0);
  assert.equal(f.states.at(-1).reason, 'pause');
  await f.player.play(melody, { bpm: 120, startBeat: f.progress.at(-1).beat });
  advance(f, 0.1);
  assert.equal(f.notes.at(-1).index, 1);
  assert.ok(f.progress.at(-1).beat > 2);
  f.player.stop();
});

test('forward and backward seeks silence every previous voice and reset absolute progress', async () => {
  const f = setup();
  await f.player.play(melody, { bpm: 120 });
  advance(f, 0.1);
  for (const [startBeat, expectedIndex] of [[4.5, 2], [0.5, 0]]) {
    const previousMaster = f.player._master;
    const previousVoices = [...f.player._voices];
    const callbackCount = f.notes.length;
    await f.player.play(melody, { bpm: 120, startBeat });
    assert.equal(previousMaster.gain.events.at(-1).value, 0);
    assert.equal(previousMaster.disconnected, true);
    assert.ok(previousVoices.every(voice => voice.oscillator.disconnected && voice.gain.disconnected && voice.oscillator.stops.at(-1) === undefined));
    assert.deepEqual(f.active.at(-1), { notes: [], beat: startBeat });
    assert.equal(f.progress.at(-1).beat, startBeat);
    advance(f, 0.1);
    assert.deepEqual(f.notes.slice(callbackCount).map(event => event.index), [expectedIndex]);
  }
  f.player.stop();
});

test('seeking into expanded repeats preserves distinct occurrences sharing a source ID', async () => {
  const f = setup();
  const source = [0, 4, 8].map(start => ({ midi: 60, start, duration: 2, sourceId: 'repeat-note' }));
  await f.player.play(source, { bpm: 120, startBeat: 5 });
  advance(f, 2.6);
  assert.deepEqual(f.notes.map(event => event.index), [1, 2]);
  assert.deepEqual(f.notes.map(event => event.note.sourceId), ['repeat-note', 'repeat-note']);
  assert.deepEqual(f.notes.map(event => event.note.duration), [1, 2]);
  assert.equal(f.context.oscillators.length, 6);
  assert.equal(f.states.at(-1).reason, 'ended');
});

test('consecutive asynchronous seeks schedule only the latest request in either resume order', async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const f = setup();
    const resumes = [];
    f.context.state = 'suspended';
    f.context.resume = () => new Promise(resolve => resumes.push(resolve));
    const pending = [
      f.player.play(melody, { bpm: 120, startBeat: 2 }),
      f.player.play(melody, { bpm: 120, startBeat: 4.5 }),
    ];
    f.player.setVolume(0);
    f.context.state = 'running';
    for (const index of order) {
      resumes[index]();
      assert.equal(await pending[index], index === 1);
    }
    assert.equal(f.context.oscillators.length, 3);
    assert.equal(f.context.oscillators[0].frequency.events[0].value, midiFrequency(67));
    assert.equal(f.player._master.gain.events[0].value, 0);
    assert.deepEqual(f.progress, [{ beat: 4.5, totalBeats: 5 }]);
    f.player.stop();
  }
});

test('an outdated resume rejection cannot stop a newer seek', async () => {
  const f = setup();
  const resumes = [];
  f.context.state = 'suspended';
  f.context.resume = () => new Promise((resolve, reject) => resumes.push({ resolve, reject }));
  const first = f.player.play(melody, { startBeat: 2 });
  const second = f.player.play(melody, { startBeat: 4 });
  f.context.state = 'running';
  resumes[1].resolve();
  assert.equal(await second, true);
  resumes[0].reject(new Error('outdated resume'));
  assert.equal(await first, false);
  assert.equal(f.player.isPlaying, true);
  assert.equal(f.errors.length, 0);
  assert.equal(f.states.at(-1).state, 'playing');
  f.player.stop();
});

test('seeking to the end invalidates an earlier pending audio resume', async () => {
  const f = setup();
  let finish;
  f.context.state = 'suspended';
  f.context.resume = () => new Promise(resolve => { finish = resolve; });
  const pending = f.player.play(melody, { startBeat: 2 });
  assert.equal(await f.player.play(melody, { startBeat: 10, totalBeats: 10 }), true);
  f.context.state = 'running';
  finish();
  assert.equal(await pending, false);
  assert.equal(f.context.oscillators.length, 0);
  assert.equal(f.player.isPlaying, false);
  assert.deepEqual(f.progress, [{ beat: 10, totalBeats: 10 }]);
  assert.deepEqual(f.states, [{ state: 'stopped', reason: 'ended' }]);
});

test('a seek started by the completing progress callback is not stopped by old completion', async () => {
  const f = setup();
  let replacement;
  const captureProgress = f.player.onProgress;
  f.player.onProgress = event => {
    captureProgress(event);
    if (event.beat === 5 && !replacement) replacement = f.player.play(melody, { bpm: 120, startBeat: 2 });
  };
  await f.player.play(melody, { bpm: 120, startBeat: 4.5 });
  advance(f, 0.3);
  assert.equal(await replacement, true);
  assert.equal(f.player.isPlaying, true);
  assert.equal(f.player._score.startBeat, 2);
  assert.ok(f.states.every(state => state.reason !== 'ended'));
  advance(f, 0.1);
  assert.equal(f.notes.at(-1).index, 1);
  f.player.stop();
});
