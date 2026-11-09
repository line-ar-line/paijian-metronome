-- 拍间练习社区：CloudBase PostgreSQL 模式。使用管理员 SQL 执行入口应用。
-- 此环境 auth.uid() 是登录 sub（text）；auth.users.id 是内部 bigint。
-- 可重复执行；不会删除现有账号、昵称或打卡记录。
do $community_migration$
begin

create schema if not exists community_private;
revoke all on schema community_private from public, anon, authenticated, service_role;

create or replace function community_private.shanghai_day(p_timestamp timestamptz)
returns date language sql immutable strict set search_path = ''
as $$ select (p_timestamp at time zone 'Asia/Shanghai')::date $$;

create or replace function community_private.trim_text(p_text text)
returns text language sql immutable strict set search_path = ''
as $$
  select btrim(p_text, E' \t\r\n\v\f' || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$$;

create or replace function community_private.valid_nickname(p_text text)
returns boolean language sql immutable strict set search_path = ''
as $$
  select char_length(p_text) between 2 and 24
    and p_text !~ U&'[@\0001-\001F\007F-\009F]'
    and regexp_replace(p_text,
      U&'[[:space:]\00A0\00AD\034F\061C\115F\1160\1680\17B4\17B5\180B-\180F\2000-\200F\2028-\202F\205F\2060-\206F\2800\3000\3164\FE00-\FE0F\FEFF\FFA0]', '', 'g') <> ''
$$;

create or replace function community_private.valid_piece(p_text text)
returns boolean language sql immutable strict set search_path = ''
as $$ select char_length(p_text) <= 100 and p_text !~ U&'[\0001-\001F\007F-\009F]' $$;

create or replace function community_private.valid_note(p_text text)
returns boolean language sql immutable strict set search_path = ''
as $$
  select char_length(p_text) <= 280
    and translate(p_text, E'\r\n\t', '') !~ U&'[\0001-\001F\007F-\009F]'
$$;

create table if not exists public.community_profiles (
  user_id bigint primary key references auth.users(id) on delete cascade,
  nickname text not null check (community_private.valid_nickname(nickname)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.community_checkins (
  user_id bigint not null references public.community_profiles(user_id) on delete cascade,
  day date not null,
  minutes integer not null check (minutes between 1 and 720),
  piece text not null default '' check (community_private.valid_piece(piece)),
  note text not null default '' check (community_private.valid_note(note)),
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);

create index if not exists community_checkins_public_feed_idx
  on public.community_checkins (created_at desc, user_id) where is_public;
create index if not exists community_checkins_public_week_idx
  on public.community_checkins (day, user_id) include (minutes) where is_public;

alter table public.community_profiles enable row level security;
alter table public.community_checkins enable row level security;

-- No client table access. Every result is filtered and projected inside an authenticated RPC.
-- Policies retained from an older installation are harmless while all table grants are revoked.
revoke all on table public.community_profiles, public.community_checkins
  from public, anon, authenticated, service_role;

create or replace function community_private.require_verified_user()
returns bigint language plpgsql security invoker set search_path = ''
as $$
declare
  v_sub text := auth.uid();
  v_project constant text := 'fast-junglefowl-d3fqxnq941dd1c4e';
  v_user_id bigint;
  v_matches bigint;
  v_verified boolean;
begin
  -- CloudBase's gateway may expose RPC endpoints regardless of EXECUTE grants.
  -- Authorize from trusted JWT claims and Auth's own columns inside every definer RPC.
  if auth.role() is distinct from 'authenticated'
     or v_sub is null or btrim(v_sub) = ''
     or (auth.jwt() ? 'project_id' and (auth.jwt() ->> 'project_id') is distinct from v_project)
     or coalesce(auth.jwt() ->> 'is_anonymous', 'false') <> 'false' then
    raise exception using errcode = '42501', message = '请先登录后再使用练习社区。';
  end if;
  select min(u.id), count(*), bool_and(u.email_verified is true and coalesce(u.email, '') <> '')
    into v_user_id, v_matches, v_verified
    from auth.users u where u.sub = v_sub and u.project = v_project;
  if v_matches <> 1 or v_verified is not true then
    raise exception using errcode = '42501', message = '请先通过邮箱验证码完成登录。';
  end if;
  return v_user_id;
end;
$$;

create or replace function public.community_update_profile(p_nickname text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid bigint := community_private.require_verified_user();
  v_nickname text := community_private.trim_text(p_nickname);
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = '请先登录后再使用练习社区。';
  end if;
  if community_private.valid_nickname(v_nickname) is not true then
    raise exception using errcode = '22023', message = '昵称须为 2–24 个字符，且不能包含邮箱地址或控制字符。';
  end if;
  insert into public.community_profiles (user_id, nickname) values (v_uid, v_nickname)
    on conflict (user_id) do update set nickname = excluded.nickname, updated_at = statement_timestamp();
  return jsonb_build_object('nickname', v_nickname);
end;
$$;

create or replace function public.community_check_in(
  p_minutes integer, p_piece text, p_note text, p_is_public boolean
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid bigint := community_private.require_verified_user();
  v_now timestamptz := statement_timestamp();
  v_day date := community_private.shanghai_day(v_now);
  v_piece text := community_private.trim_text(p_piece);
  v_note text := community_private.trim_text(p_note);
  v_record public.community_checkins%rowtype;
  v_created boolean;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = '请先登录后再使用练习社区。';
  end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 720 then
    raise exception using errcode = '22023', message = '练习时长须为 1–720 分钟的整数。';
  end if;
  if community_private.valid_piece(v_piece) is not true then
    raise exception using errcode = '22023', message = '曲目名称最多 100 个字符，且不能包含控制字符。';
  end if;
  if community_private.valid_note(v_note) is not true then
    raise exception using errcode = '22023', message = '练习心得最多 280 个字符，且不能包含无效控制字符。';
  end if;
  if p_is_public is null then
    raise exception using errcode = '22023', message = '请选择是否公开这次打卡。';
  end if;

  insert into public.community_profiles (user_id, nickname)
    values (v_uid, '琴友-' || left(md5(v_uid::text), 8))
    on conflict (user_id) do nothing;
  insert into public.community_checkins (user_id, day, minutes, piece, note, is_public, created_at)
    values (v_uid, v_day, p_minutes, v_piece, v_note, p_is_public, v_now)
    on conflict (user_id, day) do nothing returning * into v_record;
  v_created := found;
  if not v_created then
    select * into v_record from public.community_checkins where user_id = v_uid and day = v_day;
  end if;
  return jsonb_build_object(
    'day', to_char(v_record.day, 'YYYY-MM-DD'), 'minutes', v_record.minutes,
    'piece', v_record.piece, 'note', v_record.note, 'is_public', v_record.is_public,
    'created_at', v_record.created_at, 'created', v_created
  );
end;
$$;

create or replace function public.community_set_checkin_public(p_day date, p_is_public boolean)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid bigint := community_private.require_verified_user();
  v_record public.community_checkins%rowtype;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = '请先登录后再使用练习社区。';
  end if;
  if p_day is null or not isfinite(p_day) then
    raise exception using errcode = '22023', message = '请选择有效的打卡日期。';
  end if;
  if p_is_public is null then
    raise exception using errcode = '22023', message = '请选择是否公开这次打卡。';
  end if;
  update public.community_checkins set is_public = p_is_public
    where user_id = v_uid and day = p_day returning * into v_record;
  if not found then
    raise exception using errcode = 'P0002', message = '没有找到这一天的打卡记录。';
  end if;
  return jsonb_build_object(
    'day', to_char(v_record.day, 'YYYY-MM-DD'), 'minutes', v_record.minutes,
    'piece', v_record.piece, 'note', v_record.note, 'is_public', v_record.is_public,
    'created_at', v_record.created_at
  );
end;
$$;

create or replace function public.community_dashboard()
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid bigint := community_private.require_verified_user();
  v_today date := community_private.shanghai_day(statement_timestamp());
  v_week_start date := v_today - (extract(isodow from v_today)::integer - 1);
  v_result jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = '请先登录后再使用练习社区。';
  end if;
  insert into public.community_profiles (user_id, nickname)
    values (v_uid, '琴友-' || left(md5(v_uid::text), 8))
    on conflict (user_id) do nothing;

  with anchor as (
    select max(day) as day from public.community_checkins
      where user_id = v_uid and day between v_today - 1 and v_today
  ), streak_days as (
    select c.day, a.day as anchor_day, row_number() over (order by c.day desc) as position
    from public.community_checkins c cross join anchor a where c.user_id = v_uid and c.day <= a.day
  ), own_recent as (
    select day, minutes, piece, note, is_public, created_at
    from public.community_checkins where user_id = v_uid and day between v_today - 89 and v_today
  ), public_recent as (
    select c.user_id, p.nickname, c.day, c.minutes, c.piece, c.note, c.created_at
    from public.community_checkins c join public.community_profiles p using (user_id)
    where c.is_public order by c.created_at desc, c.user_id, c.day desc limit 30
  ), week_totals as (
    select user_id, count(*) as days, sum(minutes) as minutes
    from public.community_checkins where is_public and day >= v_week_start and day < v_week_start + 7
    group by user_id
  ), ranked as (
    select w.user_id, p.nickname, w.days, w.minutes,
      row_number() over (order by w.days desc, w.minutes desc, w.user_id) as rank
    from week_totals w join public.community_profiles p using (user_id)
    order by rank limit 20
  )
  select jsonb_build_object(
    'today', to_char(v_today, 'YYYY-MM-DD'),
    'week_start', to_char(v_week_start, 'YYYY-MM-DD'),
    'profile', (select jsonb_build_object('nickname', nickname) from public.community_profiles where user_id = v_uid),
    'stats', jsonb_build_object(
      'total_days', (select count(*) from public.community_checkins where user_id = v_uid),
      'total_minutes', (select coalesce(sum(minutes), 0) from public.community_checkins where user_id = v_uid),
      'current_streak', (select count(*) from streak_days where day = anchor_day - (position::integer - 1))
    ),
    'checkins', coalesce((select jsonb_agg(jsonb_build_object(
      'day', to_char(day, 'YYYY-MM-DD'), 'minutes', minutes, 'piece', piece,
      'note', note, 'is_public', is_public, 'created_at', created_at
    ) order by day desc) from own_recent), '[]'::jsonb),
    'feed', coalesce((select jsonb_agg(jsonb_build_object(
      'nickname', nickname, 'day', to_char(day, 'YYYY-MM-DD'), 'minutes', minutes,
      'piece', piece, 'note', note, 'created_at', created_at
    ) order by created_at desc, user_id, day desc) from public_recent), '[]'::jsonb),
    'leaderboard', coalesce((select jsonb_agg(jsonb_build_object(
      'rank', rank, 'nickname', nickname, 'days', days, 'minutes', minutes, 'is_self', user_id = v_uid
    ) order by rank) from ranked), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

-- Revoke default function grants as defense in depth; RPC bodies also enforce authentication.
revoke all on function community_private.require_verified_user(), community_private.shanghai_day(timestamptz),
  community_private.trim_text(text), community_private.valid_nickname(text),
  community_private.valid_piece(text), community_private.valid_note(text)
  from public, anon, authenticated, service_role;
revoke all on function public.community_dashboard(), public.community_update_profile(text),
  public.community_check_in(integer, text, text, boolean), public.community_set_checkin_public(date, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.community_dashboard(), public.community_update_profile(text),
  public.community_check_in(integer, text, text, boolean), public.community_set_checkin_public(date, boolean)
  to authenticated;

comment on table public.community_profiles is 'Community nicknames; emails remain exclusively in CloudBase Auth.';
comment on table public.community_checkins is 'One immutable practice record per member per Shanghai day; visibility can change through the authenticated RPC.';

end;
$community_migration$;
