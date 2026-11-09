const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCommunityClient } = require('../community/cloudbase-client.js');

const config = { provider: 'cloudbase', envId: 'test-community-123456', region: 'ap-shanghai', enabled: true };
const member = { user: { id: 'member-1', email: 'member@example.test', is_anonymous: false }, access_token: 'test-token' };
const profile = { sub: 'member-1', email: 'member@example.test', email_verified: true };
const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture(options = {}) {
  const calls = [], stored = new Map();
  let callback, initOptions;
  const responses = {
    getSession: { data: { session: options.session || null }, error: null },
    getCurrentUser: options.profile === undefined ? profile : options.profile,
    verify: { data: { session: member }, error: null },
    signOut: { data: {}, error: null },
    rpc: { data: { ok: true }, error: null },
  };
  const record = name => (...args) => {
    calls.push({ name, args });
    return typeof responses[name] === 'function' ? responses[name](...args) : Promise.resolve(responses[name]);
  };
  responses.signInWithOtp = { data: { verifyOtp: record('verify') }, error: null };
  const auth = {
    getSession: record('getSession'), getCurrentUser: record('getCurrentUser'), signInWithOtp: record('signInWithOtp'), signOut: record('signOut'),
    onAuthStateChange(cb) { callback = cb; return { data: { subscription: { unsubscribe() {} } } }; }
  };
  const app = { auth: () => auth, rdb: () => ({ rpc: record('rpc') }) };
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  const client = createCommunityClient(options.config || config, {
    storage, cloudbase: { init(value) { calls.push({ name: 'init', args: [value] }); initOptions = value; return app; } }, ...options.dependencies
  });
  return { client, calls, responses, stored, get initOptions() { return initOptions; }, event(name, session, info) { callback(name, session, info); } };
}

test('disabled or invalid environment never initializes an SDK or supplies fake data', async () => {
  for (const value of [{ ...config, enabled: false }, { ...config, enabled: 'true' }, { ...config, envId: '' }, { ...config, region: 'https://wrong' }, { ...config, secretKey: 'private' }]) {
    const f = fixture({ config: value });
    assert.equal(f.client.configured, false);
    await assert.rejects(f.client.init(), error => error.code === 'not_configured');
    assert.equal(f.calls.length, 0);
    assert.ok(!f.client.getConfiguration().error.includes('private'));
  }
});

test('initialization uses only public environment settings and does not enable anonymous or URL login', async () => {
  const f = fixture({ session: member });
  assert.equal(await f.client.init(), member);
  assert.equal(await f.client.init(), member);
  assert.equal(f.calls.filter(call => call.name === 'init').length, 1);
  assert.equal(f.initOptions.env, config.envId);
  assert.equal(f.initOptions.region, config.region);
  assert.equal(f.initOptions.timeout, 15000);
  assert.equal(f.initOptions.auth.detectSessionInUrl, false);
  assert.equal(f.initOptions.persistence, 'local');
  assert.equal(f.initOptions.debug, false);
  assert.equal(f.initOptions.accessKey, undefined);
  assert.equal(f.initOptions.auth.secretKey, undefined);
});

test('unauthenticated getSession means logged out while network failures remain visible and retryable', async () => {
  const f = fixture();
  f.responses.getSession = { error: { code: 'unauthenticated' } };
  assert.equal(await f.client.init(), null);
  await assert.rejects(f.client.dashboard(), error => error.code === 'not_authenticated');
  const broken = fixture();
  broken.responses.getSession = { error: { code: 'unreachable' } };
  await assert.rejects(broken.client.init(), error => error.code === 'network');
  broken.responses.getSession = { data: { session: member } };
  assert.equal(await broken.client.init(), member);
});

test('anonymous, unverified or mismatched cached profiles cannot become community members', async () => {
  for (const options of [
    { session: { ...member, user: { ...member.user, is_anonymous: true } } },
    { session: member, profile: { ...profile, email_verified: false } },
    { session: member, profile: { ...profile, sub: 'different-user' } },
    { session: member, profile: { ...profile, email: 'different@example.test' } },
  ]) {
    const f = fixture(options);
    assert.equal(await f.client.init(), null);
    await assert.rejects(f.client.dashboard(), error => error.code === 'not_authenticated');
    assert.equal(f.calls.filter(call => call.name === 'rpc').length, 0);
  }
});

