// ============================================================
// Senate chairmanship + quorum — drives the REAL resolveSenate over a
// seeded game and asserts the rotation and the vote bar behave.
//
// Written before deploy, deliberately. The last two features shipped
// today each had a defect that only a sim caught: a ReferenceError on a
// path esbuild cannot see (seedLateFaction's capitalCityHp), and a
// uniqueness rule that the DEFAULT assignment quietly violated. Term
// rotation has both shapes of risk — it runs every tick, and its
// fairness lives in an assignment nobody watches.
//
// Invariant-based rather than golden-output: the draw is random by
// design, so the tests assert PROPERTIES over many runs (nobody serves
// twice before everyone serves once) instead of a fixed sequence.
//
// Run: npm run sim:senate
// ============================================================

import { seedGameWorld, seedLateFaction, STARTING_BODY_OPTIONS } from '../worker/factions.js';
import { resolveSenate, quorumFor, billWindow } from '../worker/senate.js';
import { drawNextChairman, DEFAULT_TERM_TICKS } from '../worker/senateTerms.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

const TERM = DEFAULT_TERM_TICKS;
let failures = 0;

function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail) console.log(`        ${detail}`); }
}

/** Seed a game with N players and return { env, DB, gameId, factionIds }. */
async function seed(players, gameId = 'gsen', tickMs = 3600000) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB };
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('host','h@t','Host','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Senate Test','host',0,0)`).bind(gameId).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at,tick_interval_ms)
                    VALUES (?, 'setup','sen-seed',0,0,?)`).bind(gameId, tickMs).run();
  for (let i = 0; i < players; i++) {
    const uid = i === 0 ? 'host' : `u${i}`;
    if (i > 0) {
      await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                        VALUES (?,?,?,'x',0)`).bind(uid, `${uid}@t`, `P${i}`).run();
    }
    await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at)
                      VALUES (?,?,?)`).bind(gameId, uid, i).run();
  }
  await seedGameWorld(env, gameId);
  const factionIds = ((await DB.prepare(
    `SELECT id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(gameId).all()).results ?? [])
    .map(r => r.id);
  return { env, DB, gameId, factionIds };
}

/** Mark every player as recently seen so they count toward quorum. */
async function seatEveryone(DB, gameId, agoMs = 0) {
  const users = ((await DB.prepare(
    `SELECT user_id FROM game_factions WHERE game_id = ?`).bind(gameId).all()).results ?? []);
  for (const u of users) {
    if (!u.user_id) continue;
    await DB.prepare(`INSERT INTO sessions (token,user_id,created_at,expires_at,last_seen_at)
                      VALUES (?,?,?,?,?)`)
      .bind(`s_${u.user_id}_${agoMs}`, u.user_id, 0, 0, Date.now() - agoMs).run();
  }
}

async function runTicks(env, gameId, from, to) {
  for (let t = from; t <= to; t++) {
    await env.DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, gameId).run();
    await resolveSenate(env, gameId, t);
  }
}

async function terms(DB, gameId) {
  return ((await DB.prepare(
    `SELECT * FROM senate_terms WHERE game_id = ? ORDER BY term_index`).bind(gameId).all()).results ?? []);
}

// ============================================================
// 1. THE BAG — nobody serves twice before everyone serves once.
// ============================================================
{
  const players = 7;
  const { env, DB, gameId } = await seed(players, 'gbag');
  // Three full cycles' worth of terms.
  await runTicks(env, gameId, 0, TERM * players * 3);
  const rows = await terms(DB, gameId);

  const byCycle = new Map();
  for (const t of rows) {
    if (!byCycle.has(t.bag_cycle)) byCycle.set(t.bag_cycle, []);
    byCycle.get(t.bag_cycle).push(t.faction_id);
  }
  const dupes = [];
  const oversized = [];
  for (const [cycle, ids] of byCycle) {
    if (new Set(ids).size !== ids.length) dupes.push(`cycle ${cycle}: ${ids.join(' ')}`);
    if (ids.length > players) oversized.push(`cycle ${cycle} has ${ids.length} terms for ${players} players`);
  }
  check('bag: no faction serves twice in a cycle', dupes.length === 0, dupes.join(' | '));
  check('bag: a cycle never exceeds the player count', oversized.length === 0, oversized.join(' | '));

  // Every completed cycle must have seated everyone.
  const completed = [...byCycle.entries()].filter(([c]) => byCycle.has(c + 1));
  const short = completed.filter(([, ids]) => new Set(ids).size !== players);
  check('bag: every completed cycle seats all 7 players', short.length === 0,
    short.map(([c, ids]) => `cycle ${c} seated ${new Set(ids).size}`).join(' | '));

  // Terms must tile the timeline with no gap and no overlap.
  let contiguous = true, detail = '';
  for (let i = 1; i < rows.length; i++) {
    if (Number(rows[i].start_tick) !== Number(rows[i - 1].end_tick)) {
      contiguous = false;
      detail = `term ${i} starts ${rows[i].start_tick}, previous ended ${rows[i - 1].end_tick}`;
      break;
    }
  }
  check('terms tile the timeline with no gap or overlap', contiguous, detail);
}

// ============================================================
// 2. RANDOMNESS — the draw must not be a fixed order.
//    A bag that always hands out slot order would pass every test
//    above while being completely predictable.
// ============================================================
{
  const orders = new Set();
  for (let run = 0; run < 12; run++) {
    const { env, DB, gameId } = await seed(5, `gr${run}`);
    await runTicks(env, gameId, 0, TERM * 5);
    orders.add((await terms(DB, gameId)).slice(0, 5).map(t => t.faction_id).join(','));
  }
  check('draw order varies across runs (not a fixed rotation)', orders.size > 1,
    `saw ${orders.size} distinct first-cycle orders in 12 runs`);
}

// ============================================================
// 3. ELIMINATION — a dead chairman cannot hold the gavel.
//    NOT the forfeit rule Lorne declined: forfeit judges behaviour,
//    this is a faction that can never propose again.
// ============================================================
{
  const { env, DB, gameId } = await seed(4, 'gelim');
  await runTicks(env, gameId, 0, 1);
  const first = (await terms(DB, gameId))[0];
  await DB.prepare(`UPDATE game_factions SET status = 'eliminated' WHERE id = ?`)
    .bind(first.faction_id).run();
  await runTicks(env, gameId, 2, 3);

  const rows = await terms(DB, gameId);
  const closed = rows.find(t => t.id === first.id);
  const successor = rows[rows.length - 1];
  check('elimination closes the term early', closed.ended_reason === 'eliminated',
    `ended_reason=${closed.ended_reason}`);
  check('elimination seats a different, living chairman',
    successor.faction_id !== first.faction_id, `still ${successor.faction_id}`);
  const chairAlive = await DB.prepare(
    `SELECT status FROM game_factions WHERE id = ?`).bind(successor.faction_id).first();
  check('the successor is active', chairAlive.status === 'active', chairAlive.status);
}

// ============================================================
// 4. LATE JOIN — a newcomer enters the current bag immediately.
//    They have not had a turn, so making them wait for the next cycle
//    would be the wrong reading of "everyone serves once".
// ============================================================
{
  const { env, DB, gameId } = await seed(3, 'glate');
  await runTicks(env, gameId, 0, TERM + 1);       // burn a term or two
  const owned = new Set(((await DB.prepare(
    `SELECT template_id FROM game_bodies WHERE game_id = ? AND owner_faction_id IS NOT NULL`)
    .bind(gameId).all()).results ?? []).map(r => r.template_id));
  const free = STARTING_BODY_OPTIONS.map(o => o.id).find(id => !owned.has(id));
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('ulate','l@t','Late','x',0)`).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at) VALUES (?,?,?)`)
    .bind(gameId, 'ulate', 99).run();
  await seedLateFaction(env, gameId, 'ulate', free, {});
  const lateId = (await DB.prepare(
    `SELECT id FROM game_factions WHERE game_id = ? AND user_id = 'ulate'`).bind(gameId).first()).id;

  const cur = (await terms(DB, gameId)).slice(-1)[0];
  const draw = await drawNextChairman(env, gameId, Number(cur.bag_cycle));
  // Not asserting they're drawn NEXT (that's random) — asserting they're
  // in the pool at all, which is what eligibility means.
  let seenLate = false;
  for (let i = 0; i < 200 && !seenLate; i++) {
    const d = await drawNextChairman(env, gameId, Number(cur.bag_cycle));
    if (d.factionId === lateId) seenLate = true;
  }
  check('late joiner is eligible in the CURRENT cycle', seenLate,
    `200 draws never produced ${lateId}`);
  check('late-join draw returns a real faction', !!draw?.factionId);
}

// ============================================================
// 5. QUORUM — the denominator is SEATED players, not seats.
// ============================================================
{
  const { env, DB, gameId } = await seed(7, 'gquor');
  let q = await quorumFor(env, gameId, TERM);
  check('nobody seen -> seated 0, quorum floors at 2',
    q.seated === 0 && q.quorum === 2 && q.total === 7,
    JSON.stringify(q));

  await seatEveryone(DB, gameId, 0);
  q = await quorumFor(env, gameId, TERM);
  check('all 7 seated -> quorum 4', q.seated === 7 && q.quorum === 4, JSON.stringify(q));

  // Stale sessions must not seat anyone. Window is max(2 terms, 48h);
  // at 1h/tick that's 48h, so 30 days ago is comfortably outside.
  const { env: e2, DB: d2, gameId: g2 } = await seed(7, 'gstale');
  await seatEveryone(d2, g2, 30 * 24 * 3600 * 1000);
  const q2 = await quorumFor(e2, g2, TERM);
  check('month-old sessions do not seat anyone',
    q2.seated === 0 && q2.total === 7, JSON.stringify(q2));

  // 4 of 7 present -> quorum 2. The bar tracks the room, not the roster:
  // this is the whole reason six live games would otherwise be frozen.
  const { env: e3, DB: d3, gameId: g3 } = await seed(7, 'gpart');
  const users = ((await d3.prepare(
    `SELECT user_id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(g3).all()).results ?? []);
  for (let i = 0; i < 4; i++) {
    await d3.prepare(`INSERT INTO sessions (token,user_id,created_at,expires_at,last_seen_at)
                      VALUES (?,?,?,?,?)`)
      .bind(`sp${i}`, users[i].user_id, 0, 0, Date.now()).run();
  }
  const q3 = await quorumFor(e3, g3, TERM);
  check('4 of 7 present -> quorum 2 (not 4)',
    q3.seated === 4 && q3.quorum === 2, JSON.stringify(q3));
}

