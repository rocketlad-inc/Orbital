// ============================================================
// COMBAT AND INBOUND ALERTS — once per event, not once per tick.
//
// THIS IS THE TEST THAT DECIDES WHETHER THESE ALERTS GET TO EXIST.
// Both categories were removed from the game once already, and not for
// a tuning miss: they bucketed on a 4-tick window, so they re-fired for
// as long as the situation lasted. A siege runs for dozens of ticks and
// a transit for twenty, so the player under real pressure — exactly the
// person the alert is for — got the most noise, and that is how a
// channel gets muted.
//
// So the assertion here is not "an alert fires". It is "an alert fires
// EXACTLY ONCE across forty ticks of a battle that never stops, and
// across a transit that stays inbound the whole way" — while a
// genuinely new battle at the same body still gets through.
//
// Drives the real runTickAlerts against a real migrated database, with
// the push service stubbed at fetch.
//
// Run: node sim/combatInboundAlerts.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

// ---- real VAPID + a real subscription, so the push path runs ------
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
const b64url = (bytes) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = {
  DB,
  VAPID_PUBLIC_KEY: b64url(pubRaw),
  VAPID_PRIVATE_KEY: jwk.d,
  VAPID_SUBJECT: 'https://orbital-empire.com',
  // No DISCORD_BOT_TOKEN on purpose: combat and inbound default to the
  // phone, and this proves they reach it with Discord entirely absent.
};

