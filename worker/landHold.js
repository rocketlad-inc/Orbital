// ============================================================
// LAND A HOLD IN PLACE — where a released load goes when the freighter
// carrying it is parked at its own world.
//
// Cancelling a route (or taking a hull off one) keeps the cargo in the
// ship's hold (Lorne): refunding it to the pool from wherever the
// freighter was made cancel the fastest freight service in the game.
// That rule is about TELEPORTING goods. A freighter parked at a world
// where its empire has a settlement teleports nothing, yet the load was
// still stranded aboard, out of the stockpile it had just been taken
// from: "cancelling a delivery from a raw world while the freighter is
// in orbit dumps cargo in space instead of returning to the stockpile"
// (CMDR Poopypants, 2026-10-05).
//
// So, parked at a world with a live settlement of the SHIP's owner:
//   raw world        -> that settlement's stockpile (where pickups draw)
//   terraformed world -> the faction pool, exactly as a dropoff there
//                        and as DELIVER TO POOL do (legacy fuel is
//                        discarded, as handleUnloadHold does)
// Anywhere else (in flight, at someone else's world) the load stays
// aboard as before.
// ============================================================

/**
 * Where a hold released right now would land, or null to keep it aboard.
 * Read-only, so callers can fold the write into their own batch.
 */
export async function holdLanding(env, gameId, shipId) {
  const flying = await env.DB
    .prepare(`SELECT 1 FROM game_ship_nodes WHERE ship_id = ? AND status = 'in_transit' LIMIT 1`)
    .bind(shipId).first();
  if (flying) return null;
  const at = await env.DB
    .prepare(
      `SELECT st.id AS settlement_id, sh.owner_faction_id AS owner, b.terraformed_at_tick AS tf
         FROM game_ships sh
         JOIN game_bodies b ON b.id = sh.parent_body_id
         JOIN game_settlements st ON st.game_id = sh.game_id AND st.body_id = b.id
                                 AND st.owner_faction_id = sh.owner_faction_id
                                 AND st.destroyed_at_tick IS NULL
        WHERE sh.id = ? AND sh.game_id = ? AND sh.status = 'active'
        ORDER BY (st.type = 'station') DESC
        LIMIT 1`,
    )
    .bind(shipId, gameId).first();
  if (!at) return null;
  return at.tf == null
    ? { kind: 'stockpile', settlementId: at.settlement_id }
    : { kind: 'pool', factionId: at.owner };
}

/** The write that puts `cargo` where `landing` says, or into the hold. */
export function landHoldStatement(env, shipId, landing, cargo) {
  const f = Number(cargo.fuel ?? 0), m = Number(cargo.metal ?? 0);
  const g = Number(cargo.gold ?? 0), s = Number(cargo.science ?? 0);
  if (landing?.kind === 'stockpile') {
    return env.DB.prepare(
      `UPDATE game_settlements SET stockpile_fuel = stockpile_fuel + ?, stockpile_metal = stockpile_metal + ?,
              stockpile_gold = stockpile_gold + ?, stockpile_science = stockpile_science + ? WHERE id = ?`,
    ).bind(f, m, g, s, landing.settlementId);
  }
  if (landing?.kind === 'pool') {
    return env.DB.prepare(
      'UPDATE game_factions SET metal = metal + ?, gold = gold + ?, science = science + ? WHERE id = ?',
    ).bind(m, g, s, landing.factionId);
  }
  return env.DB.prepare(
    `UPDATE game_ships SET cargo_fuel = cargo_fuel + ?, cargo_metal = cargo_metal + ?,
            cargo_gold = cargo_gold + ?, cargo_science = cargo_science + ? WHERE id = ?`,
  ).bind(f, m, g, s, shipId);
}
