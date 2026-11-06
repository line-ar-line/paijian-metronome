const test = require('node:test');
const assert = require('node:assert/strict');
const { MetronomeEngine, normalizeSettings, tickDuration } = require('../engine.js');

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
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; this.oscillators = []; this.gains = []; }
  createGain() { const node = new Node(); this.gains.push(node); return node; }
  createOscillator() { const node = new Node(); this.oscillators.push(node); return node; }
  async resume() { this.state = 'running'; }
}
function setup(settings = {}) {
  const context = new Context();
  const beats = [], states = [], errors = [];
  const engine = new MetronomeEngine({ onBeat: e => beats.push(e), onStateChange: e => states.push(e), onError: e => errors.push(e) }, { createContext: () => context, manualClock: true });
  return { context, engine, beats, states, errors, settings };
}
function advance(fixture, seconds, step = 0.025) {
  const end = fixture.context.currentTime + seconds;
  while (fixture.context.currentTime < end) {
    fixture.context.currentTime = Math.min(end, fixture.context.currentTime + step);
    fixture.engine._schedule();
    fixture.engine._flushVisuals();
  }
}

test('validates settings and preserves intentional silence', () => {
  assert.equal(normalizeSettings({ volume: 0 }).volume, 0);
  assert.equal(normalizeSettings({ bpm: 999 }).bpm, 240);
  assert.equal(normalizeSettings({ bpm: NaN }).bpm, 80);
  assert.deepEqual(normalizeSettings({ beatsPerBar: 3, accents: [0] }).accents, [0, 1, 1]);
  assert.equal(tickDuration(normalizeSettings({ bpm: 120, subdivision: 3 })), 1 / 6);
});

test('a minute of triplets stays on the audio clock without accumulated timer drift', async () => {
  const f = setup();
  await f.engine.start({ bpm: 120, subdivision: 3 });
  advance(f, 60, 0.027);
  assert.equal(f.beats.length, 360);
  for (let i = 0; i < f.beats.length; i++) {
    assert.ok(Math.abs(f.beats[i].audioTime - (0.04 + i / 6)) < 1e-9);
    assert.equal(f.beats[i].beat, Math.floor(i / 3) % 4);
    assert.equal(f.beats[i].subdivision, i % 3);
    assert.equal(f.beats[i].bar, Math.floor(i / 12) + 1);
  }
  f.engine.stop();
});

test('silent beats silence their subdivisions while preserving visual beat events', async () => {
  const f = setup();
  await f.engine.start({ bpm: 120, beatsPerBar: 2, subdivision: 2, accents: [2, 0] });
  advance(f, 0.8);
  assert.deepEqual(f.context.oscillators.map(node => node.startTime), [0.04, 0.29]);
  assert.deepEqual(f.beats.map(e => [e.beat, e.subdivision]), [[0, 0], [0, 1], [1, 0], [1, 1]]);
  f.engine.stop();
});

test('stop cancels already scheduled sounds, visual events, and volume output', async () => {
  const f = setup();
  await f.engine.start({ bpm: 240, subdivision: 4 });
  assert.ok(f.context.oscillators.length > 1);
  const master = f.engine._master;
  f.engine.stop();
  assert.equal(f.engine.isRunning, false);
  assert.equal(f.engine._events.length, 0);
  assert.equal(master.gain.events.at(-1).value, 0);
  for (const node of f.context.oscillators) { assert.equal(node.disconnected, true); assert.equal(node.stops.at(-1), undefined); }
  advance(f, 1);
  assert.equal(f.beats.length, 0);
});

test('meter change cancels old ticks and restarts on a clean downbeat', async () => {
  const f = setup();
  await f.engine.start({ bpm: 120 });
  advance(f, 0.6);
  const prior = [...f.context.oscillators];
  f.engine.configure({ beatsPerBar: 3, subdivision: 2, accents: [2, 1, 1] });
  assert.ok(prior.every(node => node.disconnected));
  f.beats.length = 0;
  advance(f, 0.8);
  assert.deepEqual(f.beats.map(e => [e.beat, e.subdivision]), [[0, 0], [0, 1], [1, 0], [1, 1]]);
  f.engine.stop();
});

test('BPM updates preserve phase and apply the new spacing to new ticks', async () => {
  const f = setup();
  await f.engine.start({ bpm: 120 });
  advance(f, 0.1);
  f.engine.configure({ bpm: 60 });
  advance(f, 2.5);
  assert.deepEqual(f.beats.map(e => e.beat), [0, 1, 2, 3]);
  assert.deepEqual(f.beats.map(e => Math.round(e.audioTime * 1000)), [40, 540, 1540, 2540]);
  f.engine.stop();
});

