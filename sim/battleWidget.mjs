// ============================================================
// THE BATTLE WIDGET — a card that reports a war to a home screen.
//
// Three risks, and only one of them is about pixels.
//
// THE LEAK. Rival strength is gated behind Sensors research, and this
// card renders a rival's hull condition. A widget is the easiest place
// in the product to forget a gate, because nothing on a home screen
// looks like a query and nobody reviews a PNG. So the gating is asserted
// directly: no coverage, no number, and the card says '?' instead.
//
// THE LIE. A battle card that reports a fight you are not in, a threat
// from an ally you signed a pact with, or a dead hull still standing is
// worse than no card. Each of those is a separate assertion below.
//
// THE BLANK RECTANGLE. The PNG is assembled by hand. A bad chunk CRC
// produces a file the worker serves happily as image/png that no decoder
// will open, and the only symptom is an empty square on a phone.
//
// Run: node sim/battleWidget.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB };
const G = 'g_battle';
const TICK = 412;

// ---- a small war ----------------------------------------------------
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('u1','a@t','A','x',0), ('u2','b@t','B','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                  VALUES (?, 'The Long War','u1',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,next_tick_at,created_at)
                  VALUES (?, 'active','s',?,?,0)`).bind(G, TICK, Date.now() + 23 * 60000).run();
await DB.prepare(`INSERT INTO game_factions
                    (id,game_id,slot,name,color,status,joined_at,user_id,metal,fuel,gold,science)
                  VALUES ('f1',?,0,'Alpha Concord','#4ecdc4','active',0,'u1',1,0,1,1),
                         ('f2',?,1,'Red Star','#ff5a4e','active',0,'u2',1,0,1,1),
                         ('f3',?,2,'Grey League','#9aa','active',0,NULL,1,0,1,1)`)
  .bind(G, G, G).run();

const body = (id, name, owner) => DB.prepare(
  `INSERT INTO game_bodies (id,game_id,template_id,name,type,radius,mu,color,owner_faction_id)
   VALUES (?,?,'t',?,'terrestrial',1,1,'#888',?)`).bind(id, G, name, owner).run();
await body('b_mars', 'Mars', 'f1');
await body('b_ceres', 'Ceres', 'f1');
await body('b_titan', 'Titan', 'f2');
await body('b_vesta', 'Vesta', 'f1');

const ship = (id, owner, parent, hp = 100) => DB.prepare(
  `INSERT INTO game_ships (id,game_id,owner_faction_id,name,ship_class,parent_body_id,
     orbit_rp,orbit_ra,orbit_omega,orbit_m0,orbit_epoch,fuel,fuel_max,hp,hp_max,status,built_at_tick)
   VALUES (?,?,?,?,'frigate',?,1,1,0,0,0,10,10,?,100,'active',0)`)
  .bind(id, G, owner, id, parent, hp).run();

// ---- a live battle over Mars ----------------------------------------
// Mine: three hulls, one already dead. Theirs: two, both standing.
await DB.prepare(
  `INSERT INTO battles (id,game_id,body_id,body_name,started_tick,last_fire_tick,
     started_at_ms,status,faction_count)
   VALUES ('bat1',?,'b_mars','Mars',405,?,0,'active',2)`).bind(G, TICK).run();

const part = (battle, shipId, faction, hpEnd, died, kills) => DB.prepare(
  `INSERT INTO battle_participants
     (battle_id,ship_id,faction_id,ship_name,ship_class,hp_max,hp_start,hp_end,
      first_tick,last_tick,died_tick,kills)
   VALUES (?,?,?,?,'frigate',100,100,?,405,?,?,?)`)
  .bind(battle, shipId, faction, shipId, hpEnd, TICK, died, kills).run();

for (const [id, f] of [['s1', 'f1'], ['s2', 'f1'], ['s3', 'f1'], ['s4', 'f2'], ['s5', 'f2']]) {
  await ship(id, f, 'b_mars');
}
await part('bat1', 's1', 'f1', 60, null, 1);
await part('bat1', 's2', 'f1', 30, null, 1);
await part('bat1', 's3', 'f1', 0, 410, 0);      // dead: a loss, not a hull
await part('bat1', 's4', 'f2', 50, null, 0);
await part('bat1', 's5', 'f2', 20, null, 0);

// A battle I am NOT in, over Titan. It must not appear on my card.
await DB.prepare(
  `INSERT INTO battles (id,game_id,body_id,body_name,started_tick,last_fire_tick,
     started_at_ms,status,faction_count)
   VALUES ('bat2',?,'b_titan','Titan',400,?,0,'active',2)`).bind(G, TICK).run();
await ship('s6', 'f2', 'b_titan');
await ship('s7', 'f3', 'b_titan');
await part('bat2', 's6', 'f2', 90, null, 0);
await part('bat2', 's7', 'f3', 90, null, 0);

// An ENDED battle of mine. Also must not appear: the card says what is
// burning now, and a finished fight on a live card is a false alarm.
await DB.prepare(
  `INSERT INTO battles (id,game_id,body_id,body_name,started_tick,last_fire_tick,
     ended_tick,started_at_ms,status,faction_count)
   VALUES ('bat3',?,'b_ceres','Ceres',300,320,320,0,'ended',2)`).bind(G).run();
await ship('s8', 'f1', 'b_ceres');
await part('bat3', 's8', 'f1', 10, null, 4);

const battleWidget = await import('../worker/battleWidget.js');

// ---- 1. which battles appear ----------------------------------------
let snap = await battleWidget.battleSnapshot(env, 'u1');
check('the snapshot finds the live game', snap && snap.game === 'The Long War');
check('...as the right faction', snap.faction === 'Alpha Concord');
check('exactly one battle is reported', snap.battles.length === 1,
  JSON.stringify(snap.battles.map(b => b.body)));
check('...and it is the one I am in', snap.battles[0].body === 'MARS');
check('a battle I am not in is absent',
  !snap.battles.some(b => b.body === 'TITAN'));
check('an ended battle is absent',
  !snap.battles.some(b => b.body === 'CERES'));

// ---- 2. the scoreboard ----------------------------------------------
const b = snap.battles[0];
check('my standing hulls exclude the dead one', b.mine === 2, `mine=${b.mine}`);
check('their standing hulls are counted', b.theirs === 2, `theirs=${b.theirs}`);
check('my loss is counted', b.lost === 1, `lost=${b.lost}`);
check('my kills are summed across my ships', b.kills === 2, `kills=${b.kills}`);
// (60 + 30 + 0) / 300
check('my hull fraction is mine alone',
  Math.abs(b.myHp - 0.3) < 1e-9, `myHp=${b.myHp}`);

// ---- 3. THE GATE ----------------------------------------------------
// No sensor coverage of Mars yet, so their condition is not knowable.
check('without sensor coverage their hull is withheld', b.theirHp === null,
  `theirHp=${b.theirHp}`);

await DB.prepare(`INSERT INTO sensor_coverage (game_id,faction_id,body_id,level,updated_at_tick)
                  VALUES (?, 'f1','b_mars',2,?)`).bind(G, TICK).run();
snap = await battleWidget.battleSnapshot(env, 'u1');
check('with patrol coverage their hull is shown',
  snap.battles[0].theirHp != null && Math.abs(snap.battles[0].theirHp - 0.35) < 1e-9,
  `theirHp=${snap.battles[0].theirHp}`);

// Coverage of a DIFFERENT body must not unlock this one. An intel gate
// that leaks on any coverage row at all is not a gate.
await DB.prepare('DELETE FROM sensor_coverage').run();
await DB.prepare(`INSERT INTO sensor_coverage (game_id,faction_id,body_id,level,updated_at_tick)
                  VALUES (?, 'f1','b_titan',3,?)`).bind(G, TICK).run();
snap = await battleWidget.battleSnapshot(env, 'u1');
check('coverage of another world does not unlock this one',
  snap.battles[0].theirHp === null, `theirHp=${snap.battles[0].theirHp}`);

// Level 1 is ephemeris — the orbit, not the ships. Not enough.
await DB.prepare('DELETE FROM sensor_coverage').run();
await DB.prepare(`INSERT INTO sensor_coverage (game_id,faction_id,body_id,level,updated_at_tick)
                  VALUES (?, 'f1','b_mars',1,?)`).bind(G, TICK).run();
snap = await battleWidget.battleSnapshot(env, 'u1');
check('ephemeris-level coverage is not enough',
  snap.battles[0].theirHp === null, `theirHp=${snap.battles[0].theirHp}`);

// ---- 4. the threat board --------------------------------------------
const node = (id, shipId, target, arrival, seq = 0) => DB.prepare(
  `INSERT INTO game_ship_nodes (id,game_id,ship_id,sequence,anchor_kind,target_body_id,
     scheduled_t,dv_prograde,dv_normal,dv_radial,fuel_cost,status,arrival_at_tick)
   VALUES (?,?,?,?,'encounter',?,0,0,0,0,0,'in_transit',?)`)
  .bind(id, G, shipId, seq, target, arrival).run();

await ship('e1', 'f2', 'b_titan');
await ship('e2', 'f2', 'b_titan');
await ship('e3', 'f3', 'b_titan');
await node('n1', 'e1', 'b_vesta', TICK + 2);
await node('n2', 'e2', 'b_vesta', TICK + 5);   // same world, later
await node('n3', 'e3', 'b_ceres', TICK + 1);

snap = await battleWidget.battleSnapshot(env, 'u1');
const byBody = Object.fromEntries(snap.threats.map(t => [t.body, t]));
check('threats are grouped by the world they are aimed at',
  snap.threats.length === 2, JSON.stringify(snap.threats));
check('...counting every hull aimed there', byBody.VESTA?.ships === 2,
  JSON.stringify(byBody.VESTA));
check('...and reporting the SOONEST arrival, not the last',
  byBody.VESTA?.eta === 2, `eta=${byBody.VESTA?.eta}`);
check('the nearest threat sorts first', snap.threats[0].body === 'CERES',
  snap.threats.map(t => t.body).join(','));

// My own ships moving to my own world are not a threat.
await ship('m1', 'f1', 'b_mars');
await node('n4', 'm1', 'b_vesta', TICK + 1);
snap = await battleWidget.battleSnapshot(env, 'u1');
check('my own ships are never a threat',
  Object.fromEntries(snap.threats.map(t => [t.body, t])).VESTA?.ships === 2,
  JSON.stringify(snap.threats));

// A signed non-aggression pact means those ships are not a threat. The
// main card's inbound count already honours this; two widgets disagreeing
// about whether you are under attack would be worse than either alone.
await DB.prepare(`INSERT INTO treaties (id,game_id,kind,status,proposed_at_tick,signed_at_tick)
                  VALUES ('t1',?, 'nap','active',100,100)`).bind(G).run();
await DB.prepare(`INSERT INTO treaty_signatories (treaty_id,faction_id,signed_at_tick)
                  VALUES ('t1','f1',100), ('t1','f2',100)`).run();
snap = await battleWidget.battleSnapshot(env, 'u1');
check('a non-aggression pact removes those ships from the threat board',
  !snap.threats.some(t => t.body === 'VESTA'), JSON.stringify(snap.threats));
check('...but not ships from a faction I have no pact with',
  snap.threats.some(t => t.body === 'CERES'), JSON.stringify(snap.threats));

// ---- 5. states that are not a live war -------------------------------
await DB.prepare("UPDATE game_factions SET status='eliminated' WHERE id='f1'").run();
snap = await battleWidget.battleSnapshot(env, 'u1');
check('an eliminated player gets no battle list', snap.state === 'eliminated'
  && snap.battles.length === 0 && snap.threats.length === 0, JSON.stringify(snap));
await DB.prepare("UPDATE game_factions SET status='active' WHERE id='f1'").run();

await DB.prepare("UPDATE games SET status='completed' WHERE id=?").bind(G).run();
snap = await battleWidget.battleSnapshot(env, 'u1');
check('a finished game reports no live battles', snap.state === 'ended'
  && snap.battles.length === 0, JSON.stringify(snap));
await DB.prepare("UPDATE games SET status='active' WHERE id=?").bind(G).run();

check('a player with no game at all snapshots to null',
  await battleWidget.battleSnapshot(env, 'nobody') === null);

// ---- 6. the PNG is a real PNG ----------------------------------------
snap = await battleWidget.battleSnapshot(env, 'u1');
const png = await battleWidget.renderBattlePng(snap, { width: 512, height: 384 });
const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
check('starts with the PNG signature', sig.every((b2, i) => png[i] === b2));

const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
check('IHDR declares the size we asked for',
  dv.getUint32(16) === 512 && dv.getUint32(20) === 384,
  `${dv.getUint32(16)}x${dv.getUint32(20)}`);

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
const crc32 = (bytes) => { let c = 0xFFFFFFFF; for (const x of bytes) c = CRC[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
let off = 8, chunks = [], crcOk = true;
while (off < png.length) {
  const len = dv.getUint32(off);
  chunks.push(String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]));
  if (crc32(png.subarray(off + 4, off + 8 + len)) !== dv.getUint32(off + 8 + len)) crcOk = false;
  off += 12 + len;
}
check('every chunk CRC is correct', crcOk, chunks.join(','));
check('has IHDR, IDAT and IEND in order',
  chunks[0] === 'IHDR' && chunks.includes('IDAT') && chunks[chunks.length - 1] === 'IEND',
  chunks.join(','));

// A card for a player with nothing at all still has to draw, or the
// widget shows a black square to everyone between games.
const empty = await battleWidget.renderBattlePng(
  { game: 'Orbital', faction: 'NOBODY', color: '#4ecdc4', state: 'none', tick: 0, battles: [], threats: [] },
  { width: 320, height: 300 });
check('a card with no war still renders', empty.length > 100
  && sig.every((b2, i) => empty[i] === b2), `${empty.length} bytes`);

console.log(bad === 0 ? '\nall checks passed' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
