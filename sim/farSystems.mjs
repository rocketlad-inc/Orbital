// ============================================================
// THE FAR SYSTEMS — Centauri and Cygnus X-1, seeded for real.
//
// Written for single-player in May 2026 (dd5b3b8c) and never once
// seeded in a multiplayer game: they lived only in mockGameState, and
// single-player entry was retired. Ported 2026-10-05 for STAGING.
//
// HALF OF THIS FILE IS THE PRODUCTION GUARD. The bodies are in the
// shipped catalogue so every lookup-by-template keeps working, which
// means two live code paths would otherwise plant them in games nobody
// asked: seedGameWorld, and backfillMissingBodies — which runs against
// games ALREADY IN PROGRESS every time the lobby is touched. Both are
// asserted off here, because "DO NOT PUT THEM IN PROD" is a property of
// the code, not of my intentions.
//
// Run: node sim/farSystems.mjs
// ============================================================

import {
  BODY_CATALOG, FAR_SYSTEM_IDS, STARTING_BODY_OPTIONS,
  seedGameWorld, backfillMissingBodies, pickSecretPlacements,
  moonScaleCeiling, catalogFor, scaledGeometry, FAR_LOCAL_SCALE,
} from '../worker/factions.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { defaults } from '../worker/configSchema.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const CENTAURI = ['binary_barycenter', 'centauri_a', 'centauri_b', 'verdant',
  'thistle', 'sorrel', 'crimson', 'prismara', 'scoria', 'umber', 'cinder',
  'clinker', 'farspire', 'flint', 'tinder', 'ember', 'pyrite'];
const CYGNUS = ['bh_barycenter', 'cygnus_x', 'hde_226868', 'requiem',
  'lacrimosa', 'sanctus', 'vellichor', 'elegy', 'vesper', 'threnody',
  'echelon', 'gilt', 'reliquary', 'cenotaph', 'epitaph', 'votive', 'marrow'];
const ALL_FAR = [...CENTAURI, ...CYGNUS];

// ---- 1. The catalogue ------------------------------------------------
check('both systems are in the shipped catalogue',
  ALL_FAR.every(id => BODY_CATALOG.some(b => b.id === id)),
  ALL_FAR.filter(id => !BODY_CATALOG.some(b => b.id === id)).join(', '));
check('every one of them is flagged far_system',
  ALL_FAR.every(id => FAR_SYSTEM_IDS.has(id)));
check('the default config leaves them out of a game\'s catalogue',
  catalogFor(defaults()).every(b => !b.far_system));
check('...and the dial puts them back',
  catalogFor({ ...defaults(), far_systems: 1 }).filter(b => b.far_system).length === ALL_FAR.length);

// SERVER DIALECT. The catalogue spells it 'gas-giant'; the client says
// 'gas_giant' and mapBodyType rewrites at the /state boundary. A far
// world written in the client's spelling would be a body whose type
// matches no server rule — silently, which is how this has bitten twice.
const types = new Set(BODY_CATALOG.filter(b => b.far_system).map(b => b.type));
check('they use the SERVER spelling for types',
  !types.has('gas_giant') && !types.has('ice_giant'), [...types].join(', '));

// EVERY GAS GIANT HOLDS AT LEAST THREE WORLDS (Lorne, 2026-10-06).
{
  const giants = BODY_CATALOG.filter(b => b.type === 'gas-giant' || b.type === 'ice-giant');
  const moonsOf = (g) => BODY_CATALOG.filter(b => b.parent === g.id);
  check('every gas and ice giant has at least three moons',
    giants.every(g => moonsOf(g).length >= 3),
    giants.filter(g => moonsOf(g).length < 3).map(g => `${g.id}:${moonsOf(g).length}`).join(', '));
  // Checked on the LIVE geometry (body_scale 2, and FAR_LOCAL_SCALE
  // opening the system up): clear of the giant's cloud tops, and each
  // SOI clear of its neighbour's.
  const BODY = 2;
  const live = (b) => ({ ...b, ...scaledGeometry(b, { bodyScale: BODY }), radius: b.radius * BODY });
  // ...and every far TERRESTRIAL world holds one or two (no one-world
  // systems out there; Sol's own Mercury and Venus are left alone).
  const farRocks = BODY_CATALOG.filter(b => b.far_system && b.type === 'terrestrial');
  check('every far terrestrial world has one or two moons',
    farRocks.every(p => moonsOf(p).length >= 1 && moonsOf(p).length <= 2),
    farRocks.map(p => `${p.id}:${moonsOf(p).length}`).join(', '));
  check('Mercury and Venus are untouched',
    moonsOf({ id: 'mercury' }).length === 0 && moonsOf({ id: 'venus' }).length === 0);
  for (const g0 of [...giants.filter(x => x.far_system), ...farRocks]) {
    const g = live(g0);
    const ms = moonsOf(g0).map(live).sort((a, b) => a.orbit_radius - b.orbit_radius);
    check(`${g.name}'s moons clear its surface at live size`,
      ms.every(m => m.orbit_radius - m.radius > g.radius),
      ms.map(m => `${m.id}@${m.orbit_radius}`).join(', '));
    check(`${g.name}'s moons keep out of each other's way`,
      ms.every((m, i) => i === 0
        || m.orbit_radius - m.soi > ms[i - 1].orbit_radius + ms[i - 1].soi),
      ms.map(m => `${m.id} ${m.orbit_radius}±${m.soi}`).join(', '));
    check(`${g.name}'s moons all sit inside its sphere of influence`,
      ms.every(m => m.orbit_radius < g.soi * 0.5),
      `${ms.map(m => m.orbit_radius).join(', ')} vs soi ${g.soi}`);
  }
}

