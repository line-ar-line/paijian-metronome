const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createCommunityClient } = require('../community/client.js');

const config = { supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'sb_publishable_test_public_key' };
const signedIn = { access_token: 'private-test-token', user: { id: 'member-1', email: 'person@example.com' } };
const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));
const legacyKey = role => `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.${Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url')}.signature`;

function fixture(options = {}) {
  const calls = [];
  const stored = new Map();
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  let authCallback;
  let sdkOptions;
  const responses = {
    getSession: { data: { session: options.session ?? null }, error: null },
    signInWithOtp: { data: {}, error: null },
    verifyOtp: { data: { session: signedIn }, error: null },
    signOut: { error: null },
    rpc: { data: { ok: true }, error: null },
  };
  const record = name => (...args) => {
    calls.push({ name, args });
    return typeof responses[name] === 'function' ? responses[name](...args) : Promise.resolve(responses[name]);
  };
  const sdk = {
    auth: {
      getSession: record('getSession'), signInWithOtp: record('signInWithOtp'), verifyOtp: record('verifyOtp'), signOut: record('signOut'),
      onAuthStateChange(callback) { authCallback = callback; return { data: { subscription: { unsubscribe() {} } } }; }
    },
    rpc: record('rpc')
  };
  const client = createCommunityClient(options.config || config, {
    storage,
    createClient(url, key, suppliedOptions) { calls.push({ name: 'createClient', args: [url, key] }); sdkOptions = suppliedOptions; return sdk; },
    ...options.dependencies
  });
  return { client, calls, responses, stored, get sdkOptions() { return sdkOptions; }, auth(event, session) { return authCallback(event, session); } };
}

test('empty configuration disables the real service and never substitutes sample data', async () => {
  const f = fixture({ config: { supabaseUrl: '', supabasePublishableKey: '' } });
  assert.equal(f.client.configured, false);
  assert.match(f.client.getConfiguration().error, /尚未连接服务/);
  await assert.rejects(f.client.init(), error => error.code === 'not_configured');
  await assert.rejects(f.client.dashboard(), error => error.code === 'not_configured');
  assert.equal(f.calls.length, 0);
});

test('configuration accepts public keys and safe project roots only', () => {
  for (const key of [config.supabasePublishableKey, legacyKey('anon')]) {
    assert.equal(createCommunityClient({ ...config, supabasePublishableKey: key }).configured, true);
  }
  for (const url of ['https://custom.example.com/', 'http://localhost:54321', 'http://127.0.0.1:54321', 'http://[::1]:54321']) {
    assert.equal(createCommunityClient({ ...config, supabaseUrl: url }).configured, true);
  }
  for (const url of ['http://example.com', 'javascript:alert(1)', 'https://user:password@example.com', 'https://example.com/rest/v1', 'https://example.com/?key=x', 'https://example.com/#x']) {
    assert.equal(createCommunityClient({ ...config, supabaseUrl: url }).configured, false, url);
  }
});

test('service role, secret keys and user JWTs are refused before SDK creation without echoing secrets', async () => {
  for (const key of ['sb_secret_do_not_publish', legacyKey('service_role'), legacyKey('authenticated'), 'service_role', 'not-a-public-key']) {
    const f = fixture({ config: { ...config, supabasePublishableKey: key } });
    assert.equal(f.client.configured, false);
    assert.ok(!f.client.getConfiguration().error.includes(key));
    await assert.rejects(f.client.init(), error => error.code === 'not_configured' && !error.message.includes(key));
    assert.equal(f.calls.length, 0);
    assert.deepEqual(Object.keys(f.client.getConfiguration()).sort(), ['configured', 'error', 'storageWarning']);
  }
});

test('SDK persists and refreshes sessions without accepting login state from the URL', async () => {
  const f = fixture({ session: signedIn });
  assert.equal(await f.client.init(), signedIn);
  assert.equal(await f.client.init(), signedIn);
  assert.equal(f.calls.filter(call => call.name === 'createClient').length, 1);
  assert.equal(f.calls.filter(call => call.name === 'getSession').length, 1);
  assert.equal(f.sdkOptions.auth.persistSession, true);
  assert.equal(f.sdkOptions.auth.autoRefreshToken, true);
  assert.equal(f.sdkOptions.auth.detectSessionInUrl, false);
  assert.equal(f.sdkOptions.auth.debug, false);
  f.sdkOptions.auth.storage.setItem('session-key', 'session-value');
  assert.equal(f.stored.get('session-key'), 'session-value');
  f.sdkOptions.auth.storage.removeItem('session-key');
  assert.equal(f.stored.size, 0);
});

