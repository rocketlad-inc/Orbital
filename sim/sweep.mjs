// ============================================================================
// sweep.mjs — the Monte Carlo layer.
//
// One game tells you what happened. A sweep tells you what TENDS to
// happen, which is the only thing balance work can act on.
//
// This first sweep deliberately runs empires that issue NO ORDERS. That
// sounds useless and isn't: it isolates the one variable the game decides
// for you rather than one you play. Every faction gets the same rules and
// the same tick count, so any spread in the outcome is attributable to
// the STARTING POSITION the seed dealt them — the thing the fair-spawn
// work was meant to flatten.
//
// It is a floor, not a verdict. A start that is poor for a passive empire
// may be strong for an aggressive one, and nothing here can see that.
// Scripted archetypes are what turn this into a real balance instrument;
// this establishes the baseline they get measured against.
//
// Usage:  node sim/sweep.mjs [seeds] [ticks]
// ============================================================================

import { runGame } from './headless.mjs';
import { ARCHETYPES } from './bots.mjs';

const SEEDS = Number(process.argv[2] ?? 20);
const TICKS = Number(process.argv[3] ?? 200);
/** "passive" reproduces the original baseline; otherwise every archetype
 *  plays, rotated across seats so no doctrine is welded to a spawn. */
const MODE = process.argv[4] ?? 'bots';
const DOCTRINES = MODE === 'passive' ? null : Object.keys(ARCHETYPES);

/** Total wealth, weighting the three currencies equally. Crude on
 *  purpose: the moment you weight them you are encoding a strategy
 *  opinion into the measurement, and this pass is meant to be
 *  strategy-free. */
const wealth = (f) => Math.round((f.metal ?? 0) + (f.gold ?? 0) + (f.science ?? 0));

function stats(xs) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const sorted = [...xs].sort((a, b) => a - b);
  return { n, mean, sd, min: sorted[0], max: sorted[n - 1], median: sorted[Math.floor(n / 2)] };
}

