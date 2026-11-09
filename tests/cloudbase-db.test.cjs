// Runs the real PostgreSQL schema in PGlite; no Supabase project or email service required.
// See docs/CLOUDBASE_SETUP.md for the isolated dependency installation command.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const schema = fs.readFileSync(path.join(__dirname, '../cloudbase/schema.sql'), 'utf8');
const A = 'EchhGXFadSANiCSaVim2wQA';
const B = 'EchhGXFadSANiCSaVim2wQB';
const C = 'EchhGXFadSANiCSaVim2wQC';
const PROJECT = 'fast-junglefowl-d3fqxnq941dd1c4e';
let db;
let today;
let monday;

function offset(day, count) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

async function identity(userId, action, role = 'authenticated') {
  await db.exec(`set role ${role}`);
  try {
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: userId || '', role, project_id: PROJECT, is_anonymous: role === 'anon' })]);
    return await action();
  } finally {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims', '', false)");
  }
}

const call = async (sql, args = []) => (await db.query(sql, args)).rows[0].result;
const dashboard = uid => identity(uid, () => call('select public.community_dashboard() as result'));
const checkIn = (uid, minutes = 20, piece = '', note = '', isPublic = false) => identity(uid, () =>
  call('select public.community_check_in($1::integer, $2::text, $3::text, $4::boolean) as result', [minutes, piece, note, isPublic]));
const profile = (uid, nickname) => identity(uid, () =>
  call('select public.community_update_profile($1::text) as result', [nickname]));
const visibility = (uid, day, isPublic) => identity(uid, () =>
  call('select public.community_set_checkin_public($1::date, $2::boolean) as result', [day, isPublic]));
const rejectsCode = (operation, code, message) => assert.rejects(operation, error => {
  assert.equal(error.code, code);
  if (message) assert.equal(error.message, message);
  return true;
});

async function seedUser(uid, nickname) {
  await db.query('insert into auth.users (sub, email) select $1::varchar, $2::text where not exists (select 1 from auth.users where sub = $1::varchar)', [uid, `${uid}@private.example`]);
  await db.query('insert into public.community_profiles (user_id, nickname) values ((select id from auth.users where sub = $1), $2) on conflict (user_id) do update set nickname = excluded.nickname', [uid, nickname]);
}

