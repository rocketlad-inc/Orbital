// ============================================================
// nullFieldState — the Null Field through the REAL /state handler.
//
//   npm run sim:nullfieldstate
//
// sim/nullFieldIntel.mjs checks the JS half. This one runs the whole
// GET /state against a real schema, because the three holes Lorne and
// Noah found on 2026-09-24 were all in the SQL, not the maths:
//
//   RESEARCH GRANTS. Strategic Array / Total Awareness were `OR 1 = ?`
//   and never asked where anything was.
//
//   A HULL AT SOL. "Moons of presence" had no star guard, so one ship in
//   solar orbit made the Sun presence and every planet its moon: the
//   whole map, lit with no sensor or field check. Tritalowda had 64
//   hulls there, and their intel-share partner (Lorne) saw Mars too.
//
//   THE DOCK. Structures stay on the map inside a field (a hole should
//   show its cause), so they sat in visible_bodies, and every hull
//   parked at one rode in with them.
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { routes } from '../worker/state.js';

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

const statementsOf = (sql) => sql.split(/;\s*(?:\r?\n|$)/)
  .map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
const db = new SimD1();
for (const m of MIGRATIONS) for (const s of statementsOf(m.sql)) { try { db.db.exec(s); } catch { /* re-runs */ } }
db.db.exec('PRAGMA foreign_keys = OFF');
const run = (sql, ...a) => db.db.prepare(sql).run(...a);

const G = 'nullFieldSim';   // GAME_ID_RE: a real-shaped id
const TICK = 100;
const NOW = Date.now();
const F = { rival: `${G}:f1`, noah: `${G}:f5`, partner: `${G}:f0` };

for (const [u, f, slot, name] of [['u1', F.rival, 1, 'Tritalowda'], ['u2', F.noah, 5, 'Stonekin'], ['u3', F.partner, 0, 'Expanse']]) {
  run(`INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)`, u, `${u}@example.com`, name, NOW);
  run(`INSERT INTO game_factions (id, game_id, user_id, slot, name, color, status, joined_at)
       VALUES (?, ?, ?, ?, ?, '#888888', 'active', ?)`, f, G, u, slot, name, NOW);
}
run(`INSERT INTO rooms (id, name, host_id, status, created_at, updated_at) VALUES (?, 'Probe', 'u3', 'in_progress', ?, ?)`, G, NOW, NOW);
run(`INSERT INTO games (id, status, map_seed, current_tick, gating_enabled, next_tick_at, created_at) VALUES (?, 'active', 's', ?, 1, ?, ?)`, G, TICK, NOW + 3600000, NOW);
run(`UPDATE game_factions SET capital_body_id = ? WHERE id = ?`, `${G}:mars`, F.noah);

// Period 0: every body sits at angle0, so positions are exact.
const body = (id, parent, r, type, owner = null, angle = 0) => run(
  `INSERT INTO game_bodies (id, game_id, template_id, name, type, radius, mu, color,
                            parent_body_id, orbit_radius, orbit_period, angle0, owner_faction_id)
   VALUES (?, ?, ?, ?, ?, 5, 1, '#999999', ?, ?, 0, ?, ?)`,
  `${G}:${id}`, G, id, id, type, parent && `${G}:${parent}`, r, angle, owner);
body('sol', null, 0, 'star');
body('mars', 'sol', 5000, 'terrestrial', F.noah);
body('phobos', 'mars', 40, 'moon');
body('field', 'mars', 60, 'megastructure', F.noah);
body('gun', 'mars', 80, 'megastructure', F.noah);
body('earth', 'sol', 9000, 'terrestrial', F.rival, Math.PI);
body('ceres', 'sol', 7000, 'dwarf', F.noah, Math.PI / 2);   // Noah, far from the field
// A Tritalowda station 500 out from Mars, in its own system: its
// sensors cover Mars and both structures, and cannot pierce the field.
body('vesta', 'sol', 5500, 'asteroid', F.rival);

const mega = (id, kind) => run(
  `INSERT INTO game_megastructures (game_id, body_id, kind, status, hp, cost_metal, cost_credits, founded_at_tick)
   VALUES (?, ?, ?, 'complete', 3000, 0, 0, 1)`, G, `${G}:${id}`, kind);
mega('field', 'null_field');
mega('gun', 'weapons_station');

