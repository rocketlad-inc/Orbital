// ============================================================================
// economySweep.mjs — what should the opening economy actually be?
//
// The terraforming rework moved expansion behind a four-step pipeline
// (claim with a station -> haul a payload -> wait out the window -> land a
// city) and nobody knows what that costs in practice. This sweeps the
// three knobs that set the price of the first move and reports what each
// setting does to PACING, not to win rates.
//
// WHY NOT WIN RATES. Win rate is the wrong instrument for this question.
// The doctrines are crude, the Rusher razes half the map by tick 200, and
// a win-rate table would mostly measure "does the aggressive bot beat the
// passive one" — which it does, at every setting. The question here is
// narrower and more answerable: at this price, does an empire that WANTS
// to expand actually manage it, how long does the first world take, and
// does the leader run away with it.
//
// The metrics, and what each is for:
//
//   reach%     share of factions that finished at least one NEW terraform.
//              The viability floor. Below ~50% the opening is a wall, not
//              a decision — most players never get to play the mechanic.
//   t1         median tick of a faction's FIRST completed terraform.
//              The pacing number. This is "how long until my second real
//              world" in ticks; at 1 tick = 1 hour it is also hours.
//   tf/fac     mean NEW terraforms per faction by the end. Expansion depth.
//   broke%     share of factions that hit zero credits at some point.
//              Credits carry fleet upkeep AND half of every terraform, so
//              this is the first thing to break when the purse is thin.
//   gini-ish   best:worst final wealth ratio, median across games. The
//              runaway-leader check — the number cost growth is meant to
//              bend down.
//
// Usage: node sim/economySweep.mjs [seedsPerArm] [ticks]
// ============================================================================

import { runGame } from './headless.mjs';

const SEEDS = Number(process.argv[2] ?? 10);
const TICKS = Number(process.argv[3] ?? 250);
const DOCTRINES = (process.env.SIM_DOCTRINE_MIX || 'rusher,expander,economist,technocrat').split(',');

// The arms. Baseline first so every table reads against it.
//
// Deliberately NOT a full factorial: 3 knobs x 4 levels would be 64 arms
// and at 10 seeds each that is 640 games to answer a question that three
// well-chosen cuts answer. Each arm below changes ONE thing from baseline
// except the last two, which test the combinations the single cuts point
// at.
const ARMS = [
  { id: 'baseline',      config: {} },

  // --- the purse ---------------------------------------------------------
  { id: 'purse-150',     config: { starting_metal: 150, starting_credits: 150 } },
  { id: 'purse-200',     config: { starting_metal: 200, starting_credits: 200 } },
  { id: 'purse-300',     config: { starting_metal: 300, starting_credits: 300 } },

  // --- the payload -------------------------------------------------------
  { id: 'cost-80',       config: { terraform_cost_metal: 80,  terraform_cost_credits: 80 } },
  { id: 'cost-180',      config: { terraform_cost_metal: 180, terraform_cost_credits: 180 } },
  // Metal-heavy: metal is the more abundant currency and credits carry
  // upkeep, so shifting the payload onto metal should ease the choke
  // without making terraforming cheaper overall.
  { id: 'cost-metalheavy', config: { terraform_cost_metal: 180, terraform_cost_credits: 60 } },

  // --- the brake ---------------------------------------------------------
  { id: 'growth-1.15',   config: { terraform_cost_growth: 1.15 } },
  { id: 'growth-1.30',   config: { terraform_cost_growth: 1.30 } },

  // --- combinations the single cuts suggest -------------------------------
  { id: 'combo-open',    config: { starting_metal: 200, starting_credits: 200,
                                   terraform_cost_metal: 180, terraform_cost_credits: 60,
                                   terraform_cost_growth: 1.15 } },
];

const med = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (n, d) => (d ? (100 * n) / d : 0);

