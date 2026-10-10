// ============================================================
// Refund a build order from its CHARGE LEDGER (migration 0084).
//
// Hands back exactly what the order took, to the purse it came from:
// local shares to the settlement that paid them while it still stands
// and is still yours, the rest (and any share whose settlement is gone)
// to the faction pool. The rule handleCancelBuild (actions.js) applies;
// this copy is for the tick, which cannot import actions.js.
//
// Returns { metal, gold } refunded, or null when the order carries no
// ledger (pre-0084), in which case nothing is paid: there is no honest
// way to reconstruct what such an order cost.
// ============================================================

export async function refundBuildLedger(db, gameId, factionId, chargeJson) {
  let ledger = null;
  try { ledger = chargeJson ? JSON.parse(chargeJson) : null; } catch { ledger = null; }
  if (!ledger) return null;
  let poolMetal = Number(ledger.pool?.metal ?? 0) || 0;
  let poolGold = Number(ledger.pool?.gold ?? 0) || 0;
  let localMetal = 0, localGold = 0;
  const stmts = [];
  for (const l of (Array.isArray(ledger.local) ? ledger.local : [])) {
    const m = Number(l.metal ?? 0) || 0;
    const g = Number(l.gold ?? 0) || 0;
    if (m <= 0 && g <= 0) continue;
    const alive = await db
      .prepare(
        `SELECT id FROM game_settlements
          WHERE id = ? AND game_id = ? AND owner_faction_id = ? AND destroyed_at_tick IS NULL`,
      )
      .bind(l.id, gameId, factionId).first();
    if (alive) {
      stmts.push(db
        .prepare('UPDATE game_settlements SET stockpile_metal = stockpile_metal + ?, stockpile_gold = stockpile_gold + ? WHERE id = ?')
        .bind(m, g, l.id));
      localMetal += m; localGold += g;
    } else {
      poolMetal += m; poolGold += g;
    }
  }
  if (poolMetal > 0 || poolGold > 0) {
    stmts.push(db
      .prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
      .bind(poolMetal, poolGold, factionId));
  }
  if (stmts.length) await db.batch(stmts);
  return { metal: poolMetal + localMetal, gold: poolGold + localGold };
}
