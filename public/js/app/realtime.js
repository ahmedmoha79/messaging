// Live updates, built to survive phones.
//
// Mobile browsers silently drop the WebSocket when the screen locks or the
// app goes to the background. Nothing in the page is told, so the app used to
// keep "listening" on a dead connection and missed rings and declines.
// Here every channel is watched: when one isn't joined (or the page comes back
// to the foreground) all channels are rebuilt and everything is re-synced.
//
// Channels:
//   db:<uid>          table changes this user may see (row-level security filters server-side)
//   team:<org>        presence + typing, one per company (never shared across companies)
//   inbox:<uid>       small "nudges" from other people (a call is ringing for you, it was
//                     declined...). A nudge only says "look"; the app then reads the truth
//                     from the database, so a forged nudge can't do anything.
import { sb, config } from '../lib/supabase.js';
import { state, emit, chatKey, isActive } from './state.js';
import { loadChatList, loadUsers, markDelivered } from './data.js';
import { notifyMessage, updateBadge } from './notify.js';

let dbChannel = null;
let teamChannel = null;
let inboxChannel = null;
let lastStatus = '';
let started = false;
let rebuilding = false;
let rebuildTimer = null;
let failures = 0;
let lastHealthy = 0;
let forceResync = false;

export function startRealtime() {
  if (started) return;
  started = true;
  connect();
  setInterval(expireTyping, 1000);
  // Watchdog: cheap local check every 10 s, plus the moments phones wake up.
  setInterval(() => ensureRealtime('interval'), 10000);
  // After a long time in the background the socket may look open but be dead
  // (phones freeze it), so it is rebuilt rather than trusted.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    ensureRealtime('visible', { force: away > 30000, resyncAfter: true });
  });
  window.addEventListener('pageshow', () => ensureRealtime('pageshow', { resyncAfter: true }));
  window.addEventListener('focus', () => ensureRealtime('focus'));
  window.addEventListener('online', () => ensureRealtime('online', { force: true, resyncAfter: true }));
  // New access token: hand it to the realtime connection straight away.
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'TOKEN_REFRESHED' && session?.access_token) {
      try { sb.realtime.setAuth(session.access_token); } catch { /* older client */ }
    }
  });
}

