// ============================================================================
// priceSweep.mjs — are things priced so empires can grow AND fight, without
// drowning in cash?
//
// Different question from economySweep, so a different instrument. That one
// asked "can you afford the first move at all" and measured reach. This one
// asks whether the economy has a SINK that keeps pace with income across a
// whole game. Two ways to get that wrong and they look nothing alike:
//
//   too cheap   treasuries balloon, everything affordable, no decisions.
//               The tell is high terminal wealth AND a low refusal rate —
//               money piling up because there is nothing it cannot buy.
//   too dear    nothing gets built, fleets stay tiny, no fighting.
//               The tell is a high refusal rate AND low ships/kills.
//
// The healthy middle is uncomfortable on purpose: a refusal rate that is
// clearly non-zero (you cannot have everything) while ships still get
// built and destroyed (you can afford to fight).
//
// METRICS
//   wealth    median terminal metal+credits per surviving faction. The
//             flooding number.
//   growth    terminal wealth / mid-game wealth. >1 means the treasury is
//             still accelerating at the end — nothing is absorbing income.
//             ~1 means the sink has caught up, which is what we want.
//   refused%  share of all build/building attempts refused for want of
//             resources. Zero means money is meaningless; very high means
//             the game is a spreadsheet you cannot act on.
//   ships     ships built per game. Can empires field forces at all.
//   kills     ships destroyed per game. Is there actually a war on.
//   bldgs     buildings completed per game. Is the main sink being used.
//   reach%    terraform reach, carried over so a price change cannot
//             quietly break expansion while looking good on cash.
//
// Usage: node sim/priceSweep.mjs [seedsPerArm] [ticks]
// ============================================================================

import { runGame } from './headless.mjs';

const SEEDS = Number(process.argv[2] ?? 10);
const TICKS = Number(process.argv[3] ?? 300);
const DOCTRINES = ['rusher', 'expander', 'economist', 'technocrat'];

const ARMS = [
  { id: 'baseline',        config: {} },

  // --- ships -------------------------------------------------------------
  { id: 'ships-0.6',       config: { ship_cost_mult: 0.6 } },
  { id: 'ships-1.5',       config: { ship_cost_mult: 1.5 } },
  { id: 'ships-2.0',       config: { ship_cost_mult: 2.0 } },

  // --- buildings ---------------------------------------------------------
  { id: 'bldg-0.6',        config: { building_cost_mult: 0.6 } },
  { id: 'bldg-1.5',        config: { building_cost_mult: 1.5 } },
  { id: 'bldg-2.0',        config: { building_cost_mult: 2.0 } },

  // --- the compounding curve, not the base price -------------------------
  // Buildings already escalate 1.6^level. Steepening the curve taxes the
  // deep levels a rich empire buys without touching the first level a poor
  // one needs, which is a different shape of sink from a flat multiplier.
  { id: 'bldg-scale-1.9',  config: { building_cost_scaling: 1.9 } },

  // --- combinations ------------------------------------------------------
  // Cheap hulls + dear buildings: fighting stays affordable, the compounding
  // economy sink gets deeper. The hypothesis worth testing directly.
  { id: 'war-cheap-eco-dear', config: { ship_cost_mult: 0.75, building_cost_mult: 1.5 } },
  { id: 'both-dear',       config: { ship_cost_mult: 1.5, building_cost_mult: 1.5 } },
];

const med = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (n, d) => (d ? (100 * n) / d : 0);

