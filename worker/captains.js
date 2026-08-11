// ============================================================
// Captains (DESIGN-captains.md) — server core.
//
// A captain is a named, persistent officer attached to a ship. Captains
// OWN veterancy: rank + combat_history live here, not on the hull, so a
// survivor carries his record into the next ship. Everything here is
// auto-generated; the player edits via worker/actions.js endpoints.
//
// KEEP TRAIT IDS/EFFECTS IN SYNC with src/game/captains.ts (display).
// ============================================================

import { pickCaptainName } from './captainNames.js';

// Trait bank (spec §3). Small multiplicative modifiers — deliberately
// weaker than ship-designer parts; rank is the growth axis, traits are
// personality + new-player direction.
export const CAPTAIN_TRAITS = {
  gunner:        { name: 'Gunner',        dmgMul: 1.10 },
  bulwark:       { name: 'Bulwark',       hpMul: 1.10 },
  wrench:        { name: 'Wrench',        repairMul: 1.5 },
  voidrunner:    { name: 'Voidrunner',    accelMul: 1.10 },   // applied client-side (torch plans are client-computed)
  pathfinder:    { name: 'Pathfinder',    sensorMul: 1.15 },
  quartermaster: { name: 'Quartermaster', cargoMul: 1.25 },
  colonist:      { name: 'Colonist',      settleCostMul: 0.8 },
};
export const TRAIT_IDS = Object.keys(CAPTAIN_TRAITS);

/** Every faction fields this many captains before money enters it —
 *  seeded at game start (and topped up for pre-existing games) by
 *  ensureCaptainFloor. Beyond the floor, captains are RECRUITED with
 *  metal + credits — officers are a resource now, not a free perk. */
export const STARTING_CAPTAINS = 10;
export const RECRUIT_COST = { metal: 50, gold: 100 };

/** How many ticks a hull stays captain-locked after it last traded fire.
 *  Matches heraldStrip's COMBAT_WINDOW_TICKS so "in combat" means the
 *  same span everywhere a player can see it. Combat resolves EVERY tick
 *  (room.js §3), so a live battle re-stamps continuously and a lull of
 *  three ticks genuinely is the end of it. */
export const COMBAT_LOCK_TICKS = 3;

/**
 * Which of these hulls are actively engaged in combat?
 *
 * There is no in_combat column — engagement is derived fresh each tick
 * from co-location, and all that persists is a pair of stamps:
 * last_combat_tick ("I fired", migration 0026) and last_damaged_tick
 * ("I was hit", migration 0044). BOTH are load-bearing here. A freighter,
 * or anything on Hold Fire, never fires while being shot to pieces — key
 * off firing alone and the hulls that most need their captain aboard are
 * exactly the ones left unprotected.
 *
 * NULL-safe on purpose: an unstamped hull has never seen combat, and a
 * bare `COALESCE(x, -1) >= tick - 3` would call every ship in the game
 * engaged for the first three ticks of a match.
 *
 * @returns {Promise<Set<string>>} the subset of shipIds that are engaged
 */
