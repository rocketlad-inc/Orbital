// ============================================================
// Herald battle-shape regression harness.
//
// The Herald picks a template at RANDOM from each bank, so nothing here
// asserts exact prose. It asserts INVARIANTS that must hold whichever
// template fires, and runs every shape enough times to exercise the
// whole rotation.
//
// This exists because the endgame produced two Heralds that were wrong
// in ways no type checker or unit test could see:
//
//   "TWO-SIDED BATTLE ROYALE AT SOL"      — an oxymoron, and the count
//                                           was wrong: three factions
//                                           fought, two of them bled,
//                                           and the story counted the
//                                           bleeders.
//   "the attacker's identity remains a    — printed while holding BOTH
//    mystery"                               attackers' names, because a
//                                           2v1 failed the "exactly one
//                                           killer" test.
//
// Both were pure prose-logic bugs. Run: npm run sim:herald
// ============================================================

import { composeHeraldForGame } from '../worker/digest.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

const F = { A: 'Alpha Concord', B: 'Beta Syndicate', C: 'Gamma Imperium' };
const RUNS = 12;   // > the largest bank, so every template gets a turn

/** Build a one-body battle from `kills` = [[ownerKey, killerKey|null, n]]. */
async function herald(kills) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const G = 'g1';
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('u1','t@t','T','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'r','u1',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at)
                    VALUES (?, 'active','s',400,0)`).bind(G).run();
  let slot = 0;
  for (const k of Object.keys(F)) {
    await DB.prepare(`INSERT INTO game_factions (id,game_id,slot,name,color,status,joined_at)
                      VALUES (?,?,?,?,'#fff','active',0)`).bind(`f_${k}`, G, slot++, F[k]).run();
  }
  await DB.prepare(`INSERT INTO game_bodies (id,game_id,template_id,name,type,parent_body_id,radius,mu,color)
                    VALUES ('sol',?, 'sol','Sol','star',NULL,20,100,'#fd0')`).bind(G).run();

  let n = 0;
  const now = Date.now();
  for (const [owner, killer, count] of kills) {
    for (let i = 0; i < count; i++) {
      await DB.prepare(
        `INSERT INTO chronicle_entries
           (id,game_id,tick_number,kind,actor_faction_id,body_id,payload,visibility,created_at_ms)
         VALUES (?,?,400,'ship_destroyed',?, 'sol', ?, 'public', ?)`)
        .bind(`c${n++}`, G, `f_${owner}`, JSON.stringify({
          body_name: 'Sol',
          owner_faction_name: F[owner],
          killer_faction_name: killer ? F[killer] : null,
          ship_name: `Hull-${n}`,
        }), now - 1000).run();
    }
  }
  const h = await composeHeraldForGame({ DB }, { id: G, name: 'Endgame', current_tick: 400 });
  return `${h.title}\n${h.description}\n${h.fields.map(f => f.value).join('\n')}`;
}

const failures = [];
async function shape(label, kills, checks) {
  for (let run = 0; run < RUNS; run++) {
    const text = await herald(kills);
    for (const [what, ok] of Object.entries(checks)) {
      if (!ok(text)) {
        failures.push(`${label} :: ${what}\n    ${text.split('\n').slice(0, 2).join(' | ')}`);
        return;   // one report per shape is enough to act on
      }
    }
  }
  console.log(`PASS  ${label}`);
}

const has = (s) => (t) => t.includes(s);
const lacks = (s) => (t) => !t.includes(s);
/** Markers unique to the ATTACKER-UNKNOWN bank. */
const MYSTERY = ['remain unclear', 'cause unknown', 'No attacker has claimed',
  'no one is talking', 'identity remains a mystery', 'persons unknown',
  'Investigators are combing'];
const readsAsMystery = (t) => MYSTERY.some(m => t.includes(m));

// --- the two shapes that were broken -----------------------------------

await shape('2v1 wipe names BOTH attackers, is not a mystery',
  [['C', 'A', 4], ['C', 'B', 3]], {
    'names attacker A': has(F.A),
    'names attacker B': has(F.B),
    'names the victim': has(F.C),
    'does NOT read as unsolved': (t) => !readsAsMystery(t),
  });

await shape('3 participants are counted as THREE, not two',
  [['C', 'A', 6], ['C', 'B', 5], ['A', 'C', 1]], {
    'never claims two factions fought': lacks('two factions'),
    'never says two-way / two-sided': (t) => !/two-(way|sided)/i.test(t),
    'no two-sided battle royale': (t) => !/TWO-SIDED BATTLE ROYALE/i.test(t),
    'names the faction that took no losses': has(F.B),
  });

// --- lopsided multi-way reads as a rout, not "confusion" ---------------

await shape('lopsided melee is a rout, not total confusion',
  [['C', 'A', 15], ['A', 'C', 1], ['B', 'C', 1]], {
    'never calls a 15-1-1 slaughter confusion': lacks('Total confusion'),
    'names the gutted faction': has(F.C),
  });

// --- controls: paths that must NOT have changed ------------------------

await shape('CONTROL a genuinely unknown attacker credits nobody',
  [['C', null, 3]], {
    // Phrase-matching the unknown bank proved brittle — one template
    // ("Static and silence...") states the mystery without any of the
    // obvious markers. What must hold for EVERY template is that no
    // other faction gets blamed.
    'does not name a killer': (t) => !t.includes(F.A) && !t.includes(F.B),
    'names the victim': has(F.C),
  });

await shape('CONTROL 1v1 with one killer still names the winner',
  [['C', 'A', 3]], {
    'names the winner': has(F.A),
    'not a mystery': (t) => !readsAsMystery(t),
  });

await shape('CONTROL reciprocal 2-way stays a two-faction story',
  [['A', 'C', 3], ['C', 'A', 3]], {
    'names both': (t) => t.includes(F.A) && t.includes(F.C),
    'does not drag in a third party': lacks(F.B),
  });

console.log('');
if (failures.length) {
  console.log(`${failures.length} FAILED:\n` + failures.map(f => '  ' + f).join('\n'));
  process.exit(1);
}
console.log('all herald shapes pass');
