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
//   arrivals   game_ship_nodes executed this tick with a destination,
//              NAMED ("Knife reached Styx Rock") and NOT counting the
//              freighters on standing trade routes -- a supply run lands
//              most ticks, and "1 arrival" every tick read as a counter
//              stuck on 1. Their cargo shows up as income instead.
//   kills      battle_participants whose died_tick is this tick
//   worlds     game_bodies claimed_at_tick, gained or lost
//   hulls      game_ships built_at_tick
//   income     what was banked into the pool, by source (Lorne): freighter
//              deliveries, terraformed worlds, the raw worlds' 10% trickle
//              (faction_economy_ticks.income_json, booked by the tick)
//
// SENT EVERY TICK THAT PAID ANYTHING, which for a living empire is every
// tick: the income line is the report's steady beat. Sent from the END of
// resolveTick (alerts.runTurnDigest), once all of it has happened.
//
// ONE PER TURN, KEYED ON THE TURN. dedupeKey is `turn:<gameId>:<tick>`:
// a retry, a double tick or a worker restart cannot produce two.
// ============================================================

import { tr, trn } from './i18n.js';

/** A digest is worth sending only if one of these is non-zero. */
function anything(d) {
  return d.arrived > 0 || d.killed > 0 || d.lost > 0 || d.gained > 0 || d.built > 0 || banked(d.income) > 0;
}

// [income key, English label]. The label a player SEES comes from the
// catalog (alert.turn.src.<key>); the English here is the fallback.
const SOURCES = [
  ['delivered', 'Freighters'],
  ['terraformed', 'Terraformed'],
  ['raw', 'Raw worlds'],
];

/** The per-source totals, leaving out the shipment list beside them. */
const sourcesOf = (income) => SOURCES.map(([k]) => income?.[k]).filter(Boolean);

/** Everything banked this tick, all sources and resources together. */
function banked(income) {
  if (!income) return 0;
  let n = 0;
  for (const v of sourcesOf(income)) n += (v.metal ?? 0) + (v.gold ?? 0) + (v.science ?? 0);
  return n;
}

const fmt = (n) => {
  const r = Math.round(n);
  return r >= 10000 ? `${Math.round(r / 1000)}K` : r >= 1000 ? `${(r / 1000).toFixed(1)}K` : String(r);
};

/** "320M 40C 12S": one bundle of resources, whole units, zeroes left out. */
function bundle(v) {
  const bits = [];
  if (Math.round(v.metal ?? 0) > 0) bits.push(`${fmt(v.metal)}M`);
  if (Math.round(v.gold ?? 0) > 0) bits.push(`${fmt(v.gold)}C`);
  if (Math.round(v.science ?? 0) > 0) bits.push(`${fmt(v.science)}S`);
  return bits.join(' ');
}

/**
 * "+640 metal · +120 credits · +30 science to the pool" and, under it,
 * where it came from: "Freighters 500M 80C · Terraformed 120M 30C 20S ·
 * Raw worlds 20M 10C 10S". Null when nothing was banked.
 */
export function incomeLines(income, L = 'en') {
  if (!income || banked(income) <= 0) return null;
  const sum = { metal: 0, gold: 0, science: 0 };
  for (const v of sourcesOf(income)) {
    sum.metal += v.metal ?? 0;
    sum.gold += v.gold ?? 0;
    sum.science += v.science ?? 0;
  }
  const head = [
    Math.round(sum.metal) > 0 ? tr(L, 'alert.turn.metal', { n: fmt(sum.metal) }) : null,
    Math.round(sum.gold) > 0 ? tr(L, 'alert.turn.credits', { n: fmt(sum.gold) }) : null,
    Math.round(sum.science) > 0 ? tr(L, 'alert.turn.science', { n: fmt(sum.science) }) : null,
  ].filter(Boolean).join(' · ');
  if (!head) return null;
  const from = SOURCES
    .map(([k]) => (income[k] && bundle(income[k]) ? `${tr(L, `alert.turn.src.${k}`)} ${bundle(income[k])}` : null))
    .filter(Boolean)
    .join(' · ');
  return { head: tr(L, 'alert.turn.toPool', { head }), from };
}

/**
 * "+28M +19C +54S": what the tick banked, as the title's second half.
 * Null when it banked nothing worth a whole unit.
 */
