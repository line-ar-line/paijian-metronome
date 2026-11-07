const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMidi } = require('../score/midi.js');

const u16 = n => [n >>> 8 & 255, n & 255];
const u32 = n => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
const ascii = s => Array.from(s, c => c.charCodeAt(0));
function vlq(n) {
  const bytes = [n & 127];
  while ((n = Math.floor(n / 128))) bytes.unshift((n & 127) | 128);
  return bytes;
}
const event = (delta, ...bytes) => [...vlq(delta), ...bytes];
const chunk = (name, data) => [...ascii(name), ...u32(data.length), ...data];
const end = event(0, 255, 47, 0);
const track = (...events) => chunk('MTrk', [...events.flat(), ...end]);
const midi = (tracks, { format = tracks.length > 1 ? 1 : 0, division = 480, declaredTracks = tracks.length, headerExtra = [] } = {}) => Uint8Array.from([
  ...chunk('MThd', [...u16(format), ...u16(declaredTracks), ...u16(division), ...headerExtra]), ...tracks.flat(),
]);
const note = (channel = 0, pitch = 60, duration = 480, velocity = 100) => [event(0, 0x90 + channel, pitch, velocity), event(duration, 0x80 + channel, pitch, 0)];
const tempo = (delta, micros) => event(delta, 255, 81, 3, micros >>> 16 & 255, micros >>> 8 & 255, micros & 255);
const meter = (delta, numerator, denominatorPower) => event(delta, 255, 88, 4, numerator, denominatorPower, 24, 8);
const name = text => { const data = [...Buffer.from(text)]; return event(0, 255, 3, ...vlq(data.length), ...data); };

test('format 0 returns exact quarter-note positions, normalized velocity, tempo and meter', () => {
  const data = midi([track(name('卡林巴练习'), tempo(0, 750000), meter(0, 6, 3), event(0, 0xc0, 10), event(240, 0x90, 67, 127), event(720, 0x80, 67, 0))]);
  const result = parseMidi(data.buffer);
  assert.equal(result.format, 0);
  assert.equal(result.ppq, 480);
  assert.equal(result.title, '卡林巴练习');
  assert.equal(result.tempo, 80);
  assert.deepEqual(result.timeSignature, [6, 8]);
  assert.deepEqual(result.tracks, [{ id: '0:0', name: '卡林巴练习 · 通道 1', channel: 0, program: 10, isPercussion: false, notes: [{ midi: 67, start: 0.5, duration: 1.5, velocity: 1 }] }]);
  assert.deepEqual(result.warnings, []);
});

test('format 1 keeps conductor title and splits source tracks by channel including drums', () => {
  const result = parseMidi(midi([
    track(name('夜曲'), tempo(0, 500000), meter(0, 3, 2)),
    track(name('合奏'), event(0, 0x91, 64, 64), event(0, 0x92, 67, 100), event(480, 0x81, 64, 0), event(0, 0x82, 67, 0)),
    track(...note(9, 38)),
  ]));
  assert.equal(result.title, '夜曲');
  assert.deepEqual(result.tracks.map(t => [t.id, t.channel, t.isPercussion]), [['1:1', 1, false], ['1:2', 2, false], ['2:9', 9, true]]);
  assert.equal(result.tracks[0].notes[0].velocity, 64 / 127);
  assert.match(result.warnings.join(''), /打击乐/);
});

test('running status and note-on velocity zero produce ordinary releases', () => {
  const result = parseMidi(midi([track(event(0, 0x90, 60, 80), event(240, 64, 90), event(240, 60, 0), event(240, 64, 0))]));
  assert.deepEqual(result.tracks[0].notes.map(n => [n.midi, n.start, n.duration]), [[60, 0, 1], [64, 0.5, 1]]);
});

test('overlapping same-pitch attacks pair FIFO', () => {
  const result = parseMidi(midi([track(event(0, 0x90, 60, 127), event(120, 60, 64), event(120, 0x80, 60, 0), event(120, 60, 0))]));
  assert.deepEqual(result.tracks[0].notes, [
    { midi: 60, start: 0, duration: 0.5, velocity: 1 },
    { midi: 60, start: 0.25, duration: 0.5, velocity: 64 / 127 },
  ]);
});

