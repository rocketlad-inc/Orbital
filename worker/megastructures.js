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
 * Gravitational parameter a site is given, so hulls parked at one
 * orbit it the way they orbit a WORLD.
 *
 * Earth's value, chosen for exactly that reason: parked ships sit at
 * roughly the same ring radius everywhere, so matching Earth's mu
 * makes a lap round a gate take the same time as a lap round a planet.
 * Sites were stored with mu = 0 and only orbited at all because muOf
 * falls through to 100 for an unrecognised type — the right number by
 * accident, which is the kind of thing that changes under you the
 * first time somebody tidies a default.
 */
export const MEGA_MU = 100;

/**
 * Hull points on a structure, uniform across kinds.
 *
 * Taking one used to be a presence check — park an armed hull, have
 * nobody else's there, done. Nothing that costs twelve thousand metal
 * should change hands because a corvette drifted past it, so a site is
 * now something you break before you board.
 *
 * Uniform at 3000 on purpose: a Mega Destroyer scaffold is no tougher
 * than a null field because neither is armoured. What makes a structure
 * hard to take is the fleet its owner keeps parked on it.
 *
 * KEEP IN SYNC with src/game/megastructures.ts — megastructureMirrors
 * parses both files.
 */
export const MEGA_MAX_HP = 3000;

/** Below this fraction of max HP a structure can be boarded, and a
 *  finished one stops working. */
export const MEGA_SEIZE_HP_FRAC = 0.2;

/** Points repaired per tick while nothing hostile is parked on it. This
 *  is what stops a single corvette grinding a site down over two
 *  hundred unattended ticks: to take a structure you have to commit
 *  force and KEEP it there. */
export const MEGA_REGEN_PER_TICK = 12;

/** The HP at or below which a structure is breached. */
export const MEGA_BREACH_HP = MEGA_MAX_HP * MEGA_SEIZE_HP_FRAC;

/**
 * Weapon mounts a Weapons Station is built with.
 *
 * Its gun was a flat 22.5 — the damage a destroyer HULL does with no
 * mounts fitted, which is to say a ship nobody flies. Ships get
 * 0.40 x (1 + 0.10 x weaponsLvl) per mount, so a six-mount destroyer at
 * Weapons 10 fires for 130.5 while the station stayed at 22.5 forever.
 * The most expensive emplacement in the game was frozen at the power of
 * a hull straight off the slipway, and fell further behind every level
 * the owner researched — the one structure whose blurb promised
 * "destroyer-tier guns".
 *
 * Three mounts rather than a destroyer's six, because it fires on three
 * targets at once: the same total output as a well-fitted destroyer,
 * spread rather than concentrated. That is the trade an emplacement
 * makes, and it is what Lorne asked for.
 */
export const STATION_WEAPON_MOUNTS = 3;

/** Per-mount damage bonus, mirroring WEAPON_DMG_PCT in shipDesigns.js. */
const STATION_MOUNT_PCT = 0.40;
/** Per-level boost to a mount, mirroring WEAPONS_TECH_PER_LVL. */
const STATION_TECH_PER_LVL = 0.10;

/**
 * What a Weapons Station actually fires for, at a given Weapons level.
 * Same curve ships ride, so researching Weapons finally does something
 * for the thing you bought to hold a lane.
 */
export function stationDamage(baseDamage, weaponsLvl) {
  const lvl = Math.max(0, Number(weaponsLvl) || 0);
  const bonus = STATION_MOUNT_PCT * (1 + STATION_TECH_PER_LVL * lvl) * STATION_WEAPON_MOUNTS;
  return (Number(baseDamage) || 0) * (1 + bonus);
}

/**
 * May this faction pour freight into that site?
 *
 * Supplying was locked to the owner because a captured site kept being
 * fed by its old owner's standing routes — a bug, and an expensive one.
 * This is the sanctioned version of the same act: an active
 * construction pact opens the door generally, and the owner can still
 * shut it on one specific project.
 *
 * BOTH GATES, in that order. The pact is the relationship; the
 * exclusion is the veto. A partner you trust with your gate network is
 * not necessarily a partner you want inside the weapons station you are
 * building on their border, and making them tear up the whole treaty to
 * express that would be a worse game.
 */
