'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { createRegistrationServer, ENV_ID, ALLOWED_ORIGIN } = require('../cloudbase/functions/register/server.cjs');
const { createCloudBaseServices } = require('../cloudbase/functions/register/index.js');

const account = { username: 'Practice_User', password: 'Practice123!' };

async function fixture(t, overrides = {}) {
  const calls = [];
  const server = createRegistrationServer({
    async consumeSlot(hash) { calls.push(['limit', hash]); return true; },
    async reserveName(username) { calls.push(['reserve', username]); return true; },
    async createUser(input) { calls.push(['create', input]); return { Data: { Uid: 'private-created-id' } }; },
    ...overrides
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  function request({ method = 'POST', path = '/community-register', body = account, rawBody, headers = {}, chunks } = {}) {
    return new Promise((resolve, reject) => {
      const finalHeaders = { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json', ...headers };
      for (const key of Object.keys(finalHeaders)) if (finalHeaders[key] === null) delete finalHeaders[key];
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path, headers: finalHeaders, agent: false }, res => {
        const data = [];
        res.on('data', chunk => data.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(data).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : null });
        });
      });
      req.on('error', reject);
      if (chunks) for (const chunk of chunks) req.write(chunk);
      else if (method === 'POST') req.write(rawBody === undefined ? JSON.stringify(body) : rawBody);
      req.end();
    });
  }
  return { calls, request };
}

test('real HTTP registration consumes a slot before creating only an active external user and returns no identity', async t => {
  const f = await fixture(t);
  const res = await f.request({ headers: { 'X-Forwarded-For': '198.51.100.9, 203.0.113.17', 'X-Real-IP': '192.0.2.1' } });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(res.headers['access-control-allow-origin'], ALLOWED_ORIGIN);
  assert.equal(res.headers['access-control-allow-credentials'], undefined);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers.vary, 'Origin');
  assert.deepEqual(f.calls, [
    ['limit', createHash('sha256').update(`${ENV_ID}:203.0.113.17`).digest('hex')],
    ['reserve', account.username],
    ['create', { name: account.username, password: account.password, type: 'externalUser', userStatus: 'ACTIVE' }]
  ]);
  for (const privateValue of [account.username, account.password, 'private-created-id', '203.0.113.17']) assert.equal(res.text.includes(privateValue), false);
});

test('IP buckets use only the gateway-appended last valid address and otherwise fall back to the socket', async t => {
  const f = await fixture(t);
  await f.request({ headers: { 'X-Forwarded-For': '198.51.100.1, 203.0.113.20' } });
  await f.request({ headers: { 'X-Forwarded-For': '198.51.100.2, 203.0.113.20', 'X-Real-IP': '198.51.100.3' } });
  await f.request({ headers: { 'X-Forwarded-For': '198.51.100.4, invalid', 'X-Real-IP': '198.51.100.5' } });
  await f.request();
  const buckets = f.calls.filter(([name]) => name === 'limit').map(([, hash]) => hash);
  assert.equal(buckets[0], buckets[1]);
  assert.equal(buckets[2], buckets[3]);
  assert.notEqual(buckets[0], buckets[2]);
  for (const hash of buckets) assert.match(hash, /^[a-f0-9]{64}$/);
});

test('CORS allows only the fixed trial origin and POST JSON preflight, never arbitrary requested headers', async t => {
  const f = await fixture(t);
  const preflight = await f.request({ method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.text, '');
  assert.equal(preflight.headers['access-control-allow-origin'], ALLOWED_ORIGIN);
  assert.equal(preflight.headers['access-control-allow-methods'], 'POST');
  assert.equal(preflight.headers['access-control-allow-headers'], 'Content-Type');
  for (const origin of [null, 'null', 'https://untrusted.example', ALLOWED_ORIGIN + '.evil.example', 'https://line-ar-line.github.io']) {
    const denied = await f.request({ headers: { Origin: origin } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  }
  for (const headers of [
    { 'Access-Control-Request-Method': 'DELETE' },
    { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, authorization' }
  ]) assert.equal((await f.request({ method: 'OPTIONS', headers })).status, 403);
  assert.equal(f.calls.length, 0);
});

test('health is minimal and routing and methods reject before calling backend services', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/community-register']) {
    const health = await f.request({ method: 'GET', path, headers: { Origin: null } });
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true });
  }
  for (const path of ['/health', '/anything', '/community-register/nested']) assert.equal((await f.request({ method: 'GET', path })).status, 404);
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal((await f.request({ method })).status, 405);
  assert.equal(f.calls.length, 0);
});

