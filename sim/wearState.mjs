// ============================================================
// THE WATCH'S SERVER HALF, AGAINST A REAL DATABASE.
//
// worker/wear.js is the first thing in this codebase that lets a bare
// token WRITE to a game. Everything the widget family does before it is
// a read that renders a picture, and the whole argument for handing a
// capability to a device was that the worst a leak could do was show
// somebody your metal count (migration 0134). That argument now has an
// exception in it, and an exception nobody exercises is a hole.
//
// So this seeds a real schema through the real migration bundle and
// asks the questions that would otherwise be answered by reading the
// code and believing it:
//
//   - does a 'card' token get anywhere near the watch routes?
//   - does a wear token's vote actually land in senate_votes?
//   - can a wear token vote on a proposal in a DIFFERENT game -- the one
//     attack that needs no stolen token at all, just a player sending an
//     id the watch would never send?
//   - does per-tick income match the Economy tab's own arithmetic, or
//     has the watch quietly grown a second derivation?
//   - does a game the player has been eliminated from still offer
//     buttons?
//
// Run: npm run sim:wear
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { handleWearState, handleWearVote } from '../worker/wear.js';
import { mintWidgetToken } from '../worker/widget.js';
import { economySeries, economyAverages } from '../worker/economy.js';

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

const statementsOf = (sql) => sql
  .split(/;\s*(?:\r?\n|$)/)
  .map(s => s.replace(/^\s*--.*$/gm, '').trim())
  .filter(s => s.length > 0);

const NOT_FATAL_RE = /duplicate column|already exists|no such column.*to drop/i;

const db = new SimD1();
for (const m of MIGRATIONS) {
  for (const stmt of statementsOf(m.sql)) {
    try { db.db.exec(stmt); } catch (e) {
      if (!NOT_FATAL_RE.test(String(e?.message ?? e))) {
        console.error(`migration ${m.name} failed:`, e?.message ?? e);
        process.exit(1);
      }
    }
  }
}
const env = { DB: db };

// ---------------------------------------------------------------------
// Seed. Two games, because the cross-game vote is the interesting one.
// ---------------------------------------------------------------------

const NOW = Date.now();
const TICK = 100;
const run = async (sql, ...bind) => db.prepare(sql).bind(...bind).run();

await run(`INSERT INTO users (id, email, display_name, password_hash, created_at)
     VALUES ('u1', 'a@example.com', 'Admiral', 'x', ?)`, NOW);
await run(`INSERT INTO users (id, email, display_name, password_hash, created_at)
     VALUES ('u2', 'b@example.com', 'Rival', 'x', ?)`, NOW);

async function seedGame(id, name, { gameStatus = 'active', factionStatus = 'active', tick = TICK } = {}) {
  await run(`INSERT INTO rooms (id, name, host_id, status, created_at, updated_at)
       VALUES (?, ?, 'u1', 'in_progress', ?, ?)`, id, name, NOW, NOW);
  await run(`INSERT INTO games (id, status, map_seed, current_tick, next_tick_at,
                          tick_interval_ms, created_at)
       VALUES (?, ?, 'seed', ?, ?, 450000, ?)`,
    id, gameStatus, tick, NOW + 300000, NOW);
  await run(`INSERT INTO game_factions (id, game_id, user_id, slot, name, color, status,
                                  senate_weight, metal, gold, science, joined_at)
       VALUES (?, ?, 'u1', 0, 'Verdan Concord', '#4ecdc4', ?, 3, 5000, 2400, 900, ?)`,
    `${id}_f1`, id, factionStatus, NOW);
  await run(`INSERT INTO game_factions (id, game_id, user_id, slot, name, color, status,
                                  senate_weight, metal, gold, science, joined_at)
       VALUES (?, ?, 'u2', 1, 'Kepler Reach', '#ff6a60', 'active', 2, 100, 100, 100, ?)`,
    `${id}_f2`, id, NOW);
}

// The game the watch will show: live, and the most recently touched.
await seedGame('gameone', 'The Long Siege');
// A second live game, also this player's. Its proposal is the one the
// watch must not be able to reach.
await seedGame('gametwo', 'Side Theatre');
await run(`UPDATE rooms SET updated_at = ? WHERE id = 'gametwo'`, NOW - 60000);

