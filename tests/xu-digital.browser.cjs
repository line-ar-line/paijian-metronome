const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { inflateRawSync } = require('node:zlib');
const { chromium } = require('playwright');
const ScoreDocument = require('../score/document.js');

const project = path.resolve(__dirname, '..');
const prefix = '/paijian-metronome/';
const source = JSON.parse(fs.readFileSync(path.join(project, 'scores/xu.json'), 'utf8'));
const expected = ScoreDocument.compile(source);
const output = fs.mkdtempSync(path.join(tmpdir(), 'paijian-xu-digital-qa-'));
const favoriteKey = 'paijian.score-favorites.v1';
const groupColumns = [12, 10, 8, 12, 10, 5];

async function browserSession(run) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = path.resolve(project, pathname.slice(prefix.length));
    if (!pathname.startsWith(prefix) || !filename.startsWith(project + path.sep)) { response.writeHead(404); response.end(); return; }
    try {
      const bytes = fs.readFileSync(filename);
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Content-Length': bytes.length });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
    const errors = [], requests = [], blockedJson = [];
    context.on('page', page => { page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message)); });
    context.on('request', request => requests.push(request.url()));
    await context.route('**/scores/*.json*', route => { blockedJson.push(route.request().url()); return route.abort('failed'); });
    const base = `http://127.0.0.1:${server.address().port}${prefix}`;
    await run({ context, base, requests });
    assert.deepEqual(errors, [], 'digital-score routes must not produce uncaught browser errors');
    assert.deepEqual(blockedJson, [], 'bundled data must open without requesting a second score JSON file');
    assert.deepEqual(requests.filter(url => /\/scores\/[^?]*\.(?:jpe?g|png|zip)(?:\?|$)/i.test(url)), [], 'no score photograph or original-image archive may be requested');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function readyWorkshop(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('score-name')?.value === '嘘'
    && document.getElementById('score-summary')?.textContent.includes('295')
    && document.querySelector('#score-preview svg'));
}

// This is evaluated in the browser for both live SVGs and independently parsed
// exported files. It observes rendered output rather than the renderer's state.
function inspectSvgTexts(texts) {
  const documents = texts ? texts.map(text => new DOMParser().parseFromString(text, 'image/svg+xml')) : [document];
  return documents.map(doc => {
    const svg = texts ? doc.documentElement : doc.querySelector('#score-preview svg');
    const sources = node => [...node.querySelectorAll('.note-group[data-source-id]')].map(group => group.dataset.sourceId).filter(Boolean);
    return {
      parseErrors: doc.querySelectorAll('parsererror').length,
      images: svg.querySelectorAll('image, foreignObject').length,
      unmetered: svg.getAttribute('data-unmetered') === 'true',
      measures: [...svg.querySelectorAll('[data-measure]')].map(bar => Number(bar.dataset.measure)),
      measureSources: Object.fromEntries([...svg.querySelectorAll('[data-measure]')].map(bar => [bar.dataset.measure, sources(bar)])),
      sourceIds: sources(svg),
      groups: [...svg.querySelectorAll('[data-unmetered-group]')].map(group => ({
        index: Number(group.dataset.unmeteredGroup),
        columns: [...group.querySelectorAll('[data-unmetered-column]')].map(column => Number(column.dataset.unmeteredColumn)),
        sources: sources(group),
      })),
      ties: svg.querySelectorAll('.tie').length,
      glissandi: svg.querySelectorAll('.glissando').length,
      noteLabels: [...svg.querySelectorAll('.note-group>title')].map(title => title.textContent),
      noteDigits: [...svg.querySelectorAll('.note-number')].map(number => number.textContent),
      text: svg.textContent,
    };
  });
}

