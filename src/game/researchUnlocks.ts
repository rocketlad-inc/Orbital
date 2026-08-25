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

import { TechId, TECH_DEFS } from './techs';

/** Everything that can be locked. Server mirrors these string ids. */
export type FeatureId =
  // — Weapons —
  | 'part.kinetic' | 'part.detonator' | 'part.energy'
  | 'building.weapons' | 'veteranYards'
  // — Defense —
  | 'part.shield' | 'part.armor'
  | 'building.shields' | 'building.armor'
  | 'part.repair' | 'part.flak' | 'part.mining' | 'building.telescope' | 'damageControl'
  // — Propulsion — ('collectors' removed with the terraforming rework)
  | 'hull.freighter' | 'part.engine' | 'transferLanes'
  // — Construction —
  | 'settlement.city' | 'building.shipyard'
  | 'hull.frigate' | 'hull.destroyer'
  | 'building.thrusters' | 'dyson'
  // — Society —
  | 'building.lab' | 'building.forge' | 'building.mint'
  | 'pacts' | 'senate.propose' | 'senate.chancellor'
  | 'trade.convoy2' | 'trade.convoy4'
  // — Sensors —
  | 'intel.capitals' | 'intel.earlyWarning' | 'intel.fleetCensus'
  | 'intel.economy' | 'intel.loadouts' | 'intel.research'
  | 'intel.logistics' | 'intel.secrets' | 'intel.allSettlements'
  | 'intel.allShips'
  // -- Megastructures --
  | 'part.construction'
  | 'mega.warpGate' | 'mega.weaponsStation' | 'mega.gravitySink'
  | 'mega.deepArray' | 'mega.nullField'
  | 'mega.megaDestroyer' | 'mega.mobileFoundry';

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
 * (D1) become the answer. Energy (W2) and armor (D2) then land on the
 * same rung and the triangle closes: shields stop kinetic only, armor
 * stops energy only, and neither is a universal answer again.
 *
 * FUSION DETONATOR SITS AT W5, not W2. A warhead is priced off the
 * carrier's hull HP rather than its guns, so it is the sharpest thing a
 * cheap corvette can carry — handing it out as the SECOND weapons unlock
 * made ramming the opening move of the game rather than a late trick.
 */
