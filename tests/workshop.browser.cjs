const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const project = path.resolve(__dirname, '..');
const u16 = n => [n >>> 8 & 255, n & 255];
const u32 = n => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
const ascii = value => Array.from(value, character => character.charCodeAt(0));
function vlq(value) {
  const result = [value & 127];
  while ((value = Math.floor(value / 128))) result.unshift((value & 127) | 128);
  return result;
}
const event = (delta, ...bytes) => [...vlq(delta), ...bytes];
const chunk = (name, data) => [...ascii(name), ...u32(data.length), ...data];
const track = (...events) => chunk('MTrk', [...events.flat(), ...event(0, 255, 47, 0)]);
const name = value => { const bytes = [...Buffer.from(value)]; return event(0, 255, 3, ...vlq(bytes.length), ...bytes); };
function syntheticMidi() {
  const tracks = [
    track(name('Browser acceptance'), event(0, 255, 81, 3, 3, 208, 144), event(0, 255, 88, 4, 3, 2, 24, 8)), // 240 BPM, 3/4.
    track(name('Accompaniment'), event(0, 0xc0, 1), event(0, 0x90, 48, 90), event(1440, 0x80, 48, 0), event(0, 0x90, 55, 90), event(1440, 0x80, 55, 0)),
    track(name('Lead melody'), event(0, 0xc1, 10), event(0, 0x91, 60, 100), event(480, 0x81, 60, 0), event(480, 0x91, 63, 100), event(240, 0x81, 63, 0), event(0, 0x91, 48, 100), event(480, 0x81, 48, 0), event(480, 0x91, 67, 100), event(240, 0x81, 67, 0)),
    track(name('Drums'), event(0, 0x99, 38, 100), event(240, 0x89, 38, 0)),
  ];
  return Buffer.from([...chunk('MThd', [...u16(1), ...u16(tracks.length), ...u16(480)]), ...tracks.flat()]);
}

