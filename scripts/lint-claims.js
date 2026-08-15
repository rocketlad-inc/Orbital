#!/usr/bin/env node
// ============================================================
// lint-claims — find Herald sentences that ASSERT more than they know.
//
// The Herald is ~2,700 phrase-bank entries. Roughly one in seven makes a
// CLAIM: a comparison, an absolute, or a state that can be false even
// when every number interpolated into the sentence is correct. Those are
// the bugs an independent reviewer keeps finding one per edition —
// "LEAVES SOL LIGHTEST" over the heaviest loser, "losses have been light
// enough" over the worst losses in the paper, "EVERY FLAG IN THE SYSTEM"
// over three of seven factions.
//
// They are not typos and they are not caught by tests, because the code
// is correct: it interpolated the right numbers into a sentence that
// happened to lie about them. The only thing that can catch them is
// checking the CLAIM against the CONTEXT — which is what the runtime
// guard in digest.js does (see claimViolation) — and the only thing that
// can stop new ones being written is this lint.
//
// A bank opts in by listing itself in CLAIM_FLAGGED_BANKS in digest.js
// with the flags its context supplies. This reports coverage so the
// unguarded surface can be ratcheted to zero rather than audited once
// and left to rot.
//
//   node scripts/lint-claims.js          report
//   node scripts/lint-claims.js --max 0  fail if any unguarded claim
// ============================================================

const fs = require('fs');
const path = require('path');

const DIGEST = path.join(__dirname, '..', 'worker', 'digest.js');

/** The five families. Each maps to the flag a context must supply for a
 *  sentence in that family to be allowed to make its claim. */
const FAMILIES = [
  {
    name: 'superlative',
    flag: 'strictExtreme',
    // "the worst", "hit hardest", "topped" — false on a tie, which is
    // exactly how a 10-10 melee crowned a loser.
    re: /\b(worst|hardest|dearest|heaviest|lightest|biggest|largest|shortest|topped|most of anyone|paid most)\b/i,
  },
  {
    name: 'universal',
    flag: 'whole',
    // "every flag in the system" over three of seven.
    re: /\b(every (flag|fleet|power|yard|berth)|all (sides|powers)|everyone'?s at war|only \w+ paid|nobody else)\b/i,
  },
  {
    name: 'magnitude',
    flag: 'quiet',
    // "little to report" over the largest build run in the war.
    re: /\b(light enough|little to report|peacetime|nothing to report|uneventful|quiet week|routine)\b/i,
  },
  {
    name: 'parity',
    flag: 'parity',
    // "the line unchanged" at 27 built against 16 lost.
    re: /\b(unchanged|stand still|standing still|replacement, not|same size|even the period|hull for hull)\b/i,
  },
  {
    name: 'causal',
    flag: 'creditedActor',
    // "made X bleed" attributed to the side that lost more.
    re: /\b(made .{1,30} bleed|paid for it|was the answer|bled .{1,20} for it|at .{1,20}'s expense)\b/i,
  },
];

function parseBanks(src) {
  const lines = src.split('\n');
  const banks = new Map();
  let bank = null;
  lines.forEach((ln, i) => {
    const open = ln.match(/^const ([A-Z][A-Z0-9_]+) = \[/);
    if (open) { bank = open[1]; banks.set(bank, []); return; }
    if (/^\];/.test(ln)) { bank = null; return; }
    if (bank && /=>/.test(ln)) banks.get(bank).push({ line: i + 1, text: ln });
  });
  return banks;
}

/** Banks that have declared which claims their context can vouch for. */
function parseGuarded(src) {
  const m = src.match(/const CLAIM_FLAGGED_BANKS = new Set\(\[([\s\S]*?)\]\);/);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/'([A-Z0-9_]+)'/g)].map(x => x[1]));
}

function main() {
  const src = fs.readFileSync(DIGEST, 'utf8');
  const banks = parseBanks(src);
  const guarded = parseGuarded(src);

  let entries = 0;
  const findings = [];
  for (const [bank, rows] of banks) {
    for (const r of rows) {
      entries++;
      for (const fam of FAMILIES) {
        if (!fam.re.test(r.text)) continue;
        findings.push({ bank, fam: fam.name, flag: fam.flag, line: r.line, guarded: guarded.has(bank) });
      }
    }
  }

  const unguarded = findings.filter(f => !f.guarded);
  const byFam = {};
  for (const f of findings) {
    byFam[f.fam] = byFam[f.fam] || { total: 0, unguarded: 0 };
    byFam[f.fam].total++;
    if (!f.guarded) byFam[f.fam].unguarded++;
  }

  console.log(`banks ${banks.size}  entries ${entries}`);
  console.log(`claim-bearing ${findings.length}  guarded ${findings.length - unguarded.length}  UNGUARDED ${unguarded.length}`);
  console.log('');
  for (const [fam, v] of Object.entries(byFam)) {
    console.log(`  ${fam.padEnd(12)} ${String(v.total).padStart(4)}  unguarded ${v.unguarded}`);
  }

  const worst = {};
  for (const f of unguarded) worst[f.bank] = (worst[f.bank] || 0) + 1;
  const top = Object.entries(worst).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) {
    console.log('\nunguarded banks, worst first:');
    for (const [b, n] of top) console.log(`  ${String(n).padStart(3)}  ${b}`);
  }

  const maxArg = process.argv.indexOf('--max');
  if (maxArg !== -1) {
    const max = Number(process.argv[maxArg + 1] ?? 0);
    if (unguarded.length > max) {
      console.error(`\nFAIL: ${unguarded.length} unguarded claims (max ${max}).`);
      process.exit(1);
    }
  }
}

main();
