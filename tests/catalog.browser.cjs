const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const vm = require('node:vm');

const project = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(project, 'catalog/index.json'), 'utf8'));
const curatedScope = {};
if (fs.existsSync(path.join(project, 'curated/index.js'))) vm.runInNewContext(fs.readFileSync(path.join(project, 'curated/index.js'), 'utf8'), curatedScope);
const allEntries = [...(curatedScope.CuratedScores?.entries || []), ...catalog.entries];
const totalPages = Math.ceil(allEntries.length / 24);
const prefix = '/paijian-metronome/';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function exportedSvgPages(filename) {
  const result = spawnSync('python3', ['-c', String.raw`
import json, sys, zipfile, xml.etree.ElementTree as ET
filename = sys.argv[1]
if zipfile.is_zipfile(filename):
    with zipfile.ZipFile(filename) as archive:
        assert archive.testzip() is None
        files = [(name, archive.read(name)) for name in archive.namelist()]
else:
    with open(filename, 'rb') as source:
        files = [('score.svg', source.read())]
rows = []
for name, data in files:
    assert name.endswith('.svg')
    root = ET.fromstring(data)
    rows.append({'name': name, 'text': ''.join(''.join(node.itertext()) for node in root.iter() if node.tag.rsplit('}', 1)[-1] == 'text'), 'measures': [int(node.attrib['data-measure']) for node in root.iter() if 'data-measure' in node.attrib]})
print(json.dumps(rows, ensure_ascii=False))
`, filename], { encoding: 'utf8', maxBuffer: 3 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function staticServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.mid': 'audio/midi', '.svg': 'image/svg+xml' };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!pathname.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
    const filename = path.resolve(project, pathname.slice(prefix.length) || 'index.html');
    if (!filename.startsWith(project + path.sep)) { response.writeHead(403); response.end(); return; }
    try {
      const body = fs.readFileSync(filename);
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Content-Length': body.length });
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}${prefix}` };
}

test('catalog search, pages, downloads and complete score links work at a GitHub Pages project path', { timeout: 60000 }, async () => {
  const { server, base } = await staticServer();
  const screenshots = fs.mkdtempSync(path.join(tmpdir(), 'paijian-catalog-qa-'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    page.setDefaultTimeout(7000);
    const errors = [];
    const midiRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/\/catalog\/midi\//.test(request.url())) midiRequests.push(request.url()); });
    await page.addInitScript(() => {
      let scoreApi;
      Object.defineProperty(window, 'KalimbaScore', {
        get: () => scoreApi,
        set: value => {
          scoreApi = { ...value, buildScore(...args) { const result = value.buildScore(...args); window.catalogAcceptanceScore = result; return result; } };
        },
      });
    });
    await page.goto(base + 'library.html');
    assert.equal(await page.locator('#catalog-total').innerText(), allEntries.length.toLocaleString('zh-CN'));
    assert.equal(await page.locator('.catalog-piece').count(), 24);
    assert.equal(await page.locator('#catalog-page-select option').count(), totalPages);
    assert.equal(await page.locator('#catalog-previous').isDisabled(), true);
    assert.equal(await page.locator('.catalog-results').getAttribute('aria-busy'), 'false');
    assert.equal(midiRequests.length, 0, 'browsing the catalog must not download 1,000 MIDI files');
    await page.screenshot({ path: path.join(screenshots, 'library-desktop.png'), fullPage: true });
    const firstId = await page.locator('.catalog-piece').first().getAttribute('data-piece-id');
    assert.equal(firstId, allEntries[0].id);
    await page.locator('#catalog-next').click();
    assert.equal(await page.locator('#catalog-page-select').inputValue(), '2');
    assert.equal(await page.locator('.catalog-piece').first().getAttribute('data-piece-id'), allEntries[24].id);
    assert.equal(new URL(page.url()).searchParams.get('page'), '2');
    await page.reload();
    assert.equal(await page.locator('#catalog-page-select').inputValue(), '2');
    await page.locator('#catalog-page-select').selectOption(String(totalPages));
    assert.equal(await page.locator('.catalog-piece').count(), allEntries.length % 24 || 24);
    assert.equal(await page.locator('.catalog-piece').last().getAttribute('data-piece-id'), allEntries.at(-1).id);
    assert.equal(await page.locator('#catalog-next').isDisabled(), true);

    await page.locator('#catalog-query').fill('no-such-piece-不存在-901223');
    assert.equal(await page.locator('.catalog-piece').count(), 0);
    assert.equal(await page.locator('#catalog-empty').isVisible(), true);
    await page.locator('#catalog-empty-reset').click();
    assert.equal(await page.locator('#catalog-page-select').inputValue(), '1');
    const composer = catalog.entries.find(entry => /bach/i.test(entry.composer))?.composer || catalog.entries[0].composer;
    await page.locator('#catalog-composer').selectOption(composer);
    assert.ok(await page.locator('.catalog-piece').count() > 0);
    assert.ok((await page.locator('.catalog-piece-composer').allTextContents()).every(value => value === composer));
    assert.equal(new URL(page.url()).searchParams.get('composer'), composer);
    await page.locator('#catalog-reset').click();
    const instrument = allEntries[0].instrument;
    await page.locator('#catalog-instrument').selectOption(instrument);
    const instrumentIds = await page.locator('.catalog-piece').evaluateAll(nodes => nodes.map(node => node.dataset.pieceId));
    assert.ok(instrumentIds.length > 0);
    assert.ok(instrumentIds.every(id => allEntries.find(entry => entry.id === id).instrument === instrument));
    await page.locator('#catalog-reset').click();
    if (/bach/i.test(composer)) {
      await page.locator('#catalog-query').fill('巴赫');
      assert.ok(await page.locator('.catalog-piece').count() > 0, 'Chinese composer aliases are searchable');
      assert.ok((await page.locator('.catalog-piece-composer').allTextContents()).every(value => /bach/i.test(value)));
      await page.locator('#catalog-reset').click();
    }
    await page.locator('#catalog-texture').selectOption('polyphonic');
    const polyphonicIds = await page.locator('.catalog-piece').evaluateAll(nodes => nodes.map(node => node.dataset.pieceId));
    assert.ok(polyphonicIds.length > 0);
    assert.ok(polyphonicIds.every(id => allEntries.find(entry => entry.id === id).maxPolyphony > 1));
    await page.locator('#catalog-reset').click();
    await page.locator('#catalog-sort').selectOption('coverage');
    const coverage = entry => entry.notes > 0 && Number.isInteger(entry.playable17Count) ? entry.playable17Count / entry.notes : -1;
    const best = allEntries.map((entry, index) => ({ entry, index })).sort((a, b) => coverage(b.entry) - coverage(a.entry) || a.index - b.index)[0].entry;
    assert.equal(await page.locator('.catalog-piece').first().getAttribute('data-piece-id'), best.id);
    await page.locator('#catalog-reset').click();
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `catalog must fit ${width}px`);
      assert.ok(await page.locator('#catalog-query').isVisible());
      await page.locator('.catalog-results').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(screenshots, `library-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    const selected = catalog.entries.find(entry => entry.id === 'mutopia-528') || catalog.entries.find(entry => entry.maxPolyphony > 1 && entry.notes < 1500 && entry.bars >= 8 && entry.bars < 60);
    assert.ok(selected, 'a representative complete polyphonic work must be available');
    await page.locator('#catalog-query').fill(selected.id);
    assert.equal(await page.locator('.catalog-piece').count(), 1);
    assert.equal(await page.locator('.catalog-piece-title').innerText(), selected.title);
    await page.reload();
    assert.equal(await page.locator('#catalog-query').inputValue(), selected.id);
    assert.equal(await page.locator('.catalog-piece').count(), 1);
    const downloadEvent = page.waitForEvent('download');
    await page.locator('.catalog-midi').click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), `${selected.id}.mid`);
    const downloaded = await download.path();
    assert.equal(sha256(fs.readFileSync(downloaded)), selected.sha256, 'download is the complete source file');
    await page.locator('.catalog-open').click();
    await page.waitForFunction(id => document.getElementById('source-label').querySelector(`a[download="${id}.mid"]`) && document.getElementById('workshop-message').dataset.kind === 'success', selected.id);
    assert.equal(new URL(page.url()).searchParams.get('piece'), selected.id);
    assert.equal(await page.locator('#score-mode').inputValue(), 'polyphonic');
    const loaded = await page.evaluate(() => ({ notes: catalogAcceptanceScore.notes.length, bars: catalogAcceptanceScore.bars.length, total: catalogAcceptanceScore.sourceTotalBeats, polyphony: catalogAcceptanceScore.stats.maxPolyphony, removed: catalogAcceptanceScore.stats.removedPolyphony, clipped: catalogAcceptanceScore.stats.clippedOverlaps }));
    assert.equal(loaded.notes, selected.notes);
    assert.equal(loaded.bars, selected.bars);
    assert.ok(loaded.total >= selected.totalBeats);
    assert.equal(loaded.polyphony, selected.maxPolyphony);
    assert.equal(loaded.removed, 0);
    assert.equal(loaded.clipped, 0);
    const attribution = await page.locator('#source-label').innerText();
    assert.ok(attribution.includes(selected.title));
    assert.ok(attribution.includes(selected.composer));
    assert.ok(attribution.includes(selected.license));
    assert.ok(attribution.includes(selected.attribution));
    assert.equal(await page.locator('#source-label a').first().getAttribute('href'), selected.sourceUrl);
    const scorePages = await page.locator('#page-select option').count();
    if (scorePages > 1) {
      await page.locator('#page-select').selectOption(String(scorePages - 1));
      assert.ok(await page.locator(`#score-preview [data-measure="${selected.bars - 1}"]`).count() > 0, 'the final source bar remains reachable');
    }
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `loaded catalog score must fit ${width}px`);
    }

    const attributed = catalog.entries.filter(entry => /^CC BY /.test(entry.license) && entry.bars >= 20 && entry.bars <= 120 && entry.notes < 2500).sort((a, b) => a.notes - b.notes)[0];
    assert.ok(attributed, 'the catalog includes a manageable attribution-licensed work');
    await page.goto(base + `score.html?piece=${attributed.id}`);
    await page.waitForFunction(id => document.getElementById('source-label').querySelector(`a[download="${id}.mid"]`), attributed.id);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.locator('#score-preview').screenshot({ path: path.join(screenshots, 'score-with-attribution.png') });
    const attributedPageCount = await page.locator('#page-select option').count();
    assert.ok(attributedPageCount > 1, 'attribution must be tested across a multi-page export');
    const svgDownloadEvent = page.waitForEvent('download');
    await page.locator('#export-svg').click();
    const svgDownload = await svgDownloadEvent;
    const exported = exportedSvgPages(await svgDownload.path());
    assert.equal(exported.length, attributedPageCount);
    for (const exportedPage of exported) {
      for (const credit of [attributed.composer, attributed.maintainer, attributed.sourceUrl, attributed.license, attributed.licenseUrl]) {
        assert.ok(exportedPage.text.includes(credit), `${exportedPage.name} visibly preserves ${credit}`);
      }
      assert.match(exportedPage.text, /量化|规整|网格/, 'export states the rhythm conversion applied to the source');
    }
    assert.ok(exported.at(-1).measures.includes(attributed.bars - 1), 'adding attribution cannot drop the final bar');
    assert.deepEqual([...new Set(exported.flatMap(item => item.measures))], Array.from({ length: attributed.bars }, (_, index) => index));

    await page.goto(base + 'score.html?piece=mutopia-999999999');
    await page.waitForFunction(() => document.getElementById('workshop-message').dataset.kind === 'error');
    assert.match(await page.locator('#workshop-message').innerText(), /没有这首曲子/);
    assert.ok(await page.locator('#score-preview svg').count() > 0, 'invalid links leave a usable default score');

    const filePattern = `**/${selected.file}`;
    await page.route(filePattern, route => route.fulfill({ status: 503, body: 'Unavailable' }));
    await page.goto(base + `score.html?piece=${selected.id}`);
    await page.waitForFunction(() => document.getElementById('workshop-message').dataset.kind === 'error');
    assert.match(await page.locator('#workshop-message').innerText(), /无法载入/);
    assert.equal(await page.locator('#score-preview').getAttribute('aria-busy'), null);
    await page.unroute(filePattern);

    await page.route(filePattern, route => route.fulfill({ status: 200, contentType: 'audio/midi', body: fs.readFileSync(path.join(project, selected.file)).subarray(0, 20) }));
    await page.goto(base + `score.html?piece=${selected.id}`);
    await page.waitForFunction(() => document.getElementById('workshop-message').dataset.kind === 'error');
    assert.match(await page.locator('#workshop-message').innerText(), /不完整/);
    assert.ok(await page.locator('#score-preview svg').count() > 0);
    await page.unroute(filePattern);

    // A slow catalog request must not replace a newer, explicit example choice.
    let releaseDownload;
    let notifyRequested;
    const heldDownload = new Promise(resolve => { releaseDownload = resolve; });
    const downloadRequested = new Promise(resolve => { notifyRequested = resolve; });
    await page.route(filePattern, async route => {
      notifyRequested();
      await heldDownload;
      await route.fulfill({ status: 200, contentType: 'audio/midi', body: fs.readFileSync(path.join(project, selected.file)) });
    });
    await page.goto(base + `score.html?piece=${selected.id}`);
    await downloadRequested;
    assert.equal(await page.locator('#score-preview').getAttribute('aria-busy'), 'true');
    await page.locator('#example-select').selectOption('twinkle');
    assert.equal(await page.locator('#score-preview').getAttribute('aria-busy'), null);
    const exampleBefore = await page.locator('#score-preview').innerHTML();
    const completedDownload = page.waitForEvent('requestfinished', request => request.url().endsWith(selected.file));
    releaseDownload();
    await completedDownload;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#example-select').inputValue(), 'twinkle');
    assert.equal(await page.locator('#score-preview').innerHTML(), exampleBefore, 'late source download cannot replace the chosen example');
    assert.equal(await page.locator('#source-label a[download]').count(), 0);
    await page.unroute(filePattern);

    await page.route('**/catalog/index.js', route => route.abort());
    await page.goto(base + 'library.html');
    assert.equal(await page.locator('#catalog-empty').isVisible(), true);
    assert.match(await page.locator('#catalog-empty-title').innerText(), /没有加载成功/);
    assert.equal(await page.locator('.catalog-results').getAttribute('aria-busy'), 'false');
    await page.goto(base + `score.html?piece=${selected.id}`);
    await page.waitForFunction(() => document.getElementById('workshop-message').dataset.kind === 'error');
    assert.match(await page.locator('#workshop-message').innerText(), /无法加载曲目索引/);
    await page.unroute('**/catalog/index.js');
    assert.deepEqual(errors, []);
    console.log(`Verified ${allEntries.length}-entry catalog under ${prefix}, search/filter/sort, ${totalPages} pages, source-hash download, complete ${selected.id} deep link, attribution, error recovery, and 320/390/768px layouts.`);
    console.log(`Catalog QA screenshots retained at ${screenshots}`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