async function main() {
  console.log(`sweep: ${SEEDS} seeds x ${TICKS} ticks, ${MODE === 'passive' ? 'passive empires' : DOCTRINES.join(' / ')}\n`);
  const t0 = Date.now();

  const perSeed = [];
  for (let i = 0; i < SEEDS; i++) {
    const seed = `sweep-${String(i).padStart(4, '0')}`;
    const r = await runGame({
      ticks: TICKS, players: 4, seed, quiet: true,
      doctrines: DOCTRINES,
      // Rotate which seat gets which doctrine, so across the sweep every
      // archetype plays every spawn. Without this the sweep measures
      // "was slot 0 lucky" and calls it a balance result.
      doctrineOffset: i,
    });
    perSeed.push(r);
    process.stdout.write(`  ${i + 1}/${SEEDS}\r`);
  }

  // --- per-archetype outcomes ---------------------------------------------
  if (DOCTRINES) {
    const byDoc = new Map();
    let wins = new Map();
    for (const r of perSeed) {
      let best = null;
      for (const f of r.factions) {
        if (!f.doctrine) continue;
        const arr = byDoc.get(f.doctrine) ?? [];
        arr.push(f);
        byDoc.set(f.doctrine, arr);
        if (!best || wealth(f) > wealth(best)) best = f;
      }
      if (best) wins.set(best.doctrine, (wins.get(best.doctrine) ?? 0) + 1);
    }
    console.log(`--- by doctrine (${SEEDS} games, ${TICKS} ticks) ---`);
    console.log(`  ${'doctrine'.padEnd(12)} ${'wealth'.padStart(8)} ${'bodies'.padStart(7)} ${'ships'.padStart(6)} ${'top-econ'.padStart(9)}`);
    for (const d of DOCTRINES) {
      const name = ARCHETYPES[d].name;
      const fs = byDoc.get(name) ?? [];
      if (!fs.length) continue;
      const w = stats(fs.map(wealth));
      const b = stats(fs.map(f => f.bodies ?? 0));
      const s = stats(fs.map(f => f.ships ?? 0));
      const win = ((wins.get(name) ?? 0) / SEEDS * 100).toFixed(0);
      console.log(`  ${name.padEnd(12)} ${Math.round(w.mean).toString().padStart(8)} `
        + `${b.mean.toFixed(1).padStart(7)} ${s.mean.toFixed(1).padStart(6)} ${(win + '%').padStart(9)}`);
    }
    console.log('  (top-econ = share of games this doctrine ended richest; NOT a win condition)');

    // --- spread, not just centre ------------------------------------------
    // A mean hides whether a doctrine is reliable or a lottery. Two
    // strategies averaging the same wealth are not equivalent if one has
    // half the variance — that is the difference between a solid opening
    // and a gamble, and players feel it long before they can name it.
    console.log(`\n--- consistency (same games) ---`);
    console.log(`  ${'doctrine'.padEnd(12)} ${'mean'.padStart(7)} ${'sd'.padStart(7)} ${'min'.padStart(7)} ${'max'.padStart(7)}  spread`);
    for (const d of DOCTRINES) {
      const name = ARCHETYPES[d].name;
      const fs = byDoc.get(name) ?? [];
      if (!fs.length) continue;
      const w = stats(fs.map(wealth));
      console.log(`  ${name.padEnd(12)} ${Math.round(w.mean).toString().padStart(7)} `
        + `${Math.round(w.sd).toString().padStart(7)} ${Math.round(w.min).toString().padStart(7)} `
        + `${Math.round(w.max).toString().padStart(7)}  ${(w.sd / Math.max(1, w.mean)).toFixed(2)}`);
    }
    console.log('  (spread = sd/mean; higher means the doctrine is a gamble)');

    // --- tech pace ---------------------------------------------------------
    console.log(`\n--- research reached (total levels across tracks) ---`);
    for (const d of DOCTRINES) {
      const name = ARCHETYPES[d].name;
      const fs = byDoc.get(name) ?? [];
      if (!fs.length) continue;
      const t = stats(fs.map(f => f.techLevels ?? 0));
      console.log(`  ${name.padEnd(12)} mean ${t.mean.toFixed(1).padStart(5)}  range ${t.min}-${t.max}`);
    }

    // --- snowball ----------------------------------------------------------
    // Does leading at halftime mean winning? Reported as the share of
    // games where the midpoint leader also finished first. 25% is pure
    // chance with four players; 100% means the second half is decorative.
    let leadHeld = 0, comparable = 0;
    for (const r of perSeed) {
      const withMid = r.factions.filter(f => f.midWealth != null);
      if (withMid.length < 2) continue;
      comparable += 1;
      const midLeader = withMid.reduce((a, b) => (b.midWealth > a.midWealth ? b : a));
      const endLeader = r.factions.reduce((a, b) => (wealth(b) > wealth(a) ? b : a));
      if (midLeader.id === endLeader.id) leadHeld += 1;
    }
    if (comparable) {
      console.log(`\n--- snowball ---`);
      console.log(`  midpoint leader also finished first: ${leadHeld}/${comparable} `
        + `(${(leadHeld / comparable * 100).toFixed(0)}%, chance = 25%)`);
    }

    // --- spawn quality -----------------------------------------------------
    // Pooled across games by capital TEMPLATE, so "is Earth a better
    // start than Mars" gets an answer independent of who drew it.
    const byCapital = new Map();
    for (const r of perSeed) {
      for (const f of r.factions) {
        if (!f.capital) continue;
        const arr = byCapital.get(f.capital) ?? [];
        arr.push(wealth(f));
        byCapital.set(f.capital, arr);
      }
    }
    const capRows = [...byCapital.entries()]
      .filter(([, xs]) => xs.length >= 3)
      .map(([cap, xs]) => ({ cap, ...stats(xs) }))
      .sort((a, b) => b.mean - a.mean);
    if (capRows.length) {
      console.log(`\n--- spawn quality by capital (n>=3) ---`);
      for (const c of capRows) {
        console.log(`  ${c.cap.padEnd(12)} mean ${Math.round(c.mean).toString().padStart(6)}  n=${c.n}`);
      }
      const best = capRows[0], worst = capRows[capRows.length - 1];
      console.log(`  best/worst capital: ${(best.mean / Math.max(1, worst.mean)).toFixed(2)}x `
        + `(${best.cap} vs ${worst.cap})`);
    }

    // What the bots tried and were refused. A doctrine that spends the
    // game being told "insufficient metal" is a doctrine the economy
    // does not currently support — that is a balance finding, not a bug.
    const tally = {};
    for (const r of perSeed) {
      for (const [k, v] of Object.entries(r.tally ?? {})) tally[k] = (tally[k] ?? 0) + v;
    }
    // Split by doctrine: WHICH strategy the economy is refusing is a
    // lead; a global total is only an observation.
    console.log(`\n--- what each doctrine tried, and was told ---`);
    for (const d of DOCTRINES) {
      const name = ARCHETYPES[d].name;
      const mine = Object.entries(tally)
        .filter(([k]) => k.startsWith(`${name}:`))
        .map(([k, v]) => [k.slice(name.length + 1), v])
        .sort((a, b) => b[1] - a[1]);
      if (!mine.length) continue;
      const ok = mine.filter(([k]) => k.endsWith('_ok')).reduce((a, [, v]) => a + v, 0);
      const rej = mine.filter(([k]) => k.includes('_rej_')).reduce((a, [, v]) => a + v, 0);
      const pct = ok + rej ? ((rej / (ok + rej)) * 100).toFixed(0) : '0';
      console.log(`  ${name} — ${ok} accepted, ${rej} refused (${pct}% refused)`);
      for (const [k, v] of mine.slice(0, 4)) console.log(`      ${String(v).padStart(5)}  ${k}`);
    }
  }

  // --- spread WITHIN a game: how unequal is a typical match? --------------
  // The honest question for spawn fairness is not "is slot 2 lucky" (slots
  // are shuffled) but "how far apart are the best and worst starts in the
  // same game". A game where the leader ends 3x the laggard on economy
  // alone, with nobody having played, is a spawn problem.
  const ratios = [];
  const gaps = [];
  for (const r of perSeed) {
    const w = r.factions.map(wealth).sort((a, b) => b - a);
    ratios.push(w[0] / Math.max(1, w[w.length - 1]));
    gaps.push(w[0] - w[w.length - 1]);
  }
  const rs = stats(ratios);
  const gs = stats(gaps);

  console.log(`
--- inequality within a game (${MODE}, ${TICKS} ticks) ---`);
  console.log(`  best:worst wealth ratio   mean ${rs.mean.toFixed(2)}x   median ${rs.median.toFixed(2)}x   `
    + `range ${rs.min.toFixed(2)}-${rs.max.toFixed(2)}x`);
  console.log(`  absolute gap              mean ${Math.round(gs.mean)}   max ${Math.round(gs.max)}`);

  // --- bankruptcy: the arrears signal from the single-game run ------------
  let brokeGames = 0, brokeFactions = 0;
  for (const r of perSeed) {
    const broke = r.factions.filter(f => (f.gold ?? 0) <= 0).length;
    if (broke) brokeGames += 1;
    brokeFactions += broke;
  }
  console.log(`\n--- credit bankruptcy (${MODE}) ---`);
  console.log(`  games with >=1 broke faction: ${brokeGames}/${SEEDS}`);
  console.log(`  factions at 0 credits:        ${brokeFactions}/${SEEDS * 4}`);

  // --- what the tick loop actually did ------------------------------------
  const kinds = new Map();
  for (const r of perSeed) {
    for (const c of r.chronicle) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + c.n);
  }
  console.log(`\n--- chronicle across all runs ---`);
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${k}`);
  }

  const wall = Date.now() - t0;
  console.log(`\n--- cost ---`);
  console.log(`  ${SEEDS} games in ${(wall / 1000).toFixed(1)}s `
    + `(${(wall / SEEDS).toFixed(0)} ms/game)`);
  console.log(`  extrapolated 1000 games: ${((wall / SEEDS) * 1000 / 1000 / 60).toFixed(1)} min single-threaded`);
}

main().catch((e) => { console.error('SWEEP FAILED:', e.message); process.exit(1); });
