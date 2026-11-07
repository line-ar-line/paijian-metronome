const test = require('node:test');
const assert = require('node:assert/strict');
const { compile } = require('../score/document.js');
const { pitchInfo } = require('../score/score-model.js');
const { render, paginate } = require('../score/renderer.js');

function fixture({ groupCount = 6, afterBar = 32 } = {}) {
  const document = { format: 'paijian-score', version: 1, title: '嘘', meter: [3, 4], bpm: 80, instrument: '17C', voices: [
    { name: '旋律', notation: Array(73).fill("1':3").join(' | ') },
    { name: '伴奏', notation: Array(73).fill('1 3 5').join(' | ') },
  ], repeats: [], credits: [] };
  const score = compile(document).score;
  let serial = 0;
  const pitch = midi => ({ ...pitchInfo(midi, '17C'), sourceId: `unmetered-source-${serial++}` });
  const section = {
    title: '手写间奏 · 保留全部音序',
    description: '原稿没有完整时值。按原稿横向位置保留旋律与伴奏，不推断节奏。',
    afterBar,
    voiceNames: ['旋律', '伴奏'],
    groups: Array.from({ length: groupCount }, (_, index) => ({ index, columns: [
      { voices: [[pitch(72)], [pitch(48), pitch(60)]] },
      { voices: [[], [pitch(64), pitch(67), pitch(71)]] },
      { voices: [[pitch(81), pitch(84)], []] },
      { voices: [[], []] },
      { voices: [[pitch(61)], []] },
    ] })),
  };
  score.unmeteredSections = [section];
  return { score, section };
}
const pitchesOf = section => section.groups.flatMap(group => group.columns.flatMap(column => column.voices.flat()));
const sources = svg => [...svg.matchAll(/data-source-id="([^"]+)"/g)].map(match => match[1]);
const size = svg => {
  const match = svg.match(/<svg[^>]*width="(\d+)" height="(\d+)"/);
  return { width: Number(match[1]), height: Number(match[2]) };
};
const decode = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function labeledText(svg, className) {
  return [...svg.matchAll(new RegExp(`<text[^>]*class="${className}"[^>]*>([^<]*)<\\/text>`, 'g'))].map(match => decode(match[1])).join('');
}
function renderedCredits(svg) {
  const credits = new Map();
  for (const match of svg.matchAll(/<text[^>]*class="score-credit" data-credit-index="(\d+)"[^>]*>([^<]*)<\/text>/g)) credits.set(Number(match[1]), (credits.get(Number(match[1])) || '') + decode(match[2]));
  return [...credits.values()];
}

test('all six unmetered groups appear between printed bars 32 and 33, with unified page numbering', () => {
  const { score, section } = fixture();
  const snapshot = JSON.stringify(score);
  const pages = paginate(score);
  const interludes = pages.filter(page => page.unmeteredSection);
  assert.equal(interludes.length, 2);
  assert.deepEqual(interludes.map(page => page.unmeteredSection.groups.length), [3, 3]);
  const first = pages.indexOf(interludes[0]);
  const last = pages.indexOf(interludes.at(-1));
  assert.equal(pages[first - 1].bars.at(-1).index, 31);
  assert.equal(pages[last + 1].bars[0].index, 32);
  assert.deepEqual(pages.slice(0, first).flatMap(page => page.bars.map(bar => bar.index)), Array.from({ length: 32 }, (_, i) => i));
  assert.deepEqual(pages.slice(last + 1).flatMap(page => page.bars.map(bar => bar.index)), Array.from({ length: 41 }, (_, i) => i + 32));
  assert.deepEqual(interludes.flatMap(page => page.unmeteredSection.groups), section.groups);
  assert.ok(interludes.every(page => page.bars.length === 0));
  assert.equal(pages.flatMap(page => page.bars).length, 73);
  pages.forEach((page, index) => {
    assert.equal(page.pageNumber, index + 1);
    assert.equal(page.pageCount, pages.length);
    assert.equal(page.totalBarCount, 73);
    assert.equal(page.notes, score.notes, 'visual interludes do not replace or expand playback notes');
    assert.equal(page.totalBeats, score.totalBeats);
    const svg = render(page);
    assert.match(svg, new RegExp(`第 ${index + 1}/${pages.length} 页`));
    assert.match(svg, /正文 73 小节 \+ 间奏/);
    assert.ok(size(svg).height <= 1380);
  });
  assert.equal(JSON.stringify(score), snapshot, 'pagination and pitch sorting must not mutate the source score');
});

