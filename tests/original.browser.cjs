const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { chromium } = require('playwright');

const project = path.resolve(__dirname, '..');
const prefix = '/paijian-metronome/';
const favoritesKey = 'paijian.score-favorites.v1';
const originals = [
  { file: 'xu-page-1.jpg', width: 1080, height: 1411, hash: 'bd14e084a84ae16fe78943a00cbe571a66e792eceb55d7d47098acfd9a7f8a71' },
  { file: 'xu-page-2.jpg', width: 1080, height: 1430, hash: '46e41b615d82572ae837e4f96f4398b5fc760c75d6f241542c61da03237f7565' },
  { file: 'xu-interlude.jpg', width: 1440, height: 661, hash: '11fcd3e07ef1cb10213c3f0d077c9380fbc6f7a076dc4b70819839cd7f0bd176' },
  { file: 'xu-page-3.jpg', width: 1080, height: 1086, hash: '36fa689dc0a922949d587348b85490f698c865447ca20d69fe8f40c0f71b4379' },
];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function serve() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.zip': 'application/zip' };
  const requests = [];
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    requests.push(pathname);
    const filename = path.resolve(project, pathname.slice(prefix.length));
    if (!pathname.startsWith(prefix) || !filename.startsWith(project + path.sep)) { response.writeHead(404); response.end(); return; }
    try {
      const bytes = fs.readFileSync(filename);
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Content-Length': bytes.length });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, base: `http://127.0.0.1:${server.address().port}${prefix}` };
}

async function session(run) {
  const { server, requests, base } = await serve();
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    context.on('page', child => child.on('pageerror', error => errors.push(error.message)));
    page.on('pageerror', error => errors.push(error.message));
    await run({ page, context, browser, base, requests });
    assert.deepEqual(errors, [], 'reading and downloading originals must not raise uncaught errors');
    assert.deepEqual(requests.filter(url => /\.json$/i.test(url)), [], 'embedded catalog metadata must not trigger a secondary JSON request');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function ready(page, base) {
  await page.goto(base + 'original.html?score=xu');
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('#original-gallery figure.original-page img')];
    return images.length === 4 && images.every(image => image.complete && image.naturalWidth > 0);
  });
}

async function noPageOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(dimensions.html <= dimensions.viewport && dimensions.body <= dimensions.viewport, `${label}: ${JSON.stringify(dimensions)}`);
}

test('all four original photographs load in reading order and ZIP download preserves every source byte', { timeout: 30000 }, async () => {
  await session(async ({ page, base }) => {
    await ready(page, base);
    assert.equal((await page.locator('#original-title').innerText()).trim(), '嘘');
    assert.match((await page.locator('#original-meta').innerText()).replace(/\s/g, ''), /17音C调/);
    assert.match(await page.locator('#original-meta').innerText(), /3\s*\/\s*4/);
    assert.equal(await page.locator('#original-status').getAttribute('role'), 'status');
    assert.equal(await page.locator('#original-gallery figure.original-page').count(), 4);
    const images = await page.locator('#original-gallery figure.original-page img').evaluateAll(items => items.map(image => ({ file: new URL(image.currentSrc).pathname.split('/').pop(), width: image.naturalWidth, height: image.naturalHeight, alt: image.alt })));
    assert.deepEqual(images.map(({ file, width, height }) => ({ file, width, height })), originals.map(({ file, width, height }) => ({ file, width, height })));
    assert.ok(images.every(image => image.alt.trim()), 'all original pages have meaningful alternative text');
    const text = await page.locator('main').innerText();
    assert.match(text, /73/);
    assert.match(text, /间奏/);
    assert.match(text, /32/);
    assert.match(text, /33/);
    assert.match(text, /拇指琴呆小小/);
    assert.match(text, /时值|节奏/);
    assert.match(text, /速度/);
    assert.match(text, /暂不|尚未|不提供/);

    const pending = page.waitForEvent('download');
    await page.locator('#original-archive').click();
    const download = await pending;
    assert.equal(await download.failure(), null);
    assert.match(download.suggestedFilename(), /\.zip$/i);
    const zipPath = await download.path();
    assert.equal(hash(fs.readFileSync(zipPath)), hash(fs.readFileSync(path.join(project, 'scores/xu-originals.zip'))));
    const archivedImages = JSON.parse(execFileSync('python3', ['-c', [
      'import hashlib, json, sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1]) as archive:',
      '    names = [name for name in archive.namelist() if name.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))]',
      '    print(json.dumps([{ "name": name, "hash": hashlib.sha256(archive.read(name)).hexdigest() } for name in names]))',
    ].join('\n'), zipPath], { encoding: 'utf8' }));
    assert.equal(archivedImages.length, 4);
    assert.deepEqual(archivedImages.map(image => image.hash).sort(), originals.map(image => image.hash).sort());
    for (const image of originals) assert.equal(hash(fs.readFileSync(path.join(project, 'scores', image.file))), image.hash, `${image.file} preserves the supplied original`);
  });
});