test('long scheduler stalls stop rather than bunching missed notes', async () => {
  const f = setup();
  await f.engine.start({ bpm: 120, subdivision: 4 });
  const before = f.context.oscillators.length;
  f.context.currentTime = 3;
  f.engine._schedule();
  assert.equal(f.engine.isRunning, false);
  assert.equal(f.context.oscillators.length, before);
  assert.equal(f.states.at(-1).reason, 'stalled');
});

test('audio interruption stops cleanly and a later start resumes', async () => {
  const f = setup();
  await f.engine.start();
  f.context.state = 'suspended';
  f.context.onstatechange();
  assert.equal(f.states.at(-1).reason, 'interrupted');
  assert.equal(f.engine.isRunning, false);
  assert.equal(await f.engine.start(), true);
  f.engine.stop();
});

test('a stop during asynchronous resume prevents a late unwanted start', async () => {
  const f = setup();
  f.context.state = 'suspended';
  let finishResume;
  f.context.resume = () => new Promise(resolve => { finishResume = () => { f.context.state = 'running'; resolve(); }; });
  const pending = f.engine.start();
  f.engine.stop();
  finishResume();
  assert.equal(await pending, false);
  assert.equal(f.engine.isRunning, false);
  assert.equal(f.context.oscillators.length, 0);
});

test('a second start supersedes an unfinished start without duplicate playback', async () => {
  const f = setup();
  f.context.state = 'suspended';
  const resumes = [];
  f.context.resume = () => new Promise(resolve => resumes.push(resolve));
  const first = f.engine.start({ bpm: 60 });
  const second = f.engine.start({ bpm: 90 });
  f.context.state = 'running';
  resumes[1]();
  assert.equal(await second, true);
  resumes[0]();
  assert.equal(await first, false);
  assert.equal(f.context.oscillators.length, 1);
  assert.equal(f.engine.settings.bpm, 90);
  f.engine.stop();
});

test('settings changed while audio is being resumed are used by the eventual start', async () => {
  const f = setup();
  f.context.state = 'suspended';
  let finishResume;
  f.context.resume = () => new Promise(resolve => { finishResume = () => { f.context.state = 'running'; resolve(); }; });
  const pending = f.engine.start({ bpm: 60, beatsPerBar: 4 });
  f.engine.configure({ bpm: 120, beatsPerBar: 3, subdivision: 2, accents: [0, 2, 1], sound: 'bell' });
  f.engine.setVolume(0);
  finishResume();
  assert.equal(await pending, true);
  assert.equal(f.engine.settings.bpm, 120);
  assert.equal(f.engine.settings.beatsPerBar, 3);
  assert.equal(f.engine.settings.subdivision, 2);
  assert.equal(f.engine.settings.sound, 'bell');
  assert.equal(f.engine._master.gain.events[0].value, 0);
  assert.equal(f.context.oscillators.length, 0, 'first beat was changed to silent during resume');
  advance(f, 0.6);
  assert.equal(f.context.oscillators.length, 2, 'second beat uses the newly selected two-tone bell');
  f.engine.stop();
});

test('volume zero is retained on startup and when changed during playback', async () => {
  const f = setup();
  await f.engine.start({ volume: 0 });
  assert.equal(f.engine._master.gain.events[0].value, 0);
  f.engine.setVolume(0.5);
  f.engine.setVolume(0);
  assert.equal(f.engine._master.gain.events.at(-1).value, 0);
  assert.equal(f.engine.settings.volume, 0);
  f.engine.stop();
});

test('visuals returning from a background tab display only the latest audible event', async () => {
  const f = setup();
  await f.engine.start({ bpm: 120, subdivision: 4 });
  for (let i = 0; i < 40; i++) { f.context.currentTime += 0.025; f.engine._schedule(); }
  f.engine._flushVisuals();
  assert.equal(f.beats.length, 1);
  assert.equal(f.beats[0].beat, 1);
  assert.equal(f.beats[0].subdivision, 3);
  f.engine.stop();
});

test('the coalesced visual event retains the real bar after background playback', async () => {
  const f = setup();
  await f.engine.start({ bpm: 120, beatsPerBar: 4, subdivision: 4 });
  for (let i = 0; i < 400; i++) { f.context.currentTime += 0.025; f.engine._schedule(); }
  assert.ok(f.engine._events.length < 10, 'hidden-tab queue stays bounded');
  f.engine._flushVisuals();
  assert.equal(f.beats.length, 1);
  assert.equal(f.beats[0].bar, 5);
  assert.equal(f.beats[0].beat, 3);
  assert.equal(f.beats[0].subdivision, 3);
  f.engine.stop();
});
