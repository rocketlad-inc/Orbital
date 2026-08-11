// ============================================================
// Faction colour uniqueness — seeds a REAL game through
// seedGameWorld and asserts no two factions come out wearing the
// same flag.
//
// The bug this locks down: the lobby rejects a pick within
// COLOR_MIN_DISTANCE of another member's pick, but only pref-vs-pref.
// A member who never opened the swatch grid fell through to
// FACTION_COLORS[slot] — the SAME palette the grid offers. Player A
// picks rose (#ec407a); player B never picks, lands on slot 6, and slot
// 6 IS rose. Two identical factions, no rule broken. A live game ran
// that way.
//
// Run: npm run sim:colors
// ============================================================

import { seedGameWorld } from '../worker/factions.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

const PALETTE = ['#ff7043', '#42a5f5', '#66bb6a', '#ab47bc',
                 '#ffca28', '#26c6da', '#ec407a', '#8d6e63'];
const MIN_DISTANCE = 90;

function dist(a, b) {
  const dr = parseInt(a.slice(1, 3), 16) - parseInt(b.slice(1, 3), 16);
  const dg = parseInt(a.slice(3, 5), 16) - parseInt(b.slice(3, 5), 16);
  const db = parseInt(a.slice(5, 7), 16) - parseInt(b.slice(5, 7), 16);
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** picks: array of (hex | null), one per member, in join order. */
async function seedWith(picks, label) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB };
  const G = 'gclash';
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('host','h@t','Host','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Clash Test','host',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at)
                    VALUES (?, 'setup','clash-seed',0,0)`).bind(G).run();
  for (let i = 0; i < picks.length; i++) {
    const uid = `u${i}`;
    if (i > 0) {
      await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                        VALUES (?,?,?,'x',0)`).bind(uid, `${uid}@t`, `P${i}`).run();
    }
    await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,color)
                      VALUES (?,?,?,?)`)
      .bind(G, i === 0 ? 'host' : uid, i, picks[i]).run();
  }
  await seedGameWorld(env, G);
  const rows = (await DB.prepare(
    `SELECT slot, color FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results ?? [];
  const colors = rows.map(r => r.color);

  // ONE bar now (Lorne): no two factions may fly the SAME colour.
  //
  // This file used to assert a second, softer rule — that a DEFAULT stay
  // 90 sRGB units from an explicit PICK — and had to carve out
  // exceptions for it, because the palette itself has three pairs closer
  // than 90 (azure/cyan 51, verdant/ferrous 87, ember/rose 75). That
  // whole apparatus is gone with the distance rule: near neighbours are
  // legal, so there is nothing to exempt.
  //
  // Tight pairs are still MEASURED and printed, because "these two are
  // 30 apart" is useful information when judging whether the palette
  // needs re-spacing — it just no longer fails the run.
  const clashes = [];
  const near = [];
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      if (colors[i] === colors[j]) {
        clashes.push(`DUPLICATE slot${i} and slot${j} both ${colors[i]}`);
        continue;
      }
      const d = dist(colors[i], colors[j]);
      if (d < MIN_DISTANCE) {
        near.push(`slot${i}(${colors[i]}) vs slot${j}(${colors[j]}) d=${d.toFixed(0)}`);
      }
    }
  }
  // An explicit pick must be honoured — the fix must not "fix" a
  // collision by overriding what a player deliberately chose.
  //
  // ONE legitimate exception: an EARLIER seat already holds that exact
  // colour. Someone has to lose a genuine duplicate, and join order is
  // the only non-arbitrary tiebreak. Anything else is theft.
  const stolen = picks.map((p, i) => {
    if (!p || colors[i] === p) return null;
    const earlierHolder = picks.findIndex((q, j) => j < i && q === p);
    if (earlierHolder !== -1) return null;   // duplicate — losing it is correct
    return `slot${i} asked ${p} got ${colors[i]}`;
  }).filter(Boolean);

  // A zero-faction result must never read as a pass. The first run of
  // this test seeded games with status 'lobby'; seedGameWorld early-
  // returns unless the status is 'setup', so nothing was created and
  // two scenarios reported PASS over an empty set.
  const wrongCount = colors.length !== picks.length
    ? [`expected ${picks.length} factions, seeded ${colors.length}`] : [];
  const ok = clashes.length === 0 && stolen.length === 0 && wrongCount.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`        picks:  ${picks.map(p => p ?? '—').join(' ')}`);
  console.log(`        result: ${colors.join(' ')}`);
  for (const c of clashes) console.log(`        CLASH ${c}`);
  for (const s of stolen) console.log(`        OVERRODE A PICK: ${s}`);
  for (const w of wrongCount) console.log(`        ${w}`);
  for (const n of near) console.log(`        (close, allowed — informational) ${n}`);
  return ok;
}

let bad = 0;
// THE SHIPPED BUG: one player picks rose, everyone else takes defaults.
// Slot 6's default IS rose.
if (!await seedWith([PALETTE[6], null, null, null, null, null, null, null],
  'someone picks the colour that slot 6 gets by default')) bad++;
// The mirror: a late slot picks slot 0's colour.
if (!await seedWith([null, null, null, PALETTE[0], null, null],
  'someone picks the colour that slot 0 gets by default')) bad++;
// Several explicit picks scattered through the palette.
if (!await seedWith([PALETTE[3], null, PALETTE[1], null, PALETTE[7], null],
  'multiple picks interleaved with defaults')) bad++;
// Nobody picks — the familiar spread must survive untouched.
if (!await seedWith([null, null, null, null], 'nobody picks (classic rotation)')) bad++;
// A near-miss custom colour: close to rose but not identical.
if (!await seedWith(['#ee4480', null, null, null, null, null, null],
  'a custom pick sitting right next to a palette entry')) bad++;
// Full house, every slot taken by defaults.
if (!await seedWith(Array(8).fill(null), 'eight players, all defaults')) bad++;

// ---- the exact-match rule (replaced the 90-unit distance rule) ------
//
// Near neighbours are now LEGAL. Under the old rule these two picks were
// 5 units apart and the second would have been rejected outright; the
// point of the change was that the distance rule ran the lobby out of
// colours. Both picks must survive to seeding untouched.
if (!await seedWith(['#ec407a', '#ec407f', null, null],
  'two near-identical picks are now allowed (5 apart)')) bad++;

// Two seats holding the SAME pick. The lobby blocks this, but a legacy
// row or a PATCH race can still produce it — and "no two factions share
// a colour" is the one rule left, so seeding has to resolve it rather
// than emit a duplicate. Earlier join order keeps the pick.
if (!await seedWith([PALETTE[2], PALETTE[2], null, null],
  'duplicate picks resolve — earlier seat keeps it')) bad++;

console.log('');
if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('no two factions share a flag');
