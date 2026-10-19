// ============================================================
// The end-of-game page's server half: GET /api/games/:id/ending.
//
// Seeds a small, fully-specified finished game (5 empires + a monster, 300
// ticks) whose every award has a known answer, then asserts the whole payload.
// The scenario is built to trip the traps production data actually has:
//
//   * faction_metrics.settlements is deliberately absurd (99): holdings must
//     come from game_settlements, not that column (prod's counts destroyed
//     settlements forever).
//   * game_ship_stats.kills is deliberately inflated (24 for a 4-kill hull):
//     kills must come from battle_participants.killer_*.
//   * a hull's low_hp_kills exceeds its real kills: last_stand is capped.
//   * the monster has the best hull by damage: it must win nothing.
//   * friendly fire is not a kill; a pact-only trade is not a trade; a market
//     fill that IS an accepted offer is not counted twice.
//   * the privacy rule: no email, display name or user id anywhere in the JSON.
//
// Also: 409 before the game is finished, 403 for strangers, 404 for unknown
// games, the series bound (<= 120 points incl. first and last) on a 6000-tick
// game, awards OMITTED when nothing real stands behind them, and the payload
// checked key-by-key against the contract text in src/multiplayer/endingTypes.ts.
//
// Run: npm run sim:ending     (from the repo root)
// ============================================================

import { readFileSync } from 'node:fs';
import { buildEnding, routes } from '../worker/ending.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { checkEndingShape, checkEndingInvariants } from './endingShape.mjs';

const CONTRACT = readFileSync('src/multiplayer/endingTypes.ts', 'utf8');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
// The seed is a read-model fixture: skip bodies/ships FK scaffolding.
DB.db.exec('PRAGMA foreign_keys = OFF');
const env = { DB };

function ins(table, row) {
  const cols = Object.keys(row);
  return DB.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .bind(...cols.map(c => row[c])).run();
}

// ---- people (every identifier below must stay OUT of the payload) ----------
const USERS = [
  ['usr_alice_001', 'alice.secret@example.test', 'AliceDisplayName'],
  ['usr_bob_002', 'bob.secret@example.test', 'BobDisplayName'],
  ['usr_cara_003', 'cara.secret@example.test', 'CaraDisplayName'],
  ['usr_obs_004', 'obs.secret@example.test', 'ObserverDisplayName'],
  ['usr_stranger_005', 'stranger.secret@example.test', 'StrangerDisplayName'],
];
for (const [id, email, display_name] of USERS) {
  await ins('users', { id, email, display_name, password_hash: 'x', created_at: 0 });
}

async function room(id, name, status, extra = {}) {
  await ins('rooms', { id, name, host_id: 'usr_alice_001', created_at: 0, updated_at: 0 });
  await ins('games', {
    id, status, map_seed: 's', created_at: 1_000, started_at: 1_000, tick_interval_ms: 60_000,
    current_tick: 300, ...extra,
  });
}
async function faction(game, key, slot, name, o = {}) {
  const id = `${game}:${key}`;
  await ins('game_factions', {
    id, game_id: game, slot, name, color: '#112233', color2: '#445566', emblem: 'star',
    joined_at: 0, status: 'active', metal: 0, gold: 0, science: 0, ...o,
  });
  return id;
}

// ============================================================================
// GAME 1: "game_one", completed at tick 300, won by B (engineering).
// ============================================================================
const G = 'game_one';
await room(G, 'The Test Zone', 'completed', {
  winner_faction_id: `${G}:B`, victory_type: 'engineering', completed_at: 1_000 + 3_600_000,
});
for (const u of ['usr_alice_001', 'usr_bob_002', 'usr_cara_003', 'usr_obs_004']) {
  await ins('room_members', { room_id: G, user_id: u, joined_at: 0 });
}
const A = await faction(G, 'A', 0, 'Alpha Combine', { user_id: 'usr_alice_001', gold: 100, science: 77.6, metal: 5 });
const B = await faction(G, 'B', 1, 'Bravo Union', { user_id: 'usr_bob_002', gold: 1200, science: 5, metal: 6 });
const C = await faction(G, 'C', 2, 'Charlie Pact', { user_id: 'usr_cara_003', gold: 40, science: 9, metal: 7 });
const D = await faction(G, 'D', 3, 'Delta Remnant', { status: 'eliminated', gold: 50 });
const E = await faction(G, 'E', 4, 'Echo Free State', { gold: 10 });
const M = await faction(G, 'mon', 900, 'The Leviathan', { status: 'monster', color2: null, emblem: null });

// -- per-tick metrics, ticks 1..300 (D only to 199). settlements = 99 on purpose.
const gold = { A: 'CASE WHEN t <= 150 THEN 5000 ELSE 100 END', B: '1200', C: 'CASE WHEN t = 77 THEN 9000 ELSE 40 END', D: '50', E: '10' };
const ships = { A: '10', B: '20 + t / 30', C: '5', D: '2', E: '3' };
for (const [k, id] of [['A', A], ['B', B], ['C', C], ['D', D], ['E', E]]) {
  await DB.exec(`
    WITH RECURSIVE n(t) AS (SELECT 1 UNION ALL SELECT t + 1 FROM n WHERE t < ${k === 'D' ? 199 : 300})
    INSERT INTO faction_metrics (game_id, tick_number, faction_id, metal, fuel, gold, science, ships, settlements)
    SELECT '${G}', t, '${id}', 0, 0, ${gold[k]}, t * 2, CAST(${ships[k]} AS INTEGER), 99 FROM n`);
}

// -- settlements: one row per settlement, owner fixed, [created, destroyed)
const SETTLEMENTS = [
  [A, 'b1', 0, null], [A, 'b2', 50, null], [A, 'b2', 60, null] /* a 2nd on the same world */, [A, 'b3', 10, 120],
  [B, 'b4', 0, null], [B, 'b5', 20, null], [B, 'b6', 100, null], [B, 'b7', 150, null],
  [C, 'b8', 0, null], [D, 'b9', 0, 199], [E, 'b10', 0, null],
];
let sid = 0;
for (const [owner, body, created, destroyed] of SETTLEMENTS) {
  await ins('game_settlements', {
    id: `st${++sid}`, game_id: G, body_id: `${G}:${body}`, owner_faction_id: owner, type: 'city',
    name: 'x', hp: destroyed == null ? 10 : 0, hp_max: 10, created_at_tick: created, destroyed_at_tick: destroyed,
  });
}

// -- alive hulls (hp > 0) per empire; dead ones must not count
let shid = 0;
for (const [owner, alive, dead] of [[A, 6, 4], [B, 9, 0], [C, 5, 0], [D, 2, 1], [E, 3, 0]]) {
  for (let i = 0; i < alive + dead; i++) {
    await ins('game_ships', {
      id: `sh${++shid}`, game_id: G, owner_faction_id: owner, name: 'h', ship_class: 'corvette',
      parent_body_id: 'x', orbit_rp: 1, orbit_ra: 1, orbit_omega: 0, orbit_m0: 0, orbit_epoch: 0,
      fuel: 1, fuel_max: 1, built_at_tick: 0, hp: i < alive ? 10 : 0,
    });
  }
}

