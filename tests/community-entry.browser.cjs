const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const project = path.resolve(__dirname, '..');
const siteUrl = 'https://line-ar-line.github.io/paijian-metronome/';
const communityUrl = 'https://fast-junglefowl-d3fqxnq941dd1c4e-1528285429.tcloudbaseapp.com/paijian/community.html';
const config = { provider: 'cloudbase', envId: 'test-community-123456', region: 'ap-shanghai', enabled: true };

test('GitHub offers an explicit trial link without auth initialization; hosted and local pages behave correctly', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = [], blocked = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      const bases = [new URL(siteUrl), new URL(communityUrl), new URL('http://127.0.0.1:31337/paijian-metronome/community.html')];
      const origin = bases.find(base => base.origin === url.origin);
      if (!origin) { blocked.push(url.href); await route.abort(); return; }
      const prefix = url.origin === new URL(communityUrl).origin ? '/paijian/' : '/paijian-metronome/';
      if (!url.pathname.startsWith(prefix)) { blocked.push(url.href); await route.abort(); return; }
      const filename = url.pathname.slice(prefix.length);
      if (filename === 'community/config.js') {
        await route.fulfill({ contentType: 'application/javascript', body: `window.PAIJIAN_COMMUNITY_CONFIG = ${JSON.stringify(config)};` });
        return;
      }
      if (filename === 'vendor/cloudbase.min.js') {
        // Retain the actual adapter, provider dispatch and UI. Only substitute
        // the SDK network boundary so no real login service can be contacted.
        await route.fulfill({ contentType: 'application/javascript', body: `
          window.sdkCalls = { init: 0, session: 0, subscribe: 0, rpc: 0 };
          window.cloudbase = { init() {
            sdkCalls.init++;
            return { auth() { return {
              async getSession() { sdkCalls.session++; return { data: { session: null }, error: null }; },
              onAuthStateChange() { sdkCalls.subscribe++; return { data: { subscription: { unsubscribe() {} } } }; }
            }; }, rdb() { return { rpc() { sdkCalls.rpc++; throw new Error('unexpected RPC'); } }; } };
          } };
        ` });
        return;
      }
      const absolute = path.resolve(project, filename);
      if (!absolute.startsWith(project + path.sep)) { blocked.push(url.href); await route.abort(); return; }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
      await route.fulfill({ contentType: types[path.extname(absolute)] || 'application/octet-stream', body: fs.readFileSync(absolute) });
    });

    const entryUrl = siteUrl + 'community.html?redirect=https%3A%2F%2Fexample.invalid%2F#private-value';
    await page.goto(entryUrl);
    assert.equal(page.url(), entryUrl, 'entry must never redirect automatically or forward query parameters');
    assert.equal(await page.locator('#community-entry').isVisible(), true);
    assert.match(await page.locator('#community-entry-link').innerText(), /打开打卡试用版/);
    assert.equal(await page.locator('#community-entry-link').getAttribute('href'), communityUrl);
    assert.equal(await page.locator('#community-trial-label').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => sdkCalls), { init: 0, session: 0, subscribe: 0, rpc: 0 });
    assert.equal(await page.locator('#login-email').isDisabled(), true);
    assert.equal(await page.locator('#send-code').isDisabled(), true);
    assert.equal(await page.locator('#submit-checkin').isDisabled(), true);
    await page.evaluate(() => document.getElementById('email-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.deepEqual(await page.evaluate(() => sdkCalls), { init: 0, session: 0, subscribe: 0, rpc: 0 });

    await page.locator('#community-entry-link').click();
    await page.waitForURL(communityUrl);
    await page.waitForFunction(() => !document.getElementById('login-email').disabled);
    assert.equal(await page.locator('#community-entry').isVisible(), false);
    assert.equal(await page.locator('#community-trial-label').isVisible(), true);
    assert.equal(await page.evaluate(() => sdkCalls.init), 1);
    assert.equal(await page.evaluate(() => sdkCalls.rpc), 0);
    assert.deepEqual(await page.locator('.site-nav a').evaluateAll(links => links.map(link => link.href)), [
      siteUrl + 'index.html', siteUrl + 'score.html', siteUrl + 'library.html', siteUrl + 'composer.html', communityUrl
    ]);
    assert.equal(await page.locator('.brand').getAttribute('href'), siteUrl + 'index.html');
    assert.deepEqual(await page.locator('.practice-invitation a').evaluateAll(links => links.map(link => link.href)), [siteUrl + 'index.html', siteUrl + 'library.html']);

    const local = 'http://127.0.0.1:31337/paijian-metronome/community.html';
    await page.goto(local);
    await page.waitForFunction(() => !document.getElementById('login-email').disabled);
    assert.equal(page.url(), local);
    assert.equal(await page.locator('#community-entry').isVisible(), false);
    assert.equal(await page.locator('#community-trial-label').isVisible(), false);
    assert.equal(await page.locator('.brand').getAttribute('href'), './index.html');
    assert.equal(await page.evaluate(() => sdkCalls.init), 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, [], 'no real service or external redirect is contacted');
  } finally { await browser.close(); }
});
