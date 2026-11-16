const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function session(run, width = 390) {
  const root = path.resolve(__dirname, '..');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg' };
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) { res.writeHead(404).end(); return; }
    try { res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(fs.readFileSync(file)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await run(page, `http://127.0.0.1:${server.address().port}`);
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

test('mobile score links open a compact practice view while settings and exports remain reachable', async () => {
  await session(async (page, base) => {
    await page.goto(base + '/score.html?score=xu');
    await page.locator('#score-preview svg').waitFor();
    assert.equal(await page.locator('#practice-toggle').getAttribute('aria-pressed'), 'true');
    assert.ok((await page.locator('#score-preview').boundingBox()).y < 800);
    assert.equal(await page.locator('#score-settings').getAttribute('open'), null);
    await page.locator('#score-settings > summary').click();
    assert.equal(await page.locator('#instrument-select').isVisible(), true);
    await page.locator('#score-settings > summary').click();
    await page.locator('#score-more > summary').click();
    assert.equal(await page.locator('#export-svg').isVisible(), true);
    await page.locator('#practice-toggle').click();
    assert.equal(await page.locator('#practice-toggle').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#instrument-select').isVisible(), true);
    assert.equal(await page.locator('#export-svg').isVisible(), true);
  });
});


test('mobile reflow preserves every measure, enlarges notes and keeps the reading position after rotation', async () => {
  await session(async (page, base) => {
    await page.goto(base + '/score.html?score=xu');
    await page.locator('#score-preview svg').waitFor();
    await page.waitForFunction(() => document.querySelector('#score-preview svg').getBoundingClientRect().width < 400);
    const measureIds = [];
    const count = await page.locator('#page-select option').count();
    for (let i = 0; i < count; i++) {
      await page.locator('#page-select').selectOption(String(i));
      measureIds.push(...await page.locator('#score-preview [data-measure]').evaluateAll(nodes => nodes.map(n => Number(n.dataset.measure))));
    }
    assert.deepEqual(measureIds, Array.from({ length: 73 }, (_, i) => i));
    await page.locator('#page-select').selectOption('0');
    const before = await page.locator('#score-preview .note-number').first().boundingBox();
    await page.locator('#score-text-size').selectOption('1.4');
    await page.waitForFunction(() => document.querySelector('#score-preview svg').getBoundingClientRect().width > 390);
    const after = await page.locator('#score-preview .note-number').first().boundingBox();
    assert.ok(after.height > before.height * 1.3);
    await page.locator('#score-text-size').selectOption('1');
    await page.locator('#page-select').selectOption('2');
    const anchor = Number(await page.locator('#score-preview [data-measure]').first().getAttribute('data-measure'));
    await page.setViewportSize({ width: 740, height: 390 });
    await page.waitForFunction(bar => !!document.querySelector(`#score-preview [data-measure="${bar}"]`), anchor);
    assert.equal(await page.locator('#score-play').getAttribute('aria-pressed'), 'false');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
});
