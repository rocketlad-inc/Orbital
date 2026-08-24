// ============================================================
// sensorStructures — the Array adds vision, the Null Field takes it.
//
//   npm run sim:sensorstructures
//
// These two are the first structures whose whole job is changing what a
// player can SEE, which makes them the easiest pair to get subtly wrong
// in ways nobody notices for weeks. The failures are all silent:
//
//   A JAMMER THAT BLINDS ITS OWNER. Apply every Null Field rather than
//   only rival ones and the structure becomes a weapon against the
//   faction that paid for it.
//
//   A JAMMER THAT MORE SENSORS DEFEAT. If blinding is checked per-sensor
//   instead of per-point, parking enough hulls around a field cancels
//   it — and the one structure that answers the Sensors track becomes a
//   speed bump for exactly the player it was built against.
//
//   A HOLE THAT HIDES ITS OWN CAUSE. Blind the field's own body and the
//   map shows an unexplained void. Knowing something is hidden from you
//   IS the intelligence the counter is meant to leave behind.
//
//   AN ARRAY THAT SHRINKS WITH THE MAP. Ranges are pre-scale numbers.
//   Miss the sensorScale multiply and a spread map quietly makes the
//   most expensive vision in the game worse than a station.
//
// The rules are re-implemented here from the same catalogue the server
// reads, so the NUMBERS cannot drift even though the loop is restated.
// ============================================================

import { MEGASTRUCTURES } from '../worker/megastructures.js';