// -- techs (tracks with levels). B and C tie on 30; C got there first.
const TECHS = [
  [A, 'propulsion', 5, 100], [A, 'armor', 5, 110], [A, 'weapons', 4, 120],
  [B, 'propulsion', 10, 240], [B, 'armor', 10, 245], [B, 'weapons', 10, 250],
  [C, 'propulsion', 10, 150], [C, 'armor', 10, 180], [C, 'weapons', 10, 200],
];
for (const [f, tech, level, done] of TECHS) {
  await ins('faction_techs', { game_id: G, faction_id: f, tech_id: tech, status: 'completed', started_at_tick: 1, completed_at_tick: done, level });
}

// -- chronicle: hulls built, the elimination of D (eliminated_at_tick left NULL
//    on purpose: the page falls back to the chronicle), the victory line.
let cid = 0;
const chron = (kind, tick, actor, payload = {}) => ins('chronicle_entries', {
  id: `c${++cid}`, game_id: G, tick_number: tick, kind, actor_faction_id: actor,
  payload: JSON.stringify(payload), created_at_ms: 0,
});
for (const [f, n] of [[A, 12], [B, 40], [C, 7], [D, 2]]) for (let i = 0; i < n; i++) await chron('ship_built', i + 1, f);
await chron('tech_advanced', 5, A);   // other kinds must not be counted as hulls
await chron('faction_eliminated', 200, D, { faction_name: 'Delta Remnant' });
await chron('victory', 300, B, { victoryType: 'engineering', detail: 'Dyson Sphere complete' });
await ins('game_megastructures', { body_id: G + ':m1', game_id: G, kind: 'null_field', status: 'complete', cost_metal: 1, cost_credits: 1, founded_by_faction_id: A, founded_at_tick: 100, completed_at_tick: 150 });
await ins('game_megastructures', { body_id: G + ':m2', game_id: G, kind: 'weapons_station', status: 'complete', cost_metal: 1, cost_credits: 1, founded_by_faction_id: null, founded_at_tick: 10, completed_at_tick: 10, ancient: 1 });
await ins('chronicle_entries', { id: 'cpact', game_id: G, tick_number: 30, kind: 'treaty_signed', actor_faction_id: A, target_faction_id: B,
  payload: JSON.stringify({ kind: 'defense_pact' }), created_at_ms: 0 });

// -- senate: passed counts C3 A1 B1; failed/debating never count
let pid = 0;
const bill = (f, status) => ins('senate_proposals', {
  id: `p${++pid}`, game_id: G, proposer_faction_id: f, kind: 'trade', title: 't', summary: 's',
  status, proposed_at_tick: 1, vote_opens_at_tick: 2, vote_closes_at_tick: 3,
});
for (const [f, st, n] of [[C, 'passed', 3], [A, 'passed', 1], [B, 'passed', 1], [B, 'failed', 5], [A, 'debating', 2]]) {
  for (let i = 0; i < n; i++) await bill(f, st);
}

// -- wars: A declared 2, B declared 1 (+4 seeded, +1 pact_broken, which don't count)
let wid = 0;
const war = (by, other, origin) => ins('game_wars', { id: `w${++wid}`, game_id: G, faction_a: by, faction_b: other, declared_by: by, declared_at_tick: 1, origin });
await war(A, C, 'declared'); await war(A, D, 'declared'); await war(B, C, 'declared'); await war(B, D, 'pact_broken');
await war(B, A, 'seeded'); await war(C, B, 'seeded'); await war(E, A, 'seeded'); await war(E, B, 'seeded');

// -- trades. goods deals: A-B x3, B-C x1; pact-only C-D; open A-C; declined A-D.
//    market: a fill that IS accepted offer o4 (no double count) + a standalone
//    E<->B fill with no offer behind it.
let oid = 0;
const offer = (p, r, status, goods) => ins('trade_offers', {
  id: `o${++oid}`, game_id: G, proposer_faction_id: p, responder_faction_id: r, status,
  offer_gold: goods ? 100 : 0, created_at_tick: 1, created_at_ms: 0,
});
await offer(A, B, 'accepted', true); await offer(A, B, 'accepted', true); await offer(B, A, 'accepted', true);
await offer(B, C, 'accepted', true);            // o4
await offer(C, D, 'accepted', false);           // pact only
await offer(A, C, 'open', true); await offer(A, D, 'declined', true);
await ins('market_fills', { id: 'f1', game_id: G, post_id: 'mp1', poster_faction_id: B, taker_faction_id: C, trade_offer_id: 'o4', at_tick: 5, at_ms: 0 });
await ins('market_fills', { id: 'f2', game_id: G, post_id: 'mp2', poster_faction_id: E, taker_faction_id: B, trade_offer_id: null, at_tick: 6, at_ms: 0 });

// -- battles. See the header for the traps; names and numbers are chosen so each
//    hull award has a distinct, checkable answer.
const battle = (id, body, started, ended, shots, lost) => ins('battles', {
  id, game_id: G, body_id: `${G}:${body}`, body_name: body, started_tick: started, last_fire_tick: ended,
  ended_tick: ended, started_at_ms: 0, shots, ships_lost: lost, settlements_lost: 0, status: 'ended',
});
await battle('bt1', 'b3', 100, 130, 500, 8);   // A's b3 settlement dies at tick 120, inside it
await battle('bt2', 'b4', 200, 210, 80, 2);
await battle('bt3', 'b5', 220, 230, 120, 2);
await battle('bt4', 'b6', 240, 241, 10, 0);     // nobody died: never "biggest"
const part = (battle_id, ship_id, faction_id, o = {}) => ins('battle_participants', {
  battle_id, ship_id, faction_id, ship_name: ship_id, ship_class: 'frigate', first_tick: 1, last_tick: 1, ...o,
});
const died = (battle_id, ship_id, faction_id, killerShip, killerFaction) =>
  part(battle_id, ship_id, faction_id, { died_tick: 5, killer_ship_id: killerShip, killer_faction_id: killerFaction });
// H1=A 'Alpha One'; H2=B 'Bravo Two'; H3=C 'Charlie Three'; H4=A 'Alpha Four'; Hm=monster
await part('bt1', 'H1', A, { captain_name: 'Capt Ahab', last_tick: 110 });
await part('bt2', 'H2', B, { captain_name: 'Old Captain', last_tick: 205 });
await part('bt3', 'H2', B, { captain_name: 'Capt Beta', last_tick: 225 });
await part('bt1', 'H3', C);
await died('bt1', 'v1', C, 'H1', A); await died('bt1', 'v2', C, 'H1', A); await died('bt1', 'v3', C, 'H1', A);
await died('bt1', 'v4', D, 'H2', B); await died('bt1', 'v5', D, 'H2', B);
await died('bt1', 'v6', A, 'H3', C);
await died('bt1', 'v10', A, 'H4', A);            // friendly fire: nobody's kill
await died('bt1', 'v11', M, 'H1', A);            // the monster's hull: a real kill for A
await died('bt2', 'v7', A, 'H2', B); await died('bt2', 'v8', E, 'H2', B);
await died('bt3', 'v9', B, 'H3', C); await died('bt3', 'v12', D, 'H2', B);
const stat = (ship_id, faction_id, name, cls, o) => ins('game_ship_stats', {
  game_id: G, ship_id, faction_id, ship_name: name, ship_class: cls, ...o,
});
await stat('H1', A, 'Alpha One', 'frigate', { kills: 24, damage_dealt: 900, damage_absorbed: 50, low_hp_kills: 3 });
await stat('H2', B, 'Bravo Two', 'destroyer', { kills: 9, damage_dealt: 700, damage_absorbed: 2000, low_hp_kills: 1 });
await stat('H3', C, 'Charlie Three', 'corvette', { kills: 99, damage_dealt: 1200, damage_absorbed: 100, low_hp_kills: 5 });
await stat('H4', A, 'Alpha Four', 'corvette', { damage_dealt: 100 });
// 30 more hulls in C's fleet, each out-damaging every other empire's best: the
// top-N of hulls is all C, so the runner-up must still be found (A's 900).
for (let i = 0; i < 30; i++) await stat(`HF${i}`, C, `Filler ${i}`, 'corvette', { damage_dealt: 1100 });
await stat('Hm', M, 'Leviathan Maw', null, { kills: 500, damage_dealt: 99_999, damage_absorbed: 99_999, low_hp_kills: 50 });

