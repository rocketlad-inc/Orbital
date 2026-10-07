// ============================================================
// Exploration secrets — hidden surprises seeded onto non-capital
// bodies at game start. Revealed when a player ship first reaches
// the body; some effects fire once, some persist forever.
//
// Each kind is documented below the BODY_REGION_FILTERS block. The
// seeder picks bodies by category (inner / belt / outer / moon)
// so an "outer-system portal" can't accidentally land on Mercury.
// ============================================================

import { Body, BodySecret, BodySecretKind, Settlement } from '../types';
import { createCity } from './settlements';
import { tk } from '../i18n/core';

/**
 * Catalog of secrets the seeder draws from. Each entry declares
 * which body bucket it can attach to plus a human-readable display
 * string used by the discovery toast / combat log.
 */
export interface SecretDef {
  kind: BodySecretKind;
  displayName: string;
  discoveryMessage: string;
  /** Which body categories this secret can attach to. */
  hostCategories: BodyCategory[];
}

export type BodyCategory = 'inner' | 'belt' | 'outer' | 'moon-inner' | 'moon-outer';

export const SECRET_DEFS: Record<BodySecretKind, SecretDef> = {
  portal_to_sun: {
    kind: 'portal_to_sun',
    get displayName() { return tk('data.secret.portal_to_sun.name', 'Ancient Stargate'); },
    get discoveryMessage() { return tk('data.secret.portal_to_sun.found', 'DISCOVERY: an ancient stargate. Every ship arriving here will now be warped to Sol.'); },
    hostCategories: ['outer', 'moon-outer'],
  },
  // Warp gate is seeded outside the normal seedBodySecrets flow (see
  // src/state/singlePlayerSetup.ts seedWarpGates) — listed here so the
  // exhaustive Record<BodySecretKind, …> type is satisfied and any
  // inspector/log code that wants a display name has one. hostCategories
  // is intentionally empty so the regular seeder never picks it.
  warp_gate: {
    kind: 'warp_gate',
    get displayName() { return tk('data.secret.warp_gate.name', 'Warp Gate'); },
    get discoveryMessage() { return tk('data.secret.warp_gate.found', 'DISCOVERY: a warp gate. Arriving ships are transported across the void.'); },
    hostCategories: [],
  },
  ancient_city: {
    kind: 'ancient_city',
    get displayName() { return tk('data.secret.ancient_city.name', 'Ancient City Ruins'); },
    get discoveryMessage() { return tk('data.secret.ancient_city.found', 'DISCOVERY: a long-abandoned colony reactivates under your banner — a free city with a working Lab.'); },
    hostCategories: ['belt'],
  },
  free_collector: {
    kind: 'free_collector',
    get displayName() { return tk('data.secret.free_collector.name', 'Ancient Logistics Hub'); },
    get discoveryMessage() { return tk('data.secret.free_collector.found', 'DISCOVERY: a derelict freight hub still pings. Free city + collector — your logistics just widened.'); },
    hostCategories: ['moon-outer', 'moon-inner'],
  },
  // MP-only (terraforming rework): seeded server-side in
  // worker/factions.js, never by this SP seeder — hostCategories is
  // empty for the same reason warp_gate's is. Listed so MP inspector /
  // toast code has a display name for the revealed secret.
  pre_terraformed: {
    kind: 'pre_terraformed',
    get displayName() { return tk('data.secret.pre_terraformed.name', 'Pre-Terraformed World'); },
    get discoveryMessage() { return tk('data.secret.pre_terraformed.found', 'DISCOVERY: a world the ancients already prepped for life. Terraformed and waiting; claim it and build.'); },
    hostCategories: [],
  },
  derelict_warship: {
    kind: 'derelict_warship',
    get displayName() { return tk('data.secret.derelict_warship.name', 'Derelict Warship'); },
    get discoveryMessage() { return tk('data.secret.derelict_warship.found', 'DISCOVERY: a derelict destroyer is salvageable. Claimed.'); },
    hostCategories: ['belt', 'outer'],
  },
  resource_cache: {
    kind: 'resource_cache',
    get displayName() { return tk('data.secret.resource_cache.name', 'Hidden Resource Cache'); },
    get discoveryMessage() { return tk('data.secret.resource_cache.found', 'DISCOVERY: a buried cache — +500 metal + 500 credits to your pool.'); },
    hostCategories: ['inner', 'belt'],
  },
  ancient_databank: {
    kind: 'ancient_databank',
    get displayName() { return tk('data.secret.ancient_databank.name', 'Ancient Databank'); },
    get discoveryMessage() { return tk('data.secret.ancient_databank.found', 'DISCOVERY: an intact databank teaches your engineers a new trick — a free tech level.'); },
    hostCategories: ['moon-inner', 'moon-outer'],
  },
  // --- THE OUTER REACH. MP-only, seeded server-side in worker/factions.js
  // into the Plutinos, the Kuiper Belt and the Far Reach — bands this SP
  // seeder does not know about, so hostCategories is empty, as it is for
  // pre_terraformed. Listed so MP toasts and inspectors have a name.
  ancient_capital: {
    kind: 'ancient_capital',
    get displayName() { return tk('data.secret.ancient_capital.name', 'Derelict Capital Ship'); },
    get discoveryMessage() { return tk('data.secret.ancient_capital.found', 'DISCOVERY: a derelict capital ship drifting dark at the edge of the system. Claimed.'); },
    hostCategories: [],
  },
  ancient_relay: {
    kind: 'ancient_relay',
    get displayName() { return tk('data.secret.ancient_relay.name', 'Ancient Sensor Relay'); },
    get discoveryMessage() { return tk('data.secret.ancient_relay.found', 'DISCOVERY: an ancient sensor relay, still listening, answering to nobody. Breach it and seize it to make its eyes yours.'); },
    hostCategories: [],
  },
  ancient_station: {
    kind: 'ancient_station',
    get displayName() { return tk('data.secret.ancient_station.name', 'Ancient Weapons Station'); },
    get discoveryMessage() { return tk('data.secret.ancient_station.found', 'DISCOVERY: an ancient weapons station wakes and opens fire on everything in reach. Breach it and seize it to turn its guns.'); },
    hostCategories: [],
  },
  far_gate: {
    kind: 'far_gate',
    get displayName() { return tk('data.secret.far_gate.name', 'Ancient Gate Pair'); },
    get discoveryMessage() { return tk('data.secret.far_gate.found', 'DISCOVERY: an ancient gate, and its twin elsewhere in the outer system. The pair is live.'); },
    hostCategories: [],
  },
  deep_cache: {
    kind: 'deep_cache',
    get displayName() { return tk('data.secret.deep_cache.name', 'Deep Cache'); },
    get discoveryMessage() { return tk('data.secret.deep_cache.found', 'DISCOVERY: a deep cache sealed against the cold, worth a destroyer in metal and credits.'); },
    hostCategories: [],
  },
  // --- THE FAR SYSTEMS' SIGNATURE FINDS. MP-only, placed server-side by
  // worker/factions.js FAR_SECRET_PLAN; hostCategories empty like the rest.
  precursor_orrery: {
    kind: 'precursor_orrery',
    get displayName() { return tk('data.secret.precursor_orrery.name', 'Precursor Orrery'); },
    get discoveryMessage() { return tk('data.secret.precursor_orrery.found', 'DISCOVERY: a precursor orrery, built to follow the two suns and still turning. A working station, and it is yours.'); },
    hostCategories: [],
  },
  horizon_archive: {
    kind: 'horizon_archive',
    get displayName() { return tk('data.secret.horizon_archive.name', 'Horizon Archive'); },
    get discoveryMessage() { return tk('data.secret.horizon_archive.found', 'DISCOVERY: a record of everything the ancients measured at the event horizon. A windfall of science.'); },
    hostCategories: [],
  },
};