const settle = (id, at, owner) => run(
  `INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name, hp, hp_max, created_at_tick)
   VALUES (?, ?, ?, ?, 'city', ?, 100, 100, 1)`, id, G, `${G}:${at}`, owner, id);
settle('s_mars', 'mars', F.noah);
settle('s_ceres', 'ceres', F.noah);
settle('s_earth', 'earth', F.rival);
run(`INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name, hp, hp_max, created_at_tick)
     VALUES ('s_vesta', ?, ?, ?, 'station', 'Vesta', 100, 100, 1)`, G, `${G}:vesta`, F.rival);

let n = 0;
const ship = (owner, cls, at) => {
  const id = `sh${n++}`;
  run(`INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id, status,
                               orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, fuel, fuel_max, built_at_tick)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 10, 10, 0, 0, 0, 1, 1, 1)`, id, G, owner, id, cls, `${G}:${at}`);
  return id;
};
const atMars = ship(F.noah, 'frigate', 'mars');
const docked = ship(F.noah, 'freighter', 'gun');
const atCeres = ship(F.noah, 'frigate', 'ceres');
ship(F.rival, 'destroyer', 'sol');     // the hull in solar orbit
ship(F.rival, 'destroyer', 'earth');

// Tritalowda at Sensors 10: both blanket grants.
run(`INSERT INTO faction_techs (game_id, faction_id, tech_id, level, status, started_at_tick) VALUES (?, ?, 'sensors', 10, 'complete', 1)`, G, F.rival);
// Lorne's intel share with them.
run(`INSERT INTO treaties (id, game_id, kind, status, proposed_at_tick) VALUES ('t1', ?, 'intel_share', 'active', 1)`, G);
run(`INSERT INTO treaty_signatories (treaty_id, faction_id, signed_at_tick) VALUES ('t1', ?, 1), ('t1', ?, 1)`, F.rival, F.partner);

const route = routes.find(r => r.method === 'GET' && r.pattern.test(`/api/games/${G}/state`));
async function stateAs(uid) {
  const res = await route.handle(new Request(`https://x/api/games/${G}/state`), { DB: db },
    { session: { user_id: uid }, params: { gameId: G } });
  const j = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(j)}`);
  return j;
}
const view = (j) => ({
  ships: new Set(j.ships.map(s => s.id)),
  settlements: new Set(j.settlements.map(s => s.id)),
  visible: new Set(j.visible_body_ids ?? []),
  capital: j.factions.find(f => f.id === F.noah)?.capital_body_id ?? null,
});

for (const [who, uid] of [['Tritalowda (Sensors 10, hull at Sol)', 'u1'], ['Lorne (intel share, Sensors 0)', 'u3']]) {
  const v = view(await stateAs(uid));
  console.log(`-- as ${who}`);
  check('Mars is not in view', !v.visible.has(`${G}:mars`));
  check('the Mars settlement is hidden', !v.settlements.has('s_mars'));
  check('the hull parked at Mars is hidden', !v.ships.has(atMars));
  check('the hull docked at the Weapons Station is hidden', !v.ships.has(docked));
  check('the Mars capital pin is withheld', v.capital === null, String(v.capital));
  check('the Null Field itself stays on the map (a hole shows its cause)', v.visible.has(`${G}:field`));
  if (uid === 'u1') {
    check('Total Awareness still shows the hull at Ceres (outside the field)', v.ships.has(atCeres));
    check('Strategic Array still shows the Ceres settlement', v.settlements.has('s_ceres'));
  }
}

{
  const v = view(await stateAs('u2'));
  console.log('-- as Noah (the owner)');
  check('Noah sees his own Mars, hulls and dock', v.visible.has(`${G}:mars`) && v.ships.has(atMars) && v.ships.has(docked));
  check('...and his own capital pin', v.capital === `${G}:mars`);
}

// A hull IN the Mars system still sees through it.
{
  const scout = ship(F.rival, 'destroyer', 'phobos');
  const v = view(await stateAs('u1'));
  console.log('-- Tritalowda parks a hull at Phobos');
  check('the same-system hull pierces the field: Mars settlement', v.settlements.has('s_mars'));
  check('...and the docked hull', v.ships.has(docked));
  run(`DELETE FROM game_ships WHERE id = ?`, scout);
}

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
