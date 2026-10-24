create or replace function public.notify_new_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.group_id is null then
    insert into public.notifications(user_id, message_id, type, title, body)
    values (new.receiver_id, new.id, 'message', 'New message', left(coalesce(new.content, ''), 140));
  else
    insert into public.notifications(user_id, message_id, type, title, body)
    select cm.user_id, new.id, 'group_message', 'New group message', left(coalesce(new.content, ''), 140)
    from public.conversation_members cm
    where cm.conversation_id = new.group_id and cm.user_id <> new.sender_id and not cm.muted;
  end if;
  return new;
end $$;
revoke execute on function public.notify_new_message() from public, anon, authenticated;
