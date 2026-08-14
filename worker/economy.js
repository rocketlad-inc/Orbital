// ============================================================
// Economy — where an empire's money came from and where it went.
//
// Reads the per-tick ledger (migration 0087) and turns it into the two
// things a player actually asks: "what am I earning and spending right
// now", and "is that getting better or worse".
//
// INCOME IS DERIVED, NOT STORED. Money arrives across half a dozen tick
// passes — settlement yield, trade deliveries, salvage, refunds — and a
// counter maintained by hand in each of them would drift from the rules
// the first time somebody added a seventh. The ledger records only
// observable state (end-of-tick pool levels + what upkeep charged), and
// income falls out of the arithmetic:
//
//     income = (pool_now - pool_prev) + upkeep_charged + spending
//
// Spending is bucketed from spend_events, which are player actions
// stamped in wall-clock ms rather than ticks — so each tick claims the
// spends that happened between its own row and the previous one.
// ============================================================

const GAME_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function err(status, code, message) {
  return json({ error: { code, message } }, { status });
}

/** How many ticks of history the tab charts. Enough to show a trend
 *  without turning one panel open into a thousand-row scan. */
const WINDOW_TICKS = 120;

async function handleGetEconomy(req, env, ctx) {
  const gameId = ctx.params.gameId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await env.DB
    .prepare(
      `SELECT id, name, metal, gold, science, arrears_metal, arrears_gold
         FROM game_factions WHERE game_id = ? AND user_id = ?`,
    )
    .bind(gameId, ctx.session.user_id)
    .first();
  if (!me) return err(403, 'not_a_faction', 'you do not have a faction in this game');

  const game = await env.DB
    .prepare('SELECT current_tick, tick_interval_ms FROM games WHERE id = ?')
    .bind(gameId).first();
  const currentTick = Number(game?.current_tick ?? 0);

  // Oldest-first: the derivation needs each row's predecessor.
  const rows = (await env.DB
    .prepare(
      `SELECT tick_number, pool_metal, pool_gold, pool_science,
              upkeep_metal, upkeep_gold, arrears_metal, arrears_gold, created_at_ms
         FROM faction_economy_ticks
        WHERE game_id = ? AND faction_id = ? AND tick_number >= ?
        ORDER BY tick_number ASC`,
    )
    .bind(gameId, me.id, Math.max(0, currentTick - WINDOW_TICKS))
    .all()).results ?? [];

  // Every spend this faction made inside the charted window, so each tick
  // can claim the ones that landed in its own slice of wall-clock time.
  const firstMs = rows.length > 0 ? Number(rows[0].created_at_ms ?? 0) : 0;
  const spends = rows.length === 0 ? [] : ((await env.DB
    .prepare(
      `SELECT category, metal, gold, created_at_ms
         FROM spend_events
        WHERE game_id = ? AND faction_id = ? AND created_at_ms >= ?
        ORDER BY created_at_ms ASC`,
    )
    .bind(gameId, me.id, firstMs)
    .all()).results ?? []);

  const series = [];
  const byCategory = new Map();     // lifetime-in-window spend per category
  let si = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = i > 0 ? rows[i - 1] : null;
    const windowStart = prev ? Number(prev.created_at_ms ?? 0) : Number(r.created_at_ms ?? 0);
    const windowEnd = Number(r.created_at_ms ?? 0);

    let spentMetal = 0, spentGold = 0;
    while (si < spends.length && Number(spends[si].created_at_ms) <= windowEnd) {
      const s = spends[si];
      if (Number(s.created_at_ms) > windowStart || i === 0) {
        spentMetal += Number(s.metal ?? 0);
        spentGold += Number(s.gold ?? 0);
        const c = byCategory.get(s.category) ?? { metal: 0, gold: 0, count: 0 };
        c.metal += Number(s.metal ?? 0);
        c.gold += Number(s.gold ?? 0);
        c.count += 1;
        byCategory.set(s.category, c);
      }
      si++;
    }

    const upkeepMetal = Number(r.upkeep_metal ?? 0);
    const upkeepGold = Number(r.upkeep_gold ?? 0);
    // First row has no predecessor, so its delta is unknowable — report
    // the levels and leave income null rather than inventing a number
    // from a zero baseline, which would draw a false spike on the chart.
    const dMetal = prev ? Number(r.pool_metal ?? 0) - Number(prev.pool_metal ?? 0) : null;
    const dGold = prev ? Number(r.pool_gold ?? 0) - Number(prev.pool_gold ?? 0) : null;
    const dSci = prev ? Number(r.pool_science ?? 0) - Number(prev.pool_science ?? 0) : null;

    series.push({
      tick: Number(r.tick_number),
      pool_metal: Number(r.pool_metal ?? 0),
      pool_gold: Number(r.pool_gold ?? 0),
      pool_science: Number(r.pool_science ?? 0),
      upkeep_metal: upkeepMetal,
      upkeep_gold: upkeepGold,
      arrears_metal: Number(r.arrears_metal ?? 0),
      arrears_gold: Number(r.arrears_gold ?? 0),
      spend_metal: spentMetal,
      spend_gold: spentGold,
      net_metal: dMetal,
      net_gold: dGold,
      net_science: dSci,
      income_metal: dMetal == null ? null : dMetal + upkeepMetal + spentMetal,
      income_gold: dGold == null ? null : dGold + upkeepGold + spentGold,
      income_science: dSci,     // science has no upkeep and is not spendable via spend_events
    });
  }

  // Averages over the last 10 scored ticks — a single tick is noisy
  // (a build lands, a trade delivers) and a player reading "am I
  // profitable" wants the trend, not the last coin flip.
  const scored = series.filter(s => s.income_gold != null);
  const recent = scored.slice(-10);
  const avg = (key) => recent.length === 0
    ? 0
    : recent.reduce((a, s) => a + Number(s[key] ?? 0), 0) / recent.length;

  return json({
    faction: { id: me.id, name: me.name },
    current_tick: currentTick,
    tick_interval_ms: game?.tick_interval_ms ?? null,
    pools: {
      metal: Number(me.metal ?? 0),
      gold: Number(me.gold ?? 0),
      science: Number(me.science ?? 0),
    },
    arrears: {
      metal: Number(me.arrears_metal ?? 0),
      gold: Number(me.arrears_gold ?? 0),
    },
    averages: {
      income_metal: avg('income_metal'), income_gold: avg('income_gold'),
      income_science: avg('income_science'),
      upkeep_metal: avg('upkeep_metal'), upkeep_gold: avg('upkeep_gold'),
      spend_metal: avg('spend_metal'), spend_gold: avg('spend_gold'),
      net_metal: avg('net_metal'), net_gold: avg('net_gold'),
      sample_ticks: recent.length,
    },
    spend_by_category: [...byCategory.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => (b.metal + b.gold) - (a.metal + a.gold)),
    series,
  });
}

export const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/economy$/,
    auth: 'required',
    handle: handleGetEconomy,
  },
];
