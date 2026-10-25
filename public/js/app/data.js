// Every read and write to Supabase lives here, so views never build queries
// themselves. Row-level security on the database decides what each person
// can see; these helpers just ask for the minimum needed.
import { sb, config } from '../lib/supabase.js';
import { state, emit } from './state.js';
import { uuid } from '../lib/dom.js';

export const USER_COLUMNS = 'id,name,email,avatar_url,status,lastonline,device_type,role,verified,created_at';
const MESSAGE_COLUMNS = 'id,sender_id,receiver_id,group_id,content,created_at,status,is_read,read_at,delivered_at,message_type,metadata,audio_url,audio_duration,audio_waveform,attachment_path,attachment_name,attachment_size,attachment_mime,reply_to,client_id';
export const PAGE_SIZE = 40;

function check({ data, error }) {
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
export async function loadMe(authUser) {
  let me = check(await sb.from('users').select(USER_COLUMNS).eq('id', authUser.id).maybeSingle());
  if (!me) {
    // Accounts created before the signup trigger existed may lack a profile row.
    const meta = authUser.user_metadata || {};
    const row = {
      id: authUser.id,
      email: authUser.email,
      name: meta.full_name || meta.name || (authUser.email || 'user').split('@')[0],
      avatar_url: meta.avatar_url || meta.picture || null,
      status: 'online',
      lastonline: new Date().toISOString()
    };
    me = check(await sb.from('users').upsert(row, { onConflict: 'id' }).select(USER_COLUMNS).single());
  }
  state.me = me;
  state.users.set(me.id, me);
  return me;
}

export async function loadUsers() {
  const rows = check(await sb.from('users').select(USER_COLUMNS).order('name', { ascending: true }));
  rows.forEach(u => state.users.set(u.id, u));
  emit('users');
  return rows;
}

export async function updateMe(fields) {
  const row = check(await sb.from('users').update(fields).eq('id', state.me.id).select(USER_COLUMNS).single());
  state.me = row;
  state.users.set(row.id, row);
  emit('me');
  emit('users');
  return row;
}

export async function touchPresence(status = 'online') {
  if (!state.me) return;
  await sb.from('users').update({ status, lastonline: new Date().toISOString() }).eq('id', state.me.id);
}

/** Best-effort "went offline" that survives the page closing. */
export function markOfflineOnExit() {
  const s = state.session;
  if (!s || !state.me) return;
  try {
    fetch(`${config.supabaseUrl}/rest/v1/users?id=eq.${state.me.id}`, {
      method: 'PATCH',
      keepalive: true,
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${s.access_token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ status: 'offline', lastonline: new Date().toISOString() })
    });
  } catch {
    /* ignore */
  }
}

export async function loadProfileDetails(userId) {
  const [profile, followers, following, amFollowing] = await Promise.all([
    sb.from('user_profiles').select('bio,location,website,job_title,company,skills').eq('user_id', userId).maybeSingle(),
    sb.from('follows').select('id', { count: 'exact', head: true }).eq('following_id', userId),
    sb.from('follows').select('id', { count: 'exact', head: true }).eq('follower_id', userId),
    userId === state.me.id
      ? Promise.resolve({ count: 0 })
      : sb.from('follows').select('id', { count: 'exact', head: true }).eq('follower_id', state.me.id).eq('following_id', userId)
  ]);
  return {
    profile: profile.data || {},
    followers: followers.count || 0,
    following: following.count || 0,
    isFollowing: (amFollowing.count || 0) > 0
  };
}

export async function setFollowing(userId, follow) {
  if (follow) {
    const { error } = await sb.from('follows').insert({ follower_id: state.me.id, following_id: userId });
    if (error && error.code !== '23505') throw error; // already following is fine
  } else {
    check(await sb.from('follows').delete().eq('follower_id', state.me.id).eq('following_id', userId));
  }
}

