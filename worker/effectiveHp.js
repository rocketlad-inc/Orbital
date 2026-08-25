// ============================================================
// effectiveHp — the ONE number a hull's "max HP" means.
//
// `game_ships.hp_max` is the build-time base. The ceiling the game
// actually enforces — the repair cap, the health bar, the number the
// client renders — is base × veterancy × armor tech × Bulwark captain
// × fleet Bulwark aura, computed in bulk by /state's enrichment
// (worker/state.js) and by the maintenance pass (worker/room.js §3.45).
//
// Detonators were the odd one out: blast damage is priced off the
// carrier's MAX HP, and both server detonation sites fed the STORED
// base while every client surface promised a blast off the EFFECTIVE
// ceiling. Player report (clownking, 2026-08-25): destroyer showing
// 1987 max, tooltip promising 1391, blast dealing 892 — the tooltip
// was base×armor and the server was bare base, so the promise and the
// payout could never agree on any ranked or armor-teched hull.
//
// This helper recomputes the SAME ceiling per-ship, self-contained:
// it re-reads everything it needs by ship id, so call sites don't
// each have to widen their SELECTs (there are five detonation paths
// behind two call sites, each with its own query).
//
// MIRRORS worker/state.js hp_max_effective — the factor list and the
// constants must match, or a hull's blast stops matching its health
// bar. A guard test parses both.
// ============================================================

/**
 * The enforced max-HP ceiling for one ship, by id.
 * Returns the stored hp_max untouched if the ship can't be read —
 * a detonation should degrade to the old number, never throw.
 */
export async function effectiveHpMaxOf(DB, gameId, shipId) {
  const ship = await DB
    .prepare(
      // Veterancy is CAPTAIN-ONLY (spec §2): an uncrewed hull is rank 0,
      // full stop. s.rank is the legacy hull column and must NOT be read
      // — every other surface (/state's COALESCE, the transit pass)
      // already keys rank off the captain, and this helper reading the
      // hull column made a blast disagree with the served ceiling.
      `SELECT s.hp_max, COALESCE(c.rank, 0) AS rank, s.owner_faction_id, s.fleet_id,
              c.traits_json AS captain_traits
         FROM game_ships s
         LEFT JOIN game_captains c ON c.id = s.captain_id
        WHERE s.id = ? AND s.game_id = ?`,
    )
    .bind(shipId, gameId)
    .first();
  if (!ship) return 0;
  const base = Number(ship.hp_max) || 0;

  try {
    // Armor tech: best defensive line, +8%/level. armor covers shields
    // in legacy games until shields is researched (same max() as
    // state.js and the maintenance pass).
    const techRows = (await DB
      .prepare(
        `SELECT tech_id, level FROM faction_techs
          WHERE game_id = ? AND faction_id = ? AND tech_id IN ('armor','shields')`,
      )
      .bind(gameId, ship.owner_faction_id)
      .all()).results ?? [];
    const lvl = Object.fromEntries(techRows.map(r => [r.tech_id, r.level ?? 0]));
    const armorMul = 1 + 0.08 * Math.max(lvl.armor ?? 0, lvl.shields ?? 0);

    // Own Bulwark captain: +10%.
    let capHp = 1;
    if (ship.captain_traits) {
      try {
        if (JSON.parse(ship.captain_traits).includes('bulwark')) capHp = 1.10;
      } catch { /* bad blob = no bonus */ }
    }

    // Fleet Bulwark aura — halved, flagship excluded (DESIGN-fleets P2).
    let auraHp = 1;
    if (ship.fleet_id) {
      const flag = await DB
        .prepare(
          `SELECT fc.ship_id AS flagship_id, fc.traits_json
             FROM game_fleets f
             JOIN game_captains fc ON fc.id = f.flag_captain_id
            WHERE f.id = ? AND f.flag_captain_id IS NOT NULL`,
        )
        .bind(ship.fleet_id)
        .first();
      if (flag && flag.flagship_id !== shipId) {
        try {
          if (JSON.parse(flag.traits_json || '[]').includes('bulwark')) {
            auraHp = 1 + (1.10 - 1) / 2;
          }
        } catch { /* bad blob = no aura */ }
      }
    }

    return Math.round(
      base
      * (1 + 0.01 * Math.max(0, ship.rank ?? 0))
      * armorMul
      * capHp
      * auraHp,
    );
  } catch {
    // Enrichment failed — the stored base is still a sane blast price.
    return base;
  }
}
