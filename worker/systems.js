// ============================================================================
// systems.js — planetary systems, server-side, and the senate vote weight
// derived from them.
//
// This is the SERVER mirror of src/game/systemGrouping.ts. The two must
// agree: the fleet panel, the outliner and the map already head their
// groups with "Jupiter System" / "The Core", and a senate that counted
// something else would be explaining a number nobody can see on screen.
//
// GROUPING is planetary, not stellar. Orbital has exactly one star, so
// "star system" would put every body in the game in one bucket. A system
// is the body one level below the star plus everything orbiting it:
// Jupiter + the Galileans, Earth + Luna, Saturn + its moons. A lone rock
// that orbits the star directly is its own system.
//
// CONTROL is strict plurality: you control a system when you own MORE of
// its bodies than any other faction. A tie means the system is contested
// and grants nobody a vote — which is the point. Contested space should
// cost you politically until you finish taking it.
//
// WEIGHT is 1 + one per system controlled. The floor of 1 matters: a
// faction that has lost every world still gets a voice on the floor,
// which is the difference between a senate and a scoreboard.
//
// Why this replaced body-count weight: counting bodies made the senate a
// prize for grabbing moons. Owning Jupiter and its four Galileans was
// five votes for what is, strategically, one place — so the cheapest
// path to political power was hoovering up rocks nobody would ever
// fight over. Systems are the unit players actually campaign for.
// ============================================================================

/** Barycenter anchors orbit the star on a fake, effectively-infinite
 *  period. Real bodies top out near 4.7e4, so there's no ambiguity.
 *  Mirrors PRETEND_ORBIT_PERIOD in systemGrouping.ts. */
const PRETEND_ORBIT_PERIOD = 1e9;

/** Sol, Mercury and Venus read as one place. Splitting them into three
 *  systems — two of which are a single scorched rock apiece — is noise.
 *  These are TEMPLATE ids; a DB body id is `<gameId>:<template>`. */
export const CORE_TEMPLATES = new Set(['sol', 'mercury', 'venus']);
export const CORE_SYSTEM_ID = 'core';
export const CORE_LABEL = 'The Core';

/** One-line rule, used verbatim everywhere the senate is explained.
 *  Exported so the Discord card, the in-game panel and the docs can't
 *  drift into describing three different games. */
export const WEIGHT_RULE =
  'Vote weight = 1 + 1 per system you control. You control a system when '
  + 'you own more of its bodies than any other faction; a tie leaves it '
  + 'contested and worth nothing to anyone.';

/** A star or barycenter — the thing planets orbit. Never heads a system. */
function isStellarAnchor(b) {
  return !b.parent_body_id
    || b.type === 'star'
    || b.type === 'black_hole'
    || (b.orbit_period ?? 0) >= PRETEND_ORBIT_PERIOD;
}

// ---------------------------------------------------------------------------
// Belts — mirror of findBelts() in src/game/systemGrouping.ts.
//
// A run of rubble in neighbouring orbits is ONE place. Without this the
// asteroid belt was eight systems and eight votes, so the cheapest route
// to political power was grabbing pebbles nobody contests.
//
// These constants MUST match the client's. The map draws one "Asteroid
// Belt" lane; if the senate counted eight, the number on the vote card
// would contradict the picture the player is looking at.
// ---------------------------------------------------------------------------

const BELT_RATIO = 1.25;
const BELT_MIN_MEMBERS = 3;
const ROGUE_ECCENTRICITY_RATIO = 1.5;

function isBeltable(b) {
  return b.type === 'asteroid' || b.type === 'dwarf';
}

/**
 * A rogue on a long ellipse occupies no RING — it crosses a dozen.
 * Black Sky runs 400->4000, Vagrant 500->5300, Augustín 600->7000.
 *
 * This test exists only to keep them out of belt GEOMETRY (the map's
 * political wash). They ARE belt members everywhere else, votes
 * included: a Kuiper object is a Kuiper object. See members vs
 * laneMembers on the returned belts.
 */
function isEccentricRogue(b) {
  const rp = b.orbit_rp;
  const ra = b.orbit_ra;
  if (rp == null || ra == null || rp <= 0) return false;
  return ra > rp * ROGUE_ECCENTRICITY_RATIO;
}

/**
 * Cluster star-orbiting rubble into belts. Naming is structural: a belt
 * whose median orbit sits inside the outermost planet system is an
 * asteroid belt, beyond it a Kuiper belt — so it stays sensible for any
 * seeded system, not just Sol.
 *
 * Returns [{ id, label, members }].
 */