async function seedCheckin(uid, day, minutes, isPublic = false, options = {}) {
  await db.query(`insert into public.community_checkins (user_id, day, minutes, piece, note, is_public, created_at)
    values ((select id from auth.users where sub = $1), $2, $3, $4, $5, $6, $7)`, [uid, day, minutes, options.piece || '', options.note || '', isPublic, options.createdAt || `${day}T04:00:00Z`]);
}

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id bigint generated always as identity primary key, sub varchar(64) not null, project varchar(64) not null default 'fast-junglefowl-d3fqxnq941dd1c4e', email text not null, email_verified boolean not null default true);
    create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
    create function auth.uid() returns text language sql stable as $$ select auth.jwt()->>'sub' $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    grant usage on schema auth to anon, authenticated, service_role;
  `);
  await db.exec(schema);
});

beforeEach(async () => {
  await db.exec('reset role; truncate auth.users restart identity cascade; set timezone to UTC; set datestyle to ISO, YMD');
  await db.query("select set_config('request.jwt.claims', '', false)");
  const dates = (await db.query(`select community_private.shanghai_day(statement_timestamp())::text as today,
    (community_private.shanghai_day(statement_timestamp()) - (extract(isodow from community_private.shanghai_day(statement_timestamp()))::integer - 1))::text as monday`)).rows[0];
  today = dates.today;
  monday = dates.monday;
  for (const uid of [A, B, C]) await db.query('insert into auth.users (sub, email) values ($1, $2)', [uid, `${uid}@private.example`]);
});

after(async () => { await db?.close(); });

test('all RPCs require authenticated role and a nonempty auth.uid()', async () => {
  const commands = [
    'select public.community_dashboard()',
    "select public.community_update_profile('琴友甲')",
    "select public.community_check_in(10, '', '', false)",
    `select public.community_set_checkin_public('${today}', false)`
  ];
  for (const sql of commands) {
    await rejectsCode(identity(null, () => db.query(sql)), '42501', '请先登录后再使用练习社区。');
    await rejectsCode(identity(A, () => db.query(sql), 'anon'), '42501');
    await rejectsCode(identity(A, () => db.query(sql), 'service_role'), '42501');
  }
  assert.equal((await db.query('select count(*)::integer as n from public.community_profiles')).rows[0].n, 0);
});

test('new members receive a non-email nickname, empty dashboard and no exposed account identifiers', async () => {
  const data = await dashboard(A);
  assert.deepEqual(data, {
    today, week_start: monday,
    profile: { nickname: '琴友-' + require('node:crypto').createHash('md5').update('1').digest('hex').slice(0, 8) },
    stats: { total_days: 0, total_minutes: 0, current_streak: 0 },
    checkins: [], feed: [], leaderboard: []
  });
  await checkIn(A, 25, '小星星', '慢练', true);
  const shared = await dashboard(B);
  assert.deepEqual(Object.keys(shared.feed[0]).sort(), ['created_at', 'day', 'minutes', 'nickname', 'note', 'piece']);
  assert.deepEqual(Object.keys(shared.leaderboard[0]).sort(), ['days', 'is_self', 'minutes', 'nickname', 'rank']);
  assert.equal(shared.leaderboard[0].is_self, false);
  assert.doesNotMatch(JSON.stringify(shared), /email|user_id|private\.example|EchhGXFadSANiCSaVim2wQA/);
});

test('same-day retries return the first record unchanged, including visibility and timestamp', async () => {
  const first = await checkIn(A, 25, '  小星星  ', '  先慢练\n再连贯  ', false);
  const retry = await checkIn(A, 180, '不同曲子', '不能覆盖', true);
  assert.equal(first.day, today);
  assert.equal(first.piece, '小星星');
  assert.equal(first.note, '先慢练\n再连贯');
  assert.equal(first.created, true);
  assert.ok(Number.isFinite(Date.parse(first.created_at)));
  assert.deepEqual(retry, { ...first, created: false });
  const data = await dashboard(A);
  assert.deepEqual(data.stats, { total_days: 1, total_minutes: 25, current_streak: 1 });
  assert.equal(data.checkins.length, 1);
  assert.equal(data.feed.length, 0);
  assert.equal(data.leaderboard.length, 0);
});

test('Shanghai day is independent of connection timezone and changes at 16:00 UTC', async () => {
  const dates = (await db.query(`select
    community_private.shanghai_day('2026-11-08T15:59:59Z'::timestamptz)::text as before,
    community_private.shanghai_day('2026-11-08T16:00:00Z'::timestamptz)::text as after`)).rows[0];
  assert.deepEqual(dates, { before: '2026-11-08', after: '2026-11-09' });
  await db.exec("set timezone to 'America/Los_Angeles'; set datestyle to 'SQL, DMY'");
  const first = await checkIn(A);
  const data = await dashboard(A);
  assert.equal(first.day, today);
  assert.equal(data.today, today);
  assert.equal(data.week_start, monday);
  await db.exec("set timezone to 'Pacific/Kiritimati'");
  assert.equal((await checkIn(A)).created, false);
  assert.equal((await dashboard(A)).today, today);
});

test('all direct table reads/writes and private helper calls are inaccessible to clients', async () => {
  await checkIn(A, 20, '私人曲目', '私人心得', false);
  await checkIn(B, 40, '公开曲目', '公开心得', true);
  for (const role of ['authenticated', 'anon', 'service_role']) {
    await identity(A, async () => {
      for (const command of [
        'select * from public.community_profiles',
        'select * from public.community_checkins',
        `insert into public.community_checkins (user_id, day, minutes) values (2, '${offset(today, -1)}', 720)`,
        'update public.community_checkins set minutes = 720',
        'delete from public.community_checkins',
        `insert into public.community_profiles (user_id, nickname) values (3, '伪造昵称')`,
        "update public.community_profiles set nickname = '篡改昵称'",
        'delete from public.community_profiles',
        'select community_private.shanghai_day(now())',
        'select community_private.require_verified_user()'
      ]) await rejectsCode(db.query(command), '42501');
    }, role);
  }
  const own = await dashboard(A);
  assert.equal(own.checkins.length, 1);
  assert.equal(own.checkins[0].piece, '私人曲目');
  assert.equal((await dashboard(B)).checkins[0].minutes, 40);
});

test('nickname validation rejects email-like, control, empty and invisible input and trims Unicode whitespace', async () => {
  for (const nickname of [null, '', '单', '字'.repeat(25), '邮件@example.com', '琴\n友', '琴\t友', '琴\u007f友', '琴\u0085友', '　　', '\u200b\u200c', '\u2060\u2060', '\u2800\u2800']) {
    await rejectsCode(profile(A, nickname), '22023', '昵称须为 2–24 个字符，且不能包含邮箱地址或控制字符。');
  }
  assert.deepEqual(await profile(A, '　 新琴友 \n'), { nickname: '新琴友' });
  const unicodeNickname = '🎹'.repeat(24);
  assert.deepEqual(await profile(A, unicodeNickname), { nickname: unicodeNickname });
  assert.equal((await dashboard(A)).profile.nickname, unicodeNickname);
});

test('check-in validation enforces minute bounds, text limits, controls and explicit visibility', async () => {
  for (const minutes of [null, 0, -1, 721]) {
    await rejectsCode(checkIn(A, minutes), '22023', '练习时长须为 1–720 分钟的整数。');
  }
  await rejectsCode(checkIn(A, '1.5'), '22P02');
  for (const piece of [null, '曲'.repeat(101), '小\n星星', '小\u007f星星', '小\u0085星星']) {
    await rejectsCode(checkIn(A, 20, piece), '22023', '曲目名称最多 100 个字符，且不能包含控制字符。');
  }
  for (const note of [null, '练'.repeat(281), '练\u0001琴', '练\u009f琴']) {
    await rejectsCode(checkIn(A, 20, '', note), '22023', '练习心得最多 280 个字符，且不能包含无效控制字符。');
  }
  await rejectsCode(checkIn(A, 20, '', '', null), '22023', '请选择是否公开这次打卡。');
  assert.equal((await dashboard(A)).stats.total_days, 0);
  const record = await checkIn(A, 720, '🎵'.repeat(100), '第一行\n第二行\r\n\t慢练', true);
  assert.equal(record.minutes, 720);
  assert.equal(record.note, '第一行\n第二行\r\n\t慢练');
  assert.equal((await checkIn(B, 1, '', '', false)).minutes, 1);
  assert.equal((await checkIn(C, 1, '', '练'.repeat(280), false)).note.length, 280);
});

test('only owners can change visibility; feed and leaderboard immediately reflect that choice', async () => {
  await profile(A, '琴友甲');
  await profile(B, '琴友乙');
  const privateRecord = await checkIn(A, 15, '个人曲目', '个人记录', false);
  assert.equal((await dashboard(B)).feed.length, 0);
  await rejectsCode(visibility(B, today, true), 'P0002', '没有找到这一天的打卡记录。');
  await rejectsCode(visibility(A, null, true), '22023', '请选择有效的打卡日期。');
  await rejectsCode(visibility(A, 'infinity', true), '22023', '请选择有效的打卡日期。');
  await rejectsCode(visibility(A, today, null), '22023', '请选择是否公开这次打卡。');
  const visible = await visibility(A, today, true);
  const { created, ...original } = privateRecord;
  assert.deepEqual(visible, { ...original, is_public: true });
  const publicData = await dashboard(B);
  assert.equal(publicData.feed[0].nickname, '琴友甲');
  assert.equal(publicData.leaderboard[0].minutes, 15);
  await profile(A, '新的昵称');
  assert.equal((await dashboard(B)).feed[0].nickname, '新的昵称');
  await visibility(A, today, false);
  const hiddenData = await dashboard(B);
  assert.deepEqual(hiddenData.feed, []);
  assert.deepEqual(hiddenData.leaderboard, []);
  assert.equal((await dashboard(A)).stats.total_minutes, 15);
});

test('streaks allow yesterday as the anchor, stop at gaps and count private records', async () => {
  await seedUser(A, '琴友甲');
  await seedUser(B, '琴友乙');
  await seedUser(C, '琴友丙');
  for (const daysAgo of [0, 1, 2, 4, 90]) await seedCheckin(A, offset(today, -daysAgo), 10, false);
  for (const daysAgo of [1, 2, 3, 5]) await seedCheckin(B, offset(today, -daysAgo), 20, false);
  for (const daysAgo of [2, 3]) await seedCheckin(C, offset(today, -daysAgo), 30, false);
  const a = await dashboard(A);
  assert.deepEqual(a.stats, { total_days: 5, total_minutes: 50, current_streak: 3 });
  assert.equal(a.checkins.length, 4);
  assert.deepEqual(a.checkins.map(row => row.day), [0, 1, 2, 4].map(n => offset(today, -n)));
  assert.equal((await dashboard(B)).stats.current_streak, 3);
  assert.equal((await dashboard(C)).stats.current_streak, 0);
  assert.equal(a.feed.length, 0);
});

test('own history includes the last 90 calendar days while lifetime totals retain older records', async () => {
  await seedUser(A, '琴友甲');
  for (let n = 0; n < 95; n++) await seedCheckin(A, offset(today, -n), 2, false);
  const data = await dashboard(A);
  assert.deepEqual(data.stats, { total_days: 95, total_minutes: 190, current_streak: 95 });
  assert.equal(data.checkins.length, 90);
  assert.equal(data.checkins[89].day, offset(today, -89));
});

test('weekly ranking includes Monday through Sunday, uses public days then minutes and identifies self', async () => {
  await seedUser(A, '琴友甲');
  await seedUser(B, '琴友乙');
  await seedUser(C, '琴友丙');
  await seedCheckin(A, monday, 10, true);
  await seedCheckin(A, offset(monday, 6), 20, true);
  await seedCheckin(A, offset(monday, -1), 720, true);
  await seedCheckin(A, offset(monday, 7), 720, true);
  await seedCheckin(B, monday, 60, true);
  await seedCheckin(B, offset(monday, 1), 60, true);
  await seedCheckin(B, offset(monday, 2), 720, false);
  await seedCheckin(C, monday, 720, true);
  const data = await dashboard(A);
  assert.deepEqual(data.leaderboard, [
    { rank: 1, nickname: '琴友乙', days: 2, minutes: 120, is_self: false },
    { rank: 2, nickname: '琴友甲', days: 2, minutes: 30, is_self: true },
    { rank: 3, nickname: '琴友丙', days: 1, minutes: 720, is_self: false }
  ]);
});

test('shared data caps feed at 30 latest entries and ranking at 20 deterministic members', async () => {
  for (let n = 1; n <= 35; n++) {
    const uid = `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    await seedUser(uid, `琴友${String(n).padStart(2, '0')}`);
    await seedCheckin(uid, today, 10, true, { createdAt: `${today}T04:${String(n).padStart(2, '0')}:00Z` });
  }
  await seedUser(A, '隐藏琴友');
  await seedCheckin(A, today, 720, false, { createdAt: `${today}T05:00:00Z` });
  const data = await dashboard(B);
  assert.equal(data.feed.length, 30);
  assert.equal(data.leaderboard.length, 20);
  assert.equal(data.feed[0].nickname, '琴友35');
  assert.equal(data.feed[29].nickname, '琴友06');
  assert.equal(data.leaderboard[0].nickname, '琴友01');
  assert.equal(data.leaderboard[19].nickname, '琴友20');
  assert.ok(data.feed.every((row, index, rows) => index === 0 || Date.parse(rows[index - 1].created_at) >= Date.parse(row.created_at)));
  assert.doesNotMatch(JSON.stringify(data), /隐藏琴友|user_id|email|private\.example/);
});

