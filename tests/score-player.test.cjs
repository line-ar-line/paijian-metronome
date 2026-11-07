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
  const notes = [], states = [], progress = [], errors = [];
  const player = new ScorePlayer({ onNote: n => notes.push(n), onStateChange: s => states.push(s), onProgress: p => progress.push(p), onError: e => errors.push(e) }, { createContext: () => context, manualClock: true });
  return { context, player, notes, states, progress, errors };
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
  assert.throws(() => normalizeScore(Array.from({ length: 17 }, () => ({ midi: 60, start: 0, duration: 1 }))), /同时发声/);
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
  assert.equal(f.states.at(-1).reason, 'ended');
});
