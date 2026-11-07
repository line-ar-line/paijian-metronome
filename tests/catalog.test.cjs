const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { parseMidi } = require('../score/midi.js');
const { buildScore, pitchInfo, LIMITS } = require('../score/score-model.js');

const project = path.resolve(__dirname, '..');
const manifestPath = path.join(project, 'catalog/index.json');
const readCatalog = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

test('catalog contains 1,000 distinct, attributed source entries with safe local files', () => {
  const catalog = readCatalog();
  assert.equal(catalog.version, 1);
  assert.equal(catalog.source, 'Mutopia');
  assert.ok(Number.isFinite(Date.parse(catalog.updatedAt)));
  assert.equal(catalog.entries.length, 1000);
  for (const key of ['id', 'sourceUrl', 'midiUrl', 'file', 'sha256', 'musicalSha256']) {
    assert.equal(new Set(catalog.entries.map(entry => entry[key])).size, 1000, `${key} must identify 1,000 different source files`);
  }
  for (const entry of catalog.entries) {
    assert.match(entry.id, /^mutopia-\d+$/);
    for (const key of ['title', 'composer', 'instrument', 'license', 'licenseUrl', 'attribution']) {
      assert.ok(nonempty(entry[key]), `${entry.id} must retain ${key}`);
    }
    const source = new URL(entry.sourceUrl);
    assert.equal(source.protocol, 'https:');
    assert.equal(source.hostname, 'www.mutopiaproject.org');
    assert.equal(source.pathname, '/cgibin/piece-info.cgi');
    assert.equal(source.searchParams.get('id'), entry.id.slice('mutopia-'.length));
    const original = new URL(entry.midiUrl);
    assert.equal(original.protocol, 'https:');
    assert.equal(original.hostname, 'www.mutopiaproject.org');
    assert.ok(original.pathname.startsWith('/ftp/'));
    assert.match(original.pathname, /\.midi?$/i, 'one full MIDI per source entry; do not substitute a zip part');
    assert.match(entry.file, /^catalog\/midi\/mutopia-\d+\.mid$/);
    assert.equal(path.basename(entry.file), `${entry.id}.mid`);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 14);
    assert.ok(Number.isSafeInteger(entry.notes) && entry.notes > 0);
    assert.ok(Number.isSafeInteger(entry.bars) && entry.bars > 0 && entry.bars <= LIMITS.maxBars);
    assert.ok(Number.isFinite(entry.totalBeats) && entry.totalBeats > 0);
    assert.ok(Number.isSafeInteger(entry.maxPolyphony) && entry.maxPolyphony > 0 && entry.maxPolyphony <= LIMITS.maxVoices);
    assert.ok(Number.isSafeInteger(entry.playable17Count) && entry.playable17Count >= 0 && entry.playable17Count <= entry.notes);
    const licenseUrl = new URL(entry.licenseUrl);
    assert.equal(licenseUrl.protocol, 'https:');
    assert.ok(['www.mutopiaproject.org', 'creativecommons.org'].includes(licenseUrl.hostname));
    // Preserve the source's exact public-domain or attribution license version.
    // The selection deliberately excludes share-alike and restrictive licenses.
    assert.match(entry.license, /^(Public Domain|(?:Creative Commons Attribution |CC BY )(?:2\.5|3\.0|4\.0))$/);
    if (entry.license !== 'Public Domain') {
      const version = entry.license.match(/(2\.5|3\.0|4\.0)$/)[1];
      assert.equal(licenseUrl.hostname, 'creativecommons.org');
      assert.equal(licenseUrl.pathname.replace(/\/$/, ''), `/licenses/by/${version}`);
    }
  }
  assert.equal(catalog.totalBytes, catalog.entries.reduce((sum, entry) => sum + entry.bytes, 0));
  assert.deepEqual(
    fs.readdirSync(path.join(project, 'catalog/midi')).filter(filename => /\.midi?$/i.test(filename)).sort(),
    catalog.entries.map(entry => path.basename(entry.file)).sort(),
    'the published directory must not contain unindexed or missing MIDI files',
  );
});

