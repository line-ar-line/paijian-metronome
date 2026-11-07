const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScore } = require('../score/score-model.js');
const { render, paginate } = require('../score/renderer.js');

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

test('paginates a 305-bar full score without losing or duplicating bars or token IDs', () => {
  const score = buildScore(Array.from({ length: 305 }, (_, index) => n(60, index * 4, 1)));
  const originalBars = score.bars.slice();
  const expectedTokens = score.bars.flatMap(bar => bar.tokens.map(token => token.id));
  const pages = paginate(score);
  assert.equal(pages.length, 10);
  assert.equal(pages[0].bars.length, 32);
  assert.deepEqual(pages.flatMap(page => page.bars.map(bar => bar.index)), Array.from({ length: 305 }, (_, index) => index));
  assert.deepEqual(pages.flatMap(page => page.bars.flatMap(bar => bar.tokens.map(token => token.id))), expectedTokens);
  assert.equal(pages.at(-1).bars.at(-1).index, 304);
  assert.deepEqual(score.bars, originalBars);
  for (const [index, page] of pages.entries()) {
    assert.equal(page.pageNumber, index + 1);
    assert.equal(page.pageCount, pages.length);
    assert.equal(page.totalBarCount, 305);
    assert.equal(page.stats, score.stats);
    assert.equal(page.notes, score.notes);
    assert.equal(page.totalBeats, score.totalBeats);
    assert.ok(size(render(page)).height <= 1380);
  }
});

test('each printed page identifies its full-piece context and only the last page has an ending barline', () => {
  const score = buildScore([n(60)], { totalBeats: 300 });
  const pages = paginate(score);
  const first = render(pages[0]);
  const last = render(pages.at(-1));
  assert.match(first, /第 1\/3 页 · 第 1–32 小节/);
  assert.match(first, /全曲 75 小节/);
  assert.equal((first.match(/final-barline/g) || []).length, 0);
  assert.equal((last.match(/final-barline/g) || []).length, 1);
  assert.match(last, /第 3\/3 页 · 第 65–75 小节/);
  assert.match(first, /aria-labelledby="score-title-1 score-description-1"/);
  assert.match(last, /aria-labelledby="score-title-3 score-description-3"/);
});

test('pagination respects long titles and subtitles at a custom printable height', () => {
  const score = buildScore([n(60)], { totalBeats: 400 });
  const options = { title: '春'.repeat(80), subtitle: '完整乐曲的演奏说明'.repeat(16) };
  const pages = paginate(score, options, 900);
  assert.ok(pages.length > 3);
  for (const page of pages) {
    const svg = render(page, options);
    assert.ok(size(svg).height <= 900);
    assert.match(svg, /第 \d+\/\d+ 页/);
    const lines = [...svg.matchAll(/class="score-heading"[^>]*>([^<]*)<\/text>/g)].map(match => match[1]);
    assert.equal(lines.join(''), options.title);
  }
  assert.equal(pages.flatMap(page => page.bars).length, 100);
});

test('dense measures use fewer bars per page while preserving all subdivisions', () => {
  const score = buildScore(Array.from({ length: 16 * 40 }, (_, index) => n(60, index * 0.25, 0.25)));
  const pages = paginate(score);
  assert.ok(pages.length >= 5);
  assert.ok(pages.every(page => page.bars.length <= 8));
  assert.equal(pages.flatMap(page => page.bars).length, 40);
  assert.equal(pages.flatMap(page => page.bars.flatMap(bar => bar.tokens)).length, 640);
  for (const page of pages) assert.ok(size(render(page)).height <= 1380);
});

test('ties continue across page boundaries without turning a page end into a piece end', () => {
  const score = buildScore([n(60, 0, 140)]);
  const pages = paginate(score);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].bars.at(-1).tokens.at(-1).tieOut, true);
  assert.equal(pages[1].bars[0].tokens[0].tieIn, true);
  const firstSvg = render(pages[0]);
  const lastSvg = render(pages[1]);
  assert.match(firstSvg, /class="tie"/);
  assert.match(lastSvg, /class="tie" d="M52 /);
  assert.equal(firstSvg.includes('final-barline'), false);
  assert.equal((lastSvg.match(/final-barline/g) || []).length, 1);
  assert.equal(pages.flatMap(page => page.bars.flatMap(bar => bar.tokens)).filter(token => token.midi !== null).reduce((sum, token) => sum + token.duration, 0), 140);
});

test('empty input has no pages and impossibly small pages keep every measure', () => {
  assert.deepEqual(paginate(buildScore([])), []);
  const score = buildScore([n(60)], { totalBeats: 12 });
  const pages = paginate(score, {}, 100);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.flatMap(page => page.bars.map(bar => bar.index)), [0, 1, 2]);
  assert.ok(pages.every(page => page.bars.length === 1));
  assert.throws(() => paginate(score, {}, Infinity));
  assert.throws(() => paginate(score, {}, 0));
});

test('explicit page options override metadata while retaining genuine piece-end detection', () => {
  const score = buildScore([n(60)], { totalBeats: 40 });
  const firstTwo = { ...score, bars: score.bars.slice(0, 2) };
  const svg = render(firstTwo, { pageNumber: 2, pageCount: 5, totalBars: 10 });
  assert.match(svg, /第 2\/5 页 · 第 1–2 小节/);
  assert.match(svg, /全曲 10 小节/);
  assert.equal(svg.includes('final-barline'), false);
});
