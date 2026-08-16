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

import { kuiperElements, orbitPeriodFor } from './meteoroids.js';
import {
  SHIP_SENSOR_RANGE, DEFAULT_SHIP_SENSOR_RANGE,
  settlementSensorRange,
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
      `SELECT owner_faction_id AS fid, type, body_id, buildings_json
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
    // Telescopes are folded in by settlementSensorRange, so this pass
    // never has to know the building exists.
    add(st.fid, st.body_id, settlementSensorRange(st.type, st.buildings_json));
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

  // TELL THE FINDER. A rock appearing on the map with no explanation
  // reads as a rendering glitch; a line in the log makes it a survey
  // result. Scoped to the finding faction — a rival's discovery is not
  // your news, and announcing it publicly would undo the fog the
  // discovery table exists to enforce.
  try {
    const names = new Map();
    const rows = (await env.DB
      .prepare(
        `SELECT id, name, mineral_kind, mineral_remaining FROM game_bodies
          WHERE game_id = ? AND id IN (${finds.map(() => '?').join(',')})`,
      )
      .bind(gameId, ...finds.map(f => f.bodyId)).all()).results ?? [];
    for (const r of rows) names.set(r.id, r);
    await env.DB.batch(finds.map(f => {
      const r = names.get(f.bodyId) ?? {};
      return env.DB.prepare(
        `INSERT OR IGNORE INTO chronicle_entries
           (id, game_id, tick_number, kind, actor_faction_id, body_id,
            payload, visibility, created_at_ms)
         VALUES (?, ?, ?, 'meteoroid_found', ?, ?, ?, ?, ?)`,
      ).bind(
        `c_mtrf_${String(f.bodyId).slice(-8)}_${String(f.fid).slice(-6)}`,
        gameId, tick, f.fid, f.bodyId,
        JSON.stringify({ name: r.name, kind: r.mineral_kind,
                         tons: Math.round(Number(r.mineral_remaining ?? 0)) }),
        JSON.stringify([f.fid]), Date.now(),
      );
    }));
  } catch (e) { console.error('meteoroid discovery chronicle failed', e); }

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
  // The band comes from where NEPTUNE actually is, via the same helper
  // worldgen uses. These were two independent copies of the same
  // literals (2800-5000), and both were wrong: written in pre-scale
  // units for a system factions.js doubles at load, they put "Kuiper"
  // rocks between Uranus and Neptune. A restocked rock must land in the
  // same band as a seeded one or the belt drifts inward over a long
  // game, one restock at a time.
  const outer = await env.DB
    .prepare(
      `SELECT MAX(orbit_radius) AS r FROM game_bodies
        WHERE game_id = ? AND mineral_kind IS NULL
          AND type IN ('terrestrial', 'gas-giant', 'ice-giant')`,
    )
    .bind(gameId).first();
  const anchorR = Number(outer?.r) || 3000;

  // And the period against the mu THIS game's planets imply, not a
  // literal — rogue asteroids excluded, since they deliberately run at
  // half their Kepler period and would skew it badly.
  const muRow = await env.DB
    .prepare(
      `SELECT orbit_radius r, orbit_period p FROM game_bodies
        WHERE game_id = ? AND mineral_kind IS NULL
          AND type IN ('terrestrial', 'gas-giant', 'ice-giant')
          AND orbit_radius > 0 AND orbit_period > 0
        ORDER BY orbit_radius LIMIT 1 OFFSET 2`,
    )
    .bind(gameId).first();
  const mu = muRow
    ? 4 * Math.PI * Math.PI * Math.pow(Number(muRow.r), 3) / Math.pow(Number(muRow.p), 2)
    : 6003;

  let ra, rp, a, angle0, best = null;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    ({ ra, rp, a } = kuiperElements(rand, anchorR));
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
       VALUES (?, ?, ?, ?, 'meteoroid', ?,
               ?, 0, 0, ?, ?, ?, '#6f6b78',
               0, 0, 0, 0,
               NULL, 0, 0, 0,
               ?, ?, ?, ?,
               ?, ?, ?)`,
    )
    .bind(
      id, gameId, `mtr_restock_${next}`, `MTR-${String(next).padStart(2, '0')}`,
      // PARENT IS SOL, like every other rock. This insert said NULL,
      // which in this schema is what the STAR itself is — so a restocked
      // rock would have been the only heliocentric body in the game not
      // parented to Sol, and anything keying off `parent === 'sol'`
      // (map labels, the orbit-ring layer, body pickers) would quietly
      // treat it as a different class of object. No rock has restocked
      // in a live game yet, so this never bit.
      `${gameId}:sol`,
      0.3 + rand() * 0.2, a, orbitPeriodFor(a, mu),
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

/**
 * A NEW TELESCOPE FINDS SOMETHING IMMEDIATELY.
 *
 * Without this, finishing an expensive building produces no visible
 * result until a rock's orbit happens to wander into range — which
 * could be hundreds of ticks, and reads as "I built the thing and
 * nothing happened". One guaranteed find makes the purchase legible.
 *
 * It grants the NEAREST undiscovered rock, not a random one, so the
 * reward is thematically a survey rather than a lottery, and a
 * telescope on a border world tends to find what is actually near it.
 */
export async function telescopeFirstLight(env, gameId, factionId, bodyId, tick, posOf) {
  const known = new Set(((await env.DB
    .prepare('SELECT body_id FROM game_body_discoveries WHERE game_id = ? AND faction_id = ?')
    .bind(gameId, factionId).all()).results ?? []).map(r => r.body_id));

  const rocks = ((await env.DB
    .prepare(
      `SELECT id FROM game_bodies
        WHERE game_id = ? AND mineral_remaining > 0
          AND exhausted_at_tick IS NULL AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId).all()).results ?? []).filter(r => !known.has(r.id));
  if (rocks.length === 0) return { found: null };

  const home = posOf(bodyId, tick);
  if (!home) return { found: null };

  let best = null, bestD = Infinity;
  for (const r of rocks) {
    const p = posOf(r.id, tick);
    if (!p) continue;
    const d = (p.x - home.x) ** 2 + (p.y - home.y) ** 2;
    if (d < bestD) { bestD = d; best = r.id; }
  }
  if (!best) return { found: null };

  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO game_body_discoveries
         (game_id, body_id, faction_id, discovered_at_tick, method)
       VALUES (?, ?, ?, ?, 'survey')`,
    )
    .bind(gameId, best, factionId, tick).run();

  try {
    const r = await env.DB
      .prepare('SELECT name, mineral_kind, mineral_remaining FROM game_bodies WHERE id = ?')
      .bind(best).first();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO chronicle_entries
         (id, game_id, tick_number, kind, actor_faction_id, body_id,
          payload, visibility, created_at_ms)
       VALUES (?, ?, ?, 'meteoroid_found', ?, ?, ?, ?, ?)`,
    ).bind(
      `c_mtrf_${String(best).slice(-8)}_${String(factionId).slice(-6)}`,
      gameId, tick, factionId, best,
      JSON.stringify({ name: r?.name, kind: r?.mineral_kind,
                       tons: Math.round(Number(r?.mineral_remaining ?? 0)) }),
      JSON.stringify([factionId]), Date.now(),
    ).run();
  } catch (e) { console.error('telescope first-light chronicle failed', e); }

  return { found: best };
}

/** Units a rigged freighter pulls per tick. MIRRORS MINE_RATE_PER_TICK
 *  in worker/room.js — the routed path's rate, deliberately identical.
 *  A hand-worked rock that filled faster would make the manual flow
 *  strictly better than the automated one and delete the tradeoff. */
export const MANUAL_MINE_RATE = 50;

/**
 * MANUAL MINING — hulls a player pointed at a rock by hand.
 *
 * Runs beside the trade-route walk rather than inside it: these ships
 * have no route, no stop cursor and no autopilot. The only state is
 * game_ships.mining_body_id, and this pass is what turns that flag into
 * ore.
 *
 * It re-checks every precondition the endpoint checked, because a tick
 * happens later than the click: the hull may have departed, the rock may
 * have been worked out by somebody else, the hold may have filled. Each
 * of those simply STOPS the operation rather than erroring — there is
 * nobody to show an error to.
 *
 * @param holdCapFor  injected so this file does not import routeMath
 *                    (and so the sim can drive it with a fixed cap).
 */
export async function runManualMining(env, gameId, tick, holdCapFor) {
  const rows = (await env.DB
    .prepare(
      `SELECT s.id, s.owner_faction_id, s.parent_body_id, s.mining_body_id,
              s.cargo_fuel, s.cargo_metal, s.cargo_gold, s.cargo_science,
              c.traits_json AS captain_traits,
              b.name AS rock_name, b.mineral_kind, b.mineral_remaining
         FROM game_ships s
         LEFT JOIN game_captains c ON c.id = s.captain_id
         LEFT JOIN game_bodies b ON b.id = s.mining_body_id
        WHERE s.game_id = ? AND s.mining_body_id IS NOT NULL
          AND s.status = 'active'`,
    )
    .bind(gameId).all()).results ?? [];
  if (rows.length === 0) return { worked: 0, stopped: 0 };

  let worked = 0, stopped = 0;
  const clear = async (id) => {
    await env.DB.prepare('UPDATE game_ships SET mining_body_id = NULL WHERE id = ?')
      .bind(id).run();
    stopped += 1;
  };

  for (const r of rows) {
    // DEPARTED. The flag survives a burn order, so a hull that flew away
    // must not keep mining a rock it is no longer at.
    if (r.parent_body_id !== r.mining_body_id) { await clear(r.id); continue; }
    // In transit while still parented to the rock (mid-departure).
    const flying = await env.DB
      .prepare("SELECT 1 AS x FROM game_ship_nodes WHERE ship_id = ? AND status = 'in_transit' LIMIT 1")
      .bind(r.id).first();
    if (flying) { await clear(r.id); continue; }

    const left = Number(r.mineral_remaining ?? 0);
    if (!r.mineral_kind || left <= 0) { await clear(r.id); continue; }

    const cap = holdCapFor(r.captain_traits);
    const carried = Number(r.cargo_fuel ?? 0) + Number(r.cargo_metal ?? 0)
      + Number(r.cargo_gold ?? 0) + Number(r.cargo_science ?? 0);
    const space = Math.max(0, cap - carried);
    if (space <= 0) { await clear(r.id); continue; }

    const take = Math.min(MANUAL_MINE_RATE, space, left);
    const col = r.mineral_kind === 'gold' ? 'cargo_gold' : 'cargo_metal';
    await env.DB
      .prepare(`UPDATE game_ships SET ${col} = ${col} + ? WHERE id = ?`)
      .bind(take, r.id).run();
    const after = left - take;
    await env.DB
      .prepare(
        `UPDATE game_bodies SET mineral_remaining = ?, exhausted_at_tick = ?
          WHERE id = ? AND game_id = ?`,
      )
      .bind(after, after <= 0 ? tick : null, r.mining_body_id, gameId).run();
    worked += 1;

    // Stop cleanly at either end condition, and SAY SO — a hull that
    // quietly stopped digging is the kind of thing a player finds out
    // about three ticks later by staring at a cargo number.
    if (after <= 0 || take >= space) {
      await clear(r.id);
      try {
        await env.DB
          .prepare(
            `INSERT OR IGNORE INTO chronicle_entries
              (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'private', ?)`,
          )
          .bind(
            `c_mm_${r.id}_${tick}`, gameId, tick,
            after <= 0 ? 'rock_exhausted' : 'hold_full',
            r.owner_faction_id, r.mining_body_id,
            JSON.stringify({
              rock: r.rock_name,
              reason: after <= 0 ? 'worked out' : 'hold full',
            }),
            Date.now(),
          )
          .run();
      } catch { /* chronicle is a nicety, never a tick failure */ }
    }
  }
  return { worked, stopped };
}