test('OTP send and verify pass normalized addresses and string tokens with correct Supabase options', async () => {
  const f = fixture();
  assert.equal(await f.client.init(), null);
  await f.client.sendCode(' Person@Example.COM ');
  assert.deepEqual(f.calls.find(call => call.name === 'signInWithOtp').args, [{ email: 'person@example.com', options: { shouldCreateUser: true } }]);
  assert.equal(await f.client.verifyCode(' Person@Example.COM ', '001 234'), signedIn);
  assert.deepEqual(f.calls.find(call => call.name === 'verifyOtp').args, [{ email: 'person@example.com', token: '001234', type: 'email' }]);
  assert.equal(await f.client.init(), signedIn, 'init must return the verified state after an initial logged-out session');
  await f.client.signOut();
  assert.deepEqual(f.calls.find(call => call.name === 'signOut').args, [{ scope: 'local' }]);
});

test('malformed emails and OTPs are rejected before any authentication request', async () => {
  const f = fixture();
  for (const value of ['', 'person', 'person@@example.com', 'person @example.com', null]) {
    await assert.rejects(f.client.sendCode(value), error => error.code === 'invalid_email');
  }
  for (const value of ['', 123456, '123', 'abc123', '12345678901']) {
    await assert.rejects(f.client.verifyCode('person@example.com', value), error => error.code === 'invalid_otp');
  }
  assert.equal(f.calls.length, 0);
});

test('auth notifications leave the SDK callback before subscribers issue RPC requests and support unsubscribe', async () => {
  const f = fixture();
  await f.client.init();
  let inSdkCallback = false;
  const sessions = [];
  const unsubscribe = f.client.subscribe(session => {
    assert.equal(inSdkCallback, false);
    sessions.push(session);
    if (session) void f.client.dashboard();
  });
  await nextTask();
  inSdkCallback = true;
  assert.equal(f.auth('SIGNED_IN', signedIn), undefined, 'the SDK callback must be synchronous');
  assert.deepEqual(sessions, [null]);
  inSdkCallback = false;
  await nextTask();
  assert.deepEqual(sessions, [null, signedIn]);
  assert.equal(f.calls.filter(call => call.name === 'rpc').length, 1);
  assert.equal(await f.client.init(), signedIn, 'init returns the current session after auth events');
  unsubscribe();
  f.auth('SIGNED_OUT', null);
  await nextTask();
  assert.equal(sessions.length, 2);
});

test('RPC names and argument shapes match the community database API', async () => {
  const f = fixture({ session: signedIn });
  const dashboard = { profile: { nickname: '练琴的人' }, checkins: [] };
  f.responses.rpc = { data: dashboard, error: null };
  assert.equal(await f.client.dashboard(), dashboard);
  await f.client.updateProfile('  练琴的人  ');
  await f.client.checkIn({ minutes: 35, piece: '  小星星  ', note: '  今天练慢一点。  ', isPublic: true });
  await f.client.setCheckinPublic('2026-11-09', false);
  assert.deepEqual(f.calls.filter(call => call.name === 'rpc').map(call => call.args), [
    ['community_dashboard', undefined],
    ['community_update_profile', { p_nickname: '练琴的人' }],
    ['community_check_in', { p_minutes: 35, p_piece: '小星星', p_note: '今天练慢一点。', p_is_public: true }],
    ['community_set_checkin_public', { p_day: '2026-11-09', p_is_public: false }]
  ]);
});