export const RESEARCH_UNLOCKS: UnlockRow[] = [
  // ── ⚔ WEAPONS ───────────────────────────────────────────────
  { track: 'weapons', level: 1, feature: 'part.kinetic',
    label: 'Kinetic Mount', blurb: 'Your first fittable gun. Strong against armor; shields cut damage 22% each, compounding.' },
  { track: 'weapons', level: 2, feature: 'part.energy',
    label: 'Energy Mount', blurb: 'Strong against shields; armor cuts damage 22% each, compounding. Opens the counter-game.' },
  { track: 'weapons', level: 3, feature: 'building.weapons',
    label: 'Station Weapons', blurb: 'Your stations shoot back. Needs a station in orbit.' },
  { track: 'weapons', level: 4, feature: 'veteranYards',
    // Was "new hulls launch with a quarter of your fleet's average rank"
    // — hull-carried veterancy, which migration 0068 abolished and 0118
    // dropped the columns for. The perk now lands where veterancy lives.
    label: 'Veteran Yards', blurb: 'Your new captains start at rank 1 — already blooded.' },
  { track: 'weapons', level: 5, feature: 'part.detonator',
    label: 'Fusion Detonator', blurb: 'Turns a cheap hull into a threat. Hits friend and foe.' },
  { track: 'weapons', level: 6, feature: 'mega.weaponsStation',
    label: 'Weapons Station', blurb: 'A gun platform that reaches into transit lanes. Too big to ignore and too tough to pass with one fleet.' },
  { track: 'weapons', level: 9, feature: 'mega.megaDestroyer',
    label: 'Mega Destroyer', blurb: 'Strips the terraforming off a world. Barely moves, cannot use gates, and everyone sees it coming.' },

  // ── 🛡 DEFENSE ──────────────────────────────────────────────
  { track: 'armor', level: 1, feature: 'part.shield',
    label: 'Shield Array', blurb: 'The answer to kinetic. Does nothing against energy.' },
  { track: 'armor', level: 2, feature: 'part.armor',
    label: 'Armor Plate', blurb: 'The answer to energy. Does nothing against kinetic.' },
  // Named for what it grants. The old label, "Hardened Settlements",
  // described neither the building nor its host: there is one building,
  // it is the shield pool, and it sits on CITIES — so the blurb's "for
  // stations" had been wrong since shields moved to the ground.
  { track: 'armor', level: 3, feature: 'building.shields',
    label: 'Planetary Shields', blurb: 'A regenerating shield pool over your cities. Absorbs fire before structure — and structure never comes back.' },
  // Defense 4 stood EMPTY after 'pdcUpgrade' died with point defence. The
  // Repair Bay is its replacement reward, and it reads as a ladder with
  // the level above: build a tender first, then every hull self-heals.
  { track: 'armor', level: 4, feature: 'part.repair',
    label: 'Repair Bay', blurb: 'Freighter part. A field tender that patches up your worst-hurt ship anywhere — no station needed.' },
  { track: 'armor', level: 5, feature: 'damageControl',
    label: 'Damage Control', blurb: 'Ships repair a trickle between volleys, mid-fight.' },
  // FLAK on the DEFENCE track, not Weapons. It is point defence: it
  // fires no killing shot, it makes a swarm survivable. The free Weapons
  // levels are 7 and 8, which would put the answer to corvette spam long
  // after the phase of the game where corvette spam happens.
  { track: 'armor', level: 6, feature: 'part.flak',
    label: 'Flak Battery', blurb: 'No damage — it slows every enemy hull in the fight, which makes them easier for your whole fleet to hit. The answer to a corvette swarm.' },
  { track: 'armor', level: 7, feature: 'mega.nullField',
    label: 'Null Field', blurb: 'Blinds rival sensors inside its radius — the first answer the intel ladder has ever had.' },
  { track: 'armor', level: 9, feature: 'mega.deepArray',
    label: 'Deep Space Array', blurb: 'A sensor bubble anywhere you can afford to put one, rather than only where you hold ground.' },

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
  // CONVOYS LIVE HERE, not on Society. They sat at Society 7/8 on the
  // reasoning that "a shared lane is a social act" — but what the techs
  // actually raise is how many hulls one route can carry, which is a
  // movement problem, and Propulsion 4 onward was seven dead rungs of
  // +6% engine bonus. Read down the track now and it is one ladder: a
  // freighter, a faster freighter, faster lanes, two hulls, four.
  //
  // 'collectors' held Propulsion 4 until the terraforming rework deleted
  // it (terraformed status IS the loading dock now).
  { track: 'propulsion', level: 4, feature: 'trade.convoy2',
    label: 'Convoy Logistics', blurb: 'Run two freighters on one route. They walk the same loop out of phase, so deliveries land twice as often.' },
  { track: 'propulsion', level: 5, feature: 'trade.convoy4',
    label: 'Trade Armadas', blurb: 'Four freighters to a route — and an international lane must be folded before it can carry more than one.' },
  // MEGASTRUCTURES START HERE. Propulsion carries the three that are
  // about moving: a door, a trap, and a shipyard that travels.
  { track: 'propulsion', level: 6, feature: 'mega.warpGate',
    label: 'Warp Gate', blurb: 'Build a two-way gate paired to exactly one other. Anyone may use it, including the people you built it against.' },
  { track: 'propulsion', level: 8, feature: 'mega.gravitySink',
    label: 'Gravity Sink', blurb: 'Holds crossing ships for eight ticks. You choose who is caught and who passes.' },
  { track: 'propulsion', level: 10, feature: 'mega.mobileFoundry',
    label: 'Mobile Foundry', blurb: 'A shipyard that moves. Four hulls at once, wherever you park it.' },

  // ── 🔧 CONSTRUCTION ─────────────────────────────────────────
  { track: 'construction', level: 1, feature: 'settlement.city',
    label: 'Planetary Cities', blurb: 'Found cities on terraformed worlds. Stations claim ground without it.' },
  { track: 'construction', level: 2, feature: 'building.shipyard',
    label: 'Shipyard', blurb: 'Parallel build slots. Stop building one ship at a time.' },
  { track: 'construction', level: 3, feature: 'hull.frigate',
    label: 'Frigate', blurb: 'Four slots. Your first real warship.' },
  // THE MODULE IS A CONSTRUCTION TECH (Lorne, 2026-08-25). It lived on
  // Society 8 because putting it at the BOTTOM of this track would have
  // pushed the Dyson down three rungs, and the Dyson has to stay last.
  // Placing it EARLY costs the Dyson one rung instead of three, which is
  // the difference between delaying a victory path and deleting it.
  //
  // Early is also where it belongs. The module only lets a colony ship
  // lay a foundation; WHAT you may lay is gated separately and deeply
  // (Weapons 6/9, Defense 7/9, Propulsion 6/8/10). Gating the shovel as
  // hard as the cathedral meant paying twice for the same permission.
  { track: 'construction', level: 4, feature: 'part.construction',
    label: 'Construction Module',
    blurb: 'Fit a colony ship to lay megastructure foundations. Everything enormous starts here.' },
  // THE TELESCOPE COMES BEFORE THE DESTROYER. It was at L7, past the
  // Dyson, which put the mining economy it opens behind the whole
  // warship ladder — you found rocks only once you could already take
  // them off someone.
  { track: 'construction', level: 5, feature: 'building.telescope',
    label: 'Deep Survey Telescope',
    blurb: "Extends a world's sensor range and surveys meteoroids passing through it." },
  { track: 'construction', level: 6, feature: 'hull.destroyer',
    label: 'Destroyer', blurb: 'Six slots. The siege piece.' },
  { track: 'construction', level: 7, feature: 'building.thrusters',
    label: 'Trajectory Thrusters', blurb: 'Fit an asteroid with engines and aim it at someone.' },
  { track: 'construction', level: 8, feature: 'dyson',
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
    // Non-aggression is FREE from tick one, so this no longer claims to
    // unlock it — a tech that advertises something you already have is
    // a tech players learn to distrust.
    label: 'Defense & Intel Pacts', blurb: 'Defense pacts and intel-sharing treaties. Non-aggression is always available.' },
  // THE RIG SITS RIGHT BEHIND PACTS. It was Society 7 — 4,921 science
  // to reach, cumulative — which is most of a game for the entry ticket
  // to an economy that also wants a Telescope on another track. At 5 it
  // costs 1,653, and mining becomes something you can commit to rather
  // than something you arrive at. Same reasoning that moved the
  // Telescope to Construction 4. The senate pair moves up a rung.
  { track: 'industry', level: 5, feature: 'part.mining',
    label: 'Mining Rig',
    blurb: 'Fit a freighter to work meteoroids. Without it a hull cannot crew a mining run.' },
  { track: 'industry', level: 6, feature: 'senate.propose',
    label: 'Senate Proposals', blurb: 'Put bills to the floor. Voting is always open to you.' },
  { track: 'industry', level: 7, feature: 'senate.chancellor',
    label: 'Chancellor Election', blurb: 'Call the vote that can end the game. Opens the senate victory.' },
  // Convoy Logistics and Trade Armadas used to hold Society 7/8; they
  // are Propulsion 4/5 now, for the reasons noted on that track. The
  // Construction Module briefly held Society 8 and is now Construction
  // 4, where the rationale for the move is written out.

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
  // Must mirror worker/researchUnlocks.js BUILDING_FEATURE exactly. A
  // kind missing here reads as UNGATED on the client — the build button
  // renders live and enabled, the player spends the click, and the
  // server rejects it against its own map. Silent failure, not a lock.
  shields: 'building.shields',
  // Declared at Construction 4 in RESEARCH_UNLOCKS and wired NOWHERE
  // until now — the telescope shipped ungated while the research screen
  // advertised a requirement, which is the same hole part.mining sat in.
  // The comment directly above this one warned about exactly that and it
  // happened anyway; researchWiring.test.ts is the part that actually
  // holds.
  telescope: 'building.telescope',
  // NOT mirroring the server's `armor: 'building.armor'` entry: 'armor'
  // is a research TRACK, not a BuildingKind, so that row is vestigial on
  // both sides. Copying it here would be actively harmful — there is no
  // 'building.armor' row in RESEARCH_UNLOCKS, and requirementFor() miss
  // means lockReason() returns null, i.e. UNLOCKED.
  trajectory_thrusters: 'building.thrusters',
};

