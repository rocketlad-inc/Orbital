// Research unlocks — server mirror of src/game/researchUnlocks.ts.
// KEEP IN SYNC. The worker is a separate Cloudflare bundle that can't
// import the React build tree, so the table is duplicated.
//
// Only the (feature -> track/level) requirement map is needed here;
// the labels/blurbs are client presentation. Labels ARE included so the
// server can build an actionable rejection message.

export const REQUIREMENTS = {
  // Weapons
  'part.kinetic':          { track: 'weapons', level: 1, label: 'Kinetic Mount' },
  'part.detonator':        { track: 'weapons', level: 2, label: 'Fusion Detonator' },
  'part.energy':           { track: 'weapons', level: 3, label: 'Energy Mount' },
  'building.weapons':      { track: 'weapons', level: 4, label: 'Station Weapons' },
  'veteranYards':          { track: 'weapons', level: 5, label: 'Veteran Yards' },
  // Defense (the 'armor' track)
  'part.shield':           { track: 'armor', level: 1, label: 'Shield Array' },
  'part.armor':            { track: 'armor', level: 2, label: 'Armor Plate' },
  'building.shields':      { track: 'armor', level: 3, label: 'Hardened Settlements' },
  'building.armor':        { track: 'armor', level: 3, label: 'Hardened Settlements' },
  // Defense 4 was empty after 'pdcUpgrade' died with point defence. The
  // Repair Bay fills it, and sits one level below Damage Control on
  // purpose: first you can BUILD a tender, then every hull self-heals.
  'part.repair':           { track: 'armor', level: 4, label: 'Repair Bay' },
  'damageControl':         { track: 'armor', level: 5, label: 'Damage Control' },
  // Propulsion
  'hull.freighter':        { track: 'propulsion', level: 1, label: 'Freighter' },
  'part.engine':           { track: 'propulsion', level: 2, label: 'Booster Engine' },
  'transferLanes':         { track: 'propulsion', level: 3, label: 'Transfer Lanes' },
  // 'collectors' (propulsion 4) removed with the terraforming rework —
  // the endpoint it gated is deleted; Propulsion 4 currently grants no
  // unlock (same standing as Defense 4 / pdcUpgrade).
  // Construction
  // GATE SWAP (terraforming balance pass). Stations went from the
  // advanced move to the FIRST move: under the hard city gate a colony
  // ship arriving at a raw world can only plant a station, so gating
  // stations gated all expansion — a fresh empire's colony ship could do
  // literally nothing until Construction 1 landed. Stations are now
  // ungated and cities carry the level instead, which costs nearly
  // nothing in practice: you cannot build a city until a world is
  // terraformed, and the first terraform does not complete until ~t+70,
  // by which time Construction 1 is long since researched.
  'settlement.city':       { track: 'construction', level: 1, label: 'Planetary Cities' },
  'building.shipyard':     { track: 'construction', level: 2, label: 'Shipyard' },
  'hull.frigate':          { track: 'construction', level: 3, label: 'Frigate' },
  'hull.destroyer':        { track: 'construction', level: 4, label: 'Destroyer' },
  'building.thrusters':    { track: 'construction', level: 5, label: 'Trajectory Thrusters' },
  'dyson':                 { track: 'construction', level: 6, label: 'Dyson Foundation' },
  // Society (the 'industry' track)
  'building.lab':          { track: 'industry', level: 1, label: 'Laboratory' },
  'building.forge':        { track: 'industry', level: 2, label: 'Forge' },
  'building.mint':         { track: 'industry', level: 3, label: 'Mint' },
  // Non-aggression is ungated (see GATED_PACTS in trades.js); this tech
  // buys the two pacts that confer an advantage.
  'pacts':                 { track: 'industry', level: 4, label: 'Defense & Intel Pacts' },
  'senate.propose':        { track: 'industry', level: 5, label: 'Senate Proposals' },
  'senate.chancellor':     { track: 'industry', level: 6, label: 'Chancellor Election' },
  // Trade v2 (DESIGN-trade-v2 §5): carriers per route. 1 by default,
  // 2 at Convoy Logistics, 4 at Trade Armadas — see carrierCapFor in
  // tradeRoutesV2.js. Society is the natural home: it already owns the
  // pacts and senate unlocks, and a shared lane is a social act.
  'trade.convoy2':         { track: 'industry', level: 7, label: 'Convoy Logistics' },
  'trade.convoy4':         { track: 'industry', level: 8, label: 'Trade Armadas' },
  // Sensors — intel ladder
  'intel.capitals':        { track: 'sensors', level: 1, label: 'Capital Ping' },
  'intel.earlyWarning':    { track: 'sensors', level: 2, label: 'Early Warning' },
  'intel.fleetCensus':     { track: 'sensors', level: 3, label: 'Fleet Census' },
  'intel.economy':         { track: 'sensors', level: 4, label: 'Economic Intel' },
  'intel.loadouts':        { track: 'sensors', level: 5, label: 'Deep Scan' },
  'intel.research':        { track: 'sensors', level: 6, label: 'Research Intel' },
  'intel.logistics':       { track: 'sensors', level: 7, label: 'Logistics Intel' },
  'intel.secrets':         { track: 'sensors', level: 8, label: 'Survey Protocols' },
  'intel.allSettlements':  { track: 'sensors', level: 9, label: 'Strategic Array' },
  'intel.allShips':        { track: 'sensors', level: 10, label: 'Total Awareness' },
};