test('note pairing never crosses source tracks or channels', () => {
  const result = parseMidi(midi([
    track(event(0, 0x90, 60, 100), event(120, 0x81, 60, 0), event(120, 0x80, 60, 0)),
    track(event(0, 0x80, 60, 0), ...note(0, 72, 960)),
  ]));
  assert.equal(result.tracks[0].notes[0].duration, 0.5);
  assert.equal(result.tracks[1].notes[0].duration, 2);
  assert.match(result.warnings.join(''), /2 个没有对应起音/);
});

test('later tempo and meter changes never replace initial values', () => {
  const result = parseMidi(midi([track(tempo(0, 600000), meter(0, 3, 2), ...note(), tempo(0, 250000), meter(0, 6, 3))]));
  assert.equal(result.tempo, 100);
  assert.deepEqual(result.timeSignature, [3, 4]);
  assert.match(result.warnings.join(''), /后续变速/);
  assert.match(result.warnings.join(''), /后续变化/);
});

test('metadata only after tick zero leaves default tempo and meter with warnings', () => {
  const result = parseMidi(midi([track(...note(), tempo(0, 250000), meter(0, 3, 2))]));
  assert.equal(result.tempo, 120);
  assert.deepEqual(result.timeSignature, [4, 4]);
  assert.match(result.warnings.join(''), /默认 120 BPM/);
  assert.match(result.warnings.join(''), /默认 4\/4/);
});

test('a tick-zero tempo in a later source track is still the initial tempo', () => {
  const result = parseMidi(midi([track(...note(), tempo(0, 250000)), track(tempo(0, 1000000))]));
  assert.equal(result.tempo, 60);
  assert.match(result.warnings.join(''), /后续变速/);
});

test('conflicting tick-zero metadata preserves the first and reports the conflict', () => {
  const result = parseMidi(midi([track(tempo(0, 600000), tempo(0, 500000), meter(0, 3, 2), meter(0, 4, 2), ...note())]));
  assert.equal(result.tempo, 100);
  assert.deepEqual(result.timeSignature, [3, 4]);
  assert.match(result.warnings.join(''), /不同的速度/);
  assert.match(result.warnings.join(''), /不同的拍号/);
});

test('sustain pedal is warned about without extending key-down duration', () => {
  const result = parseMidi(midi([track(event(0, 0xb0, 64, 127), ...note(), event(480, 0xb0, 64, 0))]));
  assert.equal(result.tracks[0].notes[0].duration, 1);
  assert.match(result.warnings.join(''), /延音踏板/);
});

test('orphan, unfinished, and zero-duration notes are dropped and counted', () => {
  const result = parseMidi(midi([track(...note(), event(0, 0x80, 70, 0), event(0, 0x90, 71, 90), event(0, 72, 90), event(0, 0x80, 72, 0))]));
  assert.equal(result.tracks[0].notes.length, 1);
  assert.match(result.warnings.join(''), /1 个没有对应起音/);
  assert.match(result.warnings.join(''), /1 个缺少结束事件/);
  assert.match(result.warnings.join(''), /1 个时值为零/);
});

test('sysex and unknown chunks are safely skipped while extended headers are accepted', () => {
  const data = midi([chunk('TEST', [1, 2, 3]), track(event(0, 0xf0, 3, 1, 2, 0xf7), event(0, 0xf7, 2, 128, 255), ...note())], { declaredTracks: 1, format: 0, headerExtra: [0, 0] });
  const result = parseMidi(data);
  assert.equal(result.tracks[0].notes.length, 1);
  assert.match(result.warnings.join(''), /扩展数据块/);
});

test('supports one-byte channel events and does not mistake them for notes', () => {
  const result = parseMidi(midi([track(event(0, 0xc0, 3), event(0, 10), event(0, 0xd0, 80), event(0, 0xe0, 0, 64), event(0, 0xa0, 60, 80), ...note())]));
  assert.equal(result.tracks[0].program, 10);
  assert.equal(result.tracks[0].notes.length, 1);
});

test('reports changes after the first used program', () => {
  const result = parseMidi(midi([track(event(0, 0xc0, 5), ...note(), event(0, 0xc0, 10), ...note())]));
  assert.equal(result.tracks[0].program, 5);
  assert.match(result.warnings.join(''), /音色变化/);
});

test('percussion-only import is explicit and empty note files are rejected', () => {
  const result = parseMidi(midi([track(...note(9, 38))]));
  assert.equal(result.tracks[0].isPercussion, true);
  assert.match(result.warnings.join(''), /只包含打击乐/);
  assert.throws(() => parseMidi(midi([track()])), /没有可读取的完整音符/);
});

