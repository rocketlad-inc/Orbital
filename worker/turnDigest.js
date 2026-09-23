// ============================================================
// WHAT CHANGED LAST TURN, in one line.
//
// A turn is an hour of real time and most of it is invisible: a fleet
// lands, a yard finishes a hull, a world flips, a fight costs you two
// destroyers. Until now the only way to learn any of that was to open
// the game and read the log. This sends ONE notification per turn per
// player, and only when something actually happened -- so the habit it
// builds is "glance, act if it matters", not "open the game and look
// for what changed".
//
// WHAT COUNTS AS SOMETHING HAPPENING, all drawn from the tick's own
// bookkeeping rather than from a second set of rules:
//
//   arrivals   game_ship_nodes executed this tick with a destination
//   kills      battle_participants whose died_tick is this tick
//   worlds     game_bodies claimed_at_tick, gained or lost
//   hulls      game_ships built_at_tick
//
// NOT SENT WHEN THE TURN WAS QUIET. An empty turn is the common case at
// three in the morning, and a notification that says "nothing happened"
// is the one that gets the whole category muted.
//
// ONE PER TURN, KEYED ON THE TURN. dedupeKey is `turn:<gameId>:<tick>`:
// a retry, a double tick or a worker restart cannot produce two.
// ============================================================

/** A digest is worth sending only if one of these is non-zero. */
function anything(d) {
  return d.arrived > 0 || d.killed > 0 || d.lost > 0 || d.gained > 0 || d.built > 0;
}

/** The line itself, in the order a commander would want it. */
function line(d) {
  const parts = [];
  if (d.lost > 0) parts.push(`${d.lost} lost`);
  if (d.killed > 0) parts.push(`${d.killed} killed`);
  if (d.gained > 0) parts.push(`${d.gained} ${d.gained === 1 ? 'world' : 'worlds'} claimed`);
  if (d.arrived > 0) parts.push(`${d.arrived} ${d.arrived === 1 ? 'arrival' : 'arrivals'}`);
  if (d.built > 0) parts.push(`${d.built} built`);
  return parts.join(' · ');
}

/**
 * Send every human faction in this game its turn digest.
 *
 * Six counts, one query each, all keyed on the tick that just resolved.
 * Called from runTickAlerts after the interrupts, because an interrupt
 * about a battle should arrive before the summary that mentions it.
 */
export async function turnDigest(env, notify, gameId, gameName, tick) {
  const humans = (await env.DB
    .prepare(
      `SELECT id, name, user_id FROM game_factions
        WHERE game_id = ? AND status = 'active' AND user_id IS NOT NULL`,
    )
    .bind(gameId).all()).results ?? [];
  if (!humans.length) return;

  const rows = async (sql, ...bind) => (await env.DB.prepare(sql).bind(...bind).all().catch(() => ({ results: [] }))).results ?? [];

  // Arrivals: a node that executed this tick and had somewhere to be.
  const arrivals = await rows(
    `SELECT s.owner_faction_id AS f, COUNT(*) AS n
       FROM game_ship_nodes n JOIN game_ships s ON s.id = n.ship_id
      WHERE n.game_id = ?1 AND n.status = 'executed' AND n.executed_at_tick = ?2
        AND n.target_body_id IS NOT NULL
      GROUP BY s.owner_faction_id`,
    gameId, tick,
  );
  // Every hull that died this tick, with the battle it died in -- so a
  // kill can be counted as what died in a fight this faction was in,
  // rather than inferred from everyone else's losses.
  const deaths = await rows(
    `SELECT p.battle_id AS b, p.faction_id AS f
       FROM battle_participants p JOIN battles bt ON bt.id = p.battle_id
      WHERE bt.game_id = ?1 AND p.died_tick = ?2 AND p.faction_id IS NOT NULL`,
    gameId, tick,
  );
  // Who was in those battles at all (dead or alive), for the same reason.
  const inBattle = new Map();
  if (deaths.length) {
    const ids = [...new Set(deaths.map(d => d.b))];
    // D1 caps a statement at 100 parameters; a json_each list has none.
    const parts = await rows(
      `SELECT DISTINCT battle_id AS b, faction_id AS f
         FROM battle_participants
        WHERE battle_id IN (SELECT value FROM json_each(?1)) AND faction_id IS NOT NULL`,
      JSON.stringify(ids),
    );
    for (const r of parts) {
      if (!inBattle.has(r.b)) inBattle.set(r.b, new Set());
      inBattle.get(r.b).add(r.f);
    }
  }
  // Worlds that changed hands this tick, and who holds them now.
  const claims = await rows(
    `SELECT owner_faction_id AS f, COUNT(*) AS n
       FROM game_bodies
      WHERE game_id = ?1 AND claimed_at_tick = ?2 AND owner_faction_id IS NOT NULL
      GROUP BY owner_faction_id`,
    gameId, tick,
  );
  const built = await rows(
    `SELECT owner_faction_id AS f, COUNT(*) AS n
       FROM game_ships
      WHERE game_id = ?1 AND built_at_tick = ?2
      GROUP BY owner_faction_id`,
    gameId, tick,
  );
  const by = (list) => new Map(list.map(r => [r.f, Number(r.n) || 0]));
  const arrivedBy = by(arrivals);
  const claimsBy = by(claims);
  const builtBy = by(built);

  for (const me of humans) {
    let lost = 0;
    let killed = 0;
    for (const dead of deaths) {
      if (dead.f === me.id) lost += 1;
      else if (inBattle.get(dead.b)?.has(me.id)) killed += 1;
    }
    const d = {
      arrived: arrivedBy.get(me.id) ?? 0,
      lost,
      killed,
      gained: claimsBy.get(me.id) ?? 0,
      built: builtBy.get(me.id) ?? 0,
    };
    if (!anything(d)) continue;
    await notify.sendDm(env, {
      userId: me.user_id,
      gameId,
      category: 'turn',
      dedupeKey: `turn:${gameId}:${tick}`,
      url: '/',
      embed: {
        title: `Turn ${tick} · ${gameName}`,
        description: line(d),
      },
    }).catch(() => {});
  }
}