// THE BINARY'S STATION BONUS covers every world and moon of Centauri, and
// nothing else: a new Centauri moon added later without joining the list
// would quietly yield single.
{
  const { BINARY_SYSTEM_TEMPLATE_IDS } = await import('../worker/systems.js');
  const centauriWorlds = CENTAURI.filter(id => {
    const b = BODY_CATALOG.find(x => x.id === id);
    return b && b.type !== 'star' && b.type !== 'lagrange';
  });
  check('every Centauri world and moon gets the binary station bonus',
    centauriWorlds.every(id => BINARY_SYSTEM_TEMPLATE_IDS.has(id))
    && BINARY_SYSTEM_TEMPLATE_IDS.size === centauriWorlds.length,
    centauriWorlds.filter(id => !BINARY_SYSTEM_TEMPLATE_IDS.has(id)).join(', '));
}


// ---- TWO HOMES AND A CHAOS ZONE (Lorne, 2026-10-06) -------------------------
// Centauri A and B dance on matching e = 0.2 ellipses; Verdant (and its
// moons) orbit A alone and Cinder B alone, each inside its sun's SOI;
// everything else circles both, beyond the reach of either sun's SOI.
// Spread wider than real stability limits allow (Lorne, 2026-10-06: "I
// dont care if that fudges the physics") so each home's orbit shows
// clear of its sun's glare and the chaos zone between shrinks.
{
  const { eccentricLocalPosition } = await import('../worker/transitCombat.js');
  const { ORBITAL_SPEED_SCALE } = await import('../worker/orbitPos.js');
  const { binaryCloseness } = await import('../worker/binaryDance.js');
  const { binaryStationFactor } = await import('../worker/systems.js');
  const live = (id) => {
    const b = BODY_CATALOG.find(x => x.id === id);
    return { ...b, ...scaledGeometry(b, { bodyScale: 2 }), radius: b.radius * 2 };
  };
  const A = live('centauri_a'), Bs = live('centauri_b');
  const at = (b, t) => eccentricLocalPosition(b, t, ORBITAL_SPEED_SCALE);
  let opposite = true, minSep = Infinity, maxSep = 0;
  for (let t = 0; t < 480; t += 3) {
    const a = at(A, t), b = at(Bs, t);
    // Opposite, in the 0.46 : 0.54 split: A at -0.46 of the gap, B at +0.54.
    const cross = a.x * b.y - a.y * b.x, dotp = a.x * b.x + a.y * b.y;
    if (Math.abs(cross) > 1e-6 * Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y) || dotp > 0) opposite = false;
    const sep = Math.hypot(a.x - b.x, a.y - b.y);
    minSep = Math.min(minSep, sep); maxSep = Math.max(maxSep, sep);
  }
  check('the suns stay exactly opposite through the dance', opposite);
  check('they swing from 2520 apart to 3780', Math.abs(minSep - 2520) < 3 && Math.abs(maxSep - 3780) < 3,
    `${minSep.toFixed(0)}..${maxSep.toFixed(0)}`);
  const sepAt = (t) => { const a = at(A, t), b = at(Bs, t); return Math.hypot(a.x - b.x, a.y - b.y); };
  check('one full dance takes 240 ticks', Math.abs(sepAt(0) - sepAt(240)) < 0.5 && Math.abs(sepAt(0) - sepAt(120)) > 100,
    `${sepAt(0).toFixed(0)} / ${sepAt(120).toFixed(0)} / ${sepAt(240).toFixed(0)}`);

  // A home's full reach: its orbit, its outermost moon, that moon's SOI.
  const reachOf = (id) => {
    const w = live(id);
    return Math.max(w.soi, ...BODY_CATALOG.filter(m => m.parent === id)
      .map(m => live(m.id).orbit_radius + live(m.id).soi));
  };
  for (const [world, sun] of [['verdant', 'centauri_a'], ['cinder', 'centauri_b']]) {
    const w = live(world), s = live(sun);
    check(`${w.name} orbits ${sun === 'centauri_a' ? 'A' : 'B'} alone, inside its sun's SOI`,
      w.parent === sun && w.orbit_radius + reachOf(world) < s.soi,
      `${w.orbit_radius} + ${reachOf(world)} vs ${s.soi}`);
    // Clear of the sun's glare: at least 4x the sun's drawn radius out.
    check(`${w.name}'s orbit shows clear of its sun`, w.orbit_radius - reachOf(world) > 4 * s.radius,
      `${w.orbit_radius} - ${reachOf(world)} vs ${4 * s.radius}`);
  }
  check("the two suns' SOIs never touch, even at their closest", A.soi + Bs.soi < minSep,
    `${A.soi} + ${Bs.soi} vs ${minSep.toFixed(0)}`);
  // The suns' zone: the furthest either sun's SOI ever reaches.
  const SUN_ZONE = Math.max(A.orbit_ra + A.soi, Bs.orbit_ra + Bs.soi);
  for (const id of ['crimson', 'flint', 'tinder', 'ember', 'pyrite', 'farspire']) {
    const w = live(id);
    const reach = Math.max(w.soi, ...BODY_CATALOG.filter(m => m.parent === id)
      .map(m => live(m.id).orbit_radius + live(m.id).soi));
    check(`${w.name} circles both suns, clear of the suns' zone`,
      w.parent === 'binary_barycenter' && w.orbit_radius - reach > SUN_ZONE,
      `${w.orbit_radius} - ${reach} vs ${SUN_ZONE}`);
  }
  check('nothing but the suns lives in the chaos zone',
    BODY_CATALOG.filter(b => b.parent === 'binary_barycenter' && b.type !== 'star')
      .every(b => live(b.id).orbit_radius > SUN_ZONE));

  // The station bonus follows the dance for the worlds around one sun.
  let lo = 1, hi = 0;
  for (let t = 0; t < 240; t += 2) { const c = binaryCloseness(A, t); lo = Math.min(lo, c); hi = Math.max(hi, c); }
  check('the dance runs the whole range, 0 to 1', lo < 0.01 && hi > 0.99, `${lo.toFixed(3)}..${hi.toFixed(3)}`);
  check('a station around one sun yields x1.5 apart and x3 together',
    binaryStationFactor({ id: 'g:verdant' }, 0) === 1.5 && binaryStationFactor({ id: 'g:cinder' }, 1) === 3);
  check('a station around both stays x2 through it',
    binaryStationFactor({ id: 'g:crimson' }, 0) === 2 && binaryStationFactor({ id: 'g:flint' }, 1) === 2);
  check('and nothing outside Centauri is touched', binaryStationFactor({ id: 'g:requiem' }, 1) === 1
    && binaryStationFactor({ id: 'g:earth' }, 1) === 1);
}

