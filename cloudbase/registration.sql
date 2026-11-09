-- Private registration limits and username reservations for the administrator SQL endpoint.
-- Apply this entire file as one statement. Reapplying retains counters and reservations.
-- A slot is consumed before calling createUser, including when registration fails.
-- Rejected requests do not consume additional slots. No raw IP addresses, passwords or secret keys are stored.
do $registration_migration$
begin

create schema if not exists community_private;
revoke all on schema community_private from public, anon, authenticated, service_role;

create table if not exists community_private.registration_buckets (
  scope text not null check (scope in ('ip_minute', 'ip_hour', 'global_day')),
  subject_hash text not null,
  bucket_start timestamptz not null,
  expires_at timestamptz not null check (expires_at > bucket_start),
  attempts integer not null,
  primary key (scope, subject_hash, bucket_start),
  check (
    (scope = 'global_day' and subject_hash = 'global' and attempts between 1 and 100)
    or (scope = 'ip_minute' and subject_hash ~ '^[0-9a-f]{64}$' and attempts between 1 and 5)
    or (scope = 'ip_hour' and subject_hash ~ '^[0-9a-f]{64}$' and attempts between 1 and 20)
  )
);

create index if not exists registration_buckets_expiry_idx
  on community_private.registration_buckets (expires_at);

alter table community_private.registration_buckets enable row level security;
revoke all on table community_private.registration_buckets from public, anon, authenticated, service_role;

create table if not exists community_private.registration_names (
  username text collate "C" primary key check (username ~ '^[a-z][a-z0-9_-]{1,30}[a-z0-9]$'),
  expires_at timestamptz not null
);
create index if not exists registration_names_expiry_idx
  on community_private.registration_names (expires_at);
alter table community_private.registration_names enable row level security;
revoke all on table community_private.registration_names from public, anon, authenticated, service_role;

create or replace function community_private.registration_clock()
returns timestamptz language sql volatile set search_path = ''
as $$ select clock_timestamp() $$;

create or replace function community_private.consume_registration_slot(p_ip_hash text)
returns boolean language plpgsql security invoker set search_path = ''
as $$
declare
  v_now timestamptz;
  v_minute timestamptz;
  v_hour timestamptz;
  v_day timestamptz;
  v_minute_attempts integer;
  v_hour_attempts integer;
  v_day_attempts integer;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Registration requires a 64-character lowercase hexadecimal IP hash.';
  end if;

  -- One fixed transaction lock serializes the short quota reservation. There is
  -- no variable lock order, and concurrent requests cannot exceed any limit.
  perform pg_advisory_xact_lock(hashtextextended(
    'paijian:fast-junglefowl-d3fqxnq941dd1c4e:registration', 0));
  -- Take wall-clock time AFTER acquiring the lock, so a waiting request cannot
  -- reserve a slot in an already expired window across midnight/minute boundaries.
  v_now := community_private.registration_clock();
  v_minute := date_trunc('minute', v_now at time zone 'UTC') at time zone 'UTC';
  v_hour := date_trunc('hour', v_now at time zone 'UTC') at time zone 'UTC';
  v_day := date_trunc('day', v_now at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';

  -- Fixed windows expire immediately at their boundary. Cleanup uses an index
  -- and runs on demand, so no cron or stored raw IP is needed.
  delete from community_private.registration_buckets where expires_at <= v_now;

  select
    coalesce((select attempts from community_private.registration_buckets
      where scope = 'ip_minute' and subject_hash = p_ip_hash and bucket_start = v_minute), 0),
    coalesce((select attempts from community_private.registration_buckets
      where scope = 'ip_hour' and subject_hash = p_ip_hash and bucket_start = v_hour), 0),
    coalesce((select attempts from community_private.registration_buckets
      where scope = 'global_day' and subject_hash = 'global' and bucket_start = v_day), 0)
    into v_minute_attempts, v_hour_attempts, v_day_attempts;

  if v_minute_attempts >= 5 or v_hour_attempts >= 20 or v_day_attempts >= 100 then
    return false;
  end if;

  insert into community_private.registration_buckets as buckets
    (scope, subject_hash, bucket_start, expires_at, attempts)
    values
      ('ip_minute', p_ip_hash, v_minute, v_minute + interval '1 minute', 1),
      ('ip_hour', p_ip_hash, v_hour, v_hour + interval '1 hour', 1),
      ('global_day', 'global', v_day, v_day + interval '1 day', 1)
    on conflict (scope, subject_hash, bucket_start)
    do update set attempts = buckets.attempts + 1;
  return true;
end;
$$;

create or replace function community_private.reserve_registration_name(p_username text)
returns boolean language plpgsql security invoker set search_path = ''
as $$
declare
  v_username text;
  v_now timestamptz;
begin
  if p_username is null or p_username !~ '^[A-Za-z][A-Za-z0-9_-]{1,30}[A-Za-z0-9]$' then
    raise exception using errcode = '22023', message = 'Username must be 3–32 ASCII characters, start with a letter, end with a letter or digit, and contain only letters, digits, underscore or hyphen.';
  end if;
  v_username := lower(p_username collate "C");
  -- Use the same short transaction lock as quota reservation. Every caller must
  -- commit this reservation before createUser, and must not supply a custom Uid.
  perform pg_advisory_xact_lock(hashtextextended(
    'paijian:fast-junglefowl-d3fqxnq941dd1c4e:registration', 0));
  v_now := community_private.registration_clock();

  -- Existing accounts, including disabled accounts, retain their usernames.
  if exists (select 1 from auth.users u
    where u.project = 'fast-junglefowl-d3fqxnq941dd1c4e'
      and lower(u.username collate "C") = v_username) then
    return false;
  end if;

  delete from community_private.registration_names where expires_at <= v_now;
  insert into community_private.registration_names (username, expires_at)
    values (v_username, v_now + interval '10 minutes')
    on conflict (username) do nothing;
  return found;
end;
$$;

revoke all on function community_private.consume_registration_slot(text),
  community_private.reserve_registration_name(text), community_private.registration_clock()
  from public, anon, authenticated, service_role;

comment on table community_private.registration_buckets is
  'Admin-only fixed registration windows: 5/IP/minute, 20/IP/hour, 100/site/Shanghai day. Stores hashes and counters only.';
comment on function community_private.consume_registration_slot(text) is
  'Admin-only, invoker-security quota reservation. Call and commit before createUser; unsuccessful registrations still consume the slot.';
comment on table community_private.registration_names is
  'Admin-only lowercase username reservations; only the name and a 10-minute expiry are stored. No passwords or email addresses.';
comment on function community_private.reserve_registration_name(text) is
  'Admin-only case-insensitive duplicate protection. Commit before createUser; never release immediately after a timeout or provider failure.';

end;
$registration_migration$;