test('logged-out users cannot call private RPCs and malformed inputs cannot mutate data', async () => {
  const f = fixture();
  await assert.rejects(f.client.dashboard(), error => error.code === 'not_authenticated');
  await assert.rejects(f.client.updateProfile(' '), error => error.code === 'invalid_profile');
  for (const minutes of [0, -1, 1.5, 721, NaN, '10']) await assert.rejects(f.client.checkIn({ minutes }), error => error.code === 'invalid_checkin');
  await assert.rejects(f.client.updateProfile('字'.repeat(25)), error => error.code === 'invalid_profile');
  await assert.rejects(f.client.checkIn({ minutes: 20, piece: '字'.repeat(101) }), error => error.code === 'invalid_checkin');
  await assert.rejects(f.client.checkIn({ minutes: 20, note: '字'.repeat(281) }), error => error.code === 'invalid_checkin');
  await assert.rejects(f.client.checkIn({ minutes: 20, isPublic: 'true' }), error => error.code === 'invalid_checkin');
  for (const day of ['2026-02-30', '2026-13-09', '2026-1-1', 'today']) await assert.rejects(f.client.setCheckinPublic(day, true), error => error.code === 'invalid_checkin');
  assert.equal(f.calls.filter(call => call.name === 'rpc').length, 0);
});

test('public nicknames reject email-like values and control characters while counting Unicode characters', async () => {
  const f = fixture({ session: signedIn });
  for (const nickname of ['琴友@example.com', '琴\n友', '琴\t友', '琴\u007f友', '琴\u0085友']) {
    await assert.rejects(f.client.updateProfile(nickname), error => error.code === 'invalid_profile');
  }
  assert.equal(f.calls.length, 0);
  await f.client.updateProfile('🎹'.repeat(24));
  assert.equal(f.calls.find(call => call.name === 'rpc').args[1].p_nickname, '🎹'.repeat(24));
});

test('check-in text rejects hidden control characters and permits normal multiline notes', async () => {
  const f = fixture({ session: signedIn });
  await assert.rejects(f.client.checkIn({ minutes: 15, piece: '小\n星星' }), error => error.code === 'invalid_checkin');
  await assert.rejects(f.client.checkIn({ minutes: 15, piece: '小\u007f星星' }), error => error.code === 'invalid_checkin');
  await assert.rejects(f.client.checkIn({ minutes: 15, note: '今天\u0001练琴' }), error => error.code === 'invalid_checkin');
  assert.equal(f.calls.length, 0);
  const note = '第一行\n第二行\r\n\t慢练';
  await f.client.checkIn({ minutes: 15, piece: '小星星', note });
  assert.equal(f.calls.find(call => call.name === 'rpc').args[1].p_note, note);
});

test('an auth event arriving during session restoration wins over an older getSession result', async () => {
  const f = fixture();
  let resolveSession;
  f.responses.getSession = () => new Promise(resolve => { resolveSession = resolve; });
  const restoring = f.client.init();
  await Promise.resolve();
  f.auth('SIGNED_IN', signedIn);
  resolveSession({ data: { session: null }, error: null });
  assert.equal(await restoring, signedIn);
  assert.equal(await f.client.init(), signedIn);
});

test('blocked local storage retains an in-memory session and exposes a clear caveat', async () => {
  const f = fixture({ dependencies: { storage: { setItem() { throw new Error('blocked'); } } } });
  await f.client.init();
  const storage = f.sdkOptions.auth.storage;
  storage.setItem('session', 'private value');
  assert.equal(storage.getItem('session'), 'private value');
  storage.removeItem('session');
  assert.equal(storage.getItem('session'), null);
  assert.match(f.client.getConfiguration().storageWarning, /当前页面有效.*刷新后/);
  assert.equal(await f.client.verifyCode('person@example.com', '123456'), signedIn);
});

test('storage failure after initialization falls back without dropping an in-memory write', async () => {
  let blocked = false;
  const f = fixture({ dependencies: { storage: {
    getItem() { if (blocked) throw new Error('blocked'); return null; },
    setItem() { if (blocked) throw new Error('blocked'); },
    removeItem() { if (blocked) throw new Error('blocked'); }
  } } });
  await f.client.init();
  blocked = true;
  f.sdkOptions.auth.storage.setItem('session', 'value');
  assert.equal(f.sdkOptions.auth.storage.getItem('session'), 'value');
  assert.match(f.client.getConfiguration().storageWarning, /浏览器未允许/);
});