// ---- CYGNUS DANCES TOO (Lorne, 2026-10-06: "do the same thing for Cygnus")
// The hole and its donor on matching e = 0.2 ellipses; Requiem around the
// hole alone, Echelon around the giant alone; Vellichor, the Ossuary and
// Reliquary circle both, clear of either SOI.
{
  const { eccentricLocalPosition } = await import('../worker/transitCombat.js');
  const { ORBITAL_SPEED_SCALE } = await import('../worker/orbitPos.js');
  const live = (id) => {
    const b = BODY_CATALOG.find(x => x.id === id);
    return { ...b, ...scaledGeometry(b, { bodyScale: 2 }), radius: b.radius * 2 };
  };
  const H = live('cygnus_x'), G = live('hde_226868');
  const at = (b, t) => eccentricLocalPosition(b, t, ORBITAL_SPEED_SCALE);
  let opposite = true, minSep = Infinity, maxSep = 0;
  for (let t = 0; t < 480; t += 3) {
    const a = at(H, t), b = at(G, t);
    const cross = a.x * b.y - a.y * b.x, dotp = a.x * b.x + a.y * b.y;
    if (Math.abs(cross) > 1e-6 * Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y) || dotp > 0) opposite = false;
    const sep = Math.hypot(a.x - b.x, a.y - b.y);
    minSep = Math.min(minSep, sep); maxSep = Math.max(maxSep, sep);
  }
  check('Cygnus: the hole and the giant stay exactly opposite', opposite);
  check('Cygnus: they swing from 2520 apart to 3780', Math.abs(minSep - 2520) < 3 && Math.abs(maxSep - 3780) < 3,
    `${minSep.toFixed(0)}..${maxSep.toFixed(0)}`);
  const reachOf = (id) => {
    const w = live(id);
    return Math.max(w.soi, ...BODY_CATALOG.filter(m => m.parent === id)
      .map(m => live(m.id).orbit_radius + live(m.id).soi));
  };
  for (const [world, host] of [['requiem', 'cygnus_x'], ['echelon', 'hde_226868']]) {
    const w = live(world), s = live(host);
    check(`Cygnus: ${w.name} orbits ${s.name} alone, inside its SOI`,
      w.parent === host && w.orbit_radius + reachOf(world) < s.soi,
      `${w.orbit_radius} + ${reachOf(world)} vs ${s.soi}`);
    check(`Cygnus: ${w.name}'s orbit shows clear of ${s.name}`, w.orbit_radius - reachOf(world) > 4 * s.radius);
  }
  check("Cygnus: the two SOIs never touch, even at their closest", H.soi + G.soi < minSep,
    `${H.soi} + ${G.soi} vs ${minSep.toFixed(0)}`);
  const ZONE = Math.max(H.orbit_ra + H.soi, G.orbit_ra + G.soi);
  for (const id of ['vellichor', 'cenotaph', 'epitaph', 'votive', 'marrow', 'reliquary']) {
    const w = live(id);
    check(`Cygnus: ${w.name} circles both, clear of their zone`,
      w.parent === 'bh_barycenter' && w.orbit_radius - reachOf(id) > ZONE,
      `${w.orbit_radius} - ${reachOf(id)} vs ${ZONE}`);
  }
  check('Cygnus: Reliquary stays its own place, not chained into the Ossuary',
    live('reliquary').orbit_radius > 1.25 * live('marrow').orbit_radius);
  // The well follows the hole: Requiem, around it, is still the deep one.
  const { legDilation } = await import('../worker/wellDilation.js');
  const hp = at(H, 0), rq = { x: hp.x + live('requiem').orbit_radius, y: hp.y };
  const far = { x: hp.x + 8000, y: hp.y };   // about where Reliquary flies
  check('Cygnus: the well moves with the hole; Requiem is still deep in it',
    legDilation(far, rq, [hp]) > 1.5, legDilation(far, rq, [hp]).toFixed(2));
}

