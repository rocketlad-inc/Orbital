// ============================================================
// EXPANDED HARDPOINTS — Construction 8 gives every warship and the
// freighter one more slot (clownking's idea; Lorne, 2026-10-14):
// corvette 3, frigate 5, destroyer 7, freighter 2. Colony ship stays 1.
//
// The pure rule, then the REAL design endpoints at Construction 7 and 8,
// then the two traps: a stored 3-part corvette must still read as 3
// parts (parsePartsJson), and a game with research gating OFF must not
// hand the bonus out free.
//
// Run: node sim/extraSlot.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { routes } from '../worker/actions.js';
import {
  slotCountFor, validateParts, parsePartsJson, SHIP_SLOT_COUNTS, LENIENT,
} from '../worker/shipDesigns.js';

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

// ---- 1. The rule -------------------------------------------------------
const c7 = { construction: 7 }, c8 = { construction: 8 };
check('before Construction 8: corvette 2, frigate 4, destroyer 6, freighter 1',
  ['corvette', 'frigate', 'destroyer', 'freighter'].map(c => slotCountFor(c, c7)).join() === '2,4,6,1');
check('at Construction 8: corvette 3, frigate 5, destroyer 7, freighter 2',
  ['corvette', 'frigate', 'destroyer', 'freighter'].map(c => slotCountFor(c, c8)).join() === '3,5,7,2');
check('the colony ship keeps its one slot, capital hulls their none',
  slotCountFor('colony', c8) === 1 && slotCountFor('mega_destroyer', c8) === 0 && slotCountFor('kaiju', c8) === 0);
check('the base table is untouched', SHIP_SLOT_COUNTS.corvette === 2 && SHIP_SLOT_COUNTS.destroyer === 6);
check('a third part on a corvette is refused at Construction 7',
  !validateParts('corvette', ['kinetic', 'kinetic', 'shield'], c7).ok);
check('...and accepted at Construction 8',
  validateParts('corvette', ['kinetic', 'kinetic', 'shield'], c8).ok);
check('...but never a fourth', !validateParts('corvette', ['kinetic', 'kinetic', 'shield', 'engine'], c8).ok);
check('no levels at all means no bonus', !validateParts('corvette', ['kinetic', 'kinetic', 'shield']).ok);
check('a freighter gets its second slot (engine + shield)',
  validateParts('freighter', ['engine', 'shield'], c8).ok && !validateParts('freighter', ['engine', 'shield'], c7).ok);
check('a STORED 3-part corvette still reads as 3 parts, whatever the tech now',
  parsePartsJson('corvette', JSON.stringify(['kinetic', 'kinetic', 'shield'])).length === 3);
check('...and a stored loadout past even the bonus still reads as nothing',
  parsePartsJson('corvette', JSON.stringify(['kinetic', 'kinetic', 'shield', 'engine'])).length === 0);
check('templates (LENIENT) may hold the bonus slot', validateParts('destroyer', Array(7).fill('kinetic'), LENIENT).ok);

// ---- 2. The real endpoints ---------------------------------------------
const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const G = 'gslot1';
const now = Date.now();
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('u1','u1@t','u1','x',?)`).bind(now).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'Slots','u1',?,?)`).bind(G, now, now).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at) VALUES (?,'setup','slots',50,3600000,?,?)`).bind(G, now, now).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u1',?,'earth')`).bind(G, now).run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare(`UPDATE games SET status='active' WHERE id=?`).bind(G).run();
const fA = (await DB.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='u1'`).bind(G).first()).id;
const setTech = async (track, level) => {
  await DB.prepare('DELETE FROM faction_techs WHERE game_id = ? AND faction_id = ? AND tech_id = ?').bind(G, fA, track).run();
  await DB.prepare("INSERT INTO faction_techs (game_id, faction_id, tech_id, status, level, started_at_tick, completed_at_tick) VALUES (?, ?, ?, 'completed', ?, 0, 0)").bind(G, fA, track, level).run();
};
await setTech('weapons', 1);
await setTech('armor', 1);
await setTech('propulsion', 2);
await setTech('construction', 7);

const call = async (method, path, body) => {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    const url = new URL(`https://x${path}`);
    const res = await r.handle(new Request(url, { method, body: JSON.stringify(body) }), env,
      { url, params: m.groups ?? {}, session: { user_id: 'u1' } });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return { status: 404, body: null };
};

const three = ['kinetic', 'kinetic', 'shield'];
let r = await call('POST', `/api/games/${G}/designs`, { ship_class: 'corvette', name: 'Trident', parts: three });
check('Construction 7: the designer refuses a 3-part corvette', r.status === 400 && /slot/.test(r.body?.error?.message ?? ''),
  JSON.stringify(r.body));
const two = await call('POST', `/api/games/${G}/designs`, { ship_class: 'corvette', name: 'Pair', parts: ['kinetic', 'shield'] });
check('...a 2-part one is fine', two.status === 200 || two.status === 201, JSON.stringify(two.body));

await setTech('construction', 8);
r = await call('POST', `/api/games/${G}/designs`, { ship_class: 'corvette', name: 'Trident', parts: three });
check('Construction 8: the same 3-part corvette is saved', r.status === 200 || r.status === 201, JSON.stringify(r.body));
const did = two.body?.design?.id ?? two.body?.id;
r = await call('PATCH', `/api/games/${G}/designs/${did}`, { parts: three });
check('...and an old 2-part design can be refitted to 3', r.status === 200, JSON.stringify(r.body));
r = await call('POST', `/api/games/${G}/designs`, { ship_class: 'destroyer', name: 'Seven', parts: Array(7).fill('kinetic') });
check('...a 7-part destroyer is saved', r.status === 200 || r.status === 201, JSON.stringify(r.body));
r = await call('POST', `/api/games/${G}/designs`, { ship_class: 'colony', name: 'Two', parts: ['construction', 'construction'] });
check('...a colony ship still takes one', r.status === 400, JSON.stringify(r.body));

// Gating OFF grandfathers unlocks; it must not grandfather the bonus.
await DB.prepare('UPDATE games SET research_gating = 0 WHERE id = ?').bind(G).run().catch(() => {});
await setTech('construction', 0);
r = await call('POST', `/api/games/${G}/designs`, { ship_class: 'corvette', name: 'Free', parts: three });
check('a game at Construction 0 never gets the slot, gated or not', r.status === 400, JSON.stringify(r.body));

console.log(bad ? `\n${bad} FAILED` : '\nALL EXPANDED HARDPOINTS CHECKS PASS');
process.exit(bad ? 1 : 0);
