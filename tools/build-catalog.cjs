#!/usr/bin/env node
'use strict';

// Rebuild the offline catalog from Mutopia's public primary-source metadata.
// MIDI payloads are copied byte-for-byte; only their catalog metadata is derived.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseMidi } = require('../score/midi.js');
const { buildScore, pitchInfo } = require('../score/score-model.js');
const { normalizeScore } = require('../score/player.js');

const ROOT = path.resolve(__dirname, '..');
const DESTINATION = path.join(ROOT, 'catalog');
const CACHE = process.env.PAIJIAN_CATALOG_CACHE || '/tmp/paijian-mutopia-catalog';
const SOURCE_URL = 'https://www.mutopiaproject.org/datafiles/musiccache.dat';
const TARGET = Number(process.env.PAIJIAN_CATALOG_COUNT || 1000);
const CONCURRENCY = 6;
// Official item titles sometimes omit the movement encoded in their main-file
// path. These reviewed labels state the complete item scope without implying
// that one movement is the entire sonata.
const MOVEMENT_SCOPES = new Map([
  ['44', '第 1 乐章 Prelude（BWV 997）'],
  ['497', '第 1 乐章 Allegro con brio（钢琴缩编）'],
  ['683', '第 1 乐章'], ['684', '第 2 乐章'], ['685', '第 3 乐章'],
  ['1545', '第 1 首（D. 733/1）'], ['1546', '第 2 首（D. 733/2）'], ['1547', '第 3 首（D. 733/3）'],
  ['1727', '第 4 乐章（Op. 35）'], ['2228', '第 1 乐章 Allegro'],
]);
const SEMANTIC_DUPLICATES = [
  { keep: 5, exclude: 2206, work: 'Bach BWV 846, Prelude I', evidence: 'Same composer/catalog/prelude; alternate Clavier/Klavier title spelling and engraving.' },
  { keep: 44, exclude: 50, work: 'Bach BWV 997, first-movement Prelude', evidence: 'Same catalog and Prelude scope; both have 221 quarter-note beats and 56 rendered bars.' },
  { keep: 63, exclude: 493, work: 'Bach BWV 928', evidence: 'Same catalog work; collection numbering differs between Praeludium 10 and Petite Prelude No.9.' },
  { keep: 75, exclude: 102, work: 'Menuet in G, BWV Anh.114', evidence: 'Same catalog minuet, alternate short title and engraving.' },
  { keep: 75, exclude: 258, work: 'Menuet in G, BWV Anh.114', evidence: 'Another source version of the already-reviewed same catalog minuet.' },
  { keep: 75, exclude: 695, work: 'Menuet in G, BWV Anh.114', evidence: 'Another source version of the already-reviewed same catalog minuet.' },
  { keep: 461, exclude: 1534, work: 'Bach BWV 1068, Air', evidence: 'Same suite movement, including the alternate Air on the G string title.' },
  { keep: 468, exclude: 921, work: 'Chopin Op.28 No.4', evidence: 'Same numbered prelude; latter explicitly identifies an alternate Peters source.' },
  { keep: 497, exclude: 941, work: 'Beethoven Op.67, Symphony No.5 movement I', evidence: 'Piano reduction and orchestral version of the same movement. Item497 official source ZIP includes only mvt01-allegroconbrio.ly.' },
  { keep: 1030, exclude: 1621, work: 'Schubert D.328, Erlkonig', evidence: 'Same catalog song; latter explicitly says alternative typesetting.' },
  { keep: 798, exclude: 1707, work: 'Mendelssohn Op.47, Es ist bestimmt in Gottes Rat', evidence: 'Official LilyPond sources share composer/date/opus/Feuchtersleben text and opening lyric; TTBB/G versus SATB/F arrangements under alternate titles.' },
  { keep: 109, exclude: 1265, work: 'Greensleeves', evidence: 'Traditional tune under spelling variant; item1265 official notes explicitly describe a simple accordion version of the known song.' },
  { keep: 195, exclude: 1298, work: 'W.H.Doane, To God Be the Glory', evidence: 'Same composer/hymn title and 96-beat scope; latter is labeled hymntune.' },
  { keep: 256, exclude: 2167, work: 'Gounod, Ave Maria: Meditation on Bach Prelude I', evidence: 'Same composer and work title; trumpet transcription versus piano/violin arrangement.' },
];
const EXCLUDED_SCOPES = new Map([
  ['614', 'Official KV331_1_1_tema.mid is only the theme within movement 1, not the complete movement.'],
  ...['615', '616', '617', '618', '619', '620'].map(id => [id, 'Standalone KV331 variation is only a section within movement 1, not the complete movement.']),
  ['766', 'The original Contrapunctus XIX / Fuga a 3 Soggetti is historically unfinished; excluded from the complete-piece catalog.'],
  ['1634', 'Official notes say the source second-oboe part is missing and substituted.'],
  ['2238', 'Standalone variation V duplicates a section of the selected complete theme-and-12-variations item 2236.'],
  ...SEMANTIC_DUPLICATES.map(item => [String(item.exclude), `Confirmed alternate version of selected item ${item.keep}: ${item.work}. ${item.evidence}`]),
]);
const FIELDS = ['idno', 'midrif', 'musicnm', 'lyfile', 'midfile', 'a4psfile', 'a4pdffile', 'letpsfile', 'letpdffile', 'previewfile', 'pngheight', 'pngwidth', 'title', 'composer', 'opus', 'lyricist', 'instrument', 'date', 'style', 'metre', 'arranger', 'source', 'copyright', 'id', 'maintainer', 'maintaineremail', 'maintainerweb', 'extrainfo', 'lilypondversion', 'collections', 'printurl'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clean = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos|nbsp|ldquo|rdquo);/g, item => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&ldquo;': '“', '&rdquo;': '”' })[item]).replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => String.fromCodePoint(code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code))).replace(/\s+/g, ' ').trim();
const identity = value => clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function licensing(value) {
  if (value === 'Public Domain') return { license: 'Public Domain', licenseUrl: 'https://www.mutopiaproject.org/legal.html#publicdomain', priority: 0 };
  const match = value.match(/^Creative Commons Attribution(-ShareAlike)? (\d\.\d)$/);
  if (!match) return null;
  const version = match[2];
  const kind = match[1] ? 'by-sa' : 'by';
  return { license: `CC ${match[1] ? 'BY-SA' : 'BY'} ${version}`, licenseUrl: `https://creativecommons.org/licenses/${kind}/${version}/`, priority: (match[1] ? 10 : 1) + (4 - Number(version)) };
}

