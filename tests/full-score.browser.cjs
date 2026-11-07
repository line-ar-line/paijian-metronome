const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const project = path.resolve(__dirname, '..');
const u16 = n => [n >>> 8 & 255, n & 255];
const u32 = n => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
const ascii = text => Array.from(text, character => character.charCodeAt(0));
function vlq(value) {
  const bytes = [value & 127];
  while ((value = Math.floor(value / 128))) bytes.unshift((value & 127) | 128);
  return bytes;
}
const event = (delta, ...bytes) => [...vlq(delta), ...bytes];
const chunk = (name, data) => [...ascii(name), ...u32(data.length), ...data];
const name = text => { const bytes = [...Buffer.from(text)]; return event(0, 255, 3, ...vlq(bytes.length), ...bytes); };

// Two notes are intentionally very far apart. The conductor's EOT is later
// than the melody's EOT, so the test detects truncation of either the late note
// or the metadata-only trailing silence.
function completeMidi(barCount) {
  const ppq = 480;
  const totalTicks = barCount * 4 * ppq;
  const finalNoteTick = (barCount - 1) * 4 * ppq;
  const conductor = chunk('MTrk', [
    ...name('Full work'), ...event(0, 255, 81, 3, 7, 161, 32),
    ...event(0, 255, 88, 4, 4, 2, 24, 8), ...event(totalTicks, 255, 47, 0),
  ]);
  const melody = chunk('MTrk', [
    ...name('Lead melody'), ...event(0, 0x90, 60, 100), ...event(ppq, 0x80, 60, 0),
    ...event(finalNoteTick - ppq, 0x90, 79, 100), ...event(ppq, 0x80, 79, 0),
    ...event(ppq, 255, 47, 0),
  ]);
  return Buffer.from([...chunk('MThd', [...u16(1), ...u16(2), ...u16(ppq)]), ...conductor, ...melody]);
}

