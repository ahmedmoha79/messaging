// A tiny in-memory stand-in for Supabase, for local end-to-end testing only.
// It implements just enough of PostgREST, RPC, Storage, Auth and Realtime
// (via server-sent events) for the WAZAMBI web app, including the access
// rules the real database enforces with row-level security.
//
//   node test/fake-supabase/server.mjs     (listens on :54321)
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.FAKE_PORT) || 54321;

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------
const now = Date.now();
const iso = ms => new Date(ms).toISOString();
export const USERS = {
  ahmed: { id: '11111111-1111-4111-8111-111111111111', email: 'ahmed@example.com', name: 'Ahmed Mohamed' },
  mutale: { id: '22222222-2222-4222-8222-222222222222', email: 'mutale@example.com', name: 'Mutale Banda' },
  chanda: { id: '33333333-3333-4333-8333-333333333333', email: 'chanda@example.com', name: 'Chanda Phiri' }
};
const PASSWORD = 'correct horse 42';

const db = {
  users: Object.values(USERS).map((u, i) => ({
    ...u, avatar_url: null, status: 'offline', lastonline: iso(now - (i + 1) * 3600e3), device_type: 'desktop',
    role: 'user', verified: i === 0, created_at: iso(now - 90 * 86400e3), mfa_secret: 'never-exposed', login_alerts: true
  })),
  messages: [],
  message_reactions: [],
  conversations: [],
  conversation_members: [],
  calls: [],
  user_profiles: [{ id: randomUUID(), user_id: USERS.mutale.id, bio: 'Night dispatch, Lusaka depot.', job_title: 'Dispatcher', company: 'WAZAMBI Logistics', location: 'Lusaka' }],
  follows: [{ id: randomUUID(), follower_id: USERS.mutale.id, following_id: USERS.ahmed.id, created_at: iso(now - 86400e3) }],
  user_session_logs: [],
  security_logs: [],
  user_locations: [
    { user_id: USERS.mutale.id, latitude: -15.4167, longitude: 28.2833, accuracy: 20, last_updated: iso(now - 120e3), battery_level: 64, device_context: { battery_level: 64 } }
  ],
  notifications: []
};
let messageSeq = 700;

function seedMessages() {
  const t0 = now - 2 * 86400e3;
  const conv = [
    [USERS.mutale.id, USERS.ahmed.id, 'Morning! Truck 14 is loaded and leaving the depot now.', 0],
    [USERS.ahmed.id, USERS.mutale.id, 'Great, thanks. ETA to Kabwe?', 4],
    [USERS.mutale.id, USERS.ahmed.id, 'About 2 hours if the Great North Road is clear.', 6],
    [USERS.mutale.id, USERS.ahmed.id, '👍', 7],
    [USERS.ahmed.id, USERS.mutale.id, 'Send me the delivery note when you get there: https://example.com/notes/14', 60 * 24],
    [USERS.mutale.id, USERS.ahmed.id, 'Will do. Also <b>this should not be bold</b> <img src=x onerror=alert(1)>', 60 * 24 + 3]
  ];
  conv.forEach(([s, r, content, min], i) => {
    db.messages.push(msgRow({ sender_id: s, receiver_id: r, content, created_at: iso(t0 + min * 60e3), status: 'read', is_read: true, id: ++messageSeq }));
  });
  // one unread from Chanda
  db.messages.push(msgRow({ sender_id: USERS.chanda.id, receiver_id: USERS.ahmed.id, content: 'Are we still on for the 3pm check-in?', created_at: iso(now - 25 * 60e3), status: 'delivered', id: ++messageSeq }));
  db.message_reactions.push({ id: randomUUID(), message_id: 702, user_id: USERS.mutale.id, emoji: '❤️', created_at: iso(t0) });

  const gid = '44444444-4444-4444-8444-444444444444';
  db.conversations.push({ id: gid, name: 'Kabwe run', description: null, avatar_url: null, created_by: USERS.ahmed.id, created_at: iso(t0), updated_at: iso(t0), last_message_at: iso(now - 3600e3) });
  [USERS.ahmed.id, USERS.mutale.id, USERS.chanda.id].forEach((uid, i) =>
    db.conversation_members.push({ conversation_id: gid, user_id: uid, role: i === 0 ? 'admin' : 'member', joined_at: iso(t0), last_read_at: iso(now - 2 * 3600e3), muted: false }));
  db.messages.push(msgRow({ sender_id: USERS.chanda.id, group_id: gid, receiver_id: null, content: 'Fuel stop at Chisamba, 20 minutes.', created_at: iso(now - 3600e3), id: ++messageSeq }));
}