test('every selected source, main MIDI and license is traceable to the official metadata snapshot', () => {
  const catalog = readCatalog();
  const snapshot = fs.readFileSync(path.join(project, 'catalog/sources/mutopia-musiccache.dat'));
  assert.equal(createHash('sha256').update(snapshot).digest('hex'), catalog.sourceIndexSha256);
  assert.equal(catalog.sourceIndexUrl, 'https://www.mutopiaproject.org/datafiles/musiccache.dat');
  const offset = Number(snapshot.subarray(0, snapshot.indexOf(10)).toString('ascii'));
  const records = snapshot.subarray(offset).toString('utf8').split('**********\n').slice(1).map(record => record.trimEnd().split('\n'));
  const byId = new Map(records.map(record => [`mutopia-${record[0]}`, record]));
  assert.equal(byId.size, records.length, 'official source IDs are unique');
  assert.ok(byId.size >= catalog.entries.length);
  for (const entry of catalog.entries) {
    const source = byId.get(entry.id);
    assert.ok(source, `${entry.id} occurs in the official index`);
    assert.equal(entry.sourceRevision, source[23]);
    assert.equal(entry.licenseName, source[22]);
    assert.equal(entry.license, source[22].replace('Creative Commons Attribution ', 'CC BY '));
    assert.equal(decodeURIComponent(new URL(entry.midiUrl).pathname), `/ftp/${source[1]}${source[2]}/${source[4]}`, `${entry.id}: exact official main MIDI path`);
    assert.match(source[4], /\.mid$/i, `${entry.id}: single complete main file`);
    assert.doesNotMatch(`${source[12]} ${source[27]}`, /\b(fragment|excerpt|extract|incomplete)\b/i, `${entry.id}: source does not declare a fragment`);
    assert.ok(entry.attribution.includes(entry.maintainer), `${entry.id}: contributor attribution is retained`);
    assert.ok(entry.attribution.includes(entry.sourceUrl));
    assert.ok(entry.attribution.includes(entry.licenseUrl));
  }
});

test('the browser catalog and JSON download expose the same metadata', () => {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(project, 'catalog/index.js'), 'utf8'), sandbox, { timeout: 1000 });
  const candidates = Object.values(sandbox).filter(value => value && Array.isArray(value.entries));
  assert.equal(candidates.length, 1, 'the browser script must publish exactly one catalog object');
  assert.deepEqual(JSON.parse(JSON.stringify(candidates[0])), readCatalog());
});

test('confirmed alternate editions and incomplete works remain excluded after rebuilding the catalog', () => {
  const catalog = readCatalog();
  const selected = new Set(catalog.entries.map(entry => entry.sourceId));
  const review = JSON.parse(fs.readFileSync(path.join(project, 'catalog/semantic-review.json'), 'utf8'));
  assert.match(review.kind, /pre-filter.*snapshot.*final decisions/i);
  assert.match(review.description, /筛选前.*快照/);
  assert.match(review.description, /index\.json/);
  assert.equal(review.finalCatalog.count, catalog.entries.length);
  assert.equal(review.finalCatalog.totalBytes, catalog.totalBytes);
  assert.deepEqual(review.finalCatalog.ids, catalog.entries.map(entry => entry.sourceId), 'the audit distinguishes its historical candidates from the final published selection');
  const reviewedEditionPairs = [
    [5, 2206], [44, 50], [63, 493], [75, 102], [461, 1534], [468, 921],
    [497, 941], [1030, 1621], [798, 1707], [109, 1265], [195, 1298], [256, 2167],
  ];
  for (const [retained, excluded] of reviewedEditionPairs) {
    assert.ok(!(selected.has(retained) && selected.has(excluded)), `confirmed alternate editions ${retained}/${excluded} must not both be counted`);
    assert.equal(selected.has(excluded), false, `review decision excludes alternate edition ${excluded}`);
    const decision = review.confirmedAlternateVersionsExcluded.find(item => item.keep === retained && item.exclude === excluded);
    assert.ok(decision && nonempty(decision.work) && nonempty(decision.evidence), `review preserves the rationale for ${retained}/${excluded}`);
  }
  for (const sourceId of [241, 447, 614, 615, 616, 617, 618, 619, 620, 766, 1634, 2238]) {
    assert.equal(selected.has(sourceId), false, `confirmed fragment, incomplete work or duplicate inner variation ${sourceId} must stay excluded`);
  }
  for (const sourceId of [258, 695]) {
    assert.equal(selected.has(sourceId), false, `confirmed alternate edition ${sourceId} must not return as a replacement candidate`);
  }
  for (const sourceId of [614, 615, 616, 617, 618, 619, 620, 766, 1634, 2238]) {
    assert.ok(review.otherScopeExclusions.some(item => item.sourceId === sourceId && nonempty(item.reason)), `${sourceId}: review retains the scope-exclusion decision`);
  }
  for (const sourceId of [44, 497, 683, 684, 685, 1545, 1546, 1547, 1727, 2228]) {
    const decision = review.clarifiedScopeTitles.find(item => item.sourceId === sourceId);
    const entry = catalog.entries.find(item => item.sourceId === sourceId);
    assert.ok(decision && entry, `${sourceId}: clarified complete movement remains available`);
    assert.equal(entry.title, decision.title);
    assert.equal(entry.scope, decision.scope);
    assert.ok(nonempty(entry.originalTitle));
    assert.notEqual(entry.title, entry.originalTitle, 'the original title is retained alongside the clearer movement title');
  }
});