test('respects Uint8Array view boundaries', () => {
  const data = midi([track(...note())]);
  const wrapped = new Uint8Array(data.length + 9);
  wrapped.set(data, 5);
  assert.equal(parseMidi(wrapped.subarray(5, 5 + data.length)).tracks[0].notes[0].midi, 60);
});

test('rejects unsupported formats, SMPTE, zero PPQ, and invalid track counts', () => {
  assert.throws(() => parseMidi(midi([track(...note())], { format: 2 })), /格式 2/);
  assert.throws(() => parseMidi(midi([track(...note())], { format: 3 })), /格式编号/);
  assert.throws(() => parseMidi(midi([track(...note())], { division: 0xe728 })), /SMPTE/);
  assert.throws(() => parseMidi(midi([track(...note())], { division: 0 })), /PPQ/);
  assert.throws(() => parseMidi(midi([], { declaredTracks: 0 })), /1–256/);
  assert.throws(() => parseMidi(midi([], { declaredTracks: 257, format: 1 })), /1–256/);
  assert.throws(() => parseMidi(midi([track(...note()), track(...note())], { format: 0 })), /格式 0/);
});

test('rejects truncated chunks, missing tracks, and undeclared extra tracks', () => {
  const data = midi([track(...note())]);
  assert.throws(() => parseMidi(data.subarray(0, data.length - 1)), /截断/);
  assert.throws(() => parseMidi(midi([track(...note())], { format: 1, declaredTracks: 2 })), /音轨数量不足/);
  assert.throws(() => parseMidi(midi([track(...note()), track(...note())], { format: 1, declaredTracks: 1 })), /超过文件头声明/);
  assert.throws(() => parseMidi(Uint8Array.from([...data, 0, 1])), /截断/);
});

test('rejects malformed VLQs, channel data, and running status after system events', () => {
  assert.throws(() => parseMidi(midi([track([0x81, 0x80, 0x80, 0x80, 0x00, 0x90, 60, 100])])), /4 字节/);
  assert.throws(() => parseMidi(midi([track(event(0, 60, 100))])), /状态字节/);
  assert.throws(() => parseMidi(midi([track(event(0, 0x90, 60, 128))])), /数据字节/);
  assert.throws(() => parseMidi(midi([track(event(0, 0x90, 60, 100), event(0, 0xff, 1, 0), event(480, 60, 0))])), /状态字节/);
  assert.throws(() => parseMidi(midi([track(event(0, 0x90, 60, 100), event(0, 0xf0, 0), event(480, 60, 0))])), /状态字节/);
});

test('rejects incomplete events and malformed metadata instead of guessing', () => {
  assert.throws(() => parseMidi(midi([chunk('MTrk', event(0, 0x90, 60))])), /截断/);
  assert.throws(() => parseMidi(midi([chunk('MTrk', event(0, 0xf0, 5, 1, 2))])), /截断/);
  assert.throws(() => parseMidi(midi([track(event(0, 255, 81, 2, 1, 2))])), /速度事件必须/);
  assert.throws(() => parseMidi(midi([track(tempo(0, 0))])), /不能为零/);
  assert.throws(() => parseMidi(midi([track(meter(0, 0, 2))])), /拍号无效/);
  assert.throws(() => parseMidi(midi([track(meter(0, 4, 8))])), /分母超过/);
});

test('requires an end-of-track marker at the actual end of each track', () => {
  assert.throws(() => parseMidi(midi([chunk('MTrk', note().flat())])), /缺少结束标记/);
  assert.throws(() => parseMidi(midi([chunk('MTrk', [...end, ...event(0, 0x90, 60, 100)])])), /结束标记后/);
  assert.throws(() => parseMidi(midi([chunk('MTrk', event(0, 255, 47, 1, 0))])), /长度必须为零/);
});

test('enforces file, note, and split-track resource limits', () => {
  assert.throws(() => parseMidi(new Uint8Array(5 * 1024 * 1024 + 1)), /5 MiB/);
  const tooManyNotes = Array.from({ length: 10001 }, () => event(0, 0x90, 60, 100)).flat();
  assert.throws(() => parseMidi(midi([track(tooManyNotes)])), /10,000/);
  const allChannels = Array.from({ length: 16 }, (_, channel) => note(channel)).flat();
  assert.throws(() => parseMidi(midi(Array.from({ length: 17 }, () => track(...allChannels)))), /拆分后超过 256/);
});