test('OTP verifies through the returned challenge callback to support first-time registration', async () => {
  const f = fixture();
  await f.client.sendCode(' Member@Example.Test ');
  assert.deepEqual(f.calls.find(call => call.name === 'signInWithOtp').args, [{ email: 'member@example.test', options: { shouldCreateUser: true } }]);
  assert.equal(await f.client.verifyCode('member@example.test', '001 234'), member);
  assert.deepEqual(f.calls.find(call => call.name === 'verify').args, [{ token: '001234' }]);
  assert.equal(await f.client.init(), member);
  await assert.rejects(f.client.verifyCode('member@example.test', '001234'), error => error.code === 'verification_required');
});

test('verification requires the matching email and current challenge, and malformed values never send', async () => {
  const f = fixture();
  await assert.rejects(f.client.sendCode('not-an-email'), error => error.code === 'invalid_email');
  await assert.rejects(f.client.verifyCode('member@example.test', 123456), error => error.code === 'invalid_otp');
  await assert.rejects(f.client.verifyCode('member@example.test', '123456'), error => error.code === 'verification_required');
  assert.equal(f.calls.length, 0);
  await f.client.sendCode('member@example.test');
  await assert.rejects(f.client.verifyCode('someone@example.test', '123456'), error => error.code === 'verification_required');
  f.responses.verify = { error: { code: 'invalid_argument', message: 'verification failed with private details' } };
  await assert.rejects(f.client.verifyCode('member@example.test', '123456'), error => error.code === 'invalid_otp' && !error.message.includes('private'));
  f.responses.verify = { data: { session: member } };
  assert.equal(await f.client.verifyCode('member@example.test', '001234'), member, 'an incorrect attempt must not discard the current challenge');
});

test('a slow older send cannot replace a newer email challenge', async () => {
  const f = fixture();
  let firstResolve;
  const used = [];
  f.responses.signInWithOtp = ({ email }) => email === 'old@example.test' ? new Promise(resolve => { firstResolve = resolve; }) : Promise.resolve({ data: { verifyOtp: async () => { used.push('new'); return { data: { session: member } }; } } });
  const first = f.client.sendCode('old@example.test');
  await Promise.resolve();
  await f.client.sendCode('member@example.test');
  firstResolve({ data: { verifyOtp: () => { used.push('old'); } } });
  await first;
  await f.client.verifyCode('member@example.test', '123456');
  assert.deepEqual(used, ['new']);
});

test('auth events notify after credential callbacks and obsolete session restoration cannot overwrite them', async () => {
  const f = fixture();
  let resolveRestore;
  f.responses.getSession = () => new Promise(resolve => { resolveRestore = resolve; });
  const restoring = f.client.init();
  await Promise.resolve();
  const sessions = [];
  let inCallback = true;
  const unsubscribe = f.client.subscribe(value => { assert.equal(inCallback, false); sessions.push(value); });
  f.event('SIGNED_IN', member);
  inCallback = false;
  resolveRestore({ data: { session: null } });
  assert.equal(await restoring, member);
  await nextTask();
  assert.equal(sessions.at(-1), member);
  unsubscribe();
  const count = sessions.length;
  f.event('SIGNED_OUT', null);
  await nextTask();
  assert.equal(sessions.length, count);
  assert.equal(await f.client.init(), null);
});

test('PostgreSQL RPC names, arguments and returned data match the backend contract', async () => {
  const f = fixture({ session: member });
  await f.client.dashboard();
  await f.client.updateProfile('  每天练琴  ');
  await f.client.checkIn({ minutes: 25, piece: '  小星星  ', note: '第一行\n第二行', isPublic: true });
  await f.client.setCheckinPublic('2026-11-09', false);
  assert.deepEqual(f.calls.filter(call => call.name === 'rpc').map(call => call.args), [
    ['community_dashboard', undefined],
    ['community_update_profile', { p_nickname: '每天练琴' }],
    ['community_check_in', { p_minutes: 25, p_piece: '小星星', p_note: '第一行\n第二行', p_is_public: true }],
    ['community_set_checkin_public', { p_day: '2026-11-09', p_is_public: false }]
  ]);
  f.responses.rpc = { data: { created: false }, error: null };
  assert.deepEqual(await f.client.dashboard(), { created: false });
  f.responses.rpc = { error: { code: '22023', message: 'private details' } };
  await assert.rejects(f.client.dashboard(), error => error.code === 'invalid_input' && !error.message.includes('private'));
});

