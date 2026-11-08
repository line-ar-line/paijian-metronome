const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const project = path.resolve(__dirname, '..');
const prefix = '/paijian-metronome/';

async function fixture(run) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = path.resolve(project, pathname.slice(prefix.length));
    if (!pathname.startsWith(prefix) || !filename.startsWith(project + path.sep)) { response.writeHead(404); response.end(); return; }
    try {
      const body = fs.readFileSync(filename);
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' });
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    const externalRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    // Browser regressions never contact a real authentication or email service.
    await page.route('https://**', route => { externalRequests.push(route.request().url()); return route.abort(); });
    const base = `http://127.0.0.1:${server.address().port}${prefix}`;
    await run(page, base);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, [], 'browser tests must not send real authentication requests');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

// Replace only the application API boundary. Its contract matches client.js;
// real Supabase SDK/RPC and database permissions have separate integration tests.
function installMock(options) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const today = '2026-11-09';
  const accounts = {
    a: { user: { id: 'user-a', email: 'kalimba.a@example.test' } },
    b: { user: { id: 'user-b', email: 'kalimba.b@example.test' } },
  };
  const subscribers = new Set();
  const stored = {};
  for (const [name, userSession] of Object.entries(accounts)) {
    stored[userSession.user.id] = {
      today,
      week_start: today,
      profile: { nickname: name === 'a' ? '第一位琴友' : '第二位琴友' },
      stats: { total_days: 0, total_minutes: 0, current_streak: 0 },
      checkins: [],
      feed: [],
      leaderboard: [],
    };
  }
  let session = options.initial ? accounts[options.initial] : null;
  let initialized = false;
  const state = window.communityMock = {
    calls: [],
    holdUsers: options.holdUsers || [],
    held: [],
    sendError: '',
    checkinError: '',
    privacyError: '',
    duplicateNext: false,
    data: stored,
    switchAccount(name) {
      session = name ? accounts[name] : null;
      for (const callback of subscribers) callback(session);
    },
    releaseAll() {
      state.holdUsers = [];
      state.held.splice(0).forEach(item => item.resolve(item.snapshot));
    },
  };
  function current() {
    if (!session) throw new Error('请先登录。');
    return stored[session.user.id];
  }
  function publicRows(data) {
    const own = data.checkins.filter(row => row.is_public);
    data.feed = own.map(row => ({ ...row, nickname: data.profile.nickname }));
    data.leaderboard = own.length ? [{ rank: 1, nickname: data.profile.nickname, days: own.length, minutes: own.reduce((total, row) => total + row.minutes, 0), is_self: true }] : [];
  }
  window.PaijianCommunity = {
    getConfiguration: () => ({ configured: true, error: '', storageWarning: initialized && options.storageWarning ? '浏览器无法保存登录状态。' : '' }),
    async init() { initialized = true; return session; },
    subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
    async sendCode(email) {
      state.calls.push(['sendCode', email]);
      if (state.sendError) throw new Error(state.sendError);
    },
    async verifyCode(email, token) {
      state.calls.push(['verifyCode', email, token]);
      if (token !== '12345678') throw new Error('验证码不正确或已过期，请重新获取后再试。');
      session = accounts.a;
      for (const callback of subscribers) callback(session);
      return session;
    },
    async signOut() {
      state.calls.push(['signOut']);
      session = null;
      for (const callback of subscribers) callback(null);
    },
    async dashboard() {
      state.calls.push(['dashboard', session?.user?.id]);
      const snapshot = clone(current());
      if (state.holdUsers.includes(session.user.id)) return new Promise(resolve => state.held.push({ owner: session.user.id, snapshot, resolve }));
      return snapshot;
    },
    async updateProfile(nickname) {
      state.calls.push(['updateProfile', nickname]);
      const data = current();
      data.profile.nickname = nickname;
      publicRows(data);
      return clone(data.profile);
    },
    async checkIn(input) {
      state.calls.push(['checkIn', clone(input)]);
      if (state.checkinError) throw new Error(state.checkinError);
      const data = current();
      let row = data.checkins.find(item => item.day === today);
      if (state.duplicateNext && !row) {
        row = { day: today, minutes: 20, piece: '另一台设备已保存', note: '请保留原记录', is_public: false, created_at: today + 'T01:00:00Z' };
        data.checkins.unshift(row);
        data.stats = { total_days: 1, total_minutes: 20, current_streak: 1 };
      }
      if (row) return { ...clone(row), created: false };
      row = { day: today, minutes: input.minutes, piece: input.piece, note: input.note, is_public: input.isPublic, created_at: today + 'T02:00:00Z' };
      data.checkins.unshift(row);
      data.stats.total_days += 1;
      data.stats.total_minutes += row.minutes;
      data.stats.current_streak += 1;
      publicRows(data);
      return { ...clone(row), created: true };
    },
    async setCheckinPublic(day, isPublic) {
      state.calls.push(['setCheckinPublic', day, isPublic]);
      if (state.privacyError) throw new Error(state.privacyError);
      const data = current();
      const row = data.checkins.find(item => item.day === day);
      row.is_public = isPublic;
      publicRows(data);
      return clone(row);
    },
  };
}

