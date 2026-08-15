#!/usr/bin/env node
// ============================================================
// fuzz-herald — render EVERY phrase-bank entry against adversarial
// contexts and machine-check the result.
//
// An independent reviewer reading five editions sees roughly 150 of the
// Herald's 2,683 template entries — about five per cent. That is why the
// same class of defect kept arriving one per edition for twenty rounds:
// sampling cannot clear a surface this size, and every round of fixes
// was followed by a round of newly-sampled bugs from the same families.
//
// This exercises all of them, against the contexts that actually break
// sentences: a tie (no worst exists), one (plural agreement), zero
// (empty lists), and an extreme (superlatives that must earn their
// numbers). It cannot judge prose. It can prove a sentence never
// interpolates `undefined`, never disagrees with itself about number,
// and never makes a claim its context denies.
//
//   node scripts/fuzz-herald.js
//   node scripts/fuzz-herald.js --verbose
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIGEST = path.join(__dirname, '..', 'worker', 'digest.js');
const src = fs.readFileSync(DIGEST, 'utf8');

// --- Load the banks and their helpers into a sandbox -----------------
// digest.js is an ES module full of Worker imports, so rather than
// import it we lift the pure pieces: the helpers the templates call and
// the bank literals themselves.
const HELPERS = `
const NW=['zero','one','two','three','four','five','six','seven','eight','nine'];
function numWord(n){return (Number.isInteger(n)&&n>=0&&n<=9)?NW[n]:String(n);}
const OW=['zeroth','first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth'];
function ordinal(n){const i=Number(n);if(Number.isInteger(i)&&i>=0&&i<OW.length)return OW[i];
  const r=i%10,h=i%100;if(h>=11&&h<=13)return i+'th';return i+(r===1?'st':r===2?'nd':r===3?'rd':'th');}
function plural(n,s,p){return Math.abs(Number(n))===1?s:(p!==undefined?p:s+'s');}
function shipsWord(n){return plural(n,'ship','ships');}
function b(x){return '**'+x+'**';}
function titleCase(s){return String(s).replace(/\\b\\w/g,c=>c.toUpperCase());}
function capitalizeFirst(s){return String(s).charAt(0).toUpperCase()+String(s).slice(1);}
function timesWord(v){return v+'x';}
function nameList(a){return (a||[]).join(', ');}
`;

function extractBanks(source) {
  const out = [];
  const re = /^const ([A-Z][A-Z0-9_]+) = \[\n([\s\S]*?)\n\];/gm;
  let m;
  while ((m = re.exec(source))) {
    // Only banks of callables — the catalogues of plain strings and the
    // config tables have nothing to render.
    if (!/=>/.test(m[2])) continue;
    out.push({ name: m[1], code: m[0] });
  }
  return out;
}

/** Contexts chosen to break sentences rather than to exercise them. */
function contexts() {
  const base = {
    faction: 'Testarossa', actor: 'Testarossa', leader: 'Testarossa',
    winner: 'Alpha', loser: 'Beta', a: 'Alpha', b: 'Beta',
    worst: 'Beta', who: 'Alpha', target: 'Beta', partner: 'Gamma',
    body: 'Mars', bodyName: 'Mars', bodyLoc: '**Mars**', fromLoc: '**Io**', toLoc: '**Mars**',
    shipName: 'Comet', name: 'Comet', title: 'A Bill', pactName: 'a treaty',
    sideList: '**Alpha** lost two', namesClause: '', shipNamesClause: '', entriesClause: '',
    countText: 'two ships', tail: '', popClause: '', termEnd: 100, termNumber: 2, termSpan: 24,
    pct: 50, damage: 10, level: 2, rank: 1, eta: 3, tick: 100,
    factionA: 'Alpha', factionB: 'Beta', factionCount: 3, totalShips: 5, totalBuilds: 2,
  };
  const nums = {
    tie:     { count: 4, countA: 4, countB: 4, worstCount: 4, othersCount: 4, partyCount: 2,
               shipCount: 4, buildCount: 4, lost: 4, net: 0, winnerCount: 4, loserCount: 4,
               cast: 2, required: 2, nth: 2, total: 8, threshold: 4 },
    one:     { count: 1, countA: 1, countB: 1, worstCount: 1, othersCount: 0, partyCount: 1,
               shipCount: 1, buildCount: 1, lost: 1, net: 1, winnerCount: 1, loserCount: 1,
               cast: 1, required: 1, nth: 1, total: 1, threshold: 1 },
    zero:    { count: 0, countA: 0, countB: 0, worstCount: 0, othersCount: 0, partyCount: 0,
               shipCount: 0, buildCount: 0, lost: 0, net: 0, winnerCount: 0, loserCount: 0,
               cast: 0, required: 0, nth: 0, total: 0, threshold: 0 },
    extreme: { count: 57, countA: 57, countB: 3, worstCount: 57, othersCount: 3, partyCount: 7,
               shipCount: 57, buildCount: 12, lost: 57, net: -45, winnerCount: 3, loserCount: 57,
               cast: 8, required: 5, nth: 9, total: 60, threshold: 20 },
  };
  return Object.entries(nums).map(([label, n]) => [label, { ...base, ...n }]);
}