function assertWholeScore(pages) {
  assert.ok(pages.length > 2, 'the complete edition has several body and interlude pages');
  assert.ok(pages.every(page => page.parseErrors === 0 && page.images === 0), 'every page is valid vector notation with no embedded photographs');
  assert.deepEqual(pages.flatMap(page => page.measures), Array.from({ length: 73 }, (_, i) => i), 'all 73 numbered body measures occur once and in order');
  const groups = pages.flatMap(page => page.groups);
  assert.deepEqual(groups.map(group => group.index), [0, 1, 2, 3, 4, 5], 'all six unmetered groups survive pagination in order');
  assert.deepEqual(groups.map(group => group.columns.length), groupColumns, 'all 57 handwritten columns, including empty upper positions, survive');
  const bodyIds = [...new Set(pages.filter(page => !page.unmetered).flatMap(page => page.sourceIds))].sort();
  const interludeIds = [...new Set(groups.flatMap(group => group.sources))].sort();
  assert.equal(bodyIds.length, 295);
  assert.equal(interludeIds.length, 91);
  assert.deepEqual(bodyIds, expected.score.notes.map(note => note.sourceId).sort());
  assert.deepEqual(interludeIds, expected.score.unmeteredSections.flatMap(section => section.groups.flatMap(group => group.columns.flatMap(column => column.voices.flat()))).map(note => note.sourceId).sort());
  const unmeteredPages = pages.filter(page => page.unmetered);
  assert.ok(unmeteredPages.length > 0);
  for (const page of unmeteredPages) {
    assert.equal(page.measures.length, 0, 'unmetered groups must not masquerade as numbered body measures');
    assert.match(page.text, /时值待定/);
    assert.match(page.text, /间奏不参与试听/);
    assert.equal(page.glissandi, 0, 'the handwritten interlude did not specify glissandi');
    assert.ok(page.noteDigits.every(digit => /^[1-7]$/.test(digit)), 'empty handwritten positions must not turn into rests or duration dashes');
    assert.ok(page.noteLabels.every(label => label.includes('时值待定')), 'interlude notes must not acquire invented durations');
  }
  const firstInterlude = pages.findIndex(page => page.unmetered);
  const lastInterlude = pages.findLastIndex(page => page.unmetered);
  assert.equal(pages.slice(0, firstInterlude).flatMap(page => page.measures).at(-1), 31);
  assert.equal(pages.slice(lastInterlude + 1).flatMap(page => page.measures)[0], 32);
  const measures = Object.assign({}, ...pages.map(page => page.measureSources));
  for (const bar of [32, 48, 64, 72]) {
    assert.ok(measures[bar - 1].some(id => measures[bar].includes(id)), `the printed continuation across ${bar}→${bar + 1} keeps a single source note`);
  }
  assert.ok(pages.reduce((count, page) => count + page.ties, 0) >= 4, 'the four explicit continuations have visible tie curves');
}

async function downloadThrough(page, selector, filename) {
  const pending = page.waitForEvent('download');
  await page.locator(selector).click();
  const download = await pending;
  assert.equal(await download.failure(), null);
  const destination = path.join(output, filename);
  await download.saveAs(destination);
  return { name: download.suggestedFilename(), bytes: fs.readFileSync(destination) };
}

// Read ZIP's central directory independently; do not call the production ZIP
// writer or assume that payloads occur in the same order as page navigation.
function unzipSvgPages(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'export contains a ZIP end-of-central-directory record');
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const files = [];
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10);
    const size = bytes.readUInt32LE(cursor + 20);
    const unpacked = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const extraSize = bytes.readUInt16LE(cursor + 30);
    const commentSize = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8');
    assert.match(name, /\.svg$/i, 'every exported page is an SVG');
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    assert.ok(start + size <= bytes.length);
    const payload = bytes.subarray(start, start + size);
    assert.ok(method === 0 || method === 8, 'ZIP uses a supported standard compression method');
    const data = method === 8 ? inflateRawSync(payload) : payload;
    assert.equal(data.length, unpacked);
    files.push({ name, text: data.toString('utf8') });
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  assert.equal(new Set(files.map(file => file.name)).size, count, 'no duplicate page names can overwrite a page');
  return files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
}

function assertDocument(document) {
  assert.deepEqual(ScoreDocument.normalize(document), ScoreDocument.normalize(source));
  const result = ScoreDocument.compile(document);
  assert.equal(result.score.bars.length, 73);
  assert.equal(result.playbackNotes.length, 295);
  assert.equal(result.totalBeats, 219);
  assert.equal(result.score.stats.unmeteredNotes, 91);
  assert.deepEqual(result.score.unmeteredSections[0].groups.map(group => group.columns.length), groupColumns);
  assert.deepEqual(document.voices[0].notation.split('|').flatMap((bar, index) => bar.includes('~') ? [index + 1] : []), [32, 48, 64, 72]);
  assert.ok(document.unmeteredSections[0].voices.some(voice => voice.notation.includes('.')), 'empty handwritten columns remain explicit placeholders');
}

