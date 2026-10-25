-- Calls that work across devices, plus push notifications.
--
-- Problems this fixes:
--   * phones drop their live connection when the screen locks, so a ring or
--     a decline sent only over that connection was lost;
--   * call times came from each device's clock (yours differ by seconds);
--   * a ring could be left "ringing" forever if the caller's app died.

-- =====================================================================
-- Call state rules, enforced by the database with the server's clock
-- =====================================================================
create or replace function public.calls_rules() returns trigger
language plpgsql set search_path = public as $$
declare
  me uuid := auth.uid();
  terminal text[] := array['declined','missed','ended','cancelled','busy','failed'];
begin
  new.id := old.id;
  new.caller_id := old.caller_id;
  new.callee_id := old.callee_id;
  new.kind := old.kind;
  new.created_at := old.created_at;

  -- A finished call stays finished.
  if old.status = any(terminal) then
    new.status := old.status;
  end if;

  if me is not null and new.status is distinct from old.status then
    -- only the person being called can answer, decline or report busy
    if new.status in ('accepted','declined','busy') and me <> old.callee_id then new.status := old.status; end if;
    -- only the caller can cancel or give up
    if new.status in ('cancelled','missed') and me <> old.caller_id then new.status := old.status; end if;
    -- an answered call can only end
    if old.status = 'accepted' and new.status not in ('ended','failed') then new.status := old.status; end if;
    -- 'ringing' can't be restored
    if new.status = 'ringing' then new.status := old.status; end if;
  end if;

  -- timestamps always come from the server
  new.answered_at := case when new.status = 'accepted' and old.status <> 'accepted' then now() else old.answered_at end;
  new.ended_at := case when new.status = any(terminal) and not (old.status = any(terminal)) then now() else old.ended_at end;
  return new;
end $$;
drop trigger if exists calls_guard on public.calls;
drop trigger if exists calls_rules on public.calls;
create trigger calls_rules before update on public.calls for each row execute function public.calls_rules();

create or replace function public.calls_before_insert() returns trigger
language plpgsql set search_path = public as $$
begin
  new.created_at := now();
  new.status := 'ringing';
  new.answered_at := null;
  new.ended_at := null;
  return new;
end $$;
drop trigger if exists calls_before_insert on public.calls;
create trigger calls_before_insert before insert on public.calls for each row execute function public.calls_before_insert();

-- Only teammates can call each other
drop policy if exists "calls_insert_caller" on public.calls;
create policy "calls_insert_caller" on public.calls for insert to authenticated
  with check (caller_id = auth.uid() and status = 'ringing' and public.shares_org(callee_id));

-- The current state of a call, with its age measured by the server clock.
create or replace function public.call_state(call_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object('id', c.id, 'caller_id', c.caller_id, 'callee_id', c.callee_id, 'kind', c.kind,
    'status', c.status, 'created_at', c.created_at, 'answered_at', c.answered_at, 'ended_at', c.ended_at,
    'age_seconds', extract(epoch from now() - c.created_at))
  from public.calls c where c.id = call_id;
$$;

-- A call ringing for me right now (catches rings missed while the phone slept).
create or replace function public.my_ringing_call() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object('id', c.id, 'caller_id', c.caller_id, 'callee_id', c.callee_id, 'kind', c.kind,
    'status', c.status, 'created_at', c.created_at, 'age_seconds', extract(epoch from now() - c.created_at))
  from public.calls c
  where c.callee_id = auth.uid() and c.status = 'ringing' and c.created_at > now() - interval '45 seconds'
  order by c.created_at desc limit 1;
$$;
revoke execute on function public.call_state(uuid), public.my_ringing_call() from public, anon;
grant execute on function public.call_state(uuid), public.my_ringing_call() to authenticated;

-- Rings nobody answered become missed calls, even if the caller's app died.
create or replace function public.expire_stale_calls() returns void
language sql security definer set search_path = public as $$
  update public.calls set status = 'missed' where status = 'ringing' and created_at < now() - interval '60 seconds';
  update public.calls set status = 'ended' where status = 'accepted' and answered_at < now() - interval '8 hours';
$$;
revoke execute on function public.expire_stale_calls() from public, anon, authenticated;
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'wazambi-expire-calls';
  perform cron.schedule('wazambi-expire-calls', '* * * * *', 'select public.expire_stale_calls()');
end $$;

-- =====================================================================
-- Push notifications
-- =====================================================================
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
create policy "push_own_select" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy "push_own_insert" on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid());
create policy "push_own_update" on public.push_subscriptions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "push_own_delete" on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());