/** Ship hull class -> the feature that unlocks it. Corvette + colony are
 *  the starting kit and are never gated. */
export const HULL_FEATURE = {
  frigate: 'hull.frigate',
  destroyer: 'hull.destroyer',
  freighter: 'hull.freighter',
};

/** Settlement building kind -> feature id. */
export const BUILDING_FEATURE = {
  forge: 'building.forge',
  mint: 'building.mint',
  lab: 'building.lab',
  shipyard: 'building.shipyard',
  weapons: 'building.weapons',
  shields: 'building.shields',
  armor: 'building.armor',
  trajectory_thrusters: 'building.thrusters',
};

/** Ship part id -> feature id. */
export const PART_FEATURE = {
  kinetic: 'part.kinetic',
  energy: 'part.energy',
  shield: 'part.shield',
  armor: 'part.armor',
  engine: 'part.engine',
  detonator: 'part.detonator',
  repair: 'part.repair',
};

/**
 * Read a faction's tech levels as { tech_id: level }.
 * Folds the short-lived 'energy_weapons'/'shields' tracks back into
 * 'weapons'/'armor' so a live game keeps levels it paid for.
 */
export async function factionTechLevels(env, gameId, factionId) {
  const rows = (await env.DB
    .prepare('SELECT tech_id, level FROM faction_techs WHERE game_id = ? AND faction_id = ?')
    .bind(gameId, factionId)
    .all()).results ?? [];
  const out = {};
  for (const r of rows) out[r.tech_id] = r.level;
  out.weapons = Math.max(out.weapons ?? 0, out.energy_weapons ?? 0);
  out.armor = Math.max(out.armor ?? 0, out.shields ?? 0);
  return out;
}

/** Is research gating on for this game? Pre-existing games grandfather
 *  everything unlocked (gating_enabled = 0). */
export async function gatingEnabled(env, gameId) {
  const row = await env.DB
    .prepare('SELECT gating_enabled FROM games WHERE id = ?')
    .bind(gameId).first();
  return (row?.gating_enabled ?? 0) === 1;
}

/**
 * Gate check. Returns null when allowed, or { code, message } to reject.
 * Callers that already hold levels + flag should use hasFeature instead
 * to avoid re-querying.
 */
export function hasFeature(feature, levels, isGated) {
  if (!isGated) return true;
  const req = REQUIREMENTS[feature];
  if (!req) return true;
  return (levels?.[req.track] ?? 0) >= req.level;
}

/** Player-readable rejection for a locked feature. */
export function lockedError(feature) {
  const req = REQUIREMENTS[feature];
  if (!req) return { code: 'not_researched', message: 'That is not available yet.' };
  const TRACK_NAME = {
    weapons: 'Weapons', armor: 'Defense', propulsion: 'Propulsion',
    construction: 'Construction', industry: 'Society', sensors: 'Sensors',
  };
  return {
    code: 'not_researched',
    message: `${req.label} unlocks at ${TRACK_NAME[req.track] ?? req.track} level ${req.level}.`,
  };
}
