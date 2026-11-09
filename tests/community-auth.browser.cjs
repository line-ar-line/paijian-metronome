const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const project = path.resolve(__dirname, '..');
const prefix = '/paijian-metronome/';
const service = 'https://community-auth-test.supabase.co';
const publicKey = 'sb_publishable_browser_integration_only';
const email = 'sdk.person@example.test';
const memberId = '3fb49cc8-0b5b-4c4c-b36f-08c48b314123';
const nickname = '真实 SDK 测试琴友';
const privatePiece = '仅自己可见的测试曲';

async function staticServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    // This fixture intentionally exercises the retained legacy adapter without
    // loading the current username/password community UI.
    if (pathname === prefix + 'community.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body>
        <script src="community/config.js"></script>
        <script src="vendor/supabase.min.js"></script>
        <script src="community/client.js"></script>
        <script>
          window.observedSessions = [];
          PaijianCommunity.subscribe(session => observedSessions.push(session?.user?.id || null));
          window.legacyReady = PaijianCommunity.init();
        </script>
      </body></html>`);
      return;
    }
    const filename = path.resolve(project, pathname.slice(prefix.length));
    if (!pathname.startsWith(prefix) || !filename.startsWith(project + path.sep)) { response.writeHead(404); response.end(); return; }
    try {
      const body = fs.readFileSync(filename);
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' });
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}${prefix}` };
}

