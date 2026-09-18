// ============================================================
// PUSH FAN-OUT — one event, two transports, no double-silencing.
//
// The risk this pins: notify.sendDm now reaches Discord AND the phone.
// Both read the same per-category preferences but must NOT share a
// dedupe claim, or whichever fired first would silence the other — and
// the symptom is "I only ever get one of them", which nobody reports
// because they cannot see what they did not receive.
//
// Drives the real routes in worker/push.js and the real sendDm in
// worker/notify.js, with fetch stubbed at the push service.
//
// Run: node sim/pushFanout.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

// ---- a VAPID pair, so the real crypto runs ------------------------
const vapidKp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const vapidPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', vapidKp.publicKey));
const vapidJwk = await crypto.subtle.exportKey('jwk', vapidKp.privateKey);
const b64url = (bytes) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// ---- a browser subscription --------------------------------------
async function device() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return {
    p256dh: b64url(raw),
    auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
  };
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = {
  DB,
  VAPID_PUBLIC_KEY: b64url(vapidPubRaw),
  VAPID_PRIVATE_KEY: vapidJwk.d,
  VAPID_SUBJECT: 'https://orbital-empire.com',
  // No Discord token: proves the phone is reached even when Discord is
  // entirely absent, which is the case for most players.
};

await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();

// ---- stub the push service ---------------------------------------
let delivered = [];
let nextStatus = 201;
globalThis.fetch = async (url, init) => {
  delivered.push({ url: String(url), headers: init.headers, bytes: init.body?.length ?? 0 });
  return new Response(null, { status: nextStatus });
};

const push = await import('../worker/push.js');
const notify = await import('../worker/notify.js');

const call = async (method, path, userId, body) => {
  for (const r of push.routes) {
    if (r.method !== method) continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    const req = { json: async () => body ?? {}, headers: new Map([['user-agent', 'sim']]) };
    const res = await r.handle(req, env, { params: m.groups ?? {}, session: { user_id: userId } });
    return { status: res.status, body: JSON.parse((await res.text()) || '{}') };
  }
  throw new Error(`no route ${method} ${path}`);
};

// ---- subscribing --------------------------------------------------
const d1 = await device();
let r = await call('GET', '/api/push/key', 'uA');
check('the public key is served to the client', r.status === 200 && r.body.key === env.VAPID_PUBLIC_KEY);

r = await call('POST', '/api/push/subscribe', 'uA', { endpoint: 'http://insecure/x', keys: d1 });
check('an http endpoint is refused', r.status === 400, JSON.stringify(r.body));

r = await call('POST', '/api/push/subscribe', 'uA', { endpoint: 'https://push.example/a1', keys: d1 });
check('a device registers', r.status === 200, JSON.stringify(r.body));

