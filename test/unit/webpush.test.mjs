// Verifies the Web Push encryption by decrypting it as a browser would, using
// Node's own crypto module (an implementation independent of the sender's
// Web Crypto code), and checks the VAPID JWT signature.
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { encryptPayload, vapidJwt, generateVapidKeys, b64urlEncode, b64urlDecode } from '../../supabase/functions/push/webpush.ts';

function hkdf(salt, ikm, info, len) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
}

// --- a "browser" subscription
const ua = crypto.createECDH('prime256v1');
ua.generateKeys();
const uaPublic = ua.getPublicKey(); // 65 bytes uncompressed
const authSecret = crypto.randomBytes(16);

const payload = { kind: 'call', title: 'Mutale Banda', body: 'Incoming video call', callId: 'abc', emoji: '📞 ✓' };
const body = await encryptPayload(new TextEncoder().encode(JSON.stringify(payload)), b64urlEncode(uaPublic), b64urlEncode(authSecret));

// --- decrypt as the browser (RFC 8291 / RFC 8188)
const buf = Buffer.from(body);
const salt = buf.subarray(0, 16);
const rs = buf.readUInt32BE(16);
const idlen = buf[20];
const asPublic = buf.subarray(21, 21 + idlen);
const ciphertext = buf.subarray(21 + idlen);
assert.equal(rs, 4096, 'record size');
assert.equal(idlen, 65, 'key id is the sender public key');

const ecdhSecret = ua.computeSecret(asPublic);
const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
const tag = ciphertext.subarray(ciphertext.length - 16);
const dec = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
dec.setAuthTag(tag);
const plain = Buffer.concat([dec.update(ciphertext.subarray(0, ciphertext.length - 16)), dec.final()]);
assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
const decoded = JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
assert.deepEqual(decoded, payload);
console.log('✓ payload decrypts with an independent implementation');

// tampering is detected
const bad = Buffer.from(body); bad[bad.length - 1] ^= 1;
assert.throws(() => {
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(bad.subarray(bad.length - 16));
  d.update(bad.subarray(21 + idlen, bad.length - 16)); d.final();
});
console.log('✓ tampered messages are rejected');

// --- VAPID
const { publicKey, privateKey } = await generateVapidKeys();
assert.equal(b64urlDecode(publicKey).length, 65);
assert.equal(b64urlDecode(privateKey).length, 32);
const jwt = await vapidJwt('https://fcm.googleapis.com/fcm/send/xyz', 'mailto:push@wazambi.app', publicKey, privateKey);
const [h, c, s] = jwt.split('.');
const claims = JSON.parse(Buffer.from(b64urlDecode(c)).toString());
assert.equal(claims.aud, 'https://fcm.googleapis.com');
assert.equal(JSON.parse(Buffer.from(b64urlDecode(h)).toString()).alg, 'ES256');
assert.ok(claims.exp > Date.now() / 1000 + 11 * 3600);
const pub = b64urlDecode(publicKey);
const verifyKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33)) }, format: 'jwk' });
const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(b64urlDecode(s)));
assert.ok(ok, 'JWT signature verifies with the public key');
console.log('✓ VAPID JWT is signed correctly (ES256, aud = push service origin)');