test('schema can be reapplied without losing records and account deletion cascades', async () => {
  await profile(A, '保留昵称');
  await checkIn(A, 30, '保留曲目', '', true);
  const original = await dashboard(A);
  await db.exec(schema);
  assert.deepEqual(await dashboard(A), original);
  await db.query('delete from auth.users where sub = $1', [A]);
  assert.equal((await db.query('select count(*)::integer as n from public.community_profiles')).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::integer as n from public.community_checkins')).rows[0].n, 0);
  assert.deepEqual((await dashboard(B)).feed, []);
});

test('all exposed functions fix search_path and are security definer; tables retain RLS', async () => {
  const functions = (await db.query(`select p.proname, p.prosecdef, p.proconfig from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    and p.proname in ('community_dashboard', 'community_update_profile', 'community_check_in', 'community_set_checkin_public')`)).rows;
  assert.equal(functions.length, 4);
  for (const row of functions) {
    assert.equal(row.prosecdef, true, row.proname);
    assert.ok(row.proconfig.some(value => value === 'search_path=""'), row.proname);
  }
  const tables = (await db.query("select relname, relrowsecurity from pg_class where oid in ('public.community_profiles'::regclass, 'public.community_checkins'::regclass)")).rows;
  assert.equal(tables.length, 2);
  assert.ok(tables.every(row => row.relrowsecurity));
});

// CloudBase may route RPC regardless of EXECUTE grants. These calls intentionally
// use the database owner to bypass ACL and verify each function's own JWT checks.
test('every definer RPC rejects invalid claims even when the gateway bypasses EXECUTE ACL', async () => {
  const commands = [
    'select public.community_dashboard()',
    "select public.community_update_profile('琴友甲')",
    "select public.community_check_in(10, '', '', false)",
    `select public.community_set_checkin_public('${today}', false)`
  ];
  for (const claims of [{}, { sub: A }, { sub: A, role: 'anon' }, { sub: A, role: 'service_role' },
    { sub: A, role: 'authenticated', is_anonymous: true }, { sub: '', role: 'authenticated' },
    { sub: A, role: 'authenticated', project_id: 'other-environment' }, { sub: A, role: 'authenticated', project_id: null }]) {
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ project_id: PROJECT, ...claims })]);
    for (const command of commands) await rejectsCode(db.query(command), '42501');
  }
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: A, role: 'authenticated', project_id: PROJECT, is_anonymous: false })]);
  assert.equal((await call('select public.community_dashboard() as result')).stats.total_days, 0);
});

