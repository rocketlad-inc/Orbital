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


// ------------------------------------------------------------
// Senate prose (chairman terms + quorum failures).
//
// The quorum case is the one that needed a test. A bill that dies for
// want of attendance is NOT a defeat, but it lands on the same
// `outcome: 'failed'` field as one — so before the split, every
// quorum death printed "lawmakers weren't convinced" and "couldn't
// find the votes it needed" about a vote that was never held. That is
// a Herald stating something false about the game.
// ------------------------------------------------------------

/** Herald over arbitrary chronicle rows: [kind, actorKey, payload]. */
async function heraldRows(rows) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const G = 'g2';
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
  let n = 0;
  const now = Date.now();
  for (const [kind, actor, payload] of rows) {
    await DB.prepare(
      `INSERT INTO chronicle_entries
         (id,game_id,tick_number,kind,actor_faction_id,payload,visibility,created_at_ms)
       VALUES (?,?,400,?,?,?, 'public', ?)`)
      .bind(`s${n++}`, G, kind, `f_${actor}`, JSON.stringify(payload), now - 1000).run();
  }
  const h = await composeHeraldForGame({ DB }, { id: G, name: 'Endgame', current_tick: 400 });
  return [h.title, h.description, ...h.fields.map(f => f.value)].join('\n');
}

async function shapeRows(label, rows, checks) {
  for (let run = 0; run < RUNS; run++) {
    const text = await heraldRows(rows);
    for (const [what, ok] of Object.entries(checks)) {
      if (!ok(text)) {
        failures.push(`${label} :: ${what} -- ${text.split('\n').slice(0, 3).join(' | ')}`);
        return;
      }
    }
  }
  console.log(`PASS  ${label}`);
}

/** Phrases that assert the chamber WEIGHED a bill. All of them are lies
 *  about a motion that never reached a tally. */
const DEBATE_CLAIMS = [
  "weren't convinced", 'votes it needed', 'votes down', 'rejected',
  'fails to carry', 'gavel falls against',
];

// TWO rows per shape, deliberately. composeEmbed promotes the single
// most newsworthy story to the headline and removes it from its section,
// so a one-row fixture only ever exercises the HEADLINE bank and leaves
// the narrative bank — the longer, more error-prone one — untested. The
// first version of these tests did exactly that and reported a failure
// against an empty body.
await shapeRows('a quorum failure never reads as a lost debate',
  [['senate_vote', 'A', {
    title: 'Mining Levy', bill_kind: 'slider_law', outcome: 'failed',
    failed_quorum: true, quorum_required: 4, quorum_cast: 2,
    yea_weight: 6, nay_weight: 0, abstain_weight: 0,
  }], ['senate_vote', 'C', {
    title: 'Orbital Tariff', bill_kind: 'slider_law', outcome: 'failed',
    failed_quorum: true, quorum_required: 4, quorum_cast: 1,
    yea_weight: 3, nay_weight: 0, abstain_weight: 0,
  }]], {
    'never claims the chamber rejected it':
      (t) => !DEBATE_CLAIMS.some(c => t.toLowerCase().includes(c.toLowerCase())),
    'says quorum or attendance':
      (t) => /quorum|attendance|empty|deserted|absentee|benches|too thin|turn(ed)? up|answered|unread|procedurally/i.test(t),
    'names the bill': has('Mining Levy'),
  });

await shapeRows('CONTROL an ordinary defeat still reads as a defeat',
  [['senate_vote', 'A', {
    title: 'Mining Levy', bill_kind: 'slider_law', outcome: 'failed',
    failed_quorum: false, quorum_required: 2, quorum_cast: 3,
    yea_weight: 2, nay_weight: 9, abstain_weight: 0,
  }]], {
    'does not blame attendance':
      (t) => !/no quorum|empty benches|deserted|absentee/i.test(t),
    'names the bill': has('Mining Levy'),
  });

await shapeRows('a seated chairman is named with the term deadline',
  [['senate_term', 'B', {
    faction_name: F.B, term_index: 2, bag_cycle: 0,
    start_tick: 48, end_tick: 72,
  }], ['senate_term', 'A', {
    faction_name: F.A, term_index: 3, bag_cycle: 0,
    start_tick: 72, end_tick: 96,
  }]], {
    'names a chairman': (t) => t.includes(F.B) || t.includes(F.A),
    // The deadline is the only actionable fact in a term announcement —
    // "who presides" without "until when" gives a reader nothing to do.
    'carries a deadline or a span': (t) => /\b(72|96|24|twenty-four)\b/.test(t),
    'does not invent a bill title': (t) => !/"\s*"/.test(t),
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
