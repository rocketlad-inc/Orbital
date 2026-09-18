// ============================================================
// gen-vapid-keys — the application server identity for web push.
//
//   node scripts/gen-vapid-keys.mjs
//
// Prints a P-256 keypair in the base64url form RFC 8292 wants. Set them
// as worker secrets:
//
//   npx wrangler secret put VAPID_PUBLIC_KEY
//   npx wrangler secret put VAPID_PRIVATE_KEY
//   npx wrangler secret put VAPID_SUBJECT      # mailto: or https: contact
//
// RUN THIS ONCE, EVER. Every push subscription a browser creates is
// bound to the PUBLIC key it saw at subscribe time. Rotating the pair
// does not re-key existing subscriptions — it silently invalidates all
// of them, and every player has to turn notifications on again with no
// prompt telling them to. Treat the private key like the session secret.
//
// The public key is not a secret (it ships to every browser); it lives
// as a secret only so the pair stays together.
// ============================================================

const kp = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
);

const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);

const b64url = (bytes) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

console.log('VAPID_PUBLIC_KEY');
console.log(b64url(raw));
console.log();
console.log('VAPID_PRIVATE_KEY');
console.log(jwk.d);
console.log();
console.log('Set both with `npx wrangler secret put <NAME>`, then never run this again —');
console.log('a new pair silently invalidates every existing subscription.');