test('unmetered SVG keeps every pitch, octave dot and blank column without images or invented rhythm', () => {
  const { score, section } = fixture();
  const pages = paginate(score).filter(page => page.unmeteredSection);
  const svg = pages.map(page => render(page)).join('\n');
  const expected = pitchesOf(section);
  assert.equal(expected.length, 54);
  assert.equal(sources(svg).length, expected.length);
  assert.deepEqual(new Set(sources(svg)), new Set(expected.map(pitch => pitch.sourceId)));
  assert.equal((svg.match(/class="unmetered-group"/g) || []).length, 6);
  assert.equal((svg.match(/class="unmetered-column"/g) || []).length, 30, 'empty alignment columns are preserved');
  assert.equal((svg.match(/<circle class="note-dot"/g) || []).length, expected.reduce((sum, pitch) => sum + Math.abs(pitch.octave), 0));
  assert.match(svg, /class="accidental"/);
  assert.equal(/<image\b|data:image|<foreignObject\b/.test(svg), false);
  assert.equal(/class="(?:note-line|beat-guide|measure-barline|tie|glissando)"/.test(svg), false);
  assert.equal(/class="note-number"[^>]*>0<\/text>/.test(svg), false);
  assert.equal(svg.includes('>−</text>'), false);
  assert.equal(/\b(?:undefined|NaN)\b/.test(svg), false);
  assert.equal(/<title>[^<]*\d+(?:\.\d+)? 拍/.test(svg), false);
  assert.match(svg, /时值待定，横向间距不表示节奏；间奏不参与试听/);
  for (let index = 0; index < 6; index++) assert.match(svg, new RegExp(`音序分组 ${index + 1}（非小节）`));
  assert.match(svg, /旋律/);
  assert.match(svg, /伴奏/);

  const positions = new Map();
  for (const group of svg.matchAll(/<g class="note-group[^\"]*"[^>]*data-source-id="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)) {
    const number = group[2].match(/<text x="([\d.]+)" y="([\d.]+)" class="note-number"/);
    positions.set(group[1], { x: Number(number[1]), y: Number(number[2]) });
  }
  for (const group of section.groups) for (const column of group.columns) for (const voice of column.voices) {
    const ordered = voice.slice().sort((a, b) => b.midi - a.midi).map(pitch => positions.get(pitch.sourceId));
    if (!ordered.length) continue;
    assert.equal(new Set(ordered.map(note => note.x)).size, 1);
    for (let i = 1; i < ordered.length; i++) assert.ok(ordered[i].y >= ordered[i - 1].y + 40, 'chord tones are distinct and descend in pitch');
  }
});

test('custom page height splits groups without losing columns or changing original group indexes', () => {
  const { score, section } = fixture();
  const pages = paginate(score, {}, 900);
  const interludes = pages.filter(page => page.unmeteredSection);
  assert.ok(interludes.length >= 3);
  assert.ok(interludes.every(page => page.unmeteredSection.groups.length >= 1 && page.unmeteredSection.groups.length <= 3));
  assert.deepEqual(interludes.flatMap(page => page.unmeteredSection.groups.map(group => group.index)), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(interludes.flatMap(page => page.unmeteredSection.groups.flatMap(group => group.columns)), section.groups.flatMap(group => group.columns));
  assert.ok(pages.every(page => size(render(page)).height <= 900));
});

test('full section titles, descriptions and credits wrap safely on every unmetered page', () => {
  const { score, section } = fixture();
  section.title = '<script>标题</script> & "间奏" ' + '完整标题'.repeat(36);
  section.description = '<image onerror="bad()">完整说明</image> & ' + '原稿未标节奏，保留全部音序。'.repeat(45) + '\n第二段：结束标记。';
  section.voiceNames = ['<svg/onload=x>', '伴奏 & 声部'];
  const credits = ['来源与编配：' + '完整署名'.repeat(80), 'https://example.com/?score=x&notes=' + 'full-source-path/'.repeat(30), 'License <script>safe()</script> & "原稿"'];
  const options = { credits };
  const pages = paginate(score, options, 1800);
  const interludes = pages.filter(page => page.unmeteredSection);
  assert.ok(interludes.length > 0);
  for (const page of interludes) {
    const svg = render(page, options);
    assert.equal(labeledText(svg, 'unmetered-section-title'), section.title);
    assert.equal(labeledText(svg, 'unmetered-description'), section.description.replace(/\n/g, ''));
    assert.deepEqual(renderedCredits(svg), credits);
    assert.equal(/<(?:script|image|foreignObject)\b/.test(svg), false);
    assert.equal(svg.includes('<svg/onload=x>'), false);
    assert.ok(svg.includes('&lt;svg/onload=x&gt;'));
    assert.ok(size(svg).height <= 1800);
    const lastDescriptionY = Math.max(...[...svg.matchAll(/<text[^>]*y="([\d.]+)"[^>]*class="unmetered-description"/g)].map(match => Number(match[1])));
    const firstNumberY = Number(svg.match(/<text[^>]*y="([\d.]+)"[^>]*class="note-number"/)[1]);
    assert.ok(firstNumberY > lastDescriptionY + 50, 'long explanations stay above the score');
  }
  assert.equal(interludes.flatMap(page => sources(render(page, options))).length, pitchesOf(section).length);
});

test('dense unmetered groups widen rather than drop columns, and tiny height limits retain whole groups', () => {
  const { score, section } = fixture({ groupCount: 1, afterBar: 73 });
  section.groups[0].columns = Array.from({ length: 40 }, (_, index) => ({ voices: [[{ ...pitchInfo(72, '17C'), sourceId: `dense-${index}` }], []] }));
  const pages = paginate(score, {}, 100);
  const interlude = pages.at(-1);
  assert.ok(interlude.unmeteredSection);
  assert.equal(pages.at(-2).bars.at(-1).index, 72);
  assert.equal(interlude.unmeteredSection.groups[0], section.groups[0]);
  const svg = render(interlude);
  assert.equal(sources(svg).length, 40);
  assert.ok(size(svg).width > 1040);
  assert.match(svg, new RegExp(`style="min-width:${size(svg).width}px"`));
  const positions = [...svg.matchAll(/<text x="([\d.]+)"[^>]*class="note-number"/g)].map(match => Number(match[1]));
  for (let i = 1; i < positions.length; i++) assert.ok(positions[i] - positions[i - 1] >= 64);
});

test('scores without unmetered material retain their established metered page behavior', () => {
  const { score } = fixture();
  delete score.unmeteredSections;
  const pages = paginate(score);
  assert.ok(pages.every(page => !page.unmeteredSection));
  assert.deepEqual(pages.flatMap(page => page.bars.map(bar => bar.index)), Array.from({ length: 73 }, (_, i) => i));
  assert.match(render(pages[0]), /全曲 73 小节/);
  assert.equal(render(pages[0]).includes(' + 间奏'), false);
  assert.equal(pages.map(page => render(page)).join('').includes('unmetered-notice'), false);
});