// ---- 2. Distance is the balance -------------------------------------
// Live games run system_scale 4 over the catalogue's own SYSTEM_SCALE 2.
// Doubled 2026-10-06 ("Double the distance between solar systems"): on
// the real burn (burn.js, building to 1g) Earth to Centauri is ~82 T
// direct and Cygnus ~88, where the sun gates' whole route is ~71.
const LIVE = 4;
const { legTicks: burnTicksFor, SHIP_ENGINE_ACCEL } = await import('../worker/burn.js');
const EARTH = 186 * 2 * LIVE;
const direct = (r) => Math.ceil(burnTicksFor(r * LIVE - EARTH, SHIP_ENGINE_ACCEL));
const cenR = BODY_CATALOG.find(b => b.id === 'binary_barycenter').orbit_radius;
const cygR = BODY_CATALOG.find(b => b.id === 'bh_barycenter').orbit_radius;
// BODY_CATALOG is already through SYSTEM_SCALE (x2) at module load.
check('the far systems sit twice as far out as they first did',
  cenR === 2 * 2 * 33150 && cygR === 2 * 2 * 42500, `${cenR} / ${cygR}`);
check('Centauri is ~82 ticks direct from Earth on the real burn',
  Math.abs(direct(cenR) - 82) <= 2, `${direct(cenR)} ticks`);
