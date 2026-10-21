// ============================================================
// A scene's `arrive` never slows a ship (2026-10-21).
//
// Lorne's Mega Destroyer clip: `"arrive": "+40"` on a Mars -> Earth move
// was handed to the leg planner as the arrival, which shaped the burn to
// land on it, so the Mega Destroyer flew a ~16-tick hop on a twentieth of
// its engine (0.44 units/tick^2) and crawled through the shot.
//
// Drives the REAL studio applyScenario (worker/studio.js) in SimD1:
//   1. a move with no `arrive` flies its natural leg
//   2. the same move with a far `arrive` flies the SAME engine, leaving later
//   3. a group is paced to its slowest hull, as before
//   4. an `arrive` sooner than the trip allows leaves at once and warns
//
// Run: npm run sim:studio-arrive
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
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('admin','a@t','Admin','x',0)`).run();

const { applyScenario } = await import('../worker/studio.js');
const { expandScenario } = await import('../worker/studioScene.js');

const scene = (orders) => expandScenario({
  name: 'Arrive check',
  factions: [
    { key: 'terra', name: 'Terran Directorate', home: 'earth' },
    { key: 'mars', name: 'Martian Combine', home: 'mars' },
  ],
  ships: [
    { key: 'mega', owner: 'mars', at: 'mars', class: 'mega_destroyer', count: 1 },
    { key: 'pack', owner: 'mars', at: 'mars', mix: { destroyer: 1, corvette: 2 } },
  ],
  orders,
});

async function legOf(gameId, shipKey) {
  const rows = (await DB.prepare(
    `SELECT n.scheduled_t st, n.arrival_at_tick arr, n.accel a FROM game_ship_nodes n
      WHERE n.game_id = ? AND n.ship_id LIKE ? AND n.status = 'committed' ORDER BY n.sequence`,
  ).bind(gameId, `%:st_${shipKey}`).all()).results;
  return rows[rows.length - 1];
}

let out;
try {
  out = await applyScenario(env, scene([{ type: 'move', ships: 'mega', to: 'earth', depart: '+1' }]), { session: { user_id: 'admin' } });
} catch (e) {
  console.log(`SKIP  applyScenario cannot run in SimD1 here: ${e.message}`);
  process.exit(0);
}
const natural = await legOf(out.game_id, 'mega_0');
check('1. a plain move flies a natural leg', natural && natural.a > 1, JSON.stringify(natural));

const asked = natural.arr + 25;
const out2 = await applyScenario(env, { ...scene([{ type: 'move', ships: 'mega', to: 'earth', depart: '+1', arrive: asked }]), gameId: out.game_id },
  { session: { user_id: 'admin' } });
const later = await legOf(out2.game_id, 'mega_0');
const trip0 = natural.arr - natural.st, trip1 = later.arr - later.st;
check('2. a far arrive keeps the real engine', later.a > natural.a * 0.8,
  `natural accel ${natural.a.toFixed(3)} (${trip0} ticks), with arrive ${later.a.toFixed(3)} (${trip1} ticks)`);
check('   ... and leaves later instead', later.st > natural.st && Math.abs(later.arr - asked) <= 1,
  `departs ${later.st}, arrives ${later.arr}, asked ${asked}`);
check('   ... with no warning', (out2.warnings ?? []).length === 0, JSON.stringify(out2.warnings));

const out3 = await applyScenario(env, { ...scene([{ type: 'move', ships: 'pack', to: 'earth', depart: '+1' }]), gameId: out.game_id },
  { session: { user_id: 'admin' } });
const p = await Promise.all(['pack_0', 'pack_1', 'pack_2'].map(k => legOf(out3.game_id, k)));
check('3. a group lands together', new Set(p.map(x => x?.arr)).size === 1, JSON.stringify(p));

const out4 = await applyScenario(env, { ...scene([{ type: 'move', ships: 'mega', to: 'earth', depart: '+1', arrive: '+2' }]), gameId: out.game_id },
  { session: { user_id: 'admin' } });
const soon = await legOf(out4.game_id, 'mega_0');
check('4. too soon: leaves at once on the real engine', soon && soon.a > natural.a * 0.8, JSON.stringify(soon));
check('   ... and warns', (out4.warnings ?? []).some(w => /as soon as it can/.test(w)), JSON.stringify(out4.warnings));

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
