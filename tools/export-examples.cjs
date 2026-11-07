// Regenerate the downloadable MIDI examples from the same musical source as the UI.
const fs = require('node:fs');
const path = require('node:path');
require('../score/examples.js');
const ppq = 480;
function vlq(value) {
  const bytes = [value & 0x7f];
  while ((value = Math.floor(value / 128)) > 0) bytes.unshift((value & 0x7f) | 0x80);
  return bytes;
}
function chunk(name, data) {
  const head = Buffer.alloc(8); head.write(name, 0, 'ascii'); head.writeUInt32BE(data.length, 4);
  return Buffer.concat([head, Buffer.from(data)]);
}
const destination = path.resolve(__dirname, '../examples');
fs.mkdirSync(destination, { recursive: true });
for (const example of globalThis.ScoreExamples) {
  const name = Buffer.from(example.title, 'utf8');
  const tempo = Math.round(60000000 / example.bpm);
  const bytes = [0, 0xff, 3, ...vlq(name.length), ...name, 0, 0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255, 0, 0xff, 0x58, 4, example.meter[0], Math.log2(example.meter[1]), 24, 8, 0, 0xc0, 108];
  // Merge attacks and releases chronologically so independent voices retain
  // their own durations. Releases precede reattacks on the same tick.
  const events = example.notes.flatMap(note => [
    { tick: Math.round(note.start * ppq), status: 0x90, midi: note.midi, velocity: Math.round(note.velocity * 127) },
    { tick: Math.round((note.start + note.duration) * ppq), status: 0x80, midi: note.midi, velocity: 0 },
  ]).sort((a, b) => a.tick - b.tick || a.status - b.status || a.midi - b.midi);
  let cursor = 0;
  for (const event of events) {
    bytes.push(...vlq(event.tick - cursor), event.status, event.midi, event.velocity);
    cursor = event.tick;
  }
  bytes.push(0, 0xff, 0x2f, 0);
  const header = chunk('MThd', [0, 0, 0, 1, ppq >> 8, ppq & 255]);
  fs.writeFileSync(path.join(destination, `${example.id}.mid`), Buffer.concat([header, chunk('MTrk', bytes)]));
  console.log(`Generated examples/${example.id}.mid`);
}
