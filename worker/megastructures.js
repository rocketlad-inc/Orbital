// ============================================================
// Megastructures — the catalogue, and the maths for parking one.
//
// Everything here is PURE. The DB work lives in actions.js and room.js;
// this file is the part worth testing without a database, which is also
// the part most likely to be wrong: deriving an orbit from a point
// somebody clicked.
//
// KEEP THE CATALOGUE IN SYNC with src/game/megastructures.ts. The worker
// is a separate Cloudflare bundle and cannot import the React tree, so
// the table is duplicated and megastructureMirrors.test.ts parses both.
// ============================================================

/** Capture takes 30% of banked progress.
 *
 *  Same shape as damageDysonSphere: scale EVERY bucket by one ratio so
 *  the site always reads as a coherent "X% built". Scaling buckets
 *  independently would let a captor game completion by taking a site
 *  whose expensive resource happened to be full. */
export const CAPTURE_PROGRESS_KEPT = 0.7;

/** Body type marking a game_bodies row as a megastructure site. */
export const MEGA_BODY_TYPE = 'megastructure';

/**
 * The seven. `feature` is the research gate (see researchUnlocks.js);
 * `family` decides what completion does — a fixed structure switches on
 * where it stands, a mobile one launches as a hull and the site is spent.
 *
 * EFFECT NUMBERS LIVE HERE TOO, next to the price. They are the
 * part a player weighs against the cost, so keeping them in the same
 * table is what stops the picker quoting one figure while the tick
 * applies another. `range` values are in world units BEFORE
 * system_scale — the sensor pair multiply by the game's sensor scale
 * the same way every other range does, so a spread map does not quietly
 * shrink what an Array covers.
 */
export const MEGASTRUCTURES = {
  warp_gate: {
    label: 'Warp Gate',
    family: 'fixed',
    feature: 'mega.warpGate',
    cost: { metal: 5000, credits: 7000 },
    radius: 9,
    color: '#7fd4ff',
    blurb: 'Two-way transit to exactly one partner gate. Anyone may use it.',
    effect: {},
  },
  weapons_station: {
    label: 'Weapons Station',
    family: 'fixed',
    feature: 'mega.weaponsStation',
    cost: { metal: 7000, credits: 5000 },
    radius: 8,
    color: '#ff8a6b',
    blurb: 'Destroyer-tier guns with reach into transit lanes. Upgradable.',
    effect: { range: 700, damagePerTick: 22.5, targets: 3 },
  },
  gravity_sink: {
    label: 'Gravity Sink',
    family: 'fixed',
    feature: 'mega.gravitySink',
    cost: { metal: 4000, credits: 4000 },
    radius: 7,
    color: '#b98cff',
    blurb: 'Holds crossing ships for 8 ticks. You choose who is caught.',
    effect: { range: 500, holdTicks: 8 },
  },
  deep_array: {
    label: 'Deep Space Array',
    family: 'fixed',
    feature: 'mega.deepArray',
    cost: { metal: 3500, credits: 4500 },
    radius: 7,
    color: '#6ee7b7',
    blurb: 'A sensor bubble anywhere you can pay to put one.',
    effect: { sensorRange: 1100 },
  },
  null_field: {
    label: 'Null Field',
    family: 'fixed',
    feature: 'mega.nullField',
    cost: { metal: 4000, credits: 4000 },
    radius: 7,
    color: '#4a5f7a',
    blurb: 'Blinds rival sensors inside its radius.',
    effect: { blindRange: 700 },
  },
  mega_destroyer: {
    label: 'Mega Destroyer',
    family: 'mobile',
    feature: 'mega.megaDestroyer',
    cost: { metal: 12000, credits: 8000 },
    radius: 12,
    color: '#ff5e5e',
    blurb: 'Strips the terraforming off a world. Cannot use gates.',
    effect: {},
  },
  mobile_foundry: {
    label: 'Mobile Foundry',
    family: 'mobile',
    feature: 'mega.mobileFoundry',
    cost: { metal: 9000, credits: 11000 },
    radius: 11,
    color: '#ffb84d',
    blurb: 'A shipyard that moves. Four hulls at once, wherever it is.',
    effect: { buildSlots: 4 },
  },
};

export const MEGASTRUCTURE_KINDS = Object.keys(MEGASTRUCTURES);

/** Must match worker/orbitPos.js — an orbit derived with a different
 *  constant would drift away from where the player clicked. */
const TWO_PI = Math.PI * 2;
const ORBITAL_SPEED_SCALE = 0.7;

/** Where a body sits at tick t, in world space. Mirrors the walk done
 *  in state.js: a moon's position is its parent's plus its own local
 *  offset, so the chain has to be resolved parent-first. */
export function bodyPositionAt(body, byId, tick) {
  if (!body) return null;
  let x = 0;
  let y = 0;
  // Walk up to the primary, accumulating offsets. Depth is 2 in
  // practice (star -> planet -> moon); the guard is against a cycle in
  // malformed data, not against real depth.
  let cur = body;
  for (let hops = 0; cur && hops < 8; hops++) {
    const r = Number(cur.orbit_radius) || 0;
    if (r > 0) {
      const a = (Number(cur.angle0) || 0)
        + (Number(cur.orbit_period) > 0
          ? (TWO_PI * tick * ORBITAL_SPEED_SCALE) / Number(cur.orbit_period)
          : 0);
      x += Math.cos(a) * r;
      y += Math.sin(a) * r;
    }
    cur = cur.parent_body_id ? byId.get(cur.parent_body_id) : null;
  }
  return { x, y };
}

