-- Column-level revokes don't override a table grant, so grant every column except mfa_secret.
revoke select on public.users from anon, authenticated;
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ') into cols
  from information_schema.columns
  where table_schema='public' and table_name='users' and column_name <> 'mfa_secret';
  execute format('grant select (%s) on public.users to authenticated', cols);
end $$;