/**
 * Bucket a body into one of the categories the seeder picks from.
 * Cleanest classifier the seeder has — pure body-shape data, no
 * dependency on the rest of the game state.
 */
export function categorizeBody(body: Body, allBodies: Body[]): BodyCategory | null {
  if (body.type === 'star') return null;
  if (body.type === 'moon') {
    // "Outer" moon = parent is gas giant / ice giant or further out.
    const parent = allBodies.find(b => b.id === body.parent);
    if (parent && (parent.type === 'gas_giant' || parent.type === 'ice_giant')) return 'moon-outer';
    return 'moon-inner';
  }
  if (body.type === 'asteroid' || body.type === 'dwarf') return 'belt';
  // Terrestrial / gas-giant / ice-giant bucketed by orbital radius.
  // Inner = inside ~250 (Earth ~186, Mars ~245); Outer = beyond.
  if (body.orbitRadius < 250) return 'inner';
  return 'outer';
}

/**
 * Seed exploration secrets across the body catalog.
 *
 * @param bodies         the full body list (mutated in place is fine — we return a new list)
 * @param excludeBodyIds bodies that already belong to a starting faction; never get a secret
 * @param rand           injectable PRNG so map_seed produces a stable layout
 * @param kinds          which secrets to actually seed this game; defaults to the full catalog
 */
