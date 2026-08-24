// ============================================================
// DETONATION BLAST — the part of a detonation that hits STRUCTURES.
//
// There are still TWO detonation implementations: the manual endpoint
// in actions.js and detonateShip() in room.js (which the dead-man,
// arrival, timer and mine triggers all share). They already drifted
// once — the tick-loop copy forgot to resolve captains on death, and
// nobody noticed until a captain was left pointing at a destroyed
// hull.
//
// So station damage is written ONCE, here, and both import it. Adding
// it inline to both would have been a third copy of "who is in the
// blast and what does it do to them".
// ============================================================

/**
 * Stations take HALF what a hull in the same orbit takes.
 *
 * A station is a fixed installation with structure a ship does not
 * have; the same charge that guts a corvette should dent it, not gut
 * it. Halving is the whole rule, deliberately blunt — a per-class
 * table would be a second damage model to keep in step with combat's.
 */
export const STATION_BLAST_FRACTION = 0.5;

/**
 * Apply a detonation to the STATIONS sharing an orbit.
 *
 * CITIES ARE NOT TOUCHED, and that is a rule, not an oversight: a
 * detonation happens in orbit, and a city is on the ground. Bombardment
 * is what reaches a surface, and it has its own pass.
 *
 * FRIEND AND FOE ALIKE, matching the ship blast exactly. The charge
 * does not check flags — that is the whole reason the mine has a
 * "no friends in orbit" mode.
 *
 * SHIELDS ABSORB FIRST, the same way they do against bombardment. A
 * detonation that bypassed a shield would make a defensive investment
 * worthless against the one weapon it most wants to stop, and players
 * would read that as a bug rather than a rule.
 *
 * Returns { stmts, summaries } — statements for the caller to batch
 * alongside its own, so the whole blast still lands atomically.
 */
export async function planStationBlast(db, gameId, tick, bodyId, damage) {
  const out = { stmts: [], summaries: [] };
  const hit = Math.round(damage * STATION_BLAST_FRACTION * 100) / 100;
  if (!(hit > 0)) return out;

  const stations = (await db
    .prepare(
      `SELECT id, name, owner_faction_id, hp, shield_hp, shield_down_tick
         FROM game_settlements
        WHERE game_id = ? AND body_id = ? AND type = 'station'
          AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId, bodyId).all()).results ?? [];

  for (const s of stations) {
    const shield = Number(s.shield_hp ?? 0);
    const absorbed = Math.min(shield, hit);
    const shieldHp = shield - absorbed;
    // Stamp the moment it BROKE, not the last time anything hit it —
    // the same rule the bombardment pass uses for shield_down_tick.
    const shieldDownTick = (shield > 0 && shieldHp <= 0)
      ? tick
      : (s.shield_down_tick ?? null);
    const incoming = hit - absorbed;
    const newHp = Math.max(0, Number(s.hp ?? 0) - incoming);

    if (incoming > 0 && newHp <= 0) {
      out.stmts.push(db
        .prepare(`UPDATE game_settlements
                     SET hp = 0, destroyed_at_tick = ?, last_combat_tick = ?,
                         last_damaged_tick = ?, shield_hp = ?, shield_down_tick = ?
                   WHERE id = ?`)
        .bind(tick, tick, tick, shieldHp, shieldDownTick, s.id));
    } else {
      // last_damaged_tick stamps even when only the shield took it: from
      // the defender's side they are under fire either way, and the
      // urgent-alert logic keys off this stamp.
      out.stmts.push(db
        .prepare(`UPDATE game_settlements
                     SET hp = ?, last_combat_tick = ?, last_damaged_tick = ?,
                         shield_hp = ?, shield_down_tick = ?
                   WHERE id = ?`)
        .bind(newHp, tick, tick, shieldHp, shieldDownTick, s.id));
    }

    out.summaries.push({
      settlement_id: s.id,
      settlement_name: s.name,
      owner_faction_id: s.owner_faction_id,
      damage: hit,
      absorbed,
      destroyed: incoming > 0 && newHp <= 0,
    });
  }
  return out;
}

/**
 * Everything that has to happen AFTER a blast actually destroys a
 * station, beyond zeroing its hp.
 *
 * A station lost to bombardment is chronicled and re-triggers body
 * ownership; one lost to a detonation has to do the same or the two
 * deaths mean different things. Skipping this would leave a body still
 * flagged as held by a faction whose only station just evaporated, and
 * a log that never mentioned it.
 *
 * Best-effort by design: the hulls are already dead and committed. A
 * failure here costs a log line, never the blast.
 */
export async function finalizeStationBlast(db, gameId, tick, bodyId, summaries, killerFactionId) {
  const dead = (summaries ?? []).filter(s => s.destroyed);
  if (dead.length === 0) return;
  const now = Date.now();
  try {
    const body = await db.prepare('SELECT name FROM game_bodies WHERE id = ?').bind(bodyId).first();
    const facRows = (await db
      .prepare('SELECT id, name FROM game_factions WHERE game_id = ?')
      .bind(gameId).all()).results ?? [];
    const facName = new Map(facRows.map(f => [f.id, f.name]));
    for (const s of dead) {
      const row = await db
        .prepare('SELECT type, population FROM game_settlements WHERE id = ?')
        .bind(s.settlement_id).first();
      const payload = JSON.stringify({
        settlement_id: s.settlement_id,
        settlement_name: s.settlement_name ?? null,
        settlement_type: row?.type ?? 'station',
        body_id: bodyId,
        body_name: body?.name ?? '?',
        owner_faction_name: facName.get(s.owner_faction_id) ?? null,
        killer_faction_id: killerFactionId ?? null,
        killer_faction_name: killerFactionId ? (facName.get(killerFactionId) ?? null) : null,
        pop_lost: row?.population ?? 0,
      });
      await db
        .prepare(
          `INSERT INTO chronicle_entries
            (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
           VALUES (?, ?, ?, 'settlement_destroyed', ?, ?, ?, 'public', ?)`,
        )
        .bind(
          `c${tick}_blast_${s.settlement_id.slice(-6)}`,
          gameId, tick, s.owner_faction_id, bodyId, payload, now,
        )
        .run();
    }
  } catch (e) {
    console.error('station blast chronicle failed', e, { gameId, bodyId });
  }
}
