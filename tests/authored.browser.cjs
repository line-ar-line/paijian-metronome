const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { chromium } = require('playwright');
const ScoreDocument = require('../score/document.js');

const root = path.resolve(__dirname, '..');
const prefix = '/paijian-metronome/';
const source = JSON.parse(fs.readFileSync(path.join(root, 'scores/heixiu-rhapsody.json'), 'utf8'));
const expected = ScoreDocument.compile(source);

async function serve() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.mid': 'audio/midi' };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = path.resolve(root, pathname.slice(prefix.length));
    if (!pathname.startsWith(prefix) || !filename.startsWith(root + path.sep)) { response.writeHead(404); response.end(); return; }
    try {
      const data = fs.readFileSync(filename);
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' });
      response.end(data);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}${prefix}` };
}

test('bundled authored score works with all score JSON requests blocked, preserving pages, playback, favorites and downloads', { timeout: 45000 }, async () => {
  const { server, base } = await serve();
  const output = fs.mkdtempSync(path.join(tmpdir(), 'paijian-authored-qa-'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const blockedJsonRequests = [];
    await context.route('**/scores/*.json*', route => { blockedJsonRequests.push(route.request().url()); return route.abort('failed'); });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      let Player;
      Object.defineProperty(window, 'ScorePlayer', {
        get: () => Player,
        set: Original => {
          Player = class extends Original {
            constructor(callbacks, dependencies) { super(callbacks, dependencies); window.authoredPlayer = this; }
            play(notes, options) {
              window.authoredPlaybackInput = { notes: structuredClone(notes), options: { ...options } };
              return super.play(notes, options);
            }
          };
        },
      });
    });
    const scoreUrl = base + 'score.html?score=heixiu-rhapsody';
    await page.goto(scoreUrl);
    await page.waitForFunction(() => document.getElementById('score-summary').textContent.includes('189 个音符'));
    assert.match(await page.locator('#score-summary').innerText(), /189 个音符 · 29 小节/);
    assert.match(await page.locator('#full-score-info').innerText(), /谱面 29 小节 \/ 5 页 · 含反复播放 37 小节/);
    assert.equal(await page.locator('#score-name').inputValue(), '嘿咻狂想曲');
    assert.equal(await page.locator('#page-select option').count(), 5);
    for (const id of ['score-mode', 'score-meter', 'transpose', 'suggest-transpose']) assert.equal(await page.locator('#' + id).isDisabled(), true);

    const pages = [];
    for (let i = 0; i < 5; i++) {
      await page.locator('#page-select').selectOption(String(i));
      pages.push(await page.locator('#score-preview').evaluate(node => ({
        ids: [...node.querySelectorAll('.note-group[data-source-id]')].map(item => item.dataset.sourceId).filter(Boolean),
        bars: [...node.querySelectorAll('[data-measure]')].map(item => Number(item.dataset.measure)),
        glissandi: node.querySelectorAll('.glissando').length,
        repeatStarts: [...node.querySelectorAll('.repeat-start')].map(item => Number(item.closest('[data-measure]').dataset.measure)),
        repeatEnds: [...node.querySelectorAll('.repeat-end')].map(item => Number(item.closest('[data-measure]').dataset.measure)),
        voices: [...new Set([...node.querySelectorAll('.note-group[data-voice-index]')].map(item => item.dataset.voiceIndex))],
        text: node.textContent,
      })));
    }
    assert.deepEqual([...new Set(pages.flatMap(p => p.ids))].sort(), expected.score.notes.map(n => n.sourceId).sort(), 'all 189 distinct original notes survive browser pagination');
    assert.equal(new Set(pages.flatMap(p => p.ids)).size, 189);
    assert.deepEqual(pages.flatMap(p => p.bars), Array.from({ length: 29 }, (_, i) => i));
    assert.equal(pages.reduce((count, p) => count + p.glissandi, 0), 12);
    assert.deepEqual(pages.flatMap(p => p.repeatStarts), [12]);
    assert.deepEqual(pages.flatMap(p => p.repeatEnds), [19]);
    assert.ok(pages.every(p => p.voices.length === 2 && p.text.includes('来音制谱app')), 'every page keeps both voices and original-source attribution');
    const glissandoPage = pages.reduce((best, p, i) => p.glissandi > pages[best].glissandi ? i : best, 0);
    await page.locator('#page-select').selectOption(String(glissandoPage));
    await page.locator('#score-preview').screenshot({ path: path.join(output, 'heixiu-glissando-desktop.png') });

    await page.locator('#follow-pages').check();
    await page.locator('#score-play').click();
    await page.waitForFunction(() => authoredPlayer.isPlaying && authoredPlayer._voices.size > 0);
    await page.waitForFunction(() => Number(document.getElementById('playback-progress').value) > 0.1);
    const playback = await page.evaluate(() => authoredPlaybackInput);
    assert.equal(playback.notes.length, 245);
    assert.equal(playback.options.totalBeats, 148);
    assert.equal(playback.options.bpm, 100);
    assert.deepEqual(playback.notes, expected.playbackNotes);
    assert.equal(await page.evaluate(() => authoredPlayer._context.state), 'running', 'the real Web Audio player starts');
    await page.locator('#page-select').selectOption('4');
    // Simulate the progress callback synchronously instead of waiting 48 seconds.
    // The real player remains active; read the DOM in the same task to avoid a frame race.
    const repeated = await page.evaluate(() => {
      authoredPlayer.onProgress({ beat: 80, totalBeats: 148 });
      return {
        status: document.getElementById('playback-status').textContent,
        page: document.getElementById('page-select').value,
        bar13Visible: !!document.querySelector('#score-preview [data-measure="12"]'),
        progress: Number(document.getElementById('playback-progress').value),
      };
    });
    assert.match(repeated.status, /第 13 \/ 29 小节/);
    assert.equal(repeated.bar13Visible, true);
    assert.equal(repeated.page, String(pages.findIndex(p => p.bars.includes(12))));
    assert.equal(repeated.progress, 80);
    await page.locator('#score-play').click();
    assert.equal(await page.evaluate(() => authoredPlayer.isPlaying), false);
    assert.equal(await page.locator('#play-label').innerText(), '继续播放');
    assert.ok(Number(await page.locator('#playback-progress').inputValue()) > 0, 'pausing an authored score retains its position');

    assert.equal(await page.locator('#favorite-score').getAttribute('aria-pressed'), 'false');
    await page.evaluate(() => ScoreUserLibrary.set('mutopia-528', true));
    await page.locator('#favorite-score').click();
    assert.equal(await page.locator('#favorite-score').getAttribute('aria-pressed'), 'true');
    const library = await context.newPage();
    library.on('pageerror', error => errors.push(error.message));
    await library.goto(base + 'library.html?favorites=1');
    assert.equal(await library.locator('.catalog-piece').count(), 2);
    assert.equal(await library.locator('.catalog-piece').first().getAttribute('data-piece-id'), 'heixiu-rhapsody');
    assert.match(await library.locator('.catalog-piece').first().innerText(), /嘿咻狂想曲/);
    await library.close();

    assert.equal(await page.locator('#edit-authored').getAttribute('href'), 'composer.html?score=heixiu-rhapsody');
    assert.equal(await page.locator('#edit-authored').isVisible(), true);
    await page.locator('#original-score summary').click();
    await page.locator('#original-image').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => { const image = document.getElementById('original-image'); return image.complete && image.naturalWidth > 0; });
    assert.match(await page.locator('#original-image').getAttribute('src'), /scores\/heixiu-rhapsody-original\.jpg$/);
    assert.equal(await page.locator('#original-link').getAttribute('href'), 'scores/heixiu-rhapsody-original.jpg');
    const pendingDownload = page.waitForEvent('download');
    await page.locator('#export-json').click();
    const download = await pendingDownload;
    const exported = path.join(output, 'heixiu-rhapsody-exported.json');
    await download.saveAs(exported);
    assert.ok(download.suggestedFilename().endsWith('.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(exported, 'utf8')), ScoreDocument.normalize(source), 'export includes the complete notation, repeats, attribution and description');

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `authored score and expanded original image fit ${width}px`);
    }
    await page.locator('#example-select').selectOption('twinkle');
    assert.match(await page.locator('#score-summary').innerText(), /42 个音符 · 12 小节/);
    assert.equal(await page.locator('#favorite-score').isDisabled(), true);
    assert.equal(await page.locator('#favorite-score').getAttribute('aria-pressed'), 'false');
    for (const id of ['original-score', 'edit-authored', 'export-json']) assert.equal(await page.locator('#' + id).isVisible(), false);
    for (const id of ['score-mode', 'score-meter', 'transpose', 'suggest-transpose']) assert.equal(await page.locator('#' + id).isDisabled(), false);
    assert.equal(await page.locator('#score-preview .glissando, #score-preview .repeat-start, #score-preview .repeat-end').count(), 0);
    assert.match(await page.locator('#full-score-info').innerText(), /12 小节/);
    assert.doesNotMatch(await page.locator('#full-score-info').innerText(), /含反复播放|完整编配/);

    await page.goto(scoreUrl);
    await page.waitForFunction(() => document.getElementById('score-summary').textContent.includes('189 个音符'));
    assert.equal(await page.locator('#favorite-score').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#original-score').isVisible(), true);
    assert.equal(await page.locator('#page-select option').count(), 5);
    await page.goto(base + 'score.html?score=nonexistent-score');
    await page.waitForFunction(() => document.getElementById('workshop-message').dataset.kind === 'error');
    assert.match(await page.locator('#workshop-message').innerText(), /没有找到这份已发布曲谱/);
    assert.equal(await page.locator('#score-play').isEnabled(), true, 'an invalid published ID leaves the default example usable');
    assert.match(await page.locator('#score-summary').innerText(), /94 个音符 · 16 小节/);
    assert.equal(await page.locator('#export-json').isVisible(), false);
    assert.deepEqual(blockedJsonRequests, [], 'bundled scores and unknown IDs require no score JSON requests');
    assert.deepEqual(errors, []);
    console.log(`Verified 29 bars, 189 source notes, 5 pages, 12 glissandi, 245 playback notes/148 beats, repeat navigation, favorites, original image, JSON round-trip and mobile layout. QA outputs: ${output}`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('entry-only published scores keep the JSON fallback and report load failures without replacing the usable example', { timeout: 30000 }, async () => {
  const { server, base } = await serve();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const entry = { id: 'future-score', format: 'paijian-score', file: 'scores/future-score.json', title: source.title, attribution: '未来曲目测试' };
    await page.route('**/curated/index.js*', route => route.fulfill({ contentType: 'application/javascript', body: `globalThis.CuratedScores = ${JSON.stringify({ version: 1, entries: [entry] })};` }));
    let failure = 'none';
    const requests = [];
    await page.route('**/scores/future-score.json*', route => {
      requests.push(route.request().url());
      if (failure === 'network') return route.abort('failed');
      if (failure === 'http') return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(source) });
    });
    await page.goto(base + 'score.html?score=future-score');
    await page.waitForFunction(() => document.getElementById('score-summary').textContent.includes('189 个音符'));
    assert.match(await page.locator('#full-score-info').innerText(), /谱面 29 小节 \/ 5 页 · 含反复播放 37 小节/);
    assert.equal(requests.length, 1, 'a published entry without bundled data still loads its JSON');
    for (failure of ['network', 'http']) {
      await page.reload();
      await page.waitForFunction(() => document.getElementById('workshop-message').dataset.kind === 'error');
      const message = await page.locator('#workshop-message').innerText();
      assert.match(message, /曲谱|网络/);
      assert.doesNotMatch(message, /Failed to fetch|NetworkError|Load failed/);
      assert.match(await page.locator('#score-summary').innerText(), /94 个音符 · 16 小节/);
      assert.equal(await page.locator('#score-play').isEnabled(), true);
      assert.equal(await page.locator('#export-json').isVisible(), false);
      assert.equal(await page.locator('#score-preview').getAttribute('aria-busy'), null);
    }
    assert.equal(requests.length, 3);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
