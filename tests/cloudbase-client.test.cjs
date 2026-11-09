const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCommunityClient } = require('../community/cloudbase-client.js');

const config = { provider: 'cloudbase', envId: 'test-community-123456', region: 'ap-shanghai', enabled: true, registrationUrl: 'https://signup.example.test/register' };
const member = { user: { id: 'member-1', username: 'Practice_User', email: '', is_anonymous: false }, access_token: 'test-token' };
const profile = { sub: 'member-1', username: 'Practice_User', email: '', email_verified: false, loginType: 'USERNAME' };
const password = 'Practice123!';
const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture(options = {}) {
  const calls = [], stored = new Map();
  let callback, initOptions;
  const responses = {
    getSession: { data: { session: options.session || null }, error: null },
    getCurrentUser: options.profile === undefined ? profile : options.profile,
    signInWithPassword: { data: { session: member }, error: null },
    registration: { status: 201, json: async () => ({ ok: true }) },
    signOut: { data: {}, error: null },
    rpc: { data: { ok: true }, error: null },
  };
  const record = name => (...args) => {
    calls.push({ name, args });
    return typeof responses[name] === 'function' ? responses[name](...args) : Promise.resolve(responses[name]);
  };
  const auth = {
    getSession: record('getSession'), getCurrentUser: record('getCurrentUser'), signInWithPassword: record('signInWithPassword'), signOut: record('signOut'),
    onAuthStateChange(cb) { callback = cb; return { data: { subscription: { unsubscribe() {} } } }; }
  };
  const app = { auth: () => auth, rdb: () => ({ rpc: record('rpc') }) };
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  const client = createCommunityClient(options.config || config, {
    storage, fetch: record('registration'), cloudbase: { init(value) { calls.push({ name: 'init', args: [value] }); initOptions = value; return app; } }, ...options.dependencies
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
  assert.deepEqual(await f.client.init(), member);
  assert.deepEqual(await f.client.init(), member);
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
  assert.deepEqual(await broken.client.init(), member);
});

test('anonymous, missing and mismatched auth profiles cannot become community members', async () => {
  for (const options of [
    { session: { ...member, user: { ...member.user, is_anonymous: true } } },
    { session: member, profile: null },
    { session: member, profile: { ...profile, loginType: 'ANONYMOUS' } },
    { session: member, profile: { ...profile, isAnonymous: true } },
    { session: member, profile: { ...profile, sub: 'different-user' } },
    { session: member, profile: { ...profile, username: 'Other_User' } },
  ]) {
    const f = fixture(options);
    assert.equal(await f.client.init(), null);
    await assert.rejects(f.client.dashboard(), error => error.code === 'not_authenticated');
    assert.equal(f.calls.filter(call => call.name === 'rpc').length, 0);
  }
});

test('username is normalized from the official profile while existing email identities retain their user ID', async () => {
  const sdkMember = { ...member, user: { id: member.user.id, user_metadata: { username: profile.username } } };
  const f = fixture({ session: sdkMember });
  const restored = await f.client.init();
  assert.equal(restored.user.username, profile.username);
  assert.equal(restored.user.id, member.user.id);
  assert.equal(sdkMember.user.username, undefined, 'do not mutate the SDK session');
  const old = fixture({ session: { user: { id: 'old-account', email: 'old@example.test' } }, profile: { sub: 'old-account', email: 'old@example.test', email_verified: true } });
  assert.equal((await old.client.init()).user.id, 'old-account');
});

test('password sign-in preserves username case and password, rejects unverified identity, and never calls email APIs', async () => {
  const f = fixture();
  assert.deepEqual(await f.client.signIn(' Practice_User ', password), member);
  assert.deepEqual(f.calls.find(call => call.name === 'signInWithPassword').args, [{ username: 'Practice_User', password }]);
  assert.deepEqual(await f.client.init(), member);
  assert.equal(f.client.sendCode, undefined);
  assert.equal(f.client.verifyCode, undefined);
  f.responses.getCurrentUser = { ...profile, sub: 'different-user' };
  await assert.rejects(f.client.signIn('Practice_User', password), error => error.code === 'invalid_session');
  assert.equal([...f.stored.values()].some(value => String(value).includes(password)), false);
});

test('registration creates an account over HTTPS then independently signs in with the official SDK', async () => {
  const f = fixture();
  f.responses.registration = { status: 201, json: async () => ({ ok: true, session: { user: { id: 'untrusted-user' } }, access_token: 'untrusted-token' }) };
  const result = await f.client.signUp(' Practice_User ', password);
  assert.deepEqual(result, member);
  const request = f.calls.find(call => call.name === 'registration').args;
  assert.equal(request[0], config.registrationUrl);
  assert.deepEqual(JSON.parse(request[1].body), { username: 'Practice_User', password });
  for (const [key, value] of Object.entries({ method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' })) assert.equal(request[1][key], value);
  assert.equal(request[1].headers['Content-Type'], 'application/json');
  assert.ok(f.calls.findIndex(call => call.name === 'registration') < f.calls.findIndex(call => call.name === 'signInWithPassword'));
  assert.equal([...f.stored.values()].some(value => String(value).includes(password)), false);
});

test('malformed registration and empty login values never reach any service; login does not enforce new password rules', async () => {
  const f = fixture();
  for (const username of ['', 'ab', '1hello', 'abc-', '_hello', 'a'.repeat(33), 'name@example.test', '中英文']) await assert.rejects(f.client.signUp(username, password), error => error.code === 'invalid_username');
  for (const value of ['', 'Ab1!', 'alllowercase', '!Abc12345', 'Abc1234 ', 'Abc1234.', 'Abc1234汉', 'abcd123\\', 'Abc1234'.repeat(5)]) await assert.rejects(f.client.signUp('Practice_User', value), error => error.code === 'invalid_password');
  await assert.rejects(f.client.signIn('', password), error => error.code === 'invalid_username');
  await assert.rejects(f.client.signIn('Practice_User', ''), error => error.code === 'invalid_password');
  assert.equal(f.calls.length, 0);
  await f.client.signIn('Practice_User', 'old password');
  assert.equal(f.calls.find(call => call.name === 'signInWithPassword').args[0].password, 'old password');
});

test('registration refuses missing, insecure or credential-bearing endpoints', async () => {
  for (const registrationUrl of [undefined, '/register', 'http://signup.example.test/register', 'https://user:secret@signup.example.test/register', 'https://signup.example.test/register#fragment']) {
    const f = fixture({ config: { ...config, registrationUrl } });
    await assert.rejects(f.client.signUp('Practice_User', password), error => error.code === 'registration_unavailable');
    assert.equal(f.calls.length, 0);
  }
});

test('failed or malformed registration never signs in; server messages stay private', async () => {
  for (const [code, expected] of [['username_taken', 'username_taken'], ['invalid_username', 'invalid_username'], ['weak_password', 'invalid_password'], ['rate_limited', 'rate_limited'], ['registration_unavailable', 'registration_unavailable']]) {
    const f = fixture();
    f.responses.registration = { status: 400, json: async () => ({ error: { code, message: 'private server details' } }) };
    await assert.rejects(f.client.signUp('Practice_User', password), error => error.code === expected && !error.message.includes('private'));
    assert.equal(f.calls.filter(call => call.name === 'signInWithPassword').length, 0);
  }
  for (const response of [{ status: 201, json: async () => ({ session: member }) }, { status: 500, json: async () => ({ ok: true }) }, { status: 201, json: async () => { throw Error('not json'); } }]) {
    const f = fixture(); f.responses.registration = response;
    await assert.rejects(f.client.signUp('Practice_User', password), error => error.code === 'registration_unavailable');
    assert.equal(f.calls.filter(call => call.name === 'signInWithPassword').length, 0);
  }
});

test('successful account creation followed by failed sign-in tells the user to log in without registering twice', async () => {
  const f = fixture();
  f.responses.signInWithPassword = { error: { code: 'unreachable' } };
  await assert.rejects(f.client.signUp('Practice_User', password), error => error.code === 'account_created' && /账号已创建/.test(error.message));
  assert.equal(f.calls.filter(call => call.name === 'registration').length, 1);
  assert.equal(f.calls.filter(call => call.name === 'signInWithPassword').length, 1);
});

test('invalid credentials and service errors produce safe actionable messages', async () => {
  for (const [sdkError, expected] of [
    [{ code: 'invalid_username_or_password' }, 'invalid_credentials'],
    [{ code: 'not_found', category: 'USER_NOT_FOUND' }, 'invalid_credentials'],
    [{ code: 'invalid_password', category: 'INVALID_CREDENTIALS' }, 'invalid_credentials'],
    [{ category: 'PROVIDER_NOT_ENABLED' }, 'auth_unavailable'],
    [{ code: 'user_blocked' }, 'account_unavailable'],
    [{ code: 'resource_exhausted' }, 'rate_limited'],
  ]) {
    const f = fixture(); f.responses.signInWithPassword = { error: { ...sdkError, message: 'private auth details' } };
    await assert.rejects(f.client.signIn('Practice_User', password), error => error.code === expected && !error.message.includes('private'));
  }
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
  assert.deepEqual(await restoring, member);
  await nextTask();
  assert.deepEqual(sessions.at(-1), member);
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

test('signout clears the session and does not use Supabase-specific scope', async () => {
  const f = fixture();
  await f.client.signIn('Practice_User', password);
  await f.client.signOut();
  assert.deepEqual(f.calls.find(call => call.name === 'signOut').args, []);
  assert.equal(await f.client.init(), null);
  await assert.rejects(f.client.dashboard(), error => error.code === 'not_authenticated');
});

test('network operations have a bounded timeout and registration aborts its request', async () => {
  const f = fixture({ dependencies: { timeoutMs: 15 } });
  f.responses.signInWithPassword = () => new Promise(() => {});
  await assert.rejects(f.client.signIn('Practice_User', password), error => error.code === 'timeout');
  f.responses.signInWithPassword = { error: { code: 'unexpected', message: 'private password and token' } };
  await assert.rejects(f.client.signIn('Practice_User', password), error => error.code === 'request_failed' && !error.message.includes('private'));
  let requestSignal;
  f.responses.registration = (_url, options) => { requestSignal = options.signal; return new Promise(() => {}); };
  await assert.rejects(f.client.signUp('Practice_User', password), error => error.code === 'timeout');
  assert.equal(requestSignal.aborted, true);
  assert.equal(f.calls.filter(call => call.name === 'signInWithPassword').length, 2);
});

test('vendored SDK includes pinned version, Apache license and the original CDN bundle checksum', () => {
  const content = fs.readFileSync(path.join(__dirname, '../vendor/cloudbase.min.js'), 'utf8');
  assert.match(content, /@cloudbase\/js-sdk 3\.11\.0/);
  assert.match(content, /Apache License/);
  const checksum = content.match(/Bundle SHA-256: ([a-f0-9]{64})/)[1];
  const bundle = content.slice(content.indexOf('/*! For license information please see cloudbase.full.js.LICENSE.txt */'));
  assert.equal(crypto.createHash('sha256').update(bundle).digest('hex'), checksum);
});