export function bankedShort(income) {
  if (!income || banked(income) <= 0) return null;
  const sum = { metal: 0, gold: 0, science: 0 };
  for (const v of sourcesOf(income)) {
    sum.metal += v.metal ?? 0;
    sum.gold += v.gold ?? 0;
    sum.science += v.science ?? 0;
  }
  const bits = [
    Math.round(sum.metal) > 0 ? `+${fmt(sum.metal)}M` : null,
    Math.round(sum.gold) > 0 ? `+${fmt(sum.gold)}C` : null,
    Math.round(sum.science) > 0 ? `+${fmt(sum.science)}S` : null,
  ].filter(Boolean);
  return bits.length ? bits.join(' ') : null;
}

/** How many routes are named before the rest are counted. */
const ROUTES_NAMED = 2;

/**
 * "Delivered: Deimos–Mars, Ceres–Mars +1". One line, by ROUTE -- the
 * route says where the freight came from and went, which is what a
 * glance wants; the hull and the tonnage are one tap away in the game.
 * A partner's route names the partner: "Belt Run (Solar Directorate)".
 */
export function deliveredLine(shipments, L = 'en') {
  if (!shipments || shipments.length === 0) return null;
  const names = [];
  for (const s of shipments) {
    const label = (s.route ?? s.ship) + (s.partner ? ` (${s.partner})` : '');
    if (!names.includes(label)) names.push(label);
  }
  const more = names.length - ROUTES_NAMED;
  return tr(L, 'alert.turn.delivered', { names: `${names.slice(0, ROUTES_NAMED).join(', ')}${more > 0 ? ` +${more}` : ''}` });
}

/**
 * THE REPORT, BUILT TO BE READ AT A GLANCE (Lorne: the three-line income
 * breakdown made it hard to read). The title carries the total banked;
 * the body is at most two short lines -- what happened, and which routes
 * delivered. The per-source breakdown lives in the game and on the
 * watch's tick screen, not in the notification.
 */
function line(d, L = 'en') {
  const parts = [];
  if (d.lost > 0) parts.push(tr(L, 'alert.turn.lost', { n: d.lost }));
  if (d.killed > 0) parts.push(tr(L, 'alert.turn.killed', { n: d.killed }));
  if (d.gained > 0) parts.push(trn(L, 'alert.turn.claimed', d.gained));
  if (d.arrived > 0) {
    const named = d.arrivals ?? [];
    if (named.length > 0 && named.length <= 2) {
      parts.push(named.map(a => tr(L, 'alert.turn.reached', { ship: a.ship, body: a.body })).join(' · '));
    } else {
      parts.push(tr(L, 'alert.turn.arrived', { n: d.arrived }));
    }
  }
  if (d.built > 0) parts.push(tr(L, 'alert.turn.built', { n: d.built }));
  const body = [parts.join(' · '), deliveredLine(d.shipments, L)].filter(Boolean).join('\n');
  return body || tr(L, 'alert.turn.quiet');
}

/** How many shipments are named one to a line before the rest are counted. */
const SHIPMENTS_NAMED = 3;

/**
 * EVERY SHIPMENT, SAID OUT LOUD (Lorne): "Wain delivered 320M 40C to Mars
 * (Phobos Run)". A delivery on a partner's route names the partner:
 * "(Solar Directorate · Belt Run)".
 */
export function shipmentLines(shipments, L = 'en') {
  if (!shipments || shipments.length === 0) return [];
  const lines = shipments.slice(0, SHIPMENTS_NAMED).map(s => {
    const what = bundle(s);
    const via = [s.partner, s.route].filter(Boolean).join(' · ');
    return tr(L, 'alert.turn.shipment', {
      ship: s.ship, what: what || tr(L, 'alert.turn.emptyHold'), at: s.at, via: via ? ` (${via})` : '',
    });
  });
  const more = shipments.length - SHIPMENTS_NAMED;
  if (more > 0) lines.push(trn(L, 'alert.turn.moreShipments', more));
  return lines;
}

/**
 * The shipments booked this tick (income_json.deliveries: ids only), with
 * their names: the hull, the world it unloaded at, the route -- its own
 * name, or "Origin–Dest" where the player never named it -- and, on a
 * partner's route, the partner. One query per kind, whatever the count.
 */