// ============================================================================
// GAME 2: "longgame": 6000 ticks, 2 empires, NOTHING happened but economy.
// Proves the series bound and that awards with no data are omitted.
// ============================================================================
const L = 'longgame';
await room(L, 'The Long Quiet', 'completed', {
  current_tick: 6000, winner_faction_id: `${L}:X`, victory_type: 'domination', completed_at: null, started_at: null,
});
await ins('room_members', { room_id: L, user_id: 'usr_cara_003', joined_at: 0 });
const X = await faction(L, 'X', 0, 'Xenon', { user_id: 'usr_cara_003', gold: 700 });
const Y = await faction(L, 'Y', 1, 'Yttrium', { gold: 20 });
for (const [id, mult] of [[X, 7], [Y, 3]]) {
  await DB.exec(`
    WITH RECURSIVE n(t) AS (SELECT 1 UNION ALL SELECT t + 1 FROM n WHERE t < 6000)
    INSERT INTO faction_metrics (game_id, tick_number, faction_id, metal, fuel, gold, science, ships, settlements)
    SELECT '${L}', t, '${id}', 0, 0, t * ${mult}, t, 1, 1 FROM n`);
}
await ins('game_settlements', { id: 'lx', game_id: L, body_id: `${L}:w1`, owner_faction_id: X, type: 'city', name: 'x', hp: 5, hp_max: 5, created_at_tick: 0 });
await ins('game_settlements', { id: 'ly', game_id: L, body_id: `${L}:w2`, owner_faction_id: Y, type: 'city', name: 'x', hp: 5, hp_max: 5, created_at_tick: 0 });

// ============================================================================
// GAME 4: "tl_game": the timeline of a war story. 1000 ticks, five empires, a
// Leviathan (a monster seat) and an observer seat, and the traps: a lead that
// did not last, a monster as an actor, a pact-breaking war that also appears
// as a treaty_broken row, and four battles: one with a house replay link
// already, one with NO replay data, one with no link at all (to be minted) and
// one whose house link was revoked.
// ============================================================================
const T = 'tl_game';
await room(T, 'The Long Story', 'completed', {
  current_tick: 1000, winner_faction_id: `${T}:W`, victory_type: 'chancellor', completed_at: 5_000_000,
});
await ins('room_members', { room_id: T, user_id: 'usr_bob_002', joined_at: 0 });
const tf = {};
for (const [k, slot, name, extra] of [
  ['R', 0, 'Red Republic', { user_id: 'usr_bob_002', status: 'eliminated' }],
  ['W', 1, 'Wren Dominion', { user_id: 'usr_alice_001' }],
  ['G', 2, 'Green League', { status: 'eliminated' }],
  ['B', 3, 'Blue Syndicate', {}],
  ['P', 4, 'Pauper Isles', { status: 'eliminated' }],
  ['mon', 900, 'The Leviathan', { status: 'monster', color2: null, emblem: null }],
  ['obs', 901, 'Quiet Observer', { status: 'observer' }],
]) tf[k] = await faction(T, k, slot, name, extra);

// worlds: [owner, body, created, destroyed]. Leadership: R leads first (not a
// "change"); W passes it at 100 but G takes it at 140 and W retakes it at 160
// (neither of those two held 5% = 50 ticks); W's lead at 160 lasts; B's at 500 too.
const TS = [
  ...[0, 10, 20, 30].map((t, i) => ['R', `r${i}`, t, 700]),
  ['W', 'w0', 0, null], ['W', 'w1', 40, null], ['W', 'w2', 60, null], ['W', 'w3', 80, null], ['W', 'w4', 100, null],
  ['W', 'w5', 160, null], ['W', 'w6', 160, null], ['W', 'w7', 160, null],
  ['G', 'g0', 0, 900], ...[1, 2, 3, 4, 5, 6].map(i => ['G', `g${i}`, 140, 900]),
  ['B', 'b0', 0, null], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => ['B', `b${i}`, 500, null]),
  ['P', 'p0', 0, 300], ['P', 'p1', 50, 300],
];
let tsid = 0;
for (const [o, body, created, destroyed] of TS) {
  await ins('game_settlements', {
    id: `ts${++tsid}`, game_id: T, body_id: `${T}:${body}`, owner_faction_id: tf[o], type: 'city', name: 'x',
    hp: destroyed == null ? 10 : 0, hp_max: 10, created_at_tick: created, destroyed_at_tick: destroyed,
  });
}

let tcid = 0;
const tchron = (kind, tick, actor, target, payload = {}) => ins('chronicle_entries', {
  id: `tc${++tcid}`, game_id: T, tick_number: tick, kind, actor_faction_id: actor ? tf[actor] : null,
  target_faction_id: target ? tf[target] : null, payload: JSON.stringify(payload), created_at_ms: tcid,
});
await tchron('game_started', 0, null, null, { factions: [] });
// the earliest hull lost is the Leviathan's; the first EMPIRE hull (R, by W) is at tick 40
await tchron('ship_destroyed', 3, 'mon', null, { body_name: 'Titan', ship_class: 'corvette', killer_faction_id: tf.W });
await tchron('ship_destroyed', 40, 'R', null, { body_name: 'Mars', ship_class: 'frigate', killer_faction_id: tf.W });
await tchron('ship_destroyed', 41, 'G', null, { body_name: 'Io', ship_class: 'corvette', killer_faction_id: tf.R });
await tchron('war_declared', 60, 'R', 'W', { broke_pacts: [] });
await tchron('war_declared', 62, 'mon', 'W', { broke_pacts: [] });                // a monster never declares
await tchron('war_declared', 440, 'B', 'W', { broke_pacts: ['nap'] });           // pact-breaking war, just before the big battle
await tchron('treaty_broken', 440, 'B', 'W', { kind: 'nap' });                   // the same event again: told once
await tchron('war_declared', 446, 'B', 'W', { broke_pacts: ['nap'] });           // the SAME betrayal again 6 ticks later: too close, same empires, same kind
await tchron('treaty_broken', 520, 'G', 'R', { kind: 'defense_pact' });
await tchron('faction_eliminated', 300, 'P', null, { faction_name: 'Pauper Isles' });
await tchron('faction_eliminated', 700, 'R', null, { faction_name: 'Red Republic' });
await tchron('faction_eliminated', 900, 'G', null, { faction_name: 'Green League' });
await tchron('settlement_destroyed', 700, 'R', null, { killer_faction_id: tf.W });
await tchron('settlement_seized', 900, 'B', 'G', { body_name: 'x' });
await tchron('victory', 1000, 'W', null, { victoryType: 'chancellor', detail: 'Wren elected Supreme Chancellor' });
let tpid = 0;
const tbill = (g, kind, status, tick, proposer, payload) => ins('senate_proposals', {
  id: `tp${++tpid}`, game_id: g, proposer_faction_id: proposer, kind, title: 't', summary: 's', status,
  payload: JSON.stringify(payload), proposed_at_tick: tick - 5, vote_opens_at_tick: tick - 3, vote_closes_at_tick: tick, resolved_at_tick: tick,
});
await tbill(T, 'war_authorization', 'passed', 420, tf.W, { target_faction_id: tf.B });
await tbill(T, 'war_authorization', 'failed', 430, tf.B, { target_faction_id: tf.W });   // failed bills are not history
await tbill(T, 'slider_law', 'passed', 100, tf.W, { slider_id: 'x' });                    // a slider is not a pivotal bill
await tbill(T, 'chancellor_vote', 'passed', 995, tf.W, { candidate_faction_id: tf.W });  // the winning vote: the victory covers it