/**
 * Which body's sphere of influence owns a point.
 *
 * Innermost wins: a point inside Io's SOI is inside Jupiter's too, and
 * the moon is the more specific answer. Bodies with no SOI (and the
 * primary, whose SOI is the whole system) are not candidates — a site
 * out in open space falls through to the star and orbits it directly.
 */
export function soiHolderAt(point, bodies, tick) {
  const byId = new Map(bodies.map(b => [b.id, b]));
  let best = null;
  let bestSoi = Infinity;
  for (const b of bodies) {
    const soi = Number(b.soi) || 0;
    if (soi <= 0) continue;
    if (b.type === MEGA_BODY_TYPE) continue;   // sites do not capture sites
    const pos = bodyPositionAt(b, byId, tick);
    if (!pos) continue;
    const d = Math.hypot(point.x - pos.x, point.y - pos.y);
    if (d <= soi && soi < bestSoi) { best = b; bestSoi = soi; }
  }
  // Nothing claimed it: it belongs to the primary, the body with no parent.
  return best ?? bodies.find(b => !b.parent_body_id) ?? null;
}

/**
 * The period a satellite of `parent` would have at radius r.
 *
 * CALIBRATED FROM THE PARENT'S OWN MOONS rather than computed from mu.
 * The catalogue's periods are authored and then rescaled by system_scale,
 * moon_scale and outer_orbit_speedup before they reach the database, so
 * a period derived from the mu column would disagree with every real
 * body in the same system — a site would visibly drift against the moons
 * beside it. Taking k = T/r^1.5 from an actual sibling reproduces
 * whatever convention that game ended up with, including the speed-ups.
 *
 * Falls back to the mu relation only when the parent has no satellites
 * at all, which is the case for a lone planet.
 */
export function periodForRadius(parent, radius, bodies) {
  const r = Math.max(1e-6, Number(radius) || 0);
  const kids = bodies.filter(
    b => b.parent_body_id === parent.id
      && b.type !== MEGA_BODY_TYPE
      && Number(b.orbit_radius) > 0
      && Number(b.orbit_period) > 0,
  );
  if (kids.length > 0) {
    // Average k across siblings. One sibling is enough; averaging keeps
    // a single oddly-tuned moon from setting the rule for the system.
    const k = kids.reduce(
      (s, b) => s + Number(b.orbit_period) / Math.pow(Number(b.orbit_radius), 1.5),
      0,
    ) / kids.length;
    return k * Math.pow(r, 1.5);
  }
  const mu = Number(parent.mu) || 0;
  if (mu > 0) return TWO_PI * Math.sqrt(Math.pow(r, 3) / mu);
  return 0;   // static: no orbit information available at all
}

/**
 * Turn a clicked point into the orbit a site placed there would hold.
 *
 * angle0 is BACK-SOLVED from the current tick, so the site appears
 * exactly where it was placed and only then starts moving. Deriving it
 * any other way puts the foundation somewhere the player did not click,
 * which reads as a bug however correct the orbit is.
 */
export function deriveSiteOrbit(point, bodies, tick) {
  const parent = soiHolderAt(point, bodies, tick);
  if (!parent) return null;
  const byId = new Map(bodies.map(b => [b.id, b]));
  const centre = bodyPositionAt(parent, byId, tick) ?? { x: 0, y: 0 };
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  const orbitRadius = Math.hypot(dx, dy);
  const orbitPeriod = periodForRadius(parent, orbitRadius, bodies);
  const thetaNow = Math.atan2(dy, dx);
  const advance = orbitPeriod > 0
    ? (TWO_PI * tick * ORBITAL_SPEED_SCALE) / orbitPeriod
    : 0;
  // Normalised into [0, 2pi) so the stored value is comparable and does
  // not grow without bound in a long game.
  const angle0 = ((thetaNow - advance) % TWO_PI + TWO_PI) % TWO_PI;
  return {
    parent_body_id: parent.id,
    orbit_radius: orbitRadius,
    orbit_period: orbitPeriod,
    angle0,
  };
}

/** 0..1, how far along a site is. Both resources must be satisfied, so
 *  progress is the WORSE of the two — a site with all its metal and no
 *  credits is not half done in any sense that matters. */
export function progressOf(row) {
  const m = Number(row.cost_metal) || 0;
  const c = Number(row.cost_credits) || 0;
  const pm = m > 0 ? Math.min(1, (Number(row.acc_metal) || 0) / m) : 1;
  const pc = c > 0 ? Math.min(1, (Number(row.acc_credits) || 0) / c) : 1;
  return Math.min(pm, pc);
}

export function isComplete(row) {
  return (Number(row.acc_metal) || 0) >= (Number(row.cost_metal) || 0)
    && (Number(row.acc_credits) || 0) >= (Number(row.cost_credits) || 0);
}

/** What a site still wants, for the inspector and for route planning. */
export function remainingFor(row) {
  return {
    metal: Math.max(0, (Number(row.cost_metal) || 0) - (Number(row.acc_metal) || 0)),
    credits: Math.max(0, (Number(row.cost_credits) || 0) - (Number(row.acc_credits) || 0)),
  };
}

/** Progress after a capture. Proportional across both buckets. */
export function applyCapture(row) {
  return {
    acc_metal: (Number(row.acc_metal) || 0) * CAPTURE_PROGRESS_KEPT,
    acc_credits: (Number(row.acc_credits) || 0) * CAPTURE_PROGRESS_KEPT,
  };
}