export function findBelts(bodies) {
  const childCount = new Map();
  for (const b of bodies) {
    if (b.parent_body_id) {
      childCount.set(b.parent_body_id, (childCount.get(b.parent_body_id) ?? 0) + 1);
    }
  }
  const anchors = new Set(bodies.filter(isStellarAnchor).map(b => b.id));

  const isRubble = (b) => !!b.parent_body_id && anchors.has(b.parent_body_id)
    && !childCount.get(b.id) && isBeltable(b);

  // Clustering runs on ring-dwellers ONLY — a rogue's nominal radius is
  // a fiction and would decide where the chain breaks.
  const rubble = bodies
    .filter(b => isRubble(b) && !isEccentricRogue(b))
    .sort((a, b) => (a.orbit_radius ?? 0) - (b.orbit_radius ?? 0));

  const clusters = [];
  for (const b of rubble) {
    const last = clusters[clusters.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && (b.orbit_radius ?? 0) <= (prev.orbit_radius ?? 0) * BELT_RATIO) last.push(b);
    else clusters.push([b]);
  }

  const planetRadii = bodies
    .filter(b => b.parent_body_id && anchors.has(b.parent_body_id)
      && (childCount.get(b.id) ?? 0) > 0)
    .map(b => b.orbit_radius ?? 0);
  const outermostPlanetSystem = planetRadii.length ? Math.max(...planetRadii) : Infinity;

  const belts = [];
  let inner = 0, outer = 0;
  for (const cluster of clusters) {
    if (cluster.length < BELT_MIN_MEMBERS) continue;
    const radii = cluster.map(b => b.orbit_radius ?? 0);
    const median = radii[Math.floor(radii.length / 2)];
    const label = median < outermostPlanetSystem
      ? (inner++ === 0 ? 'Asteroid Belt' : `Inner Belt ${inner}`)
      : (outer++ === 0 ? 'Kuiper Belt' : `Outer Belt ${outer}`);
    belts.push({
      id: `belt:${Math.round(median)}`, label,
      members: cluster.slice(), laneMembers: cluster,
    });
  }

  // Fold the rogues in as MEMBERS. A Kuiper object is a Kuiper object:
  // it belongs to the belt for grouping, ownership and votes, but never
  // joins laneMembers, so the map's political wash is unaffected.
  //
  // Placed by APOAPSIS, not nominal radius — Black Sky's nominal 2200
  // sits inside Pluto's orbit and would file as inner-belt, but it
  // reaches 4000, past every planet system. Reach is where a crossing
  // orbit actually lives.
  const beltClass = (belt) => {
    const radii = belt.laneMembers.map(m => m.orbit_radius ?? 0);
    return radii[Math.floor(radii.length / 2)] < outermostPlanetSystem ? 'inner' : 'outer';
  };
  for (const b of bodies) {
    if (!isRubble(b) || !isEccentricRogue(b)) continue;
    const reach = b.orbit_ra ?? b.orbit_radius ?? 0;
    const want = reach < outermostPlanetSystem ? 'inner' : 'outer';
    const host = belts.find(belt => beltClass(belt) === want);
    // No belt of that class here — the rogue stays its own system rather
    // than being filed under a belt that doesn't exist.
    if (host) host.members.push(b);
  }
  return belts;
}

/** Memoized per bodies-array so the resolver and the labeller agree
 *  without re-clustering on every lookup. */
const beltCache = new WeakMap();
function beltsOf(bodies) {
  const hit = beltCache.get(bodies);
  if (hit) return hit;
  const byBody = new Map();
  const byId = new Map();
  for (const belt of findBelts(bodies)) {
    byId.set(belt.id, belt);
    // members, not laneMembers — a rogue roots to its belt even though
    // it is absent from the belt's shaded lane.
    for (const m of belt.members) byBody.set(m.id, belt);
  }
  const built = { byBody, byId };
  beltCache.set(bodies, built);
  return built;
}

function templateOf(b) {
  if (b.template_id) return b.template_id;
  const colon = String(b.id).indexOf(':');
  return colon === -1 ? String(b.id) : String(b.id).slice(colon + 1);
}

/**
 * Build a memoized `bodyId -> system root key` resolver.
 *
 * Climb the parent chain until the next step would land on a star, and
 * stop there: Titan and Enceladus both root to Saturn, Saturn roots to
 * itself, Ceres roots to itself. Cycle-guarded — a malformed chain
 * degrades to "own system" rather than hanging a vote.
 *
 * `bodies` rows need: id, parent_body_id, type, orbit_period, and
 * ideally template_id (derived from the id if absent).
 */
export function makeSystemRootOf(bodies) {
  const byId = new Map(bodies.map(b => [b.id, b]));
  const cache = new Map();
  const belts = beltsOf(bodies);
  return (bodyId) => {
    const hit = cache.get(bodyId);
    if (hit) return hit;
    // Belt membership outranks the parent walk: a belt rock's parent IS
    // the star, so without this it would root to itself.
    const belt = belts.byBody.get(bodyId);
    if (belt) { cache.set(bodyId, belt.id); return belt.id; }
    const chain = [];
    let cur = byId.get(bodyId);
    const seen = new Set();
    while (cur && !isStellarAnchor(cur) && !seen.has(cur.id)) {
      const parent = cur.parent_body_id ? byId.get(cur.parent_body_id) : undefined;
      if (!parent || isStellarAnchor(parent)) break;
      seen.add(cur.id);
      chain.push(cur.id);
      cur = parent;
    }
    const raw = cur?.id ?? bodyId;
    // Collapse applied to the ROOT, not the body, so a moon of Venus
    // follows its planet into the Core instead of heading its own system.
    const root = (cur && CORE_TEMPLATES.has(templateOf(cur))) ? CORE_SYSTEM_ID : raw;
    for (const id of chain) cache.set(id, root);
    cache.set(bodyId, root);
    return root;
  };
}