const tbattle = (id, body, started, last, shots, lost, victor) => ins('battles', {
  id, game_id: T, body_id: `${T}:${body}`, body_name: body, started_tick: started, last_fire_tick: last, ended_tick: last,
  started_at_ms: 0, shots, ships_lost: lost, settlements_lost: 0, status: 'ended', victor_faction_id: victor ? tf[victor] : null,
});
await tbattle('tb_big', 'Mars', 450, 480, 900, 50, 'W');              // top 3, has a house link
await tbattle('tb_noframes', 'Venus', 800, 820, 400, 40, 'B');        // top 3, NOTHING recorded to replay
await tbattle('tb_mid', 'Europa', 650, 690, 300, 30, 'W');            // top 3, replayable, no house link (a player's own only)
await tbattle('tb_small', 'Luna', 200, 210, 50, 20, 'W');             // not top 3, not before an elimination: not a moment
await tbattle('tb_laststand', 'Pluto', 880, 895, 100, 30, 'B');        // G's last stand; replayable; house link REVOKED
let tpart = 0;
for (const [b, who, n] of [['tb_big', 'R', 2], ['tb_big', 'W', 1], ['tb_big', 'B', 1], ['tb_noframes', 'G', 2], ['tb_noframes', 'B', 1],
  ['tb_mid', 'R', 2], ['tb_mid', 'W', 1], ['tb_laststand', 'G', 2], ['tb_small', 'B', 1]]) {
  for (let i = 0; i < n; i++) {
    await ins('battle_participants', { battle_id: b, ship_id: `tps${++tpart}`, faction_id: tf[who], first_tick: 1, last_tick: 2, died_tick: 2 });
  }
}
for (const [b, frames] of [['tb_big', 4], ['tb_mid', 5], ['tb_small', 2], ['tb_laststand', 3]]) {   // tb_noframes has none
  for (let i = 0; i < frames; i++) await ins('battle_ticks', { battle_id: b, tick_number: i + 1, seq: i, roster: '[]', shot_log: '[]' });
}
const shareRow = (token, battle_id, created_by, revoked) => ins('battle_shares', {
  token, battle_id, game_id: T, created_by, created_at_ms: 1, revoked_at_ms: revoked ? 2 : null,
});
await shareRow('HOUSE_BIG_TOKEN_0001', 'tb_big', null, false);
await shareRow('HOUSE_SMALL_TOKEN_01', 'tb_small', null, false);
await shareRow('REVOKED_HOUSE_TOKEN1', 'tb_laststand', null, true);
await shareRow('USER_MADE_TOKEN_0001', 'tb_mid', 'usr_alice_001', false);   // a player's own link: not the house's

// ============================================================================
// GAME 5: "tl_world": the timeline of the world's own events: a Leviathan, a
// sun gate, a Dyson Sphere, a megastructure, a discovery, the Senate and pacts.
// 500 ticks. A monster, an observer and a vacated actor appear as actors and
// must never become a timeline actor.
// ============================================================================
const W5 = 'tl_world';
await room(W5, 'The Wide World', 'completed', {
  current_tick: 500, winner_faction_id: `${W5}:W`, victory_type: 'engineering', completed_at: 5_000_000,
});
await ins('room_members', { room_id: W5, user_id: 'usr_alice_001', joined_at: 0 });
const wf = {};
for (const [k, slot, name, extra] of [
  ['W', 0, 'Wren Dominion', { user_id: 'usr_alice_001' }],
  ['G', 1, 'Green League', {}],
  ['B', 2, 'Blue Syndicate', {}],
  ['mon', 900, 'The Leviathan', { status: 'monster', color2: null, emblem: null }],
  ['obs', 901, 'Quiet Observer', { status: 'observer' }],
]) wf[k] = await faction(W5, k, slot, name, extra);
let wcid = 0;
const wchron = (kind, tick, actor, target, payload = {}) => ins('chronicle_entries', {
  id: `wc${++wcid}`, game_id: W5, tick_number: tick, kind, actor_faction_id: actor ? wf[actor] : null,
  target_faction_id: target ? wf[target] : null, payload: JSON.stringify(payload), created_at_ms: wcid,
});
await wchron('game_started', 0, null, null, {});
await wchron('sun_gate_opened', 180, null, null, { gate: 'Centauri Gate', system: 'Centauri', index: 0 });
await wchron('gate_transit', 190, 'B', null, { sun_gate: true, first: true, to_system: 'Centauri' });
await wchron('gate_transit', 191, 'W', null, { sun_gate: true, first: false });
await wchron('kaiju_revealed', 260, null, null, { body_name: 'MK 2' });
await wchron('world_obliterated', 300, 'mon', null, { body_name: 'MK 2', cause: 'kaiju', settlements_lost: 2 });
await wchron('kaiju_dead', 330, null, null, { body_name: 'Weywot', killer_faction_name: 'Wren Dominion' });
await wchron('dyson_initiated', 250, 'W', null, { target_total: 40000 });
await wchron('dyson_milestone', 400, 'W', null, { pct: 25 });
await wchron('secret_discovered', 70, 'G', null, { kind: 'ancient_capital', body_name: 'Aya' });
await wchron('secret_discovered', 90, 'B', null, { kind: 'deep_cache', body_name: 'Ixion', metal: 10000, credits: 10000 });
await wchron('secret_discovered', 80, 'obs', null, { kind: 'ancient_capital', body_name: 'Nowhere' });   // an observer's: ignored
await wchron('treaty_signed', 30, 'W', 'G', { kind: 'nap' });
await wchron('treaty_signed', 120, 'W', 'B', { kind: 'defense_pact' });
await wchron('victory', 500, 'W', null, { victoryType: 'engineering', detail: 'Dyson Sphere complete' });
await tbill(W5, 'chancellor_vote', 'passed', 200, wf.G, { candidate_faction_id: wf.G });
await tbill(W5, 'trade_embargo', 'passed', 455, wf.obs, { target_faction_id: wf.B });      // an observer's bill: ignored
await ins('game_bodies', { id: `${W5}:mega1`, game_id: W5, template_id: 'x', name: 'Ceres Foundry', type: 'asteroid', radius: 1, mu: 1, color: '#fff' });
await ins('game_megastructures', { body_id: `${W5}:mega1`, game_id: W5, kind: 'weapons_station', status: 'complete', cost_metal: 1, cost_credits: 1, founded_by_faction_id: wf.W, founded_at_tick: 300, completed_at_tick: 350 });
await ins('game_megastructures', { body_id: `${W5}:mega2`, game_id: W5, kind: 'weapons_station', status: 'complete', cost_metal: 1, cost_credits: 1, founded_by_faction_id: null, founded_at_tick: 10, completed_at_tick: 10, ancient: 1 });

