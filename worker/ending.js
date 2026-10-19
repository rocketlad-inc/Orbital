// ============================================================================
// GET /api/games/:gameId/ending — everything the end-of-game page shows,
// computed once, on demand, for a FINISHED game.
//
// The shape is the contract in src/multiplayer/endingTypes.ts (EndingPayload).
// This file is the only producer. Principles it keeps:
//
//   * Structure, not prose. Ids and numbers; the page owns every word.
//   * Nothing a player could not already see in the game: faction names,
//     colours, emblems, ship and captain names. No emails, no account display
//     names, no user ids (user_id is read only to find the VIEWER's empire and
//     is never copied into the payload).
//   * An award exists only when real data stands behind it.
//
// Cost: two round trips. One (in parallel) for the game row + membership, then
// ONE env.DB.batch carrying every aggregate. No per-faction loops. Every
// statement binds <= 4 params (D1 allows 100).
//
// ---------------------------------------------------------------------------
// WHERE EACH NUMBER COMES FROM (and why — several tables look interchangeable
// and are not; this was checked against production rows of finished games):
//
//  holdings  Worlds (distinct bodies) on which the empire had a settlement,
//            rebuilt from game_settlements' own lifetime (created_at_tick ..
//            destroyed_at_tick, one row per settlement, owner fixed: a seizure
//            destroys the old row and creates a new one). NOT from
//            faction_metrics.settlements: that column counts every settlement
//            row the empire ever owned, destroyed ones included, so on prod it
//            only ever climbs (an empire with 5 live settlements reads 29).
//            This is also the lobby's definition (COUNT DISTINCT body_id).
//  ships     game_ships with hp > 0 (final), faction_metrics.ships (series,
//            peak) — the same predicate, so the curve ends where final says.
//  credits   faction_metrics.gold / game_factions.gold (the app calls gold
//            "credits"). science and metal likewise.
//  techs     SUM(faction_techs.level): research levels completed across the
//            tech tracks. (A track row is one tech with a level up to 10, so
//            counting rows would cap everyone at 6.) Ties on the scholar award
//            go to whoever got there first (MAX(completed_at_tick)).
//  kills     battle_participants rows where this empire is killer_faction_id
//            and the victim belonged to someone else. NOT game_ship_stats.kills:
//            that column credits EVERY attacker present at a kill, so on prod a
//            corvette with one real kill reads 24 and an empire with 113 hulls
//            lost reads 7502 kills. Hull "ace" uses killer_ship_id the same way.
//  shipsLost battle_participants rows with died_tick set, by the loser's empire.
//  damage    SUM(game_ship_stats.damage_dealt) by empire (complete per tick;
//            battle_participants omits some pre-battle fire). It agrees with
//            the per-battle numbers to within a few percent.
//  last_stand game_ship_stats.low_hp_kills, capped at the hull's real kills
//            (killer_ship_id) because it shares kills' over-crediting.
//  shipsBuilt chronicle_entries kind 'ship_built' by actor (every hull class).
//  trades    One "trade" = one ACCEPTED trade_offers row that moves goods or a
//            ship (pact-only acceptances — a NAP with nothing attached — are
//            diplomacy, not trade), plus any market_fills row that has no
//            accepted offer behind it (market fills normally ARE accepted
//            offers, so adding both would count them twice). Each of the two
//            parties is credited once. Route runs and deliveries are the
//            *execution* of a trade and are not counted again.
//  billsPassed senate_proposals status 'passed' by proposer.
//  warsDeclared game_wars.declared_by with origin = 'declared' (not 'seeded' —
//            the starting state — nor 'pact_broken'). totals.wars counts every
//            war except 'seeded'.
//  series    faction_metrics (gold -> credits, science, ships) at <= 120 ticks:
//            every `stride`-th tick plus the first and the last recorded tick,
//            with holdings rebuilt as above at those same ticks. Missing rows
//            (not yet in, or already out of, the game) read 0.
//  battles   battles + battle_participants (the three with most hulls lost).
//            endedTick falls back to last_fire_tick for a battle whose quiet
//            window never closed before the game ended. settlementsLost:
//            battles.settlements_lost is 0 on every prod game checked, so it
//            is the larger of that and the settlements of that body destroyed
//            during the battle (game_settlements.destroyed_at_tick); the
//            game-wide total is the count of destroyed settlement rows.
//  place     winner first, then final holdings, ships, techs, credits (all
//            descending), then later elimination, then seat number: a total
//            order.
//  empires   Monster and observer seats (the Leviathan) are not empires and
//            appear nowhere. Their hulls still count in the battle totals.
// ============================================================================

