// ============================================================
// Meteoroids, per tick — who can see them, and keeping the belt stocked.
//
// TWO PASSES, deliberately separate:
//
//   DISCOVERY. A faction's sensor bubbles sweep the sky and record what
//   they find. Discovery is PERMANENT and PER FACTION: once you have
//   seen a rock it stays on your map when it drifts back out of range,
//   and your rival still has to find it themselves. That is why this
//   writes rows instead of being computed live at render time — "can I
//   see it right now" and "do I know it exists" are different questions
//   and only the second one survives the rock moving.
//
//   REPLENISHMENT. Rocks are consumed and removed, so an untended belt
//   runs dry and mining becomes a phase of the game rather than part of
//   it. Lorne's call: the Kuiper belt restocks itself. New rocks arrive
//   UNDISCOVERED, so a restock is not a gift — it is something somebody
//   has to go and find.
//
// Both run from the room tick. Both are best-effort: a failure here
// must never cost a player their tick, so each is wrapped by the caller
// and neither holds state the rest of the tick depends on.
// ============================================================

import {
  SHIP_SENSOR_RANGE, SETTLEMENT_SENSOR_RANGE,
  DEFAULT_SHIP_SENSOR_RANGE, DEFAULT_SETTLEMENT_SENSOR_RANGE,
} from './state.js';

/** How many live Kuiper rocks the belt tries to hold. Matches the eight
 *  spawned at worldgen, so the belt is kept at its opening depth rather
 *  than growing over a long game. */
export const KUIPER_FLOOR = 8;

/** Ticks between restock checks. Not every tick: a trickle is the point
 *  — a belt that refills the instant a rock dies removes the pressure
 *  that made anyone go looking in the first place. */
export const RESTOCK_INTERVAL = 20;

const TWO_PI = Math.PI * 2;

/**
 * PASS 1 — passive discovery by sensor coverage.
 *
 * @param posOf  (bodyId, tick) => {x,y}. Passed in because the tick
 *               already builds a memoised position resolver and
 *               computing orbits twice per tick is the kind of thing
 *               that shows up in the frame budget later.
 */
/**
 * Every faction's sensor coverage this tick, as squared-radius circles.
 *
 * Shared by BOTH passes on purpose. Discovery asks "who can see this
 * rock"; replenishment asks "can anyone see where I am about to put
 * one". Those are the same question from opposite ends, and two
 * implementations of it would drift the moment a range changed.
 *
 * @returns Map<factionId, Array<{x, y, r2}>>
 */
export async function sensorBubbles(env, gameId, tick, posOf) {
  const [ships, setts] = await Promise.all([
    env.DB.prepare(
      `SELECT owner_faction_id AS fid, ship_class, parent_body_id
         FROM game_ships
        WHERE game_id = ? AND status = 'active' AND parent_body_id IS NOT NULL`,
    ).bind(gameId).all(),
    env.DB.prepare(
      `SELECT owner_faction_id AS fid, type, body_id
         FROM game_settlements
        WHERE game_id = ? AND destroyed_at_tick IS NULL`,
    ).bind(gameId).all(),
  ]);

  const bubbles = new Map();
  const add = (fid, bodyId, range) => {
    if (!fid || !bodyId || !(range > 0)) return;
    const p = posOf(bodyId, tick);
    if (!p) return;
    if (!bubbles.has(fid)) bubbles.set(fid, []);
    bubbles.get(fid).push({ x: p.x, y: p.y, r2: range * range });
  };
  for (const s of ships.results ?? []) {
    add(s.fid, s.parent_body_id,
      SHIP_SENSOR_RANGE[s.ship_class] ?? DEFAULT_SHIP_SENSOR_RANGE);
  }
  for (const st of setts.results ?? []) {
    // The Telescope raises this by raising the settlement's range, so
    // neither pass needs to know the building exists.
    add(st.fid, st.body_id,
      SETTLEMENT_SENSOR_RANGE[st.type] ?? DEFAULT_SETTLEMENT_SENSOR_RANGE);
  }
  return bubbles;
}

/** Is (x, y) inside ANY faction's coverage? Exported so the spawn
 *  clearance rule can be tested as the geometry it is, rather than
 *  through a fixture that has to out-range a station to reach it. */
export function seenByAnyone(bubbles, x, y) {
  for (const [, list] of bubbles) {
    for (const b of list) {
      const dx = x - b.x, dy = y - b.y;
      if (dx * dx + dy * dy <= b.r2) return true;
    }
  }
  return false;
}

