// ============================================================
// nullFieldIntel — a Null Field hides things from the blanket grants too.
//
//   npm run sim:nullfieldintel
//
// Noah, 2026-09-24: "can anyone tell if the null field site I built is
// working? I built it by Mars so it should be cutting off all sight
// there". It was not, for the two players it was built against. Both
// were at Sensors 10, and Strategic Array (9) and Total Awareness (10)
// hand over every rival settlement and hull "fog or no fog" -- a SQL
// `OR 1 = ?` that never asked where the thing was. The jammer only ever
// cut sensor REACH, which a Sensors-10 empire no longer needs.
//
// Runs the server's own buildFriendlySensors / computeJammedIds, then
// assembles what /state returns the same way the SQL does:
//   seen = presence ∪ sensor-revealed ∪ (grant ? all − jammed : ∅)
// ============================================================

import {
  buildFriendlySensors, computeSensorVisibleShipIds, computeSensorVisibleBodyIds,
  computeJammedIds,
} from '../worker/state.js';
import { MEGASTRUCTURES } from '../worker/megastructures.js';

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

const R = MEGASTRUCTURES.null_field.effect.blindRange;
const TICK = 100;
// Period 0 = parked at angle0, so every position below is exact.
const body = (id, parent, r, type = 'terrestrial') => ({
  id, parent_body_id: parent, orbit_radius: r, orbit_period: 0, angle0: 0, type,
});

// Sol at the origin; Mars 5000 out with a moon; Earth far away on the
// other side. The field sits just off Mars, as Noah built it.
const bodies = [
  body('sol', null, 0, 'star'),
  body('mars', 'sol', 5000),
  body('phobos', 'mars', 40),
  body('field', 'mars', 60, 'megastructure'),
  body('earth', 'sol', -9000),
];
const megas = [{ body_id: 'field', kind: 'null_field', status: 'complete', owner_faction_id: 'noah' }];

// Noah's hulls: one at Mars (inside), one at Earth (outside).
const ship = (id, at) => ({ id, ship_class: 'destroyer', parent_body_id: at, target_body_id: null });
const noahShips = [ship('n_mars', 'mars'), ship('n_earth', 'earth')];
// Noah's settlements: Mars (inside the field) and Earth (outside).
const noahSettlementBodies = ['mars', 'earth'];

/** What a rival at Sensors 10 is sent, the way /state's SQL composes it. */
function rivalView({ rivalShips = [], rivalSettlements = [], grant = true } = {}) {
  const { sensors, blinds, bodyPos, shipPos } = buildFriendlySensors(
    bodies, rivalShips, rivalSettlements, TICK, 1, megas, ['rival'],
  );
  const sensorBodies = new Set(computeSensorVisibleBodyIds(bodies, sensors, bodyPos, blinds));
  // Presence: a body a rival hull is parked at (my_presence CTE).
  for (const s of rivalShips) sensorBodies.add(s.parent_body_id);
  const sensorShips = new Set(computeSensorVisibleShipIds(noahShips, sensors, shipPos, blinds));
  const jammedShips = new Set(grant ? computeJammedIds(noahShips, shipPos, sensors, blinds) : []);
  const jammedBodies = new Set(grant ? computeJammedIds(bodies, bodyPos, sensors, blinds) : []);
  const ships = noahShips.filter(s => sensorShips.has(s.id) || sensorBodies.has(s.parent_body_id)
    || (grant && !jammedShips.has(s.id))).map(s => s.id);
  const settlements = noahSettlementBodies.filter(b => sensorBodies.has(b)
    || (grant && !jammedBodies.has(b)));
  return { ships, settlements, blinds };
}

// ---- the reported case: Sensors 10, nothing of theirs near Mars -------
{
  const v = rivalView({ rivalSettlements: [{ body_id: 'earth', type: 'city', buildings_json: '[]' }] });
  check('the field is live (one rival blind, over Mars)', v.blinds.length === 1, JSON.stringify(v.blinds));
  check('Total Awareness does NOT see the hull at Mars', !v.ships.includes('n_mars'), v.ships.join(','));
  check('Strategic Array does NOT see the Mars settlement', !v.settlements.includes('mars'), v.settlements.join(','));
  check('...and the grant still covers the open map (Earth hull)', v.ships.includes('n_earth'));
  check('...and the Earth settlement', v.settlements.includes('earth'));
}

// ---- a hull in the Mars system still pierces it ------------------------
{
  const v = rivalView({ rivalShips: [ship('r_phobos', 'phobos')] });
  check('a rival hull at Phobos sees the Mars hull through the field', v.ships.includes('n_mars'), v.ships.join(','));
  check('...and the Mars settlement', v.settlements.includes('mars'), v.settlements.join(','));
}

// ---- the owner is never blinded by their own field ---------------------
{
  const { blinds } = buildFriendlySensors(bodies, [], [], TICK, 1, megas, ['noah']);
  check('Noah\'s own field blinds nobody on his side', blinds.length === 0);
}

// ---- the range is the catalogue's, scaled like every sensor ------------
{
  const { blinds } = buildFriendlySensors(bodies, [], [], TICK, 2, megas, ['rival']);
  check(`blind radius = ${R} × sensorScale`, Math.abs(Math.sqrt(blinds[0].r2) - R * 2) < 1e-6);
}

// ---- a breached / unfinished field has no effect -----------------------
{
  const { blinds } = buildFriendlySensors(bodies, [], [], TICK, 1,
    [{ ...megas[0], status: 'building' }], ['rival']);
  check('an unfinished field blinds nothing', blinds.length === 0);
}

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
