const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const project = path.resolve(__dirname, '..');
const u16 = value => [value >>> 8 & 255, value & 255];
const u32 = value => [value >>> 24 & 255, value >>> 16 & 255, value >>> 8 & 255, value & 255];
const ascii = text => Array.from(text, character => character.charCodeAt(0));
function vlq(value) {
  const bytes = [value & 127];
  while ((value = Math.floor(value / 128))) bytes.unshift((value & 127) | 128);
  return bytes;
}
const event = (delta, ...bytes) => [...vlq(delta), ...bytes];
const chunk = (name, bytes) => [...ascii(name), ...u32(bytes.length), ...bytes];
const trackName = text => { const bytes = [...Buffer.from(text)]; return event(0, 255, 3, ...vlq(bytes.length), ...bytes); };
function makeMidi(tracks, totalBeats) {
  const ppq = 480;
  const conductor = chunk('MTrk', [...event(0, 255, 81, 3, 7, 161, 32), ...event(0, 255, 88, 4, 4, 2, 24, 8), ...event(totalBeats * ppq, 255, 47, 0)]);
  const music = tracks.map(({ name, channel, notes }) => {
    const events = notes.flatMap(([midi, start, duration]) => [
      { tick: start * ppq, off: false, bytes: [0x90 + channel, midi, 100] },
      { tick: (start + duration) * ppq, off: true, bytes: [0x80 + channel, midi, 0] },
    ]).sort((a, b) => a.tick - b.tick || Number(b.off) - Number(a.off));
    let tick = 0;
    const bytes = [...trackName(name)];
    for (const item of events) { bytes.push(...event(item.tick - tick, ...item.bytes)); tick = item.tick; }
    bytes.push(...event(totalBeats * ppq - tick, 255, 47, 0));
    return chunk('MTrk', bytes);
  });
  return Buffer.from([...chunk('MThd', [...u16(1), ...u16(tracks.length + 1), ...u16(ppq)]), ...conductor, ...music.flat()]);
}
const lead = [[72, 0, 3], [76, 0, 1], [74, 1, 1], [77, 3, 2]];
const accompaniment = [[60, 0, 5], [64, 0, 2], [67, 2, 3]];
const chordFile = () => makeMidi([
  { name: 'Lead melody', channel: 0, notes: lead },
  { name: 'Accompaniment', channel: 1, notes: accompaniment },
  { name: 'Drums', channel: 9, notes: [[38, 0, .5]] },
], 5);
const ordered = notes => [...notes].sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);