export async function saveMyProfile(fields) {
  return check(await sb.from('user_profiles')
    .upsert({ user_id: state.me.id, ...fields, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    .select('bio,location,website,job_title,company').single());
}

export async function uploadAvatar(blob) {
  const path = `${state.me.id}/avatar-${Date.now()}.${blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
  check(await sb.storage.from('avatars').upload(path, blob, { contentType: blob.type, cacheControl: '31536000', upsert: false }));
  const { data } = sb.storage.from('avatars').getPublicUrl(path);
  return data.publicUrl;
}

// ---------------------------------------------------------------------------
// Chat list
// ---------------------------------------------------------------------------
export async function loadChatList() {
  const data = check(await sb.rpc('get_chat_list'));
  state.direct.clear();
  (data.direct || []).forEach(c => state.direct.set(c.partner_id, c));
  state.groups.clear();
  (data.groups || []).forEach(g => state.groups.set(g.id, g));
  state.chatListLoaded = true;
  emit('chatlist');
  return data;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
function scopeQuery(query, chat) {
  if (chat.type === 'group') return query.eq('group_id', chat.id);
  const me = state.me.id;
  return query
    .is('group_id', null)
    .or(`and(sender_id.eq.${me},receiver_id.eq.${chat.id}),and(sender_id.eq.${chat.id},receiver_id.eq.${me})`);
}

/** Newest PAGE_SIZE messages before `before` (ISO time), returned oldest first. */
export async function fetchMessages(chat, { before = null, limit = PAGE_SIZE } = {}) {
  let q = scopeQuery(sb.from('messages').select(MESSAGE_COLUMNS), chat)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (before) q = q.lt('created_at', before);
  const rows = check(await q);
  return rows.reverse();
}

export async function fetchMessage(id) {
  return check(await sb.from('messages').select(MESSAGE_COLUMNS).eq('id', id).maybeSingle());
}

export async function fetchReactions(messageIds) {
  if (!messageIds.length) return [];
  return check(await sb.from('message_reactions').select('id,message_id,user_id,emoji').in('message_id', messageIds));
}

export async function fetchMessagesByIds(ids) {
  if (!ids.length) return [];
  return check(await sb.from('messages').select(MESSAGE_COLUMNS).in('id', ids));
}

export async function insertMessage(row) {
  const payload = { ...row, sender_id: state.me.id, device_type: deviceType() };
  const { data, error } = await sb.from('messages').insert(payload).select(MESSAGE_COLUMNS).single();
  if (error && error.code === '23505' && row.client_id) {
    // A retry after a flaky network: the first attempt actually landed.
    return check(await sb.from('messages').select(MESSAGE_COLUMNS).eq('sender_id', state.me.id).eq('client_id', row.client_id).single());
  }
  if (error) throw error;
  return data;
}

export async function deleteMessage(message) {
  check(await sb.from('messages').delete().eq('id', message.id).eq('sender_id', state.me.id));
  const paths = [message.attachment_path, message.audio_url].filter(p => p && !/^https?:/.test(p));
  if (paths.length) sb.storage.from('chat_media').remove(paths).catch(() => {});
}

export async function setReaction(messageId, emoji) {
  if (emoji) {
    check(await sb.from('message_reactions').upsert(
      { message_id: messageId, user_id: state.me.id, emoji, created_at: new Date().toISOString() },
      { onConflict: 'message_id,user_id' }));
  } else {
    check(await sb.from('message_reactions').delete().eq('message_id', messageId).eq('user_id', state.me.id));
  }
}

export async function markDirectRead(partnerId) {
  await sb.rpc('mark_chat_read', { partner: partnerId });
}

export async function markGroupRead(groupId) {
  await sb.from('conversation_members').update({ last_read_at: new Date().toISOString() })
    .eq('conversation_id', groupId).eq('user_id', state.me.id);
}

export async function markDelivered(ids) {
  if (!ids.length) return;
  await sb.from('messages').update({ status: 'delivered', delivered_at: new Date().toISOString() })
    .in('id', ids).eq('status', 'sent');
}

// ---------------------------------------------------------------------------
// Media (private bucket, short-lived signed links)
// ---------------------------------------------------------------------------
const signed = new Map(); // path -> { url, expires }
const SIGN_SECONDS = 6 * 3600;

export async function signPaths(paths) {
  const now = Date.now();
  const need = [...new Set(paths.filter(p => p && !/^https?:/.test(p)))]
    .filter(p => !(signed.get(p)?.expires > now + 60000));
  if (need.length) {
    const { data, error } = await sb.storage.from('chat_media').createSignedUrls(need, SIGN_SECONDS);
    if (!error) {
      data.forEach(item => {
        if (item.signedUrl) signed.set(item.path, { url: item.signedUrl, expires: now + SIGN_SECONDS * 1000 });
      });
    }
  }
}

export async function mediaUrl(path) {
  if (!path) return null;
  if (/^https?:/.test(path)) return path;
  await signPaths([path]);
  return signed.get(path)?.url || null;
}
export function cachedMediaUrl(path) {
  if (!path) return null;
  if (/^https?:/.test(path)) return path;
  return signed.get(path)?.url || null;
}

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'application/pdf': 'pdf'
};

/**
 * Uploads to the private chat_media bucket with real progress events
 * (supabase-js has none), returning the storage path.
 */
export function uploadMedia(blob, { name = '', onProgress, signal } = {}) {
  const type = (blob.type || 'application/octet-stream').split(';')[0];
  const fromName = (name.match(/\.([a-z0-9]{1,8})$/i) || [])[1];
  const ext = (fromName || EXT[type] || 'bin').toLowerCase();
  const d = new Date();
  const path = `${state.me.id}/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}/${uuid()}.${ext}`;
  const url = `${config.supabaseUrl}/storage/v1/object/chat_media/${path}`;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${state.session.access_token}`);
    xhr.setRequestHeader('apikey', config.supabaseAnonKey);
    xhr.setRequestHeader('Content-Type', type);
    xhr.setRequestHeader('cache-control', 'max-age=31536000');
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(path);
      else {
        let msg = 'Upload failed';
        try { msg = JSON.parse(xhr.responseText).message || msg; } catch { /* keep default */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(blob);
  });
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------
export async function createGroup(name, memberIds, description = null) {
  const id = check(await sb.rpc('create_group', { group_name: name, member_ids: memberIds, group_description: description }));
  await loadChatList();
  return id;
}

export async function loadGroup(groupId) {
  const [group, members] = await Promise.all([
    sb.from('conversations').select('id,name,description,avatar_url,created_by,created_at').eq('id', groupId).single(),
    sb.from('conversation_members').select('user_id,role,joined_at,muted').eq('conversation_id', groupId)
  ]);
  return { group: check(group), members: check(members) };
}

export async function addGroupMembers(groupId, userIds) {
  check(await sb.from('conversation_members').insert(userIds.map(user_id => ({ conversation_id: groupId, user_id, role: 'member' }))));
}

export async function removeGroupMember(groupId, userId) {
  check(await sb.from('conversation_members').delete().eq('conversation_id', groupId).eq('user_id', userId));
}

export async function updateGroup(groupId, fields) {
  check(await sb.from('conversations').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', groupId));
}

export async function setGroupMuted(groupId, muted) {
  check(await sb.from('conversation_members').update({ muted }).eq('conversation_id', groupId).eq('user_id', state.me.id));
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------
export async function createCall(calleeId, kind) {
  return check(await sb.from('calls').insert({ caller_id: state.me.id, callee_id: calleeId, kind, status: 'ringing' })
    .select('*').single());
}

/** Status only: the database stamps answered/ended times with its own clock. */
export async function updateCall(id, fields) {
  const { error } = await sb.from('calls').update({ status: fields.status }).eq('id', id);
  if (error) console.warn('Call update failed', error);
}

/** The call as the server sees it now, with its age by the server clock. */
export async function callState(id) {
  return check(await sb.rpc('call_state', { call_id: id }));
}

/** A call ringing for me right now, if any. */
export async function myRingingCall() {
  return check(await sb.rpc('my_ringing_call'));
}

export async function loadCallHistory(limit = 60) {
  return check(await sb.from('calls').select('*').order('created_at', { ascending: false }).limit(limit));
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------
export async function logSession() {
  const key = 'wazambi-session-logged';
  const sid = state.session?.access_token?.slice(-16);
  if (!sid || sessionStorage.getItem(key) === sid) return;
  sessionStorage.setItem(key, sid);
  await sb.from('user_session_logs').insert({ user_id: state.me.id, user_agent: navigator.userAgent.slice(0, 400) });
}

export async function loadSessions() {
  return check(await sb.from('user_session_logs').select('id,created_at,user_agent,ip_address')
    .eq('user_id', state.me.id).order('created_at', { ascending: false }).limit(10));
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------
export async function loadLocations() {
  return check(await sb.from('user_locations').select('user_id,latitude,longitude,accuracy,last_updated,device_context,battery_level'));
}

export async function saveLocation({ latitude, longitude, accuracy, battery }) {
  const now = new Date().toISOString();
  await sb.from('user_locations').upsert({
    user_id: state.me.id,
    latitude,
    longitude,
    accuracy,
    last_updated: now,
    last_active: now,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    is_sharing: true,
    is_online: true,
    battery_level: battery ?? null,
    device_context: { battery_level: battery ?? null, device_type: deviceType(), is_mobile: deviceType() === 'mobile' }
  }, { onConflict: 'user_id' });
}

export async function stopSharingLocation() {
  await sb.from('user_locations').delete().eq('user_id', state.me.id);
}

export function deviceType() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------
const ORG_KEY = 'wazambi-org';

export async function loadOrgs() {
  const rows = check(await sb.from('org_members')
    .select('org_id,role,joined_at,orgs(id,name,invite_code,plan,created_at)')
    .eq('user_id', state.me.id));
  state.orgs = rows.filter(r => r.orgs).map(r => ({ ...r.orgs, role: r.role }));
  let chosen = null;
  try { chosen = localStorage.getItem(`${ORG_KEY}:${state.me.id}`); } catch { /* ignore */ }
  const org = state.orgs.find(o => o.id === chosen) || state.orgs[0] || null;
  setActiveOrg(org, { silent: true });
  return state.orgs;
}

export function setActiveOrg(org, { silent = false } = {}) {
  state.org = org;
  state.role = org?.role || null;
  try {
    if (org) localStorage.setItem(`${ORG_KEY}:${state.me.id}`, org.id);
  } catch { /* ignore */ }
  if (!silent) emit('org');
}

export const isStaff = () => ['owner', 'admin', 'dispatcher'].includes(state.role);
export const isAdmin = () => ['owner', 'admin'].includes(state.role);

export async function createOrg(name) {
  const id = check(await sb.rpc('create_org', { org_name: name }));
  await loadOrgs();
  setActiveOrg(state.orgs.find(o => o.id === id) || state.org);
  return id;
}

export async function joinOrg(code) {
  const id = check(await sb.rpc('join_org', { code }));
  await loadOrgs();
  setActiveOrg(state.orgs.find(o => o.id === id) || state.org);
  return id;
}

export async function loadOrgMembers(orgId = state.org?.id) {
  if (!orgId) return [];
  const rows = check(await sb.from('org_members').select('user_id,role,joined_at').eq('org_id', orgId));
  state.members = new Map(rows.map(r => [r.user_id, r.role]));
  return rows;
}

export async function setMemberRole(userId, role) {
  check(await sb.rpc('set_member_role', { org: state.org.id, member: userId, new_role: role }));
}

export async function removeMember(userId) {
  check(await sb.from('org_members').delete().eq('org_id', state.org.id).eq('user_id', userId));
}

export async function newInviteCode() {
  const code = check(await sb.rpc('new_invite_code', { org: state.org.id }));
  state.org.invite_code = code;
  emit('org');
  return code;
}

export async function renameOrg(name) {
  check(await sb.from('orgs').update({ name }).eq('id', state.org.id));
  state.org.name = name;
  emit('org');
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
export const JOB_COLUMNS = 'id,org_id,ref,title,customer_name,customer_phone,pickup_name,pickup_lat,pickup_lng,dropoff_name,dropoff_lat,dropoff_lng,cargo,vehicle,notes,driver_id,status,due_at,track_token,created_by,created_at,updated_at,delivered_at';

export async function loadJobs({ orgId = state.org?.id, limit = 300 } = {}) {
  if (!orgId) return [];
  return check(await sb.from('jobs').select(JOB_COLUMNS).eq('org_id', orgId)
    .order('created_at', { ascending: false }).limit(limit));
}

export async function loadJob(id) {
  return check(await sb.from('jobs').select(JOB_COLUMNS).eq('id', id).maybeSingle());
}

export async function createJob(fields) {
  return check(await sb.from('jobs').insert({ ...fields, org_id: state.org.id }).select(JOB_COLUMNS).single());
}

export async function updateJob(id, fields) {
  return check(await sb.from('jobs').update(fields).eq('id', id).select(JOB_COLUMNS).single());
}

export async function deleteJob(id) {
  check(await sb.from('jobs').delete().eq('id', id));
}

export async function loadJobEvents(jobId) {
  return check(await sb.from('job_events').select('id,job_id,kind,status,message,actor_id,lat,lng,meta,created_at')
    .eq('job_id', jobId).order('created_at', { ascending: true }).limit(500));
}

export async function addJobEvent(jobId, kind, message, meta = {}) {
  return check(await sb.from('job_events').insert({ job_id: jobId, kind, message, meta, actor_id: state.me.id })
    .select('id,job_id,kind,status,message,actor_id,lat,lng,meta,created_at').single());
}

export async function loadProofs(jobId) {
  return check(await sb.from('proofs').select('*').eq('job_id', jobId).order('captured_at', { ascending: false }));
}

export async function createProof(fields) {
  return check(await sb.from('proofs').insert({ ...fields, created_by: state.me.id }).select('*').single());
}

export async function verifyProof(id) {
  return check(await sb.rpc('verify_proof', { proof: id }));
}

export async function loadPlaces(orgId = state.org?.id) {
  if (!orgId) return [];
  return check(await sb.from('places').select('*').eq('org_id', orgId).order('name'));
}

export async function addPlace(fields) {
  return check(await sb.from('places').insert({ ...fields, org_id: state.org.id }).select('*').single());
}

export async function deletePlace(id) {
  check(await sb.from('places').delete().eq('id', id));
}

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------
export async function vapidPublicKey() {
  const { data } = await sb.rpc('vapid_public_key');
  if (data) return data;
  // First device ever: ask the push function to create the key pair.
  const res = await fetch(`${config.supabaseUrl}/functions/v1/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'init' })
  });
  if (!res.ok) throw new Error('Push is not available right now');
  return (await res.json()).publicKey;
}

export async function savePushSubscription(sub) {
  const j = sub.toJSON();
  check(await sb.from('push_subscriptions').upsert({
    user_id: state.me.id,
    endpoint: j.endpoint,
    p256dh: j.keys.p256dh,
    auth: j.keys.auth,
    user_agent: navigator.userAgent.slice(0, 300)
  }, { onConflict: 'endpoint' }));
}

export async function deletePushSubscription(endpoint) {
  await sb.from('push_subscriptions').delete().eq('endpoint', endpoint);
}