check('Cygnus is ~88 ticks direct',
  Math.abs(direct(cygR) - 88) <= 2, `${direct(cygR)} ticks`);
{
  // ...and the sun gate is the shortcut: to the gate (out in the Far
  // Reach, ~25,500 live), across it at a tenth of the burn, and in from
  // the far gate to a home (~6,500).
  const { gateTransitTicks } = await import('../worker/megastructures.js');
  const leg = (d) => Math.ceil(burnTicksFor(d, SHIP_ENGINE_ACCEL));
  const viaGate = leg(25500 - EARTH) + gateTransitTicks(leg(cenR * LIVE - 25500), 0.1) + leg(6500);
  check('Earth to Centauri through the gate beats flying direct by 10+ ticks',
    direct(cenR) - viaGate >= 10, `gate ${viaGate} vs direct ${direct(cenR)}`);
}
check('they sit on opposite sides of Sol',
  Math.abs(BODY_CATALOG.find(b => b.id === 'binary_barycenter').angle0
    - BODY_CATALOG.find(b => b.id === 'bh_barycenter').angle0) > 3,
  'both would crowd one edge of the map');

// ---- 3. Yields: "everything, but far" -------------------------------
const solMax = { metal: 0, gold: 0, science: 0 };
for (const b of BODY_CATALOG) {
  if (b.far_system || !b.yield) continue;
  for (const k of Object.keys(solMax)) solMax[k] = Math.max(solMax[k], b.yield[k] ?? 0);
}
const farWorlds = BODY_CATALOG.filter(b => b.far_system && (b.yield.metal + b.yield.gold + b.yield.science) > 0);
check('the far worlds out-yield the best of Sol...',
  farWorlds.some(b => b.yield.science > solMax.science)
  && farWorlds.some(b => b.yield.metal > solMax.metal)
  && farWorlds.some(b => b.yield.gold > solMax.gold),
  JSON.stringify(solMax));
const over = farWorlds.filter(b =>
  b.yield.metal > solMax.metal * 2 || b.yield.gold > solMax.gold * 2
  || b.yield.science > solMax.science * 2);
check('...without doubling it — the trip is the cost, not a jackpot',
  over.length === 0, over.map(b => b.id).join(', '));
check('stars and the black hole yield nothing, like Sol',
  BODY_CATALOG.filter(b => b.far_system
    && ['star', 'black_hole', 'lagrange'].includes(b.type))
    .every(b => b.yield.metal + b.yield.gold + b.yield.science === 0));

// ---- 4. No cross-effects on the Sol map ------------------------------
check('no far world is a capital option',
  !STARTING_BODY_OPTIONS.some(o => FAR_SYSTEM_IDS.has(o.id)));
check('the moon-scale clamp is unchanged by their arrival',
  moonScaleCeiling(4, BODY_CATALOG) === moonScaleCeiling(4, BODY_CATALOG.filter(b => !b.far_system)),
  `${moonScaleCeiling(4, BODY_CATALOG)} vs ${moonScaleCeiling(4, BODY_CATALOG.filter(b => !b.far_system))}`);
const places = pickSecretPlacements(() => 0.5, new Set());
check('no secret is ever placed out there',
  ![...places.keys()].some(id => FAR_SYSTEM_IDS.has(id)),
  [...places.keys()].filter(id => FAR_SYSTEM_IDS.has(id)).join(', '));

