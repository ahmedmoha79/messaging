// WAZAMBI push notifications.
//
// Called by database triggers (via pg_net) when a call rings or ends, a
// message arrives, or a job needs someone's attention. Looks up who should
// be told, and sends Web Push messages to their phones and computers.
//
// Also handles two requests from browsers:
//   {type:'init'}                    → returns the VAPID public key (creating the key pair once)
//   {type:'decline', id, token}      → the "Decline" button on a call notification
import { generateVapidKeys, sendPush, type PushSubscriptionRow } from './webpush.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUBJECT = 'mailto:push@wazambi.app';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// Database access with the service key (row-level security does not apply here,
// so every query below is written to fetch only what the notification needs).
// ---------------------------------------------------------------------------
async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  if (!res.ok) throw new Error(`${path.split('?')[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const rpc = (fn: string, args: Record<string, unknown> = {}) => rest(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
const one = async (path: string) => (await rest(path))?.[0] ?? null;
const inList = (ids: string[]) => `(${ids.map(encodeURIComponent).join(',')})`;

let cachedConfig: { hook: string; public: string | null; private: string | null; at: number } | null = null;
async function config(force = false) {
  if (!force && cachedConfig && Date.now() - cachedConfig.at < 5 * 60 * 1000) return cachedConfig;
  const c = await rpc('push_config');
  cachedConfig = { ...c, at: Date.now() };
  return cachedConfig!;
}

async function ensureVapid() {
  let c = await config();
  if (c.public && c.private) return c;
  const keys = await generateVapidKeys();
  try {
    await rpc('push_init_vapid', { pub: keys.publicKey, priv: keys.privateKey });
  } catch {
    /* another request created them first */
  }
  c = await config(true);
  return c;
}

async function hmac(secret: string, text: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
async function subscriptionsFor(userIds: string[]): Promise<(PushSubscriptionRow & { id: string; user_id: string })[]> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return [];
  return rest(`push_subscriptions?select=id,user_id,endpoint,p256dh,auth&user_id=in.${inList(ids)}`);
}

async function deliver(userIds: string[], data: Record<string, unknown>, opts: { ttl?: number; urgency?: 'normal' | 'high'; topic?: string } = {}) {
  const c = await ensureVapid();
  const subs = await subscriptionsFor(userIds);
  const results = await Promise.all(subs.map(s => sendPush(s, data, { publicKey: c.public!, privateKey: c.private!, subject: SUBJECT }, opts)));
  const gone = results.filter(r => r.gone).map(r => r.endpoint);
  if (gone.length) {
    await rest(`push_subscriptions?endpoint=in.${inList(gone.map(e => `"${e.replace(/"/g, '')}"`))}`, { method: 'DELETE' }).catch(() => {});
  }
  const ok = results.filter(r => r.status >= 200 && r.status < 300).map(r => r.endpoint);
  if (ok.length) {
    await rest(`push_subscriptions?endpoint=in.${inList(ok.map(e => `"${e.replace(/"/g, '')}"`))}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_used_at: new Date().toISOString() })
    }).catch(() => {});
  }
  return { sent: ok.length, removed: gone.length, failed: results.filter(r => !r.gone && (r.status < 200 || r.status >= 300)).map(r => ({ status: r.status, error: r.error })) };
}

const firstName = (name?: string | null) => (name || 'Someone').trim().split(/\s+/)[0];

function preview(m: Record<string, string | null>) {
  switch (m.message_type) {
    case 'audio': return 'Voice message';
    case 'image': return m.content && m.content !== 'Photo' ? `Photo: ${m.content}` : 'Photo';
    case 'video': return 'Video';
    case 'file': return m.attachment_name || 'File';
    default: return (m.content || '').slice(0, 160);
  }
}

async function onCall(id: string) {
  const call = await one(`calls?id=eq.${id}&select=id,caller_id,callee_id,kind,status,answered_at`);
  if (!call) return { skipped: 'not found' };
  const caller = await one(`users?id=eq.${call.caller_id}&select=name,avatar_url`);
  const what = call.kind === 'video' ? 'video call' : 'voice call';
  const tag = `call-${call.id}`;
  if (call.status === 'ringing') {
    const c = await config();
    return deliver([call.callee_id], {
      kind: 'call',
      callId: call.id,
      title: caller?.name || 'Incoming call',
      body: `Incoming ${what}`,
      icon: caller?.avatar_url || undefined,
      tag,
      url: `/app#/call/${call.id}`,
      declineUrl: `${SUPABASE_URL}/functions/v1/push`,
      declineToken: await hmac(c.hook, `decline:${call.id}`)
    }, { ttl: 45, urgency: 'high', topic: tag });
  }
  if (['missed', 'cancelled', 'busy'].includes(call.status) && !call.answered_at) {
    return deliver([call.callee_id], {
      kind: 'call-ended',
      callId: call.id,
      title: caller?.name || 'Missed call',
      body: `Missed ${what}`,
      tag,
      url: '/app#/calls'
    }, { ttl: 86400, urgency: 'normal', topic: tag });
  }
  // answered or declined: clear the ringing notification everywhere
  return deliver([call.callee_id], { kind: 'call-close', callId: call.id, tag }, { ttl: 60, urgency: 'high', topic: tag });
}