// ---- the ledger ------------------------------------------------------
// Twelve ticks of pools that rise by a known amount, with a known upkeep
// and one known spend, so the per-tick figure has a right answer rather
// than merely a plausible one.
const INCOME_METAL = 40, INCOME_GOLD = 25, INCOME_SCI = 12;
const UPKEEP_METAL = 6, UPKEEP_GOLD = 4;
let poolM = 1000, poolG = 500, poolS = 200;
for (let i = 0; i <= 12; i++) {
  const t = TICK - 12 + i;
  if (i > 0) {
    poolM += INCOME_METAL - UPKEEP_METAL;
    poolG += INCOME_GOLD - UPKEEP_GOLD;
    poolS += INCOME_SCI;
  }
  await run(`INSERT INTO faction_economy_ticks
        (game_id, faction_id, tick_number, pool_metal, pool_gold, pool_science,
         upkeep_metal, upkeep_gold, arrears_metal, arrears_gold, created_at_ms)
       VALUES ('gameone', 'gameone_f1', ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    t, poolM, poolG, poolS, i === 0 ? 0 : UPKEEP_METAL, i === 0 ? 0 : UPKEEP_GOLD,
    NOW - (12 - i) * 450000);
}

// ---- a bill in its voting window ------------------------------------
await run(`INSERT INTO senate_proposals
      (id, game_id, proposer_faction_id, kind, title, summary, status,
       proposed_at_tick, vote_opens_at_tick, vote_closes_at_tick)
     VALUES ('prop1', 'gameone', 'gameone_f2', 'sanction', 'Censure the Reach',
             'Trade sanctions for three ticks.', 'voting', ?, ?, ?)`,
  TICK - 2, TICK - 1, TICK + 4);
// One that has closed: listed nowhere, votable never.
await run(`INSERT INTO senate_proposals
      (id, game_id, proposer_faction_id, kind, title, summary, status,
       proposed_at_tick, vote_opens_at_tick, vote_closes_at_tick)
     VALUES ('prop_old', 'gameone', 'gameone_f2', 'trade', 'Old Business',
             'Already decided.', 'passed', ?, ?, ?)`, TICK - 20, TICK - 19, TICK - 10);
// The other game's bill, open and perfectly legal -- in its own game.
await run(`INSERT INTO senate_proposals
      (id, game_id, proposer_faction_id, kind, title, summary, status,
       proposed_at_tick, vote_opens_at_tick, vote_closes_at_tick)
     VALUES ('prop_other', 'gametwo', 'gametwo_f2', 'military', 'Rearm',
             'Not this watch business.', 'voting', ?, ?, ?)`, TICK - 2, TICK - 1, TICK + 4);

// ---------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------

const cardToken = await mintWidgetToken(env, 'u1', 'widget', 'card');
const wearToken = await mintWidgetToken(env, 'u1', 'watch', 'wear');

const GET = (token) => handleWearState(new Request('https://x/'), env, { params: { token } });
const VOTE = (token, body) => handleWearVote(
  new Request('https://x/', { method: 'POST', body: JSON.stringify(body) }),
  env, { params: { token } },
);

// ---------------------------------------------------------------------
// The scope boundary
// ---------------------------------------------------------------------

{
  const r = await GET(cardToken);
  check('a card token cannot read the watch state', r.status === 403,
    `got ${r.status}`);
}
{
  const r = await VOTE(cardToken, { proposalId: 'prop1', vote: 'yea' });
  const rows = (await db.prepare(`SELECT COUNT(*) AS n FROM senate_votes`).bind().first()).n;
  check('a card token cannot vote', r.status === 403 && rows === 0,
    `status ${r.status}, ${rows} vote rows`);
}
{
  const r = await GET('nosuchtokenatall');
  check('an unknown token is a 404, not a 500', r.status === 404, `got ${r.status}`);
}
{
  await db.prepare('UPDATE widget_tokens SET revoked_ms = ? WHERE token = ?')
    .bind(NOW, cardToken).run();
  const r = await GET(cardToken);
  check('a revoked token is refused', r.status === 404, `got ${r.status}`);
}

// ---------------------------------------------------------------------
// The state document
// ---------------------------------------------------------------------

const state = await (await GET(wearToken)).json();

check('the live game is the one shown', state.gameId === 'gameone' && state.state === 'live',
  JSON.stringify({ gameId: state.gameId, state: state.state }));
check('resources are the faction pools',
  state.resources.metal === 5000 && state.resources.credits === 2400
    && state.resources.science === 900,
  JSON.stringify(state.resources));

// Per tick, against the Economy tab's own numbers rather than against a
// constant typed in here: if the derivation ever changes, both move
// together and this keeps passing -- which is the point of sharing it.
const { series } = await economySeries(env, 'gameone', 'gameone_f1', TICK, 24);
const avg = economyAverages(series, 10);
check('per-tick income matches the Economy tab derivation',
  state.perTick.metal === Math.round(avg.income_metal * 10) / 10
    && state.perTick.gold === Math.round(avg.income_gold * 10) / 10
    && state.perTick.science === Math.round(avg.income_science * 10) / 10,
  `watch ${JSON.stringify(state.perTick)} vs tab ${JSON.stringify({
    m: avg.income_metal, g: avg.income_gold, s: avg.income_science })}`);
check('per-tick income is the seeded income, not the seeded net',
  state.perTick.metal === INCOME_METAL && state.perTick.gold === INCOME_GOLD,
  `expected +${INCOME_METAL}/+${INCOME_GOLD}, got ${state.perTick.metal}/${state.perTick.gold}`);
check('net per tick is income minus upkeep',
  state.perTick.netMetal === INCOME_METAL - UPKEEP_METAL
    && state.perTick.netGold === INCOME_GOLD - UPKEEP_GOLD,
  JSON.stringify({ netMetal: state.perTick.netMetal, netGold: state.perTick.netGold }));
check('the countdown carries server time, not the watch\'s',
  typeof state.now === 'number' && state.now > 0 && state.nextTickAt > state.now,
  JSON.stringify({ now: state.now, nextTickAt: state.nextTickAt }));

check('the open bill is listed and unvoted',
  state.senate.length === 1 && state.senate[0].id === 'prop1'
    && state.senate[0].myVote === null,
  JSON.stringify(state.senate));
check('a bill past its window is not listed',
  !state.senate.some(b => b.id === 'prop_old'), JSON.stringify(state.senate.map(b => b.id)));
check('another game\'s bill is not listed',
  !state.senate.some(b => b.id === 'prop_other'), JSON.stringify(state.senate.map(b => b.id)));
check('bills say how long is left in ticks, not an absolute tick',
  state.senate[0]?.closesIn === 4, String(state.senate[0]?.closesIn));

// ---------------------------------------------------------------------
// The vote
// ---------------------------------------------------------------------

{
  const r = await VOTE(wearToken, { proposalId: 'prop1', vote: 'yea' });
  const body = await r.json();
  const row = await db.prepare(
    `SELECT vote, weight FROM senate_votes WHERE proposal_id = 'prop1' AND faction_id = 'gameone_f1'`,
  ).bind().first();
  check('a wear token can vote, and the vote lands with its weight',
    r.status === 200 && row?.vote === 'yea' && Number(row?.weight) > 0,
    `status ${r.status}, row ${JSON.stringify(row)}`);
  check('the response carries the redrawn bill',
    body.bill?.id === 'prop1' && body.bill?.myVote === 'yea' && body.bill?.yea > 0,
    JSON.stringify(body.bill));
}
{
  // Changing your mind inside the window is allowed by castVoteCore, so
  // the watch must not end up with two rows for one faction.
  const r = await VOTE(wearToken, { proposalId: 'prop1', vote: 'nay' });
  const n = (await db.prepare(
    `SELECT COUNT(*) AS n FROM senate_votes WHERE proposal_id = 'prop1'`).bind().first()).n;
  const row = await db.prepare(
    `SELECT vote FROM senate_votes WHERE proposal_id = 'prop1'`).bind().first();
  check('changing a vote updates rather than duplicates',
    r.status === 200 && n === 1 && row.vote === 'nay', `status ${r.status}, ${n} rows`);
}
{
  const r = await VOTE(wearToken, { proposalId: 'prop_other', vote: 'yea' });
  const leaked = await db.prepare(
    `SELECT COUNT(*) AS n FROM senate_votes WHERE proposal_id = 'prop_other'`).bind().first();
  check('a vote cannot cross into the player\'s other game',
    r.status !== 200 && Number(leaked.n) === 0,
    `status ${r.status}, ${leaked.n} rows in the other game`);
}
{
  const r = await VOTE(wearToken, { proposalId: 'prop_old', vote: 'yea' });
  check('a closed bill is refused', r.status === 409, `got ${r.status}`);
}
{
  const r = await VOTE(wearToken, { proposalId: 'prop1', vote: 'maybe' });
  check('a vote that is not yea/nay/abstain is refused', r.status === 400, `got ${r.status}`);
}

// ---------------------------------------------------------------------
// The states that are not 'live'
// ---------------------------------------------------------------------

{
  await db.prepare(`UPDATE game_factions SET status = 'eliminated' WHERE id = 'gameone_f1'`).bind().run();
  // Now the OTHER live game should win the "which game" rule, exactly as
  // the widget card does -- so this also checks the watch inherits it.
  await db.prepare(`UPDATE rooms SET updated_at = ? WHERE id = 'gametwo'`).bind(NOW + 1000).run();
  const s = await (await GET(wearToken)).json();
  check('elimination hands the watch the player\'s other live game',
    s.gameId === 'gametwo' && s.state === 'live', JSON.stringify({ g: s.gameId, st: s.state }));

  await db.prepare(`UPDATE game_factions SET status = 'eliminated' WHERE id = 'gametwo_f1'`).bind().run();
  const s2 = await (await GET(wearToken)).json();
  check('an eliminated player gets no bills and no buttons',
    s2.state === 'eliminated' && s2.senate.length === 0 && s2.battles.length === 0,
    JSON.stringify({ state: s2.state, bills: s2.senate.length }));
  const r = await VOTE(wearToken, { proposalId: 'prop1', vote: 'yea' });
  check('an eliminated player cannot vote', r.status === 409, `got ${r.status}`);
}

console.log(bad === 0 ? '\nAll wear checks passed.' : `\n${bad} check(s) failed.`);
process.exit(bad === 0 ? 0 : 1);
