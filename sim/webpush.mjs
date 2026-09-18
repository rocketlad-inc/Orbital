// ============================================================
// WEB PUSH CRYPTO — does the envelope actually open?
//
// Push encryption fails silently by design: the push service moves an
// opaque blob and reports 201 whether or not the browser can read it.
// Get a single HKDF step wrong and every notification is delivered and
// discarded, and the only symptom is players saying "I get nothing".
//
// So this does not assert on shapes. It plays the BROWSER's half:
// generates a real subscription keypair, has worker/webpush.js encrypt
// to it, and decrypts with the private key. If the message comes back
// out, the derivation is right end to end.
//
// Run: node sim/webpush.mjs
// ============================================================

import {
  encryptPayload, decryptPayload, vapidAuthHeader, vapidJwk,
  b64urlToBytes, bytesToB64url,
} from '../worker/webpush.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

// ---- stand in for a browser's PushManager.subscribe() --------------
async function makeSubscription() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return {
    p256dh: bytesToB64url(raw),
    auth: bytesToB64url(crypto.getRandomValues(new Uint8Array(16))),
    privateJwk: jwk,
  };
}

// ---- a VAPID keypair, the way the generator script makes one -------
async function makeVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: bytesToB64url(raw), privateKey: jwk.d };
}

// ============ the round trip ============
const sub = await makeSubscription();
const message = JSON.stringify({
  title: 'Tritalowda accepted your offer',
  body: '500 metal for 300 credits — the lane is flying.',
  url: '/',
  tag: 'trade:abc',
});

const body = await encryptPayload(sub.p256dh, sub.auth, message);
check('the encrypted body carries an aes128gcm header', body.length > 21 && body[20] === 65,
  `len ${body.length}, idlen ${body[20]}`);
check('the record size is 4096', new DataView(body.buffer, body.byteOffset).getUint32(16) === 4096);

const out = await decryptPayload(sub.privateJwk, sub.p256dh, sub.auth, body);
check('THE BROWSER CAN READ IT — full round trip', out === message,
  `got ${JSON.stringify(out).slice(0, 120)}`);

// Two messages to the same subscriber must not reuse a salt or an
// ephemeral key; identical ciphertext would mean the nonce repeated,
// which is the one fatal mistake in AES-GCM.
const body2 = await encryptPayload(sub.p256dh, sub.auth, message);
const sameSalt = body.slice(0, 16).every((b, i) => b === body2[i]);
const sameKey = body.slice(21, 86).every((b, i) => b === body2[21 + i]);
check('every message gets a fresh salt', !sameSalt);
check('every message gets a fresh ephemeral key', !sameKey);

// The wrong subscriber must not be able to open it.
const other = await makeSubscription();
let refused = false;
try {
  await decryptPayload(other.privateJwk, other.p256dh, other.auth, body);
} catch { refused = true; }
check('another subscriber cannot decrypt it', refused);

// ============ VAPID ============
const vapid = await makeVapid();
const env = {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'https://orbital-empire.com',
};
const header = await vapidAuthHeader(env, 'https://fcm.googleapis.com/fcm/send/abc123');
check('the header is a vapid t=..., k=... pair', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(header), header.slice(0, 60));

const jwt = header.slice('vapid t='.length, header.indexOf(', k='));
const [h64, p64, s64] = jwt.split('.');
const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p64)));
check('audience is the push service ORIGIN, not the endpoint',
  claims.aud === 'https://fcm.googleapis.com', claims.aud);
check('it expires, and within a day', claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400);
check('it carries a contact subject', typeof claims.sub === 'string' && claims.sub.length > 0);

// The push service verifies this signature; if it does not check out,
// every push is rejected with a 401 and nothing says why.
const pubKey = await crypto.subtle.importKey(
  'raw', b64urlToBytes(vapid.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
);
const verified = await crypto.subtle.verify(
  { name: 'ECDSA', hash: 'SHA-256' }, pubKey,
  b64urlToBytes(s64), new TextEncoder().encode(`${h64}.${p64}`),
);
check('THE SIGNATURE VERIFIES against the VAPID public key', verified);

const tampered = `${h64}.${p64}`.replace(/.$/, 'X');
const badVerify = await crypto.subtle.verify(
  { name: 'ECDSA', hash: 'SHA-256' }, pubKey, b64urlToBytes(s64), new TextEncoder().encode(tampered),
);
check('a tampered token does not verify', !badVerify);

// A malformed public key must fail loudly at config time, not on the
// first push of a live game.
let threw = false;
try { vapidJwk(bytesToB64url(new Uint8Array(10)), vapid.privateKey); } catch { threw = true; }
check('a short VAPID public key is rejected', threw);

console.log(bad === 0 ? '\nALL WEB-PUSH CRYPTO CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
