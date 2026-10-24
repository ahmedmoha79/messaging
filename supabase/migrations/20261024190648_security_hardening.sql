-- 1. verification_requests had RLS off: lock it to owners
alter table public.verification_requests enable row level security;
create policy "vr_select_own" on public.verification_requests for select to authenticated using (user_id = auth.uid());
create policy "vr_insert_own" on public.verification_requests for insert to authenticated with check (user_id = auth.uid() and coalesce(status,'pending') = 'pending');

-- 2. notifications: remove "anyone can read/edit/delete everything" policies
drop policy if exists "Allow DELETE on notifications" on public.notifications;
drop policy if exists "Allow INSERT on notifications" on public.notifications;
drop policy if exists "Allow SELECT on notifications" on public.notifications;
drop policy if exists "Allow UPDATE on notifications" on public.notifications;
drop policy if exists "No updates allowed" on public.notifications;
create policy "notif_update_own" on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 3. users: no open inserts, no anonymous reads, team can see each other when signed in
drop policy if exists "allow_all_inserts" on public.users;
drop policy if exists "Allow user signups" on public.users;
drop policy if exists "Enable insert for signups" on public.users;
drop policy if exists "Users can view all users" on public.users;
drop policy if exists "Allow public read access to users" on public.users;
drop policy if exists "Public profiles are viewable" on public.users;
create policy "users_select_authenticated" on public.users for select to authenticated using (true);
-- users can never promote themselves or change their id/email through the API
create or replace function public.users_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null and coalesce(auth.jwt()->>'role','') <> 'service_role' then
    new.id := old.id;
    new.email := old.email;
    new.role := old.role;
    new.verified := old.verified;
    new.account_status := old.account_status;
  end if;
  return new;
end $$;
drop trigger if exists users_guard on public.users;
create trigger users_guard before update on public.users for each row execute function public.users_guard();

-- 4. locations: signed-in team only
drop policy if exists "Allow public read access to locations" on public.user_locations;
drop policy if exists "Enable read access for all users" on public.user_locations;
drop policy if exists "Users can view all locations" on public.user_locations;
drop policy if exists "Enable insert for authenticated users only" on public.user_locations;
create policy "locations_select_authenticated" on public.user_locations for select to authenticated using (true);

-- 5. admin/SECURITY DEFINER functions were callable by anyone over /rpc
revoke execute on function public.approve_access(uuid) from public, anon, authenticated;
revoke execute on function public.approve_access_request(uuid) from public, anon, authenticated;
revoke execute on function public.approve_user(uuid) from public, anon, authenticated;
revoke execute on function public.get_user_sessions() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.increment_followers_count(integer, uuid) from public, anon, authenticated;
revoke execute on function public.increment_following_count(integer, uuid) from public, anon, authenticated;
revoke execute on function public.initialize_user_stats(uuid) from public, anon, authenticated;
revoke execute on function public.notify_admin() from public, anon, authenticated;
revoke execute on function public.notify_admin_of_request() from public, anon, authenticated;
revoke execute on function public.notify_admin_on_request() from public, anon, authenticated;
revoke execute on function public.supabase_notify_email(text, text, text) from public, anon, authenticated;

-- 6. pin search_path on every public function we own (not extension functions)
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prokind = 'f'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter function %s set search_path = public', r.sig);
  end loop;
end $$;

-- 7. materialized view should not be exposed to the API
revoke select on public.hourly_activity_heatmap from anon, authenticated;

-- 8. storage: drop "any signed-in user can upload anything to any bucket"
drop policy if exists "Allow users to insert their own files" on storage.objects;

-- 9. stop streaming private log tables over realtime
do $$
declare t text;
begin
  foreach t in array array['forensic_logs','security_logs','user_session_logs','verification_requests'] loop
    if exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end $$;
