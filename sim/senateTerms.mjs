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
import {
  resolveSenate, quorumFor, billWindow, routes as senateRoutes,
  BILLS_PER_TERM, MAX_OPEN_BILLS, CHANCELLOR_VOTE_TICKS,
} from '../worker/senate.js';
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

/** Write a session row per player, `agoMs` in the past.
 *
 *  Sessions do NOT affect quorum — that is exactly what this now exists
 *  to prove. Kept so the tests can assert the bar stays put whether
 *  everyone is fresh, stale, or has never logged in at all. */
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
// 5. QUORUM — a MAJORITY of the living factions in the game.
//
//    Idleness is irrelevant (Lorne): a seat belongs to the empire, not
//    to whether its owner logged in this week. Only ELIMINATION removes
//    one. An earlier build shrank the denominator to recently-seen
//    players; these tests are what pin the rule down so that cannot
//    quietly creep back.
// ============================================================
{
  const { env, DB, gameId } = await seed(7, 'gquor');
  let q = await quorumFor(env, gameId);
  check('7 living factions -> quorum 4', q.eligible === 7 && q.quorum === 4, JSON.stringify(q));

  // The rule that changed. Nobody has a session at all here, and the
  // bar must NOT move for it.
  const { env: e2, DB: d2, gameId: g2 } = await seed(7, 'gidle');
  const q2 = await quorumFor(e2, g2);
  check('idle players still count toward quorum',
    q2.eligible === 7 && q2.quorum === 4, JSON.stringify(q2));

  // ...and a month-old session is still just an idle player.
  await seatEveryone(d2, g2, 30 * 24 * 3600 * 1000);
  const q2b = await quorumFor(e2, g2);
  check('a stale session changes nothing',
    q2b.eligible === 7 && q2b.quorum === 4, JSON.stringify(q2b));

  // Elimination is the ONLY thing that shrinks the chamber.
  const facs = ((await DB.prepare(
    `SELECT id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(gameId).all()).results ?? [])
    .map(r => r.id);
  await DB.prepare(`UPDATE game_factions SET status = 'eliminated' WHERE id IN (?, ?, ?)`)
    .bind(facs[4], facs[5], facs[6]).run();
  q = await quorumFor(env, gameId);
  check('eliminating 3 of 7 drops the bar to 3 of 4',
    q.eligible === 4 && q.quorum === 3, JSON.stringify(q));

  // MAJORITY, not half: an even chamber needs more than a tie's worth.
  const { env: e4, gameId: g4 } = await seed(4, 'geven');
  const q4 = await quorumFor(e4, g4);
  check('4 factions -> quorum 3 (majority, not half)',
    q4.eligible === 4 && q4.quorum === 3, JSON.stringify(q4));

  const { env: e5, gameId: g5 } = await seed(2, 'gduo');
  const q5 = await quorumFor(e5, g5);
  check('2 factions -> both must vote', q5.eligible === 2 && q5.quorum === 2, JSON.stringify(q5));
}

// ============================================================
// 6. QUORUM AT RESOLUTION — a bill with too few voters fails even
//    when the tally is unanimous in favour.
// ============================================================
{
  // 7 living factions -> quorum 4. No session setup needed: idleness
  // does not enter into it.
  const { env, DB, gameId } = await seed(7, 'gres');
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
// 7. BILL WINDOWS — no debate; the chairman picks 12–24, chancellor is 48.
// ============================================================
{
  const bad = [];
  for (let at = 0; at < 120; at++) {
    for (const v of [undefined, 0, 6, 12, 18, 24, 48, 999]) {
      const w = billWindow(at, v, 'slider_law');
      if (!w.ok) bad.push(`at=${at} v=${v} refused`);
      if (w.voteOpens !== at) bad.push(`at=${at} v=${v} opens ${w.voteOpens}, not now`);
      if (w.debateTicks !== 0) bad.push(`at=${at} v=${v} has a debate of ${w.debateTicks}`);
      if (w.voteTicks < 12 || w.voteTicks > 24) bad.push(`at=${at} v=${v} vote ${w.voteTicks} outside 12-24`);
      if (w.voteCloses !== at + w.voteTicks) bad.push(`at=${at} v=${v} closes wrong`);
    }
  }
  check('every bill opens now, votes 12-24 ticks, never refused for lateness', bad.length === 0, bad.slice(0, 3).join(' | '));
  const ch = billWindow(40, 12, 'chancellor_vote');
  check('a chancellor election is always 48 ticks, whatever was asked',
    ch.voteTicks === CHANCELLOR_VOTE_TICKS && CHANCELLOR_VOTE_TICKS === 48 && ch.voteCloses === 88, JSON.stringify(ch));
}

// ============================================================
// 8. THE FLOOR, end to end through the real proposal handler: the gavel,
//    no debate, no two bills on one dial, BILLS_PER_TERM, votes crossing
//    the handover, MAX_OPEN_BILLS, and the fixed-length chancellor vote.
// ============================================================
{
  const { env, DB, gameId, factionIds } = await seed(4, 'gfloor');
  // Research gating is not what this section tests.
  await DB.prepare('UPDATE games SET gating_enabled = 0 WHERE id = ?').bind(gameId).run();
  await runTicks(env, gameId, 0, 1);

  const route = senateRoutes.find(r => r.method === 'POST' && r.pattern.test(`/api/games/${gameId}/senate/proposals`));
  const file = async (userId, body) => {
    const res = await route.handle(
      new Request('https://sim/', { method: 'POST', body: JSON.stringify(body) }),
      env, { params: { gameId }, session: { user_id: userId } },
    );
    let j = {};
    try { j = await res.json(); } catch { /* empty */ }
    return { status: res.status, code: j?.error?.code ?? null, id: j?.proposal?.id ?? j?.id ?? null };
  };
  const userOf = async (fid) => (await DB.prepare('SELECT user_id FROM game_factions WHERE id = ?').bind(fid).first()).user_id;
  const slider = (id, v = 1.2) => ({ kind: 'slider_law', title: `Set ${id}`, summary: 'sim', slider_id: id, target_value: v, vote_ticks: 24 });
  const open = async () => Number((await DB.prepare(
    `SELECT COUNT(*) AS n FROM senate_proposals WHERE game_id = ? AND status IN ('debating','voting')`).bind(gameId).first()).n);
  const tick = async () => Number((await DB.prepare('SELECT current_tick AS t FROM games WHERE id = ?').bind(gameId).first()).t);

  let ts = await terms(DB, gameId);
  const t0 = ts[ts.length - 1];
  const chairA = await userOf(t0.faction_id);
  const outsider = await userOf(factionIds.find(f => f !== t0.faction_id));

  let r = await file(outsider, slider('metal_yield_multiplier'));
  check('only the chairman may file', r.status === 403 && r.code === 'not_chairman', JSON.stringify(r));

  r = await file(chairA, slider('metal_yield_multiplier'));
  const first = await DB.prepare(
    `SELECT status, proposed_at_tick, vote_opens_at_tick, vote_closes_at_tick FROM senate_proposals
      WHERE game_id = ? ORDER BY proposed_at_tick, rowid LIMIT 1`).bind(gameId).first();
  check('a bill opens straight into voting (no debate)',
    r.status < 300 && first?.status === 'voting' && first.vote_opens_at_tick === first.proposed_at_tick,
    JSON.stringify({ r, first }));

  r = await file(chairA, slider('metal_yield_multiplier', 1.5));
  check('a second bill on the same dial is refused while the first is open',
    r.status === 409 && r.code === 'bill_conflict', JSON.stringify(r));

  r = await file(chairA, slider('gold_yield_multiplier'));
  check('a second bill on a different dial is accepted', r.status < 300, JSON.stringify(r));

  r = await file(chairA, slider('science_yield_multiplier'));
  check(`a third bill in one term is refused (${BILLS_PER_TERM} per term)`,
    r.status === 409 && r.code === 'term_budget_spent', JSON.stringify(r));

  // Next chairman, filing on the LAST tick of their term: accepted, and
  // the votes stay open into the following term.
  await runTicks(env, gameId, 2, Number(t0.end_tick));
  ts = await terms(DB, gameId);
  const t1 = ts[ts.length - 1];
  const chairB = await userOf(t1.faction_id);
  await runTicks(env, gameId, Number(t0.end_tick) + 1, Number(t1.end_tick) - 1);
  const b1 = await file(chairB, slider('science_yield_multiplier'));
  const b2 = await file(chairB, slider('combat_damage_multiplier', 1.1));
  check('a bill filed on the last tick of a term is accepted',
    b1.status < 300 && b2.status < 300, JSON.stringify({ b1, b2, at: await tick(), end: t1.end_tick }));

  await runTicks(env, gameId, Number(t1.end_tick), Number(t1.end_tick));
  ts = await terms(DB, gameId);
  const t2 = ts[ts.length - 1];
  const stillOpen = await open();
  check('its votes stay open into the next chairman\'s term',
    t2.faction_id !== t1.faction_id && stillOpen === 2, JSON.stringify({ stillOpen, t2: t2.faction_id, t1: t1.faction_id }));

  // Third chairman: a chancellor election takes the third seat...
  const chairC = await userOf(t2.faction_id);
  const c1 = await file(chairC, {
    kind: 'chancellor_vote', title: 'Crown', summary: 'sim', candidate_faction_id: t2.faction_id, vote_ticks: 12,
  });
  const crown = await DB.prepare(
    `SELECT vote_ticks, vote_opens_at_tick, vote_closes_at_tick FROM senate_proposals
      WHERE game_id = ? AND kind = 'chancellor_vote'`).bind(gameId).first();
  check('a chancellor election runs 48 ticks even when 12 was asked',
    c1.status < 300 && crown && crown.vote_closes_at_tick - crown.vote_opens_at_tick === 48,
    JSON.stringify({ c1, crown }));

  // ...and the chamber is now full.
  const c2 = await file(chairC, slider('metal_yield_multiplier', 0.9));
  check(`a fourth open vote is refused (at most ${MAX_OPEN_BILLS})`,
    (await open()) === 3 && c2.status === 409 && c2.code === 'floor_full', JSON.stringify(c2));

  // ============================================================
  // 9. THE CHANCELLOR ELECTION NEEDS NO QUORUM. Only the proposer's own
  //    automatic yea is cast -- one of four seats, under the majority
  //    quorum every other bill needs -- and it still carries.
  // ============================================================
  const before = await DB.prepare(
    `SELECT COUNT(*) AS n FROM senate_votes WHERE proposal_id IN
       (SELECT id FROM senate_proposals WHERE game_id = ? AND kind = 'chancellor_vote')`).bind(gameId).first();
  await runTicks(env, gameId, Number(t2.start_tick) + 1, Number(crown.vote_closes_at_tick));
  const res = await DB.prepare(
    `SELECT status FROM senate_proposals WHERE game_id = ? AND kind = 'chancellor_vote'`).bind(gameId).first();
  const g = await DB.prepare('SELECT status, victory_type FROM games WHERE id = ?').bind(gameId).first();
  check('a chancellor election carries on one vote of four (no quorum)',
    Number(before.n) === 1 && res.status === 'passed' && g.status === 'completed' && g.victory_type === 'chancellor',
    JSON.stringify({ votes: before.n, res, g }));
  // The ordinary bills in the same chamber still need their quorum.
  const b = await DB.prepare(
    `SELECT COUNT(*) AS n FROM senate_proposals WHERE game_id = ? AND kind = 'slider_law' AND status = 'passed'`).bind(gameId).first();
  check('ordinary bills with one vote of four still fail for quorum', Number(b.n) === 0, JSON.stringify(b));
}

// ============================================================
// 10. EVERYTHING ELSE THAT READS A BILL, after the debate phase went.
//     Found by auditing every consumer (2026-09-26):
//     - DISCORD: the vote card (the only thing with Yea/Nay buttons, and
//       the only row live tallies refresh) posted on debating -> voting,
//       which a new bill never passes through. New bills got a "Debate is
//       open... a vote card posts when the floor opens" card and nothing.
//     - WITHDRAW: allowed only while debating, so no new bill could ever
//       be withdrawn, though floorCounts refunds a withdrawn bill's slot.
// ============================================================
{
  const { env, DB, gameId, factionIds } = await seed(3, 'gwithdraw');
  await DB.prepare('UPDATE games SET gating_enabled = 0 WHERE id = ?').bind(gameId).run();
  await runTicks(env, gameId, 0, 1);
  // A Discord audience and a channel, and a bot whose every call is kept.
  await DB.prepare(`UPDATE users SET discord_id = 'd1' WHERE id = 'host'`).run();
  env.DISCORD_BOT_TOKEN = 'sim';
  env.DISCORD_CHANNEL_ID = 'chan1';
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: init.method ?? 'GET', body });
    return new Response(JSON.stringify({ id: `m${calls.length}` }), { status: 200 });
  };

  const handle = async (method, path, userId, body) => {
    const route = senateRoutes.find(r => r.method === method && r.pattern.test(path));
    const m = path.match(route.pattern);
    const res = await route.handle(
      new Request(`https://sim${path}`, { method, body: body ? JSON.stringify(body) : undefined }),
      env, { params: m.groups, session: { user_id: userId } },
    );
    let j = {};
    try { j = await res.json(); } catch { /* empty */ }
    return { status: res.status, code: j?.error?.code ?? null, id: j?.proposal?.id ?? null };
  };
  const userOf = async (fid) => (await DB.prepare('SELECT user_id FROM game_factions WHERE id = ?').bind(fid).first()).user_id;
  const ts = await terms(DB, gameId);
  const chairFid = ts[ts.length - 1].faction_id;
  const chair = await userOf(chairFid);
  const other = await userOf(factionIds.find(f => f !== chairFid));
  const slider = (id) => ({ kind: 'slider_law', title: `Set ${id}`, summary: 'sim', slider_id: id, target_value: 1.2, vote_ticks: 12 });

  const a = await handle('POST', `/api/games/${gameId}/senate/proposals`, chair, slider('metal_yield_multiplier'));
  const posts = calls.filter(c => c.method === 'POST' && c.url.endsWith('/channels/chan1/messages'));
  const card = posts[posts.length - 1]?.body;
  const buttons = (card?.components?.[0]?.components ?? []).map(b => b.custom_id);
  check('Discord: a new bill posts the VOTE card, with its buttons',
    buttons.includes(`orb:v:${a.id}:yea`) && buttons.includes(`orb:v:${a.id}:nay`),
    JSON.stringify({ a, card }));
  check('Discord: ...and not the "Debate is open" card',
    !JSON.stringify(card ?? {}).includes('Debate is open'), JSON.stringify(card));
  const row = await DB.prepare('SELECT message_id FROM discord_senate_messages WHERE proposal_id = ?').bind(a.id).first();
  check('Discord: the card is recorded, so live tallies can refresh it', !!row?.message_id, JSON.stringify(row));

  calls.length = 0;
  const w = await handle('POST', `/api/games/${gameId}/senate/proposals/${a.id}/withdraw`, chair);
  const st = await DB.prepare('SELECT status FROM senate_proposals WHERE id = ?').bind(a.id).first();
  check('withdraw: the proposer can take back an open bill nobody else has voted on',
    w.status === 200 && st.status === 'withdrawn', JSON.stringify({ w, st }));
  const patch = calls.find(c => c.method === 'PATCH');
  check('withdraw: its Discord card loses its buttons',
    !!patch && Array.isArray(patch.body?.components) && patch.body.components.length === 0,
    JSON.stringify(patch));

  const b = await handle('POST', `/api/games/${gameId}/senate/proposals`, chair, slider('gold_yield_multiplier'));
  const v = await handle('POST', `/api/games/${gameId}/senate/proposals/${b.id}/vote`, other, { vote: 'nay' });
  const w2 = await handle('POST', `/api/games/${gameId}/senate/proposals/${b.id}/withdraw`, chair);
  check('withdraw: refused once another senator has voted (no pulling a losing bill)',
    v.status < 300 && w2.status === 409 && w2.code === 'not_withdrawable', JSON.stringify({ b, v, w2 }));

  const w3 = await handle('POST', `/api/games/${gameId}/senate/proposals/${b.id}/withdraw`, other);
  check('withdraw: never by anyone but the proposer', w3.status === 403, JSON.stringify(w3));

  globalThis.fetch = realFetch;
}

console.log('');
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
console.log('chairmanship rotates fairly and the quorum bar tracks the room');