async function nameShipments(rows, incomes) {
  const all = [];
  for (const inc of incomes) for (const d of inc?.deliveries ?? []) all.push(d);
  if (all.length === 0) return new Map();
  const ids = (key) => JSON.stringify([...new Set(all.map(d => d[key]).filter(Boolean))]);
  const routes = await rows(
    `SELECT id, name, origin_body_id AS o, dest_body_id AS d FROM game_trade_routes
      WHERE id IN (SELECT value FROM json_each(?1))`, ids('route'),
  );
  const bodyIds = new Set(all.map(d => d.at).filter(Boolean));
  for (const r of routes) { if (r.o) bodyIds.add(r.o); if (r.d) bodyIds.add(r.d); }
  const [ships, bodies, factions] = await Promise.all([
    rows('SELECT id, name FROM game_ships WHERE id IN (SELECT value FROM json_each(?1))', ids('ship')),
    rows('SELECT id, name FROM game_bodies WHERE id IN (SELECT value FROM json_each(?1))', JSON.stringify([...bodyIds])),
    rows('SELECT id, name FROM game_factions WHERE id IN (SELECT value FROM json_each(?1))', ids('from')),
  ]);
  const nameOf = (list) => new Map(list.map(r => [r.id, r.name]));
  const shipName = nameOf(ships);
  const bodyName = nameOf(bodies);
  const factionName = nameOf(factions);
  const routeName = new Map(routes.map(r => [
    r.id,
    r.name || [bodyName.get(r.o), bodyName.get(r.d)].filter(Boolean).join('–') || null,
  ]));
  const named = new Map();
  for (const d of all) {
    named.set(d, {
      ship: shipName.get(d.ship) ?? 'A freighter',
      at: bodyName.get(d.at) ?? 'port',
      route: routeName.get(d.route) ?? null,
      partner: d.from ? (factionName.get(d.from) ?? null) : null,
      metal: d.metal, gold: d.gold, science: d.science,
    });
  }
  return named;
}

/** Freighters on a standing trade route: their landings are the route's
 *  business, and their cargo is counted as income instead. */
const NOT_ON_A_ROUTE = `NOT EXISTS (
  SELECT 1 FROM game_trade_route_ships rs JOIN game_trade_routes tr ON tr.id = rs.route_id
   WHERE rs.ship_id = s.id AND tr.cancelled_at_tick IS NULL)`;

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

  // Arrivals: a node that executed this tick and had somewhere to be,
  // one row per hull so they can be named. A fleet lands as one: its
  // hulls are folded under the first name.
  const arrivalRows = await rows(
    `SELECT s.owner_faction_id AS f, COALESCE(s.fleet_id, s.id) AS g, s.name AS ship, b.name AS body
       FROM game_ship_nodes n JOIN game_ships s ON s.id = n.ship_id
       LEFT JOIN game_bodies b ON b.id = n.target_body_id
      WHERE n.game_id = ?1 AND n.status = 'executed' AND n.executed_at_tick = ?2
        AND n.target_body_id IS NOT NULL AND ${NOT_ON_A_ROUTE}`,
    gameId, tick,
  );
  const arrivalsBy = new Map();
  for (const r of arrivalRows) {
    if (!arrivalsBy.has(r.f)) arrivalsBy.set(r.f, new Map());
    const groups = arrivalsBy.get(r.f);
    if (!groups.has(r.g)) groups.set(r.g, { ship: r.ship ?? 'A fleet', body: r.body ?? 'its destination', n: 0 });
    groups.get(r.g).n += 1;
  }
  // What each empire banked this tick, by source.
  const incomeRows = await rows(
    `SELECT faction_id AS f, income_json AS j FROM faction_economy_ticks
      WHERE game_id = ?1 AND tick_number = ?2 AND income_json IS NOT NULL`,
    gameId, tick,
  );
  const incomeBy = new Map();
  for (const r of incomeRows) {
    try { incomeBy.set(r.f, JSON.parse(r.j)); } catch { /* a bad row reports no income */ }
  }
  // Each shipment's names, resolved once for the whole game.
  const shipmentNames = await nameShipments(rows, [...incomeBy.values()]).catch(() => new Map());
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
  // Players in more than one live game, whose report must say which.
  const multiGame = new Set((await rows(
    `SELECT f.user_id AS u FROM game_factions f JOIN games g ON g.id = f.game_id
      WHERE f.user_id IN (SELECT user_id FROM game_factions WHERE game_id = ?1 AND user_id IS NOT NULL)
        AND f.status = 'active' AND g.status = 'active'
      GROUP BY f.user_id HAVING COUNT(DISTINCT f.game_id) > 1`,
    gameId,
  )).map(r => r.u));
  const by = (list) => new Map(list.map(r => [r.f, Number(r.n) || 0]));
  const claimsBy = by(claims);
  const builtBy = by(built);

  for (const me of humans) {
    let lost = 0;
    let killed = 0;
    for (const dead of deaths) {
      if (dead.f === me.id) lost += 1;
      else if (inBattle.get(dead.b)?.has(me.id)) killed += 1;
    }
    const landed = [...(arrivalsBy.get(me.id)?.values() ?? [])];
    const d = {
      arrived: landed.length,
      arrivals: landed.map(a => ({ ship: a.n > 1 ? `${a.ship} ×${a.n}` : a.ship, body: a.body })),
      income: incomeBy.get(me.id) ?? null,
      shipments: (incomeBy.get(me.id)?.deliveries ?? []).map(x => shipmentNames.get(x)).filter(Boolean),
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
      embed: (L) => ({
        // TICK, the game's own word for it (Lorne), not "turn"; the total
        // banked rides in the title so the glance gets it first. The game's
        // name only when this player is in more than one.
        title: [tr(L, 'alert.turn.tick', { n: tick }), bankedShort(d.income), multiGame.has(me.user_id) ? gameName : null].filter(Boolean).join(' · '),
        description: line(d, L),
      }),
    }).catch(() => {});
  }
}