-- Secrets live in Vault. The hook secret is generated here and never leaves
-- the database; the VAPID key pair is generated by the push function itself.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'wazambi_push_hook') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'wazambi_push_hook', 'Shared secret between database triggers and the push function');
  end if;
end $$;

create or replace function public.push_config() returns jsonb
language sql stable security definer set search_path = public, vault as $$
  select jsonb_build_object(
    'hook', (select decrypted_secret from vault.decrypted_secrets where name = 'wazambi_push_hook'),
    'public', (select decrypted_secret from vault.decrypted_secrets where name = 'wazambi_vapid_public'),
    'private', (select decrypted_secret from vault.decrypted_secrets where name = 'wazambi_vapid_private'));
$$;

create or replace function public.push_init_vapid(pub text, priv text) returns text
language plpgsql security definer set search_path = public, vault as $$
declare existing text;
begin
  select decrypted_secret into existing from vault.decrypted_secrets where name = 'wazambi_vapid_public';
  if existing is not null then return existing; end if;
  perform vault.create_secret(priv, 'wazambi_vapid_private', 'Web Push VAPID private key');
  perform vault.create_secret(pub, 'wazambi_vapid_public', 'Web Push VAPID public key');
  return pub;
end $$;

create or replace function public.vapid_public_key() returns text
language sql stable security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'wazambi_vapid_public';
$$;

revoke execute on function public.push_config(), public.push_init_vapid(text, text) from public, anon, authenticated;
grant execute on function public.push_config(), public.push_init_vapid(text, text) to service_role;
revoke execute on function public.vapid_public_key() from public, anon;
grant execute on function public.vapid_public_key() to authenticated;

-- Ask the push function to notify people about something that just happened.
-- Never blocks or fails the change that triggered it.
create or replace function public.notify_push(kind text, ref text) returns void
language plpgsql security definer set search_path = public, vault, extensions as $$
declare hook text;
begin
  select decrypted_secret into hook from vault.decrypted_secrets where name = 'wazambi_push_hook';
  perform net.http_post(
    url := 'https://twsqvdxhsfvdibhpfvqr.supabase.co/functions/v1/push',
    body := jsonb_build_object('type', kind, 'id', ref),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook),
    timeout_milliseconds := 8000);
exception when others then
  raise warning 'notify_push failed: %', sqlerrm;
end $$;
revoke execute on function public.notify_push(text, text) from public, anon, authenticated;

create or replace function public.calls_push() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.push_subscriptions where user_id = new.callee_id) then return new; end if;
  if tg_op = 'INSERT' then
    perform public.notify_push('call', new.id::text);
  elsif old.status = 'ringing' and new.status <> 'ringing' then
    -- replaces the ringing notification with "missed call" or clears it
    perform public.notify_push('call', new.id::text);
  end if;
  return new;
end $$;
drop trigger if exists calls_push on public.calls;
create trigger calls_push after insert or update of status on public.calls for each row execute function public.calls_push();

create or replace function public.messages_push() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.group_id is null then
    if not exists (select 1 from public.push_subscriptions where user_id = new.receiver_id) then return new; end if;
  else
    if not exists (
      select 1 from public.conversation_members cm join public.push_subscriptions ps on ps.user_id = cm.user_id
      where cm.conversation_id = new.group_id and cm.user_id <> new.sender_id and not cm.muted) then return new; end if;
  end if;
  perform public.notify_push('message', new.id::text);
  return new;
end $$;
drop trigger if exists messages_push on public.messages;
create trigger messages_push after insert on public.messages for each row execute function public.messages_push();

create or replace function public.job_events_push() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('customer_message', 'assigned') then
    perform public.notify_push('job_event', new.id::text);
  end if;
  return new;
end $$;
drop trigger if exists job_events_push on public.job_events;
create trigger job_events_push after insert on public.job_events for each row execute function public.job_events_push();

revoke execute on function public.calls_rules(), public.calls_before_insert(), public.calls_push(),
  public.messages_push(), public.job_events_push() from public, anon, authenticated;