const GAME_ID = '[A-Za-z0-9_-]{6,32}';
const MAX_POINTS = 120;

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}
function err(status, code, message) {
  return json({ code, error: { code, message } }, { status });
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const whole = (v) => Math.round(num(v));
const rows = (res) => res?.results ?? [];

/** { key -> number } from rows of [keyCol, valCol]. */
function sumBy(list, keyCol, valCol) {
  const out = new Map();
  for (const r of list) {
    const k = r[keyCol];
    if (k == null) continue;
    out.set(k, (out.get(k) ?? 0) + num(r[valCol]));
  }
  return out;
}

/**
 * Holdings over time for one empire. `events` is [{tick, body, d}] with d = +1
 * when a settlement appears and -1 when it dies. Returns the state after each
 * distinct event tick: [{tick, n}] where n = distinct bodies still held.
 */
function holdingsStates(events) {
  const sorted = [...events].sort((a, b) => a.tick - b.tick);
  const perBody = new Map();
  let n = 0;
  const states = [];
  for (let i = 0; i < sorted.length;) {
    const tick = sorted[i].tick;
    while (i < sorted.length && sorted[i].tick === tick) {
      const e = sorted[i++];
      const before = perBody.get(e.body) ?? 0;
      const after = before + e.d;
      perBody.set(e.body, after);
      if (before <= 0 && after > 0) n++;
      else if (before > 0 && after <= 0) n--;
    }
    states.push({ tick, n });
  }
  return states;
}

function holdingsAt(states, tick) {
  let lo = 0, hi = states.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (states[mid].tick <= tick) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best < 0 ? 0 : states[best].n;
}

/** Evenly thin an ascending list to <= max entries, keeping first and last. */
function thin(list, max) {
  if (list.length <= max) return list;
  const out = [];
  for (let i = 0; i < max; i++) out.push(list[Math.round((i * (list.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}

/**
 * Build the ending payload.
 *
 * `opts` exists for tooling only (scripts/ending-from-prod.mjs): `asFactionId`
 * picks the viewer's empire directly and `skipMembership` waives the
 * membership check. The HTTP handler never sets either.
 *
 * Returns an EndingPayload, or `{ error: { status, code, message } }`.
 */
export async function buildEnding(env, gameId, viewerUserId, opts = {}) {
  const [game, member] = await Promise.all([
    env.DB.prepare(
      `SELECT g.id, g.status, g.victory_type, g.winner_faction_id, g.current_tick,
              g.tick_interval_ms, g.started_at, g.completed_at, r.name
         FROM games g JOIN rooms r ON r.id = g.id
        WHERE g.id = ?`,
    ).bind(gameId).first(),
    opts.skipMembership
      ? Promise.resolve({ fid: null, rm: 1 })
      : env.DB.prepare(
        `SELECT (SELECT id FROM game_factions WHERE game_id = ? AND user_id = ?) AS fid,
                (SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?) AS rm`,
      ).bind(gameId, viewerUserId ?? '', gameId, viewerUserId ?? '').first(),
  ]);
  if (!game) return { error: { status: 404, code: 'not_found', message: 'game not found' } };
  if (!opts.skipMembership && !member?.fid && !member?.rm) {
    return { error: { status: 403, code: 'not_a_member', message: 'you are not in this game' } };
  }
  if (game.status !== 'completed') {
    return { error: { status: 409, code: 'not_finished', message: 'this game is still being played' } };
  }

  const currentTick = Math.max(0, whole(game.current_tick));
  const stride = Math.max(1, Math.ceil(currentTick / (MAX_POINTS - 2)));
  const q = (sql, ...binds) => env.DB.prepare(sql).bind(...binds);
  const g = gameId;

  const battleParticipantsOfGame = 'p JOIN battles b ON b.id = p.battle_id WHERE b.game_id = ?';
  // The same ordering twice (top battles; their per-empire losses) must agree.
  const TOP_BATTLES = `SELECT id FROM battles WHERE game_id = ? AND ships_lost > 0
                        ORDER BY ships_lost DESC, shots DESC, started_tick ASC LIMIT 3`;
  // Each empire's single best hull by `v` ("champions"), best first. One row
  // per empire is what the award needs: the winner is the first row and the
  // runner-up the second, however many of the top hulls belong to one fleet.
  // `inner` selects ship_id, ship_name, ship_class, faction_id, v from game_ship_stats s.
  // The captain (latest one on record) is looked up for the survivors only.
  const champions = (inner) => `
    SELECT t.ship_id, t.ship_name, t.ship_class, t.faction_id, t.v,
           (SELECT q2.captain_name FROM battle_participants q2
             WHERE q2.ship_id = t.ship_id AND q2.captain_name IS NOT NULL
             ORDER BY q2.last_tick DESC LIMIT 1) AS captain_name
      FROM (SELECT x.*, ROW_NUMBER() OVER (PARTITION BY x.faction_id ORDER BY x.v DESC, x.ship_id) AS rn
              FROM (${inner}) x WHERE x.v > 0) t
     WHERE t.rn = 1
     ORDER BY t.v DESC, t.ship_id`;
  const realKills =`(SELECT COUNT(*) FROM battle_participants k JOIN battles bk ON bk.id = k.battle_id
                       WHERE bk.game_id = s.game_id AND k.killer_ship_id = s.ship_id
                         AND k.died_tick IS NOT NULL)`;

  const results = await env.DB.batch([
    /* 0  */ q(`SELECT id, name, color, color2, emblem, status, eliminated_at_tick, slot,
                      user_id, metal, gold, science
                 FROM game_factions
                WHERE game_id = ? AND status NOT IN ('monster', 'observer')
                ORDER BY slot`, g),
    /* 1  */ q(`SELECT owner_faction_id AS fid, body_id, created_at_tick AS t0, destroyed_at_tick AS t1
                 FROM game_settlements WHERE game_id = ?`, g),
    /* 2  */ q(`SELECT owner_faction_id AS fid, COUNT(*) AS n
                 FROM game_ships WHERE game_id = ? AND hp > 0 GROUP BY owner_faction_id`, g),
    /* 3  */ q(`SELECT faction_id AS fid, SUM(level) AS lv, MAX(completed_at_tick) AS done
                 FROM faction_techs WHERE game_id = ? GROUP BY faction_id`, g),
    /* 4  */ q(`SELECT faction_id AS fid, MAX(ships) AS ships, MAX(gold) AS gold
                 FROM faction_metrics WHERE game_id = ? GROUP BY faction_id`, g),
    /* 5  */ q(`SELECT tick_number AS t, faction_id AS fid, gold, science, ships
                 FROM faction_metrics
                WHERE game_id = ?
                  AND (tick_number % ? = 0
                       OR tick_number = (SELECT MIN(tick_number) FROM faction_metrics WHERE game_id = ?)
                       OR tick_number = (SELECT MAX(tick_number) FROM faction_metrics WHERE game_id = ?))
                ORDER BY tick_number`, g, stride, g, g),
    /* 6  */ q(`SELECT actor_faction_id AS fid, COUNT(*) AS n FROM chronicle_entries
                WHERE game_id = ? AND kind = 'ship_built' AND actor_faction_id IS NOT NULL
                GROUP BY actor_faction_id`, g),
    /* 7  */ q(`SELECT proposer_faction_id AS fid, COUNT(*) AS n FROM senate_proposals
                WHERE game_id = ? AND status = 'passed' AND proposer_faction_id IS NOT NULL
                GROUP BY proposer_faction_id`, g),
    /* 8  */ q(`SELECT declared_by AS fid, origin, COUNT(*) AS n FROM game_wars
                WHERE game_id = ? GROUP BY declared_by, origin`, g),
    /* 9  */ q(`SELECT fid, COUNT(*) AS n FROM (
                  SELECT proposer_faction_id AS fid FROM trade_offers
                   WHERE game_id = ? AND status = 'accepted'
                     AND (offer_metal + offer_fuel + offer_gold + offer_science
                          + request_metal + request_fuel + request_gold + request_science > 0
                          OR offered_ship_id IS NOT NULL)
                  UNION ALL
                  SELECT responder_faction_id FROM trade_offers
                   WHERE game_id = ? AND status = 'accepted'
                     AND (offer_metal + offer_fuel + offer_gold + offer_science
                          + request_metal + request_fuel + request_gold + request_science > 0
                          OR offered_ship_id IS NOT NULL)
                  UNION ALL
                  SELECT poster_faction_id FROM market_fills f
                   WHERE game_id = ? AND NOT EXISTS (SELECT 1 FROM trade_offers o
                          WHERE o.id = f.trade_offer_id AND o.status = 'accepted')
                  UNION ALL
                  SELECT taker_faction_id FROM market_fills f
                   WHERE game_id = ? AND NOT EXISTS (SELECT 1 FROM trade_offers o
                          WHERE o.id = f.trade_offer_id AND o.status = 'accepted')
                ) GROUP BY fid`, g, g, g, g),
    /* 10 */ q(`SELECT p.killer_faction_id AS fid, COUNT(*) AS n FROM battle_participants ${battleParticipantsOfGame}
                  AND p.died_tick IS NOT NULL AND p.killer_faction_id IS NOT NULL
                  AND (p.faction_id IS NULL OR p.faction_id <> p.killer_faction_id)
                GROUP BY p.killer_faction_id`, g),
    /* 11 */ q(`SELECT p.faction_id AS fid, COUNT(*) AS n FROM battle_participants ${battleParticipantsOfGame}
                  AND p.died_tick IS NOT NULL AND p.faction_id IS NOT NULL
                GROUP BY p.faction_id`, g),
    /* 12 */ q(`SELECT faction_id AS fid, SUM(damage_dealt) AS n FROM game_ship_stats
                WHERE game_id = ? AND faction_id IS NOT NULL GROUP BY faction_id`, g),
    /* 13 */ q(`SELECT COUNT(*) AS battles, COALESCE(SUM(shots), 0) AS shots,
                      COALESCE(SUM(ships_lost), 0) AS ships_lost,
                      COALESCE(SUM(settlements_lost), 0) AS settlements_lost,
                      (SELECT COUNT(*) FROM game_settlements
                        WHERE game_id = ? AND destroyed_at_tick IS NOT NULL) AS setl_destroyed
                 FROM battles WHERE game_id = ?`, g, g),
    /* 14 */ q(`SELECT id, body_name, started_tick, ended_tick, last_fire_tick, shots, ships_lost, settlements_lost,
                      (SELECT COUNT(*) FROM game_settlements st
                        WHERE st.game_id = battles.game_id AND st.body_id = battles.body_id
                          AND st.destroyed_at_tick BETWEEN battles.started_tick
                              AND COALESCE(battles.ended_tick, battles.last_fire_tick)) AS setl_here
                 FROM battles WHERE id IN (${TOP_BATTLES})
                ORDER BY ships_lost DESC, shots DESC, started_tick ASC`, g),
    /* 15 */ q(`SELECT p.battle_id, p.faction_id AS fid, COUNT(*) AS n FROM battle_participants p
                WHERE p.died_tick IS NOT NULL AND p.faction_id IS NOT NULL
                  AND p.battle_id IN (${TOP_BATTLES})
                GROUP BY p.battle_id, p.faction_id`, g),
    /* 16 ace */ q(champions(`
                SELECT s.ship_id, s.ship_name, s.ship_class, s.faction_id, h.v
                  FROM (SELECT k.killer_ship_id AS ship_id, COUNT(*) AS v
                          FROM battle_participants k JOIN battles bk ON bk.id = k.battle_id
                         WHERE bk.game_id = ? AND k.died_tick IS NOT NULL AND k.killer_ship_id IS NOT NULL
                           AND (k.faction_id IS NULL OR k.killer_faction_id IS NULL OR k.faction_id <> k.killer_faction_id)
                         GROUP BY k.killer_ship_id) h
                  JOIN game_ship_stats s ON s.game_id = ? AND s.ship_id = h.ship_id`), g, g),
    /* 17 heavy_hitter */ q(champions(`
                SELECT s.ship_id, s.ship_name, s.ship_class, s.faction_id, s.damage_dealt AS v
                  FROM game_ship_stats s WHERE s.game_id = ? AND s.damage_dealt > 0`), g),
    /* 18 iron_wall */ q(champions(`
                SELECT s.ship_id, s.ship_name, s.ship_class, s.faction_id, s.damage_absorbed AS v
                  FROM game_ship_stats s WHERE s.game_id = ? AND s.damage_absorbed > 0`), g),
    /* 19 last_stand */ q(champions(`
                SELECT s.ship_id, s.ship_name, s.ship_class, s.faction_id, MIN(s.low_hp_kills, ${realKills}) AS v
                  FROM game_ship_stats s WHERE s.game_id = ? AND s.low_hp_kills > 0`), g),
    /* 20 */ q(`SELECT payload FROM chronicle_entries WHERE game_id = ? AND kind = 'victory'
                ORDER BY tick_number DESC LIMIT 1`, g),
    /* 21 */ q(`SELECT actor_faction_id AS fid, MAX(tick_number) AS t FROM chronicle_entries
                WHERE game_id = ? AND kind = 'faction_eliminated' AND actor_faction_id IS NOT NULL
                GROUP BY actor_faction_id`, g),
  ]);
  const R = (i) => rows(results[i]);

  // ---- the empires ---------------------------------------------------------
  const fRows = R(0);
  const known = new Set(fRows.map(f => f.id));
  const viewerFactionId = opts.asFactionId !== undefined
    ? opts.asFactionId
    : (viewerUserId ? (fRows.find(f => f.user_id === viewerUserId)?.id ?? member?.fid ?? null) : null);

  // holdings: settlement lifetimes -> per-empire sweeps
  const eventsBy = new Map();
  for (const s of R(1)) {
    if (!known.has(s.fid)) continue;
    const ev = eventsBy.get(s.fid) ?? [];
    ev.push({ tick: num(s.t0), body: s.body_id, d: 1 });
    if (s.t1 != null) ev.push({ tick: num(s.t1), body: s.body_id, d: -1 });
    eventsBy.set(s.fid, ev);
  }
  const holdStates = new Map(fRows.map(f => [f.id, holdingsStates(eventsBy.get(f.id) ?? [])]));
  const finalHoldings = (fid) => { const s = holdStates.get(fid); return s.length ? s[s.length - 1].n : 0; };
  const peakHoldings = (fid) => holdStates.get(fid).reduce((m, s) => Math.max(m, s.n), 0);

  const shipsAlive = sumBy(R(2), 'fid', 'n');
  const techLv = sumBy(R(3), 'fid', 'lv');
  const techDone = new Map(R(3).map(r => [r.fid, r.done == null ? Infinity : num(r.done)]));
  const peakShips = sumBy(R(4), 'fid', 'ships');
  const peakGold = sumBy(R(4), 'fid', 'gold');
  const built = sumBy(R(6), 'fid', 'n');
  const bills = sumBy(R(7), 'fid', 'n');
  const declared = new Map();
  let warsTotal = 0;
  for (const w of R(8)) {
    if (w.origin === 'declared') declared.set(w.fid, (declared.get(w.fid) ?? 0) + num(w.n));
    if (w.origin !== 'seeded') warsTotal += num(w.n);
  }
  const tradeParties = sumBy(R(9), 'fid', 'n');
  const tradesTotal = Math.round([...tradeParties.values()].reduce((a, b) => a + b, 0) / 2);
  const kills = sumBy(R(10), 'fid', 'n');
  const lost = sumBy(R(11), 'fid', 'n');
  const dealt = sumBy(R(12), 'fid', 'n');
  const elimTick = new Map(R(21).map(r => [r.fid, num(r.t)]));

  const factions = fRows.map(f => {
    const finalStatus = f.status === 'active' ? 'active' : 'eliminated';
    const final = {
      holdings: finalHoldings(f.id),
      ships: whole(shipsAlive.get(f.id) ?? 0),
      techs: whole(techLv.get(f.id) ?? 0),
      credits: whole(f.gold),
      science: whole(f.science),
      metal: whole(f.metal),
    };
    const out = {
      id: f.id,
      name: f.name,
      color: f.color,
      color2: f.color2 ?? null,
      emblem: f.emblem ?? null,
      finalStatus,
      eliminatedAtTick: finalStatus === 'eliminated'
        ? (f.eliminated_at_tick != null ? num(f.eliminated_at_tick) : (elimTick.get(f.id) ?? null))
        : null,
      place: 0,
      isWinner: game.winner_faction_id === f.id,
      isMe: viewerFactionId != null && viewerFactionId === f.id,
      final,
      peak: {
        holdings: Math.max(peakHoldings(f.id), final.holdings),
        ships: Math.max(whole(peakShips.get(f.id) ?? 0), final.ships),
        credits: Math.max(whole(peakGold.get(f.id) ?? 0), final.credits),
      },
      totals: {
        kills: whole(kills.get(f.id) ?? 0),
        shipsLost: whole(lost.get(f.id) ?? 0),
        damageDealt: whole(dealt.get(f.id) ?? 0),
        shipsBuilt: whole(built.get(f.id) ?? 0),
        trades: whole(tradeParties.get(f.id) ?? 0),
        billsPassed: whole(bills.get(f.id) ?? 0),
        warsDeclared: whole(declared.get(f.id) ?? 0),
      },
    };
    out._slot = num(f.slot);
    return out;
  });

  factions.sort((a, b) =>
    (Number(b.isWinner) - Number(a.isWinner))
    || (b.final.holdings - a.final.holdings)
    || (b.final.ships - a.final.ships)
    || (b.final.techs - a.final.techs)
    || (b.final.credits - a.final.credits)
    || ((b.eliminatedAtTick ?? Infinity) - (a.eliminatedAtTick ?? Infinity))
    || (a._slot - b._slot));
  factions.forEach((f, i) => { f.place = i + 1; delete f._slot; });
  const placeOf = new Map(factions.map(f => [f.id, f.place]));

  // ---- awards ---------------------------------------------------------------
  const awards = [];
  const tieBreak = {
    scholar: (a, b) => (techDone.get(a.id) ?? Infinity) - (techDone.get(b.id) ?? Infinity),
  };
  /** Empire award: highest value; ties by `tieBreak` then by place. */
  const factionAward = (id, valueOf) => {
    const ranked = factions
      .map(f => ({ f, v: valueOf(f) }))
      .filter(x => x.v > 0)
      .sort((a, b) => (b.v - a.v) || (tieBreak[id]?.(a.f, b.f) ?? 0) || (a.f.place - b.f.place));
    if (!ranked.length) return;
    const award = { id, factionId: ranked[0].f.id, value: ranked[0].v };
    if (ranked[1]) award.runnerUp = { factionId: ranked[1].f.id, value: ranked[1].v };
    awards.push(award);
  };
  /** Hull award: the best hull of a real empire; runner-up is the best hull
   *  of a DIFFERENT empire (a runner-up from the same fleet says little). */
  const hullAward = (id, list) => {
    const ranked = list
      .map(h => ({ h, v: whole(h.v) }))
      .filter(x => x.v > 0 && known.has(x.h.faction_id));
    if (!ranked.length) return;
    const top = ranked[0];
    const award = {
      id, factionId: top.h.faction_id, value: top.v,
      ship: { name: top.h.ship_name ?? '', shipClass: top.h.ship_class ?? null, captainName: top.h.captain_name ?? null },
    };
    const next = ranked.find(x => x.h.faction_id !== top.h.faction_id);
    if (next) award.runnerUp = { factionId: next.h.faction_id, value: next.v };
    awards.push(award);
  };
  factionAward('warmonger', f => f.totals.kills);
  hullAward('ace', R(16));
  hullAward('heavy_hitter', R(17));
  hullAward('iron_wall', R(18));
  hullAward('last_stand', R(19));
  factionAward('instigator', f => f.totals.warsDeclared);
  factionAward('landlord', f => f.peak.holdings);
  factionAward('treasurer', f => f.peak.credits);
  factionAward('scholar', f => f.final.techs);
  factionAward('shipwright', f => f.totals.shipsBuilt);
  factionAward('merchant', f => f.totals.trades);
  factionAward('statesman', f => f.totals.billsPassed);

  // ---- series ---------------------------------------------------------------
  const metricRows = R(5);
  let ticks = [...new Set(metricRows.map(r => num(r.t)))].sort((a, b) => a - b);
  ticks = thin(ticks, MAX_POINTS);
  const at = new Map();
  for (const r of metricRows) at.set(`${num(r.t)}|${r.fid}`, r);
  const series = { ticks, holdings: {}, ships: {}, credits: {}, science: {} };
  for (const f of factions) {
    const states = holdStates.get(f.id);
    series.holdings[f.id] = ticks.map(t => holdingsAt(states, t));
    series.ships[f.id] = ticks.map(t => whole(at.get(`${t}|${f.id}`)?.ships));
    series.credits[f.id] = ticks.map(t => whole(at.get(`${t}|${f.id}`)?.gold));
    series.science[f.id] = ticks.map(t => whole(at.get(`${t}|${f.id}`)?.science));
  }

  // ---- battles ----------------------------------------------------------------
  const lossesBy = new Map();
  for (const r of R(15)) {
    if (!known.has(r.fid)) continue;
    const l = lossesBy.get(r.battle_id) ?? [];
    l.push({ factionId: r.fid, shipsLost: whole(r.n) });
    lossesBy.set(r.battle_id, l);
  }
  const battles = R(14).map(b => ({
    id: b.id,
    bodyName: b.body_name ?? null,
    startedTick: whole(b.started_tick),
    endedTick: b.ended_tick != null ? whole(b.ended_tick) : (b.last_fire_tick != null ? whole(b.last_fire_tick) : null),
    shots: whole(b.shots),
    shipsLost: whole(b.ships_lost),
    settlementsLost: Math.max(whole(b.settlements_lost), whole(b.setl_here)),
    lossesByFaction: (lossesBy.get(b.id) ?? [])
      .sort((a, c) => (c.shipsLost - a.shipsLost) || ((placeOf.get(a.factionId) ?? 0) - (placeOf.get(c.factionId) ?? 0))),
  }));

  // ---- the game ---------------------------------------------------------------
  let victoryDetail = null;
  try {
    const d = JSON.parse(R(20)[0]?.payload ?? 'null')?.detail;
    if (typeof d === 'string' && d.trim()) victoryDetail = d.trim();
  } catch { /* an unparsable payload just means no detail line */ }
  const startedAtMs = game.started_at != null ? num(game.started_at) : null;
  const completedAtMs = game.completed_at != null ? num(game.completed_at) : null;
  const bt = R(13)[0] ?? {};

  return {
    game: {
      id: game.id,
      name: game.name,
      victoryType: game.victory_type ?? null,
      winnerFactionId: game.winner_faction_id ?? null,
      victoryDetail,
      currentTick,
      tickIntervalMs: whole(game.tick_interval_ms),
      startedAtMs,
      completedAtMs,
      durationMs: startedAtMs != null && completedAtMs != null ? Math.max(0, completedAtMs - startedAtMs) : null,
      players: fRows.filter(f => f.user_id != null).length,
      empires: fRows.length,
    },
    factions,
    awards,
    series,
    totals: {
      battles: whole(bt.battles),
      shots: whole(bt.shots),
      shipsLost: whole(bt.ships_lost),
      settlementsLost: Math.max(whole(bt.settlements_lost), whole(bt.setl_destroyed)),
      trades: tradesTotal,
      billsPassed: whole([...bills.values()].reduce((a, b) => a + b, 0)),
      techsResearched: whole([...techLv.values()].reduce((a, b) => a + b, 0)),
      shipsBuilt: whole([...built.values()].reduce((a, b) => a + b, 0)),
      wars: warsTotal,
    },
    battles,
  };
}

async function handleEnding(_req, env, { params, session }) {
  const result = await buildEnding(env, params.gameId, session.user_id);
  if (result.error) return err(result.error.status, result.error.code, result.error.message);
  return json(result, { headers: { 'cache-control': 'private, max-age=60' } });
}

export const routes = [
  {
    method: 'GET',
    pattern: new RegExp(`^/api/games/(?<gameId>${GAME_ID})/ending$`),
    auth: 'required',
    handle: handleEnding,
  },
];
