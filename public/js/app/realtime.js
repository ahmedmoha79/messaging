// Live updates. One database channel carries every table change this user is
// allowed to see (row-level security filters it server-side), and one "team"
// channel carries presence and typing indicators.
import { sb } from '../lib/supabase.js';
import { state, emit, chatKey, isActive } from './state.js';
import { loadChatList, loadUsers, markDelivered } from './data.js';
import { notifyMessage, updateBadge } from './notify.js';

let dbChannel = null;
let teamChannel = null;
let lastStatus = '';

export function startRealtime() {
  const uid = state.me.id;

  dbChannel = sb.channel(`db:${uid}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, p => onMessageInsert(p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, p => onMessageUpdate(p.new))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, p => onMessageDelete(p.old))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, p => emit('reaction', p))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'calls', filter: `callee_id=eq.${uid}` }, p => emit('call:incoming', p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls' }, p => emit('call:update', p.new))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members' }, p => onMembership(p))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, p => onGroupUpdate(p.new))
    .subscribe(status => {
      if (status === lastStatus) return;
      const wasDown = lastStatus && lastStatus !== 'SUBSCRIBED';
      lastStatus = status;
      emit('realtime', status);
      // Anything could have happened while we were disconnected: resync.
      if (status === 'SUBSCRIBED' && wasDown) resync();
    });

  teamChannel = sb.channel('team', { config: { presence: { key: uid }, broadcast: { self: false } } })
    .on('presence', { event: 'sync' }, () => {
      state.online = new Set(Object.keys(teamChannel.presenceState()));
      // Someone we have never seen (a new teammate) just came online.
      if ([...state.online].some(id => !state.users.has(id))) refreshUsers();
      emit('presence');
    })
    .on('broadcast', { event: 'typing' }, ({ payload }) => onTyping(payload))
    .subscribe(async status => {
      if (status === 'SUBSCRIBED') await teamChannel.track({ at: Date.now() });
    });

  setInterval(expireTyping, 1000);
}

export async function resync() {
  try {
    await Promise.all([loadChatList(), loadUsers()]);
    emit('resync');
  } catch (err) {
    console.warn('Resync failed', err);
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
function chatOf(message) {
  if (message.group_id) return { type: 'group', id: message.group_id };
  const partner = message.sender_id === state.me.id ? message.receiver_id : message.sender_id;
  return { type: 'direct', id: partner };
}

function preview(message) {
  return {
    id: message.id,
    content: message.content,
    message_type: message.message_type,
    attachment_name: message.attachment_name,
    sender_id: message.sender_id,
    created_at: message.created_at,
    status: message.status,
    is_read: message.is_read
  };
}

/** Updates the chat list entry for a message (used for both incoming and our own sends). */
export function bumpChat(message, { countUnread = false } = {}) {
  const chat = chatOf(message);
  if (chat.type === 'group') {
    const g = state.groups.get(chat.id);
    if (!g) {
      loadChatList();
      return chat;
    }
    g.last = preview(message);
    g.last_at = message.created_at;
    if (countUnread) g.unread = (g.unread || 0) + 1;
  } else {
    const c = state.direct.get(chat.id) || { partner_id: chat.id, unread: 0 };
    c.last = preview(message);
    if (countUnread) c.unread = (c.unread || 0) + 1;
    state.direct.set(chat.id, c);
    if (!state.users.has(chat.id)) loadUsers();
  }
  emit('chatlist');
  updateBadge();
  return chat;
}

function onMessageInsert(message) {
  const mine = message.sender_id === state.me.id;
  const chat = chatOf(message);
  const viewing = isActive(chat.type, chat.id) && document.visibilityState === 'visible';

  bumpChat(message, { countUnread: !mine && !viewing });

  if (!mine) {
    // Clear the typing indicator the moment their message lands.
    const typing = state.typing.get(chatKey(chat.type, chat.id));
    if (typing?.delete(message.sender_id)) emit('typing', chatKey(chat.type, chat.id));

    if (!message.group_id && message.status === 'sent') markDelivered([message.id]);
    const muted = chat.type === 'group' && state.groups.get(chat.id)?.muted;
    if (!viewing && !muted) notifyMessage(message, chat);
  }
  emit('message:new', message);
}

function onMessageUpdate(message) {
  // Keep the chat-list ticks in sync when our last message gets read.
  const chat = chatOf(message);
  const entry = chat.type === 'group' ? state.groups.get(chat.id) : state.direct.get(chat.id);
  if (entry?.last?.id === message.id) {
    entry.last = preview(message);
    emit('chatlist');
  }
  emit('message:update', message);
}

function onMessageDelete(old) {
  emit('message:delete', old);
  // The deleted message may have been the latest preview; cheapest correct fix is a refresh.
  const wasLast = [...state.direct.values(), ...state.groups.values()].some(c => c.last?.id === old.id);
  if (wasLast) loadChatList();
}

// ---------------------------------------------------------------------------
// Groups and people
// ---------------------------------------------------------------------------
function onMembership(payload) {
  const row = payload.new?.user_id ? payload.new : payload.old;
  if (!row) return;
  if (row.user_id === state.me.id || !row.user_id) {
    loadChatList();
  }
  emit('members', row.conversation_id);
}

function onGroupUpdate(group) {
  const g = state.groups.get(group.id);
  if (g) {
    g.name = group.name;
    g.avatar_url = group.avatar_url;
    emit('chatlist');
    emit('group', group.id);
  }
}

let usersRefreshing = null;
/** Profile changes (names, photos) are picked up on presence changes and when the app regains focus. */
export function refreshUsers() {
  if (!usersRefreshing) {
    usersRefreshing = loadUsers()
      .then(() => {
        const me = state.users.get(state.me.id);
        if (me) state.me = me;
        emit('me');
      })
      .catch(() => {})
      .finally(() => { usersRefreshing = null; });
  }
  return usersRefreshing;
}

// ---------------------------------------------------------------------------
// Typing indicators
// ---------------------------------------------------------------------------
let lastTypingSent = 0;
let typingChatKey = '';

export function sendTyping(chat, stop = false) {
  if (!teamChannel || !chat) return;
  const now = Date.now();
  const key = chatKey(chat.type, chat.id);
  if (!stop && key === typingChatKey && now - lastTypingSent < 2500) return;
  if (stop && key !== typingChatKey) return;
  lastTypingSent = stop ? 0 : now;
  typingChatKey = stop ? '' : key;
  teamChannel.send({
    type: 'broadcast',
    event: 'typing',
    payload: {
      from: state.me.id,
      to: chat.type === 'direct' ? chat.id : null,
      group: chat.type === 'group' ? chat.id : null,
      stop
    }
  }).catch(() => {});
}

function onTyping({ from, to, group, stop }) {
  if (!from || from === state.me.id) return;
  let key;
  if (group) {
    if (!state.groups.has(group)) return;
    key = chatKey('group', group);
  } else if (to === state.me.id) {
    key = chatKey('direct', from);
  } else {
    return;
  }
  if (!state.typing.has(key)) state.typing.set(key, new Map());
  const map = state.typing.get(key);
  if (stop) map.delete(from);
  else map.set(from, Date.now() + 4500);
  emit('typing', key);
}

function expireTyping() {
  const now = Date.now();
  state.typing.forEach((map, key) => {
    let changed = false;
    map.forEach((expiry, uid) => {
      if (expiry < now) {
        map.delete(uid);
        changed = true;
      }
    });
    if (changed) emit('typing', key);
  });
}

export function typingNames(type, id) {
  const map = state.typing.get(chatKey(type, id));
  if (!map || !map.size) return [];
  return [...map.keys()].map(uid => state.users.get(uid)?.name?.split(' ')[0] || 'Someone');
}

export function realtimeHealthy() {
  return lastStatus === 'SUBSCRIBED';
}
