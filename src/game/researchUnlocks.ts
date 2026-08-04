// ============================================================
// Research unlocks — the progression spine.
//
// A game starts with almost nothing: one corvette (bare hull), one
// colony ship, and your capital city. Every other mechanic is behind a
// research level, so features arrive ONE AT A TIME as the player's
// comprehension grows. The tech tree IS the tutorial.
//
// This table is the single source of truth for "what does level N of
// track T give you". KEEP IN SYNC with worker/researchUnlocks.js — the
// worker is a separate Cloudflare bundle and can't import this.
//
// Two rules the table encodes:
//   - Every level pays its track's passive % (see TECH_DEFS.perLevel),
//     so a pure-buff level is never dead weight.
//   - Early levels ALSO unlock a mechanic, so the first ~5 levels of a
//     track are a guided tour rather than a stat ramp.
//
// GRANDFATHERING: games created before this system have
// games.gating_enabled = 0 and every check below returns true. Only new
// games gate. See hasFeature().
// ============================================================

import { TechId } from './techs';

/** Everything that can be locked. Server mirrors these string ids. */
export type FeatureId =
  // — Weapons —
  | 'part.kinetic' | 'part.detonator' | 'part.energy'
  | 'building.weapons' | 'veteranYards'
  // — Defense —
  | 'part.shield' | 'part.armor'
  | 'building.shields' | 'building.armor'
  | 'pdcUpgrade' | 'damageControl'
  // — Propulsion —
  | 'hull.freighter' | 'part.engine' | 'transferLanes' | 'collectors'
  // — Construction —
  | 'settlement.station' | 'building.shipyard'
  | 'hull.frigate' | 'hull.destroyer'
  | 'building.thrusters' | 'dyson'
  // — Society —
  | 'building.lab' | 'building.forge' | 'building.mint'
  | 'pacts' | 'senate.propose' | 'senate.chancellor'
  // — Sensors —
  | 'intel.capitals' | 'intel.earlyWarning' | 'intel.fleetCensus'
  | 'intel.economy' | 'intel.loadouts' | 'intel.research'
  | 'intel.logistics' | 'intel.secrets' | 'intel.allSettlements'
  | 'intel.allShips';

export interface UnlockRow {
  track: TechId;
  level: number;
  feature: FeatureId;
  /** Shown on the research card + in the locked-feature tooltip. */
  label: string;
  /** One line of why it matters, for the research card. */
  blurb: string;
}

/**
 * THE TREE. Levels not listed here are pure-scaling levels.
 *
 * Ordering is deliberate — the counter-matrix teaches itself in the
 * order a player can absorb it: everyone fits kinetic (W1), so shields
 * (D1) become the answer, so armor (D2) pre-empts, and then energy (W3)
 * arrives and shields stop being universal.
 */
