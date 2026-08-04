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
  return (bodyId) => {
    const hit = cache.get(bodyId);
    if (hit) return hit;
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