test('gateway CORS mode omits every Access-Control header while retaining origin, preflight and input validation', async t => {
  const f = await fixture(t, { gatewayCors: true });
  const success = await f.request();
  assert.equal(success.status, 201);
  const preflight = await f.request({ method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  const denied = await f.request({ headers: { Origin: 'https://untrusted.example' } });
  assert.equal(denied.status, 403);
  const invalid = await f.request({ body: { ...account, uid: 'chosen-by-client' } });
  assert.equal(invalid.status, 400);
  const invalidPreflight = await f.request({ method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(invalidPreflight.status, 403);
  for (const response of [success, preflight, denied, invalid, invalidPreflight]) {
    assert.deepEqual(Object.keys(response.headers).filter(name => name.startsWith('access-control-')), []);
    assert.equal(response.headers.vary, 'Origin');
  }
  assert.equal(f.calls.filter(([name]) => name === 'create').length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'limit').length, 1);
});

test('only two exact credential fields are accepted; callers cannot choose UID, account type, role or email', async t => {
  const f = await fixture(t);
  for (const body of [null, [], 'value', {}, { username: account.username }, { password: account.password },
    ...['uid', 'email', 'type', 'userStatus', 'role', '__proto__'].map(key => ({ ...account, [key]: 'admin' }))]) {
    const res = await f.request({ body });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: { code: 'registration_unavailable' } });
  }
  assert.equal(f.calls.length, 0);
});

test('username and password limits match client rules and malformed values never consume a registration slot', async t => {
  const f = await fixture(t);
  for (const username of ['', 'ab', '1user', 'User_', '_User', 'user.name', 'with space', '中文账号', 'A'.repeat(33), 123]) {
    const res = await f.request({ body: { ...account, username } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: { code: 'invalid_username' } });
  }
  for (const password of ['', 'Ab1!', '!Abc1234', 'Abc1234 ', 'Abc1234.', 'Abc1234汉', 'abcd123\\', 'lowercaseonly', 'A1'.repeat(17), 123]) {
    const res = await f.request({ body: { ...account, password } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: { code: 'weak_password' } });
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request({ body: { username: 'Ab3', password: 'Ab123456' } })).status, 201);
  assert.equal((await f.request({ body: { username: 'A'.repeat(32), password: 'Ab1' + 'x'.repeat(29) } })).status, 201);
});

test('JSON content type, encoding, syntax and streamed 2 KiB size limits are enforced before any service call', async t => {
  const f = await fixture(t);
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Type': null }, { 'Content-Encoding': 'gzip' }]) assert.equal((await f.request({ headers })).status, 415);
  for (const rawBody of ['', '{broken', Buffer.from([0xff, 0xff])]) assert.equal((await f.request({ rawBody })).status, 400);
  assert.equal((await f.request({ chunks: ['{"username":"', 'x'.repeat(2048), '"}'] })).status, 413);
  assert.equal((await f.request({ headers: { 'Content-Length': '3000' }, rawBody: 'x'.repeat(3000) })).status, 413);
  assert.equal(f.calls.length, 0);
});

test('limit refusal or unavailable limit storage never creates an account and errors do not expose credentials', async t => {
  let created = 0;
  for (const limit of [false, null, 'true']) {
    const f = await fixture(t, { consumeSlot: async () => limit, createUser: async () => { created++; } });
    const res = await f.request();
    assert.equal(res.status, 429);
    assert.deepEqual(res.body, { error: { code: 'rate_limited' } });
  }
  const broken = await fixture(t, { consumeSlot: async () => { throw Object.assign(new Error(account.password), { publicCode: account.password, status: 400 }); }, createUser: async () => { created++; } });
  const res = await broken.request();
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { error: { code: 'registration_unavailable' } });
  assert.equal(res.text.includes(account.password), false);
  assert.equal(created, 0);
});

test('failed or malformed create responses stay private and consumed slots are not refunded', async t => {
  for (const createUser of [async () => { throw new Error(`${account.username} ${account.password}`); }, async () => ({}), async () => ({ Data: { Uid: '' } })]) {
    const f = await fixture(t, { createUser });
    const res = await f.request();
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: { code: 'registration_unavailable' } });
    assert.equal(f.calls.filter(([name]) => name === 'limit').length, 1);
    assert.equal(f.calls.filter(([name]) => name === 'reserve').length, 1);
    assert.equal(res.headers['access-control-allow-origin'], ALLOWED_ORIGIN);
  }
});