// ---- 5. Seeding, both ways -------------------------------------------
async function seedGame(id, farSystems) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB };
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('u0','a@t','A','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Far','u0',0,0)`).bind(id).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at)
                    VALUES (?, 'setup','far-seed',0,0)`).bind(id).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at) VALUES (?,?,0)`)
    .bind(id, 'u0').run();
  if (farSystems != null) {
    await DB.prepare(
      `INSERT INTO game_configs (id, name, status, overrides, created_ms, updated_ms)
       VALUES (?, 'far', 'published', ?, 0, 0)`,
    ).bind(`cfg_${id}`, JSON.stringify({ far_systems: farSystems })).run();
    await DB.prepare(`UPDATE games SET config_id = ? WHERE id = ?`).bind(`cfg_${id}`, id).run();
  }
  await seedGameWorld(env, id);
  const rows = (await DB.prepare(
    `SELECT template_id FROM game_bodies WHERE game_id=?`).bind(id).all()).results ?? [];
  return { env, DB, ids: new Set(rows.map(r => r.template_id)), count: rows.length };
}

const plain = await seedGame('gfar_off', null);
check('a game with no config has NO far-system body', ![...plain.ids].some(t => FAR_SYSTEM_IDS.has(t)),
  [...plain.ids].filter(t => FAR_SYSTEM_IDS.has(t)).join(', '));

const off = await seedGame('gfar_zero', 0);
check('far_systems: 0 seeds none either', ![...off.ids].some(t => FAR_SYSTEM_IDS.has(t)));

const on = await seedGame('gfar_on', 1);

// THE WELL, on the server's own leg timer (routeMath.computeLegTicks):
// a hop from Requiem to Vellichor, timed with the black hole there and
// again with it gone.
{
  const { makeRouteMath } = await import('../worker/routeMath.js');
  const leg = async () => makeRouteMath(on.DB, 'gfar_on')
    .computeLegTicks(null, 'gfar_on:requiem', 'gfar_on:vellichor', 0);
  const near = await leg();
  await on.DB.prepare(`UPDATE game_bodies SET destroyed_at_tick = 0 WHERE id = 'gfar_on:cygnus_x'`).run();
  const flat = await leg();
  await on.DB.prepare(`UPDATE game_bodies SET destroyed_at_tick = NULL WHERE id = 'gfar_on:cygnus_x'`).run();
  check("the well slows a hop between Cygnus's inner worlds on the server too",
    near >= flat * 1.3, `${near} ticks in the well vs ${flat} without it`);
}
check(`far_systems: 1 seeds all ${ALL_FAR.length}`,
  ALL_FAR.every(id => on.ids.has(id)), ALL_FAR.filter(id => !on.ids.has(id)).join(', '));
check('...and the rest of Sol is still there',
  on.count === plain.count + ALL_FAR.length + 18, `${on.count} vs ${plain.count} + ${ALL_FAR.length} + 18 rocks`);


// ---- THE FAR SYSTEMS' ROCKS (2026-10-06) ---------------------------------
{
  const rows = (await on.DB.prepare(
    `SELECT * FROM game_bodies WHERE game_id = 'gfar_on'`).all()).results;
  const tpl = (r) => r.template_id;
  const rocks = rows.filter(r => r.mineral_kind);
  const cen = rocks.filter(r => tpl(r).startsWith('mtr_cen_'));
  const cyg = rocks.filter(r => tpl(r).startsWith('mtr_cyg_'));
  check('each far system is seeded nine rocks of its own', cen.length === 9 && cyg.length === 9,
    `${cen.length} Centauri, ${cyg.length} Cygnus`);
  check('...orbiting their own barycenter',
    // An L3 rock rides its host's parent: Verdant's and Cinder's are
    // around their own sun now (two homes), Requiem's around the hole
    // and Echelon's around the giant.
    cen.every(r => ['gfar_on:binary_barycenter', 'gfar_on:centauri_a', 'gfar_on:centauri_b'].includes(r.parent_body_id))
    && cyg.every(r => ['gfar_on:bh_barycenter', 'gfar_on:cygnus_x', 'gfar_on:hde_226868'].includes(r.parent_body_id)),
    [...cen, ...cyg].map(r => `${r.template_id}@${r.parent_body_id}`).join(' '));
  check('...named for their system', cen.every(r => /^CEN-\d\d$/.test(r.name)) && cyg.every(r => /^CYG-\d\d$/.test(r.name)),
    [...cen, ...cyg].map(r => r.name).join(' '));
  check('...metal and gold, never science', [...cen, ...cyg].every(r => ['metal', 'gold'].includes(r.mineral_kind)));
  const byTpl = new Map(rows.map(r => [tpl(r), r]));
  const l3 = [...cen, ...cyg].filter(r => r.type === 'lagrange');
  check('three per system sit at L3, on their host\'s orbit and opposite it',
    l3.length === 6 && l3.every(r => {
      const host = byTpl.get(tpl(r).replace(/^mtr_c(en|yg)_/, '').replace(/_l3$/, ''));
      const dA = Math.abs(((r.angle0 - host.angle0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
      return host && r.orbit_radius === host.orbit_radius && r.orbit_period === host.orbit_period && dA < 1e-9;
    }));
  for (const [sysName, bary, list] of [['Centauri', 'binary_barycenter', cen], ['Cygnus', 'bh_barycenter', cyg]]) {
    const worlds = rows.filter(r => r.parent_body_id === `gfar_on:${bary}` && !r.mineral_kind
      && ['terrestrial', 'gas-giant', 'dwarf'].includes(r.type));
    const outermost = Math.max(...worlds.map(w => w.orbit_radius));
    const outer = list.filter(r => r.orbit_ra != null);
    check(`${sysName}'s three long-haul rocks stay out past its last world`,
      outer.length === 3 && outer.every(r => r.orbit_rp > outermost && r.orbit_ra > r.orbit_rp),
      outer.map(r => `${Math.round(r.orbit_rp)}-${Math.round(r.orbit_ra)} vs ${outermost}`).join(', '));
  }
  // The belts form, each around its own centre, named for its system.
  const { findBelts } = await import('../worker/systems.js');
  const belts = findBelts(rows);
  const kindling = belts.find(b => b.label === 'The Kindling');
  const ossuary = belts.find(b => b.label === 'The Ossuary');
  check('Centauri has its belt, the Kindling, of its four asteroids',
    kindling && ['flint', 'tinder', 'ember', 'pyrite'].every(id => kindling.members.some(m => tpl(m) === id))
    && !kindling.members.some(m => tpl(m) === 'farspire'),
    kindling ? kindling.members.map(tpl).join(', ') : belts.map(b => b.label).join(', '));
  check('Cygnus has its belt, the Ossuary',
    ossuary && ['cenotaph', 'epitaph', 'votive', 'marrow'].every(id => ossuary.members.some(m => tpl(m) === id)),
    ossuary ? ossuary.members.map(tpl).join(', ') : belts.map(b => b.label).join(', '));
  check('Sol\'s belts are untouched by them',
    belts.filter(b => b.members.some(m => m.parent_body_id === 'gfar_on:sol'))
      .every(b => b.members.every(m => m.parent_body_id === 'gfar_on:sol')));

  // Turning far_systems on never moves a Sol rock.
  const solRocks = (g) => g.filter(r => r.mineral_kind && r.parent_body_id.endsWith(':sol'))
    .map(r => `${tpl(r)} ${r.orbit_radius} ${r.angle0} ${r.mineral_kind} ${r.mineral_initial}`).sort();
  const plainRows = (await plain.DB.prepare(`SELECT * FROM game_bodies WHERE game_id = 'gfar_off'`).all()).results;
  // gfar_off was seeded from a different map seed; compare against a
  // fresh far-less game on gfar_on's own seed instead.
  const twin = await seedGame('gfar_on', 0);
  const twinRows = (await twin.DB.prepare(`SELECT * FROM game_bodies WHERE game_id = 'gfar_on'`).all()).results;
  check('turning the far systems on moves no Sol rock',
    JSON.stringify(solRocks(rows)) === JSON.stringify(solRocks(twinRows)) && plainRows.length > 0,
    `${solRocks(rows).length} vs ${solRocks(twinRows).length}`);

  // A running game gets the same rocks from the backfill.
  const before = cen.concat(cyg).map(r => `${tpl(r)} ${Math.round(r.orbit_radius)} ${r.mineral_initial}`).sort();
  await on.DB.prepare(`DELETE FROM game_bodies WHERE game_id = 'gfar_on' AND template_id LIKE 'mtr_c%'`).run();
  const added = await backfillMissingBodies(on.env, 'gfar_on');
  const again = ((await on.DB.prepare(
    `SELECT * FROM game_bodies WHERE game_id = 'gfar_on' AND template_id LIKE 'mtr_c%'`).all()).results)
    .map(r => `${tpl(r)} ${Math.round(r.orbit_radius)} ${r.mineral_initial}`).sort();
  check('the backfill gives a running game the same rocks a fresh one gets',
    added >= 18 && JSON.stringify(again) === JSON.stringify(before), `added ${added}`);
  const twice = await backfillMissingBodies(on.env, 'gfar_on');
  check('...and never twice', twice === 0, `added ${twice}`);
}

