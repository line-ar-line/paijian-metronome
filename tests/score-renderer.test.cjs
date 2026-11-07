const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScore } = require('../score/score-model.js');
const { render } = require('../score/renderer.js');

const n = (midi, start = 0, duration = 1) => ({ midi, start, duration });
const numberLabels = svg => [...svg.matchAll(/<text[^>]*class="note-number"[^>]*>([^<]*)<\/text>/g)].map(match => match[1]);
const size = svg => {
  const match = svg.match(/<svg[^>]* width="(\d+)" height="(\d+)"/);
  return { width: Number(match[1]), height: Number(match[2]) };
};

test('whole and half rests use repeated zeroes without note extension dashes', () => {
  const svg = render(buildScore([n(60, 6, 1)]));
  assert.deepEqual(numberLabels(svg), ['0', '0', '0', '0', '0', '0', '1', '0']);
  assert.equal(svg.includes('>−</text>'), false);
  const heldNote = render(buildScore([n(60, 0, 4)]));
  assert.equal((heldNote.match(/>−<\/text>/g) || []).length, 3);
});

test('dotted and subdivided notes retain rhythm symbols and source grouping', () => {
  const svg = render(buildScore([n(60, 0, 0.75), n(62, 0.75, 0.25), n(64, 1, 1.5)]));
  assert.equal((svg.match(/class="note-line"/g) || []).length, 3);
  assert.equal((svg.match(/<circle class="note-dot"/g) || []).length, 3); // includes dotted final rest.
  assert.match(svg, /data-source-id="n0"/);
  assert.match(svg, /data-source-id="n1"/);
  assert.match(svg, /data-source-id="n2"/);
});

test('long Unicode titles wrap without dropping text and shift the score below the header', () => {
  const title = '春天的卡林巴练习曲'.repeat(8);
  const score = buildScore([n(60)], { title });
  const svg = render(score);
  const headings = [...svg.matchAll(/<text[^>]*class="score-heading"[^>]*>([^<]*)<\/text>/g)];
  assert.equal(headings.map(match => match[1]).join(''), title);
  assert.ok(headings.every(match => Array.from(match[1]).length <= 32));
  assert.equal(headings.length, 3);
  assert.ok(size(svg).height > size(render(score, { title: '短曲名' })).height);
  const ys = headings.map(match => Number(match[0].match(/ y="([\d.]+)"/)[1]));
  const firstNoteY = Number(svg.match(/<text[^>]* y="([\d.]+)"[^>]*class="note-number"/)[1]);
  assert.ok(firstNoteY > Math.max(...ys) + 80);
});

test('title truncation respects Unicode code points rather than splitting surrogate pairs', () => {
  const title = '🎵'.repeat(80);
  const svg = render(buildScore([n(60)]), { title });
  const lines = [...svg.matchAll(/class="score-heading"[^>]*>([^<]*)<\/text>/g)].map(match => match[1]);
  assert.equal(lines.join(''), title);
  assert.equal(lines.length, 3);
  assert.equal(svg.includes('\uFFFD'), false);
});

test('dense measures grow the SVG and minimum CSS width instead of compressing symbols', () => {
  const notes = Array.from({ length: 96 }, (_, index) => n(60, index * 0.25, 0.25));
  const svg = render(buildScore(notes, { meter: [12, 2] }));
  const dimensions = size(svg);
  assert.ok(dimensions.width > 1040);
  assert.match(svg, new RegExp(`style="min-width:${dimensions.width}px"`));
  const xs = [...svg.matchAll(/<text x="([\d.]+)"[^>]*class="note-number"/g)].map(match => Number(match[1]));
  assert.equal(xs.length, 96);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 30, 'note centers preserve readable spacing');
  const ordinary = render(buildScore([n(60)]));
  assert.equal(size(ordinary).width, 1040);
  assert.equal(ordinary.includes('style="min-width:'), false);
});

test('renders model instrument and meter, and escapes metadata and note attributes', () => {
  const score = buildScore([n(53)], { instrument: '21C', meter: [3, 4] });
  score.bars[0].tokens[0].sourceId = '\" onload=\"alert(1)';
  const svg = render(score, { title: '<script>alert("x")</script>&', subtitle: '<img src=x onerror=alert(1)>' });
  assert.match(svg, /21 音 C 调/);
  assert.match(svg, /3\/4/);
  assert.equal(svg.includes('<script>'), false);
  assert.equal(svg.includes('<img '), false);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /data-source-id="&quot; onload=&quot;alert\(1\)"/);
});

test('adjacent tied pieces use one continuous arc while repeated notes do not tie', () => {
  const sustained = render(buildScore([n(60, 0, 1.25)]));
  assert.equal((sustained.match(/class="tie"/g) || []).length, 1);
  const repeated = render(buildScore([n(60, 0, 1), n(60, 1, 1)]));
  assert.equal((repeated.match(/class="tie"/g) || []).length, 0);
});