function readSource(bytes) {
  const offset = Number(bytes.subarray(0, bytes.indexOf(10)).toString('ascii'));
  if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.length) throw new Error('Official metadata header offset is invalid.');
  const lines = bytes.subarray(offset).toString('utf8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length % 32) throw new Error('Official metadata has an incomplete record.');
  const records = [];
  for (let index = 0; index < lines.length; index += 32) {
    if (lines[index] !== '**********') throw new Error(`Unexpected metadata separator at record ${index / 32}.`);
    records.push(Object.fromEntries(FIELDS.map((name, field) => [name, lines[index + field + 1]])));
  }
  return records;
}

async function download(url, file) {
  if (fs.existsSync(file)) return fs.readFileSync(file);
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'PaijianScoreCatalog/1.0 (offline music practice catalog; 6 concurrent downloads)' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 20 * 1024 * 1024) throw new Error('Source MIDI exceeds the 20 MiB importer bound.');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      return bytes;
    } catch (error) {
      last = error;
      if (/HTTP 40[034]/.test(error.message)) break;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
  throw last;
}

function summarize(record, bytes) {
  const parsed = parseMidi(bytes);
  if (parsed.tracks.some(track => track.isPercussion)) throw new Error('Percussion source parts are not included in the current kalimba playback path.');
  if (parsed.warnings.some(warning => /不能保证与完整原谱一致/.test(warning))) throw new Error('Source has unmatched note releases; completeness cannot be established.');
  const sourceNotes = parsed.tracks.flatMap(track => track.notes);
  if (!sourceNotes.length) throw new Error('Source has no pitched notes.');
  const score = buildScore(sourceNotes, { mode: 'polyphonic', meter: parsed.timeSignature, instrument: '17C', totalBeats: parsed.totalBeats });
  if (score.stats.outputNotes !== sourceNotes.length || score.stats.removedPolyphony || score.stats.clippedOverlaps) throw new Error('Validation changed the number of notes or clipped a voice.');
  normalizeScore(score.notes, { bpm: Math.max(30, Math.min(240, parsed.tempo)), totalBeats: score.sourceTotalBeats });
  const lowest = sourceNotes.reduce((value, note) => Math.min(value, note.midi), 127);
  // Ignore absolute transposition and tempo when excluding reused musical data.
  const fingerprintNotes = sourceNotes.map(note => [note.midi - lowest, Math.round(note.start * 1e6), Math.round(note.duration * 1e6)]).sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
  const musicalSha256 = hash(JSON.stringify({ notes: fingerprintNotes, totalBeats: Math.round(parsed.totalBeats * 1e6) }));
  const license = licensing(record.copyright);
  const id = `mutopia-${record.idno}`;
  const originalTitle = clean(record.title);
  const movementScope = MOVEMENT_SCOPES.get(record.idno);
  const title = `${originalTitle}${movementScope ? ` — ${movementScope}` : ''}`;
  const opus = clean(record.opus);
  const composer = clean(record.composer);
  const maintainer = clean(record.maintainer) || 'Mutopia Project contributors';
  const maintainerWebsite = clean(record.maintainerweb);
  const arranger = clean(record.arranger);
  const sourceUrl = `https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=${record.idno}`;
  const midiUrl = `https://www.mutopiaproject.org/ftp/${`${record.midrif}${record.musicnm}/${record.midfile}`.split('/').map(encodeURIComponent).join('/')}`;
  const workKey = `${record.midrif.split('/')[0]}|${identity(title)}|${identity(opus)}`;
  return {
    entry: {
      id, sourceId: Number(record.idno), title, originalTitle, composer, opus,
      instrument: clean(record.instrument), style: clean(record.style),
      sourceUrl, midiUrl, file: `catalog/midi/${id}.mid`,
      license: license.license, licenseUrl: license.licenseUrl,
      licenseName: record.copyright, maintainer, maintainerWebsite, arranger,
      attribution: `《${title}》${opus ? `（${opus}）` : ''} — ${composer}。${arranger ? `编配：${arranger}。` : ''}制谱/贡献者：${maintainer}${maintainerWebsite ? `（${maintainerWebsite}）` : ''}。来源：Mutopia Project #${record.idno}（${sourceUrl}）。授权：${license.license}（${license.licenseUrl}）。原始 MIDI 字节未修改。`,
      scope: movementScope ? `完整独立曲目/乐章：${movementScope}；不表示整部《${originalTitle}》。${record.idno === '497' ? '范围依据官方乐谱源 ZIP，主文件仅包含 mvt01-allegroconbrio.ly。' : `范围依据官方主 MIDI 文件 ${record.midfile} 及作品编号 ${opus}。`}` : `完整官方条目：《${title}》${opus ? `（${opus}）` : ''}；如为组曲或歌剧中的独立曲目/乐章，收录范围以原标题为准。`,
      sourceEdition: clean(record.source), sourceRevision: record.id, sourceNotes: clean(record.extrainfo),
      bytes: bytes.length, sha256: hash(bytes), musicalSha256,
      notes: score.notes.length, bars: score.bars.length, totalBeats: parsed.totalBeats,
      renderedTotalBeats: score.totalBeats, maxPolyphony: score.stats.maxPolyphony,
      playable17Count: score.stats.outputNotes - score.stats.unplayable,
      playable21Count: score.notes.filter(note => pitchInfo(note.midi, '21C').playable).length,
      bpm: parsed.tempo, meter: parsed.timeSignature, tracks: parsed.tracks.length,
      quantizedNotes: score.stats.quantized,
      validationWarnings: [...parsed.warnings, ...score.warnings],
    },
    workKey,
  };
}