// THE BACKFILL IS THE ONE THAT TOUCHES LIVE GAMES.
const added = await backfillMissingBodies(plain.env, 'gfar_off');
const after = (await plain.DB.prepare(
  `SELECT template_id FROM game_bodies WHERE game_id='gfar_off'`).all()).results ?? [];
check('backfill does NOT inject them into a running game that never asked',
  !after.some(r => FAR_SYSTEM_IDS.has(r.template_id)),
  `added ${added}: ${after.filter(r => FAR_SYSTEM_IDS.has(r.template_id)).map(r => r.template_id).join(', ')}`);

// ---- 6. The seeded geometry is sane ----------------------------------
const geo = (await on.DB.prepare(
  `SELECT template_id, parent_body_id, orbit_radius, radius, type FROM game_bodies
    WHERE game_id='gfar_on' AND template_id IN ('binary_barycenter','verdant','cygnus_x','crimson')`)
  .all()).results ?? [];
const byId = new Map(geo.map(r => [r.template_id, r]));
check('the barycenter is heliocentric and far out',
  byId.get('binary_barycenter')?.parent_body_id?.endsWith(':sol')
  && byId.get('binary_barycenter').orbit_radius > 60000,
  JSON.stringify(byId.get('binary_barycenter')));
check('a default-dial game still opens the system up (FAR_LOCAL_SCALE)',
  byId.get('crimson')?.orbit_radius === 1900 * FAR_LOCAL_SCALE,
  String(byId.get('crimson')?.orbit_radius));