async function runArm(arm) {
  const firstTicks = [];      // per faction: tick of first NEW terraform
  const perFacTf = [];        // per faction: count of NEW terraforms
  const ratios = [];          // per game: best:worst wealth
  let facs = 0, reached = 0, broke = 0, brokeDen = 0;
  const gates = new Map();    // why expansion stalled

  for (let i = 0; i < SEEDS; i++) {
    const r = await runGame({
      ticks: TICKS, players: 4, seed: `eco-${arm.id}-${i}`, quiet: true,
      doctrines: DOCTRINES, doctrineOffset: i, config: arm.config,
    });
    const q = async (sql, ...b) => (await r.env.DB.prepare(sql).bind(...b).all()).results ?? [];

    // NEW terraforms are chronicled; seeded ones are not. That makes the
    // chronicle the honest source for "did this empire actually expand",
    // as opposed to counting terraformed bodies (which includes the
    // capital and anything captured from a rival).
    const done = await q(
      `SELECT actor_faction_id fid, MIN(tick_number) first_tick, COUNT(*) n
         FROM chronicle_entries
        WHERE game_id = ? AND kind = 'terraform_complete'
        GROUP BY actor_faction_id`, r.gameId);
    const byFac = new Map(done.map(d => [d.fid, d]));

    const allFacs = await q('SELECT id, metal, gold FROM game_factions WHERE game_id = ?', r.gameId);
    // MEASURE THE DOCTRINE THAT IS ACTUALLY TRYING. Only the Expander
    // colonises, so counting reach across all four seats caps it at 25%
    // by construction and every arm looks like a failure. The question
    // is "when an empire commits to expanding, does the opening economy
    // let it" — so the denominator is Expanders, not factions.
    // headless stores the DISPLAY name ('Expander'), not the key —
    // comparing against the key silently matched nothing and reported
    // reach 0% for every arm, which read like a catastrophic finding
    // rather than the typo it was. Normalised, and asserted below.
    const expanderIds = new Set(
      (r.factions ?? [])
        .filter(f => {
          const d = String(f.doctrine ?? '').toLowerCase();
          return d === 'expander' || d === 'logistician';
        })
        .map(f => f.id));
    if (expanderIds.size === 0) {
      throw new Error('economySweep: no expanding seat found — doctrine label changed?');
    }
    for (const f of allFacs) {
      const d = byFac.get(f.id);
      if ((f.gold ?? 0) <= 0) broke++;
      brokeDen++;
      if (!expanderIds.has(f.id)) continue;
      facs++;
      perFacTf.push(d ? d.n : 0);
      if (d) { reached++; firstTicks.push(d.first_tick); }
    }

    const wealth = allFacs.map(f => (f.metal ?? 0) + (f.gold ?? 0)).sort((a, b) => b - a);
    if (wealth.length >= 2 && wealth[wealth.length - 1] > 0) {
      ratios.push(wealth[0] / wealth[wealth.length - 1]);
    }

    for (const [k, v] of Object.entries(r.tally ?? {})) {
      if (/tfroute_no_|claim_rej|city_rej|insufficient/.test(k)) {
        gates.set(k, (gates.get(k) ?? 0) + v);
      }
    }
  }

  const topGates = [...gates.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return {
    id: arm.id,
    reach: pct(reached, facs),
    t1: med(firstTicks),
    tfPerFac: mean(perFacTf),
    broke: pct(broke, brokeDen),
    ratio: med(ratios),
    gates: topGates,
  };
}

console.log(`economy sweep: ${ARMS.length} arms x ${SEEDS} seeds x ${TICKS} ticks `
  + `= ${ARMS.length * SEEDS} games\n`);
const t0 = Date.now();
const out = [];
for (const arm of ARMS) {
  const res = await runArm(arm);
  out.push(res);
  console.log(`  ${res.id.padEnd(17)} reach ${res.reach.toFixed(0).padStart(3)}%  `
    + `t1 ${String(res.t1 ?? '-').padStart(4)}  tf/fac ${(res.tfPerFac ?? 0).toFixed(2)}  `
    + `broke ${res.broke.toFixed(0).padStart(3)}%  ratio ${(res.ratio ?? 0).toFixed(1)}x`);
}

console.log(`\n--- ranked by reach%, then by first-terraform speed ---`);
for (const r of [...out].sort((a, b) => (b.reach - a.reach) || ((a.t1 ?? 1e9) - (b.t1 ?? 1e9)))) {
  console.log(`  ${r.id.padEnd(17)} reach ${r.reach.toFixed(0).padStart(3)}%  t1 ${String(r.t1 ?? '-').padStart(4)}  `
    + `ratio ${(r.ratio ?? 0).toFixed(1)}x`);
}

console.log(`\n--- what blocked expansion, by arm ---`);
for (const r of out) {
  console.log(`  ${r.id.padEnd(17)} ${r.gates.map(([k, v]) => `${k}:${v}`).join('  ') || '(nothing recorded)'}`);
}

console.log(`\n${ARMS.length * SEEDS} games in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