export function maySupplySite(factionId, ownerFactionId, pactPartnerIds, excludedIds) {
  if (!factionId) return false;
  if (factionId === ownerFactionId) return true;          // your own site
  if (!ownerFactionId) return false;                      // ancient: nobody's to fund
  // The set is MY partners, so the question is whether the OWNER is in
  // it — not whether I am. Asking the wrong way round refuses every
  // legitimate co-build while looking entirely reasonable, which is
  // exactly what it did until a live pact failed to open the door.
  const partners = pactPartnerIds instanceof Set
    ? pactPartnerIds : new Set(pactPartnerIds ?? []);
  if (!partners.has(ownerFactionId)) return false;
  return !(excludedIds ?? []).includes(factionId);
}

/**
 * Factions this one holds an ACTIVE construction pact with.
 *
 * One definition, shared by all four places freight can enter a site —
 * the route validator, the route-creation endpoint, hand delivery, and
 * the tick's unload. The first three of those already disagreed with
 * each other once about who may supply a structure, which is how a
 * captured site went on being fed for free.
 */
export async function constructionPartners(env, gameId, factionId, tick) {
  const rows = (await env.DB
    .prepare(
      `SELECT ts2.faction_id AS partner
         FROM treaties t
         JOIN treaty_signatories ts  ON ts.treaty_id  = t.id AND ts.faction_id = ?
         JOIN treaty_signatories ts2 ON ts2.treaty_id = t.id AND ts2.faction_id <> ?
        WHERE t.game_id = ?
          AND t.kind = 'construction_pact'
          AND t.status = 'active'
          AND t.broken_at_tick IS NULL
          AND ts.signed_at_tick IS NOT NULL
          AND ts2.signed_at_tick IS NOT NULL
          AND (t.expires_at_tick IS NULL OR t.expires_at_tick > ?)`,
    )
    .bind(factionId, factionId, gameId, tick)
    .all()).results ?? [];
  return new Set(rows.map(r => r.partner));
}