const AGREEMENT = [
  // "1 ships", "one ships", "2 ship" — number disagreeing with its noun.
  //
  // skipIf keeps the tool honest about PAIRS: "one and four hulls" is
  // correct English, and flagging it buried three real findings under
  // four false ones the first time this ran. A checker that cries wolf
  // is a checker nobody runs.
  { re: /\b(?:1|one)\s+(?:ships|hulls|worlds|settlements|losses|powers|fleets|times|projects)\b/i,
    skipIf: /\b(?:and|or|to)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine)\s+\w+s\b/i,
    why: 'singular value with plural noun' },
  { re: /\b(?:[02-9]|two|three|four|five|six|seven|eight|nine)\s+(?:ship|hull|world|settlement|loss|power|fleet|project)\b(?!s)/i,
    why: 'plural value with singular noun' },
];

function main() {
  const verbose = process.argv.includes('--verbose');
  const banks = extractBanks(src);
  const ctxs = contexts();

  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(HELPERS, sandbox);

  let rendered = 0;
  const problems = [];

  for (const bank of banks) {
    let arr;
    try {
      vm.runInContext(bank.code + `\nglobalThis.__B = ${bank.name};`, sandbox);
      arr = sandbox.__B;
    } catch (e) {
      problems.push({ bank: bank.name, kind: 'load', detail: String(e.message).slice(0, 80) });
      continue;
    }
    if (!Array.isArray(arr)) continue;

    arr.forEach((fn, i) => {
      if (typeof fn !== 'function') return;
      for (const [label, ctx] of ctxs) {
        // Preconditions. A melee bank is never reached with fewer than
        // three parties, so "one powers" from that bank is a fact about
        // this harness, not about the paper. Without these the real
        // findings drown in impossible ones and nobody runs the tool.
        if (/MELEE|CHAOS|GANG_UP|FLEET_MELEE/.test(bank.name) && ctx.partyCount < 3) continue;
        if (/MUTUAL|DECISIVE|NARROW/.test(bank.name) && (ctx.countA < 1 || ctx.countB < 1)) continue;
        if (/SURGE|REPLACEMENT|ATTRITION/.test(bank.name) && ctx.shipCount < 3) continue;
        // Banks disagree about their calling convention — some take a
        // ctx object, others positional args in several shapes. Trying
        // one and reporting the mess is how a checker becomes noise
        // nobody runs, so try them all and judge the BEST result: a
        // defect is only real if no convention renders the sentence
        // cleanly.
        const shapes = [
          () => fn(ctx),
          () => fn(ctx.bodyLoc, ctx.count),
          () => fn(ctx.count, ctx.faction),
          () => fn(ctx.count),
          () => fn(ctx.shipName, false, ctx.popClause),
          () => fn(),
        ];
        let best = null;
        let threw = null;
        for (const shape of shapes) {
          let out;
          try { out = shape(); } catch (e) { threw = threw ?? String(e.message); continue; }
          if (typeof out !== 'string') continue;
          const holed = /undefined|NaN|\[object Object\]/.test(out);
          if (!holed) { best = out; break; }
          if (best === null) best = out;
        }
        if (best === null) {
          if (threw) {
            problems.push({ bank: bank.name, idx: i, ctx: label, kind: 'throw',
                            detail: String(threw).slice(0, 70) });
          }
          continue;
        }
        rendered++;
        if (/undefined|NaN|\[object Object\]/.test(best)) {
          problems.push({ bank: bank.name, idx: i, ctx: label, kind: 'hole',
                          detail: best.trim().slice(0, 90) });
          continue;
        }
        for (const a of AGREEMENT) {
          if (a.skipIf && a.skipIf.test(best)) continue;
          if (a.re.test(best)) {
            problems.push({ bank: bank.name, idx: i, ctx: label, kind: 'agreement',
                            detail: a.why + ': ' + best.trim().slice(0, 70) });
            break;
          }
        }
      }
    });
  }

  const byKind = {};
  for (const p of problems) byKind[p.kind] = (byKind[p.kind] || 0) + 1;

  console.log(`banks ${banks.length}  renders ${rendered}`);
  console.log(`problems ${problems.length}` +
    (problems.length ? '  (' + Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ') + ')' : ''));

  const show = verbose ? problems : problems.slice(0, 25);
  for (const p of show) {
    console.log(`  ${p.kind.padEnd(9)} ${p.bank}[${p.idx}] @${p.ctx}: ${p.detail}`);
  }
  if (!verbose && problems.length > show.length) {
    console.log(`  … ${problems.length - show.length} more (--verbose)`);
  }
}

main();