/** Display name for a system root. Mirrors systemLabel() client-side:
 *  only roots that actually hold satellites earn the "System" suffix —
 *  "Midas System" for one bare asteroid is pretend grandeur. */
export function systemLabel(bodies, rootId) {
  if (rootId === CORE_SYSTEM_ID) return CORE_LABEL;
  const belt = beltsOf(bodies).byId.get(rootId);
  if (belt) return belt.label;
  const root = bodies.find(b => b.id === rootId);
  if (!root) return rootId;
  const name = String(root.name ?? '').replace(/\s*Barycenter$/i, '');
  if (isStellarAnchor(root)) return name || rootId;
  const hasSatellites = bodies.some(b => b.parent_body_id === rootId);
  return hasSatellites ? `${name} System` : name;
}

/**
 * Roll every body up into its system and work out who holds each one.
 *
 * Returns an array of
 *   { rootId, label, total, counts: {factionId: n}, controller, contested }
 * ordered by system size, biggest first.
 *
 * `controller` is the strict plurality owner, or null when the system is
 * unowned or tied. `contested` distinguishes "two factions deadlocked
 * here" from "nobody has touched this yet" — the senate treats them the
 * same, but the UI shouldn't.
 */
export function summarizeSystems(bodies) {
  const rootOf = makeSystemRootOf(bodies);
  const systems = new Map();
  for (const b of bodies) {
    // A STRUCTURE IS NOT TERRITORY. Megastructure sites are bodies and
    // carry owner_faction_id, so this tally counted them as ground held
    // — and control is strict plurality, which means three cheap gates
    // parked around Neptune took the Neptune system in the senate
    // without a single settlement. Senate weight is one vote per system
    // controlled, so that was real, continuous political power bought
    // with construction freight rather than colonisation.
    if (b.type === 'megastructure') continue;
    const rootId = rootOf(b.id);
    let sys = systems.get(rootId);
    if (!sys) {
      sys = { rootId, label: systemLabel(bodies, rootId), total: 0, counts: {} };
      systems.set(rootId, sys);
    }
    sys.total += 1;
    const owner = b.owner_faction_id;
    if (owner) sys.counts[owner] = (sys.counts[owner] ?? 0) + 1;
  }

  const out = [];
  for (const sys of systems.values()) {
    let best = null, bestN = 0, tied = false;
    for (const [fid, n] of Object.entries(sys.counts)) {
      if (n > bestN) { best = fid; bestN = n; tied = false; }
      else if (n === bestN && bestN > 0) tied = true;
    }
    out.push({
      ...sys,
      controller: tied ? null : best,
      held: bestN,
      contested: tied,
    });
  }
  out.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  return out;
}

/**
 * Vote weight for every faction in the game: 1 + systems controlled.
 *
 * Takes ALL undestroyed bodies (ownership is global truth — fog of war
 * masks what a PLAYER sees, never what the senate counts) plus the list
 * of faction ids, so factions holding nothing still appear at their
 * floor of 1 rather than vanishing from the map of the chamber.
 */
export function voteWeights(bodies, factionIds = []) {
  const weights = new Map();
  for (const id of factionIds) weights.set(id, 1);
  for (const sys of summarizeSystems(bodies)) {
    if (!sys.controller) continue;
    weights.set(sys.controller, (weights.get(sys.controller) ?? 1) + 1);
  }
  return weights;
}

/**
 * One faction's weight, with the systems that produced it — so a player
 * asking "why is my vote worth 4?" gets an answer instead of a number.
 */
export function weightBreakdown(bodies, factionId) {
  const systems = summarizeSystems(bodies);
  const controlled = systems
    .filter(s => s.controller === factionId)
    .map(s => ({ label: s.label, held: s.held, total: s.total }));
  // Systems where you hold ground but don't lead — the actionable list.
  const contesting = systems
    .filter(s => s.controller !== factionId && (s.counts[factionId] ?? 0) > 0)
    .map(s => {
      const mine = s.counts[factionId] ?? 0;
      // Control needs STRICTLY more than the leader, so one past them.
      // In a tie you are the leader, and one more body breaks it.
      return {
        label: s.label,
        held: mine,
        total: s.total,
        need: s.held - mine + 1,
        contested: s.contested,
      };
    });
  return { weight: 1 + controlled.length, base: 1, controlled, contesting };
}
