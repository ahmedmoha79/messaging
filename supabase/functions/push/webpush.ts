// Web Push with nothing but Web Crypto (works in Deno and Node 20+).
//   * RFC 8291 message encryption (aes128gcm content coding, RFC 8188)
//   * RFC 8292 VAPID authentication (ES256 JWT)
// Kept dependency-free so the push function starts fast and has no supply chain.

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/** A new VAPID key pair: public = 65-byte uncompressed point, private = 32-byte scalar, both base64url. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const pub = concat(new Uint8Array([4]), b64urlDecode(jwk.x!), b64urlDecode(jwk.y!));
  return { publicKey: b64urlEncode(pub), privateKey: jwk.d! };
}

async function vapidSigningKey(publicKey: string, privateKey: string): Promise<CryptoKey> {
  const pub = b64urlDecode(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be an uncompressed P-256 point');
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), d: privateKey, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

/** The signed JWT for one push service origin (RFC 8292). Valid for 12 hours. */
export async function vapidJwt(endpoint: string, subject: string, publicKey: string, privateKey: string, now = Date.now()): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const unsigned = `${header}.${claims}`;
  const key = await vapidSigningKey(publicKey, privateKey);
  // Web Crypto returns ECDSA signatures as raw r||s (64 bytes), which is what JWT ES256 needs.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return `${unsigned}.${b64urlEncode(sig)}`;
}

/**
 * Encrypts a payload for one browser subscription (RFC 8291, aes128gcm).
 * `salt` and `serverKeys` can be passed in for testing; normally they are random.
 */
export async function encryptPayload(
  payload: Uint8Array,
  p256dh: string,
  authSecret: string,
  options: { salt?: Uint8Array; serverKeys?: CryptoKeyPair } = {}
): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(p256dh);
  const auth = b64urlDecode(authSecret);
  if (uaPublic.length !== 65) throw new Error('subscription p256dh must be 65 bytes');
  if (auth.length < 16) throw new Error('subscription auth secret must be 16 bytes');

  const serverKeys = options.serverKeys ||
    (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, serverKeys.privateKey, 256));

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(auth, ecdhSecret, keyInfo, 32);

  const salt = options.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // single record: payload followed by the 0x02 "last record" delimiter
  const plaintext = concat(payload, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));

  // header: salt(16) | record size (uint32 BE) | key id length | key id (= as_public)
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushResult {
  endpoint: string;
  status: number;
  gone: boolean;
  error?: string;
}

/** Sends one push message. `gone` = the browser unsubscribed; delete that subscription. */
export async function sendPush(
  sub: PushSubscriptionRow,
  data: unknown,
  vapid: { publicKey: string; privateKey: string; subject: string },
  { ttl = 3600, urgency = 'normal', topic }: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string } = {}
): Promise<PushResult> {
  try {
    const body = await encryptPayload(enc.encode(JSON.stringify(data)), sub.p256dh, sub.auth);
    const jwt = await vapidJwt(sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey);
    const headers: Record<string, string> = {
      TTL: String(ttl),
      Urgency: urgency,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`
    };
    // Topic replaces an undelivered message with the same topic (e.g. ringing → missed)
    if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
    const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 200);
    return { endpoint: sub.endpoint, status: res.status, gone: res.status === 404 || res.status === 410, error: text || undefined };
  } catch (err) {
    return { endpoint: sub.endpoint, status: 0, gone: false, error: String((err as Error)?.message || err) };
  }
}