test('original-page favorites survive refresh and work in library search and favorites filtering', { timeout: 30000 }, async () => {
  await session(async ({ page, context, base }) => {
    await ready(page, base);
    const favorite = page.locator('#original-favorite');
    assert.equal(await favorite.getAttribute('aria-pressed'), 'false');
    await favorite.click();
    assert.equal(await favorite.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).ids, favoritesKey), ['xu']);
    await page.reload();
    assert.equal(await favorite.getAttribute('aria-pressed'), 'true');

    const library = await context.newPage();
    await library.goto(base + 'library.html?favorites=1&q=' + encodeURIComponent('嘘'));
    assert.equal(await library.locator('#catalog-favorites-only').getAttribute('aria-pressed'), 'true');
    assert.equal(await library.locator('.catalog-piece').count(), 1);
    assert.equal(await library.locator('[data-favorite-id="xu"]').getAttribute('aria-pressed'), 'true');
    const href = await library.locator('.catalog-open').getAttribute('href');
    assert.match(href, /original\.html\?score=xu$/);
    assert.match(await library.locator('.catalog-piece').innerText(), /原图/);
    assert.match(await library.locator('.catalog-piece').innerText(), /4/);
    assert.match(await library.locator('.catalog-midi').getAttribute('href'), /scores\/xu-originals\.zip$/);
    assert.match(await library.locator('.catalog-midi').innerText(), /原图|ZIP/);
    await library.reload();
    assert.equal(await library.locator('.catalog-piece').count(), 1);
    assert.equal(new URL(library.url()).searchParams.get('favorites'), '1');
    await library.locator('.catalog-open').click();
    assert.match(page.url(), /original\.html\?score=xu$/);
    await library.waitForURL(/original\.html\?score=xu$/);
    assert.equal(await library.locator('#original-favorite').getAttribute('aria-pressed'), 'true');
    await favorite.click();
    await library.waitForFunction(() => document.querySelector('#original-favorite').getAttribute('aria-pressed') === 'false');
    await library.goto(base + 'library.html?favorites=1');
    assert.equal(await library.locator('.catalog-piece').count(), 0);
    assert.match(await library.locator('#catalog-empty-title').innerText(), /还没有收藏/);
  });
});

