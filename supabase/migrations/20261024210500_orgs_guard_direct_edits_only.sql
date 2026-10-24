create or replace function public.orgs_guard() returns trigger language plpgsql set search_path = public as $$
begin
  -- Only direct edits from the app are restricted; the database's own
  -- functions (job numbering, new invite codes) run as the table owner.
  if current_user in ('authenticated', 'anon') then
    new.id := old.id;
    new.invite_code := old.invite_code;
    new.plan := old.plan;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.job_seq := old.job_seq;
  end if;
  return new;
end $$;
revoke execute on function public.orgs_guard() from public, anon, authenticated;
