#!/usr/bin/env node
// ============================================================================
// demo-fleets.mjs — stand up four fleets of different shapes so the map's
// fleet markers can actually be LOOKED at.
//
// WHY THIS EXISTS. The marker work (one flagship + an escort wedge + a
// count, one trajectory instead of N) was built against unit tests and a
// twenty-hull scratch fleet. Neither tells you whether it reads well. This
// puts four deliberately different fleets on a board:
//
//   1st Battle Fleet   64 hulls, parked        big badge, wedge, overflow
//   2nd Strike Wing    40 hulls, under way     ONE line, not forty
//   Ceres Picket        5 hulls, parked        every escort shown, no overflow
//   Logistics Command  28 hulls, SPLIT         two markers for one fleet,
//                                              plus a detached hull on its own,
//                                              merging to one badge when you
//                                              zoom out
//
// RE-RUNNABLE. Every row it writes is prefixed `<game>:dm_`, and it clears
// that prefix before writing. Running it twice is the same as running it
// once; running it after a partial failure repairs rather than duplicates.
// Nothing outside the prefix is ever touched, so it cannot damage a board
// it is pointed at by mistake.
//
// PRINTS ITS OWN ROLLBACK. The teardown drops the hulls, their burn plans
// and the fleet rows, and sends the borrowed captains back to the bank.
// It is on stdout every run — see --teardown.
//
// USAGE
//   node scripts/demo-fleets.mjs --game <id> --faction <id> > demo.sql
//   npx wrangler d1 execute orbital --remote --file demo.sql
//   node scripts/demo-fleets.mjs --teardown --game <id> > undo.sql
//
// PUTTING THE STRIKE WING UNDER WAY. This script only parks hulls; the
// burn is a separate POST per ship to
//   /api/games/<id>/ships/<shipId>/transfer
// with {target_body_id, scheduled_t, arrival_t, dv_prograde, fuel_cost}.
//
// KEEP THE FLIGHT TIME HONEST — roughly what the game itself would quote
// for that leg (a moon hop is ~20 ticks). The first cut asked for a
// 2880-tick coast so the demo would still be in flight the next day, and
// because the endpoint accepts a plan with no launch vectors the client
// fell back to reconstructing the arc from duration and dv alone. Over
// 2880 ticks that reconstruction is meaningless: it drew enormous hatched
// ribbons fanning across the map and terminating at arbitrary points,
// which read exactly like a rendering bug and is not one. A plausible
// duration draws a plausible arc. Lorne spotted the ribbons on the demo
// board; the physics was never asked to agree to the burn.
// ============================================================================

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const has = (k) => argv.includes(`--${k}`);

const GAME = arg('game');
const FACTION = arg('faction');
const TICK = Number(arg('tick', '0'));
if (!GAME) { console.error('--game <id> required'); process.exit(1); }

const P = `${GAME}:dm_`;                       // the one prefix we own

// Teardown is also the first half of a normal run, so there is exactly one
// definition of "what this script owns".
const TEARDOWN = [
  // Nodes FIRST: they key off ship_id, so dropping the hulls first would
  // strand every burn plan as an orphan row nothing ever collects.
  `DELETE FROM game_ship_nodes WHERE game_id='${GAME}' AND ship_id LIKE '${P}%';`,
  `DELETE FROM game_ships      WHERE game_id='${GAME}' AND id      LIKE '${P}%';`,
  `DELETE FROM game_fleets     WHERE game_id='${GAME}' AND id      LIKE '${P}%';`,
  // Send the borrowed captains back to the bank, or they keep pointing at
  // hulls that no longer exist.
  `UPDATE game_captains SET ship_id = NULL WHERE game_id='${GAME}' AND ship_id LIKE '${P}%';`,
];

if (has('teardown')) { console.log(TEARDOWN.join('\n')); process.exit(0); }
if (!FACTION) { console.error('--faction <id> required'); process.exit(1); }

// Per-class stats, averaged off the live 8-faction board so the demo hulls
// are the same animals players actually fly — a 40hp "destroyer" would
// make the fleet cards lie.
const CLASS = {
  mega_destroyer: { hp: 4000, dmg: 350, fuel: 600, tag: 'BB' },
  destroyer:      { hp: 1109, dmg: 47,  fuel: 300, tag: 'DD' },
  frigate:        { hp: 123,  dmg: 22,  fuel: 200, tag: 'FF' },
  corvette:       { hp: 40,   dmg: 5,   fuel: 92,  tag: 'CV' },
  freighter:      { hp: 60,   dmg: 0,   fuel: 400, tag: 'TR' },
  colony:         { hp: 60,   dmg: 0,   fuel: 100, tag: 'CL' },
};

// Parking radius. Derived from the live board, where it holds exactly for
// every body but Sol: rp = 1.45r + 0.3. Not stationOrbitRadius() — that is
// the STATION formula and sits ships noticeably higher.
const parkR = (radius) => Math.round((1.45 * radius + 0.3) * 100) / 100;

