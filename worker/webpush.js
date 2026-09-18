// ============================================================
// Web Push, implemented against WebCrypto.
//
// WHY NOT A LIBRARY. The `web-push` npm package is Node-shaped: it wants
// node:crypto, Buffer and streams, none of which a Cloudflare Worker
// has. The protocol is two RFCs and about a hundred lines, so it lives
// here rather than behind a polyfill stack.
//
//   RFC 8291  Message Encryption for Web Push  (aes128gcm)
//   RFC 8292  VAPID — how the server proves it is allowed to push
//
// HOW A PUSH ACTUALLY TRAVELS. The browser hands us an endpoint URL on
// its own vendor's service (for Chrome that is fcm.googleapis.com), plus
// two keys: p256dh, the subscriber's public ECDH key, and auth, a shared
// secret. We encrypt the payload so ONLY that browser can read it — the
// push service moves an opaque blob and cannot see the message. Then we
// sign a JWT with our VAPID key so the push service knows which
// application server is asking.
//
// This is why a push cannot be "faked" server-side and why losing the
// VAPID private key means every existing subscription must be rebuilt:
// subscriptions are bound to the public key they were created with.
// ============================================================

const enc = new TextEncoder();

// ---- base64url ----------------------------------------------------

export function b64urlToBytes(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) { out.set(a, at); at += a.length; }
  return out;
}

// ---- VAPID --------------------------------------------------------

/** An uncompressed P-256 point is 0x04 || X(32) || Y(32). WebCrypto will
 *  only import a private key as JWK, so the scalar and the point have to
 *  be taken apart and handed over as x/y/d. */
export function vapidJwk(publicKeyB64, privateKeyB64) {
  const pub = b64urlToBytes(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  return {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: privateKeyB64,
    ext: true,
  };
}

/**
 * The Authorization header for one push.
 *
 * `aud` is the ORIGIN of the endpoint, not the endpoint itself — a JWT
 * minted for one origin is rejected by another, which is what stops a
 * leaked token being replayed at a different push service.
 */
export async function vapidAuthHeader(env, endpoint, { ttlSeconds = 12 * 3600 } = {}) {
  const pubB64 = env.VAPID_PUBLIC_KEY;
  const privB64 = env.VAPID_PRIVATE_KEY;
  if (!pubB64 || !privB64) throw new Error('VAPID keys are not configured');

  const aud = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    // A contact the push service can reach if this server misbehaves.
    sub: env.VAPID_SUBJECT || 'https://orbital-empire.com',
  };
  const signingInput = `${bytesToB64url(enc.encode(JSON.stringify(header)))}`
    + `.${bytesToB64url(enc.encode(JSON.stringify(payload)))}`;

  const key = await crypto.subtle.importKey(
    'jwk', vapidJwk(pubB64, privB64),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  // WebCrypto returns the raw r||s pair, which is exactly what JWS wants
  // (a DER signature here would be rejected).
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput),
  ));
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${pubB64}`;
}

// ---- payload encryption (RFC 8291) --------------------------------

async function hkdf(salt, ikm, info, lengthBytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Encrypt `plaintext` for one subscription.
 *
 * Returns the aes128gcm body, whose header carries everything the
 * browser needs to derive the same key: the salt, the record size, and
 * our ephemeral public key. Exported so the round-trip test can decrypt
 * it — a push you cannot decrypt in a test is a push you find out about
 * from a player.
 */
export async function encryptPayload(p256dhB64, authB64, plaintext) {
  const uaPublic = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);

  // Our ephemeral keypair — new for every message, which is what makes
  // the exchange forward-secret.
  const asKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));

  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, asKeys.privateKey, 256,
  ));

  // Step one: mix the shared secret with the subscription's auth secret,
  // binding the key to BOTH parties' public keys.
  const keyInfo = concat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // Step two: the content key and nonce, salted per message.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  // 0x02 is the last-record delimiter. Orbital's payloads are one record
  // and far below the 4096 limit, so no further padding is added.
  const padded = concat(enc.encode(plaintext), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded,
  ));

  // Header: salt(16) | record size(4, big-endian) | key id length(1) | key id
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/** Decrypt a body produced by encryptPayload. TEST-ONLY — the server
 *  never receives pushes — but it is the only honest way to prove the
 *  encryption above is right without a real device in the loop. */
export async function decryptPayload(uaPrivateJwk, uaPublicB64, authB64, body) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const authSecret = b64urlToBytes(authB64);

  const uaPriv = await crypto.subtle.importKey(
    'jwk', uaPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'],
  );
  const asKey = await crypto.subtle.importKey(
    'raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: asKey }, uaPriv, 256,
  ));

  const uaPublic = b64urlToBytes(uaPublicB64);
  const keyInfo = concat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext,
  ));
  // Strip the delimiter and any padding behind it.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  return new TextDecoder().decode(padded.slice(0, end));
}

// ---- sending ------------------------------------------------------

/**
 * Deliver one notification.
 *
 * The return value distinguishes "gone" from "failed", because they need
 * opposite responses: a 404/410 means the browser threw the subscription
 * away (uninstalled, cleared data, revoked permission) and the row must
 * be deleted or we push at a dead endpoint forever. Anything else is
 * transient and the row stays.
 */
export async function sendPush(env, sub, payloadObject, { ttl = 12 * 3600, urgency = 'normal' } = {}) {
  try {
    const body = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(payloadObject));
    const auth = await vapidAuthHeader(env, sub.endpoint);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: auth,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(ttl),
        urgency,
      },
      body,
    });
    if (res.ok) return { ok: true };
    // 404/410: the subscription is dead and will never work again.
    if (res.status === 404 || res.status === 410) return { ok: false, gone: true, status: res.status };
    return { ok: false, gone: false, status: res.status, detail: await res.text().catch(() => '') };
  } catch (e) {
    console.error('web push failed', e);
    return { ok: false, gone: false, status: 0, detail: String(e?.message ?? e) };
  }
}