/**
 * The same five counts for ONE faction and one tick, for the watch's
 * "the tick landed" screen (state.json lastTick). The digest above is
 * written for a whole game at once; this is the per-player read of the
 * very same bookkeeping, so the screen and the notification can never
 * disagree about what a tick did.
 */
export async function tickSummaryFor(env, gameId, factionId, tick) {
  const one = async (sql, ...bind) => Number((await env.DB.prepare(sql).bind(...bind).first().catch(() => null))?.n ?? 0);
  const [arrived, gained, built, lost, killed, incomeRow] = await Promise.all([
    one(`SELECT COUNT(DISTINCT COALESCE(s.fleet_id, s.id)) AS n FROM game_ship_nodes n JOIN game_ships s ON s.id = n.ship_id
          WHERE n.game_id = ?1 AND n.status = 'executed' AND n.executed_at_tick = ?2
            AND n.target_body_id IS NOT NULL AND s.owner_faction_id = ?3 AND ${NOT_ON_A_ROUTE}`, gameId, tick, factionId),
    one(`SELECT COUNT(*) AS n FROM game_bodies
          WHERE game_id = ?1 AND claimed_at_tick = ?2 AND owner_faction_id = ?3`, gameId, tick, factionId),
    one(`SELECT COUNT(*) AS n FROM game_ships
          WHERE game_id = ?1 AND built_at_tick = ?2 AND owner_faction_id = ?3`, gameId, tick, factionId),
    one(`SELECT COUNT(*) AS n FROM battle_participants p JOIN battles bt ON bt.id = p.battle_id
          WHERE bt.game_id = ?1 AND p.died_tick = ?2 AND p.faction_id = ?3`, gameId, tick, factionId),
    // A kill is a death on another side of a battle this faction was in.
    one(`SELECT COUNT(*) AS n FROM battle_participants p JOIN battles bt ON bt.id = p.battle_id
          WHERE bt.game_id = ?1 AND p.died_tick = ?2 AND p.faction_id IS NOT NULL AND p.faction_id != ?3
            AND EXISTS (SELECT 1 FROM battle_participants q WHERE q.battle_id = p.battle_id AND q.faction_id = ?3)`,
      gameId, tick, factionId),
    env.DB.prepare(
      `SELECT income_json AS j FROM faction_economy_ticks
        WHERE game_id = ?1 AND faction_id = ?2 AND tick_number = ?3`,
    ).bind(gameId, factionId, tick).first().catch(() => null),
  ]);
  let income = null;
  try { income = incomeRow?.j ? JSON.parse(incomeRow.j) : null; } catch { income = null; }
  return { tick, arrived, gained, built, lost, killed, income };
}
