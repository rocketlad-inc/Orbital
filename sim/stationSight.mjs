// ============================================================
// stationSight — a Weapons Station sees as far as it shoots.
//
//   node sim/stationSight.mjs
//
// Sam, 2026-10-23: "a weapons platform will take damage ... but nothing
// is nearby to actually hit it." His station over Mars fired 700 units
// out at a raid still in flight, and the hulls it hit shot back from
// there (counter-battery, room.js). A city sees 500, so the fight and
// its damage came from nothing he could see. The station now carries a
// sensorRange equal to its reach, through the same buildFriendlySensors
// the payload is filtered by.
// ============================================================

import { MEGASTRUCTURES } from '../worker/megastructures.js';
import { buildFriendlySensors } from '../worker/state.js';

let bad = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`PASS  ${label}`); return; }
  bad += 1;
  console.log(`FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
};

const ST = MEGASTRUCTURES.weapons_station.effect;
const body = (id, parent, r, extra = {}) => ({
  id, name: id, parent_body_id: parent, orbit_radius: r, orbit_period: 1e9, angle0: 0,
  radius: 1, soi: 50, type: 'terrestrial', ...extra,
});
const bodies = [
  { id: 'g:sol', name: 'Sol', parent_body_id: null, orbit_radius: 0, orbit_period: 0, angle0: 0, radius: 60, type: 'star' },
  body('g:mars', 'g:sol', 2264),
  body('g:mega_st', 'g:mars', 8.57, { type: 'megastructure' }),
  body('g:mega_rival', 'g:mars', 9.5, { type: 'megastructure' }),
];
const station = (id, owner, extra = {}) => ({ body_id: id, kind: 'weapons_station', status: 'complete', owner_faction_id: owner, ...extra });
const radii = (megas, friendly, scale = 1) =>
  buildFriendlySensors(bodies, [], [], 0, scale, megas, friendly).sensors.map(s => Math.sqrt(s.r2));

check('a Weapons Station sees at least as far as its guns reach',
  (ST.sensorRange ?? 0) >= ST.range, JSON.stringify(ST));
const own = radii([station('g:mega_st', 'g:f0')], ['g:f0']);
check('your own station adds a sensor bubble the size of its reach',
  own.length === 1 && Math.abs(own[0] - ST.range) < 1e-9, JSON.stringify(own));
check('...an ally\'s station lights your map too',
  radii([station('g:mega_st', 'g:f9')], ['g:f0', 'g:f9']).length === 1);
check('...a rival\'s station gives you nothing',
  radii([station('g:mega_rival', 'g:f5')], ['g:f0']).length === 0);
check('...an unowned ancient battery gives nobody sight',
  radii([station('g:mega_st', null, { ancient: 1 })], ['g:f0']).length === 0);
check('...a station still under construction sees nothing',
  radii([station('g:mega_st', 'g:f0', { status: 'building' })], ['g:f0']).length === 0);
const spread = radii([station('g:mega_st', 'g:f0')], ['g:f0'], 4);
check('...and it scales with the map like every other sensor', Math.abs(spread[0] - 4 * ST.range) < 1e-9, JSON.stringify(spread));
check('the Deep Space Array still sees 1100',
  Math.abs(radii([{ body_id: 'g:mega_st', kind: 'deep_array', status: 'complete', owner_faction_id: 'g:f0' }], ['g:f0'])[0] - 1100) < 1e-9);
check('a Null Field is still not a sensor',
  radii([{ body_id: 'g:mega_rival', kind: 'null_field', status: 'complete', owner_faction_id: 'g:f0' }], ['g:f0']).length === 0);

console.log(bad ? `\n${bad} FAILURE(S)` : '\nALL STATION SIGHT CHECKS PASS');
process.exit(bad ? 1 : 0);
