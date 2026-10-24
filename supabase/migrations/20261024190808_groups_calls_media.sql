-- ===== Group conversations =====
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  description text check (char_length(description) <= 500),
  avatar_url text,
  created_by uuid not null default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin','member')),
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  muted boolean not null default false,
  primary key (conversation_id, user_id)
);
create index if not exists conversation_members_user_idx on public.conversation_members(user_id);

create or replace function public.is_conversation_member(conv uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversation_members where conversation_id = conv and user_id = auth.uid());
$$;
create or replace function public.is_conversation_admin(conv uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversation_members where conversation_id = conv and user_id = auth.uid() and role = 'admin');
$$;
revoke execute on function public.is_conversation_member(uuid) from public, anon;
revoke execute on function public.is_conversation_admin(uuid) from public, anon;
grant execute on function public.is_conversation_member(uuid) to authenticated;
grant execute on function public.is_conversation_admin(uuid) to authenticated;

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
create policy "conv_select_members" on public.conversations for select to authenticated using (public.is_conversation_member(id));
create policy "conv_update_admins" on public.conversations for update to authenticated using (public.is_conversation_admin(id)) with check (public.is_conversation_admin(id));
create policy "members_select" on public.conversation_members for select to authenticated using (public.is_conversation_member(conversation_id));
create policy "members_update_self" on public.conversation_members for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "members_leave_or_admin_remove" on public.conversation_members for delete to authenticated using (user_id = auth.uid() or public.is_conversation_admin(conversation_id));
create policy "members_admin_add" on public.conversation_members for insert to authenticated with check (public.is_conversation_admin(conversation_id));

-- members can only change their own read marker / mute flag
create or replace function public.members_guard() returns trigger language plpgsql set search_path = public as $$
begin
  new.conversation_id := old.conversation_id;
  new.user_id := old.user_id;
  new.role := old.role;
  new.joined_at := old.joined_at;
  return new;
end $$;
create trigger members_guard before update on public.conversation_members for each row
  when (auth.uid() is not null) execute function public.members_guard();

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
    where u.id = any(member_ids) and u.id <> me
      and exists (select 1 from auth.users a where a.id = u.id)
    on conflict do nothing;
  return conv;
end $$;
revoke execute on function public.create_group(text, uuid[], text) from public, anon;
grant execute on function public.create_group(text, uuid[], text) to authenticated;

-- ===== Messages: group support, attachments, replies, idempotent sends =====
alter table public.messages alter column receiver_id drop not null;
alter table public.messages
  add column if not exists group_id uuid references public.conversations(id) on delete cascade,
  add column if not exists attachment_path text,
  add column if not exists attachment_name text,
  add column if not exists attachment_size bigint,
  add column if not exists attachment_mime text,
  add column if not exists reply_to bigint references public.messages(id) on delete set null,
  add column if not exists client_id uuid;
alter table public.messages drop constraint if exists messages_target_chk;
alter table public.messages add constraint messages_target_chk
  check ((receiver_id is not null and group_id is null) or (receiver_id is null and group_id is not null));
create unique index if not exists messages_client_id_key on public.messages(sender_id, client_id) where client_id is not null;
create index if not exists messages_group_created_idx on public.messages(group_id, created_at desc) where group_id is not null;
create index if not exists messages_pair_created_idx on public.messages(sender_id, receiver_id, created_at desc);
create index if not exists messages_unread_idx on public.messages(receiver_id, sender_id) where is_read is not true;
create index if not exists messages_attachment_path_idx on public.messages(attachment_path) where attachment_path is not null;
create index if not exists messages_audio_url_idx on public.messages(audio_url) where audio_url is not null;
drop index if exists public.idx_messages_sender_receiver;
drop index if exists public.idx_messages_created;

-- replace the 18 overlapping message policies with one clear set
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='messages' loop
    execute format('drop policy %I on public.messages', p.policyname);
  end loop;
end $$;
create policy "messages_select" on public.messages for select to authenticated using (
  sender_id = auth.uid() or receiver_id = auth.uid()
  or (group_id is not null and public.is_conversation_member(group_id)));
create policy "messages_insert" on public.messages for insert to authenticated with check (
  sender_id = auth.uid() and (
    (group_id is null and receiver_id is not null and receiver_id <> auth.uid())
    or (group_id is not null and public.is_conversation_member(group_id))));
create policy "messages_update_participants" on public.messages for update to authenticated using (
  sender_id = auth.uid() or receiver_id = auth.uid()) with check (sender_id = auth.uid() or receiver_id = auth.uid());
create policy "messages_delete_sender" on public.messages for delete to authenticated using (sender_id = auth.uid());

-- recipients may only touch delivery/read fields; nobody can re-address a message
create or replace function public.messages_guard() returns trigger language plpgsql set search_path = public as $$
begin
  new.sender_id := old.sender_id;
  new.receiver_id := old.receiver_id;
  new.group_id := old.group_id;
  new.created_at := old.created_at;
  new.client_id := old.client_id;
  if old.sender_id <> auth.uid() then
    new.content := old.content;
    new.message_type := old.message_type;
    new.metadata := old.metadata;
    new.audio_url := old.audio_url;
    new.audio_duration := old.audio_duration;
    new.audio_waveform := old.audio_waveform;
    new.attachment_path := old.attachment_path;
    new.attachment_name := old.attachment_name;
    new.attachment_size := old.attachment_size;
    new.attachment_mime := old.attachment_mime;
    new.reply_to := old.reply_to;
    new.reactions := old.reactions;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists messages_guard on public.messages;
