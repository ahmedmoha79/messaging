-- realtime ignores column grants, so don't stream the users table (it has mfa_secret)
do $$ begin
  if exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='users') then
    alter publication supabase_realtime drop table public.users;
  end if;
end $$;

-- people can stop sharing their location
create policy "locations_delete_own" on public.user_locations for delete to authenticated using (user_id = auth.uid());

-- expired locations are cleaned by the trigger; it must run with owner rights to see every row
alter function public.auto_clean_expired_locations() security definer;
revoke execute on function public.auto_clean_expired_locations() from public, anon, authenticated;