// ============================================================================
// GAME 6: "tl_lead": leadership in worlds held. X leads from tick 10 (the first
// leader replaced nobody), Y passes X at 100 but only for 40 ticks (< 5% of the
// game), X retakes it at 140 and keeps it, Z passes at 500 and keeps it.
// ============================================================================
const LD = 'tl_lead';
await room(LD, 'Lead Changes', 'completed', { current_tick: 1000, winner_faction_id: `${LD}:Z`, victory_type: 'domination', completed_at: 5_000_000 });
await ins('room_members', { room_id: LD, user_id: 'usr_alice_001', joined_at: 0 });
const lf = {};
for (const [k, slot, name] of [['X', 0, 'Xan'], ['Y', 1, 'Yth'], ['Z', 2, 'Zor']]) lf[k] = await faction(LD, k, slot, name, k === 'X' ? { user_id: 'usr_alice_001' } : {});
const LS = [
  ['X', 'x0', 0], ['X', 'x1', 10], ['X', 'x2', 20], ['X', 'x3', 30], ['X', 'x4', 140], ['X', 'x5', 140],
  ['Y', 'y0', 0], ['Y', 'y1', 40], ['Y', 'y2', 60], ['Y', 'y3', 80], ['Y', 'y4', 100],
  ['Z', 'z0', 0], ...[1, 2, 3, 4, 5, 6, 7].map(i => ['Z', `z${i}`, 500]),
];
let lsid = 0;
for (const [o, body, created] of LS) {
  await ins('game_settlements', { id: `ls${++lsid}`, game_id: LD, body_id: `${LD}:${body}`, owner_faction_id: lf[o], type: 'city', name: 'x', hp: 10, hp_max: 10, created_at_tick: created });
}

// ============================================================================
// GAME 3: "livegame": still being played.
// ============================================================================
await room('livegame', 'Still Going', 'active');
await ins('room_members', { room_id: 'livegame', user_id: 'usr_alice_001', joined_at: 0 });
await faction('livegame', 'A', 0, 'Live A', { user_id: 'usr_alice_001' });

// ============================================================================
// Assertions
// ============================================================================
console.log('-- access --');
const alice = 'usr_alice_001';
const live = await buildEnding(env, 'livegame', alice);
eq('unfinished game: 409 not_finished (member)', [live.error?.status, live.error?.code], [409, 'not_finished']);
const liveStranger = await buildEnding(env, 'livegame', 'usr_stranger_005');
eq('unfinished game, stranger: membership is checked first (403)', liveStranger.error?.status, 403);
const missing = await buildEnding(env, 'nosuchgame', alice);
eq('unknown game: 404', missing.error?.status, 404);
const stranger = await buildEnding(env, G, 'usr_stranger_005');
eq('finished game, non-member: 403', [stranger.error?.status, stranger.error?.code], [403, 'not_a_member']);
const anon = await buildEnding(env, G, null);
eq('no viewer at all: 403', anon.error?.status, 403);

const p = await buildEnding(env, G, alice);
check('member of a finished game gets a payload', !p.error, p.error);
const obs = await buildEnding(env, G, 'usr_obs_004');
check('a room member with no empire (observer) may read it', !obs.error && obs.factions.every(f => !f.isMe), obs.error);

console.log('-- HTTP route --');
const route = routes[0];
check('route is GET /api/games/:id/ending, auth required',
  route.method === 'GET' && route.auth === 'required'
  && route.pattern.test('/api/games/game_one/ending') && !route.pattern.test('/api/games/game_one/ending/x'));
const call = (gameId, userId) => route.handle(new Request('https://x/'), env, { params: { gameId }, session: { user_id: userId } });
let res = await call('livegame', alice);
eq('HTTP 409 + code body', [res.status, (await res.json()).code], [409, 'not_finished']);
res = await call(G, 'usr_stranger_005');
eq('HTTP 403 for a stranger', res.status, 403);
res = await call('nosuchgame', alice);
eq('HTTP 404 for an unknown game', res.status, 404);
res = await call(G, alice);
check('HTTP 200, JSON, private cache', res.status === 200
  && /application\/json/.test(res.headers.get('content-type'))
  && /private/.test(res.headers.get('cache-control') ?? ''));
const viaHttp = await res.json();
eq('HTTP body equals buildEnding', viaHttp, JSON.parse(JSON.stringify(p)));

console.log('-- contract --');
const shapeErrs = checkEndingShape(p, CONTRACT);
check('payload conforms to src/multiplayer/endingTypes.ts', shapeErrs.length === 0, shapeErrs.slice(0, 8));
const invErrs = checkEndingInvariants(p);
check('payload invariants hold', invErrs.length === 0, invErrs.slice(0, 8));
const s2 = checkEndingShape({ ...p, extra: 1 }, CONTRACT);
check('shape check catches a stray key', s2.some(e => /extra/.test(e)));
const s3 = checkEndingShape({ ...p, game: { ...p.game, name: undefined } }, CONTRACT);
check('shape check catches a missing key', s3.some(e => /name/.test(e)));
const s4 = checkEndingShape({ ...p, factions: [{ ...p.factions[0], place: '1' }] }, CONTRACT);
check('shape check catches a wrong type', s4.some(e => /place/.test(e)));

console.log('-- privacy --');
const text = JSON.stringify(p) + JSON.stringify(obs) + JSON.stringify(await buildEnding(env, L, 'usr_cara_003'));
const leaks = [...USERS.flat(), 'secret', 'example.test', 'DisplayName', 'usr_', 'password']
  .filter(needle => text.includes(needle));
check('no email, display name or user id anywhere in the JSON', leaks.length === 0, leaks);

console.log('-- game --');
eq('game header', [p.game.id, p.game.name, p.game.victoryType, p.game.winnerFactionId, p.game.victoryDetail],
  [G, 'The Test Zone', 'engineering', B, 'Dyson Sphere complete']);
eq('ticks and timing', [p.game.currentTick, p.game.tickIntervalMs, p.game.startedAtMs, p.game.completedAtMs, p.game.durationMs],
  [300, 60000, 1000, 3_601_000, 3_600_000]);
eq('players = empires with a human; empires excludes the monster', [p.game.players, p.game.empires], [3, 5]);

