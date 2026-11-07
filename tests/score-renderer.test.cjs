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
  assert.match(lastSvg, /class="tie"[^>]* d="M52 /);
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

function sourcePosition(svg, sourceId) {
  const group = svg.match(new RegExp(`<g class="note-group[^\"]*"[^>]*data-source-id="${sourceId}"[^>]*>([\\s\\S]*?)<\\/g>`));
  assert.ok(group, `source ${sourceId} is present`);
  const number = group[1].match(/<text x="([\d.]+)" y="([\d.]+)" class="note-number"/);
  return { x: Number(number[1]), y: Number(number[2]) };
}

test('simultaneous unequal-duration notes align in time across separate voice lanes', () => {
  const score = buildScore([n(72, 0, 0.5), n(60, 0, 4), n(74, 0.5, 0.5), n(76, 1, 1)], { mode: 'polyphonic' });
  const svg = render(score);
  const high = sourcePosition(svg, 'n0');
  const bass = sourcePosition(svg, 'n1');
  const next = sourcePosition(svg, 'n2');
  const third = sourcePosition(svg, 'n3');
  assert.equal(high.x, bass.x);
  assert.ok(bass.y - high.y >= 70);
  assert.equal(high.y, next.y);
  assert.ok(Math.abs((third.x - high.x) - 2 * (next.x - high.x)) < 1e-8);
  assert.match(svg, /data-voice-index="0"/);
  assert.match(svg, /data-voice-index="1"/);
  assert.match(svg, /声部为排版分组/);
  assert.match(svg, /声部 1/);
  assert.match(svg, /声部 2/);
});

test('polyphonic single-voice material keeps the established compact layout', () => {
  const notes = [n(60, 0, 1), n(62, 1, 1), n(64, 2, 2)];
  const melody = render(buildScore(notes));
  const polyphonic = render(buildScore(notes, { mode: 'polyphonic' }));
  assert.deepEqual(size(polyphonic), size(melody));
  assert.deepEqual(numberLabels(polyphonic), numberLabels(melody));
  assert.equal(polyphonic.includes('voice-label'), false);
});

test('polyphonic pagination accounts for voice heights and preserves all note sources and ties', () => {
  const notes = [n(48, 0, 160), ...Array.from({ length: 160 }, (_, index) => n(72 + index % 2 * 2, index, 1))];
  const score = buildScore(notes, { mode: 'polyphonic', instrument: '21C' });
  const pages = paginate(score);
  assert.ok(pages.length > 2);
  assert.deepEqual(pages.flatMap(page => page.bars.map(bar => bar.index)), score.bars.map(bar => bar.index));
  const sourceIds = new Set();
  let endings = 0;
  for (const page of pages) {
    const svg = render(page);
    assert.ok(size(svg).height <= 1380);
    for (const match of svg.matchAll(/data-source-id="(n\d+)"/g)) sourceIds.add(match[1]);
    endings += (svg.match(/final-barline/g) || []).length;
  }
  assert.equal(endings, 1);
  assert.deepEqual(sourceIds, new Set(score.notes.map(note => note.sourceId)));
  const bass = score.notes.find(note => note.midi === 48);
  assert.equal(score.bars.flatMap(bar => bar.tokens).filter(token => token.sourceId === bass.sourceId).reduce((sum, token) => sum + token.duration, 0), 160);
  assert.match(render(pages[1]), /class="tie"[^>]* d="M52 /);
});

test('inactive lanes receive aligned full-measure rests within the same system', () => {
  const score = buildScore([n(72, 0, 1), n(60, 0, 1), n(74, 4, 1)], { mode: 'polyphonic', totalBeats: 8 });
  const svg = render(score);
  assert.match(svg, /data-token-id="silent-1-1-0"/);
  assert.equal((svg.match(/class="voice-lane"/g) || []).length, 4);
  assert.equal(score.notes.length, 3);
});

function renderedCredits(svg) {
  const credits = new Map();
  for (const match of svg.matchAll(/<text[^>]*class="score-credit" data-credit-index="(\d+)"[^>]*>([^<]*)<\/text>/g)) {
    const index = Number(match[1]);
    credits.set(index, (credits.get(index) || '') + match[2]);
  }
  return credits;
}

test('credits preserve complete long attribution and URLs on every exported page', () => {
  const credits = [
    '作曲与编谱署名：' + '完整保留编谱者和贡献者姓名'.repeat(24),
    'Mutopia source: https://www.mutopiaproject.org/' + 'long-original-source-path/'.repeat(14) + '?id=528',
    'License: CC BY 4.0 https://creativecommons.org/licenses/by/4.0/',
    '拍间数字谱：十六分音符节奏量化，整体移调 +2 半音，多音改编保留独立延音。',
  ];
  const score = buildScore([n(60)], { totalBeats: 1200 });
  const pages = paginate(score, { credits });
  const noCreditPages = paginate(score);
  assert.ok(pages.length > noCreditPages.length);
  assert.deepEqual(pages.flatMap(page => page.bars.map(bar => bar.index)), score.bars.map(bar => bar.index));
  let endings = 0;
  for (const page of pages) {
    const svg = render(page); // The page retains its export attribution.
    assert.ok(size(svg).height <= 1380);
    assert.deepEqual([...renderedCredits(svg).values()], credits);
    endings += (svg.match(/final-barline/g) || []).length;
    const lines = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" class="score-credit"[^>]*>([^<]*)<\/text>/g)];
    for (let i = 1; i < lines.length; i++) assert.equal(Number(lines[i][2]) - Number(lines[i - 1][2]), 14);
    assert.ok(Number(lines.at(-1)[2]) < size(svg).height - 20);
    assert.ok(lines.every(line => Array.from(line[3]).length <= 91));
  }
  assert.equal(endings, 1);
});

test('empty credits keep previous page geometry and credits are XML-escaped', () => {
  const score = buildScore([n(60)]);
  assert.deepEqual(size(render(score)), size(render(score, { credits: [] })));
  assert.deepEqual(size(render(score)), size(render(score, { credits: [''] })));
  const svg = render(score, { credits: ['Creator <script> & "Name"', 'License: https://example.com/?x=1&y=2'] });
  assert.equal(svg.includes('<script>'), false);
  assert.match(svg, /Creator &lt;script&gt; &amp; &quot;Name&quot;/);
  assert.match(svg, /x=1&amp;y=2/);
  assert.throws(() => render(score, { credits: 'incorrect type' }), /字符串数组/);
  assert.throws(() => paginate(score, { credits: [null] }), /字符串数组/);
});

test('credits wrap explicit newlines and preserve Unicode characters without slicing attribution', () => {
  const first = '🎵'.repeat(180);
  const second = '署名保留完整文字。'.repeat(40);
  const score = buildScore([n(60)]);
  const svg = render(score, { credits: [`${first}\n${second}`] });
  assert.equal(renderedCredits(svg).get(0), first + second);
  assert.equal(svg.includes('\uFFFD'), false);
  const ys = [...svg.matchAll(/<text[^>]* y="([\d.]+)" class="score-credit"/g)].map(match => Number(match[1]));
  assert.ok(ys.length > 4);
  assert.ok(ys.at(-1) < size(svg).height - 20);
});

test('polyphonic page sizing includes full credits without losing source notes', () => {
  const notes = [n(48, 0, 100), ...Array.from({ length: 100 }, (_, index) => n(72 + index % 2 * 2, index, 1))];
  const score = buildScore(notes, { mode: 'polyphonic' });
  const credits = ['Source credit '.repeat(40), 'https://example.com/' + 'long-url-segment/'.repeat(20), 'CC BY 4.0', '拍间量化、移调、多声部数字谱'];
  const pages = paginate(score, { credits }, 1000);
  const sources = new Set();
  for (const page of pages) {
    const svg = render(page);
    assert.ok(size(svg).height <= 1000);
    assert.deepEqual([...renderedCredits(svg).values()], credits);
    for (const match of svg.matchAll(/data-source-id="(n\d+)"/g)) sources.add(match[1]);
  }
  assert.deepEqual(sources, new Set(score.notes.map(note => note.sourceId)));
});
