const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compile, normalize } = require('../score/document.js');
const { render, paginate } = require('../score/renderer.js');

const original = JSON.parse(fs.readFileSync(path.join(__dirname, '../scores/heixiu-rhapsody.json'), 'utf8'));

// Independently transcribed from the supplied photograph, not from the parser's
// notation or compiled output. Each bar has [upper, lower]; each event has
// [duration in sixteenths, ...absolute MIDI pitches]. An empty pitch list is a
// rest. The 12 multi-pitch events are the photograph's rising glissandi.
const expectedBars = [
  [[[2,60],[2,67],[2,76],[8,79],[2]],[[4],[4],[4],[4]]], // 1
  [[[2,60],[2,65],[2,69],[8,72],[2]],[[4],[4],[4],[4]]], // 2
  [[[2,60],[2,67],[2,76],[8,72],[2]],[[4],[4],[4],[4]]], // 3
  [[[2,65],[2,69],[2,72],[8,74],[2]],[[4],[4],[4],[4]]], // 4
  [[[2,76],[2,67],[2,76],[8,79],[2]],[[16,60]]], // 5
  [[[2,69],[2,65],[2,69],[8,72],[2]],[[16,60]]], // 6
  [[[2,72],[2,69],[2,72],[6,76],[2,72],[2]],[[16,60]]], // 7
  [[[2,71],[2,67],[2,71],[8,74],[2]],[[16,62]]], // 8
  [[[2,76],[2,67],[2,76],[8,79],[2]],[[16,60]]], // 9
  [[[2,69],[2,65],[2,69],[8,72],[2]],[[16,60]]], // 10
  [[[2,76],[2,67],[2,76],[8,72],[2]],[[16,60]]], // 11
  [[[2,69],[2,65],[2,72],[8,74],[2]],[[16,60]]], // 12
  [[[8,76],[8,79]],[[2,60],[2,64],[2,76],[2,79],[2],[2,67],[2,71],[2,74]]], // 13
  [[[16,84]],[[2],[2,65],[2,69],[6,72],[4,74]]], // 14
  [[[8,76],[8,79]],[[2,60],[2,67],[2,76],[2,79],[2,67],[2,71],[4,74]]], // 15
  [[[16,77]],[[2,60],[2,65],[2,69],[6,72],[4,71]]], // 16
  [[[8,76],[8,79]],[[2,60],[2,67],[2,76],[2,79],[2,67],[2,71],[4,74]]], // 17
  [[[16,84]],[[2,60],[2,67],[4,72],[4,77],[4,81]]], // 18
  [[[8,79],[8,77]],[[2,60],[2,67],[2,76],[2,72],[2],[2,65],[4,69]]], // 19
  [[[4,72],[4],[4],[4]],[[2],[2,60],[2,64],[8,67],[2]]], // 20
  [[[4,76],[3,76],[1,72],[4,74],[3,74],[1,71]],[[4,60,64,67],[4],[4,67,71],[4]]], // 21
  [[[4,72],[2,72],[2,74],[2],[2,67],[4,67]],[[4,60,64],[4],[4],[4]]], // 22
  [[[4,76],[3,76],[1,72],[4,74],[3,74],[1,71]],[[4,60,64,67],[4],[4,67,71],[4]]], // 23
  [[[4,72],[2,72],[2,74],[2],[2,67],[2,72],[2,74]],[[4,60,64],[4],[4],[4]]], // 24
  [[[4,76],[3,76],[1,72],[4,74],[3,74],[1,71]],[[4,60,64,67],[4],[4,67,71],[4]]], // 25
  [[[4,72],[2,72],[2,71],[2],[2,67],[4,67]],[[4,60,64],[4],[4],[4]]], // 26
  [[[4,76],[3,76],[1,72],[4,74],[3,74],[1,71]],[[4,60,64,67],[4],[4,67,71],[4]]], // 27
  [[[4,72],[2,71],[2,72],[2],[2,67],[2,72],[2,74]],[[4,60,64],[4],[4],[4]]], // 28
  [[[4,72],[4],[4],[4]],[[4,60],[4],[4],[4]]], // 29
];
const writtenOrder = Array.from({ length: 29 }, (_, i) => i);
const performanceOrder = [...writtenOrder.slice(0, 20), ...writtenOrder.slice(12, 20), ...writtenOrder.slice(20)];
const sorted = notes => notes.slice().sort((a, b) => a.voiceIndex - b.voiceIndex || a.start - b.start || a.midi - b.midi || a.duration - b.duration);
const fields = note => ({ voiceIndex: note.voiceIndex, midi: note.midi, start: note.start, duration: note.duration });
function expectedNotes(order = writtenOrder, played = false) {
  const notes = [];
  for (const [performanceBar, sourceBar] of order.entries()) {
    expectedBars[sourceBar].forEach((events, voiceIndex) => {
      let beat = 0;
      for (const [ticks, ...pitches] of events) {
        pitches.forEach((midi, index) => {
          // The published rendition specifies 35 ms between rising attacks at
          // 100 BPM. Sustain ends at the written boundary for every chord tone.
          const delay = played && pitches.length > 1 ? index * 0.035 * 100 / 60 : 0;
          notes.push({ voiceIndex, midi, start: performanceBar * 4 + beat + delay, duration: ticks / 4 - delay });
        });
        beat += ticks / 4;
      }
      assert.equal(beat, 4, `independent transcription: bar ${sourceBar + 1}, voice ${voiceIndex + 1}`);
    });
  }
  return sorted(notes);
}
function basic(notation = '1:4', extras = {}) {
  return { format: 'paijian-score', version: 1, title: '测试曲谱', bpm: 100, meter: [4, 4], instrument: '17C', voices: [{ name: '旋律', notation }], repeats: [], credits: [], ...extras };
}
function options(result) {
  return { title: result.document.title, bpm: result.document.bpm, credits: result.document.credits };
}
function noteGroups(svg) {
  return [...svg.matchAll(/<g class="note-group[^\"]*"([^>]*)>([\s\S]*?)<\/g>/g)].map(match => {
    const label = match[2].match(/<text x="([\d.]+)" y="([\d.]+)" class="note-number"[^>]*>([^<]*)<\/text>/);
    return { sourceId: match[1].match(/data-source-id="([^"]*)"/)[1], x: Number(label[1]), y: Number(label[2]), degree: label[3], body: match[2] };
  });
}
function assertNearly(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

test('the complete 29-bar transcription matches every photographed pitch, onset, duration, rest and voice', () => {
  const result = compile(original), { score } = result;
  assert.equal(result.document.title, '嘿咻狂想曲');
  assert.equal(result.document.bpm, 100);
  assert.deepEqual(result.document.meter, [4, 4]);
  assert.equal(score.bars.length, 29);
  assert.equal(score.totalBeats, 116);
  assert.equal(score.notes.length, 189);
  assert.deepEqual(sorted(score.notes.map(fields)), expectedNotes());
  assert.deepEqual([0, 1].map(v => score.notes.filter(n => n.voiceIndex === v).length), [108, 81]);
  for (const [barIndex, bar] of score.bars.entries()) {
    assert.equal(bar.start, barIndex * 4);
    assert.equal(bar.duration, 4);
    for (const [voiceIndex, lane] of bar.voices.entries()) {
      assert.equal(lane.index, voiceIndex);
      let end = bar.start;
      for (const token of lane.tokens) {
        assert.equal(token.start, end, `bar ${barIndex + 1}, voice ${voiceIndex + 1} must have no gap or overlap`);
        end += token.duration;
      }
      assert.equal(end, bar.start + 4);
      assert.deepEqual(lane.tokens.map(token => [token.duration * 4, ...(token.midi === null ? [] : (token.pitches || [token]).map(p => p.midi).sort((a, b) => a - b))]), expectedBars[barIndex][voiceIndex]);
    }
  }
  assert.deepEqual(score.stats, { inputNotes: 189, outputNotes: 189, unplayable: 0, voiceCount: 2, maxPolyphony: 4, quantized: 0, removedPolyphony: 0, clippedOverlaps: 0 });
  assert.deepEqual(result.warnings, []);
});

test('bars 13–20 repeat exactly once, yielding all 245 notes in 37 bars and 88.8 seconds', () => {
  const result = compile(original);
  assert.deepEqual(result.score.playbackBarMap, performanceOrder);
  assert.equal(result.score.playbackBarMap.length, 37);
  assert.equal(result.totalBeats, 148);
  assert.equal(result.totalBeats * 60 / result.document.bpm, 88.8);
  assert.equal(result.playbackNotes.length, 245);
  const actual = sorted(result.playbackNotes.map(fields));
  const expected = expectedNotes(performanceOrder, true);
  assert.equal(actual.length, expected.length);
  actual.forEach((note, i) => {
    assert.equal(note.midi, expected[i].midi, `performance note ${i}: pitch`);
    assert.equal(note.voiceIndex, expected[i].voiceIndex, `performance note ${i}: voice`);
    assertNearly(note.start, expected[i].start, `performance note ${i}: onset`);
    assertNearly(note.duration, expected[i].duration, `performance note ${i}: duration`);
  });
});

test('all 12 glissandi keep every written chord tone and rise in pitch during playback', () => {
  const result = compile(original);
  const groups = new Map();
  for (const note of result.score.notes) if (note.glissandoGroup) {
    if (!groups.has(note.glissandoGroup)) groups.set(note.glissandoGroup, []);
    groups.get(note.glissandoGroup).push(note);
  }
  assert.equal(groups.size, 12);
  assert.deepEqual([...groups.values()].map(notes => notes.length), [3, 2, 2, 3, 2, 2, 3, 2, 2, 3, 2, 2]);
  for (const [id, written] of groups) {
    assert.equal(new Set(written.map(n => n.start)).size, 1, 'notation is simultaneous');
    const played = result.playbackNotes.filter(n => n.glissandoGroup === id).sort((a, b) => a.start - b.start);
    assert.deepEqual(played.map(n => n.midi), written.map(n => n.midi).sort((a, b) => a - b));
    assert.equal(played[0].start, written[0].start + 32, 'the repeated passage precedes these glissandi');
    for (let i = 0; i < played.length; i++) {
      assert.ok(played[i].duration > 0);
      assertNearly(played[i].start + played[i].duration, written[0].start + 33, 'all glissando tones retain their written release');
      if (i) assert.ok(played[i].start > played[i - 1].start && played[i].midi > played[i - 1].midi);
    }
  }
});

test('SVG pagination exports every note, all chord stacks, 12 glissandi and both repeat boundaries', () => {
  const result = compile(original);
  const renderOptions = options(result);
  const pages = paginate(result.score, renderOptions);
  assert.ok(pages.length > 1);
  assert.deepEqual(pages.flatMap(page => page.bars.map(bar => bar.index)), writtenOrder);
  const svgs = pages.map(page => render(page, renderOptions));
  const svg = svgs.join('\n');
  assert.equal((svg.match(/class="glissando"/g) || []).length, 12);
  assert.equal((svg.match(/class="repeat-start"/g) || []).length, 1);
  assert.equal((svg.match(/class="repeat-end"/g) || []).length, 1);
  assert.equal((svg.match(/final-barline/g) || []).length, 1);
  assert.deepEqual(result.score.bars.filter(b => b.repeatStart).map(b => b.index + 1), [13]);
  assert.deepEqual(result.score.bars.filter(b => b.repeatEnd).map(b => [b.index + 1, b.repeatEnd]), [[20, 2]]);
  const renderedNotes = noteGroups(svg).filter(group => group.sourceId);
  assert.equal(renderedNotes.length, 189);
  assert.deepEqual(new Set(renderedNotes.map(group => group.sourceId)), new Set(result.score.notes.map(note => note.sourceId)));
  for (const note of result.score.notes) {
    const group = renderedNotes.find(group => group.sourceId === note.sourceId);
    assert.equal(group.degree, String(note.degree));
    const dotCount = (group.body.match(/<circle class="note-dot"/g) || []).length;
    assert.equal(dotCount, Math.abs(note.octave) + ([0.75, 1.5].includes(note.duration) ? 1 : 0));
  }
  for (const token of result.score.bars.flatMap(bar => bar.tokens).filter(t => t.pitches)) {
    const stack = token.pitches.map(pitch => renderedNotes.find(group => group.sourceId === pitch.sourceId));
    assert.equal(new Set(stack.map(note => note.x)).size, 1, 'chord tones occupy one rhythmic column');
    assert.deepEqual(stack.map(note => Number(note.degree)), token.pitches.map(pitch => Number(pitch.degree)));
    for (let i = 1; i < stack.length; i++) assert.ok(stack[i].y >= stack[i - 1].y + 40, 'all chord tones have distinct visible vertical positions');
  }
  for (const page of svgs) {
    assert.match(page, /♩ = 100/);
    for (const credit of original.credits) assert.ok(page.includes(credit), 'every page keeps original attribution');
  }
});

test('compound note lengths conserve each chord pitch and draw a separate tie for every sustained tone', () => {
  const result = compile(basic('(1,3,5):1.25 0:2.75'));
  assert.equal(result.score.notes.length, 3);
  const lane = result.score.bars[0].voices[0];
  assert.equal(lane.tokens.reduce((sum, token) => sum + token.duration, 0), 4);
  for (const note of result.score.notes) {
    const pieces = lane.tokens.filter(token => token.pitches?.some(p => p.sourceId === note.sourceId));
    assert.equal(pieces.reduce((sum, token) => sum + token.duration, 0), 1.25);
    assert.equal(pieces[0].tieOut, true);
    assert.equal(pieces.at(-1).tieIn, true);
  }
  const svg = render(result.score, options(result));
  assert.equal(noteGroups(svg).filter(group => group.sourceId).length, 6);
  const ties = [...svg.matchAll(/<path class="tie"[^>]*d="M[\d.]+ ([\d.]+)/g)];
  assert.equal(ties.length, 3, 'each of the three repeated glyph pairs is a sustained tone, not a new attack');
  assert.equal(new Set(ties.map(match => match[1])).size, 3);
});

test('disjoint repeats retain normal bars and their explicit total play counts', () => {
  const result = compile(basic('1:4 | 2:4 | 3:4 | 4:4 | 5:4', { repeats: [{ startBar: 4, endBar: 4, times: 3 }, { startBar: 1, endBar: 2, times: 2 }] }));
  assert.deepEqual(result.score.playbackBarMap, [0, 1, 0, 1, 2, 3, 3, 3, 4]);
  assert.deepEqual(result.playbackNotes.map(n => n.midi), [60, 62, 60, 62, 64, 65, 65, 65, 67]);
  const svg = render(result.score, options(result));
  assert.equal((svg.match(/class="repeat-start"/g) || []).length, 2);
  assert.equal((svg.match(/class="repeat-end"/g) || []).length, 2);
  assert.match(svg, /共 3 次/);
});

test('invalid durations, incomplete bars and unequal voice lengths are rejected', () => {
  for (const notation of ['1:0 0:4', '1:-1 0:4', '1:0.1 0:3.9', '1:0.125 0:3.875', '1:5', '1:Infinity', '1:NaN', '1:1e0 0:3', '1:4.0001', '1:2', '1:4 | | 1:4']) {
    assert.throws(() => compile(basic(notation)), undefined, `reject ${notation}`);
  }
  assert.throws(() => compile(basic('1:4', { voices: [{ name: 'A', notation: '1:4 | 2:4' }, { name: 'B', notation: '0:4' }] })), /所有声部的小节数量必须相同/);
  assert.throws(() => compile(basic('1:4', { voices: [{ name: 'A', notation: '1:4' }, { name: 'B', notation: '0:3' }] })), /需要 4 拍/);
});

test('overlapping, nested, reversed, fractional and out-of-bounds repeats are rejected', () => {
  const notation = '1:4 | 2:4 | 3:4 | 4:4';
  for (const repeats of [
    [{ startBar: 1, endBar: 3, times: 2 }, { startBar: 3, endBar: 4, times: 2 }],
    [{ startBar: 1, endBar: 4, times: 2 }, { startBar: 2, endBar: 3, times: 2 }],
    [{ startBar: 3, endBar: 2, times: 2 }], [{ startBar: 0, endBar: 2, times: 2 }],
    [{ startBar: 1.5, endBar: 2, times: 2 }], [{ startBar: 1, endBar: 5, times: 2 }],
    [{ startBar: 1, endBar: 2, times: 1 }], [{ startBar: 1, endBar: 2, times: 2.5 }],
    [{ startBar: 1, endBar: 2, times: 9 }],
  ]) assert.throws(() => compile(basic(notation, { repeats })), undefined, JSON.stringify(repeats));
});

test('metadata remains text in complete SVG exports and normalized JSON round trips', () => {
  const title = '<script>alert("x")</script>&\'';
  const voiceName = '<svg/onload=x>';
  const credits = ['<image href="javascript:alert(1)"/> & "credit"', '</text><script>evil()</script>'];
  const document = basic('1:4', { title, voices: [{ name: voiceName, notation: '1:4' }], credits, description: '<img onerror=evil()>' });
  const result = compile(document);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(result.document))), result.document);
  const svg = render(result.score, { ...options(result), subtitle: '</text><foreignObject>bad</foreignObject>' });
  assert.equal(/<(?:script|image|img|foreignObject)\b/.test(svg), false);
  assert.equal(svg.includes('<svg/onload='), false);
  assert.ok(svg.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&apos;'));
  assert.ok(svg.includes('&lt;svg/onload=x&gt;'));
  assert.ok(svg.includes('&lt;image href=&quot;javascript:alert(1)&quot;/&gt; &amp; &quot;credit&quot;'));
  assert.ok(svg.includes('&lt;/text&gt;&lt;script&gt;evil()&lt;/script&gt;'));
  assert.ok(svg.includes('&lt;foreignObject&gt;bad&lt;/foreignObject&gt;'));
});

test('invalid chord and pitch syntax is rejected without silently dropping tones', () => {
  for (const notation of ['(1,1):4', '(1):4', '~(1):4', '(1,):4', '(1,3,5,7,1\',3\',5\',7\',1\'\'):4', '8:4', '1\'\'\':4', '(1,BAD):4']) {
    assert.throws(() => compile(basic(notation)), undefined, `reject ${notation}`);
  }
});