console.log('-- standings --');
eq('place order: winner, then holdings, ships', p.factions.map(f => f.id), [B, A, C, E, D]);
eq('places are 1..n', p.factions.map(f => f.place), [1, 2, 3, 4, 5]);
check('the monster is not an empire', !p.factions.some(f => f.id === M));
eq('isWinner only B', p.factions.filter(f => f.isWinner).map(f => f.id), [B]);
eq('isMe only for the caller (A)', p.factions.filter(f => f.isMe).map(f => f.id), [A]);
const by = Object.fromEntries(p.factions.map(f => [f.id, f]));
eq('final A', by[A].final, { holdings: 2, ships: 6, techs: 14, credits: 100, science: 78, metal: 5 });
eq('final B', by[B].final, { holdings: 4, ships: 9, techs: 30, credits: 1200, science: 5, metal: 6 });
eq('final D (eliminated): no worlds, 1 hull-less... 2 live hulls', [by[D].final.holdings, by[D].final.ships], [0, 2]);
eq('peak A: 3 worlds (b1,b2,b3 at once, not the 99), 5000 credits', [by[A].peak.holdings, by[A].peak.credits], [3, 5000]);
eq('peak ships B = 30 (20 + 300/30)', by[B].peak.ships, 30);
eq('D eliminated: status and the chronicle tick (column was NULL)', [by[D].finalStatus, by[D].eliminatedAtTick], ['eliminated', 200]);
eq('active empires have no eliminatedAtTick', [by[A].finalStatus, by[A].eliminatedAtTick], ['active', null]);
eq('look carried over', [by[A].name, by[A].color, by[A].color2, by[A].emblem], ['Alpha Combine', '#112233', '#445566', 'star']);
eq('totals A', by[A].totals, { kills: 4, shipsLost: 3, damageDealt: 1000, shipsBuilt: 12, trades: 3, billsPassed: 1, warsDeclared: 2 });
eq('totals B', by[B].totals, { kills: 5, shipsLost: 1, damageDealt: 700, shipsBuilt: 40, trades: 5, billsPassed: 1, warsDeclared: 1 });
eq('totals C', by[C].totals, { kills: 2, shipsLost: 3, damageDealt: 34_200, shipsBuilt: 7, trades: 1, billsPassed: 3, warsDeclared: 0 });
eq('totals D', by[D].totals, { kills: 0, shipsLost: 3, damageDealt: 0, shipsBuilt: 2, trades: 0, billsPassed: 0, warsDeclared: 0 });
eq('totals E (standalone market fill counts once)', [by[E].totals.trades, by[E].totals.shipsLost], [1, 1]);

console.log('-- awards --');
const aw = Object.fromEntries(p.awards.map(a => [a.id, a]));
eq('awards in contract order', p.awards.map(a => a.id),
  ['warmonger', 'ace', 'heavy_hitter', 'iron_wall', 'last_stand', 'instigator', 'landlord', 'treasurer', 'scholar', 'shipwright', 'merchant', 'statesman']);
const row = (a) => a && [a.factionId, a.value, a.runnerUp?.factionId, a.runnerUp?.value];
eq('warmonger: B 5 kills (friendly fire not counted), runner-up A 4', row(aw.warmonger), [B, 5, A, 4]);
eq('ace: Bravo Two 5 real kills (not the stat column), runner-up Alpha One 4', row(aw.ace), [B, 5, A, 4]);
eq('ace ship carries the latest captain', aw.ace.ship, { name: 'Bravo Two', shipClass: 'destroyer', captainName: 'Capt Beta' });
eq('heavy_hitter: Charlie Three 1200 (the monster\'s 99999 is excluded)', row(aw.heavy_hitter), [C, 1200, A, 900]);
eq('heavy_hitter ship (no captain on record -> null)', aw.heavy_hitter.ship, { name: 'Charlie Three', shipClass: 'corvette', captainName: null });
eq('iron_wall: Bravo Two 2000, runner-up from another empire', row(aw.iron_wall), [B, 2000, C, 100]);
eq('last_stand: Alpha One 3; Charlie\'s 5 is capped at its 2 real kills', row(aw.last_stand), [A, 3, C, 2]);
eq('instigator: A 2 wars declared, runner-up B 1', row(aw.instigator), [A, 2, B, 1]);
eq('landlord: B 4 worlds at once, runner-up A 3', row(aw.landlord), [B, 4, A, 3]);
eq('treasurer: C 9000 at tick 77, runner-up A 5000', row(aw.treasurer), [C, 9000, A, 5000]);
eq('scholar: C and B tie on 30 levels; C finished first', row(aw.scholar), [C, 30, B, 30]);
eq('shipwright: B 40, runner-up A 12', row(aw.shipwright), [B, 40, A, 12]);
eq('merchant: B 5 trades, runner-up A 3', row(aw.merchant), [B, 5, A, 3]);
eq('statesman: C 3 bills; A and B tie on 1, better place first', row(aw.statesman), [C, 3, B, 1]);
check('hull awards name a ship, empire awards do not', ['ace', 'heavy_hitter', 'iron_wall', 'last_stand'].every(i => aw[i].ship) && !aw.landlord.ship);

console.log('-- series --');
const S = p.series;
check('<= 120 points', S.ticks.length <= 120, S.ticks.length);
eq('first and last tick kept', [S.ticks[0], S.ticks.at(-1)], [1, 300]);
check('every curve is aligned to ticks', ['holdings', 'ships', 'credits', 'science'].every(k =>
  [A, B, C, D, E].every(f => S[k][f].length === S.ticks.length)));
const idx = (t) => S.ticks.indexOf(t);
eq('credits: A 5000 until 150, then 100', [S.credits[A][idx(150)], S.credits[A][idx(153)]], [5000, 100]);
eq('credits: the single-tick spike at 77 is not on a sampled tick, but peak has it', [S.ticks.includes(77), by[C].peak.credits], [false, 9000]);
eq('science = 2 x tick', [S.science[A][idx(150)], S.science[B][idx(300)]], [300, 600]);
eq('holdings come from settlements: A 3 at tick 99, 2 at tick 126', [S.holdings[A][idx(99)], S.holdings[A][idx(126)]], [3, 2]);
eq('holdings: B grows 3 -> 4 at tick 150', [S.holdings[B][idx(147)], S.holdings[B][idx(150)]], [3, 4]);
eq('last holdings point equals final standing', p.factions.map(f => S.holdings[f.id].at(-1)), p.factions.map(f => f.final.holdings));
eq('D: real until its metrics stop at 199, then 0 (ships and credits)', [S.ships[D][idx(198)], S.credits[D][idx(198)], S.ships[D][idx(300)], S.credits[D][idx(300)], S.holdings[D][idx(300)]], [2, 50, 0, 0, 0]);
eq('ships B follow the metrics', S.ships[B][idx(300)], 30);

console.log('-- battles & totals --');
eq('three biggest fights by hulls lost, ties by shots', p.battles.map(b => b.id), ['bt1', 'bt3', 'bt2']);
eq('bt1 body, ticks, shots, hulls', [p.battles[0].bodyName, p.battles[0].startedTick, p.battles[0].endedTick, p.battles[0].shots, p.battles[0].shipsLost], ['b3', 100, 130, 500, 8]);
eq('bt1 lost a settlement (derived from destroyed_at_tick 120)', p.battles[0].settlementsLost, 1);
eq('bt1 losses by empire (monster omitted, largest first)', p.battles[0].lossesByFaction, [{ factionId: C, shipsLost: 3 }, { factionId: A, shipsLost: 2 }, { factionId: D, shipsLost: 2 }]);
eq('totals', p.totals, { battles: 4, shots: 710, shipsLost: 12, settlementsLost: 2, trades: 5, billsPassed: 5, techsResearched: 74, shipsBuilt: 61, wars: 4 });