async function onMessage(id: string) {
  const m = await one(`messages?id=eq.${id}&select=id,sender_id,receiver_id,group_id,content,message_type,attachment_name`);
  if (!m) return { skipped: 'not found' };
  const sender = await one(`users?id=eq.${m.sender_id}&select=name,avatar_url`);
  if (m.group_id) {
    const group = await one(`conversations?id=eq.${m.group_id}&select=name`);
    const members = await rest(`conversation_members?conversation_id=eq.${m.group_id}&muted=eq.false&select=user_id`);
    return deliver(members.map((r: { user_id: string }) => r.user_id).filter((u: string) => u !== m.sender_id), {
      kind: 'message',
      title: group?.name || 'Group',
      body: `${firstName(sender?.name)}: ${preview(m)}`,
      tag: `chat-g-${m.group_id}`,
      url: `/app#/chat/g/${m.group_id}`
    }, { ttl: 86400 });
  }
  return deliver([m.receiver_id], {
    kind: 'message',
    title: sender?.name || 'New message',
    body: preview(m),
    icon: sender?.avatar_url || undefined,
    tag: `chat-u-${m.sender_id}`,
    url: `/app#/chat/u/${m.sender_id}`
  }, { ttl: 86400 });
}

async function onJobEvent(id: string) {
  const e = await one(`job_events?id=eq.${id}&select=id,job_id,kind,message,meta,actor_id`);
  if (!e) return { skipped: 'not found' };
  const job = await one(`jobs?id=eq.${e.job_id}&select=id,ref,title,org_id,driver_id,customer_name,pickup_name,dropoff_name`);
  if (!job) return { skipped: 'job not found' };
  const url = `/app#/jobs/${job.id}`;
  if (e.kind === 'customer_message') {
    const staff = await rest(`org_members?org_id=eq.${job.org_id}&role=in.(owner,admin,dispatcher)&select=user_id`);
    return deliver(staff.map((r: { user_id: string }) => r.user_id), {
      kind: 'job',
      title: `${job.ref} · ${job.customer_name || 'Customer'}`,
      body: `${e.meta?.name || 'Customer'}: ${(e.message || '').slice(0, 160)}`,
      tag: `job-${job.id}`,
      url
    }, { ttl: 86400, urgency: 'high' });
  }
  if (e.kind === 'assigned') {
    const driver = e.meta?.driver_id;
    if (!driver || driver === e.actor_id) return { skipped: 'self-assigned' };
    const route = [job.pickup_name, job.dropoff_name].filter(Boolean).join(' → ');
    return deliver([driver], {
      kind: 'job',
      title: `New job ${job.ref}`,
      body: route ? `${job.title}: ${route}` : job.title,
      tag: `job-${job.id}`,
      url
    }, { ttl: 86400, urgency: 'high' });
  }
  return { skipped: e.kind };
}

// ---------------------------------------------------------------------------
Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: Record<string, string> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'JSON body required' }, 400);
  }

  try {
    if (body.type === 'init') {
      const c = await ensureVapid();
      return json({ publicKey: c.public });
    }

    if (body.type === 'decline') {
      const c = await config();
      const expected = await hmac(c.hook, `decline:${body.id}`);
      if (!/^[0-9a-f-]{36}$/i.test(body.id || '') || !safeEqual(expected, body.token || '')) return json({ error: 'invalid token' }, 403);
      await rest(`calls?id=eq.${body.id}&status=eq.ringing`, { method: 'PATCH', body: JSON.stringify({ status: 'declined' }) });
      return json({ ok: true });
    }

    const c = await config();
    if (!safeEqual(req.headers.get('x-hook-secret') || '', c.hook)) return json({ error: 'forbidden' }, 403);
    if (!/^[0-9a-f-]{1,40}$/i.test(String(body.id || ''))) return json({ error: 'bad id' }, 400);

    let result;
    if (body.type === 'call') result = await onCall(body.id);
    else if (body.type === 'message') result = await onMessage(body.id);
    else if (body.type === 'job_event') result = await onJobEvent(body.id);
    else return json({ error: 'unknown type' }, 400);
    return json({ ok: true, ...result });
  } catch (err) {
    console.error('push failed', body?.type, body?.id, err);
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
