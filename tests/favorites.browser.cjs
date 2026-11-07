const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const key = 'paijian.score-favorites.v1';
const prefix = '/paijian-metronome/';

async function serve() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = path.resolve(root, pathname.slice(prefix.length));
    if (!pathname.startsWith(prefix) || !filename.startsWith(root + path.sep)) { response.writeHead(404); response.end(); return; }
    try { const data = fs.readFileSync(filename); response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' }); response.end(data); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}${prefix}` };
}

test('favorite cards persist, filter, synchronize across tabs, and preserve keyboard focus', { timeout: 30000 }, async () => {
  const { server, base } = await serve();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    const first = await context.newPage();
    const second = await context.newPage();
    const errors = [];
    first.on('pageerror', error => errors.push(error.message));
    second.on('pageerror', error => errors.push(error.message));
    first.setDefaultTimeout(5000); second.setDefaultTimeout(5000);
    await first.goto(base + 'library.html?q=mutopia-528');
    const firstFavorite = first.locator('.catalog-favorite');
    assert.equal(await firstFavorite.count(), 1);
    assert.equal(await firstFavorite.getAttribute('aria-pressed'), 'false');
    await firstFavorite.focus();
    await firstFavorite.press('Enter');
    assert.equal(await firstFavorite.getAttribute('aria-pressed'), 'true');
    assert.equal(await first.evaluate(() => document.activeElement.dataset.favoriteId), 'mutopia-528');
    assert.equal(await first.locator('#catalog-favorite-count').innerText(), '1');
    assert.deepEqual(await first.evaluate(key => JSON.parse(localStorage.getItem(key)).ids, key), ['mutopia-528']);
    await first.reload();
    assert.equal(await firstFavorite.getAttribute('aria-pressed'), 'true');

    await second.goto(base + 'library.html?favorites=1');
    assert.equal(await second.locator('#catalog-favorites-only').getAttribute('aria-pressed'), 'true');
    assert.equal(await second.locator('.catalog-piece').count(), 1);
    await first.locator('#catalog-query').fill('mutopia-931');
    await first.locator('.catalog-favorite').click();
    await second.waitForFunction(() => document.querySelectorAll('.catalog-piece').length === 2);
    assert.equal(await second.locator('#catalog-favorite-count').innerText(), '2');
    await second.locator('#catalog-query').fill('no-matching-favorite');
    assert.equal(await second.locator('.catalog-piece').count(), 0);
    assert.match(await second.locator('#catalog-empty-title').innerText(), /收藏中没有匹配/);
    assert.equal(await second.locator('#catalog-favorite-count').innerText(), '2');
    await second.locator('#catalog-query').fill('');
    await second.reload();
    assert.equal(new URL(second.url()).searchParams.get('favorites'), '1');
    assert.equal(await second.locator('.catalog-piece').count(), 2);

    for (const width of [320, 390, 768]) {
      await second.setViewportSize({ width, height: 844 });
      assert.ok(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `favorites fit ${width}px`);
      const button = await second.locator('.catalog-favorite').first().boundingBox();
      assert.ok(button.width >= 42 && button.height >= 42, 'favorite has a usable touch target');
    }
    await second.locator('[data-favorite-id="mutopia-528"]').click();
    assert.equal(await second.locator('.catalog-piece').count(), 1);
    assert.equal(await second.evaluate(() => document.activeElement.dataset.favoriteId), 'mutopia-931');
    await second.locator('.catalog-favorite').press('Space');
    assert.equal(await second.locator('.catalog-piece').count(), 0);
    assert.match(await second.locator('#catalog-empty-title').innerText(), /还没有收藏/);
    assert.equal(await second.evaluate(() => document.activeElement.id), 'catalog-favorites-only');
    await first.waitForFunction(() => document.querySelector('.catalog-favorite').getAttribute('aria-pressed') === 'false');
    assert.equal(await first.locator('#catalog-favorite-count').innerText(), '0');
    await second.locator('#catalog-empty-reset').click();
    assert.equal(await second.locator('#catalog-favorites-only').getAttribute('aria-pressed'), 'false');
    assert.equal(new URL(second.url()).searchParams.get('favorites'), null);
    assert.equal(await second.locator('.catalog-piece').count(), 24);

    // The score page can use the same API with a curated score's stable ID.
    await first.evaluate(() => ScoreUserLibrary.set('heixiu-rhapsody', true));
    await second.locator('#catalog-query').fill('heixiu-rhapsody');
    assert.equal(await second.locator('.catalog-piece').count(), 1);
    await second.waitForFunction(() => document.querySelector('[data-favorite-id="heixiu-rhapsody"]').getAttribute('aria-pressed') === 'true');
    assert.equal(await second.locator('.catalog-favorite').getAttribute('aria-pressed'), 'true');
    assert.match(await second.locator('.catalog-open').getAttribute('href'), /score\.html\?score=heixiu-rhapsody$/);
    assert.match(await second.locator('.catalog-midi').innerText(), /JSON/);
    assert.equal(await second.locator('.catalog-midi').getAttribute('download'), 'heixiu-rhapsody.json');
    assert.match(await second.locator('.catalog-piece-source').innerText(), /用户提供原谱/);
    assert.equal(await second.locator('.catalog-piece-source a').first().getAttribute('href'), 'scores/heixiu-rhapsody-original.jpg');
    await second.locator('#catalog-favorites-only').click();
    await first.evaluate(() => localStorage.clear());
    await second.waitForFunction(() => document.querySelectorAll('.catalog-piece').length === 0);
    assert.equal(await second.locator('#catalog-favorite-count').innerText(), '0');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('blocked storage and quota errors are visible without a false saved state', { timeout: 30000 }, async () => {
  const { server, base } = await serve();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const failure of ['read', 'write']) {
      const context = await browser.newContext();
      await context.addInitScript(({ failure, key }) => {
        if (failure === 'read') Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } });
        else {
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (name, value) { if (name === key) throw new DOMException('Storage full', 'QuotaExceededError'); return original.call(this, name, value); };
        }
      }, { failure, key });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + 'library.html?q=mutopia-528');
      await page.locator('.catalog-favorite').click();
      assert.equal(await page.locator('.catalog-favorite').getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('#catalog-favorite-count').innerText(), '0');
      assert.equal(await page.locator('#catalog-favorite-message').getAttribute('data-kind'), 'error');
      assert.match(await page.locator('#catalog-favorite-message').innerText(), failure === 'read' ? /无法读取/ : /未能保存/);
      await page.setViewportSize({ width: 320, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