check('its worlds orbit IT, at their own local radii',
  byId.get('crimson')?.parent_body_id?.endsWith(':binary_barycenter')
  && byId.get('verdant')?.parent_body_id?.endsWith(':centauri_a')
  && byId.get('verdant').orbit_radius === 560 * FAR_LOCAL_SCALE,
  JSON.stringify(byId.get('verdant')));
check('the black hole kept its type through the seed',
  byId.get('cygnus_x')?.type === 'black_hole', byId.get('cygnus_x')?.type);
check('the gas giant kept the server spelling',
  byId.get('crimson')?.type === 'gas-giant', byId.get('crimson')?.type);

// ---- 7. The host's dials move the systems, not their shapes ---------
//
// Caught on the first staging seed: everything orbiting a barycenter
// trips the "parent is not Sol, so it is a moon" test, so the live map's
// moon_scale 8 inflated Centauri with it — Verdant at 3,200 instead of
// 400, Farspire at 19,200, and a 54-tick hop between neighbours in a
// system meant to be crossed in twenty.
{
  const { scaledGeometry } = await import('../worker/factions.js');
  const dials = { sysScale: 4, bodyScale: 2, moonScale: 8, moonReach: {}, outerSpeedup: 4, beltRadius: 1000 };
  const geo = (id) => scaledGeometry(BODY_CATALOG.find(b => b.id === id), dials);
  // Opened up by FAR_LOCAL_SCALE and by nothing the host set.
  const F = FAR_LOCAL_SCALE;
  check(`a far world sits at ${F}x its designed orbit whatever the host dials`,
    geo('crimson').orbit_radius === 1900 * F && geo('farspire').orbit_radius === 2900 * F,
    `crimson ${geo('crimson').orbit_radius}, farspire ${geo('farspire').orbit_radius}`);
  check('...and its year follows Kepler',
    Math.abs(geo('crimson').orbit_period - 7247 * Math.pow(F, 1.5)) < 1e-6,
    String(geo('crimson').orbit_period));
  check('a far moon of a far world takes the same factor, not moon_scale',
    geo('prismara').orbit_radius === 26 * F, String(geo('prismara').orbit_radius));
  check("the suns' binary opens up with the rest",
    geo('centauri_b').orbit_radius === 850.5 * F, String(geo('centauri_b').orbit_radius));
  // 66,300 written in the file, doubled at module load by SYSTEM_SCALE,
  // then the host's system_scale 4 on top: 530,400 live.
  check('but the DISTANCE to the system still scales with the map',
    geo('binary_barycenter').orbit_radius === 66300 * 2 * 4,
    String(geo('binary_barycenter').orbit_radius));
  check('a real moon still takes moon_scale',
    geo('luna').orbit_radius === 20 * 8, String(geo('luna').orbit_radius));
  check('a planet still takes system_scale',
    geo('earth').orbit_radius === 186 * 2 * 4, String(geo('earth').orbit_radius));
  // Twice the room is still a hop, not a campaign (the real burn).
  const hop = burnTicksFor(2900 * FAR_LOCAL_SCALE, SHIP_ENGINE_ACCEL);
  check('crossing Centauri end to end is a short trip, not a second campaign',
    hop < 30, `${hop.toFixed(0)} ticks`);
}

// ---- 8. What the review found on staging ----------------------------
{
  // The world menu offered BUILD STATION on the event horizon: stations
  // are allowed on anything but a meteoroid, a rule from a game with no
  // black holes in it.
  const srv = (await import('node:fs')).readFileSync(
    new URL('../worker/actions.js', import.meta.url), 'utf8');
  check('the server refuses a station on a black hole',
    /black_hole/.test(srv) && /event horizon/.test(srv));
  check('...and refuses a city on one too',
    /type === 'city' && \(bodyRow\.type === 'star' \|\| bodyRow\.type === 'black_hole'/.test(srv)
    || srv.includes("bodyRow.type === 'black_hole'"));
  // randomize_orbits spun the two set pieces into the same quarter of
  // the sky on the first staging seed.
  const fac = (await import('node:fs')).readFileSync(
    new URL('../worker/factions.js', import.meta.url), 'utf8');
  check('randomised phases skip the far systems',
    /randomizeOrbits && !body\.far_system/.test(fac));
}

console.log(bad === 0 ? '\nALL FAR SYSTEM CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