test('taken or concurrently reserved names return username_taken before createUser is called', async t => {
  let creates = 0;
  const taken = await fixture(t, { reserveName: async () => false, createUser: async () => { creates++; } });
  const duplicate = await taken.request();
  assert.equal(duplicate.status, 409);
  assert.deepEqual(duplicate.body, { error: { code: 'username_taken' } });
  assert.equal(creates, 0);
  const reserved = new Set();
  const concurrent = await fixture(t, {
    reserveName: async username => {
      if (reserved.has(username)) return false;
      reserved.add(username);
      return true;
    },
    createUser: async () => { creates++; return { Data: { Uid: 'one-account' } }; }
  });
  const responses = await Promise.all([concurrent.request(), concurrent.request()]);
  assert.deepEqual(responses.map(value => value.status).sort(), [201, 409]);
  assert.equal(creates, 1);
  assert.equal(concurrent.calls.filter(([name]) => name === 'limit').length, 2);
});

test('unavailable name reservation fails closed and a create failure never releases or retries the reservation', async t => {
  let created = 0;
  const broken = await fixture(t, { reserveName: async () => { throw Error(account.password); }, createUser: async () => { created++; } });
  const failure = await broken.request();
  assert.equal(failure.status, 503);
  assert.deepEqual(failure.body, { error: { code: 'registration_unavailable' } });
  assert.equal(created, 0);
  let reserved = false;
  const timeout = await fixture(t, {
    reserveName: async () => { if (reserved) return false; reserved = true; return true; },
    createUser: async () => { created++; throw Error('upstream timeout'); }
  });
  assert.equal((await timeout.request()).status, 503);
  assert.equal((await timeout.request()).status, 409);
  assert.equal(created, 1);
});

test('CloudBase bridge uses managed credentials, fixed environment, validated SQL hash and exact boolean result', async () => {
  let initOptions;
  const calls = [];
  let result = { Rows: ['[true]'], Columns: ['allowed'] };
  const services = createCloudBaseServices({ init(options) {
    initOptions = options;
    return {
      commonService: () => ({ call: async input => { calls.push(input); return result; } }),
      user: { createUser: async input => ({ Data: { Uid: input.name } }) }
    };
  } });
  assert.deepEqual(initOptions, { envId: ENV_ID, region: 'ap-shanghai', timeout: 7000 });
  const hash = 'a'.repeat(64);
  assert.equal(await services.consumeSlot(hash), true);
  assert.deepEqual(calls, [{ Action: 'ExecutePGSql', Param: { EnvId: ENV_ID, Sql: `select community_private.consume_registration_slot('${hash}') as allowed;` } }]);
  for (const value of ['', "x'); drop table users;--", 'g'.repeat(64), 'a'.repeat(63)]) await assert.rejects(services.consumeSlot(value));
  assert.equal(calls.length, 1);
  result = { Rows: ['[false]'] };
  assert.equal(await services.consumeSlot(hash), false);
  result = { Rows: ['["true"]'], ColumnTypes: ['bool'] };
  assert.equal(await services.consumeSlot(hash), true);
  result = { Rows: ['["false"]'], ColumnTypes: ['bool'] };
  assert.equal(await services.consumeSlot(hash), false);
  for (const invalid of [{}, { Rows: [] }, { Rows: ['[true]', '[true]'] }, { Rows: [[true]] }, { Rows: ['{"allowed":true}'] }, { Rows: ['["t"]'] }, { Rows: ['[1]'] }, { Rows: ['[true,false]'] }, { Rows: ['broken'] }]) {
    result = invalid;
    await assert.rejects(services.consumeSlot(hash));
  }
  result = { Rows: ['["true"]'] };
  assert.equal(await services.reserveName(account.username), true);
  assert.deepEqual(calls.at(-1), { Action: 'ExecutePGSql', Param: { EnvId: ENV_ID, Sql: `select community_private.reserve_registration_name('${account.username}') as allowed;` } });
  const before = calls.length;
  for (const username of ["a');drop table users;--", 'a\\b', 'bad user', 'ab', 'Name@x']) await assert.rejects(services.reserveName(username));
  assert.equal(calls.length, before);
  result = { Rows: ['["false"]'] };
  assert.equal(await services.reserveName(account.username), false);
});