export async function shipsInCombat(db, gameId, shipIds, tick) {
  const ids = [...new Set((shipIds ?? []).filter(id => typeof id === 'string' && id))];
  if (!ids.length) return new Set();
  const since = tick - COMBAT_LOCK_TICKS;
  const marks = ids.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT id FROM game_ships
               WHERE game_id = ? AND id IN (${marks})
                 AND ( (last_combat_tick  IS NOT NULL AND last_combat_tick  >= ?)
                    OR (last_damaged_tick IS NOT NULL AND last_damaged_tick >= ?) )`)
    .bind(gameId, ...ids, since, since)
    .all();
  return new Set((rows?.results ?? []).map(r => r.id));
}

/**
 * Bring every faction in the game up to STARTING_CAPTAINS total ACTIVE
 * captains (assigned + bank). New games: seeds the initial ten on the
 * first tick. Pre-existing games: no-ops for factions that already
 * field ten or more (their ships were auto-captained under the old
 * free-mint model), tops up anyone under. Idempotent and cheap.
 */
export async function ensureCaptainFloor(db, gameId, tick) {
  const counts = (await db
    .prepare(`SELECT f.id AS faction_id,
                     (SELECT COUNT(*) FROM game_captains c
                       WHERE c.game_id = f.game_id AND c.faction_id = f.id
                         AND c.status = 'active') AS n
                FROM game_factions f WHERE f.game_id = ?`)
    .bind(gameId).all()).results ?? [];
  const short = counts.filter(r => (r.n ?? 0) < STARTING_CAPTAINS);
  if (short.length === 0) return;
  const names = new Set(
    ((await db.prepare(`SELECT name FROM game_captains WHERE game_id = ? AND status = 'active'`)
      .bind(gameId).all()).results ?? []).map(r => r.name),
  );
  let idx = 0;
  for (const row of short) {
    for (let i = row.n ?? 0; i < STARTING_CAPTAINS; i++) {
      const c = rollCaptain(gameId, row.faction_id, tick, names, idx++);
      names.add(c.name);
      await db
        .prepare(
          `INSERT INTO game_captains
             (id, game_id, faction_id, name, avatar_id, bio, rank, combat_history,
              traits_json, ship_id, status, created_at_tick)
           VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, 'active', ?)`)
        .bind(c.id, gameId, row.faction_id, c.name, c.avatar_id, c.bio,
              JSON.stringify(c.traits), tick)
        .run();
    }
  }
}
export const AVATAR_IDS = ['a1','a2','a3','a4','a5','a6','a7','a8','a9','a10','a11','a12'];

const BIO_TEMPLATES = [
  'Signed on at sixteen hauling ice off the Belt. Never looked back.',
  'Third generation spacer. First to make captain.',
  'Survived the academy on stubbornness and bad coffee.',
  'Keeps a pre-war coin in the flight console for luck.',
  'Talks to the ship. Insists it listens.',
  'Demoted twice. Promoted three times. Net positive.',
  'Ran freight through a war zone once. Doesn’t recommend it.',
  'Reads old paper books on the long burns.',
  'Owes money in three ports and favors in five.',
  'Quietest voice on the command channel. Nobody interrupts.',
  'Grew up under a dome and swore off ceilings.',
  'Navigates by feel first, math second. The math always agrees.',
];

function pick(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }

/** Roll a captain: name (deduped against living captains), avatar, bio,
 *  1 trait (2 for recoveries above rank 10 — see survival path). */
export function rollCaptain(gameId, factionId, tick, existingNames, seedIdx) {
  // Math.random is fine here — captains are minted once and persisted;
  // nothing re-derives them.
  const rand = Math.random;
  const name = pickCaptainName(rand, existingNames);
  existingNames.add(name);
  return {
    id: `${gameId}:c${tick}_${seedIdx}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    avatar_id: pick(rand, AVATAR_IDS),
    bio: pick(rand, BIO_TEMPLATES),
    traits: [pick(rand, TRAIT_IDS)],
  };
}

/**
 * Lazy backfill + attach-on-build (spec §2.2, §5.4). Any active ship with
 * no captain gets the LONGEST-WAITING unassigned bank captain of its
 * faction, if the faction has one. If the bank is empty the hull sails
 * UNCAPTAINED — captains are a finite resource (STARTING_CAPTAINS +
 * recruits), and an uncaptained hull now banks no veterancy at all.
 *
 * The old fresh-roll branch that inherited the ship's legacy
 * rank/combat_history is gone twice over: it stopped minting captains
 * when they became finite, and veterancy is captain-only as of migration
 * 0068, so there is no hull record left to inherit.
 *
 * Idempotent; no-ops once every ship is captained.
 */
export async function ensureCaptains(db, gameId, tick) {
  const orphans = (await db
    .prepare(`SELECT id, owner_faction_id FROM game_ships
               WHERE game_id = ? AND status = 'active' AND captain_id IS NULL
                 -- One captain per fleet: members surrendered theirs on
                 -- joining; auto-assign must not re-captain them. The
                 -- flagship keeps its captain and never matches (captain
                 -- NOT NULL); leaderless fleets re-officer via PROMOTE.
                 AND fleet_id IS NULL
               ORDER BY CASE WHEN ship_class IN ('corvette','frigate','destroyer')
                             THEN 0 ELSE 1 END, RANDOM()
               LIMIT 40`)
    .bind(gameId).all()).results ?? [];
  if (orphans.length === 0) return;

  // Bank pull: longest-waiting unassigned captain per faction.
  // benched_at_tick IS NULL excludes captains the player deliberately put
  // in reserve (migration 0051) — without it, "→ To the bank" was undone
  // within one tick, since a faction short on captains always has an
  // orphan hull for this pass to soak one up with.
  const bank = (await db
    .prepare(`SELECT id, faction_id FROM game_captains
               WHERE game_id = ? AND status = 'active' AND ship_id IS NULL
                 AND benched_at_tick IS NULL
               ORDER BY created_at_tick ASC`)
    .bind(gameId).all()).results ?? [];
  const bankByFaction = new Map();
  for (const c of bank) {
    if (!bankByFaction.has(c.faction_id)) bankByFaction.set(c.faction_id, []);
    bankByFaction.get(c.faction_id).push(c.id);
  }

  for (const ship of orphans) {
    const queue = bankByFaction.get(ship.owner_faction_id);
    if (queue && queue.length > 0) {
      const capId = queue.shift();
      await db.batch([
        db.prepare('UPDATE game_captains SET ship_id = ? WHERE id = ?').bind(ship.id, capId),
        db.prepare('UPDATE game_ships SET captain_id = ? WHERE id = ?').bind(capId, ship.id),
      ]);
      continue;
    }
    // Bank empty: the ship sails UNCAPTAINED. Captains are a finite
    // resource now (STARTING_CAPTAINS + recruits) — the old branch that
    // minted a free captain for every hull is gone. Recruit more with
    // metal + credits (POST /captains/recruit).
    continue;
  }
}