test('workshop imports, renders, plays, exports, and handles errors on desktop and mobile', { timeout: 30000 }, async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'paijian-workshop-'));
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
          scoreApi = { ...value, buildScore(...args) { const result = value.buildScore(...args); window.acceptanceScore = result; return result; } };
        },
      });
      let Player;
      Object.defineProperty(window, 'ScorePlayer', {
        get: () => Player,
        set: Original => {
          Player = class extends Original {
            constructor(...args) { super(...args); window.acceptancePlayer = this; }
          };
        },
      });
    });
    await page.goto(pathToFileURL(path.join(project, 'score.html')).href);
    assert.equal(await page.locator('#score-summary').innerText(), '42 个音符 · 12 小节');
    assert.equal(await page.locator('[data-measure]').count(), 12);
    assert.equal(await page.locator('.note-group.unplayable').count(), 0);
    const demo = await page.evaluate(() => acceptanceScore.notes.map(({ midi, start, duration }) => ({ midi, start, duration })));

    await page.locator('#midi-file').setInputFiles(path.join(project, 'examples/twinkle.mid'));
    await page.waitForFunction(() => document.getElementById('source-label').textContent.includes('twinkle.mid'));
    assert.deepEqual(await page.evaluate(() => acceptanceScore.notes.map(({ midi, start, duration }) => ({ midi, start, duration }))), demo);
    assert.equal(await page.locator('#score-summary').innerText(), '42 个音符 · 12 小节');

    const uploaded = syntheticMidi();
    await page.locator('#midi-file').setInputFiles({ name: 'browser-melody.mid', mimeType: 'audio/midi', buffer: uploaded });
    await page.waitForFunction(() => document.getElementById('source-label').textContent.includes('browser-melody.mid'));
    assert.equal(await page.locator('#track-select option').count(), 2, 'drum tracks must be excluded');
    assert.equal(await page.locator('#track-select').inputValue(), '2:1', 'a named melody should be selected ahead of accompaniment');
    assert.equal(await page.locator('#score-bpm').inputValue(), '240');
    assert.equal(await page.locator('#score-meter').inputValue(), '3/4');
    assert.deepEqual(await page.evaluate(() => acceptanceScore.notes.map(({ midi, start, duration }) => [midi, start, duration])), [[60, 0, 1], [63, 2, .5], [48, 2.5, 1], [67, 4.5, .5]]);
    assert.equal(await page.locator('#score-summary').innerText(), '4 个音符 · 2 小节');
    assert.ok(await page.locator('.note-group.unplayable').count() >= 2);
    assert.equal(await page.locator('.accidental').textContent(), '#');
    assert.ok(await page.locator('.tie').count() >= 1, 'cross-bar held notes must have a tie');
    assert.ok(await page.locator('.note-group title').filter({ hasText: '休止' }).count() >= 2);
    assert.match(await page.locator('#score-warnings').innerText(), /2 个旋律音.*橙色/s);
    assert.equal(await page.locator('.note-group.unplayable .note-number').first().evaluate(node => getComputedStyle(node).fill), 'rgb(177, 99, 55)');

    // Real Web Audio and real progress frames: a rest must clear the old note.
    await page.locator('#score-play').click();
    await page.waitForFunction(() => acceptancePlayer.isPlaying && document.querySelector('.note-group.is-active'));
    assert.equal(await page.evaluate(() => acceptancePlayer._context.state), 'running');
    assert.ok(await page.evaluate(() => acceptancePlayer._voices.size > 0));
    await page.waitForFunction(() => { const beat = document.getElementById('playback-progress').value; return beat > 1.1 && beat < 1.9; });
    assert.equal(await page.locator('.note-group.is-active').count(), 0, 'a silent gap must not highlight the previous note');
    await page.locator('#score-play').click();
    assert.equal(await page.evaluate(() => acceptancePlayer.isPlaying), false);
    assert.equal(await page.evaluate(() => acceptancePlayer._voices.size), 0);
    assert.equal(await page.locator('#score-play').getAttribute('aria-pressed'), 'false');
    await page.locator('#score-play').click();
    await page.waitForFunction(() => document.getElementById('playback-status').textContent.includes('试听结束'));
    assert.equal(await page.locator('.note-group.is-active').count(), 0);
    assert.equal(await page.evaluate(() => acceptancePlayer._voices.size), 0);
    assert.equal(await page.locator('#playback-progress').getAttribute('value'), '6');

    await page.locator('#track-select').selectOption('1:0');
    assert.deepEqual(await page.evaluate(() => acceptanceScore.notes.map(note => note.midi)), [48, 55]);
    await page.locator('#suggest-transpose').click();
    assert.equal(await page.locator('#transpose').inputValue(), '12');
    assert.deepEqual(await page.evaluate(() => acceptanceScore.notes.map(note => note.midi)), [60, 67]);
    assert.equal(await page.locator('.note-group.unplayable').count(), 0);

    // Keep the existing usable score when a newly uploaded file is malformed.
    const beforeInvalid = await page.locator('#score-preview').innerHTML();
    await page.locator('#midi-file').setInputFiles({ name: 'broken.mid', mimeType: 'audio/midi', buffer: uploaded.subarray(0, uploaded.length - 1) });
    await page.waitForFunction(() => document.getElementById('workshop-message').dataset.kind === 'error');
    assert.match(await page.locator('#workshop-message').innerText(), /不完整|截断/);
    assert.equal(await page.locator('#score-preview').innerHTML(), beforeInvalid);

    const hostileTitle = '曲谱 <script>alert("x")</script> & 测试';
    await page.locator('#score-name').fill(hostileTitle);
    await page.locator('#score-name').press('Tab');
    assert.equal(await page.locator('#score-preview script').count(), 0);
    assert.equal(await page.locator('.score-heading').first().textContent(), hostileTitle.slice(0, 32));
    const svgDownload = page.waitForEvent('download');
    await page.locator('#export-svg').click();
    const svgFile = await svgDownload;
    assert.ok(svgFile.suggestedFilename().endsWith('.svg'));
    await svgFile.saveAs(path.join(output, 'score.svg'));
    const svg = await readFile(path.join(output, 'score.svg'), 'utf8');
    assert.match(svg, /&lt;script&gt;/);
    const xmlCheck = await page.evaluate(source => {
      const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
      return { root: doc.documentElement.localName, errors: doc.querySelectorAll('parsererror').length, scripts: doc.querySelectorAll('script').length, title: doc.querySelector('title').textContent };
    }, svg);
    assert.equal(xmlCheck.root, 'svg');
    assert.equal(xmlCheck.errors, 0);
    assert.equal(xmlCheck.scripts, 0);
    assert.ok(xmlCheck.title.includes(hostileTitle));

    await page.locator('#score-name').fill('长'.repeat(80));
    await page.locator('#score-name').press('Tab');
    assert.equal(await page.locator('.score-heading').count(), 3);
    assert.ok(await page.locator('.score-heading').evaluateAll(nodes => nodes.every(node => { const box = node.getBBox(); const width = node.ownerSVGElement.viewBox.baseVal.width; return box.x >= 0 && box.x + box.width <= width; })));
    const pngDownload = page.waitForEvent('download');
    await page.locator('#export-png').click();
    const pngFile = await pngDownload;
    assert.ok(pngFile.suggestedFilename().endsWith('.png'));
    await pngFile.saveAs(path.join(output, 'score.png'));
    const png = await readFile(path.join(output, 'score.png'));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(png.readUInt32BE(16), 2080);
    assert.ok(png.readUInt32BE(20) > 600 && png.readUInt32BE(20) <= 16000);
    assert.ok(png.length > 10000, 'download must contain rendered image data');

    await page.locator('#example-select').selectOption('twinkle');
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page must not overflow horizontally at ${width}px`);
      assert.ok(await page.locator('#score-preview').evaluate(node => node.scrollWidth >= node.clientWidth), 'score has its own scroll container');
      await page.screenshot({ path: path.join(output, `workshop-${width}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log(`Verified workshop imports, pitch/rhythm mapping, real audio and rests, transpose, SVG/PNG exports, title escaping, errors, and mobile layout. Temporary QA outputs: ${output}`);
  } finally {
    await browser.close();
    if (process.env.KEEP_WORKSHOP_QA !== '1') await rm(output, { recursive: true, force: true });
  }
});