export const RESEARCH_UNLOCKS: UnlockRow[] = [
  // ── ⚔ WEAPONS ───────────────────────────────────────────────
  { track: 'weapons', level: 1, feature: 'part.kinetic',
    label: 'Kinetic Mount', blurb: 'Your first fittable gun. Armor never stops it; shields cut it to 78% each.' },
  { track: 'weapons', level: 2, feature: 'part.detonator',
    label: 'Fusion Detonator', blurb: 'Turns a cheap hull into a threat. Hits friend and foe.' },
  { track: 'weapons', level: 3, feature: 'part.energy',
    label: 'Energy Mount', blurb: 'Shields never stop it; armor cuts it to 78% each. Opens the counter-game.' },
  { track: 'weapons', level: 4, feature: 'building.weapons',
    label: 'Station Weapons', blurb: 'Your stations shoot back. Needs a station in orbit.' },
  { track: 'weapons', level: 5, feature: 'veteranYards',
    label: 'Veteran Yards', blurb: 'New hulls launch with a quarter of your fleet’s average rank.' },

  // ── 🛡 DEFENSE ──────────────────────────────────────────────
  { track: 'armor', level: 1, feature: 'part.shield',
    label: 'Shield Array', blurb: 'The answer to kinetic. Does nothing against energy.' },
  { track: 'armor', level: 2, feature: 'part.armor',
    label: 'Armor Plate', blurb: 'The answer to energy. Does nothing against kinetic.' },
  { track: 'armor', level: 3, feature: 'building.shields',
    label: 'Hardened Settlements', blurb: 'Shield + armor buildings for stations.' },
  { track: 'armor', level: 4, feature: 'pdcUpgrade',
    label: 'Point-Defense Upgrade', blurb: 'Every hull mitigates a further step of incoming fire.' },
  { track: 'armor', level: 5, feature: 'damageControl',
    label: 'Damage Control', blurb: 'Ships repair a trickle between volleys, mid-fight.' },

  // ── 🚀 PROPULSION ───────────────────────────────────────────
  // Freighters unlock as a BUNDLE — the hull and everything it does
  // (trade routes, ad-hoc pickup). Gating those separately made the
  // freighter feel half-delivered.
  { track: 'propulsion', level: 1, feature: 'hull.freighter',
    label: 'Freighter', blurb: 'The economy opens: hauling, trade routes, and pickup, all at once.' },
  { track: 'propulsion', level: 2, feature: 'part.engine',
    label: 'Booster Engine', blurb: 'Speed becomes a fitting choice.' },
  { track: 'propulsion', level: 3, feature: 'transferLanes',
    label: 'Transfer Lanes', blurb: 'Capital-to-capital transits run faster.' },
  { track: 'propulsion', level: 4, feature: 'collectors',
    label: 'Collectors', blurb: 'Automated harvest→pool logistics. Before this, hauling is manual.' },

  // ── 🔧 CONSTRUCTION ─────────────────────────────────────────
  { track: 'construction', level: 1, feature: 'settlement.station',
    label: 'Orbital Stations', blurb: 'Claim a body from orbit. Consumes a colony ship.' },
  { track: 'construction', level: 2, feature: 'building.shipyard',
    label: 'Shipyard', blurb: 'Parallel build slots. Stop building one ship at a time.' },
  { track: 'construction', level: 3, feature: 'hull.frigate',
    label: 'Frigate', blurb: 'Four slots. Your first real warship.' },
  { track: 'construction', level: 4, feature: 'hull.destroyer',
    label: 'Destroyer', blurb: 'Six slots. The siege piece.' },
  { track: 'construction', level: 5, feature: 'building.thrusters',
    label: 'Trajectory Thrusters', blurb: 'Fit an asteroid with engines and aim it at someone.' },
  { track: 'construction', level: 6, feature: 'dyson',
    label: 'Dyson Foundation', blurb: 'Opens the engineering victory path.' },

  // ── ⛏ SOCIETY ───────────────────────────────────────────────
  // Lab first: science compounds, so an economic opening is a real
  // strategy — at the cost of reaching mid-game with no guns.
  { track: 'industry', level: 1, feature: 'building.lab',
    label: 'Laboratory', blurb: 'Science buildings. The engine that feeds this whole tree.' },
  { track: 'industry', level: 2, feature: 'building.forge',
    label: 'Forge', blurb: 'Metal output from your settlements.' },
  { track: 'industry', level: 3, feature: 'building.mint',
    label: 'Mint', blurb: 'Credit output from your settlements.' },
  { track: 'industry', level: 4, feature: 'pacts',
    label: 'Diplomatic Pacts', blurb: 'Non-aggression, defense, and intel-sharing treaties.' },
  { track: 'industry', level: 5, feature: 'senate.propose',
    label: 'Senate Proposals', blurb: 'Put bills to the floor. Voting is always open to you.' },
  { track: 'industry', level: 6, feature: 'senate.chancellor',
    label: 'Chancellor Election', blurb: 'Call the vote that can end the game. Opens the senate victory.' },

  // ── 📡 SENSORS ──────────────────────────────────────────────
  // Every level widens the scan radius AND peels back another layer of
  // what rivals are doing. The capstones are strong, but they cost ten
  // levels of a track that never fires a shot.
  { track: 'sensors', level: 1, feature: 'intel.capitals',
    label: 'Capital Ping', blurb: 'Every faction’s capital is marked on the map.' },
  { track: 'sensors', level: 2, feature: 'intel.earlyWarning',
    label: 'Early Warning', blurb: 'Inbound hostiles appear in your Situation Report.' },
  { track: 'sensors', level: 3, feature: 'intel.fleetCensus',
    label: 'Fleet Census', blurb: 'See how many ships each faction has.' },
  { track: 'sensors', level: 4, feature: 'intel.economy',
    label: 'Economic Intel', blurb: 'See each faction’s per-tick income.' },
  { track: 'sensors', level: 5, feature: 'intel.loadouts',
    label: 'Deep Scan', blurb: 'Read enemy loadouts in range — scout the counter before you commit.' },
  { track: 'sensors', level: 6, feature: 'intel.research',
    label: 'Research Intel', blurb: 'See what your rivals have teched.' },
  { track: 'sensors', level: 7, feature: 'intel.logistics',
    label: 'Logistics Intel', blurb: 'See enemy trade routes and build queues.' },
  { track: 'sensors', level: 8, feature: 'intel.secrets',
    label: 'Survey Protocols', blurb: 'Secrets auto-mark when a ship passes near one.' },
  { track: 'sensors', level: 9, feature: 'intel.allSettlements',
    label: 'Strategic Array', blurb: 'Every enemy settlement, fog or no fog.' },
  { track: 'sensors', level: 10, feature: 'intel.allShips',
    label: 'Total Awareness', blurb: 'Every enemy ship, fog or no fog.' },
];