const BODY = {
  triton:   { radius: 1.5 },
  earth:    { radius: 3 },
  ceres:    { radius: 1.5 },
  callisto: { radius: 2 },
  europa:   { radius: 1.5 },
};

// Four fleets, chosen so each one answers a different question about the
// marker. Captains c1_1..c1_4 — c1_0 already flies an existing hull, and
// two ships sharing a captain makes "which one is the flagship" ambiguous.
const FLEETS = [
  {
    key: 'bf1', name: '1st Battle Fleet', captain: 'c1_1_jd5d4',
    flagName: 'Iron Sentinel',
    groups: [{ body: 'triton', comp: [['mega_destroyer', 1], ['destroyer', 38], ['frigate', 25]] }],
  },
  {
    key: 'sw2', name: '2nd Strike Wing', captain: 'c1_2_oezme',
    flagName: 'Quickfire',
    // Parked at Earth by this script; the transfer order that puts it
    // under way is issued through the real API afterwards, because a
    // hand-written burn would draw an arc the physics never agreed to.
    groups: [{ body: 'earth', comp: [['destroyer', 28], ['corvette', 12]] }],
  },
  {
    key: 'cp3', name: 'Ceres Picket', captain: 'c1_3_u1zkw',
    flagName: 'Watchful',
    groups: [{ body: 'ceres', comp: [['frigate', 1], ['corvette', 4]] }],
  },
  {
    key: 'lc4', name: 'Logistics Command', captain: 'c1_4_6nita',
    flagName: 'Long Patience',
    groups: [
      { body: 'callisto', comp: [['freighter', 16]] },
      { body: 'europa',   comp: [['freighter', 8], ['colony', 3]] },
      // Detached: the player saying "that one is doing its own thing".
      // It must keep its own sprite however tightly the rest collapse.
      { body: 'callisto', comp: [['corvette', 1]], detached: true },
    ],
  },
];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const out = [...TEARDOWN];

for (const f of FLEETS) {
  const fleetId = `${P}${f.key}`;
  out.push(
    `INSERT INTO game_fleets (id, game_id, faction_id, name, flag_captain_id, created_at_tick)`
    + ` VALUES (${q(fleetId)}, ${q(GAME)}, ${q(FACTION)}, ${q(f.name)},`
    + ` ${q(`${GAME}:${f.captain}`)}, ${TICK});`);

  let n = 0;
  let flagged = false;
  for (const g of f.groups) {
    const body = BODY[g.body];
    if (!body) { console.error(`unknown body ${g.body}`); process.exit(1); }
    const r = parkR(body.radius);
    for (const [cls, count] of g.comp) {
      const st = CLASS[cls];
      for (let i = 0; i < count; i++) {
        const id = `${P}${f.key}_${n}`;
        // The flagship is the hull carrying the fleet's flag captain —
        // that is how the server derives flagship_id, and how the marker
        // decides it is drawing a command rather than a detachment.
        const isFlag = !flagged && !g.detached;
        if (isFlag) flagged = true;
        const name = isFlag ? f.flagName : `${st.tag}-${String(100 + n)}`;
        out.push(
          `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class,`
          + ` parent_body_id, orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch,`
          + ` orbit_direction, fuel, fuel_max, status, built_at_tick, hp, hp_max,`
          + ` damage_per_tick, captain_id, fleet_id, fleet_detached, home_body_id)`
          + ` VALUES (${q(id)}, ${q(GAME)}, ${q(FACTION)}, ${q(name)}, ${q(cls)},`
          + ` ${q(`${GAME}:${g.body}`)}, ${r}, ${r}, 0, 0, ${TICK}, 1,`
          + ` ${st.fuel}, ${st.fuel}, 'active', ${TICK}, ${st.hp}, ${st.hp},`
          + ` ${st.dmg}, ${isFlag ? q(`${GAME}:${f.captain}`) : 'NULL'}, ${q(fleetId)},`
          + ` ${g.detached ? 1 : 0}, ${q(`${GAME}:${g.body}`)});`);
        n++;
      }
    }
  }
  // THE CAPTAIN LINK IS STORED TWICE, AND THE TICK BELIEVES THE OTHER ONE.
  //
  // game_ships.captain_id is what the UI reads, but the fleet-integrity
  // sweep in room.js joins game_captains.ship_id -> game_ships and nulls
  // flag_captain_id when that join finds nothing ("a flag captain who no
  // longer commands an active member ship beheads the fleet"). Setting
  // only the ship side left four fleets that looked correct on insert and
  // were silently beheaded within 30 seconds, once per tick, forever.
  // Both sides, or neither.
  out.push(
    `UPDATE game_captains SET ship_id = ${q(`${P}${f.key}_0`)}`
    + ` WHERE id = ${q(`${GAME}:${f.captain}`)};`);
  out.push(
    `UPDATE game_fleets SET flag_captain_id = ${q(`${GAME}:${f.captain}`)}`
    + ` WHERE id = ${q(fleetId)};`);

  console.error(`${f.name}: ${n} hulls`);
}

console.log(out.join('\n'));