const d2 = await device();
await call('POST', '/api/push/subscribe', 'uA', { endpoint: 'https://push.example/a2', keys: d2 });
let n = (await DB.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE user_id='uA'").first()).n;
check('a second device is a second row — both should ring', n === 2, String(n));

// Re-subscribing the same browser must update, not duplicate.
await call('POST', '/api/push/subscribe', 'uA', { endpoint: 'https://push.example/a1', keys: d1 });
n = (await DB.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE user_id='uA'").first()).n;
check('re-subscribing the same device does not duplicate it', n === 2, String(n));

// The same phone, a different player signing in.
await call('POST', '/api/push/subscribe', 'uB', { endpoint: 'https://push.example/a1', keys: d1 });
const owner = (await DB.prepare("SELECT user_id FROM push_subscriptions WHERE endpoint='https://push.example/a1'").first()).user_id;
check('a shared device follows whoever signed in last', owner === 'uB', owner);
await call('POST', '/api/push/subscribe', 'uA', { endpoint: 'https://push.example/a1', keys: d1 });

r = await call('POST', '/api/push/unsubscribe', 'uB', { endpoint: 'https://push.example/a2' });
n = (await DB.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE user_id='uA'").first()).n;
check('you cannot unsubscribe somebody else’s device', n === 2, String(n));

// ---- delivery ------------------------------------------------------
delivered = [];
let res = await push.pushToUser(env, {
  userId: 'uA', category: 'dm', dedupeKey: 'trade:1',
  embed: { title: 'Wu Tang **accepted**', description: 'The lane is _flying_.' },
  url: '/',
});
check('it reaches every device the player has', res.sent && delivered.length === 2, JSON.stringify(res));
check('encrypted with aes128gcm and a VAPID token',
  delivered[0].headers['content-encoding'] === 'aes128gcm' && /^vapid t=/.test(delivered[0].headers.authorization),
  JSON.stringify(delivered[0].headers));
check('the body is a non-trivial ciphertext', delivered[0].bytes > 90, String(delivered[0].bytes));

// ---- dedupe is per transport ---------------------------------------
delivered = [];
res = await push.pushToUser(env, { userId: 'uA', category: 'dm', dedupeKey: 'trade:1', embed: { title: 'again' } });
check('the same event does not push twice', !res.sent && res.reason === 'already_sent' && delivered.length === 0, JSON.stringify(res));

// The Discord side claims the UNPREFIXED key. If the two shared a claim,
// this push would be swallowed.
await DB.prepare(
  `INSERT INTO notification_log (user_id, game_id, category, dedupe_key, ok, created_ms)
   VALUES ('uA', NULL, 'dm', 'trade:2', 1, 0)`).run();
delivered = [];
res = await push.pushToUser(env, { userId: 'uA', category: 'dm', dedupeKey: 'trade:2', embed: { title: 'phone still rings' } });
check('a Discord DM already sent does NOT silence the phone', res.sent && delivered.length === 2, JSON.stringify(res));

// ---- preferences are shared ----------------------------------------
await DB.prepare(
  `INSERT INTO notification_prefs (user_id, category, enabled, updated_ms) VALUES ('uA','senate',0,0)`).run();
delivered = [];
res = await push.pushToUser(env, { userId: 'uA', category: 'senate', embed: { title: 'vote closing' } });
check('muting a category mutes the phone too', !res.sent && res.reason === 'opted_out' && delivered.length === 0, JSON.stringify(res));

// ---- dead subscriptions are reaped ---------------------------------
nextStatus = 410;
delivered = [];
res = await push.pushToUser(env, { userId: 'uA', category: 'dm', embed: { title: 'gone' } });
n = (await DB.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE user_id='uA'").first()).n;
check('a 410 deletes the subscription rather than retrying forever', n === 0 && res.removed === 2, `${n} left, ${JSON.stringify(res)}`);

// A transient failure must NOT unsubscribe anybody.
await call('POST', '/api/push/subscribe', 'uA', { endpoint: 'https://push.example/a3', keys: d1 });
nextStatus = 500;
await push.pushToUser(env, { userId: 'uA', category: 'dm', embed: { title: 'server hiccup' } });
const row = await DB.prepare("SELECT fail_count FROM push_subscriptions WHERE endpoint='https://push.example/a3'").first();
check('a 500 is counted, not fatal', !!row && row.fail_count === 1, JSON.stringify(row));
nextStatus = 201;

// ---- the fan-out from sendDm ---------------------------------------
delivered = [];
const out = await notify.sendDm(env, {
  userId: 'uA', category: 'dm', dedupeKey: 'fan:1',
  embed: { title: 'Offer from Stonekin', description: '500 metal for 300 credits' },
});
check('sendDm pushes even with Discord switched off entirely', out.pushed === true && delivered.length === 1, JSON.stringify(out));
check('...and still reports DISCORD in .sent, which three bot commands read',
  out.sent === false && out.reason === 'no_bot_token', JSON.stringify(out));

// A player with no devices is simply not pushed; nothing throws.
delivered = [];
const none = await notify.sendDm(env, { userId: 'uB', category: 'dm', embed: { title: 'nobody home' } });
check('a player with no device is a quiet no-op', none.pushed === false && delivered.length === 0, JSON.stringify(none));

console.log(bad === 0 ? '\nALL PUSH FAN-OUT CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