// ── id -> feature maps ──────────────────────────────────────
// Mirrors of the same three maps in worker/researchUnlocks.js. A missing
// key means "ungated": the corvette and colony hulls, and the city
// settlement, are the starting kit and never appear here.

/** Ship class -> feature id. */
export const HULL_FEATURE: Partial<Record<string, FeatureId>> = {
  frigate: 'hull.frigate',
  destroyer: 'hull.destroyer',
  freighter: 'hull.freighter',
};

/** Settlement building kind -> feature id. */
export const BUILDING_FEATURE: Partial<Record<string, FeatureId>> = {
  forge: 'building.forge',
  mint: 'building.mint',
  lab: 'building.lab',
  shipyard: 'building.shipyard',
  weapons: 'building.weapons',
  trajectory_thrusters: 'building.thrusters',
};

/** Ship part id -> feature id. */
export const PART_FEATURE: Partial<Record<string, FeatureId>> = {
  kinetic: 'part.kinetic',
  energy: 'part.energy',
  shield: 'part.shield',
  armor: 'part.armor',
  engine: 'part.engine',
  detonator: 'part.detonator',
};

/** feature -> requirement, built once. */
const REQUIREMENT = new Map<FeatureId, { track: TechId; level: number; label: string }>(
  RESEARCH_UNLOCKS.map(u => [u.feature, { track: u.track, level: u.level, label: u.label }]),
);

/** Unlocks granted at exactly this level (usually 0 or 1 rows). */
export function unlocksAt(track: TechId, level: number): UnlockRow[] {
  return RESEARCH_UNLOCKS.filter(u => u.track === track && u.level === level);
}

/** What a feature costs, for tooltips + error copy. Null = always on. */
export function requirementFor(feature: FeatureId): { track: TechId; level: number; label: string } | null {
  return REQUIREMENT.get(feature) ?? null;
}

/**
 * Is `feature` available to a faction at these tech levels?
 *
 * @param levels        tech_id -> level (missing = 0)
 * @param gatingEnabled false for pre-existing games, which grandfather
 *                      EVERYTHING unlocked. Always pass the game's flag.
 */
export function hasFeature(
  feature: FeatureId,
  levels: Partial<Record<string, number>> | undefined,
  gatingEnabled: boolean,
): boolean {
  if (!gatingEnabled) return true;
  const req = REQUIREMENT.get(feature);
  if (!req) return true;                       // not gated
  return (levels?.[req.track] ?? 0) >= req.level;
}