function inspectArchive(filename) {
  const python = String.raw`
import json, sys, zipfile, struct, zlib, xml.etree.ElementTree as ET
results = []
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None, 'ZIP CRC validation failed'
    for entry in archive.infolist():
        data = archive.read(entry)
        result = {'name': entry.filename, 'size': len(data), 'crc': entry.CRC}
        if entry.filename.endswith('.svg'):
            root = ET.fromstring(data)
            assert root.tag == '{http://www.w3.org/2000/svg}svg'
            result['measures'] = [int(node.attrib['data-measure']) for node in root.iter() if 'data-measure' in node.attrib]
            result['text'] = ''.join(root.itertext())
        elif entry.filename.endswith('.png'):
            assert data[:8] == b'\x89PNG\r\n\x1a\n'
            result['width'], result['height'] = struct.unpack('>II', data[16:24])
            cursor = 8
            compressed = []
            while cursor < len(data):
                length = struct.unpack('>I', data[cursor:cursor+4])[0]
                kind = data[cursor+4:cursor+8]
                payload = data[cursor+8:cursor+8+length]
                crc = struct.unpack('>I', data[cursor+8+length:cursor+12+length])[0]
                assert zlib.crc32(kind + payload) & 0xffffffff == crc
                if kind == b'IDAT': compressed.append(payload)
                cursor += 12 + length
                if kind == b'IEND': break
            decoded = zlib.decompress(b''.join(compressed))
            assert len(decoded) > result['width'] * result['height']
            result['decodedBytes'] = len(decoded)
        else:
            raise AssertionError('Unexpected ZIP entry: ' + entry.filename)
        results.append(result)
print(json.dumps(results, ensure_ascii=False))
`;
  const result = spawnSync('python3', ['-c', python, filename], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('complete pieces remain intact through pagination, playback following, export, print and library navigation', { timeout: 30000 }, async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'paijian-full-score-'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      let scoreApi;
      Object.defineProperty(window, 'KalimbaScore', {
        get: () => scoreApi,
        set: value => { scoreApi = { ...value, buildScore(...args) { const score = value.buildScore(...args); window.fullTestScore = score; return score; } }; },
      });
      let Player;
      Object.defineProperty(window, 'ScorePlayer', {
        get: () => Player,
        set: Original => {
          Player = class extends Original {
            constructor(...args) { super(...args); window.fullTestPlayer = this; }
            get isPlaying() { return this.simulatePlaying || super.isPlaying; }
          };
        },
      });
      window.printCalls = 0;
      window.print = () => { window.printCalls++; };
    });
    await page.goto(pathToFileURL(path.join(project, 'score.html')).href);
    await page.locator('#example-select').selectOption('ode');
    assert.equal(await page.locator('#score-summary').innerText(), '62 个音符 · 16 小节');
    assert.deepEqual(await page.evaluate(() => ({
      total: fullTestScore.totalBeats,
      end: Math.max(...fullTestScore.notes.map(note => note.start + note.duration)),
      low: Math.min(...fullTestScore.notes.map(note => note.midi)),
      high: Math.max(...fullTestScore.notes.map(note => note.midi)),
      natural: fullTestScore.notes.every(note => [0, 2, 4, 5, 7, 9, 11].includes(note.midi % 12)),
    })), { total: 64, end: 64, low: 67, high: 79, natural: true });
    assert.equal(await page.locator('#source-label a').getAttribute('href'), 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=528');

    const fiveBeatFile = Buffer.from([
      ...chunk('MThd', [...u16(0), ...u16(1), ...u16(480)]),
      ...chunk('MTrk', [...event(0, 0x90, 60, 100), ...event(480, 0x80, 60, 0), ...event(1920, 255, 47, 0)]),
    ]);
    await page.locator('#midi-file').setInputFiles({ name: '完整五拍.mid', mimeType: 'audio/midi', buffer: fiveBeatFile });
    await page.waitForFunction(() => document.getElementById('source-label').textContent.includes('完整五拍'));
    assert.deepEqual(await page.evaluate(() => [fullTestScore.sourceTotalBeats, fullTestScore.totalBeats]), [5, 8]);
    assert.equal(await page.locator('#playback-progress').getAttribute('max'), '5', 'display must use the source duration instead of adding an extra partial bar');
    await page.locator('#score-play').click();
    await page.waitForFunction(() => fullTestPlayer.isPlaying);
    assert.equal(await page.evaluate(() => fullTestPlayer._score.totalBeats), 5, 'audio completion must use all and only the source timeline');
    await page.locator('#score-play').click();
    assert.equal(await page.evaluate(() => fullTestPlayer.isPlaying), false);

    async function upload(bars) {
      const filename = `完整测试-${bars}小节.mid`;
      await page.locator('#midi-file').setInputFiles({ name: filename, mimeType: 'audio/midi', buffer: completeMidi(bars) });
      await page.waitForFunction(name => document.getElementById('source-label').textContent.includes(name), filename);
    }
    await upload(300);
    assert.equal(Number(await page.locator('#playback-progress').inputValue()), 0, 'loading a new complete piece resets the paused position');
    assert.equal(await page.locator('#play-label').innerText(), '播放');
    assert.equal(await page.locator('#score-summary').innerText(), '2 个音符 · 300 小节');
    assert.deepEqual(await page.evaluate(() => ({ total: fullTestScore.totalBeats, source: fullTestScore.sourceTotalBeats, noteEnd: fullTestScore.sourceEndBeat, last: fullTestScore.notes.at(-1).start, pitch: fullTestScore.notes.at(-1).midi })), { total: 1200, source: 1200, noteEnd: 1197, last: 1196, pitch: 79 });
    assert.equal(await page.locator('#playback-progress').getAttribute('max'), '1200');
    assert.match(await page.locator('#full-score-info').innerText(), /已转完源文件全时长.*300 小节/);
    assert.doesNotMatch(await page.locator('#score-warnings').innerText(), /截取|截断|节选|只显示前/);
    const pageCount = await page.locator('#page-select option').count();
    assert.ok(pageCount > 1);
    const seenMeasures = [];
    for (let index = 0; index < pageCount; index++) {
      await page.locator('#page-select').selectOption(String(index));
      seenMeasures.push(...await page.locator('#score-preview [data-measure]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.measure))));
    }
    assert.deepEqual(seenMeasures, Array.from({ length: 300 }, (_, index) => index), 'every measure appears exactly once across all pages');
    assert.equal(await page.locator('#score-preview [data-measure="299"]').count(), 1);
    assert.equal(await page.locator('#score-preview [data-source-id="n1"]').count(), 1);
    assert.ok(await page.locator('#score-preview [data-measure="299"] title').filter({ hasText: '休止' }).count() > 0, 'EOT silence remains after the final note');
    assert.equal(await page.locator('#next-page').isDisabled(), true);

    // Deliver the same callbacks as the audio player without waiting ten minutes
    // for the long fixture. Real sound output is covered by workshop.browser.cjs.
    await page.locator('#page-select').selectOption('0');
    await page.evaluate(() => {
      fullTestPlayer.simulatePlaying = true;
      fullTestPlayer.onStateChange({ state: 'playing', reason: 'play' });
      fullTestPlayer.onActiveNotes({ notes: [fullTestScore.notes.at(-1)], beat: 1196.1 });
      fullTestPlayer.onProgress({ beat: 1196.1, totalBeats: 1200 });
    });
    assert.equal(await page.locator('#page-select').inputValue(), String(pageCount - 1));
    assert.equal(await page.locator('.note-group.is-active').getAttribute('data-source-id'), 'n1');
    await page.locator('#follow-pages').uncheck();
    await page.locator('#page-select').selectOption('0');
    await page.evaluate(() => fullTestPlayer.onProgress({ beat: 1196.5, totalBeats: 1200 }));
    assert.equal(await page.locator('#page-select').inputValue(), '0');
    await page.locator('#follow-pages').check();
    await page.evaluate(() => fullTestPlayer.onProgress({ beat: 1196.75, totalBeats: 1200 }));
    assert.equal(await page.locator('#page-select').inputValue(), String(pageCount - 1));
    await page.evaluate(() => {
      fullTestPlayer.onActiveNotes({ notes: [], beat: 1197.2 });
      fullTestPlayer.onProgress({ beat: 1197.2, totalBeats: 1200 });
      fullTestPlayer.simulatePlaying = false;
      fullTestPlayer.onStateChange({ state: 'stopped', reason: 'stop' });
    });
    assert.equal(await page.locator('.note-group.is-active').count(), 0);

    await upload(40);
    assert.equal(await page.locator('#page-select option').count(), 2);
    const expectedMeasures = Array.from({ length: 40 }, (_, index) => index);
    const archives = {};
    for (const format of ['svg', 'png']) {
      const downloading = page.waitForEvent('download');
      await page.locator(`#export-${format}`).click();
      const download = await downloading;
      assert.match(download.suggestedFilename(), /全部2页\.zip$/);
      const filename = path.join(output, `all-pages-${format}.zip`);
      await download.saveAs(filename);
      archives[format] = inspectArchive(filename);
      assert.equal(archives[format].length, 2);
      assert.deepEqual(archives[format].map(file => file.name), [1, 2].map(number => `完整测试-40小节-数字谱-第${String(number).padStart(3, '0')}页.${format}`));
    }
    assert.deepEqual(archives.svg.flatMap(file => file.measures), expectedMeasures);
    assert.match(archives.svg[1].text, /第 2\/2 页/);
    assert.match(archives.svg[1].text, /全曲 40 小节/);
    assert.ok(archives.svg[1].measures.includes(39));
    for (const file of archives.png) {
      assert.equal(file.width, 2080);
      assert.ok(file.height > 500 && file.height <= 2760);
      assert.ok(file.size > 10000);
    }
    assert.notEqual(archives.png[0].crc, archives.png[1].crc, 'PNG ZIP must contain distinct rendered pages');

    await page.locator('#print-score').click();
    assert.equal(await page.evaluate(() => printCalls), 1);
    assert.equal(await page.locator('#print-scores .print-page').count(), 2);
    assert.deepEqual(await page.locator('#print-scores [data-measure]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.measure))), expectedMeasures);

    await page.locator('#score-name').fill('a'.repeat(69) + '🎵');
    await page.locator('#score-name').press('Tab');
    const emojiExport = page.waitForEvent('download');
    await page.locator('#export-svg').click();
    const emojiDownload = await emojiExport;
    const emojiArchive = path.join(output, 'unicode-pages.zip');
    await emojiDownload.saveAs(emojiArchive);
    const emojiEntries = inspectArchive(emojiArchive);
    assert.equal(emojiEntries.length, 2);
    assert.ok(emojiEntries.every(entry => entry.name.includes('🎵')), 'long titles must not split Unicode before ZIP encoding');
    assert.deepEqual(emojiEntries.flatMap(entry => entry.measures), expectedMeasures);

    const oldScore = await page.locator('#score-preview').innerHTML();
    await page.evaluate(() => {
      const input = document.getElementById('midi-file');
      Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'too-large.mid', size: 20 * 1024 * 1024 + 1, arrayBuffer() { throw new Error('oversized files must not be read'); } }] });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      delete input.files;
    });
    assert.match(await page.locator('#workshop-message').innerText(), /超过 20 MB.*未生成部分乐谱/);
    assert.equal(await page.locator('#score-preview').innerHTML(), oldScore);

    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `score page has no document overflow at ${width}px`);
      if (width === 390) await page.screenshot({ path: path.join(output, 'score-390.png'), fullPage: true });
    }

    await page.goto(pathToFileURL(path.join(project, 'library.html')).href);
    assert.equal(await page.locator('.library-card').count(), 4);
    assert.deepEqual(await page.locator('.library-card h3').allTextContents(), ['PDMX', 'Lakh MIDI Dataset', 'MAESTRO', 'GiantMIDI-Piano']);
    assert.match(await page.locator('.library-card').filter({ hasText: 'PDMX' }).innerText(), /222,856.*no_license_conflict/s);
    const form = page.locator('.library-search form');
    assert.equal(await form.getAttribute('action'), 'https://www.mutopiaproject.org/cgibin/make-table.cgi');
    assert.equal(await form.getAttribute('method'), 'get');
    assert.equal(await form.getAttribute('target'), '_blank');
    assert.equal(await page.locator('#library-query').getAttribute('name'), 'searchingfor');
    const destinations = await page.locator('.library-links a').evaluateAll(nodes => nodes.map(node => node.href));
    assert.deepEqual(destinations, ['https://zenodo.org/records/15571083', 'https://github.com/pnlong/PDMX', 'https://colinraffel.com/projects/lmd', 'https://magenta.tensorflow.org/datasets/maestro', 'https://github.com/bytedance/GiantMIDI-Piano']);
    assert.ok(await page.locator('a[target="_blank"]').evaluateAll(nodes => nodes.every(node => node.rel.includes('noopener'))));
    // Check the browser's actual query encoding without contacting Mutopia.
    await context.route('https://www.mutopiaproject.org/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Search destination verified</title>' }));
    await page.locator('#library-query').fill('Ode to Joy & Beethoven');
    const opening = context.waitForEvent('page');
    await form.locator('button').click();
    const search = await opening;
    await search.waitForLoadState('domcontentloaded');
    const searchedUrl = new URL(search.url());
    assert.equal(searchedUrl.origin + searchedUrl.pathname, 'https://www.mutopiaproject.org/cgibin/make-table.cgi');
    assert.equal(searchedUrl.searchParams.get('searchingfor'), 'Ode to Joy & Beethoven');
    await search.close();
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `library has no document overflow at ${width}px`);
      if (width === 390) await page.screenshot({ path: path.join(output, 'library-390.png'), fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log(`Verified complete Ode, 300-bar MIDI with late notes/EOT rests, all-page navigation, following, 40-bar PNG/SVG ZIPs and print coverage, file limit, source search, and mobile layouts. QA outputs: ${output}`);
  } finally {
    await browser.close();
    if (process.env.KEEP_FULL_SCORE_QA !== '1') await rm(output, { recursive: true, force: true });
  }
});
