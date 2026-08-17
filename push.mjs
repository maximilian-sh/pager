// Minimal Web Push sender: VAPID (RFC 8292) + aes128gcm (RFC 8291).
// Zero dependencies — everything comes from node:crypto's WebCrypto.

import { webcrypto as crypto } from 'node:crypto';

const { subtle } = crypto;

export const b64uDecode = (s) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export const b64uEncode = (b) =>
  Buffer.from(b).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(key, data) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await subtle.sign('HMAC', k, data));
}

// HKDF for outputs <= 32 bytes, which is all Web Push needs.
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, Buffer.concat([Buffer.from(info, 'binary'), Buffer.from([1])]));
  return okm.subarray(0, length);
}

export async function generateVapidKeys() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  const raw = await subtle.exportKey('raw', pair.publicKey);
  return { publicKey: b64uEncode(Buffer.from(raw)), privateKey: jwk.d };
}

async function vapidHeader(endpoint, subject, publicKey, privateKey, jwt) {
  // Ein fertiges JWT ist nur an Domain + exp gebunden, nicht an den Payload —
  // es lässt sich also wiederverwenden, solange es gültig ist.
  if (jwt) return `vapid t=${jwt}, k=${publicKey}`;

  const pub = b64uDecode(publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point (base64url)');
  }

  const key = await subtle.importKey('jwk', {
    kty: 'EC',
    crv: 'P-256',
    x: b64uEncode(pub.subarray(1, 33)),
    y: b64uEncode(pub.subarray(33, 65)),
    d: privateKey,
    ext: true,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  const header = b64uEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64uEncode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  }));

  const signature = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(`${header}.${claims}`),
  );

  return `vapid t=${header}.${claims}.${b64uEncode(Buffer.from(signature))}, k=${publicKey}`;
}

async function encrypt(p256dh, auth, payload) {
  const uaPublic = b64uDecode(p256dh);
  const authSecret = b64uDecode(auth);

  const asKeys = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = Buffer.from(await subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = Buffer.from(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  // RFC 8291 §3.4: the auth secret is the salt that mixes both public keys in.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'binary'), uaPublic, asPublic]);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
  const cek = await hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = await hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12);

  const aesKey = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 is the last-record delimiter; we always send exactly one record.
  const plaintext = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);
  const ciphertext = Buffer.from(await subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    aesKey,
    plaintext,
  ));

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);

  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

/**
 * @param {{endpoint: string, keys: {p256dh: string, auth: string}}} subscription
 * @param {string} payload - arbitrary string; the service worker decides how to read it
 * @param {{publicKey: string, privateKey: string, subject: string, ttl?: number, urgency?: string}} vapid
 */
export async function sendPush(subscription, payload, vapid) {
  const body = await encrypt(subscription.keys.p256dh, subscription.keys.auth, payload);
  const authorization = await vapidHeader(
    subscription.endpoint,
    vapid.subject,
    vapid.publicKey,
    vapid.privateKey,
    vapid.jwt,
  );

  const headers = {
    TTL: String(vapid.ttl ?? 60),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.length),
    Authorization: authorization,
  };
  if (vapid.urgency) headers.Urgency = vapid.urgency;

  const response = await fetch(subscription.endpoint, { method: 'POST', headers, body });

  return {
    ok: response.ok,
    status: response.status,
    apnsId: response.headers.get('apns-id'),
    body: await response.text(),
  };
}