function inspectZip(filename) {
  const code = String.raw`
import json, sys, zipfile, struct, xml.etree.ElementTree as ET
rows = []
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None
    for info in archive.infolist():
        data = archive.read(info)
        row = {'name': info.filename, 'size': len(data), 'crc': info.CRC}
        assert '\ufffd' not in info.filename
        if info.filename.endswith('.svg'):
            root = ET.fromstring(data)
            row['measures'] = [int(node.attrib['data-measure']) for node in root.iter() if 'data-measure' in node.attrib]
            row['sourceIds'] = sorted(set(node.attrib['data-source-id'] for node in root.iter() if node.attrib.get('data-source-id')))
            row['voices'] = sorted(set(node.attrib['data-voice-index'] for node in root.iter() if 'data-voice-index' in node.attrib))
            row['text'] = ''.join(root.itertext())
        else:
            assert data[:8] == b'\x89PNG\r\n\x1a\n'
            row['width'], row['height'] = struct.unpack('>II', data[16:24])
        rows.append(row)
print(json.dumps(rows, ensure_ascii=False))
`;
  const result = spawnSync('python3', ['-c', code, filename], { encoding: 'utf8', maxBuffer: 3 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('polyphonic scores retain chords, independent durations, merged tracks and all exported voices', { timeout: 30000 }, async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'paijian-polyphony-'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      let scoreApi;
      Object.defineProperty(window, 'KalimbaScore', {
        get: () => scoreApi,
        set: value => {
          scoreApi = { ...value, buildScore(notes, options) {
            const result = value.buildScore(notes, options);
            window.polyInput = notes.map(note => [note.midi, note.start, note.duration]);
            window.polyScore = result;
            return result;
          } };
        },
      });
      let Player;
      Object.defineProperty(window, 'ScorePlayer', {
        get: () => Player,
        set: Original => {
          Player = class extends Original {
            constructor(callbacks, dependencies) {
              super({ ...callbacks, onActiveNotes(event) {
                window.polyActivePitches = event.notes.map(note => note.midi).sort((a, b) => a - b);
                callbacks.onActiveNotes?.(event);
              } }, dependencies);
              window.polyPlayer = this;
            }
            async play(...args) { window.polyPlucks = []; window.polyActivePitches = []; return super.play(...args); }
            _pluck(note, time, duration) { window.polyPlucks.push({ midi: note.midi, start: note.start, duration: note.duration }); return super._pluck(note, time, duration); }
          };
        },
      });
      window.print = () => {};
    });
    await page.goto(pathToFileURL(path.join(project, 'score.html')).href);
    assert.equal(await page.locator('#score-mode').inputValue(), 'polyphonic');
    await page.locator('#example-select').selectOption('ode-duet');
    const demo = await page.evaluate(() => ({ count: polyScore.notes.length, input: polyInput.length, bars: polyScore.bars.length, duration: polyScore.sourceTotalBeats, voices: polyScore.stats.voiceCount, maxPolyphony: polyScore.stats.maxPolyphony, dropped: polyScore.stats.removedPolyphony, clipped: polyScore.stats.clippedOverlaps, notes: polyScore.notes.map(note => [note.midi, note.start, note.duration]), original: polyInput }));
    assert.ok(demo.count > 62, 'duet includes accompaniment in addition to the complete melody');
    assert.equal(demo.count, demo.input);
    assert.equal(demo.bars, 16);
    assert.equal(demo.duration, 64);
    assert.ok(demo.voices >= 2 && demo.maxPolyphony >= 2);
    assert.equal(demo.dropped, 0);
    assert.equal(demo.clipped, 0);
    assert.deepEqual(ordered(demo.notes), ordered(demo.original));
    assert.ok(await page.locator('.note-group[data-voice-index]').count() > 0);
    await page.screenshot({ path: path.join(output, 'duet-desktop.png'), fullPage: true });

    await page.locator('#midi-file').setInputFiles({ name: 'independent-chords.mid', mimeType: 'audio/midi', buffer: chordFile() });
    await page.waitForFunction(() => document.getElementById('source-label').textContent.includes('independent-chords.mid'));
    assert.equal(await page.locator('#track-select').inputValue(), '__all__');
    assert.equal(await page.locator('#track-select option').count(), 3, 'all-pitched option plus two music tracks, with drums excluded');
    assert.deepEqual(ordered(await page.evaluate(() => polyScore.notes.map(note => [note.midi, note.start, note.duration]))), ordered([...lead, ...accompaniment]));
    assert.deepEqual(await page.evaluate(() => ({ source: polyScore.sourceTotalBeats, padded: polyScore.totalBeats, count: polyScore.notes.length, dropped: polyScore.stats.removedPolyphony, clipped: polyScore.stats.clippedOverlaps, simultaneous: polyScore.stats.maxPolyphony })), { source: 5, padded: 8, count: 7, dropped: 0, clipped: 0, simultaneous: 4 });
    assert.equal(await page.locator('#playback-progress').getAttribute('max'), '5', 'playback uses actual source duration, not padded final bar');
    const onsetPositions = await page.evaluate(() => polyScore.notes.filter(note => note.start === 0).map(note => {
      const node = Array.from(document.querySelectorAll('#score-preview [data-measure="0"] .note-group')).find(group => group.dataset.sourceId === note.sourceId);
      const number = node.querySelector('.note-number');
      return { x: Number(number.getAttribute('x')), y: Number(number.getAttribute('y')), voice: node.dataset.voiceIndex };
    }));
    assert.equal(new Set(onsetPositions.map(note => note.voice)).size, 4);
    assert.equal(new Set(onsetPositions.map(note => note.y)).size, 4);
    assert.ok(onsetPositions.every(note => Math.abs(note.x - onsetPositions[0].x) < .001), 'simultaneous notes align horizontally across separate lanes');

    const activePitchesInDOM = () => page.evaluate(() => {
      const active = new Set(Array.from(document.querySelectorAll('#score-preview .note-group.is-active')).map(node => node.dataset.sourceId));
      return polyScore.notes.filter(note => active.has(note.sourceId)).map(note => note.midi).sort((a, b) => a - b);
    });
    await page.locator('#score-play').click();
    await page.waitForFunction(() => polyActivePitches.join(',') === '60,64,72,76');
    assert.deepEqual(await activePitchesInDOM(), [60, 64, 72, 76]);
    assert.ok(await page.evaluate(() => polyPlayer._voices.size > 3), 'the audio engine must synthesize the chord, not just one note');
    assert.equal(await page.evaluate(() => polyPlayer._score.totalBeats), 5);
    await page.waitForFunction(() => polyActivePitches.join(',') === '60,64,72,74');
    assert.deepEqual(await activePitchesInDOM(), [60, 64, 72, 74], 'short upper note ends while longer notes remain active');
    await page.waitForFunction(() => polyActivePitches.join(',') === '60,67,72');
    assert.deepEqual(await activePitchesInDOM(), [60, 67, 72]);
    await page.waitForFunction(() => polyActivePitches.join(',') === '60,67,77');
    assert.deepEqual(await activePitchesInDOM(), [60, 67, 77]);
    await page.waitForFunction(() => document.getElementById('playback-status').textContent.includes('试听结束'));
    assert.equal(await page.locator('#playback-progress').getAttribute('value'), '5');
    assert.equal(await page.locator('.note-group.is-active').count(), 0);
    assert.equal(await page.evaluate(() => polyPlayer._voices.size), 0);
    assert.deepEqual(ordered(await page.evaluate(() => polyPlucks.map(note => [note.midi, note.start, note.duration]))), ordered([...lead, ...accompaniment]), 'each retained note is plucked exactly once, including sustained cross-bar notes');

    await page.locator('#track-select').selectOption('1:0');
    assert.deepEqual(ordered(await page.evaluate(() => polyScore.notes.map(note => [note.midi, note.start, note.duration]))), ordered(lead));
    await page.locator('#track-select').selectOption('__all__');
    assert.equal(await page.evaluate(() => polyScore.notes.length), 7);
    await page.locator('#score-play').click();
    await page.waitForFunction(() => polyPlayer.isPlaying && polyActivePitches.length > 1);
    await page.locator('#score-mode').selectOption('melody');
    assert.equal(await page.evaluate(() => polyPlayer.isPlaying), false, 'changing score mode stops stale polyphonic playback');
    assert.equal(await page.evaluate(() => polyPlayer._voices.size), 0);
    assert.equal(await page.locator('.note-group.is-active').count(), 0);
    assert.deepEqual(ordered(await page.evaluate(() => polyScore.notes.map(note => [note.midi, note.start, note.duration]))), ordered([[76, 0, 1], [74, 1, 1], [67, 2, 1], [77, 3, 2]]));
    assert.match(await page.locator('#score-warnings').innerText(), /省略|简化/);
    await page.locator('#score-mode').selectOption('polyphonic');
    assert.deepEqual(ordered(await page.evaluate(() => polyScore.notes.map(note => [note.midi, note.start, note.duration]))), ordered([...lead, ...accompaniment]), 'switching back restores every original note and duration');

    // Export a genuine multi-page two-voice piece, including its final chord.
    const upper = Array.from({ length: 40 }, (_, index) => [72 + [0, 2, 4, 5][index % 4], index * 4, 4]);
    const lower = Array.from({ length: 40 }, (_, index) => [60 + [0, 5, 7, 0][index % 4], index * 4, 4]);
    await page.locator('#midi-file').setInputFiles({ name: '完整合奏.mid', mimeType: 'audio/midi', buffer: makeMidi([{ name: 'Upper', channel: 0, notes: upper }, { name: 'Lower', channel: 1, notes: lower }], 160) });
    await page.waitForFunction(() => document.getElementById('source-label').textContent.includes('完整合奏.mid'));
    assert.equal(await page.evaluate(() => polyScore.notes.length), 80);
    const title = 'a'.repeat(69) + '😀';
    await page.locator('#score-name').fill(title);
    await page.locator('#score-name').press('Tab');
    const pages = await page.locator('#page-select option').count();
    assert.ok(pages > 1);
    const archives = {};
    for (const format of ['svg', 'png']) {
      const pending = page.waitForEvent('download');
      await page.locator(`#export-${format}`).click();
      const download = await pending;
      assert.ok(download.suggestedFilename().includes('😀'));
      assert.ok(download.suggestedFilename().endsWith('.zip'));
      const filename = path.join(output, `polyphonic-${format}.zip`);
      await download.saveAs(filename);
      archives[format] = inspectZip(filename);
      assert.equal(archives[format].length, pages);
      assert.ok(archives[format].every(file => file.name.includes('😀') && file.name.endsWith(`.${format}`)));
    }
    const allMeasures = archives.svg.flatMap(file => file.measures);
    assert.deepEqual([...new Set(allMeasures)], Array.from({ length: 40 }, (_, index) => index));
    const allSourceIds = new Set(archives.svg.flatMap(file => file.sourceIds));
    assert.equal(allSourceIds.size, 80, 'all voices and the complete final chord are exported');
    assert.ok(archives.svg.every(file => file.voices.length >= 2));
    assert.ok(archives.svg.at(-1).measures.includes(39));
    assert.ok(archives.png.every(file => file.width >= 2080 && file.height > 500 && file.height <= 2760 && file.size > 10000));
    assert.equal(new Set(archives.png.map(file => file.crc)).size, pages);
    await page.locator('#print-score').click();
    assert.equal(await page.locator('#print-scores .print-page').count(), pages);
    assert.equal(await page.locator('#print-scores [data-source-id]').evaluateAll(nodes => new Set(nodes.map(node => node.dataset.sourceId).filter(Boolean)).size), 80);

    await page.locator('#example-select').selectOption('ode-duet');
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `polyphonic UI must fit ${width}px`);
      if (width === 390) await page.screenshot({ path: path.join(output, 'duet-mobile.png'), fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log(`Verified full polyphonic demo, overlapping chords, independent releases, merged tracks, source-duration playback, lane alignment, mode restoration, Unicode multi-page exports and mobile layout. QA outputs: ${output}`);
  } finally {
    await browser.close();
    if (process.env.KEEP_POLYPHONY_QA !== '1') await rm(output, { recursive: true, force: true });
  }
});