test('invalid mutations never reach PostgreSQL', async () => {
  const f = fixture({ session: member });
  for (const nickname of ['一', '琴@example.test', '琴\n友', '字'.repeat(25)]) await assert.rejects(f.client.updateProfile(nickname));
  for (const input of [{ minutes: 0 }, { minutes: 721 }, { minutes: '10' }, { minutes: 20, piece: '曲\n名' }, { minutes: 20, note: '\u0001' }, { minutes: 20, isPublic: 'true' }]) await assert.rejects(f.client.checkIn(input));
  await assert.rejects(f.client.setCheckinPublic('2026-02-30', true));
  assert.equal(f.calls.length, 0);
});

test('PostgreSQL auth, validation, missing record and missing procedure errors are translated', async () => {
  for (const [code, expected] of [['42501', 'not_authenticated'], ['22023', 'invalid_input'], ['22P02', 'invalid_input'], ['P0002', 'not_found'], ['PGRST202', 'backend_unavailable']]) {
    const f = fixture({ session: member });
    f.responses.rpc = { error: { code, message: 'private database details' } };
    await assert.rejects(f.client.dashboard(), error => error.code === expected && !error.message.includes('private'));
  }
});

test('storage failures use memory with both CloudBase storage interfaces and expose a warning', async () => {
  const f = fixture({ dependencies: { storage: { setItem() { throw new Error('blocked'); } } } });
  await f.client.init();
  assert.equal(f.initOptions.persistence, 'none');
  const storage = f.initOptions.storage;
  await storage.setItem('credentials', 'value');
  assert.equal(storage.getItemSync('credentials'), 'value');
  storage.removeItemSync('credentials');
  assert.equal(await storage.getItem('credentials'), null);
  assert.match(f.client.getConfiguration().storageWarning, /当前页面有效/);
});

test('signout clears session and OTP challenge and does not use Supabase-specific scope', async () => {
  const f = fixture();
  await f.client.sendCode('member@example.test');
  await f.client.verifyCode('member@example.test', '123456');
  await f.client.sendCode('member@example.test');
  await f.client.signOut();
  assert.deepEqual(f.calls.find(call => call.name === 'signOut').args, []);
  assert.equal(await f.client.init(), null);
  await assert.rejects(f.client.verifyCode('member@example.test', '123456'), error => error.code === 'verification_required');
  await assert.rejects(f.client.dashboard(), error => error.code === 'not_authenticated');
});

test('network operations have a bounded timeout and server messages are not exposed', async () => {
  const f = fixture({ dependencies: { timeoutMs: 15 } });
  f.responses.signInWithOtp = () => new Promise(() => {});
  await assert.rejects(f.client.sendCode('member@example.test'), error => error.code === 'timeout');
  f.responses.signInWithOtp = { error: { code: 'unexpected', message: 'private email and token' } };
  await assert.rejects(f.client.sendCode('member@example.test'), error => error.code === 'request_failed' && !error.message.includes('private'));
});

test('vendored SDK includes pinned version, Apache license and the original CDN bundle checksum', () => {
  const content = fs.readFileSync(path.join(__dirname, '../vendor/cloudbase.min.js'), 'utf8');
  assert.match(content, /@cloudbase\/js-sdk 3\.11\.0/);
  assert.match(content, /Apache License/);
  const checksum = content.match(/Bundle SHA-256: ([a-f0-9]{64})/)[1];
  const bundle = content.slice(content.indexOf('/*! For license information please see cloudbase.full.js.LICENSE.txt */'));
  assert.equal(crypto.createHash('sha256').update(bundle).digest('hex'), checksum);
});