/** Ship part id -> feature id. */
export const PART_FEATURE: Partial<Record<string, FeatureId>> = {
  construction: 'part.construction',
  kinetic: 'part.kinetic',
  energy: 'part.energy',
  shield: 'part.shield',
  armor: 'part.armor',
  engine: 'part.engine',
  detonator: 'part.detonator',
  repair: 'part.repair',
  flak: 'part.flak',
  // MINING WAS MISSING HERE while RESEARCH_UNLOCKS declared it at
  // Society 5. The unlock row alone gates nothing — THIS map is what
  // the designer and requireParts consult — so the rig was free from
  // turn 1 while the research screen advertised a gate that never
  // fired. partGates.test.ts now fails if a declared part unlock has no
  // entry here.
  mining: 'part.mining',
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
 * "Convoy Logistics (Propulsion 4)" — the tech, the track AS THE PLAYER
 * SEES IT, and the level.
 *
 * Three trade surfaces used to spell this out by hand, and every one of
 * them said "Society 7" / "Society 8". Moving the convoy rows to
 * Propulsion would have left all three pointing at a track that no
 * longer holds the tech — advice that sends a player to the wrong column
 * is worse than no advice. Derive it instead.
 *
 * Note the track NAME, not its id: 'industry' displays as SOCIETY, and a
 * player hunting for a track called "Industry" finds nothing.
 */
export function requirementLabel(feature: FeatureId): string | null {
  const req = requirementFor(feature);
  if (!req) return null;
  return `${req.label} (${TECH_DEFS[req.track].name} ${req.level})`;
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
