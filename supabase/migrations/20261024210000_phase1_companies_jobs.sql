-- Phase 1 ("Loads"): company workspaces, jobs with a status track, an
-- append-only job timeline, tamper-evident proof of delivery, places
-- (geofences) that post updates automatically, and a public tracking link.

-- =====================================================================
-- Companies
-- =====================================================================
create table if not exists public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 80),
  invite_code text not null unique default upper(encode(extensions.gen_random_bytes(5), 'hex')),
  plan text not null default 'crew' check (plan in ('crew','fleet','corridor')),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  job_seq integer not null default 0
);

create table if not exists public.org_members (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'driver' check (role in ('owner','admin','dispatcher','driver')),
  joined_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_members_user_idx on public.org_members(user_id);

create or replace function public.org_role(org uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.org_members where org_id = org and user_id = auth.uid();
$$;
create or replace function public.is_org_member(org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.org_members where org_id = org and user_id = auth.uid());
$$;
-- owners, admins and dispatchers run the operation; drivers see only their own jobs
create or replace function public.is_org_staff(org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.org_members where org_id = org and user_id = auth.uid() and role in ('owner','admin','dispatcher'));
$$;
create or replace function public.shares_org(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.org_members a join public.org_members b on a.org_id = b.org_id
    where a.user_id = auth.uid() and b.user_id = other);
$$;
revoke execute on function public.org_role(uuid), public.is_org_member(uuid), public.is_org_staff(uuid), public.shares_org(uuid) from public, anon;
grant execute on function public.org_role(uuid), public.is_org_member(uuid), public.is_org_staff(uuid), public.shares_org(uuid) to authenticated;

alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
create policy "orgs_select_members" on public.orgs for select to authenticated using (public.is_org_member(id));
create policy "orgs_update_admins" on public.orgs for update to authenticated
  using (public.org_role(id) in ('owner','admin')) with check (public.org_role(id) in ('owner','admin'));
create policy "org_members_select" on public.org_members for select to authenticated using (public.is_org_member(org_id));
create policy "org_members_leave_or_remove" on public.org_members for delete to authenticated using (
  (user_id = auth.uid() and role <> 'owner') or (public.org_role(org_id) in ('owner','admin') and role <> 'owner'));

-- only the company name can be changed directly; plan, code and counters are server-side
create or replace function public.orgs_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then
    new.id := old.id;
    new.invite_code := old.invite_code;
    new.plan := old.plan;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.job_seq := old.job_seq;
  end if;
  return new;
end $$;
drop trigger if exists orgs_guard on public.orgs;
create trigger orgs_guard before update on public.orgs for each row execute function public.orgs_guard();

create or replace function public.create_org(org_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare o uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if char_length(trim(coalesce(org_name, ''))) < 2 then raise exception 'company name required'; end if;
  insert into public.orgs(name, created_by) values (trim(org_name), auth.uid()) returning id into o;
  insert into public.org_members(org_id, user_id, role) values (o, auth.uid(), 'owner');
  return o;
end $$;

create or replace function public.join_org(code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare o uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select id into o from public.orgs where invite_code = upper(trim(code));
  if o is null then raise exception 'invalid invite code'; end if;
  insert into public.org_members(org_id, user_id, role) values (o, auth.uid(), 'driver') on conflict do nothing;
  return o;
end $$;

create or replace function public.set_member_role(org uuid, member uuid, new_role text) returns void
language plpgsql security definer set search_path = public as $$
declare mine text := public.org_role(org);
begin
  if new_role not in ('admin','dispatcher','driver') then raise exception 'invalid role'; end if;
  if mine is null or mine not in ('owner','admin') then raise exception 'only owners and admins can change roles'; end if;
  if new_role = 'admin' and mine <> 'owner' then raise exception 'only the owner can make admins'; end if;
  if exists (select 1 from public.org_members where org_id = org and user_id = member and role = 'owner') then
    raise exception 'the owner''s role cannot be changed';
  end if;
  update public.org_members set role = new_role where org_id = org and user_id = member;
end $$;

create or replace function public.new_invite_code(org uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if public.org_role(org) not in ('owner','admin') then raise exception 'only owners and admins can change the invite code'; end if;
  c := upper(encode(extensions.gen_random_bytes(5), 'hex'));
  update public.orgs set invite_code = c where id = org;
  return c;
end $$;

revoke execute on function public.create_org(text), public.join_org(text), public.set_member_role(uuid, uuid, text), public.new_invite_code(uuid) from public, anon;
grant execute on function public.create_org(text), public.join_org(text), public.set_member_role(uuid, uuid, text), public.new_invite_code(uuid) to authenticated;

-- Existing users become one company so nothing changes for them.
do $$
declare o uuid; owner_id uuid := '7e764ca3-8d03-48ad-be87-22d1fd0ab7da';
begin
  if not exists (select 1 from public.orgs) then
    insert into public.orgs(name, created_by, plan) values ('WAZAMBI Team', owner_id, 'corridor') returning id into o;
    insert into public.org_members(org_id, user_id, role)
      select o, u.id, case when u.id = owner_id then 'owner' else 'dispatcher' end
      from public.users u where exists (select 1 from auth.users a where a.id = u.id)
      on conflict do nothing;
  end if;
end $$;

-- People only see teammates (and themselves); locations and profiles likewise.
drop policy if exists "users_select_authenticated" on public.users;
create policy "users_select_teammates" on public.users for select to authenticated using (id = auth.uid() or public.shares_org(id));
drop policy if exists "locations_select_authenticated" on public.user_locations;
create policy "locations_select_teammates" on public.user_locations for select to authenticated using (user_id = auth.uid() or public.shares_org(user_id));
drop policy if exists "Anyone can view user profiles" on public.user_profiles;
create policy "profiles_select_teammates" on public.user_profiles for select to authenticated using (user_id = auth.uid() or public.shares_org(user_id));

-- Direct messages and new groups only between teammates
drop policy if exists "messages_insert" on public.messages;
create policy "messages_insert" on public.messages for insert to authenticated with check (
  sender_id = auth.uid() and (
    (group_id is null and receiver_id is not null and receiver_id <> auth.uid() and public.shares_org(receiver_id))
    or (group_id is not null and public.is_conversation_member(group_id))));

create or replace function public.create_group(group_name text, member_ids uuid[], group_description text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare conv uuid; me uuid := auth.uid();
begin
  if me is null then raise exception 'not authenticated'; end if;
  if coalesce(trim(group_name),'') = '' then raise exception 'group name required'; end if;
  insert into public.conversations(name, description, created_by)
    values (trim(group_name), group_description, me) returning id into conv;
  insert into public.conversation_members(conversation_id, user_id, role) values (conv, me, 'admin');
  insert into public.conversation_members(conversation_id, user_id, role)
    select conv, u.id, 'member' from public.users u
    where u.id = any(member_ids) and u.id <> me and public.shares_org(u.id)
      and exists (select 1 from auth.users a where a.id = u.id)
    on conflict do nothing;
  return conv;
end $$;

-- =====================================================================
-- Jobs
-- =====================================================================
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  ref text not null default '',
  title text not null check (char_length(title) between 1 and 120),
  customer_name text check (char_length(customer_name) <= 120),
  customer_phone text check (char_length(customer_phone) <= 40),
  pickup_name text check (char_length(pickup_name) <= 160),
  pickup_lat double precision check (pickup_lat between -90 and 90),
  pickup_lng double precision check (pickup_lng between -180 and 180),
  dropoff_name text check (char_length(dropoff_name) <= 160),
  dropoff_lat double precision check (dropoff_lat between -90 and 90),
  dropoff_lng double precision check (dropoff_lng between -180 and 180),
  cargo text check (char_length(cargo) <= 300),
  vehicle text check (char_length(vehicle) <= 40),
  notes text check (char_length(notes) <= 2000),
  driver_id uuid references auth.users(id) on delete set null,
  status text not null default 'assigned'
    check (status in ('assigned','loading','in_transit','at_border','arrived','delivered','paid','cancelled')),
  due_at timestamptz,
  track_token text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (org_id, ref)
);
create index if not exists jobs_org_status_idx on public.jobs(org_id, status, created_at desc);
create index if not exists jobs_driver_status_idx on public.jobs(driver_id, status);

create table if not exists public.job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.jobs(id) on delete cascade,
  org_id uuid references public.orgs(id) on delete cascade,
  kind text not null check (kind in ('created','assigned','status','note','photo','geofence','proof','customer_message','customer_reply')),
  status text,
  message text check (char_length(message) <= 2000),
  actor_id uuid default auth.uid() references auth.users(id) on delete set null,
  lat double precision,
  lng double precision,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists job_events_job_idx on public.job_events(job_id, created_at);

create table if not exists public.proofs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  org_id uuid references public.orgs(id) on delete cascade,
  receiver_name text not null check (char_length(receiver_name) between 1 and 120),
  photo_path text,
  signature_path text,
  note text check (char_length(note) <= 500),
  lat double precision,
  lng double precision,
  accuracy double precision,
  captured_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  prev_hash text,
  hash text
);
create index if not exists proofs_job_idx on public.proofs(job_id);

create table if not exists public.places (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  kind text not null default 'other' check (kind in ('depot','border','customer','site','other')),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  radius_m integer not null default 300 check (radius_m between 50 and 20000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists places_org_idx on public.places(org_id);

-- inside/outside memory for each driver, job and place (server-only)
create table if not exists public.geofence_state (
  user_id uuid not null,
  job_id uuid not null references public.jobs(id) on delete cascade,
  place_key text not null,
  inside boolean not null,
  changed_at timestamptz not null default now(),
  primary key (user_id, job_id, place_key)
);
alter table public.geofence_state enable row level security;

alter table public.jobs enable row level security;
alter table public.job_events enable row level security;
alter table public.proofs enable row level security;
alter table public.places enable row level security;

create policy "jobs_select" on public.jobs for select to authenticated using (public.is_org_staff(org_id) or driver_id = auth.uid());
create policy "jobs_insert_staff" on public.jobs for insert to authenticated with check (public.is_org_staff(org_id));
create policy "jobs_update" on public.jobs for update to authenticated
  using (public.is_org_staff(org_id) or driver_id = auth.uid())
  with check (public.is_org_staff(org_id) or driver_id = auth.uid());
create policy "jobs_delete_staff" on public.jobs for delete to authenticated using (public.is_org_staff(org_id));

create policy "job_events_select" on public.job_events for select to authenticated using (
  exists (select 1 from public.jobs j where j.id = job_id));
create policy "job_events_insert" on public.job_events for insert to authenticated with check (
  actor_id = auth.uid() and kind in ('note','photo','customer_reply')
  and exists (select 1 from public.jobs j where j.id = job_id));

create policy "proofs_select" on public.proofs for select to authenticated using (
  exists (select 1 from public.jobs j where j.id = job_id));
create policy "proofs_insert" on public.proofs for insert to authenticated with check (
  created_by = auth.uid() and exists (select 1 from public.jobs j where j.id = job_id));

create policy "places_select_members" on public.places for select to authenticated using (public.is_org_member(org_id));
create policy "places_write_staff" on public.places for all to authenticated using (public.is_org_staff(org_id)) with check (public.is_org_staff(org_id));

-- references like J-0001, numbered per company
create or replace function public.jobs_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.orgs set job_seq = job_seq + 1 where id = new.org_id returning job_seq into n;
  new.ref := 'J-' || lpad(n::text, 4, '0');
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.track_token := encode(extensions.gen_random_bytes(16), 'hex');
  if new.driver_id is not null and not exists (select 1 from public.org_members where org_id = new.org_id and user_id = new.driver_id) then
    raise exception 'the driver must be a member of this company';
  end if;
  return new;
end $$;
drop trigger if exists jobs_before_insert on public.jobs;
create trigger jobs_before_insert before insert on public.jobs for each row execute function public.jobs_before_insert();

-- drivers may only move their job along; staff may edit details. Nobody rewrites identity fields.
create or replace function public.jobs_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  new.id := old.id;
  new.org_id := old.org_id;
  new.ref := old.ref;
  new.track_token := old.track_token;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.updated_at := now();
  if auth.uid() is not null and not public.is_org_staff(old.org_id) then
    -- a driver: status only, and never to "paid" or back to "assigned"
    new.title := old.title; new.customer_name := old.customer_name; new.customer_phone := old.customer_phone;
    new.pickup_name := old.pickup_name; new.pickup_lat := old.pickup_lat; new.pickup_lng := old.pickup_lng;
    new.dropoff_name := old.dropoff_name; new.dropoff_lat := old.dropoff_lat; new.dropoff_lng := old.dropoff_lng;
    new.cargo := old.cargo; new.vehicle := old.vehicle; new.notes := old.notes; new.driver_id := old.driver_id; new.due_at := old.due_at;
    if new.status in ('paid','assigned','cancelled') and new.status <> old.status then
      raise exception 'drivers cannot set a job to %', new.status;
    end if;
  end if;
  if new.driver_id is distinct from old.driver_id and new.driver_id is not null
     and not exists (select 1 from public.org_members where org_id = old.org_id and user_id = new.driver_id) then
    raise exception 'the driver must be a member of this company';
  end if;
  if new.status = 'delivered' and old.status <> 'delivered' and new.delivered_at is null then new.delivered_at := now(); end if;
  return new;
end $$;
drop trigger if exists jobs_guard on public.jobs;
create trigger jobs_guard before update on public.jobs for each row execute function public.jobs_guard();

-- every change of status or driver lands in the job's timeline
create or replace function public.jobs_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare auto boolean := coalesce(current_setting('wazambi.auto', true), '') = '1';
begin
  if tg_op = 'INSERT' then
    insert into public.job_events(job_id, org_id, kind, status, actor_id) values (new.id, new.org_id, 'created', new.status, auth.uid());
    if new.driver_id is not null then
      insert into public.job_events(job_id, org_id, kind, actor_id, meta) values (new.id, new.org_id, 'assigned', auth.uid(), jsonb_build_object('driver_id', new.driver_id));
    end if;
  else
    if new.status is distinct from old.status then
      insert into public.job_events(job_id, org_id, kind, status, actor_id, meta)
      values (new.id, new.org_id, 'status', new.status, case when auto then null else auth.uid() end,
              jsonb_build_object('from', old.status, 'auto', auto));
    end if;
    if new.driver_id is distinct from old.driver_id and new.driver_id is not null then
      insert into public.job_events(job_id, org_id, kind, actor_id, meta) values (new.id, new.org_id, 'assigned', auth.uid(), jsonb_build_object('driver_id', new.driver_id));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists jobs_log on public.jobs;
create trigger jobs_log after insert or update on public.jobs for each row execute function public.jobs_log();

create or replace function public.job_events_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select org_id into new.org_id from public.jobs where id = new.job_id;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists job_events_before_insert on public.job_events;
create trigger job_events_before_insert before insert on public.job_events for each row execute function public.job_events_before_insert();

-- =====================================================================
-- Proof of delivery: each proof is hashed and chained to the company's
-- previous proof, so editing or deleting one breaks every hash after it.
-- =====================================================================
create or replace function public.proof_hash(p public.proofs) returns text
language sql immutable set search_path = public as $$
  select encode(extensions.digest(concat_ws('|',
    coalesce(p.prev_hash, 'genesis'), p.id::text, p.job_id::text, p.receiver_name,
    coalesce(p.photo_path, ''), coalesce(p.signature_path, ''), coalesce(p.note, ''),
    coalesce(p.lat::text, ''), coalesce(p.lng::text, ''), to_char(p.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(p.created_by::text, '')), 'sha256'), 'hex');
$$;

create or replace function public.proofs_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select org_id into new.org_id from public.jobs where id = new.job_id;
  new.captured_at := now();
  new.created_by := coalesce(auth.uid(), new.created_by);
  perform pg_advisory_xact_lock(hashtext('proofs:' || new.org_id::text));
  select hash into new.prev_hash from public.proofs where org_id = new.org_id order by captured_at desc, id desc limit 1;
  new.hash := public.proof_hash(new);
  return new;
end $$;
drop trigger if exists proofs_before_insert on public.proofs;
create trigger proofs_before_insert before insert on public.proofs for each row execute function public.proofs_before_insert();

create or replace function public.proofs_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.job_events(job_id, org_id, kind, actor_id, lat, lng, message, meta)
  values (new.job_id, new.org_id, 'proof', new.created_by, new.lat, new.lng, 'Delivered to ' || new.receiver_name,
          jsonb_build_object('proof_id', new.id, 'hash', new.hash));
  update public.jobs set status = 'delivered', delivered_at = new.captured_at
  where id = new.job_id and status not in ('delivered', 'paid');
  return new;
end $$;
drop trigger if exists proofs_after_insert on public.proofs;
create trigger proofs_after_insert after insert on public.proofs for each row execute function public.proofs_after_insert();

create or replace function public.verify_proof(proof uuid) returns boolean
language sql stable security invoker set search_path = public as $$
  select p.hash = public.proof_hash(p) from public.proofs p where p.id = proof;
$$;
revoke execute on function public.verify_proof(uuid) from public, anon;
grant execute on function public.verify_proof(uuid) to authenticated;

-- =====================================================================
-- Geofences: driver positions post arrivals/departures and move the job on.
-- =====================================================================
create or replace function public.distance_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

create or replace function public.geofence_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare j record; p record; d double precision; was boolean; now_inside boolean; next_status text;
begin
  for j in select * from public.jobs where driver_id = new.user_id and status in ('assigned','loading','in_transit','at_border','arrived') loop
    for p in
      select 'place:' || pl.id::text as key, pl.name, pl.kind, pl.lat, pl.lng, pl.radius_m from public.places pl where pl.org_id = j.org_id
      union all select 'pickup', coalesce(nullif(j.pickup_name, ''), 'pickup'), 'pickup', j.pickup_lat, j.pickup_lng, 300 where j.pickup_lat is not null and j.pickup_lng is not null
      union all select 'dropoff', coalesce(nullif(j.dropoff_name, ''), 'drop-off'), 'dropoff', j.dropoff_lat, j.dropoff_lng, 300 where j.dropoff_lat is not null and j.dropoff_lng is not null
    loop
      d := public.distance_m(new.latitude, new.longitude, p.lat, p.lng);
      select inside into was from public.geofence_state where user_id = new.user_id and job_id = j.id and place_key = p.key;
      -- 20% hysteresis so GPS jitter at the edge doesn't flap
      now_inside := case when was then d <= p.radius_m * 1.2 else d <= p.radius_m end;
      if was is null then
        insert into public.geofence_state(user_id, job_id, place_key, inside) values (new.user_id, j.id, p.key, now_inside);
        if not now_inside then continue; end if;
      elsif was = now_inside then
        continue;
      else
        update public.geofence_state set inside = now_inside, changed_at = now() where user_id = new.user_id and job_id = j.id and place_key = p.key;
      end if;

      insert into public.job_events(job_id, org_id, kind, actor_id, lat, lng, message, meta)
      values (j.id, j.org_id, 'geofence', null, new.latitude, new.longitude,
              case when now_inside then 'Arrived at ' else 'Left ' end || p.name,
              jsonb_build_object('place', p.key, 'place_kind', p.kind, 'event', case when now_inside then 'enter' else 'exit' end));

      next_status := null;
      if now_inside and p.kind = 'border' and j.status in ('assigned','loading','in_transit') then next_status := 'at_border';
      elsif now_inside and p.kind = 'dropoff' and j.status in ('assigned','loading','in_transit','at_border') then next_status := 'arrived';
      elsif not now_inside and p.kind = 'pickup' and j.status in ('assigned','loading') then next_status := 'in_transit';
      elsif not now_inside and p.kind = 'border' and j.status = 'at_border' then next_status := 'in_transit';
      end if;
      if next_status is not null then
        perform set_config('wazambi.auto', '1', true);
        update public.jobs set status = next_status where id = j.id;
        perform set_config('wazambi.auto', '', true);
        j.status := next_status;
      end if;
    end loop;
  end loop;
  return new;
end $$;
drop trigger if exists geofence_check on public.user_locations;
create trigger geofence_check after insert or update of latitude, longitude on public.user_locations
  for each row execute function public.geofence_check();

-- =====================================================================
-- Public tracking link (no account needed)
-- =====================================================================
create or replace function public.track_job(token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare j public.jobs; pr record; driver_name text; plat double precision; plng double precision; pat timestamptz;
begin
  if token is null or length(token) < 24 then return null; end if;
  select * into j from public.jobs where track_token = token;
  if j.id is null or j.status = 'cancelled' then return null; end if;
  select split_part(coalesce(u.name, ''), ' ', 1) into driver_name from public.users u where u.id = j.driver_id;
  if j.status in ('loading','in_transit','at_border','arrived') then
    select latitude, longitude, last_updated into plat, plng, pat from public.user_locations
    where user_id = j.driver_id and last_updated > now() - interval '3 hours';
  end if;
  select receiver_name, captured_at, hash into pr from public.proofs where job_id = j.id order by captured_at desc limit 1;
  return jsonb_build_object(
    'ref', j.ref,
    'company', (select name from public.orgs where id = j.org_id),
    'status', j.status,
    'pickup', jsonb_build_object('name', j.pickup_name, 'lat', j.pickup_lat, 'lng', j.pickup_lng),
    'dropoff', jsonb_build_object('name', j.dropoff_name, 'lat', j.dropoff_lat, 'lng', j.dropoff_lng),
    'due_at', j.due_at,
    'driver', driver_name,
    'vehicle', j.vehicle,
    'position', case when plat is null then null else jsonb_build_object('lat', plat, 'lng', plng, 'at', pat) end,
    'delivered_at', j.delivered_at,
    'proof', case when pr.receiver_name is null then null else jsonb_build_object('receiver', pr.receiver_name, 'at', pr.captured_at, 'hash', pr.hash) end,
    'events', coalesce((select jsonb_agg(jsonb_build_object(
        'kind', e.kind, 'status', e.status,
        'message', case when e.kind in ('geofence','proof','customer_message','customer_reply') then e.message end,
        'name', case when e.kind = 'customer_message' then e.meta->>'name' end,
        'at', e.created_at) order by e.created_at)
      from public.job_events e where e.job_id = j.id and e.kind in ('created','status','geofence','proof','customer_message','customer_reply')), '[]'::jsonb)
  );
end $$;

create or replace function public.track_message(token text, sender_name text, body text) returns boolean
language plpgsql security definer set search_path = public as $$
declare j public.jobs;
begin
  select * into j from public.jobs where track_token = token;
  if j.id is null or j.status in ('cancelled','paid') then raise exception 'tracking link not found'; end if;
  if char_length(trim(coalesce(body, ''))) = 0 or char_length(body) > 500 then raise exception 'message must be 1 to 500 characters'; end if;
  if (select count(*) from public.job_events where job_id = j.id and kind = 'customer_message' and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too many messages, try again later';
  end if;
  insert into public.job_events(job_id, org_id, kind, actor_id, message, meta)
  values (j.id, j.org_id, 'customer_message', null, trim(body), jsonb_build_object('name', left(coalesce(nullif(trim(sender_name), ''), 'Customer'), 60)));
  return true;
end $$;
revoke execute on function public.track_job(text), public.track_message(text, text, text) from public;
grant execute on function public.track_job(text), public.track_message(text, text, text) to anon, authenticated;

-- server-only helpers stay private
revoke execute on function public.jobs_before_insert(), public.jobs_log(), public.job_events_before_insert(),
  public.proofs_before_insert(), public.proofs_after_insert(), public.geofence_check(), public.orgs_guard()
  from public, anon, authenticated;

-- =====================================================================
-- Storage: proof photos and signatures, and photos posted in a job
-- =====================================================================
drop policy if exists "chat_media_read_participants" on storage.objects;
create policy "chat_media_read_participants" on storage.objects for select to authenticated using (
  bucket_id = 'chat_media' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (select 1 from public.messages m where m.attachment_path = storage.objects.name or m.audio_url = storage.objects.name)
    or exists (select 1 from public.proofs p where p.photo_path = storage.objects.name or p.signature_path = storage.objects.name)
    or exists (select 1 from public.job_events e where e.kind = 'photo' and e.meta->>'path' = storage.objects.name)));

-- =====================================================================
-- Realtime
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['jobs','job_events','proofs','places','org_members'] loop
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