async function main() {
  if (!Number.isInteger(TARGET) || TARGET < 1 || TARGET > 2000) throw new Error('Catalog target must be an integer between 1 and 2000.');
  fs.mkdirSync(CACHE, { recursive: true });
  const sourceFile = process.env.PAIJIAN_CATALOG_SOURCE;
  const sourceBytes = sourceFile ? fs.readFileSync(sourceFile) : await download(SOURCE_URL, path.join(CACHE, 'musiccache.dat'));
  const records = readSource(sourceBytes);
  const rejected = [];
  const candidates = records.filter(record => {
    let reason;
    if (!/^\d+$/.test(record.idno)) reason = 'Source ID is invalid.';
    else if (EXCLUDED_SCOPES.has(record.idno)) reason = EXCLUDED_SCOPES.get(record.idno);
    else if (!licensing(record.copyright)) reason = 'No approved redistribution license.';
    else if (!/\.mid$/i.test(record.midfile)) reason = 'No single official main MIDI; ZIP/part bundles are not selected.';
    else if (/\b(fragment|excerpt|extract|incomplete)\b/i.test(clean(`${record.title} ${record.extrainfo}`))) reason = 'Official metadata identifies a fragment or excerpt.';
    else if (/\b(practice|rehearsal|soprano only|alto only|tenor only|bass only)\b/i.test(record.midfile)) reason = 'MIDI filename identifies a rehearsal/isolated-voice file.';
    if (reason) rejected.push({ sourceId: Number(record.idno), reason });
    return !reason;
  }).sort((a, b) => licensing(a.copyright).priority - licensing(b.copyright).priority || Number(a.idno) - Number(b.idno));
  const entries = [];
  const selectedBytes = new Map();
  const seenSources = new Set(), seenBytes = new Set(), seenMusic = new Set(), seenWorks = new Set();
  let checked = 0;
  const started = Date.now();
  console.log(JSON.stringify({ phase: 'source', sourceRecords: records.length, candidates: candidates.length, target: TARGET, sourceSha256: hash(sourceBytes) }));
  for (let index = 0; index < candidates.length && entries.length < TARGET; index += CONCURRENCY) {
    const batch = candidates.slice(index, index + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async record => {
      const url = `https://www.mutopiaproject.org/ftp/${`${record.midrif}${record.musicnm}/${record.midfile}`.split('/').map(encodeURIComponent).join('/')}`;
      const bytes = await download(url, path.join(CACHE, 'midi', `mutopia-${record.idno}.mid`));
      return { ...summarize(record, bytes), bytes };
    }));
    for (let offset = 0; offset < results.length && entries.length < TARGET; offset++) {
      checked++;
      const result = results[offset];
      const record = batch[offset];
      if (result.status === 'rejected') { rejected.push({ sourceId: Number(record.idno), reason: result.reason.message }); continue; }
      const { entry, workKey, bytes } = result.value;
      let reason;
      if (seenSources.has(entry.sourceId)) reason = 'Duplicate official source ID.';
      else if (seenBytes.has(entry.sha256)) reason = 'Duplicate original MIDI bytes.';
      else if (seenMusic.has(entry.musicalSha256)) reason = 'Duplicate musical event sequence, allowing for transposition.';
      else if (seenWorks.has(workKey)) reason = 'Duplicate composer/title/opus identity.';
      if (reason) { rejected.push({ sourceId: entry.sourceId, reason }); continue; }
      seenSources.add(entry.sourceId); seenBytes.add(entry.sha256); seenMusic.add(entry.musicalSha256); seenWorks.add(workKey);
      entries.push(entry); selectedBytes.set(entry.id, bytes);
    }
    const progress = { phase: 'validation', checked, accepted: entries.length, target: TARGET, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), elapsedSeconds: Math.round((Date.now() - started) / 1000), latestSourceId: Number(batch.at(-1).idno), latestLicense: batch.at(-1).copyright };
    fs.writeFileSync(path.join(CACHE, 'progress.json'), JSON.stringify({ ...progress, recentRejected: rejected.slice(-8) }, null, 2));
    if (checked % 30 === 0 || entries.length === TARGET) console.log(JSON.stringify(progress));
  }
  fs.writeFileSync(path.join(CACHE, 'rejected.json'), JSON.stringify(rejected, null, 2));
  if (entries.length !== TARGET) throw new Error(`Only ${entries.length} validated distinct complete entries are available; refusing to publish an incomplete catalog of ${TARGET}.`);

  entries.sort((a, b) => a.sourceId - b.sourceId);
  const catalog = {
    version: 1, updatedAt: new Date().toISOString(), source: 'Mutopia',
    sourceIndexUrl: SOURCE_URL, sourceIndexSha256: hash(sourceBytes),
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    count: entries.length,
    completeness: '每项保存官方单一主 MIDI 原始字节，按官方条目/独立乐章范围收录；不截取，不以声部练习文件凑数。谱面仍按当前应用的节奏网格生成，相关差异保留在逐项说明中。',
    entries,
  };
  fs.mkdirSync(path.join(DESTINATION, 'midi'), { recursive: true });
  fs.mkdirSync(path.join(DESTINATION, 'sources'), { recursive: true });
  const selectedNames = new Set(entries.map(entry => `${entry.id}.mid`));
  for (const name of fs.readdirSync(path.join(DESTINATION, 'midi'))) {
    if (/^mutopia-\d+\.mid$/.test(name) && !selectedNames.has(name)) fs.unlinkSync(path.join(DESTINATION, 'midi', name));
  }
  for (const entry of entries) fs.writeFileSync(path.join(DESTINATION, 'midi', `${entry.id}.mid`), selectedBytes.get(entry.id));
  fs.writeFileSync(path.join(DESTINATION, 'index.json'), JSON.stringify(catalog, null, 2) + '\n');
  fs.writeFileSync(path.join(DESTINATION, 'index.js'), `globalThis.ScoreCatalog = ${JSON.stringify(catalog)};\n`);
  fs.writeFileSync(path.join(DESTINATION, 'sources', 'mutopia-musiccache.dat'), sourceBytes);
  fs.writeFileSync(path.join(DESTINATION, 'build-report.json'), JSON.stringify({ sourceRecords: records.length, candidates: candidates.length, checked, selected: entries.length, licenses: entries.reduce((counts, entry) => ({ ...counts, [entry.license]: (counts[entry.license] || 0) + 1 }), {}), confirmedAlternateVersionsExcluded: SEMANTIC_DUPLICATES, rejected }, null, 2) + '\n');
  const reviewFile = path.join(DESTINATION, 'semantic-review.json');
  const review = fs.existsSync(reviewFile) ? JSON.parse(fs.readFileSync(reviewFile, 'utf8')) : {};
  Object.assign(review, {
    stage: 'preselection-review',
    explanation: '这是语义排除前1000条候选的审查快照，不是最终目录；保留groups和nearPairs用于追溯，最终1000条以index.json为准。decisions列明已确认的排除决定。',
    decisions: [
      ...[241, 447].map(excludedSourceId => ({ excludedSourceId, reason: 'Official item explicitly identifies a fragment, excluded from the complete-piece catalog.' })),
      ...[...EXCLUDED_SCOPES].map(([id, reason]) => {
        const pair = SEMANTIC_DUPLICATES.find(item => String(item.exclude) === id);
        return { excludedSourceId: Number(id), ...(pair ? { keptSourceId: pair.keep } : {}), reason };
      }),
    ],
    kind: 'pre-filter candidate-review snapshot with final decisions',
    description: '本文件的sourceCount/groups/nearPairs是语义筛选前1000条候选的审阅快照，不是当前曲库清单。当前1000条请以index.json为准。按作曲者、作品编号、标题别名和官方编配说明复核；不把同一套作品中的不同完整乐章或编号小曲按时长误删，也不声称穷尽所有音乐学同一性判断。',
    confirmedAlternateVersionsExcluded: SEMANTIC_DUPLICATES,
    otherScopeExclusions: [...EXCLUDED_SCOPES].filter(([id]) => !SEMANTIC_DUPLICATES.some(pair => String(pair.exclude) === id)).map(([sourceId, reason]) => ({ sourceId: Number(sourceId), reason })),
    clarifiedScopeTitles: entries.filter(entry => MOVEMENT_SCOPES.has(String(entry.sourceId))).map(entry => ({ sourceId: entry.sourceId, title: entry.title, scope: entry.scope })),
    finalCatalog: { count: entries.length, totalBytes: catalog.totalBytes, ids: entries.map(entry => entry.sourceId) },
  });
  fs.writeFileSync(reviewFile, JSON.stringify(review, null, 2) + '\n');
  fs.writeFileSync(path.join(DESTINATION, 'README.md'), `# 拍间离线曲库\n\n本目录包含 ${entries.length} 个不同 Mutopia 官方曲谱条目的原始主 MIDI 文件，共 ${catalog.totalBytes} 字节。曲目若是作品集中的独立曲目或乐章，其收录范围以原标题及作品编号为准。没有截取源文件，也没有用同一曲目的分声部练习文件补数。\n\n每项的来源链接、原始 MIDI 下载地址、版本、贡献者署名、许可证与许可证链接、SHA-256、总时长及验证结果保存在 index.json。index.js 是相同数据的浏览器版本。MIDI 字节未修改；界面数字谱按当前转换器的节奏网格和所选琴型生成，逐项保留校对说明。\n\n优先采用 Public Domain；不足的部分采用允许再分发的 Creative Commons 作品，完整保留署名及许可链接。请在再分发或改编时保留对应条目的来源与授权信息。原始官方批量元数据快照位于 sources/mutopia-musiccache.dat。\n\n重建：使用支持 fetch 的 Node.js 运行 node tools/build-catalog.cjs。最多 6 个并发请求，缓存默认保存在 /tmp/paijian-mutopia-catalog；可通过 PAIJIAN_CATALOG_CACHE 指定缓存目录。每个候选须通过 MIDI 完整性、完整多声部模型及播放器验证，源 ID、文件字节、移调归一化音乐事件序列和作曲者/标题/作品编号均经过重复检查。失败项记录在 build-report.json。\n`);
  fs.appendFileSync(path.join(DESTINATION, 'README.md'), `\n另对规范化作曲者与作品编号的候选分组进行了语义复核，剔除了 ${SEMANTIC_DUPLICATES.length} 个已确认的同曲不同制谱或编配版本，并排除单独主题、变奏片段及历史未完成条目。semantic-review.json 保留筛选前候选快照与最终排除决策；它不是当前条目清单，也不表示穷尽所有音乐学同一性判断。\n`);
  console.log(JSON.stringify({ phase: 'complete', count: entries.length, totalBytes: catalog.totalBytes, licenses: entries.reduce((counts, entry) => ({ ...counts, [entry.license]: (counts[entry.license] || 0) + 1 }), {}), destination: DESTINATION }));
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
