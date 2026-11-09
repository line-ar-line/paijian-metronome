const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const project = path.resolve(__dirname, '..');
const config = { provider: 'cloudbase', envId: 'test-community-123456', region: 'ap-shanghai', enabled: true };
const email = 'member@example.test';
const profile = { sub: 'verified-member', email, email_verified: true, name: '已验证琴友', created_at: '2026-11-09T00:00:00Z', providers: [] };
const credentials = { access_token: 'test-cloudbase-access', refresh_token: 'test-cloudbase-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'user' };

test('actual CloudBase SDK registers and signs in by verified email, restores sessions and calls PostgreSQL RPC; blocked storage stays in memory', { timeout: 60000 }, async () => {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<html><body><script src="/vendor/cloudbase.min.js"></script><script src="/community/cloudbase-client.js"></script><script>window.api = CloudBaseCommunity.createCommunityClient(${JSON.stringify(config)}); window.ready = api.init();</script></body></html>`);
      return;
    }
    const filename = path.resolve(project, '.' + pathname);
    if (!filename.startsWith(project + path.sep)) { response.writeHead(404); response.end(); return; }
    try { const body = fs.readFileSync(filename); response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(body); }
    catch (_) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const blockedStorage of [false, true]) {
      const context = await browser.newContext();
      if (blockedStorage) await context.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } });
      });
      const page = await context.newPage();
      const errors = [], blocked = [], requests = [];
      let isExisting = false;
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === origin) { await route.continue(); return; }
        const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': request.headers()['access-control-request-headers'] || '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
        if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
        let body;
        try { body = request.postDataJSON(); } catch (_) { body = request.postData(); }
        const requestHeaders = await request.allHeaders();
        requests.push({ path: url.pathname, body, headers: requestHeaders });
        const json = value => route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(value) });
        if (url.pathname.endsWith('/auth/v1/verification')) {
          assert.equal(body.email, email);
          await json({ verification_id: 'test-challenge', is_user: isExisting });
        } else if (url.pathname.endsWith('/auth/v1/verification/verify')) {
          assert.equal(body.verification_id, 'test-challenge');
          assert.equal(body.verification_code, '001234');
          await json({ verification_token: 'test-verified-email', expires_in: 300 });
        } else if (url.pathname.endsWith('/auth/v1/signup')) {
          assert.equal(isExisting, false);
          assert.equal(body.email, email);
          assert.equal(body.verification_token, 'test-verified-email');
          isExisting = true;
          await json(credentials);
        } else if (url.pathname.endsWith('/auth/v1/signin')) {
          assert.equal(isExisting, true);
          assert.equal(body.username, email);
          assert.equal(body.verification_token, 'test-verified-email');
          await json(credentials);
        } else if (url.pathname.endsWith('/auth/v1/user/me')) {
          assert.equal(requestHeaders.authorization, 'Bearer ' + credentials.access_token);
          await json(profile);
        } else if (url.pathname.endsWith('/rpc/community_dashboard')) {
          assert.equal(requestHeaders.authorization, 'Bearer ' + credentials.access_token);
          assert.deepEqual(body, {});
          await json({ profile: { nickname: '云端琴友' }, privateRecord: '私人记录' });
        } else if (url.pathname.endsWith('/auth/v1/revoke')) {
          assert.equal(body.token, credentials.access_token);
          await json({});
        } else {
          blocked.push({ path: url.pathname, method: request.method(), action: body?.action });
          await route.abort();
        }
      });
      await page.goto(origin);
      assert.equal(await page.evaluate(() => ready).catch(async error => {
        throw new Error(error.message + '\nSDK diagnostic: ' + JSON.stringify(await page.evaluate(async config => {
          try { const app = cloudbase.init({ env: config.envId, region: config.region }); const auth = app.auth(); const result = await auth.getSession(); return { result, methods: [typeof auth.getSession, typeof auth.getCurrentUser] }; }
          catch (error) { return { name: error.name, message: error.message, stack: error.stack }; }
        }, config)) + '\nPage errors: ' + JSON.stringify(errors) + '\nBlocked: ' + JSON.stringify(blocked));
      }), null);
      assert.equal(requests.length, 0, 'initialization must never sign in anonymously');
      await page.evaluate(email => api.sendCode(email), email);
      assert.equal(await page.evaluate(() => api.init()), null, 'sending a code does not sign in');
      const signedIn = await page.evaluate(email => api.verifyCode(email, '001234'), email).catch(error => {
        error.message += '\nIntercepted paths: ' + JSON.stringify(requests.map(request => request.path)) + '\nUnexpected: ' + JSON.stringify(blocked) + '\nPage errors: ' + JSON.stringify(errors);
        throw error;
      });
      assert.equal(signedIn.user.id, profile.sub);
      assert.equal(signedIn.user.email, email);
      assert.deepEqual(await page.evaluate(() => api.dashboard()), { profile: { nickname: '云端琴友' }, privateRecord: '私人记录' });
      if (blockedStorage) {
        assert.match(await page.evaluate(() => api.getConfiguration().storageWarning), /当前页面有效/);
      } else {
        assert.ok(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('credentials_'))));
      }
      await page.reload();
      const restored = await page.evaluate(() => ready);
      assert.equal(restored?.user?.id || null, blockedStorage ? null : profile.sub);
      if (!blockedStorage) {
        assert.deepEqual(await page.evaluate(() => api.dashboard()), { profile: { nickname: '云端琴友' }, privateRecord: '私人记录' });
        await page.evaluate(() => api.signOut());
        assert.equal(await page.evaluate(() => api.init()), null);
        assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('credentials_'))), false);
      }
      // The same address now follows the existing-user signIn branch.
      await page.evaluate(email => api.sendCode(email), email);
      assert.equal((await page.evaluate(email => api.verifyCode(email, '001234'), email)).user.id, profile.sub);
      await page.evaluate(() => api.signOut());
      const requestsBefore = requests.filter(request => request.path.includes('/rpc/')).length;
      assert.equal(await page.evaluate(async () => { try { await api.dashboard(); return ''; } catch (error) { return error.code; } }), 'not_authenticated');
      assert.equal(requests.filter(request => request.path.includes('/rpc/')).length, requestsBefore);
      assert.equal(requests.filter(request => request.path.endsWith('/auth/v1/signup')).length, 1);
      assert.equal(requests.filter(request => request.path.endsWith('/auth/v1/signin')).length, 1);
      assert.deepEqual(blocked, []);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