/**
 * Survival roll when a ship dies (spec §2.1): base odds improved by
 * friendly-station proximity, floored at 5%. Tiers (implementable proxy
 * for the spec's distance decay):
 *   station at the death body            → 60%
 *   station in the same system (anchor)  → 40%
 *   any friendly station anywhere        → 15%
 *   no friendly stations left            → 5%
 * Survivor → back to the bank (ship_id NULL), rank intact; recoveries
 * above rank 10 earn a second trait. Lost → status='lost', permanent.
 * Returns { outcome: 'rescued'|'lost', captain } or null (no captain).
 */
export async function resolveCaptainOnDeath(db, gameId, tick, shipId) {
  const cap = await db
    .prepare(`SELECT id, name, rank, faction_id, traits_json FROM game_captains
               WHERE game_id = ? AND ship_id = ? AND status = 'active' LIMIT 1`)
    .bind(gameId, shipId).first();
  if (!cap) return null;

  const ship = await db
    .prepare('SELECT parent_body_id FROM game_ships WHERE id = ?')
    .bind(shipId).first();
  const bodyId = ship?.parent_body_id ?? null;

  let odds = 0.05;
  const stations = (await db
    .prepare(`SELECT body_id FROM game_settlements
               WHERE game_id = ? AND owner_faction_id = ? AND type = 'station'
                 AND destroyed_at_tick IS NULL`)
    .bind(gameId, cap.faction_id).all()).results ?? [];
  if (stations.length > 0) {
    odds = 0.15;
    if (bodyId) {
      const stationBodies = new Set(stations.map(s => s.body_id));
      if (stationBodies.has(bodyId)) {
        odds = 0.60;
      } else {
        // Same system = same parent anchor (both moons of one giant, or
        // station on the planet a moon orbits, etc).
        const anchorOf = async (bid) => {
          const b = await db.prepare('SELECT parent_body_id FROM game_bodies WHERE id = ?').bind(bid).first();
          return b?.parent_body_id ?? bid;
        };
        const deathAnchor = await anchorOf(bodyId);
        for (const sb of stationBodies) {
          const a = await anchorOf(sb);
          if (a === deathAnchor || sb === deathAnchor || a === bodyId) { odds = 0.40; break; }
        }
      }
    }
  }

  const rescued = Math.random() < odds;
  if (rescued) {
    // Rank ≥10 recoveries earn a second trait — the story writes itself.
    let traits = [];
    try { traits = JSON.parse(cap.traits_json ?? '[]'); } catch { traits = []; }
    if ((cap.rank ?? 0) >= 10 && traits.length < 2) {
      const pool = TRAIT_IDS.filter(t => !traits.includes(t));
      if (pool.length) traits.push(pool[Math.floor(Math.random() * pool.length)]);
    }
    await db.prepare('UPDATE game_captains SET ship_id = NULL, traits_json = ? WHERE id = ?')
      .bind(JSON.stringify(traits), cap.id).run();
  } else {
    await db.prepare(`UPDATE game_captains SET ship_id = NULL, status = 'lost', lost_at_tick = ? WHERE id = ?`)
      .bind(tick, cap.id).run();
  }
  return { outcome: rescued ? 'rescued' : 'lost', captain: cap };
}

/** Parse a captain's traits_json into a validated id list. */
export function parseTraits(json) {
  try {
    const arr = JSON.parse(json ?? '[]');
    return Array.isArray(arr) ? arr.filter(t => TRAIT_IDS.includes(t)) : [];
  } catch { return []; }
}

/** Multiplier helpers over a parsed trait list. */
export function traitMul(traits, key) {
  let m = 1;
  for (const t of traits) {
    const def = CAPTAIN_TRAITS[t];
    if (def && def[key]) m *= def[key];
  }
  return m;
}
