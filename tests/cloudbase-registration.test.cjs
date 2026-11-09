const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

const schema = fs.readFileSync(path.join(__dirname, '../cloudbase/registration.sql'), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const IP_A = hash('local-test-address-a');
const IP_B = hash('local-test-address-b');
let db;

async function at(timestamp) {
  const stamp = new Date(timestamp).toISOString();
  // Only the local test database owner replaces this private clock helper.
  // The production helper always returns the server's clock_timestamp().
  await db.exec(`create or replace function community_private.registration_clock()
    returns timestamptz language sql volatile set search_path = '' as $$ select '${stamp}'::timestamptz $$;`);
}
const consume = async ip => (await db.query('select community_private.consume_registration_slot($1::text) as allowed', [ip])).rows[0].allowed;
const reserve = async username => (await db.query('select community_private.reserve_registration_name($1::text) as allowed', [username])).rows[0].allowed;
const buckets = async () => (await db.query('select scope, subject_hash, attempts from community_private.registration_buckets order by scope, subject_hash')).rows;
const denied = operation => assert.rejects(operation, error => error.code === '42501');

before(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users (
      id bigint generated always as identity primary key,
      project text not null default 'fast-junglefowl-d3fqxnq941dd1c4e',
      username text, status smallint, type text
    );`);
  await db.exec(schema);
});
beforeEach(async () => {
  await db.exec('reset role; truncate community_private.registration_buckets, community_private.registration_names, auth.users; set timezone to UTC');
  await at('2026-11-09T04:00:00Z');
});
after(async () => { await db?.close(); });

test('each accepted attempt consumes all three quotas; only five per IP per minute are allowed', async () => {
  for (let n = 0; n < 5; n++) assert.equal(await consume(IP_A), true);
  assert.equal(await consume(IP_A), false);
  assert.deepEqual(await buckets(), [
    { scope: 'global_day', subject_hash: 'global', attempts: 5 },
    { scope: 'ip_hour', subject_hash: IP_A, attempts: 5 },
    { scope: 'ip_minute', subject_hash: IP_A, attempts: 5 }
  ]);
  assert.equal(await consume(IP_B), true);
  const global = (await buckets()).find(row => row.scope === 'global_day');
  assert.equal(global.attempts, 6, 'a rate-limited request does not consume somebody else’s remaining quota');
});

test('registration provider failures are not refunded and queued attempts cannot exceed a minute quota', async () => {
  // Reservations commit before the caller contacts createUser. The provider can
  // fail or return a duplicate username; no release API exists to undo a reservation.
  const results = await Promise.all(Array.from({ length: 30 }, () => consume(IP_A)));
  assert.equal(results.filter(Boolean).length, 5);
  assert.equal(results.filter(value => !value).length, 25);
  assert.ok((await buckets()).every(row => row.attempts === 5));
});

test('hourly limits persist across minute boundaries and reset in the next hour', async () => {
  for (let minute = 0; minute < 4; minute++) {
    await at(`2026-11-09T04:0${minute}:00Z`);
    for (let n = 0; n < 5; n++) assert.equal(await consume(IP_A), true);
  }
  await at('2026-11-09T04:04:00Z');
  assert.equal(await consume(IP_A), false);
  assert.equal((await buckets()).find(row => row.scope === 'ip_hour').attempts, 20);
  assert.equal((await buckets()).filter(row => row.scope === 'ip_minute').length, 0, 'expired minute bucket is removed even on a rejected attempt');
  await at('2026-11-09T05:00:00Z');
  assert.equal(await consume(IP_A), true);
  const rows = await buckets();
  assert.equal(rows.find(row => row.scope === 'ip_hour').attempts, 1);
  assert.equal(rows.find(row => row.scope === 'global_day').attempts, 21);
});

test('global limit covers different IPs and resets exactly at Shanghai midnight', async () => {
  await at('2026-11-09T15:59:00Z');
  for (let n = 0; n < 100; n++) assert.equal(await consume(hash(`test-ip-${n}`)), true);
  assert.equal(await consume(hash('new-ip-at-limit')), false);
  assert.equal((await buckets()).length, 201, 'rejected requests do not allocate arbitrary new IP buckets');
  await at('2026-11-09T15:59:59.999Z');
  assert.equal(await consume(IP_A), false);
  await at('2026-11-09T16:00:00Z');
  assert.equal(await consume(IP_A), true);
  assert.deepEqual((await buckets()).map(row => row.attempts), [1, 1, 1]);
  const day = (await db.query("select to_char(bucket_start at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as day from community_private.registration_buckets where scope = 'global_day'")).rows[0].day;
  assert.equal(day, '2026-11-10 00:00:00');
});

test('all expired buckets are cleaned lazily without deleting unexpired quotas', async () => {
  await consume(IP_A);
  await at('2026-11-09T04:01:00Z');
  assert.equal(await consume(IP_B), true);
  let rows = await buckets();
  assert.equal(rows.filter(row => row.scope === 'ip_minute').length, 1);
  assert.equal(rows.filter(row => row.scope === 'ip_hour').length, 2);
  assert.equal(rows.find(row => row.scope === 'global_day').attempts, 2);
  await at('2026-11-11T04:00:00Z');
  await consume(IP_B);
  rows = await buckets();
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.attempts === 1));
  assert.equal((await db.query('select count(*)::integer as n from community_private.registration_buckets where expires_at <= community_private.registration_clock()')).rows[0].n, 0);
});

test('UTC minute/hour and Shanghai-day boundaries do not depend on session timezone', async () => {
  await at('2026-11-09T15:59:00Z');
  await db.exec("set timezone to 'America/Los_Angeles'");
  await consume(IP_A);
  const initial = (await db.query('select scope, extract(epoch from bucket_start)::bigint as start from community_private.registration_buckets order by scope')).rows;
  await db.exec("set timezone to 'Pacific/Kiritimati'");
  await consume(IP_A);
  const after = (await db.query('select scope, extract(epoch from bucket_start)::bigint as start from community_private.registration_buckets order by scope')).rows;
  assert.deepEqual(after, initial);
  assert.ok((await buckets()).every(row => row.attempts === 2));
});

test('invalid hashes and SQL-looking input are rejected before modifying any quota', async () => {
  for (const value of [null, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), '127.0.0.1', "x');drop table auth.users;--", `${IP_A}\n`]) {
    await assert.rejects(consume(value), error => error.code === '22023');
  }
  assert.deepEqual(await buckets(), []);
  assert.equal(await consume('0'.repeat(64)), true);
});

test('anon, authenticated and service_role cannot call the private functions or access their table', async () => {
  await consume(IP_A);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await db.exec(`set role ${role}`);
    try {
      await denied(consume(IP_A));
      await denied(reserve('ValidName'));
      await denied(db.query('select community_private.registration_clock()'));
      await denied(db.query('select * from community_private.registration_buckets'));
      await denied(db.query('update community_private.registration_buckets set attempts = 1'));
      await denied(db.query('delete from community_private.registration_buckets'));
      await denied(db.query('truncate community_private.registration_buckets'));
      await denied(db.query('select * from community_private.registration_names'));
      await denied(db.query("insert into community_private.registration_names values ('validname', now() + interval '10 minutes')"));
      await denied(db.query("update community_private.registration_names set expires_at = now()"));
      await denied(db.query('delete from community_private.registration_names'));
    } finally { await db.exec('reset role'); }
  }
  assert.ok((await buckets()).every(row => row.attempts === 1));
});

test('the reservation holds exactly one transaction advisory lock and releases it at transaction end', async () => {
  await db.exec('begin');
  try {
    assert.equal(await consume(IP_A), true);
    assert.equal(await reserve('SharedLockName'), true);
    const locks = (await db.query("select mode, granted from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()")).rows;
    assert.deepEqual(locks, [{ mode: 'ExclusiveLock', granted: true }]);
  } finally { await db.exec('commit'); }
  assert.equal((await db.query("select count(*)::integer as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()")).rows[0].n, 0);
});

test('schema reapplies without resetting counters and stores only hashes, windows and counts', async () => {
  await consume(IP_A);
  await reserve('RetainedName');
  const before = await buckets();
  const namesBefore = (await db.query('select username, expires_at from community_private.registration_names')).rows;
  await db.exec(schema);
  assert.deepEqual(await buckets(), before);
  assert.deepEqual((await db.query('select username, expires_at from community_private.registration_names')).rows, namesBefore);
  await at('2026-11-09T04:00:00Z');
  await consume(IP_A);
  assert.ok((await buckets()).every(row => row.attempts === 2));
  const columns = (await db.query("select column_name from information_schema.columns where table_schema = 'community_private' and table_name = 'registration_buckets' order by ordinal_position")).rows.map(row => row.column_name);
  assert.deepEqual(columns, ['scope', 'subject_hash', 'bucket_start', 'expires_at', 'attempts']);
  const fn = (await db.query("select prosecdef, proconfig from pg_proc where oid = 'community_private.consume_registration_slot(text)'::regprocedure")).rows[0];
  assert.equal(fn.prosecdef, false, 'the admin-only function cannot elevate a client’s permissions');
  assert.ok(fn.proconfig.includes('search_path=""'));
  const nameColumns = (await db.query("select column_name from information_schema.columns where table_schema = 'community_private' and table_name = 'registration_names' order by ordinal_position")).rows.map(row => row.column_name);
  assert.deepEqual(nameColumns, ['username', 'expires_at']);
});

test('existing usernames are case-insensitively reserved even for disabled accounts', async () => {
  await db.exec("insert into auth.users (username, status, type) values ('ExistingUser', 1, 'external'), ('DisabledUser', 3, 'external')");
  const before = (await db.query('select * from auth.users order by id')).rows;
  for (const name of ['ExistingUser', 'existinguser', 'EXISTINGUSER', 'DisabledUser', 'disableduser']) assert.equal(await reserve(name), false);
  assert.equal((await db.query('select count(*)::integer as n from community_private.registration_names')).rows[0].n, 0);
  assert.deepEqual((await db.query('select * from auth.users order by id')).rows, before);
});

test('concurrent-style duplicate name reservations allow exactly one attempt across letter case', async () => {
  const results = await Promise.all(['NewUser', 'newuser', 'NEWUSER', 'nEwUsEr'].map(reserve));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter(value => !value).length, 3);
  const row = (await db.query("select username, to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as expiry from community_private.registration_names")).rows[0];
  assert.deepEqual(row, { username: 'newuser', expiry: '2026-11-09 04:10:00' });
  assert.equal(await reserve('different-user'), true);
});

test('failed registrations keep the ten-minute reservation and can retry after expiry', async () => {
  assert.equal(await reserve('RetryUser'), true);
  await at('2026-11-09T04:09:59.999Z');
  assert.equal(await reserve('retryuser'), false);
  await at('2026-11-09T04:10:00Z');
  assert.equal(await reserve('RETRYUSER'), true);
  const expiry = (await db.query("select to_char(expires_at at time zone 'UTC', 'HH24:MI:SS') as expiry from community_private.registration_names where username = 'retryuser'")).rows[0].expiry;
  assert.equal(expiry, '04:20:00');
});

test('a real account created after a timeout remains protected when the reservation expires', async () => {
  assert.equal(await reserve('SlowProvider'), true);
  await db.exec("insert into auth.users (username, status, type) values ('SlowProvider', 1, 'external')");
  await at('2026-11-09T04:10:00Z');
  assert.equal(await reserve('slowprovider'), false);
  assert.equal(await reserve('freshname'), true, 'a new name also cleans stale reservations');
  assert.deepEqual((await db.query('select username from community_private.registration_names order by username')).rows, [{ username: 'freshname' }]);
  assert.equal((await db.query('select count(*)::integer as n from auth.users')).rows[0].n, 1);
});

test('username existence checks are scoped to the fixed CloudBase project', async () => {
  await db.exec("insert into auth.users (project, username, status, type) values ('another-environment', 'SharedName', 1, 'external')");
  assert.equal(await reserve('sharedname'), true);
});

test('username reservations reject blanks, controls and unsupported characters before writing', async () => {
  for (const name of [null, '', 'ab', 'a'.repeat(33), '1name', '_name', 'name_', 'name-', 'name.dot', '中文名称', 'name space', ' name', 'name ', 'name\n', 'na\tme', 'na\u0001me', "abc');drop table auth.users;--"]) {
    await assert.rejects(reserve(name), error => error.code === '22023');
  }
  assert.equal((await db.query('select count(*)::integer as n from community_private.registration_names')).rows[0].n, 0);
  for (const name of ['a_b', 'a-b', 'Ab1', `A${'x'.repeat(30)}9`]) assert.equal(await reserve(name), true);
});