export async function discoverMeteoroids(env, gameId, tick, posOf) {
  const rocks = (await env.DB
    .prepare(
      `SELECT id FROM game_bodies
        WHERE game_id = ? AND mineral_remaining > 0
          AND exhausted_at_tick IS NULL AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId).all()).results ?? [];
  if (rocks.length === 0) return { found: 0 };

  const [known, bubbles] = await Promise.all([
    env.DB.prepare(
      'SELECT body_id, faction_id FROM game_body_discoveries WHERE game_id = ?',
    ).bind(gameId).all(),
    sensorBubbles(env, gameId, tick, posOf),
  ]);
  const seen = new Set((known.results ?? []).map(r => `${r.faction_id}|${r.body_id}`));
  if (bubbles.size === 0) return { found: 0 };

  const finds = [];
  for (const rock of rocks) {
    const p = posOf(rock.id, tick);
    if (!p) continue;
    for (const [fid, list] of bubbles) {
      if (seen.has(`${fid}|${rock.id}`)) continue;
      for (const b of list) {
        const dx = p.x - b.x, dy = p.y - b.y;
        if (dx * dx + dy * dy <= b.r2) {
          finds.push({ fid, bodyId: rock.id });
          seen.add(`${fid}|${rock.id}`);   // one row per pair, not per bubble
          break;
        }
      }
    }
  }
  if (finds.length === 0) return { found: 0 };

  await env.DB.batch(finds.map(f => env.DB.prepare(
    `INSERT OR IGNORE INTO game_body_discoveries
       (game_id, body_id, faction_id, discovered_at_tick, method)
     VALUES (?, ?, ?, ?, 'sensor')`,
  ).bind(gameId, f.bodyId, f.fid, tick)));

  return { found: finds.length, finds };
}

/**
 * PASS 2 — restock the Kuiper belt.
 *
 * Only counts rocks that are still WORTH finding: exhausted ones are
 * gone and should not hold the belt above the floor forever.
 */
export async function replenishKuiper(env, gameId, tick, rand, posOf) {
  if (tick % RESTOCK_INTERVAL !== 0) return { added: 0 };

  const live = await env.DB
    .prepare(
      `SELECT COUNT(*) n FROM game_bodies
        WHERE game_id = ? AND mineral_remaining > 0
          AND exhausted_at_tick IS NULL AND destroyed_at_tick IS NULL
          AND orbit_ra IS NOT NULL`,
    )
    .bind(gameId).first();
  if (Number(live?.n ?? 0) >= KUIPER_FLOOR) return { added: 0 };

  // Continue the catalogue rather than restarting it. MTR-31 tells a
  // player this rock arrived later, which is true and worth knowing.
  const top = await env.DB
    .prepare(
      `SELECT name FROM game_bodies
        WHERE game_id = ? AND name LIKE 'MTR-%'
        ORDER BY CAST(SUBSTR(name, 5) AS INTEGER) DESC LIMIT 1`,
    )
    .bind(gameId).first();
  const next = (Number(String(top?.name ?? 'MTR-00').slice(4)) || 0) + 1;

  // ARRIVE UNSEEN. A rock that materialises inside somebody's sensor
  // bubble is discovered the same tick it is born, which hands that
  // player a free find for having done nothing and makes the restock
  // feel like a gift rather than something to go looking for.
  //
  // Only the CURRENT position is checked, deliberately. The orbit will
  // carry it through somebody's coverage sooner or later — that is the
  // discovery mechanic working, and trying to guarantee a permanently
  // unobservable orbit would mean no orbit at all.
  const bubbles = posOf ? await sensorBubbles(env, gameId, tick, posOf) : new Map();
  const MAX_TRIES = 12;
  let ra, rp, a, angle0, best = null;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    ra = 2800 + rand() * 2200;
    rp = 300 + rand() * 900;
    a = (ra + rp) / 2;
    angle0 = rand() * TWO_PI;
    // Where it would be RIGHT NOW. The circular shortcut is enough for
    // a coverage test: an eccentric rock this far out moves slowly, and
    // the check only has to be right to within a sensor radius.
    const x = Math.cos(angle0) * a;
    const y = Math.sin(angle0) * a;
    if (!seenByAnyone(bubbles, x, y)) { best = { ra, rp, a, angle0 }; break; }
  }
  if (!best) {
    // Every candidate was observed — possible late in a game with a lot
    // of deep-space coverage. Skip this cycle rather than spawning in
    // plain sight; the belt is below its floor either way and the next
    // check is only RESTOCK_INTERVAL ticks out.
    return { added: 0, reason: 'no_unobserved_slot' };
  }
  ({ ra, rp, a, angle0 } = best);

  const id = `${gameId}:mtr_restock_${next}`;
  const tonnage = Math.round((1200 + rand() * 1200) / 25) * 25;
  const kind = rand() < 0.5 ? 'metal' : 'gold';

  await env.DB
    .prepare(
      `INSERT INTO game_bodies
         (id, game_id, template_id, name, type, parent_body_id,
          radius, soi, mu, orbit_radius, orbit_period, angle0, color,
          yield_metal, yield_fuel, yield_gold, yield_science,
          owner_faction_id, development_level, fortification_level, shipyard_level,
          orbit_rp, orbit_ra, orbit_omega, orbit_m0,
          mineral_kind, mineral_initial, mineral_remaining)
       VALUES (?, ?, ?, ?, 'meteoroid', NULL,
               ?, 0, 0, ?, ?, ?, '#6f6b78',
               0, 0, 0, 0,
               NULL, 0, 0, 0,
               ?, ?, ?, ?,
               ?, ?, ?)`,
    )
    .bind(
      id, gameId, `mtr_restock_${next}`, `MTR-${String(next).padStart(2, '0')}`,
      0.3 + rand() * 0.2, a, Math.round(TWO_PI * Math.sqrt((a * a * a) / 4000)),
      angle0,
      rp, ra, rand() * TWO_PI, rand() * TWO_PI,
      kind, tonnage, tonnage,
    )
    .run();

  // NO discovery rows. A new rock is undiscovered by everyone — the
  // belt restocking is not a gift, it is something somebody has to go
  // and find. That is what keeps a Telescope worth its Construction
  // level long after the opening survey.
  return { added: 1, id, name: `MTR-${String(next).padStart(2, '0')}`, kind, tonnage };
}