export function seedBodySecrets(
  bodies: Body[],
  excludeBodyIds: Set<string>,
  rand: () => number = Math.random,
  kinds: BodySecretKind[] = ['portal_to_sun', 'ancient_city', 'free_collector', 'derelict_warship', 'resource_cache', 'ancient_databank'],
): Body[] {
  // Pool of eligible bodies, grouped by category. We pull from a
  // category at random within the secret's allowed set.
  const pool: Record<BodyCategory, Body[]> = {
    'inner': [], 'belt': [], 'outer': [], 'moon-inner': [], 'moon-outer': [],
  };
  for (const b of bodies) {
    if (excludeBodyIds.has(b.id)) continue;
    const cat = categorizeBody(b, bodies);
    if (cat) pool[cat].push(b);
  }

  // Track placements so the same body never gets two secrets.
  const claimed = new Set<string>();
  const placements: Record<string, BodySecret> = {};

  for (const kind of kinds) {
    const def = SECRET_DEFS[kind];
    // Build candidate list: union of host categories, minus claimed.
    const candidates: Body[] = [];
    for (const cat of def.hostCategories) {
      for (const b of pool[cat]) {
        if (!claimed.has(b.id)) candidates.push(b);
      }
    }
    if (candidates.length === 0) continue;     // catalog exhausted, skip
    const pick = candidates[Math.floor(rand() * candidates.length)];
    claimed.add(pick.id);
    placements[pick.id] = { kind };
  }

  // Return a new body list with the secret fields attached.
  return bodies.map(b => (placements[b.id]
    ? { ...b, secret: placements[b.id] }
    : b));
}

// ============================================================
// Reveal — called by the per-tick discovery scanner when a player
// ship reaches a body whose secret hasn't fired yet.
//
// The return shape is a "patch" the tick loop applies into the
// game state. Effects that produce ships / settlements / resource
// changes / tech bumps come back via this object rather than
// directly mutating state, which keeps the tick reducer pure.
// ============================================================

export interface SecretRevealPatch {
  bodyId: string;
  secret: BodySecret;
  message: string;
  /** Resources to add to discoverer's pool. */
  resourceGain?: { fuel: number; ore: number; credits: number; science: number };
  /** Settlement to append (created via createCity/createStation upstream). */
  spawnSettlement?: Settlement;
  /** Spawn a ship of this class for the discoverer at this body. */
  spawnShipClass?: 'corvette' | 'frigate' | 'destroyer' | 'freighter';
  /** Bump a random tech level by N for the discoverer. */
  techBump?: { count: number };
}

/**
 * Compute the reveal patch for a given body + secret + discoverer.
 * The caller is responsible for actually applying it to the state
 * (creating the settlement, debiting/crediting pools, etc.).
 *
 * @param body            the body whose secret is firing
 * @param discovererFactionId the faction whose ship reached the body
 * @param tick            current tick (used for spawned-settlement timestamp)
 */
export function computeSecretReveal(
  body: Body,
  discovererFactionId: string,
  tick: number,
): SecretRevealPatch | null {
  const s = body.secret;
  if (!s || s.revealed) return null;
  const def = SECRET_DEFS[s.kind];
  const patch: SecretRevealPatch = {
    bodyId: body.id,
    secret: {
      ...s,
      revealed: true,
      discoveredByFactionId: discovererFactionId,
      discoveredAtTick: tick,
    },
    message: `${body.name}: ${def.discoveryMessage}`,
  };

  switch (s.kind) {
    case 'portal_to_sun':
      // Persistent effect — the warp-on-arrival handler keys off the
      // body's revealed secret. No extra patch payload needed.
      break;

    case 'warp_gate':
      // Same story as portal_to_sun — the warp-on-arrival handler in
      // gameContext.tsx does the teleport AND its own reveal log
      // (because it knows the destination body name). This branch
      // normally never runs; it exists for type exhaustiveness in
      // case the secret is somehow inspected outside the warp loop.
      break;

    case 'ancient_city': {
      const city = createCity(body, discovererFactionId, tick, `${body.name} Ruins`);
      city.population = 3;
      city.buildings = { lab: 2 };
      patch.spawnSettlement = city;
      break;
    }

    case 'free_collector': {
      const city = createCity(body, discovererFactionId, tick, `${body.name} Hub`);
      city.hasCollector = true;
      city.collectorBuiltTick = tick;
      patch.spawnSettlement = city;
      break;
    }

    case 'pre_terraformed':
      // MP-only kind — the server reveal handler (worker/room.js)
      // grants terraform status there. This SP path never runs (the SP
      // seeder can't pick it); the case exists for exhaustiveness.
      break;

    case 'derelict_warship':
      patch.spawnShipClass = 'destroyer';
      break;

    case 'resource_cache':
      patch.resourceGain = { fuel: 0, ore: 500, credits: 500, science: 0 };
      break;

    case 'ancient_databank':
      patch.techBump = { count: 1 };
      break;
  }

  return patch;
}