async function mock(page, options = {}) {
  await page.route('**/community/client.js*', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: `(${installMock.toString()})(${JSON.stringify(options)});` }));
}

async function afterRefresh(page, predicate) {
  await page.waitForFunction(predicate);
  await page.waitForFunction(() => !document.getElementById('refresh-community').disabled);
}

test('unconfigured community is honest and disables authentication and writes', { timeout: 30000 }, async () => fixture(async (page, base) => {
  await page.route('**/community/config.js*', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.PAIJIAN_COMMUNITY_CONFIG = { supabaseUrl: "", supabasePublishableKey: "" };' }));
  await page.goto(base + 'community.html');
  assert.equal(await page.locator('#service-notice').isVisible(), true);
  assert.match(await page.locator('#service-notice').innerText(), /准备|开通/);
  for (const id of ['login-email', 'send-code', 'submit-checkin', 'refresh-community']) assert.equal(await page.locator('#' + id).isDisabled(), true);
  assert.equal(await page.locator('#account-panel').isVisible(), false);
  assert.equal(await page.locator('#stat-days').innerText(), '—');
  assert.equal(await page.locator('#calendar-grid .is-checked').count(), 0);
  assert.equal(await page.locator('#feed-list .feed-item').count(), 0);
  assert.equal(await page.locator('#leaderboard-list .rank-item').count(), 0);
  await page.evaluate(() => document.getElementById('email-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(await page.locator('#verify-form').isVisible(), false);
}));

test('email errors, eight-digit verification, private check-in, sharing and logout behave truthfully', { timeout: 30000 }, async () => fixture(async (page, base) => {
  await mock(page);
  await page.goto(base + 'community.html');
  await page.waitForFunction(() => !document.getElementById('login-email').disabled);
  await page.evaluate(() => { communityMock.sendError = '操作太频繁，请稍后再试。'; });
  await page.locator('#login-email').fill('Kalimba.A@example.test');
  await page.locator('#send-code').click();
  await page.waitForFunction(() => document.getElementById('auth-message').classList.contains('is-error'));
  assert.match(await page.locator('#auth-message').innerText(), /操作太频繁/);
  assert.equal(await page.locator('#verify-form').isVisible(), false);
  assert.equal(await page.locator('#account-panel').isVisible(), false);
  await page.evaluate(() => { communityMock.sendError = ''; });
  await page.locator('#send-code').click();
  await page.locator('#login-code').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#send-code').isDisabled(), true, 'successful send starts a resend cooldown');
  assert.equal(await page.locator('#account-panel').isVisible(), false, 'sending a code alone never signs in');
  await page.locator('#login-code').fill('000000');
  await page.locator('#verify-code').click();
  await page.waitForFunction(() => document.getElementById('auth-message').textContent.includes('不正确'));
  assert.equal(await page.locator('#account-panel').isVisible(), false);
  assert.equal(await page.locator('#checkin-fields').evaluate(fieldset => fieldset.disabled), true);
  await page.locator('#login-code').fill('12345678');
  await page.locator('#verify-code').click();
  await afterRefresh(page, () => document.getElementById('stat-days').textContent === '0');
  assert.equal(await page.locator('#account-panel').isVisible(), true);
  assert.equal(await page.locator('#login-panel').isVisible(), false);
  assert.equal(await page.locator('#account-email').innerText(), 'kalimba.a@example.test');
  assert.equal(await page.locator('#share-public').isChecked(), false, 'sharing requires an explicit choice');
  assert.deepEqual(await page.evaluate(() => communityMock.calls.filter(call => call[0] === 'verifyCode')), [['verifyCode', 'kalimba.a@example.test', '000000'], ['verifyCode', 'kalimba.a@example.test', '12345678']]);

  await page.locator('#nickname').fill('每天弹一点');
  await page.locator('#save-profile').click();
  await afterRefresh(page, () => document.getElementById('account-name').textContent === '每天弹一点');
  await page.locator('#practice-minutes').fill('30');
  await page.locator('#practice-piece').fill('小星星');
  await page.locator('#practice-note').fill('今天练顺了左右手交替。');
  await page.evaluate(() => { communityMock.checkinError = '网络断开，打卡未保存。'; });
  await page.locator('#submit-checkin').click();
  await page.waitForFunction(() => document.getElementById('community-message').textContent.includes('未保存'));
  assert.equal(await page.locator('#stat-days').innerText(), '0');
  assert.equal(await page.locator('#checkin-result').isVisible(), false);
  assert.equal(await page.locator('#checkin-fields').evaluate(fieldset => fieldset.disabled), false);
  await page.evaluate(() => { communityMock.checkinError = ''; });
  await page.locator('#submit-checkin').click();
  await afterRefresh(page, () => document.getElementById('stat-minutes').textContent === '30');
  assert.equal(await page.locator('#stat-days').innerText(), '1');
  assert.equal(await page.locator('#stat-streak').innerText(), '1');
  assert.equal(await page.locator('#calendar-grid .is-checked').count(), 1);
  assert.equal(await page.locator('#checkin-fields').evaluate(fieldset => fieldset.disabled), true);
  assert.match(await page.locator('#checkin-result').innerText(), /仅自己可见/);
  assert.equal(await page.locator('#feed-list .feed-item').count(), 0);
  const attempts = await page.evaluate(() => communityMock.calls.filter(call => call[0] === 'checkIn').length);
  await page.evaluate(() => document.getElementById('checkin-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(await page.evaluate(() => communityMock.calls.filter(call => call[0] === 'checkIn').length), attempts, 'submitting the same day twice cannot repeat a write');

  await page.locator('#history-details summary').click();
  const sharing = page.locator('#history-list button[data-day="2026-11-09"]');
  await page.evaluate(() => { communityMock.privacyError = '分享设置未保存，请重试。'; });
  await sharing.click();
  await page.waitForFunction(() => document.getElementById('community-message').textContent.includes('未保存'));
  assert.equal(await sharing.getAttribute('data-public'), 'false');
  assert.equal(await page.locator('#feed-list .feed-item').count(), 0);
  await page.evaluate(() => { communityMock.privacyError = ''; });
  await sharing.click();
  await afterRefresh(page, () => document.querySelectorAll('#feed-list .feed-item').length === 1);
  assert.equal(await sharing.getAttribute('data-public'), 'true');
  assert.match(await page.locator('#feed-list').innerText(), /小星星/);
  assert.doesNotMatch(await page.locator('#feed-list').innerText(), /example\.test/);
  await page.locator('#tab-ranking').click();
  assert.equal(await page.locator('#panel-ranking').isVisible(), true);
  assert.equal(await page.locator('#leaderboard-list .rank-item').count(), 1);
  assert.match(await page.locator('#leaderboard-list').innerText(), /每天弹一点/);
  await sharing.click();
  await afterRefresh(page, () => document.querySelectorAll('#leaderboard-list .rank-item').length === 0);
  assert.equal(await sharing.getAttribute('data-public'), 'false');
  assert.equal(await page.locator('#feed-list .feed-item').count(), 0);
  assert.equal(await page.locator('#stat-minutes').innerText(), '30', 'private practice remains in personal totals');

  await page.locator('#sign-out').click();
  await page.locator('#login-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#account-panel').isVisible(), false);
  assert.equal(await page.locator('#stat-days').innerText(), '—');
  assert.equal(await page.locator('#history-list button').count(), 0);
  assert.equal(await page.locator('#calendar-grid .is-checked').count(), 0);
  assert.equal(await page.locator('#checkin-fields').evaluate(fieldset => fieldset.disabled), true);
  assert.equal(await page.locator('#practice-piece').inputValue(), '');
  assert.equal(await page.locator('#practice-note').inputValue(), '');
}));

test('an existing same-day check-in wins a multi-device race; public text is inert and fits mobile', { timeout: 30000 }, async () => fixture(async (page, base) => {
  await mock(page, { initial: 'a' });
  await page.goto(base + 'community.html');
  await afterRefresh(page, () => document.getElementById('stat-days').textContent === '0');
  await page.evaluate(() => { communityMock.duplicateNext = true; });
  await page.locator('#practice-minutes').fill('99');
  await page.locator('#practice-piece').fill('这条不能覆盖已保存记录');
  await page.locator('#submit-checkin').click();
  await afterRefresh(page, () => document.getElementById('stat-minutes').textContent === '20');
  assert.equal(await page.locator('#stat-days').innerText(), '1');
  assert.match(await page.locator('#community-message').innerText(), /已经打卡/);
  assert.match(await page.locator('#checkin-result').innerText(), /另一台设备已保存/);
  assert.doesNotMatch(await page.locator('#checkin-result').innerText(), /99|不能覆盖/);
  assert.equal(await page.locator('#checkin-fields').evaluate(fieldset => fieldset.disabled), true);

  const hostileNickname = '<svg onload=alert(1)>';
  const hostileNote = '<img src=x onerror="window.__communityXss=1">' + '无空格练习心得'.repeat(28);
  const longPiece = '卡林巴'.repeat(33);
  await page.evaluate(({ hostileNickname, hostileNote, longPiece }) => {
    const data = communityMock.data['user-a'];
    data.profile.nickname = hostileNickname;
    data.feed = [{ nickname: hostileNickname, day: data.today, minutes: 720, piece: longPiece, note: hostileNote, created_at: data.today + 'T02:00:00Z' }];
    data.leaderboard = [{ rank: 1, nickname: hostileNickname, days: 7, minutes: 5040, is_self: true }];
  }, { hostileNickname, hostileNote, longPiece });
  await page.locator('#refresh-community').click();
  await afterRefresh(page, () => document.getElementById('account-name').textContent.includes('<svg'));
  assert.equal(await page.locator('#account-name').innerText(), hostileNickname);
  assert.ok((await page.locator('#feed-list').innerText()).includes(hostileNote));
  assert.equal(await page.locator('#feed-list img, #feed-list svg, #leaderboard-list svg, #account-name svg').count(), 0);
  assert.equal(await page.evaluate(() => window.__communityXss), undefined);
  await page.locator('#tab-feed').focus();
  await page.locator('#tab-feed').press('ArrowRight');
  assert.equal(await page.locator('#tab-ranking').getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-ranking');
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    for (const tab of ['tab-ranking', 'tab-feed']) {
      await page.locator('#' + tab).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tab} must fit ${width}px with long user text`);
    }
  }
}));

test('late dashboards cannot reveal the previous account after account switching or logout', { timeout: 30000 }, async () => fixture(async (page, base) => {
  await mock(page, { initial: 'a', holdUsers: ['user-a'] });
  await page.goto(base + 'community.html');
  await page.waitForFunction(() => communityMock.held.length > 0);
  await page.evaluate(() => {
    communityMock.data['user-b'].stats = { total_days: 22, total_minutes: 340, current_streak: 2 };
    communityMock.switchAccount('b');
  });
  await afterRefresh(page, () => document.getElementById('stat-days').textContent === '22');
  await page.evaluate(() => communityMock.releaseAll());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#account-name').innerText(), '第二位琴友');
  assert.equal(await page.locator('#account-email').innerText(), 'kalimba.b@example.test');
  assert.equal(await page.locator('#stat-minutes').innerText(), '340');
  assert.equal(await page.locator('#stat-days').innerText(), '22');
  await page.evaluate(() => { communityMock.holdUsers = ['user-b']; });
  await page.locator('#refresh-community').click();
  await page.waitForFunction(() => communityMock.held.length > 0);
  await page.locator('#sign-out').click();
  await page.locator('#login-panel').waitFor({ state: 'visible' });
  await page.evaluate(() => communityMock.releaseAll());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#stat-days').innerText(), '—');
  assert.equal(await page.locator('#account-email').innerText(), '');
  assert.equal(await page.locator('#account-panel').isVisible(), false);
  assert.equal(await page.locator('#history-list button').count(), 0);
  assert.equal(await page.locator('#checkin-fields').evaluate(fieldset => fieldset.disabled), true);
}));

test('storage limitations discovered during initialization are visible to the user', { timeout: 30000 }, async () => fixture(async (page, base) => {
  await mock(page, { storageWarning: true });
  await page.goto(base + 'community.html');
  await page.waitForFunction(() => !document.getElementById('login-email').disabled);
  assert.equal(await page.locator('#service-notice').isVisible(), true);
  assert.match(await page.locator('#service-notice').innerText(), /无法保存登录状态|当前页面|重新验证/);
}));