console.log('-- the long quiet game --');
const lg = await buildEnding(env, L, 'usr_cara_003');
check('long game builds', !lg.error, lg.error);
eq('long game conforms to the contract', checkEndingShape(lg, CONTRACT), []);
eq('long game invariants', checkEndingInvariants(lg), []);
check('6000 ticks downsample to <= 120 points', lg.series.ticks.length <= 120 && lg.series.ticks.length > 50, lg.series.ticks.length);
eq('first and last tick kept', [lg.series.ticks[0], lg.series.ticks.at(-1)], [1, 6000]);
eq('values are the real ones at the sampled ticks', [lg.series.credits[X].at(-1), lg.series.credits[X][lg.series.ticks.indexOf(lg.series.ticks[10])]], [42000, lg.series.ticks[10] * 7]);
eq('unknown times are null, not invented', [lg.game.startedAtMs, lg.game.completedAtMs, lg.game.durationMs], [null, null, null]);
eq('only awards with real data: landlord + treasurer', lg.awards.map(a => a.id), ['landlord', 'treasurer']);
eq('equal holdings: the winner leads the tie', [lg.awards[0].factionId, lg.awards[0].runnerUp.factionId], [X, Y]);
eq('no battles, no trades', [lg.battles.length, lg.totals.battles, lg.totals.trades, lg.totals.wars], [0, 0, 0, 0]);
eq('victoryDetail null with no chronicle line', lg.game.victoryDetail, null);
check('a stranger-free read as the winner marks isMe', lg.factions[0].isMe && !lg.factions[1].isMe);

console.log('-- timeline --');
const houseRows = async (b) => Number((await DB.prepare(
  'SELECT COUNT(*) AS n FROM battle_shares WHERE battle_id = ? AND created_by IS NULL').bind(b).first()).n);
const allRows = async (b) => Number((await DB.prepare('SELECT COUNT(*) AS n FROM battle_shares WHERE battle_id = ?').bind(b).first()).n);
const moment = (tl, kind, tick) => tl.find(m => m.kind === kind && (tick === undefined || m.tick === tick));
const idsOf = (m) => m?.factionIds;

// -- read-only mode (the prod-fixture script) NEVER writes -----------------
const ro = await buildEnding(env, T, 'usr_alice_001', { readOnly: true });
check('read-only: builds', !ro.error, ro.error);
eq('read-only: the unlinked replayable battle gets no clip and no row is written', [moment(ro.timeline, 'battle', 650)?.clip, await houseRows('tb_mid')], [null, 0]);
eq('read-only: an existing house link is still used', moment(ro.timeline, 'battle', 450).clip?.path, '/recap/HOUSE_BIG_TOKEN_0001');

// -- the real read (this one mints) ---------------------------------------------
// two viewers open the page together while a battle has no house link: one token between them
const [tp, tpTwin] = await Promise.all([buildEnding(env, T, 'usr_alice_001'), buildEnding(env, T, 'usr_bob_002')]);
const TL = tp.timeline;
console.log(TL.map(m => `   ${String(m.tick).padStart(4)} ${m.kind.padEnd(12)} ${String(m.importance).padStart(3)} ${m.factionIds.map(f => f.split(':')[1]).join(',').padEnd(7)} ${m.bodyName ?? ''} ${m.n ?? ''} ${m.detail ?? ''} ${m.clip?.path ?? ''}`).join('\n'));
eq('timeline conforms to the contract and its invariants', [checkEndingShape(tp, CONTRACT), checkEndingInvariants(tp)], [[], []]);
check('at most 16 moments, at least 10 in a rich game', TL.length <= 16 && TL.length >= 10, TL.length);
eq('start is first (tick 0, n = empires) and victory last (game end, detail = how, [winner])',
  [TL[0].kind, TL[0].tick, TL[0].n, TL.at(-1).kind, TL.at(-1).tick, TL.at(-1).detail, TL.at(-1).factionIds],
  ['start', 0, 5, 'victory', 1000, 'chancellor', [tf.W]]);
check('ordered by tick', TL.every((m, i) => !i || TL[i - 1].tick <= m.tick));
{
  const spacing = 15;   // 1.5% of 1000 ticks
  let bad = [];
  for (const a of TL) for (const b of TL) {
    if (a.id >= b.id) continue;
    const dt = Math.abs(a.tick - b.tick);
    if (dt === 0) bad.push(['same tick', a.id, b.id]);
    if (a.kind === b.kind && dt < spacing && a.factionIds.some(f => b.factionIds.includes(f))) bad.push(['too close', a.id, b.id]);
  }
  check('spacing: no two of a kind about the same empire within 1.5% of the game, none on the same tick', bad.length === 0, bad);
}
eq('the second betrayal 6 ticks after the first is not told (spacing)', [TL.filter(m => m.kind === 'pact_broken' && m.tick >= 440 && m.tick < 460).length, !!moment(TL, 'pact_broken', 446)], [1, false]);
eq('lead: only the lasting changes (W@160 n=8, B@500 n=10); not the brief G lead, not W@100, not the first leader',
  TL.filter(m => m.kind === 'lead').map(m => [m.tick, ...m.factionIds, m.n]), [[160, tf.W, 8], [500, tf.B, 10]]);
eq('first blood: the earliest EMPIRE hull lost (tick 40, killer first), not the Leviathan\'s at 3',
  TL.filter(m => m.kind === 'first_blood').map(m => [m.tick, m.factionIds, m.bodyName, m.detail]), [[40, [tf.W, tf.R], 'Mars', 'frigate']]);
eq('war: the first war at 60 (R on W); the monster\'s "war" at 62 is never told', [idsOf(moment(TL, 'war', 60)), !!moment(TL, 'war', 62)], [[tf.R, tf.W], false]);
eq('a pact-breaking war is told once, as the betrayal', [TL.filter(m => m.tick === 440).map(m => [m.kind, m.factionIds, m.detail])], [[['pact_broken', [tf.B, tf.W], 'nap']]]);
eq('a standalone broken pact', [moment(TL, 'pact_broken', 520)?.factionIds, moment(TL, 'pact_broken', 520)?.detail], [[tf.G, tf.R], 'defense_pact']);
eq('eliminations: fallen first, then who took the last world; n = its peak worlds',
  TL.filter(m => m.kind === 'eliminated').map(m => [m.tick, m.factionIds, m.n]),
  [[300, [tf.P], 2], [700, [tf.R, tf.W], 4], [900, [tf.G, tf.B], 7]]);
eq('a passed war authorization is a bill (proposer, target); failed bills and slider laws are not',
  TL.filter(m => m.kind === 'bill').map(m => [m.tick, m.factionIds, m.detail]), [[420, [tf.W, tf.B], 'war_authorization']]);
check('the winning chancellor vote is the victory, not a moment of its own', !TL.some(m => m.kind === 'chancellor'));
check('importance orders the story: the biggest battle outranks every non-forced moment',
  TL.filter(m => !['start', 'victory'].includes(m.kind)).every(m => m.importance <= moment(TL, 'battle', 450).importance));