// ============================================================
// 6. QUORUM AT RESOLUTION — a bill with too few voters fails even
//    when the tally is unanimous in favour.
// ============================================================
{
  const { env, DB, gameId } = await seed(7, 'gres');
  await seatEveryone(DB, gameId, 0);                     // quorum = 4
  const facs = ((await DB.prepare(
    `SELECT id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(gameId).all()).results ?? [])
    .map(r => r.id);

  const mkBill = async (id, voters) => {
    await DB.prepare(
      `INSERT INTO senate_proposals
        (id, game_id, proposer_faction_id, kind, title, summary, payload, status,
         proposed_at_tick, vote_opens_at_tick, vote_closes_at_tick, debate_ticks, vote_ticks)
       VALUES (?, ?, ?, 'slider_law', ?, 's', '{"slider_id":"x","target_value":1}', 'voting', 0, 0, 5, 6, 6)`,
    ).bind(id, gameId, facs[0], id).run();
    for (const f of voters) {
      await DB.prepare(`INSERT INTO senate_votes (proposal_id,faction_id,vote,weight,cast_at_tick)
                        VALUES (?,?,'yea',1,0)`).bind(id, f).run();
    }
  };

  await mkBill('p_thin', facs.slice(0, 3));              // 3 yea, 0 nay — under quorum
  await runTicks(env, gameId, 5, 5);
  const thin = await DB.prepare(`SELECT status FROM senate_proposals WHERE id='p_thin'`).first();
  check('unanimous 3-of-7 bill FAILS for want of quorum', thin.status === 'failed', thin.status);

  const chr = await DB.prepare(
    `SELECT payload FROM chronicle_entries WHERE game_id = ? AND kind='senate_vote'
      ORDER BY created_at_ms DESC LIMIT 1`).bind(gameId).first();
  const parsed = JSON.parse(chr?.payload ?? '{}');
  check('chronicle distinguishes quorum failure from defeat',
    parsed.failed_quorum === true && parsed.quorum_required === 4,
    JSON.stringify(parsed).slice(0, 160));

  await mkBill('p_full', facs.slice(0, 4));              // 4 yea — quorum met
  await runTicks(env, gameId, 6, 6);
  const full = await DB.prepare(`SELECT status FROM senate_proposals WHERE id='p_full'`).first();
  check('4-of-7 bill PASSES once quorum is met', full.status === 'passed', full.status);

  // Abstain must count toward quorum, or "present and neutral" is a
  // vote against by omission and nobody would ever use it.
  await mkBill('p_abst', []);
  for (const f of facs.slice(0, 3)) {
    await DB.prepare(`INSERT INTO senate_votes (proposal_id,faction_id,vote,weight,cast_at_tick)
                      VALUES (?,?,'abstain',1,0)`).bind('p_abst', f).run();
  }
  await DB.prepare(`INSERT INTO senate_votes (proposal_id,faction_id,vote,weight,cast_at_tick)
                    VALUES ('p_abst',?, 'yea',1,0)`).bind(facs[4]).run();
  await runTicks(env, gameId, 7, 7);
  const abst = await DB.prepare(`SELECT status FROM senate_proposals WHERE id='p_abst'`).first();
  check('abstentions count toward quorum', abst.status === 'passed', abst.status);
}

// ============================================================
// 7. BILL WINDOWS — a bill can never outlive its term.
// ============================================================
{
  const bad = [];
  for (let end = 12; end <= 60; end++) {
    for (let at = 0; at < end; at++) {
      for (const [d, v] of [[undefined, undefined], [6, 6], [48, 24], [40, 20], [7, 9], [0, 0], [999, 999]]) {
        const w = billWindow(end, at, d, v);
        if (!w.ok) continue;
        if (w.voteCloses > end) bad.push(`end=${end} at=${at} d=${d} v=${v} -> closes ${w.voteCloses}`);
        if (w.debateTicks < 6 || w.voteTicks < 6) bad.push(`end=${end} at=${at} window under floor`);
      }
    }
  }
  check('no accepted bill closes after its term ends', bad.length === 0, bad.slice(0, 3).join(' | '));

  const tight = billWindow(24, 13, 6, 6);
  check('a term with 11 ticks left rejects the bill', tight.ok === false, JSON.stringify(tight));
  const exact = billWindow(24, 12, 6, 6);
  check('a term with exactly 12 ticks left accepts one minimum bill',
    exact.ok === true && exact.voteCloses === 24, JSON.stringify(exact));
  const greedy = billWindow(24, 0, 48, 24);
  check('an over-long request is clamped to fit the term',
    greedy.ok && greedy.voteCloses <= 24, JSON.stringify(greedy));
}

console.log('');
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
console.log('chairmanship rotates fairly and the quorum bar tracks the room');