create trigger messages_guard before update on public.messages for each row
  when (auth.uid() is not null) execute function public.messages_guard();

create or replace function public.touch_conversation() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.group_id is not null then
    update public.conversations set last_message_at = new.created_at where id = new.group_id;
  end if;
  return new;
end $$;
revoke execute on function public.touch_conversation() from public, anon, authenticated;
drop trigger if exists touch_conversation on public.messages;
create trigger touch_conversation after insert on public.messages for each row execute function public.touch_conversation();

-- ===== Reactions: one row per (message, user) instead of a shared JSON blob =====
delete from public.message_reactions a using public.message_reactions b
  where a.message_id = b.message_id and a.user_id = b.user_id and a.created_at < b.created_at;
create unique index if not exists message_reactions_one_per_user on public.message_reactions(message_id, user_id);
insert into public.message_reactions(message_id, user_id, emoji)
  select m.id, (u.val)::uuid, r.key
  from public.messages m
  cross join lateral jsonb_each(m.reactions) r
  cross join lateral jsonb_array_elements_text(r.value) u(val)
  where m.reactions is not null and jsonb_typeof(m.reactions) = 'object' and jsonb_typeof(r.value) = 'array'
    and u.val ~ '^[0-9a-f-]{36}$'
    and exists (select 1 from auth.users a where a.id = (u.val)::uuid)
  on conflict (message_id, user_id) do nothing;
drop policy if exists "Users can view reactions" on public.message_reactions;
create policy "reactions_select_visible" on public.message_reactions for select to authenticated using (
  exists (select 1 from public.messages m where m.id = message_id));
drop policy if exists "Users can add reactions" on public.message_reactions;
create policy "reactions_insert_visible" on public.message_reactions for insert to authenticated with check (
  user_id = auth.uid() and exists (select 1 from public.messages m where m.id = message_id));
create policy "reactions_update_own" on public.message_reactions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ===== Calls (ringing + call history; media flows peer-to-peer) =====
create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  callee_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'audio' check (kind in ('audio','video')),
  status text not null default 'ringing' check (status in ('ringing','accepted','declined','missed','ended','cancelled','busy','failed')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  check (caller_id <> callee_id)
);
create index if not exists calls_caller_idx on public.calls(caller_id, created_at desc);
create index if not exists calls_callee_idx on public.calls(callee_id, created_at desc);
alter table public.calls enable row level security;
create policy "calls_select_participants" on public.calls for select to authenticated using (auth.uid() in (caller_id, callee_id));
create policy "calls_insert_caller" on public.calls for insert to authenticated with check (caller_id = auth.uid() and status = 'ringing');
create policy "calls_update_participants" on public.calls for update to authenticated using (auth.uid() in (caller_id, callee_id)) with check (auth.uid() in (caller_id, callee_id));
create or replace function public.calls_guard() returns trigger language plpgsql set search_path = public as $$
begin
  new.caller_id := old.caller_id;
  new.callee_id := old.callee_id;
  new.kind := old.kind;
  new.created_at := old.created_at;
  return new;
end $$;
create trigger calls_guard before update on public.calls for each row
  when (auth.uid() is not null) execute function public.calls_guard();

-- ===== One round trip for the whole chat list (superseded by 20261024194418) =====
-- see 20261024194418_chat_list_attachment_names.sql for the current get_chat_list()

-- mark a whole direct conversation read in one call
create or replace function public.mark_chat_read(partner uuid)
returns void language sql security invoker set search_path = public as $$
  update public.messages set is_read = true, read_at = now(), status = 'read'
  where receiver_id = auth.uid() and sender_id = partner and is_read is not true;
$$;
revoke execute on function public.mark_chat_read(uuid) from public, anon;
grant execute on function public.mark_chat_read(uuid) to authenticated;

-- new accounts (password, magic link or Google) get a profile with their real name/photo
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email, name, avatar_url, status, created_at, lastonline, role, login_alerts, suspicious_activity_alerts)
  values (
    new.id, new.email,
    coalesce(nullif(new.raw_user_meta_data->>'full_name',''), nullif(new.raw_user_meta_data->>'name',''), split_part(new.email, '@', 1)),
    nullif(coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'), ''),
    'offline', now(), now(), 'user', true, true)
  on conflict (id) do nothing;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ===== Private media bucket (photos, files, voice notes) =====
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat_media', 'chat_media', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;
create policy "chat_media_upload_own_folder" on storage.objects for insert to authenticated with check (
  bucket_id = 'chat_media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "chat_media_read_participants" on storage.objects for select to authenticated using (
  bucket_id = 'chat_media' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (select 1 from public.messages m where m.attachment_path = storage.objects.name or m.audio_url = storage.objects.name)));
create policy "chat_media_delete_own" on storage.objects for delete to authenticated using (
  bucket_id = 'chat_media' and (storage.foldername(name))[1] = auth.uid()::text);

-- ===== Realtime =====
do $$
declare t text;
begin
  foreach t in array array['conversations','conversation_members','calls'] loop
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
alter table public.messages replica identity full;
alter table public.message_reactions replica identity full;