function msgRow(m) {
  return {
    id: m.id ?? ++messageSeq, sender_id: m.sender_id, receiver_id: m.receiver_id ?? null, group_id: m.group_id ?? null,
    content: m.content ?? '', created_at: m.created_at ?? iso(Date.now()), status: m.status ?? 'sent', is_read: m.is_read ?? false,
    read_at: null, delivered_at: null, message_type: m.message_type ?? 'text', metadata: m.metadata ?? null,
    audio_url: m.audio_url ?? null, audio_duration: m.audio_duration ?? null, audio_waveform: m.audio_waveform ?? null,
    attachment_path: m.attachment_path ?? null, attachment_name: m.attachment_name ?? null, attachment_size: m.attachment_size ?? null,
    attachment_mime: m.attachment_mime ?? null, reply_to: m.reply_to ?? null, client_id: m.client_id ?? null, device_type: m.device_type ?? null,
    reactions: {}, updated_at: iso(Date.now())
  };
}
seedMessages();

// ---------------------------------------------------------------------------
// Visibility rules (mirrors the row-level security policies)
// ---------------------------------------------------------------------------
const isMember = (gid, uid) => db.conversation_members.some(m => m.conversation_id === gid && m.user_id === uid);
function visible(table, row, uid) {
  if (!uid) return false;
  switch (table) {
    case 'messages': return row.sender_id === uid || row.receiver_id === uid || (row.group_id && isMember(row.group_id, uid));
    case 'calls': return row.caller_id === uid || row.callee_id === uid;
    case 'conversations': return isMember(row.id, uid);
    case 'conversation_members': return isMember(row.conversation_id, uid);
    case 'message_reactions': { const m = db.messages.find(x => x.id === row.message_id); return !!m && visible('messages', m, uid); }
    case 'user_session_logs':
    case 'security_logs':
    case 'notifications': return row.user_id === uid;
    default: return true;
  }
}
function strip(table, row) {
  if (table === 'users') {
    const { mfa_secret, ...rest } = row;
    return rest;
  }
  return row;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------
function cmp(row, col, op, val) {
  const v = row[col];
  switch (op) {
    case 'eq': return String(v) === String(val);
    case 'neq': return String(v) !== String(val);
    case 'lt': return v != null && v < val;
    case 'gt': return v != null && v > val;
    case 'is': return val === null || val === 'null' ? v == null : v === val;
    case 'in': return val.map(String).includes(String(v));
    default: return true;
  }
}
// "and(a.eq.1,b.eq.2),and(a.eq.2,b.eq.1)"
function orMatches(row, expr) {
  const groups = [];
  let depth = 0;
  let cur = '';
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { groups.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) groups.push(cur);
  return groups.some(g => {
    const inner = g.startsWith('and(') ? g.slice(4, -1).split(',') : [g];
    return inner.every(c => {
      const [col, op, ...rest] = c.split('.');
      return cmp(row, col, op, rest.join('.'));
    });
  });
}
function applyFilters(rows, filters = []) {
  return rows.filter(r => filters.every(f => (f.op === 'or' ? orMatches(r, f.val) : cmp(r, f.col, f.op, f.val))));
}

// ---------------------------------------------------------------------------
// Realtime (SSE)
// ---------------------------------------------------------------------------
const clients = new Map(); // id -> { res, uid }
const presence = new Map(); // channel -> Map(key -> state)
function push(client, data) {
  client.res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function emitChange(table, eventType, row, old = null) {
  for (const c of clients.values()) {
    const check = row || old;
    if (eventType !== 'DELETE' && !visible(table, check, c.uid)) continue;
    push(c, { kind: 'db', table, eventType, new: row ? strip(table, row) : {}, old: old ? (eventType === 'DELETE' ? { id: old.id, user_id: old.user_id } : strip(table, old)) : {} });
  }
}
function emitPresence(channel) {
  const state = Object.fromEntries([...(presence.get(channel) || new Map())].map(([k, v]) => [k, [v]]));
  for (const c of clients.values()) push(c, { kind: 'presence', channel, state });
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------
const rpc = {
  get_chat_list(_, uid) {
    const direct = new Map();
    db.messages.filter(m => !m.group_id && (m.sender_id === uid || m.receiver_id === uid))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .forEach(m => {
        const partner = m.sender_id === uid ? m.receiver_id : m.sender_id;
        const entry = direct.get(partner) || { partner_id: partner, unread: 0 };
        entry.last = { id: m.id, content: m.content, message_type: m.message_type, attachment_name: m.attachment_name, sender_id: m.sender_id, created_at: m.created_at, status: m.status, is_read: m.is_read };
        if (m.receiver_id === uid && !m.is_read) entry.unread++;
        direct.set(partner, entry);
      });
    const groups = db.conversation_members.filter(cm => cm.user_id === uid).map(cm => {
      const c = db.conversations.find(x => x.id === cm.conversation_id);
      const msgs = db.messages.filter(m => m.group_id === c.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
      const last = msgs[msgs.length - 1];
      return {
        id: c.id, name: c.name, avatar_url: c.avatar_url, muted: cm.muted,
        member_count: db.conversation_members.filter(x => x.conversation_id === c.id).length,
        last: last ? { id: last.id, content: last.content, message_type: last.message_type, attachment_name: last.attachment_name, sender_id: last.sender_id, created_at: last.created_at } : null,
        last_at: last?.created_at || c.last_message_at,
        unread: msgs.filter(m => m.created_at > cm.last_read_at && m.sender_id !== uid).length
      };
    });
    return { direct: [...direct.values()], groups };
  },
  mark_chat_read({ partner }, uid) {
    db.messages.filter(m => m.receiver_id === uid && m.sender_id === partner && !m.is_read).forEach(m => {
      const old = { ...m };
      Object.assign(m, { is_read: true, read_at: iso(Date.now()), status: 'read' });
      emitChange('messages', 'UPDATE', m, old);
    });
    return null;
  },
  create_group({ group_name, member_ids }, uid) {
    const id = randomUUID();
    const t = iso(Date.now());
    const conv = { id, name: group_name, description: null, avatar_url: null, created_by: uid, created_at: t, updated_at: t, last_message_at: t };
    db.conversations.push(conv);
    [uid, ...member_ids.filter(x => x !== uid)].forEach((m, i) => {
      const row = { conversation_id: id, user_id: m, role: i === 0 ? 'admin' : 'member', joined_at: t, last_read_at: t, muted: false };
      db.conversation_members.push(row);
      emitChange('conversation_members', 'INSERT', row);
    });
    return id;
  }
};

// ---------------------------------------------------------------------------
// Query endpoint
// ---------------------------------------------------------------------------
function defaults(table, row, uid) {
  const t = iso(Date.now());
  if (table === 'messages') {
    if (row.client_id && db.messages.some(m => m.sender_id === row.sender_id && m.client_id === row.client_id)) {
      const err = new Error('duplicate key value violates unique constraint "messages_client_id_key"');
      err.code = '23505';
      throw err;
    }
    if (row.sender_id !== uid) throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
    if (row.group_id && !isMember(row.group_id, uid)) throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
    return msgRow({ ...row, created_at: t });
  }
  if (table === 'calls') return { id: randomUUID(), status: 'ringing', created_at: t, answered_at: null, ended_at: null, ...row, caller_id: uid };
  if (table === 'message_reactions') return { id: randomUUID(), created_at: t, ...row };
  return { id: row.id ?? randomUUID(), created_at: t, ...row };
}

function runQuery(q, uid) {
  const table = q.table;
  if (!db[table]) db[table] = [];
  const rows = db[table];
  if (q.op === 'select') {
    let out = applyFilters(rows.filter(r => visible(table, r, uid)), q.filters);
    if (q.order) {
      const { col, ascending } = q.order;
      out = [...out].sort((a, b) => (String(a[col] ?? '')).localeCompare(String(b[col] ?? '')) * (ascending ? 1 : -1));
    }
    const count = out.length;
    if (q.limit) out = out.slice(0, q.limit);
    out = out.map(r => strip(table, r));
    if (q.head) return { data: null, count };
    return { data: out, count };
  }
  if (q.op === 'insert' || q.op === 'upsert') {
    const input = Array.isArray(q.values) ? q.values : [q.values];
    const result = [];
    for (const v of input) {
      if (q.op === 'upsert') {
        const keys = (q.onConflict || 'id').split(',');
        const existing = rows.find(r => keys.every(k => String(r[k]) === String(v[k])));
        if (existing) {
          const old = { ...existing };
          Object.assign(existing, v);
          emitChange(table, 'UPDATE', existing, old);
          result.push(existing);
          continue;
        }
      }
      if (table === 'follows' && rows.some(r => r.follower_id === v.follower_id && r.following_id === v.following_id)) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      const row = defaults(table, v, uid);
      rows.push(row);
      emitChange(table, 'INSERT', row);
      result.push(row);
    }
    return { data: q.single ? strip(table, result[0]) : result.map(r => strip(table, r)) };
  }
  if (q.op === 'update') {
    const targets = applyFilters(rows.filter(r => visible(table, r, uid)), q.filters);
    targets.forEach(r => {
      const old = { ...r };
      const vals = { ...q.values };
      if (table === 'messages' && r.sender_id !== uid) {
        // recipients may only touch delivery fields (like the database trigger)
        for (const k of Object.keys(vals)) if (!['status', 'is_read', 'read_at', 'delivered_at'].includes(k)) delete vals[k];
      }
      Object.assign(r, vals);
      emitChange(table, 'UPDATE', r, old);
    });
    return { data: q.single ? strip(table, targets[0]) : targets.map(r => strip(table, r)) };
  }
  if (q.op === 'delete') {
    const targets = applyFilters(rows.filter(r => visible(table, r, uid)), q.filters);
    targets.forEach(r => {
      rows.splice(rows.indexOf(r), 1);
      emitChange(table, 'DELETE', null, r);
    });
    return { data: targets };
  }
  throw new Error(`Unsupported op ${q.op}`);
}

// ---------------------------------------------------------------------------
// Storage (in memory)
// ---------------------------------------------------------------------------
const objects = new Map(); // bucket/path -> { type, body }

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
}
function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
const uidOf = req => String(req.headers.authorization || '').replace(/^Bearer\s+/, '').split(':')[0] || null;

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();
  const url = new URL(req.url, 'http://x');
  const uid = uidOf(req);
  try {
    if (url.pathname === '/fake/auth/login') {
      const { email, password } = JSON.parse(await readBody(req));
      const user = db.users.find(u => u.email === email);
      if (!user || password !== PASSWORD) return json(res, 400, { error: 'Invalid login credentials' });
      return json(res, 200, { access_token: `${user.id}:token`, user: { id: user.id, email: user.email, user_metadata: { full_name: user.name } } });
    }
    if (url.pathname === '/auth/v1/user') {
      const user = db.users.find(u => u.id === uid);
      return user ? json(res, 200, { id: user.id, email: user.email }) : json(res, 401, { error: 'bad token' });
    }
    if (url.pathname === '/fake/query') {
      const q = JSON.parse(await readBody(req));
      return json(res, 200, runQuery(q, uid));
    }
    if (url.pathname.startsWith('/fake/rpc/')) {
      const fn = url.pathname.split('/').pop();
      const args = JSON.parse((await readBody(req)).toString() || '{}');
      if (!rpc[fn]) return json(res, 404, { error: 'no such function' });
      return json(res, 200, { data: rpc[fn](args, uid) });
    }
    if (url.pathname === '/fake/events') {
      const id = randomUUID();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': hello\n\n');
      const euid = url.searchParams.get('uid');
      clients.set(id, { res, uid: euid });
      req.on('close', () => {
        clients.delete(id);
        presence.forEach((map, channel) => {
          if (map.delete(euid)) emitPresence(channel);
        });
      });
      return;
    }
    if (url.pathname === '/fake/broadcast') {
      const msg = JSON.parse(await readBody(req));
      for (const c of clients.values()) push(c, { kind: 'broadcast', ...msg });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/fake/presence') {
      const { channel, key, state, leave } = JSON.parse(await readBody(req));
      if (!presence.has(channel)) presence.set(channel, new Map());
      if (leave) presence.get(channel).delete(key);
      else presence.get(channel).set(key, state);
      emitPresence(channel);
      return json(res, 200, { ok: true });
    }
    // Storage upload used by the app's XHR uploader
    if (url.pathname.startsWith('/storage/v1/object/') && req.method === 'POST') {
      const key = decodeURIComponent(url.pathname.slice('/storage/v1/object/'.length));
      const [, owner] = key.split('/');
      if (owner !== uid) return json(res, 403, { message: 'new row violates row-level security policy' });
      objects.set(key, { type: req.headers['content-type'], body: await readBody(req) });
      return json(res, 200, { Key: key });
    }
    if (url.pathname.startsWith('/fake/storage/')) {
      const key = decodeURIComponent(url.pathname.slice('/fake/storage/'.length));
      const o = objects.get(key);
      if (!o) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': o.type || 'application/octet-stream', 'Content-Length': o.body.length });
      return res.end(o.body);
    }
    // keepalive PATCH from markOfflineOnExit
    if (url.pathname === '/rest/v1/users' && req.method === 'PATCH') {
      const id = (url.searchParams.get('id') || '').replace('eq.', '');
      const u = db.users.find(x => x.id === id && id === uid);
      if (u) Object.assign(u, JSON.parse(await readBody(req)));
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/fake/state') {
      return json(res, 200, { messages: db.messages.length, calls: db.calls, reactions: db.message_reactions.length, groups: db.conversations.length });
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 400, { error: err.message, code: err.code });
  }
});

server.listen(PORT, () => console.log(`fake supabase on :${PORT}`));