console.log('-- timeline: clips --');
const battles = TL.filter(m => m.kind === 'battle');
eq('battle moments: the 3 biggest + the last stand, each by hulls lost', battles.map(m => [m.tick, m.bodyName, m.n]),
  [[450, 'Mars', 50], [650, 'Europa', 30], [800, 'Venus', 40], [880, 'Pluto', 30]]);
check('a battle that is not big and not before an elimination is no moment', !TL.some(m => m.bodyName === 'Luna'));
eq('battle factions: the victor first, then the losers', idsOf(moment(TL, 'battle', 450)), [tf.W, tf.R, tf.B]);
eq('house link reused: path, battle, shots, hulls',
  moment(TL, 'battle', 450).clip, { path: '/recap/HOUSE_BIG_TOKEN_0001', battleId: 'tb_big', shots: 900, shipsLost: 50 });
eq('no recorded frames: the moment stays, the clip does not (and nothing is minted)', [moment(TL, 'battle', 800).clip, await allRows('tb_noframes')], [null, 0]);
const midClip = moment(TL, 'battle', 650).clip;
check('a replayable battle with no house link gets one, minted (a player\'s own link is not the house\'s)',
  midClip && /^\/recap\/[A-Za-z0-9_-]{16,}$/.test(midClip.path) && !midClip.path.includes('USER_MADE') && midClip.battleId === 'tb_mid', midClip);
eq('exactly one house row for it, plus the player\'s own', [await houseRows('tb_mid'), await allRows('tb_mid')], [1, 2]);
eq('a REVOKED house link is not re-minted and gives no clip', [moment(TL, 'battle', 880).clip, await houseRows('tb_laststand'), await allRows('tb_laststand')], [null, 1, 1]);
const again = await buildEnding(env, T, 'usr_bob_002');
eq('two viewers opening the page at once mint ONE token between them; a third read mints nothing and hands out the same link',
  [await houseRows('tb_mid'), moment(tpTwin.timeline, 'battle', 650).clip.path, moment(again.timeline, 'battle', 650).clip.path],
  [1, midClip.path, midClip.path]);
eq('the unselected battle\'s link is untouched', await allRows('tb_small'), 1);
check('no battle id used as a link anywhere', !JSON.stringify(tp).match(/"path":"[^"]*tb_/));
eq('isMe follows the viewer in the timeline game too', [tp.factions.find(f => f.isMe)?.id, again.factions.find(f => f.isMe)?.id], [tf.W, tf.R]);

const tlead = await buildEnding(env, LD, 'usr_alice_001');
eq('lead: a brief overtake (Y@100, 40 ticks) is not a moment; X retaking it and Z overtaking both are',
  tlead.timeline.filter(m => m.kind === 'lead').map(m => [m.tick, m.factionIds, m.n]), [[140, [lf.X], 6], [500, [lf.Z], 8]]);

console.log('-- timeline: the world --');
const tw = await buildEnding(env, W5, 'usr_alice_001');
check('world game builds and conforms', !tw.error && checkEndingShape(tw, CONTRACT).length === 0 && checkEndingInvariants(tw).length === 0, tw.error ?? checkEndingShape(tw, CONTRACT).concat(checkEndingInvariants(tw)));
const WL = tw.timeline;
console.log(WL.map(m => `   ${String(m.tick).padStart(4)} ${m.kind.padEnd(12)} ${String(m.importance).padStart(3)} ${m.factionIds.map(f => f.split(':')[1]).join(',').padEnd(7)} ${m.bodyName ?? ''} ${m.n ?? ''} ${m.detail ?? ''}`).join('\n'));
eq('the Leviathan: arrives, strikes (cause kaiju; none of it is an empire), dies to the empire named in the payload',
  WL.filter(m => m.kind === 'leviathan').map(m => [m.tick, m.detail, m.bodyName, m.n, m.factionIds]),
  [[260, 'arrives', 'MK 2', null, []], [300, 'strike', 'MK 2', 2, []], [330, 'dies', 'Weywot', null, [wf.W]]]);
eq('a sun gate opens; the first crossing is by an empire (the second crossing is not told)',
  WL.filter(m => m.kind === 'gate').map(m => [m.tick, m.detail, m.bodyName, m.n, m.factionIds]),
  [[180, 'opened', 'Centauri', 1, []], [190, 'first_crossing', 'Centauri', null, [wf.B]]]);
eq('the Dyson Sphere begun and a milestone (a third megastructure moment yields to the cap of two)',
  WL.filter(m => m.kind === 'megastructure').map(m => [m.tick, m.detail, m.n, m.factionIds]),
  [[250, 'dyson_sphere', 0, [wf.W]], [400, 'dyson_sphere', 25, [wf.W]]]);
eq('ONE discovery, the most valuable by an empire (an observer\'s equal find is ignored)',
  WL.filter(m => m.kind === 'discovery').map(m => [m.tick, m.detail, m.bodyName, m.factionIds]), [[70, 'ancient_capital', 'Aya', [wf.G]]]);
eq('a non-winning chancellor election; an observer\'s embargo is ignored',
  [WL.filter(m => m.kind === 'chancellor').map(m => [m.tick, m.factionIds]), WL.some(m => m.kind === 'bill')], [[[200, [wf.G]]], false]);
eq('past a dozen moments only the weighty stay: the defense pact made it in, the minor NAP after it did not',
  [WL.length, WL.filter(m => m.kind === 'pact').map(m => [m.tick, m.detail, m.factionIds])], [12, [[120, 'defense_pact', [wf.W, wf.B]]]]);
eq('a built megastructure is its builder\'s moment (kind, 100% done); an ancient one is nobody\'s',
  p.timeline.filter(m => m.kind === 'megastructure').map(m => [m.tick, m.detail, m.n, m.factionIds]), [[150, 'null_field', 100, [A]]]);
eq('a quiet game keeps its pacts, with their kind', p.timeline.filter(m => m.kind === 'pact').map(m => [m.tick, m.detail, m.factionIds]), [[30, 'defense_pact', [A, B]]]);
eq('engineering victory', [WL.at(-1).detail, WL.at(-1).tick], ['engineering', 500]);

console.log('-- timeline: everywhere --');
const everyTimeline = [tp, tw, p, lg, obs];
const seats = [M, tf.mon, tf.obs, wf.mon, wf.obs];
check('no monster or observer seat in any moment of any game',
  everyTimeline.every(x => x.timeline.every(m => m.factionIds.every(f => !seats.includes(f)))));
check('no user ids, emails or display names in any timeline',
  !USERS.flat().concat(['secret', 'example.test', 'DisplayName']).some(n => JSON.stringify(everyTimeline.map(x => x.timeline)).includes(n)));
eq('a game with no history still has its start and its end', lg.timeline.map(m => [m.kind, m.tick, m.detail, m.factionIds]),
  [['start', 0, null, []], ['victory', 6000, 'domination', [X]]]);

console.log('-- cost --');
DB.queries = 0;
const t0 = Date.now();
await buildEnding(env, L, 'usr_cara_003');
const stmts = DB.queries;
check(`a 6000-tick read prepares ${stmts} statements (two round trips: 2 parallel + 1 batch) in ${Date.now() - t0} ms`,
  stmts <= 40 && Date.now() - t0 < 1500, stmts);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