test('fit and zoom keep mobile overflow inside the image containers, page jump works, and print includes all four pages', { timeout: 45000 }, async () => {
  await session(async ({ page, base }) => {
    await page.addInitScript(() => {
      window.originalPrintCalls = [];
      window.print = () => window.originalPrintCalls.push([...document.querySelectorAll('#original-gallery figure.original-page img')].map(image => ({ complete: image.complete && image.naturalWidth > 0, src: image.currentSrc })));
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await ready(page, base);
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator('#original-zoom').selectOption('fit');
      await noPageOverflow(page, `fit at ${width}px`);
      const fitWidth = await page.locator('#original-gallery img').first().evaluate(image => image.getBoundingClientRect().width);
      for (const zoom of ['150', '200']) {
        await page.locator('#original-zoom').selectOption(zoom);
        await noPageOverflow(page, `${zoom}% at ${width}px`);
        const imageWidth = await page.locator('#original-gallery img').first().evaluate(image => image.getBoundingClientRect().width);
        assert.ok(imageWidth >= fitWidth * (Number(zoom) / 100 - 0.05), `${zoom}% must actually enlarge the score`);
        const scrollable = await page.locator('#original-gallery img').evaluateAll(images => images.map(image => {
          let parent = image.parentElement;
          while (parent && parent !== document.body) {
            const style = getComputedStyle(parent);
            if (['auto', 'scroll'].includes(style.overflowX) && parent.scrollWidth > parent.clientWidth) {
              parent.scrollLeft = Math.min(50, parent.scrollWidth - parent.clientWidth);
              return parent.scrollLeft > 0;
            }
            parent = parent.parentElement;
          }
          return false;
        }));
        assert.deepEqual(scrollable, [true, true, true, true], 'every enlarged image is horizontally scrollable');
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#original-zoom').selectOption('fit');
    for (const index of ['2', '3', '0']) {
      await page.locator('#original-jump').selectOption(index);
      await page.waitForFunction(index => {
        const rect = document.querySelectorAll('#original-gallery figure.original-page')[Number(index)].getBoundingClientRect();
        return rect.top < innerHeight && rect.bottom > 0;
      }, index);
    }
    const screenshots = fs.mkdtempSync(path.join(tmpdir(), 'paijian-original-qa-'));
    await page.screenshot({ path: path.join(screenshots, 'original-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(screenshots, 'original-desktop.png'), fullPage: true });

    await page.locator('#original-zoom').selectOption('200');
    await page.locator('#original-print').click();
    const prints = await page.evaluate(() => window.originalPrintCalls);
    assert.equal(prints.length, 1);
    assert.equal(prints[0].length, 4);
    assert.ok(prints[0].every(image => image.complete));
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('#original-gallery figure.original-page:visible').count(), 4);
    assert.ok(await page.locator('#original-gallery img').evaluateAll(images => images.every(image => image.getBoundingClientRect().width <= image.parentElement.getBoundingClientRect().width + 1)), 'printing fits the entire original even after a 200% screen zoom');
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, path: path.join(screenshots, 'original-print.pdf') });
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 4, 'the real printable PDF includes exactly four original pages');
    console.log(`Original-score acceptance artifacts: ${screenshots}`);
  });
});

test('unknown score IDs show a Chinese error and never fall back to a different piece', { timeout: 30000 }, async () => {
  await session(async ({ page, base }) => {
    await page.goto(base + 'original.html?score=does-not-exist');
    await page.waitForFunction(() => document.querySelector('#original-status')?.textContent.trim());
    assert.equal(await page.locator('#original-status').getAttribute('role'), 'status');
    assert.equal(await page.locator('#original-status').isVisible(), true);
    assert.match(await page.locator('#original-status').innerText(), /未找到|找不到|不存在|无效|没有找到/);
    assert.equal(await page.locator('#original-gallery img').count(), 0);
    assert.equal(await page.locator('#original-favorite').isDisabled(), true);
    assert.equal(await page.locator('#original-print').isDisabled(), true);
    assert.equal((await page.locator('#original-title').innerText()).trim() === '嘘', false);
  });
});

test('loading and an individual image failure have Chinese status while preserving the other original pages', { timeout: 30000 }, async () => {
  await session(async ({ page, base }) => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/scores/xu-interlude.jpg', async route => { await gate; await route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing image' }); });
    try {
      await page.goto(base + 'original.html?score=xu', { waitUntil: 'domcontentloaded' });
      await page.locator('#original-gallery figure.original-page').first().waitFor();
      assert.equal(await page.locator('#original-status').getAttribute('role'), 'status');
      assert.match(await page.locator('#original-status').innerText(), /加载|读取|正在/);
      assert.equal(await page.locator('#original-status').isVisible(), true);
      assert.equal(await page.locator('#original-gallery').getAttribute('aria-busy'), 'true');
      assert.equal(await page.locator('#original-print').isDisabled(), true);
    } finally { release(); }
    await page.waitForFunction(() => {
      const text = document.querySelector('#original-status')?.textContent || '';
      return /失败|未能|无法/.test(text);
    });
    assert.equal(await page.locator('#original-gallery figure.original-page').count(), 4, 'an unavailable image must not silently disappear from the original set');
    assert.equal(await page.locator('#original-status').isVisible(), true);
    const imageStates = await page.locator('#original-gallery img').evaluateAll(images => images.map(image => image.complete && image.naturalWidth > 0));
    assert.deepEqual(imageStates, [true, true, false, true]);
    assert.match(await page.locator('#original-gallery figure.original-page').nth(2).innerText(), /失败|未能|无法|重新|原图/);
    assert.equal(await page.locator('#original-gallery').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('#original-print').isDisabled(), true, 'an incomplete original set cannot be printed as if complete');
    await page.unroute('**/scores/xu-interlude.jpg');
    await page.locator('#original-gallery figure.original-page').nth(2).getByRole('button', { name: '重新加载' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('#original-gallery img')].every(image => image.complete && image.naturalWidth > 0));
    assert.match(await page.locator('#original-status').innerText(), /全部\s*4.*加载/);
    assert.equal(await page.locator('#original-print').isDisabled(), false);
  });
});