test('auth and backend failures are mapped to Chinese errors without exposing server messages', async () => {
  const cases = [
    [{ code: 'otp_expired' }, 'invalid_otp', /验证码/],
    [{ status: 429 }, 'rate_limited', /太频繁/],
    [{ code: 'email_provider_disabled' }, 'auth_unavailable', /邮箱登录/],
    [{ code: 'PGRST202' }, 'backend_unavailable', /尚未初始化/],
    [{ status: 401 }, 'session_expired', /登录已失效/],
    [{ name: 'TypeError', message: 'Failed to fetch' }, 'network', /检查网络/],
    [{ code: 'unexpected', message: 'sensitive person@example.com token private-test-token' }, 'request_failed', /稍后重试/]
  ];
  for (const [error, code, message] of cases) {
    const f = fixture();
    f.responses.signInWithOtp = { data: null, error };
    await assert.rejects(f.client.sendCode('person@example.com'), actual => actual.code === code && message.test(actual.message) && !/person@example.com|private-test-token/.test(actual.message));
  }
});

test('database errors distinguish sign-in, validation and missing private records', async () => {
  for (const [code, expected, wording] of [
    ['42501', 'not_authenticated', /重新.*登录/],
    ['22023', 'invalid_input', /填写内容不符合要求/],
    ['22P02', 'invalid_input', /填写内容不符合要求/],
    ['P0002', 'not_found', /没有找到这一天的打卡记录/],
    ['42883', 'backend_unavailable', /尚未初始化/]
  ]) {
    const f = fixture({ session: signedIn });
    f.responses.rpc = { data: null, error: { code, message: 'server detail must stay private' } };
    await assert.rejects(f.client.dashboard(), error => error.code === expected && wording.test(error.message) && !error.message.includes('server detail'));
  }
});

test('failed initialization can be retried and verification requires a returned session', async () => {
  const f = fixture();
  f.responses.getSession = { data: null, error: { status: 503 } };
  await assert.rejects(f.client.init(), error => error.code === 'request_failed');
  f.responses.getSession = { data: { session: signedIn }, error: null };
  assert.equal(await f.client.init(), signedIn);
  f.responses.verifyOtp = { data: {}, error: null };
  await assert.rejects(f.client.verifyCode('person@example.com', '123456'), error => error.code === 'session_missing');
});

test('authentication operations and network fetches have bounded deadlines', async () => {
  let fetchSignal;
  const f = fixture({ dependencies: { timeoutMs: 20, fetch(_input, options) { fetchSignal = options.signal; return new Promise(() => {}); } } });
  f.responses.signInWithOtp = () => new Promise(() => {});
  await assert.rejects(f.client.sendCode('person@example.com'), error => error.code === 'timeout');
  await assert.rejects(f.sdkOptions.global.fetch('https://example.supabase.co/auth/v1/otp'), error => error.code === 'timeout');
  assert.equal(fetchSignal.aborted, true);
});

test('network cancellation propagates from the SDK and listener cleanup does not block completion', async () => {
  const controller = new AbortController();
  let requestSignal;
  const f = fixture({ dependencies: { fetch(_input, options) { requestSignal = options.signal; return Promise.resolve({ ok: true }); } } });
  await f.client.init();
  controller.abort();
  await f.sdkOptions.global.fetch('https://example.supabase.co', { signal: controller.signal });
  assert.equal(requestSignal.aborted, true);
});

test('vendored official SDK retains its pinned version, license and upstream checksum', () => {
  const content = fs.readFileSync(path.join(__dirname, '../vendor/supabase.min.js'), 'utf8');
  assert.match(content, /@supabase\/supabase-js 2\.119\.0/);
  assert.match(content, /MIT License/);
  assert.match(content, /Copyright \(c\) 2020 Supabase/);
  const checksum = content.match(/Bundle SHA-256: ([a-f0-9]{64})/)[1];
  const bundle = content.slice(content.indexOf(' */\n') + 4);
  assert.equal(crypto.createHash('sha256').update(bundle).digest('hex'), checksum);
  const context = {};
  vm.runInNewContext(content, context, { timeout: 2000 });
  assert.equal(typeof context.supabase.createClient, 'function');
});