test('server-side email verification uses Auth system columns and fails closed for unknown users', async () => {
  await db.query('update auth.users set email_verified = false where sub = $1', [A]);
  await rejectsCode(dashboard(A), '42501', '请先通过邮箱验证码完成登录。');
  await rejectsCode(profile(A, '未验证昵称'), '42501');
  await rejectsCode(checkIn(A), '42501');
  await rejectsCode(visibility(A, today, true), '42501');
  await rejectsCode(dashboard('missing-user'), '42501');
  await db.query('update auth.users set email_verified = true where sub = $1', [A]);
  assert.equal((await checkIn(A)).created, true);
  await db.query('update auth.users set email_verified = false where sub = $1', [A]);
  await rejectsCode(dashboard(A), '42501', '请先通过邮箱验证码完成登录。');
});

test('Auth lookup scopes duplicate subjects to the target project and rejects ambiguous accounts', async () => {
  await db.query('insert into auth.users (sub, project, email, email_verified) values ($1, $2, $3, true)', [A, 'another-project', 'other@private.example']);
  assert.equal((await checkIn(A)).created, true);
  const record = (await db.query('select user_id from public.community_checkins')).rows[0];
  assert.equal(Number(record.user_id), 1, 'the record belongs to this project’s internal Auth id');
  await db.query('insert into auth.users (sub, project, email, email_verified) values ($1, $2, $3, false)', [A, PROJECT, 'duplicate@private.example']);
  await rejectsCode(dashboard(A), '42501', '请先通过邮箱验证码完成登录。');
});

test('a valid authenticated JWT without optional project_id still resolves only this environment', async () => {
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: A, role: 'authenticated', is_anonymous: false })]);
  assert.equal((await call('select public.community_dashboard() as result')).stats.total_days, 0);
  await db.query('update auth.users set project = $1 where sub = $2', ['another-environment', A]);
  await rejectsCode(call('select public.community_dashboard() as result'), '42501', '请先通过邮箱验证码完成登录。');
});