async function runArm(arm) {
  const wealths = [], growths = [];
  let ships = 0, kills = 0, bldgs = 0, games = 0;
  let refused = 0, attempted = 0;
  let expanders = 0, reached = 0;

  for (let i = 0; i < SEEDS; i++) {
    const r = await runGame({
      ticks: TICKS, players: 4, seed: `px-${arm.id}-${i}`, quiet: true,
      doctrines: DOCTRINES, doctrineOffset: i, config: arm.config,
    });
    const q = async (sql, ...b) => (await r.env.DB.prepare(sql).bind(...b).all()).results ?? [];
    games++;

    // Terminal wealth, living factions only — a dead empire's zero would
    // drag the median down and read as "prices are fine".
    const facs = await q(
      `SELECT id, metal, gold FROM game_factions WHERE game_id = ? AND status = 'active'`, r.gameId);
    for (const f of facs) wealths.push((f.metal ?? 0) + (f.gold ?? 0));

    // Is the treasury still climbing at the end? midWealth is captured by
    // headless at the game's midpoint.
    for (const f of (r.factions ?? [])) {
      const mid = f.midWealth;
      const end = (f.metal ?? 0) + (f.gold ?? 0);
      if (mid && mid > 50) growths.push(end / mid);
    }

    const chron = await q(
      `SELECT kind, COUNT(*) n FROM chronicle_entries WHERE game_id = ? GROUP BY kind`, r.gameId);
    for (const c of chron) {
      if (c.kind === 'ship_built') ships += c.n;
      else if (c.kind === 'ship_destroyed') kills += c.n;
      else if (c.kind === 'building_completed') bldgs += c.n;
    }

    // Refusal rate over every purchase attempt the bots made. Both halves
    // come from the same tally so the ratio is honest: the denominator is
    // attempts, not ticks.
    for (const [k, v] of Object.entries(r.tally ?? {})) {
      const isBuy = /(:build_|:bld_)/.test(k);
      if (!isBuy) continue;
      attempted += v;
      if (/insufficient/.test(k)) refused += v;
    }

    const done = await q(
      `SELECT DISTINCT actor_faction_id fid FROM chronicle_entries
        WHERE game_id = ? AND kind = 'terraform_complete'`, r.gameId);
    const got = new Set(done.map(d => d.fid));
    for (const f of (r.factions ?? [])) {
      if (String(f.doctrine ?? '').toLowerCase() !== 'expander') continue;
      expanders++;
      if (got.has(f.id)) reached++;
    }
  }

  return {
    id: arm.id,
    wealth: med(wealths),
    growth: med(growths),
    refused: pct(refused, attempted),
    ships: ships / games,
    kills: kills / games,
    bldgs: bldgs / games,
    reach: pct(reached, expanders),
  };
}

console.log(`price sweep: ${ARMS.length} arms x ${SEEDS} seeds x ${TICKS} ticks `
  + `= ${ARMS.length * SEEDS} games\n`);
const t0 = Date.now();
const out = [];
for (const arm of ARMS) {
  const res = await runArm(arm);
  out.push(res);
  console.log(`  ${res.id.padEnd(20)} wealth ${String(Math.round(res.wealth ?? 0)).padStart(6)}  `
    + `growth ${(res.growth ?? 0).toFixed(2)}x  refused ${res.refused.toFixed(0).padStart(3)}%  `
    + `ships ${res.ships.toFixed(1).padStart(5)}  kills ${res.kills.toFixed(1).padStart(5)}  `
    + `bldgs ${res.bldgs.toFixed(1).padStart(4)}  reach ${res.reach.toFixed(0).padStart(3)}%`);
}

console.log(`\n--- flooding check: wealth still climbing at the end? ---`);
for (const r of [...out].sort((a, b) => (b.wealth ?? 0) - (a.wealth ?? 0))) {
  const verdict = (r.growth ?? 0) > 1.6 ? 'STILL CLIMBING'
    : (r.growth ?? 0) > 1.15 ? 'climbing slowly' : 'sink keeping up';
  console.log(`  ${r.id.padEnd(20)} wealth ${String(Math.round(r.wealth ?? 0)).padStart(6)}  `
    + `growth ${(r.growth ?? 0).toFixed(2)}x  ${verdict}`);
}

console.log(`\n${ARMS.length * SEEDS} games in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