async function assertMobile(page, label) {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const size = await page.evaluate(() => ({ width: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(size.html <= size.width && size.body <= size.width, `${label} must fit a ${width}px page: ${JSON.stringify(size)}`);
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
}

test('Xu complete digital edition keeps every body measure and unmetered note in the browser, playback and full SVG/JSON exports', { timeout: 60000 }, async () => {
  assertDocument(source);
  assert.deepEqual(fs.readdirSync(path.join(project, 'scores')).filter(name => /^xu.*\.(?:jpe?g|png|zip)$/i.test(name)), [], 'the former four Xu photographs and their ZIP are removed from the published score folder');
  await browserSession(async ({ context, base }) => {
    await context.addInitScript(() => {
      let Player;
      Object.defineProperty(window, 'ScorePlayer', { configurable: true, get: () => Player, set: Original => {
        Player = class extends Original {
          constructor(...args) { super(...args); window.xuAcceptancePlayer = this; }
          play(notes, options) { window.xuAcceptanceInput = { notes: structuredClone(notes), options: { ...options } }; return super.play(notes, options); }
        };
      } });
    });
    const page = await context.newPage();
    await readyWorkshop(page, base + 'score.html?score=xu');
    assert.match(await page.locator('#full-score-info').innerText(), /正文 73 小节.*间奏 6 组/);
    assert.match(await page.locator('#score-summary').innerText(), /295.*91/);
    assert.equal(await page.locator('#play-label').innerText(), '试听正文');
    assert.equal(await page.locator('#original-score').isVisible(), false);
    assert.equal(await page.locator('#score-preview image').count(), 0);
    await page.screenshot({ path: path.join(output, 'xu-desktop.png'), fullPage: true });

    const count = await page.locator('#page-select option').count();
    const pages = [];
    for (let index = 0; index < count; index++) {
      await page.locator('#page-select').selectOption(String(index));
      const snapshot = (await page.evaluate(inspectSvgTexts, null))[0];
      pages.push(snapshot);
      if (snapshot.unmetered) {
        assert.match(await page.locator('#page-range').innerText(), /间奏.*不参与试听/);
        await page.locator('#score-preview').screenshot({ path: path.join(output, `xu-interlude-page-${index + 1}.png`) });
      }
    }
    assertWholeScore(pages);
    const interludePage = pages.findIndex(page => page.unmetered);
    await page.locator('#page-select').selectOption(String(interludePage));
    await assertMobile(page, 'workshop interlude page');
    await page.locator('#page-select').selectOption('0');
    await assertMobile(page, 'workshop body page');

    await page.locator('#score-play').click();
    await page.waitForFunction(() => window.xuAcceptancePlayer.isPlaying && window.xuAcceptancePlayer._voices.size > 0);
    const playback = await page.evaluate(() => ({
      context: xuAcceptancePlayer._context.state,
      notes: xuAcceptanceInput.notes.map(note => ({ midi: note.midi, start: note.start, duration: note.duration, voiceIndex: note.voiceIndex, sourceId: note.sourceId })),
      totalBeats: xuAcceptanceInput.options.totalBeats,
    }));
    assert.equal(playback.context, 'running');
    assert.equal(playback.notes.length, 295);
    assert.equal(playback.totalBeats, 219);
    assert.ok(playback.notes.every(note => !note.sourceId.startsWith('u')), 'unmetered interlude pitches are excluded from synthesized playback');
    for (const [bar, duration] of [[32, 6], [48, 4], [64, 5], [72, 6]]) {
      const attack = playback.notes.filter(note => note.voiceIndex === 0 && note.start === (bar - 1) * 3 && note.midi === 72);
      assert.equal(attack.length, 1);
      assert.equal(attack[0].duration, duration, `tie at ${bar} sustains through the following bar without a second pluck`);
      assert.equal(playback.notes.filter(note => note.voiceIndex === 0 && note.start === bar * 3 && note.midi === 72).length, 0);
    }
    await page.locator('#page-select').selectOption(String(interludePage));
    const followed = await page.evaluate(() => {
      xuAcceptancePlayer.onProgress({ beat: 96, totalBeats: 219 });
      return { bar33: !!document.querySelector('#score-preview [data-measure="32"]'), unmetered: !!document.querySelector('#score-preview svg[data-unmetered]'), status: document.getElementById('playback-status').textContent };
    });
    assert.equal(followed.bar33, true, 'playback resumes its visual position in body bar 33, skipping unmetered pages');
    assert.equal(followed.unmetered, false);
    assert.match(followed.status, /正文.*第 33 \/ 73 小节/);
    await page.locator('#score-play').click();
    assert.equal(await page.locator('#play-label').innerText(), '试听正文');
    assert.equal(await page.evaluate(() => xuAcceptancePlayer._voices.size), 0);

    const json = await downloadThrough(page, '#export-json', 'xu-workshop.json');
    assert.match(json.name, /\.json$/);
    assertDocument(JSON.parse(json.bytes.toString('utf8')));
    const zip = await downloadThrough(page, '#export-svg', 'xu-complete-svg.zip');
    assert.match(zip.name, /\.zip$/);
    const files = unzipSvgPages(zip.bytes);
    assert.equal(files.length, count, 'ZIP contains every body and interlude page');
    assertWholeScore(await page.evaluate(inspectSvgTexts, files.map(file => file.text)));
    console.log(`Xu digital acceptance: ${count} SVG pages, 73 body bars, 6 interlude groups / 91 pitches, 295 playback events / 219 beats. Screenshots and exports: ${output}`);
  });
});

test('Xu favorites persist across library reloads and the former original-image link opens the digital edition', { timeout: 30000 }, async () => {
  await browserSession(async ({ context, base }) => {
    const page = await context.newPage();
    await readyWorkshop(page, base + 'score.html?score=xu');
    assert.equal(await page.locator('#favorite-score').getAttribute('aria-pressed'), 'false');
    await page.locator('#favorite-score').click();
    assert.equal(await page.locator('#favorite-score').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).ids, favoriteKey), ['xu']);
    const library = await context.newPage();
    await library.goto(base + 'library.html?favorites=1');
    const card = library.locator('.catalog-piece[data-piece-id="xu"]');
    await card.waitFor();
    assert.equal(await library.locator('.catalog-piece').count(), 1);
    assert.equal(await card.locator('[data-favorite-id="xu"]').getAttribute('aria-pressed'), 'true');
    assert.match(await card.locator('.catalog-open').getAttribute('href'), /score\.html\?score=xu$/);
    assert.equal(await card.locator('a[href*="original.html"], a[href$=".jpg"], a[href$=".zip"]').count(), 0);
    await library.reload();
    await card.waitFor();
    assert.equal(await card.locator('[data-favorite-id="xu"]').getAttribute('aria-pressed'), 'true');
    await assertMobile(library, 'favorite Xu library card');
    await page.goto(base + 'original.html?score=xu');
    await page.waitForURL(base + 'score.html?score=xu');
    await page.waitForFunction(() => document.getElementById('score-name')?.value === '嘘' && document.getElementById('score-summary')?.textContent.includes('295'));
    assert.equal(await page.locator('#play-label').innerText(), '试听正文');
    assert.equal(await page.locator('#original-score').isVisible(), false);
    assert.equal(await page.locator('#favorite-score').getAttribute('aria-pressed'), 'true');
  });
});

test('editing a Xu copy preserves the entire untimed interlude and all tie notation through local saving and JSON recompile', { timeout: 30000 }, async () => {
  await browserSession(async ({ context, base }) => {
    const page = await context.newPage();
    await readyWorkshop(page, base + 'score.html?score=xu');
    assert.equal(await page.locator('#edit-authored').getAttribute('href'), 'composer.html?score=xu');
    await page.locator('#edit-authored').click();
    await page.waitForFunction(() => document.getElementById('composer-title')?.value === '嘘'
      && document.querySelector('#composer-preview svg') && document.getElementById('notation-error').hidden);
    assert.equal(await page.locator('#composer-unmetered').isVisible(), true);
    assert.equal(await page.locator('#composer-voices .notation-input').count(), 2);
    assert.equal(await page.locator('.unmetered-notation').count(), 2);
    assert.match(await page.locator('#composer-play').innerText(), /试听正文/);
    for (let i = 0; i < 2; i++) assert.equal(await page.locator('.unmetered-notation').nth(i).inputValue(), source.unmeteredSections[0].voices[i].notation);
    const before = await page.locator('.draft-item').count();
    await page.reload();
    await page.waitForFunction(() => document.getElementById('composer-title')?.value === '嘘' && document.querySelector('#composer-preview svg'));
    assert.equal(await page.locator('.draft-item').count(), before, 'reloading the saved editing copy does not import a second copy');
    const json = await downloadThrough(page, '#composer-export-json', 'xu-composer-roundtrip.json');
    const restored = JSON.parse(json.bytes.toString('utf8'));
    assertDocument(restored);
    assert.deepEqual(restored.unmeteredSections, source.unmeteredSections);
    const count = await page.locator('#composer-page-select option').count();
    let foundInterlude = false;
    for (let index = 0; index < count; index++) {
      await page.locator('#composer-page-select').selectOption(String(index));
      if (await page.locator('#composer-preview svg[data-unmetered="true"]').count()) {
        foundInterlude = true;
        assert.match(await page.locator('#composer-page-range').innerText(), /间奏.*不参与试听/);
        assert.equal(await page.locator('#composer-preview image').count(), 0);
        await assertMobile(page, 'composer with an unmetered interlude');
        break;
      }
    }
    assert.equal(foundInterlude, true);
  });
});