let bad = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`PASS  ${label}`); return; }
  bad += 1;
  console.log(`FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
};

const ARRAY_R = MEGASTRUCTURES.deep_array.effect.sensorRange;
const NULL_R = MEGASTRUCTURES.null_field.effect.blindRange;

/** Mirrors buildFriendlySensors' two structure passes. */
function build(megas, friendlyIds, scale = 1) {
  const friendly = new Set(friendlyIds);
  const sensors = [];
  const blinds = [];
  for (const m of megas) {
    if (m.status !== 'complete') continue;
    if (m.kind === 'deep_array') {
      if (!m.owner || !friendly.has(m.owner)) continue;
      const r = ARRAY_R * scale;
      sensors.push({ pos: m.pos, r2: r * r });
    }
    if (m.kind === 'null_field') {
      if (m.owner && friendly.has(m.owner)) continue;   // never your own
      const r = NULL_R * scale;
      blinds.push({ pos: m.pos, r2: r * r, system: m.system ?? null });
    }
  }
  return { sensors, blinds };
}

const inside = (pos, circles) => circles.some((c) => {
  const dx = pos.x - c.pos.x;
  const dy = pos.y - c.pos.y;
  return dx * dx + dy * dy <= c.r2;
});

const over = (pos, blinds = []) => blinds.filter((c) => {
  const dx = pos.x - c.pos.x;
  const dy = pos.y - c.pos.y;
  return dx * dx + dy * dy <= c.r2;
});

/** Mirrors revealedBy: reach, then the in-system-hull exception. */
function revealed(pos, sensors, blinds = []) {
  const cover = over(pos, blinds);
  return sensors.some((sen) => {
    const dx = pos.x - sen.pos.x;
    const dy = pos.y - sen.pos.y;
    if (dx * dx + dy * dy > sen.r2) return false;
    if (cover.length === 0) return true;
    // Only a sensor carrying the field's own system pierces it, and it
    // must pierce every field over the point.
    return !!sen.system && cover.every(b => b.system === sen.system);
  });
}

/** Mirrors computeSensorVisibleBodyIds. */
function visible(body, sensors, blinds) {
  if (body.type === 'megastructure') return inside(body.pos, sensors);
  return revealed(body.pos, sensors, blinds);
}

/** A ship's sensor bubble, tagged with the system the hull is sitting in. */
const shipSensor = (pos, r, system) => ({ pos, r2: r * r, system });

const at = (x, y) => ({ x, y });

// ---- the Array sees what nothing else would --------------------------
{
  const array = { kind: 'deep_array', status: 'complete', owner: 'me', pos: at(0, 0) };
  const { sensors, blinds } = build([array], ['me']);
  const near = { id: 'near', type: 'terrestrial', pos: at(ARRAY_R * 0.8, 0) };
  const far = { id: 'far', type: 'terrestrial', pos: at(ARRAY_R * 1.2, 0) };
  check('an Array reveals a body inside its bubble', visible(near, sensors, blinds));
  check('...and not one outside it', !visible(far, sensors, blinds));

  // It has to be a real upgrade on the widest thing you already own.
  const STATION = 400;
  check('an Array out-ranges a station, or it is not worth 20 freighter loads',
    ARRAY_R > STATION * 2, `${ARRAY_R} vs station ${STATION}`);
}

// ---- a rival's Array does nothing for you ----------------------------
{
  const theirs = { kind: 'deep_array', status: 'complete', owner: 'them', pos: at(0, 0) };
  const { sensors } = build([theirs], ['me']);
  check('a rival Array grants you nothing', sensors.length === 0);
  const allied = build([theirs], ['me', 'them']).sensors;
  check('...but an ally shares theirs', allied.length === 1);
}

// ---- an unfinished structure does nothing ----------------------------
{
  const half = { kind: 'deep_array', status: 'building', owner: 'me', pos: at(0, 0) };
  check('a half-built Array is not a sensor', build([half], ['me']).sensors.length === 0);
  const halfNull = { kind: 'null_field', status: 'building', owner: 'them', pos: at(0, 0) };
  check('a half-built Null Field blinds nobody', build([halfNull], ['me']).blinds.length === 0);
}

// ---- the Null Field takes vision away --------------------------------
{
  const theirField = { kind: 'null_field', status: 'complete', owner: 'them', pos: at(1000, 0) };
  const myArray = { kind: 'deep_array', status: 'complete', owner: 'me', pos: at(0, 0) };
  const { sensors, blinds } = build([theirField, myArray], ['me']);

  const hidden = { id: 'hidden', type: 'terrestrial', pos: at(1000, 0) };
  check('a body inside a rival Null Field is hidden even under an Array',
    !visible(hidden, sensors, blinds));

  const outside = { id: 'edge', type: 'terrestrial', pos: at(1000 - NULL_R * 1.1, 0) };
  check('...while a body just outside the field is still seen',
    visible(outside, sensors, blinds));

  // The field's own body stays on the map.
  const fieldBody = { id: 'nf', type: 'megastructure', pos: at(1000, 0) };
  check('the field itself remains visible — a void that hides its cause reads as a bug',
    visible(fieldBody, sensors, blinds));
}

// ---- no amount of coverage defeats a field ---------------------------
{
  const theirField = { kind: 'null_field', status: 'complete', owner: 'them', pos: at(0, 0) };
  // Twenty arrays stacked on the spot.
  const many = [theirField];
  for (let i = 0; i < 20; i++) {
    many.push({ kind: 'deep_array', status: 'complete', owner: 'me', pos: at(i * 5, 0) });
  }
  const { sensors, blinds } = build(many, ['me']);
  const hidden = { id: 'h', type: 'terrestrial', pos: at(0, 0) };
  check('twenty Arrays do not out-vote one Null Field',
    !visible(hidden, sensors, blinds), `${sensors.length} sensors, still hidden`);
}

// ---- your own field never blinds you ---------------------------------
{
  const mine = { kind: 'null_field', status: 'complete', owner: 'me', pos: at(0, 0) };
  const myArray = { kind: 'deep_array', status: 'complete', owner: 'me', pos: at(0, 0) };
  const { sensors, blinds } = build([mine, myArray], ['me']);
  check('your own Null Field does not blind you', blinds.length === 0);
  check('...so you still see what is inside it',
    visible({ id: 'x', type: 'terrestrial', pos: at(50, 0) }, sensors, blinds));

  // An ally's is yours too — a shared jammer that blinded the alliance
  // would make the structure unusable in any coalition.
  const allyField = { kind: 'null_field', status: 'complete', owner: 'ally', pos: at(0, 0) };
  check("an ally's Null Field does not blind you either",
    build([allyField], ['me', 'ally']).blinds.length === 0);
}

// ---- both ranges follow the map --------------------------------------
{
  for (const scale of [1, 4, 8]) {
    const a = build([{ kind: 'deep_array', status: 'complete', owner: 'me', pos: at(0, 0) }], ['me'], scale);
    const n = build([{ kind: 'null_field', status: 'complete', owner: 'them', pos: at(0, 0) }], ['me'], scale);
    check(`scale ${scale}: the Array bubble scales with the map`,
      Math.abs(Math.sqrt(a.sensors[0].r2) - ARRAY_R * scale) < 1e-6);
    check(`scale ${scale}: the Null Field does too`,
      Math.abs(Math.sqrt(n.blinds[0].r2) - NULL_R * scale) < 1e-6);
  }
}

// ---- the field is smaller than the array it counters ------------------
{
  // Deliberate: a jammer that out-ranged the widest sensor would make
  // one structure cancel a whole track rather than contest it.
  check('a Null Field hides less than an Array reveals',
    NULL_R < ARRAY_R, `${NULL_R} vs ${ARRAY_R}`);
}


// ---- the one exception: a hull in the same system --------------------
//
// A jammer beats telescopes and Arrays reading a system from outside. It
// does not beat a destroyer parked in the next orbit — and Lorne's rule
// is that this is the ONLY thing it does not beat. Everything below is
// that sentence, taken apart.
{
  const SHIP_R = 300;
  const theirField = {
    kind: 'null_field', status: 'complete', owner: 'them',
    pos: at(0, 0), system: 'jupiter',
  };
  const { blinds } = build([theirField], ['me']);
  const hidden = { id: 'moon', type: 'moon', pos: at(0, 0) };

  const inSystem = [shipSensor(at(0, 0), SHIP_R, 'jupiter')];
  check('a hull in the same system sees through the field',
    visible(hidden, inSystem, blinds));

  const elsewhere = [shipSensor(at(0, 0), SHIP_R, 'mars')];
  check('...a hull from another system, standing in the same place, does not',
    !visible(hidden, elsewhere, blinds));

  // Settlements and Arrays never carry a system, so they are blinded
  // without exception however close they happen to be.
  const groundLike = [{ pos: at(0, 0), r2: SHIP_R * SHIP_R }];
  check('a settlement or Array is blinded even at zero range',
    !visible(hidden, groundLike, blinds));

  // The exception must not become "any coverage wins" by the back door.
  const manyGround = [];
  for (let i = 0; i < 20; i++) manyGround.push({ pos: at(i, 0), r2: SHIP_R * SHIP_R });
  check('twenty ground sensors still lose to one field',
    !visible(hidden, manyGround, blinds));
}

// ---- overlapping fields stack ----------------------------------------
//
// Parking a hull in one system must not open a hole through a SECOND
// jammer that also covers the point — otherwise two fields are weaker
// than one, which is the wrong direction for a structure this expensive.
{
  const SHIP_R = 300;
  const a1 = { kind: 'null_field', status: 'complete', owner: 'them', pos: at(0, 0), system: 'jupiter' };
  const a2 = { kind: 'null_field', status: 'complete', owner: 'them', pos: at(10, 0), system: 'saturn' };
  const { blinds } = build([a1, a2], ['me']);
  const hidden = { id: 'x', type: 'moon', pos: at(5, 0) };

  const jupiterHull = [shipSensor(at(5, 0), SHIP_R, 'jupiter')];
  check('a hull piercing only one of two overlapping fields still sees nothing',
    !visible(hidden, jupiterHull, blinds));

  const bothOff = [shipSensor(at(5, 0), SHIP_R, 'jupiter'), shipSensor(at(5, 0), SHIP_R, 'saturn')];
  check('...and two hulls, one per field, do not combine either',
    !visible(hidden, bothOff, blinds));
}

// ---- ships hide too, not just terrain --------------------------------
//
// The field applied to bodies and not to hulls, so it concealed the
// rocks a fleet flew past and left the fleet itself in plain view.
{
  const SHIP_R = 300;
  const theirField = {
    kind: 'null_field', status: 'complete', owner: 'them',
    pos: at(0, 0), system: 'jupiter',
  };
  const { blinds } = build([theirField], ['me']);
  const enemyPos = at(0, 0);

  const ground = [{ pos: at(0, 0), r2: SHIP_R * SHIP_R }];
  check('an enemy hull inside the field is hidden from ground sensors',
    !revealed(enemyPos, ground, blinds));

  const onSite = [shipSensor(at(0, 0), SHIP_R, 'jupiter')];
  check('...and visible to your hull in that system',
    revealed(enemyPos, onSite, blinds));
}

// The summary lives at the very END. It used to sit mid-file with a
// process.exit under it, so every case appended after it was dead code
// that reported nothing and passed silently.
console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
