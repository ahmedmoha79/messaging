-- One round trip for the whole chat list: every direct chat and group with
-- its latest message and unread count. Runs as the caller, so RLS applies.
create or replace function public.get_chat_list()
returns jsonb language sql stable security invoker set search_path = public as $$
  with me as (select auth.uid() as uid),
  direct as (
    select distinct on (partner) partner, m.id, m.content, m.message_type, m.attachment_name, m.sender_id, m.created_at, m.status, m.is_read
    from (
      select m.*, case when m.sender_id = (select uid from me) then m.receiver_id else m.sender_id end as partner
      from public.messages m
      where m.group_id is null and ((select uid from me) in (m.sender_id, m.receiver_id))
    ) m
    order by partner, m.created_at desc
  ),
  unread_direct as (
    select sender_id as partner, count(*)::int as n from public.messages
    where receiver_id = (select uid from me) and is_read is not true group by sender_id
  ),
  groups as (
    select c.id, c.name, c.avatar_url, c.last_message_at, cm.last_read_at, cm.muted,
      (select count(*)::int from public.conversation_members x where x.conversation_id = c.id) as member_count,
      (select jsonb_build_object('id', m.id, 'content', m.content, 'message_type', m.message_type, 'attachment_name', m.attachment_name, 'sender_id', m.sender_id, 'created_at', m.created_at)
         from public.messages m where m.group_id = c.id order by m.created_at desc limit 1) as last,
      (select count(*)::int from public.messages m where m.group_id = c.id and m.created_at > cm.last_read_at and m.sender_id <> (select uid from me)) as unread
    from public.conversations c
    join public.conversation_members cm on cm.conversation_id = c.id and cm.user_id = (select uid from me)
  )
  select jsonb_build_object(
    'direct', coalesce((select jsonb_agg(jsonb_build_object(
        'partner_id', d.partner,
        'last', jsonb_build_object('id', d.id, 'content', d.content, 'message_type', d.message_type, 'attachment_name', d.attachment_name, 'sender_id', d.sender_id, 'created_at', d.created_at, 'status', d.status, 'is_read', d.is_read),
        'unread', coalesce(u.n, 0))) from direct d left join unread_direct u on u.partner = d.partner), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object(
        'id', g.id, 'name', g.name, 'avatar_url', g.avatar_url, 'member_count', g.member_count, 'muted', g.muted,
        'last', g.last, 'last_at', coalesce((g.last->>'created_at')::timestamptz, g.last_message_at), 'unread', g.unread)) from groups g), '[]'::jsonb)
  );
$$;
revoke execute on function public.get_chat_list() from public, anon;
grant execute on function public.get_chat_list() to authenticated;