function connect() {
  const uid = state.me.id;
  const onStatus = name => status => {
    if (status === 'SUBSCRIBED') {
      failures = 0;
      lastHealthy = Date.now();
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      if (!rebuilding) scheduleRebuild(`${name} ${status}`);
    }
    if (name === 'db') {
      if (status === lastStatus) return;
      const wasDown = lastStatus && lastStatus !== 'SUBSCRIBED';
      lastStatus = status;
      emit('realtime', status);
      if (status === 'SUBSCRIBED' && (wasDown || forceResync)) {
        forceResync = false;
        recovered();
      }
    }
  };

  dbChannel = sb.channel(`db:${uid}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, p => onMessageInsert(p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, p => onMessageUpdate(p.new))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, p => onMessageDelete(p.old))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, p => emit('reaction', p))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'calls', filter: `callee_id=eq.${uid}` }, p => emit('call:incoming', p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls' }, p => emit('call:update', p.new))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members' }, p => onMembership(p))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, p => onGroupUpdate(p.new))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, p => emit('job:change', p))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'job_events' }, p => emit('job:event', p.new))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'proofs' }, p => emit('job:proof', p.new))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'org_members' }, p => emit('org:members', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'places' }, p => emit('places', p))
    .subscribe(onStatus('db'));

  inboxChannel = sb.channel(`inbox:${uid}`, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'nudge' }, ({ payload }) => onNudge(payload))
    .subscribe(onStatus('inbox'));

  if (state.org) {
    teamChannel = sb.channel(`team:${state.org.id}`, { config: { presence: { key: uid }, broadcast: { self: false } } })
      .on('presence', { event: 'sync' }, () => {
        state.online = new Set(Object.keys(teamChannel.presenceState()));
        // Someone we have never seen (a new teammate) just came online.
        if ([...state.online].some(id => !state.users.has(id))) refreshUsers();
        emit('presence');
      })
      .on('broadcast', { event: 'typing' }, ({ payload }) => onTyping(payload))
      .subscribe(async status => {
        onStatus('team')(status);
        if (status === 'SUBSCRIBED') await teamChannel.track({ at: Date.now() });
      });
  }
}

function channelsJoined() {
  const list = [dbChannel, inboxChannel, teamChannel].filter(Boolean);
  return list.length > 0 && list.every(ch => ch.state === 'joined');
}

function socketConnected() {
  try {
    return typeof sb.realtime.isConnected === 'function' ? sb.realtime.isConnected() : true;
  } catch {
    return true;
  }
}

/**
 * Makes sure the live connection works; rebuilds it when it doesn't.
 * `resyncAfter` also re-reads chats and checks for a ringing call even if the
 * connection looks fine (a phone may have slept through events).
 */
export function ensureRealtime(reason = 'check', { force = false, resyncAfter = false } = {}) {
  if (!started) return;
  const healthy = channelsJoined() && socketConnected();
  if (force || !healthy) {
    if (resyncAfter) forceResync = true;
    scheduleRebuild(reason, 0);
  } else if (resyncAfter) {
    recovered();
  }
}

function scheduleRebuild(reason, delay) {
  clearTimeout(rebuildTimer);
  const wait = delay ?? Math.min(15000, 1000 * 2 ** Math.min(failures, 4));
  rebuildTimer = setTimeout(() => rebuild(reason), wait);
}

async function rebuild(reason) {
  if (rebuilding || !navigator.onLine) return;
  rebuilding = true;
  failures += 1;
  console.info('[realtime] reconnecting:', reason);
  emit('realtime', 'RECONNECTING');
  try {
    const old = [dbChannel, inboxChannel, teamChannel].filter(Boolean);
    dbChannel = inboxChannel = teamChannel = null;
    lastStatus = 'RECONNECTING';
    // a dead socket never acknowledges the leave, so don't wait long for it
    await Promise.race([
      Promise.all(old.map(ch => sb.removeChannel(ch).catch(() => {}))),
      new Promise(resolve => setTimeout(resolve, 1500))
    ]);
    try {
      if (!socketConnected()) sb.realtime.connect();
    } catch { /* connect() is called by subscribe anyway */ }
    const { data } = await sb.auth.getSession();
    if (data.session?.access_token) {
      state.session = data.session;
      try { sb.realtime.setAuth(data.session.access_token); } catch { /* older client */ }
    }
    connect();
  } finally {
    rebuilding = false;
  }
}

let recoverTimer = null;
function recovered() {
  // collapse bursts (visible + focus + pageshow fire together)
  clearTimeout(recoverTimer);
  recoverTimer = setTimeout(() => {
    resync();
    emit('realtime:recovered');
  }, 150);
}

export async function resync() {
  try {
    await Promise.all([loadChatList(), loadUsers()]);
    emit('resync');
  } catch (err) {
    console.warn('Resync failed', err);
  }
}

export function realtimeHealthy() {
  return channelsJoined() && socketConnected() && Date.now() - lastHealthy < 10 * 60 * 1000;
}

/** Rebuilds the team channel after switching company. */
export function restartTeamChannel() {
  if (!started) return;
  scheduleRebuild('company changed', 0);
}

// ---------------------------------------------------------------------------
// Inbox nudges
// ---------------------------------------------------------------------------
/**
 * Sends a small nudge to someone's inbox over the REST broadcast endpoint,
 * which works even when our own WebSocket is down.
 */
export async function nudge(userId, payload) {
  if (!userId) return;
  try {
    await fetch(`${config.supabaseUrl}/realtime/v1/api/broadcast`, {
      method: 'POST',
      keepalive: true,
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${state.session?.access_token || config.supabaseAnonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ messages: [{ topic: `inbox:${userId}`, event: 'nudge', payload: { ...payload, from: state.me?.id } }] })
    });
  } catch {
    /* best effort: the database and polling are the source of truth */
  }
}

function onNudge(payload) {
  if (!payload || payload.from === state.me.id) return;
  if (payload.type === 'call' && payload.id) emit('call:nudge', payload.id);
  else if (payload.type === 'resync') resync();
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