/** Factions excluded from funding this specific site, off settings_json. */
export function excludedFundersOf(settingsJson) {
  try {
    const cfg = settingsJson ? JSON.parse(settingsJson) : null;
    return Array.isArray(cfg?.no_fund)
      ? cfg.no_fund.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}

/**
 * How long a gate trip takes, as a fraction of the ordinary burn.
 *
 * A gate does not teleport and it does not need a cooldown — it FLINGS
 * you. A crossing that would take ten ticks under your own engines
 * takes three (2.5, rounded up), and the hull is genuinely in flight for
 * those ticks: visible, interceptable, and catchable by a Gravity Sink
 * like anything else under burn.
 *
 * Tying it to the replaced flight rather than a flat number is what
 * keeps distance meaningful. A gate across the system still saves you
 * most of a week; two gates in one neighbourhood save almost nothing,
 * because there was almost nothing to save.
 *
 * KEEP IN SYNC with src/game/megastructures.ts.
 */
export const GATE_TRANSIT_FRACTION = 0.25;

/** Ticks a gate crossing takes, given what the same burn would cost
 *  under its own engine. Mirror of src/game/megastructures.ts. */
export function gateTransitTicks(normalTicks) {
  const t = Number(normalTicks);
  if (!Number.isFinite(t) || t <= 0) return 1;
  return Math.max(1, Math.ceil(t * GATE_TRANSIT_FRACTION));
}

/**
 * Is this structure derelict and free to claim?
 *
 * An ANCIENT gate is also unowned and must never be claimable — one
 * faction holding the map's only permanent crossing would be a
 * different game. The two are told apart by their history: an ancient
 * has no founder and no abandonment date, an abandoned structure has
 * both. Checking only for a NULL owner would hand the ancients to
 * whoever flew past first.
 */
export function isAbandoned(site) {
  return !site?.owner_faction_id
    && site?.abandoned_at_tick != null
    && site?.founded_by_faction_id != null;
}

/** Breached: boardable, and offline if it was finished. */
export function isBreached(hp) {
  return (Number(hp) || 0) <= MEGA_BREACH_HP;
}

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
    radius: 1.9,
    color: '#7fd4ff',
    blurb: 'Two-way transit to exactly one partner gate. Anyone may use it.',
    effect: {},
  },
  weapons_station: {
    label: 'Weapons Station',
    family: 'fixed',
    feature: 'mega.weaponsStation',
    cost: { metal: 7000, credits: 5000 },
    radius: 1.6,
    color: '#ff8a6b',
    blurb: 'Destroyer-tier guns with reach into transit lanes, and it fires on three at once.',
    effect: { range: 700, damagePerTick: 22.5, targets: 3 },
  },
  gravity_sink: {
    label: 'Gravity Sink',
    family: 'fixed',
    feature: 'mega.gravitySink',
    cost: { metal: 4000, credits: 4000 },
    radius: 1.5,
    color: '#b98cff',
    blurb: 'Holds crossing ships for 8 ticks. You choose who is caught.',
    effect: { range: 500, holdTicks: 8 },
  },
  deep_array: {
    label: 'Deep Space Array',
    family: 'fixed',
    feature: 'mega.deepArray',
    cost: { metal: 3500, credits: 4500 },
    radius: 1.5,
    color: '#6ee7b7',
    blurb: 'A sensor bubble anywhere you can pay to put one.',
    effect: { sensorRange: 1100 },
  },
  null_field: {
    label: 'Null Field',
    family: 'fixed',
    feature: 'mega.nullField',
    cost: { metal: 4000, credits: 4000 },
    radius: 1.4,
    color: '#4a5f7a',
    blurb: 'Blinds rival sensors inside its radius.',
    effect: { blindRange: 700 },
  },
  mega_destroyer: {
    label: 'Mega Destroyer',
    family: 'mobile',
    feature: 'mega.megaDestroyer',
    cost: { metal: 12000, credits: 8000 },
    radius: 1.8,
    color: '#ff5e5e',
    blurb: 'Strips the terraforming off a world. Cannot use gates.',
    effect: {},
  },
  mobile_foundry: {
    label: 'Mobile Foundry',
    family: 'mobile',
    feature: 'mega.mobileFoundry',
    cost: { metal: 9000, credits: 11000 },
    radius: 1.7,
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

/**
 * Extra concurrent build slots from Mobile Foundries parked at a body.
 *
 * A FOUNDRY IS A SHIPYARD THAT MOVES, so it has to satisfy both halves
 * of what a shipyard does: make a body buildable at all, and add
 * capacity once it is. Checking only the second would let a player queue
 * at a foundry parked over someone else's world but not over empty
 * space, which is precisely backwards — forward basing is the point.
 *
 * Lives here rather than in actions.js because BOTH the queue endpoint
 * and the tick's FIFO promoter need it, and room.js does not import
 * actions.js. Counting them differently is how a foundry's slots get
 * honoured when an order is accepted and ignored forever after.
 *
 * ACTIVE hulls only: a destroyed foundry stops being a shipyard the
 * moment it dies, including for orders already waiting.
 */
export async function foundrySlotsAt(env, gameId, bodyId, factionId) {
  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM game_ships
        WHERE game_id = ? AND parent_body_id = ? AND owner_faction_id = ?
          AND ship_class = 'mobile_foundry' AND status = 'active'`,
    )
    .bind(gameId, bodyId, factionId)
    .first();
  const n = Number(row?.n ?? 0);
  if (n <= 0) return 0;
  return n * Number(MEGASTRUCTURES.mobile_foundry?.effect?.buildSlots ?? 0);
}