const G = 'g_alerts';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uDef','d@t','Defender','x',0), ('uAtk','a@t','Attacker','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                  VALUES (?, 'Alert Test','uDef',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at)
                  VALUES (?, 'active','s',100,0)`).bind(G).run();
await DB.prepare(`INSERT INTO game_factions (id,game_id,slot,name,color,status,joined_at,user_id)
                  VALUES ('fDef',?,0,'Defender','#fff','active',0,'uDef'),
                         ('fAtk',?,1,'Attacker','#f00','active',0,'uAtk')`).bind(G, G).run();
await DB.prepare(`INSERT INTO game_bodies (id,game_id,template_id,name,type,parent_body_id,radius,mu,color)
                  VALUES ('mars',?, 'mars','Mars','planet',NULL,10,50,'#c44')`).bind(G).run();
// The defender holds Mars, which is what makes a fleet heading there a threat.
await DB.prepare(`INSERT INTO game_settlements
                    (id,game_id,body_id,owner_faction_id,type,name,hp,hp_max,created_at_tick)
                  VALUES ('s1',?,'mars','fDef','city','Olympus',100,100,0)`).bind(G).run();

await DB.prepare(
  `INSERT INTO push_subscriptions (endpoint,user_id,p256dh,auth,user_agent,created_ms)
   VALUES ('https://push.example/def','uDef',?,?,'test',0)`,
).bind(b64url(uaRaw), b64url(crypto.getRandomValues(new Uint8Array(16)))).run();


/** game_ships carries a full orbit and a fuel tank, none of which this
 *  test cares about but all of which are NOT NULL. One helper so the
 *  cases below read as what they are about. */
async function hostileShip(id, name) {
  await DB.prepare(
    `INSERT INTO game_ships
       (id,game_id,owner_faction_id,name,ship_class,parent_body_id,
        orbit_rp,orbit_ra,orbit_omega,orbit_m0,orbit_epoch,fuel,fuel_max,built_at_tick,hp)
     VALUES (?,?,'fAtk',?,'frigate','mars', 1,1,0,0,0, 10,10, 0, 100)`,
  ).bind(id, G, name).run();
}
async function inboundNode(id, shipId, committedTick) {
  await DB.prepare(
    `INSERT INTO game_ship_nodes
       (id,game_id,ship_id,sequence,anchor_kind,target_body_id,scheduled_t,fuel_cost,status,committed_at_tick)
     VALUES (?,?,?,0,'encounter','mars',0,0,'in_transit',?)`,
  ).bind(id, G, shipId, committedTick).run();
}

// ---- stub the push service ---------------------------------------
let sent = [];
globalThis.fetch = async (url) => { sent.push(String(url)); return new Response(null, { status: 201 }); };

const alerts = await import('../worker/alerts.js');

const countFor = async (category) => (await DB
  .prepare('SELECT COUNT(*) AS n FROM notification_log WHERE category = ? AND dedupe_key LIKE ?')
  .bind(category, 'push:%').first()).n;

// ================================================================
// 1. A SIEGE THAT NEVER STOPS
// ================================================================
// One battle row, still firing every tick, for forty ticks. This is the
// exact shape that produced a DM every four hours in the old version.
await DB.prepare(
  `INSERT INTO battles (id,game_id,body_id,body_name,started_tick,last_fire_tick,started_at_ms,status)
   VALUES ('b_100_mars',?,'mars','Mars',100,100,0,'active')`,
).bind(G).run();
await DB.prepare(
  `INSERT INTO battle_participants (battle_id,ship_id,faction_id,ship_name,first_tick,last_tick)
   VALUES ('b_100_mars','sh1','fDef','Watchman',100,100), ('b_100_mars','sh2','fAtk','Raider',100,100)`,
).run();

for (let t = 100; t <= 140; t++) {
  // The battle is still live at every one of these ticks.
  await DB.prepare('UPDATE battles SET last_fire_tick = ? WHERE id = ?').bind(t, 'b_100_mars').run();
  await alerts.runTickAlerts(env, G, t);
}
const afterSiege = await countFor('combat');
check('a 40-tick siege notifies exactly once', afterSiege === 1, `got ${afterSiege}`);

// ---- ...but a genuinely NEW battle still gets through --------------
// Same body, later start tick, so a new battles row and a new id. The
// whole point of keying on the engagement rather than muting the body.
await DB.prepare(
  `INSERT INTO battles (id,game_id,body_id,body_name,started_tick,last_fire_tick,started_at_ms,status)
   VALUES ('b_200_mars',?,'mars','Mars',200,200,0,'active')`,
).bind(G).run();
await DB.prepare(
  `INSERT INTO battle_participants (battle_id,ship_id,faction_id,ship_name,first_tick,last_tick)
   VALUES ('b_200_mars','sh3','fDef','Watchman II',200,200), ('b_200_mars','sh4','fAtk','Raider II',200,200)`,
).run();
await DB.prepare("UPDATE battles SET status = 'ended' WHERE id = 'b_100_mars'").run();
await alerts.runTickAlerts(env, G, 200);
const afterSecond = await countFor('combat');
check('a separate battle at the same body DOES notify', afterSecond === 2, `got ${afterSecond}`);

// ================================================================
// 2. A LONG TRANSIT
// ================================================================
// Nine ships, one departure, twenty ticks in the air. The old version
// would have re-fired for every tick they stayed inbound; the new key is
// the departure, which happens once.
for (let i = 0; i < 9; i++) {
  await hostileShip(`atk${i}`, `Raider ${i}`);
  await inboundNode(`n${i}`, `atk${i}`, 210);
}

for (let t = 210; t <= 230; t++) await alerts.runTickAlerts(env, G, t);
const afterWave = await countFor('inbound');
check('nine ships on one departure are ONE notification, over 20 ticks',
  afterWave === 1, `got ${afterWave}`);

// ---- a second wave is a second departure --------------------------
await hostileShip('atk9', 'Raider 9');
await inboundNode('n9', 'atk9', 240);
await alerts.runTickAlerts(env, G, 240);
const afterSecondWave = await countFor('inbound');
check('a later departure for the same body DOES notify',
  afterSecondWave === 2, `got ${afterSecondWave}`);

// ================================================================
// 3. THE ATTACKER IS NOT TOLD ABOUT THEIR OWN FLEET
// ================================================================
const atkRows = (await DB
  .prepare("SELECT COUNT(*) AS n FROM notification_log WHERE user_id = 'uAtk' AND category = 'inbound'")
  .first()).n;
check('the attacker gets no inbound alert about their own ships', atkRows === 0, `got ${atkRows}`);

// ================================================================
// 4. A NON-AGGRESSION PACT SILENCES THE WARNING
// ================================================================
// Crying wolf about an ally's fleet is how a player learns to skim past
// the one warning that matters.
await DB.prepare(
  `INSERT INTO treaties (id,game_id,kind,status,proposed_at_tick)
   VALUES ('t1',?, 'nap','active',0)`,
).bind(G).run();
await DB.prepare(
  `INSERT INTO treaty_signatories (treaty_id,faction_id,signed_at_tick)
   VALUES ('t1','fDef',1), ('t1','fAtk',1)`,
).run();
await hostileShip('atk10', 'Friendly');
await inboundNode('n10', 'atk10', 260);
await alerts.runTickAlerts(env, G, 260);
const afterNap = await countFor('inbound');
check('a fleet from a non-aggression partner does not warn',
  afterNap === 2, `got ${afterNap}`);

// ================================================================
// 5. MUTING THE PHONE ACTUALLY STOPS IT
// ================================================================
const notify = await import('../worker/notify.js');
await notify.setPref(env, 'uDef', 'combat', false, 'push');
await DB.prepare(
  `INSERT INTO battles (id,game_id,body_id,body_name,started_tick,last_fire_tick,started_at_ms,status)
   VALUES ('b_300_mars',?,'mars','Mars',300,300,0,'active')`,
).bind(G).run();
await DB.prepare(
  `INSERT INTO battle_participants (battle_id,ship_id,faction_id,ship_name,first_tick,last_tick)
   VALUES ('b_300_mars','sh5','fDef','Watchman III',300,300)`,
).run();
await alerts.runTickAlerts(env, G, 300);
check('a muted phone category sends nothing', await countFor('combat') === 2);

console.log(bad ? `\n${bad} FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