function authResponse() {
  const issued = Math.floor(Date.now() / 1000);
  const expires = issued + 3600;
  const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
  // This deliberately non-production JWT exists only inside intercepted test
  // responses; no real Supabase service ever receives it or the test address.
  const accessToken = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: memberId, email, role: 'authenticated', aud: 'authenticated', iss: service + '/auth/v1', iat: issued, exp: expires })}.test-signature`;
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expires,
    refresh_token: 'test-only-refresh-token',
    user: {
      id: memberId, aud: 'authenticated', role: 'authenticated', email,
      email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {}, identities: [], created_at: new Date().toISOString(),
    },
  };
}

function dashboardResponse() {
  return {
    today: '2026-11-09', week_start: '2026-11-09', profile: { nickname },
    stats: { total_days: 1, total_minutes: 27, current_streak: 1 },
    checkins: [{ day: '2026-11-08', minutes: 27, piece: privatePiece, note: '这是私人练习记录。', is_public: false }],
    feed: [], leaderboard: [],
  };
}

test('legacy Supabase adapter independently verifies 6–10 digit OTPs, restores sessions, authorizes RPCs and clears sessions on signout', { timeout: 60000 }, async () => {
  const productionConfig = fs.readFileSync(path.join(project, 'community/config.js'), 'utf8');
  const { server, base } = await staticServer();
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(7000);
    const errors = [];
    const blocked = [];
    const requests = [];
    let expectedCode = '';
    let session = authResponse();
    page.on('pageerror', error => errors.push(error.message));

    // The minimal fixture loads the unmodified vendored SDK and legacy adapter.
    // Only configuration and service HTTP responses are supplied by the test.
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === new URL(base).origin) {
        if (url.pathname === prefix + 'community/config.js') {
          await route.fulfill({ status: 200, contentType: 'application/javascript', body: `window.PAIJIAN_COMMUNITY_CONFIG = ${JSON.stringify({ supabaseUrl: service, supabasePublishableKey: publicKey })};` });
        } else await route.continue();
        return;
      }
      if (url.origin !== service) {
        blocked.push(request.url());
        await route.abort();
        return;
      }
      const cors = {
        'access-control-allow-origin': new URL(base).origin,
        'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-expose-headers': 'X-Supabase-Api-Version',
        'x-supabase-api-version': '2024-01-01',
      };
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      const body = request.postData() ? request.postDataJSON() : null;
      const headers = await request.allHeaders();
      requests.push({ pathname: url.pathname, search: url.search, method: request.method(), body, headers });
      assert.equal(headers.apikey, publicKey);
      const json = (body, status = 200) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/auth/v1/otp' && request.method() === 'POST') {
        assert.equal(body.email, email);
        assert.equal(body.create_user, true, 'first verification may create the account');
        await json({});
      } else if (url.pathname === '/auth/v1/verify' && request.method() === 'POST') {
        assert.equal(body.email, email);
        assert.equal(body.type, 'email');
        assert.equal(typeof body.token, 'string', 'leading zeros in OTPs must survive the SDK');
        if (body.token === expectedCode) await json(session);
        else await json({ code: 'otp_expired', message: 'Token has expired or is invalid' }, 403);
      } else if (url.pathname === '/auth/v1/user' && request.method() === 'GET') {
        assert.equal(headers.authorization, `Bearer ${session.access_token}`);
        await json(session.user);
      } else if (url.pathname === '/rest/v1/rpc/community_dashboard' && request.method() === 'POST') {
        assert.equal(headers.authorization, `Bearer ${session.access_token}`, 'private RPCs must carry the verified access token');
        await json(dashboardResponse());
      } else if (url.pathname === '/auth/v1/logout' && request.method() === 'POST') {
        assert.equal(url.searchParams.get('scope'), 'local');
        assert.equal(headers.authorization, `Bearer ${session.access_token}`);
        await route.fulfill({ status: 204, headers: cors });
      } else {
        blocked.push(request.url());
        await route.abort();
      }
    });

    await page.goto(base + 'community.html');
    assert.equal(await page.evaluate(() => typeof supabase.createClient), 'function');
    for (const code of ['001234', '00123456', '0012345678']) {
      expectedCode = code;
      session = authResponse();
      assert.equal(await page.evaluate(() => legacyReady), null);
      assert.equal(await page.evaluate(() => PaijianCommunity.configured), true);
      await page.evaluate(() => PaijianCommunity.sendCode('SDK.Person@example.test'));
      assert.equal(await page.evaluate(() => PaijianCommunity.init()), null, 'sending OTP must not establish a session');
      if (code.length === 6) {
        const error = await page.evaluate(async email => {
          try { await PaijianCommunity.verifyCode(email, '000000'); return ''; }
          catch (error) { return error.message; }
        }, email);
        assert.match(error, /不正确或已过期/);
        assert.equal(await page.evaluate(() => PaijianCommunity.init()), null);
        assert.equal(requests.filter(request => request.pathname.startsWith('/rest/')).length, 0);
      }
      const signedIn = await page.evaluate(({ email, code }) => PaijianCommunity.verifyCode(email, code), { email, code });
      assert.equal(signedIn.user.id, memberId);
      assert.equal(signedIn.user.email, email);
      await page.waitForFunction(id => observedSessions.at(-1) === id, memberId);
      assert.deepEqual(await page.evaluate(() => PaijianCommunity.dashboard()), dashboardResponse());
      assert.equal(await page.evaluate(async () => (await PaijianCommunity.init()).user.id), memberId);
      const storage = await page.evaluate(() => {
        const key = Object.keys(localStorage).find(key => key.endsWith('-auth-token'));
        const saved = key && JSON.parse(localStorage.getItem(key));
        return { key, memberId: saved?.user?.id, persisted: Boolean(saved?.access_token && saved?.refresh_token) };
      });
      assert.equal(storage.key, 'sb-community-auth-test-auth-token');
      assert.equal(storage.memberId, memberId);
      assert.equal(storage.persisted, true);

      const verifications = requests.filter(request => request.pathname === '/auth/v1/verify').length;
      const dashboardCount = requests.filter(request => request.pathname === '/rest/v1/rpc/community_dashboard').length;
      await page.reload();
      assert.equal((await page.evaluate(() => legacyReady)).user.id, memberId);
      assert.equal(requests.filter(request => request.pathname === '/auth/v1/verify').length, verifications, 'reload must reuse the saved session without another OTP');
      assert.deepEqual(await page.evaluate(() => PaijianCommunity.dashboard()), dashboardResponse());
      assert.equal(requests.filter(request => request.pathname === '/rest/v1/rpc/community_dashboard').length, dashboardCount + 1);

      await page.evaluate(() => PaijianCommunity.signOut());
      await page.waitForFunction(() => observedSessions.length > 0 && observedSessions.at(-1) === null);
      assert.equal(await page.evaluate(() => localStorage.getItem('sb-community-auth-test-auth-token')), null);
      assert.equal(await page.evaluate(() => PaijianCommunity.init()), null);
      const rpcCountAfterLogout = requests.filter(request => request.pathname.startsWith('/rest/')).length;
      const loggedOutCode = await page.evaluate(async () => {
        try { await PaijianCommunity.dashboard(); return ''; }
        catch (error) { return error.code; }
      });
      assert.equal(loggedOutCode, 'not_authenticated');
      await page.reload();
      assert.equal(await page.evaluate(() => legacyReady), null);
      assert.equal(requests.filter(request => request.pathname.startsWith('/rest/')).length, rpcCountAfterLogout, 'logging out must prevent later private RPCs');
    }
    assert.equal(requests.filter(request => request.pathname === '/auth/v1/otp').length, 3);
    assert.equal(requests.filter(request => request.pathname === '/auth/v1/logout').length, 3);
    assert.deepEqual(requests.filter(request => request.pathname === '/auth/v1/verify').map(request => request.body.token), ['000000', '001234', '00123456', '0012345678']);
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, [], 'all authentication traffic must be fulfilled locally; no real email or backend is contacted');
    assert.equal(fs.readFileSync(path.join(project, 'community/config.js'), 'utf8'), productionConfig, 'test configuration must never be written into the production file');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