test('all 1,000 complete MIDI files match their hashes and convert without dropped polyphony', { timeout: 180000 }, () => {
  const catalog = readCatalog();
  let noteCount = 0;
  let barCount = 0;
  let longest = 0;
  let mostVoices = 0;
  for (const entry of catalog.entries) {
    const label = `${entry.id}: ${entry.title}`;
    const bytes = fs.readFileSync(path.join(project, entry.file));
    assert.equal(bytes.length, entry.bytes, `${label}: full byte length`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${label}: complete original byte hash`);
    const midi = parseMidi(bytes);
    const notes = midi.tracks.filter(track => !track.isPercussion).flatMap(track => track.notes);
    assert.equal(notes.length, entry.notes, `${label}: all pitched tracks`);
    assert.equal(midi.totalBeats, entry.totalBeats, `${label}: source timeline`);
    const score = buildScore(notes, { mode: 'polyphonic', instrument: '17C', meter: midi.timeSignature, totalBeats: midi.totalBeats, grid: .25, transpose: 0 });
    assert.equal(score.notes.length, notes.length, `${label}: no omitted notes`);
    assert.equal(score.stats.removedPolyphony, 0, `${label}: no omitted simultaneous notes`);
    assert.equal(score.stats.clippedOverlaps, 0, `${label}: no shortened overlapping notes`);
    assert.equal(score.bars.length, entry.bars, `${label}: all bars are represented`);
    assert.equal(score.stats.maxPolyphony, entry.maxPolyphony, `${label}: voice count`);
    assert.equal(notes.filter(note => pitchInfo(note.midi, '17C').playable).length, entry.playable17Count, `${label}: accurate instrument coverage`);
    assert.ok(score.sourceTotalBeats >= midi.totalBeats, `${label}: metadata-only final rests must survive`);
    assert.ok(score.totalBeats >= score.sourceTotalBeats, `${label}: final bar is included`);
    assert.ok(score.totalBeats - score.sourceTotalBeats < score.barBeats + 1e-7, `${label}: final padding is less than one bar`);
    const tokenIds = new Set(score.bars.flatMap(bar => bar.tokens.filter(token => token.sourceId).map(token => token.sourceId)));
    assert.equal(tokenIds.size, notes.length, `${label}: every note is materialized in the complete score`);
    const originalPitches = notes.map(note => note.midi).sort((a, b) => a - b);
    assert.deepEqual(score.notes.map(note => note.midi).sort((a, b) => a - b), originalPitches, `${label}: no pitch changes`);
    noteCount += notes.length;
    barCount += score.bars.length;
    longest = Math.max(longest, score.bars.length);
    mostVoices = Math.max(mostVoices, score.stats.maxPolyphony);
  }
  console.log(`Catalog audit: ${catalog.entries.length} unique files, ${catalog.totalBytes} bytes, ${noteCount} retained notes, ${barCount} bars; longest ${longest} bars, maximum ${mostVoices} voices.`);
});
