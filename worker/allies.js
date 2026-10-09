// Who shares a faction's vision: the other signatories of an active
// defense pact or intel-share pact. Non-aggression and construction
// pacts do not share sight.
//
// ONE query for every caller (/state for the fog, /factions for the
// capital pins), so the two can never disagree about who is an ally.
//
// An ELIMINATED partner shares nothing. Its treaties are not torn up when
// it falls, so without the status check a dead empire's surviving hulls
// kept lighting its partner's map (sensor audit, 2026-10-08). A revived
// empire is 'active' again and shares again.
export function allyIdsQuery(env, gameId, factionId, tick) {
  return env.DB
    .prepare(
      `SELECT DISTINCT ts2.faction_id AS ally_id
         FROM treaties t
         JOIN treaty_signatories ts1
           ON ts1.treaty_id = t.id AND ts1.faction_id = ?2 AND ts1.signed_at_tick IS NOT NULL
         JOIN treaty_signatories ts2
           ON ts2.treaty_id = t.id AND ts2.faction_id != ?2 AND ts2.signed_at_tick IS NOT NULL
         JOIN game_factions af
           ON af.id = ts2.faction_id AND af.status = 'active'
        WHERE t.game_id = ?1
          AND t.status = 'active'
          AND t.broken_at_tick IS NULL
          AND t.kind IN ('defense_pact', 'intel_share')
          AND (t.expires_at_tick IS NULL OR t.expires_at_tick > ?3)`,
    )
    .bind(gameId, factionId, tick)
    .all();
}

export async function allyIds(env, gameId, factionId, tick) {
  const rows = (await allyIdsQuery(env, gameId, factionId, tick)).results ?? [];
  return rows.map(r => r.ally_id);
}
