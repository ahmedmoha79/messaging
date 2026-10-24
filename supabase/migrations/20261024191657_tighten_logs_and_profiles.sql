drop policy if exists "Security logs are insert-only for system" on public.security_logs;
drop policy if exists "Public profiles are viewable by everyone" on public.user_profiles;
drop policy if exists "Public stats are viewable by everyone" on public.user_stats;
create policy "user_stats_select_authenticated" on public.user_stats for select to authenticated using (true);
create unique index if not exists follows_pair_key on public.follows(follower_id, following_id);
