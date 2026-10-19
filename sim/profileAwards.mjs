// ============================================================
// The profile trophy case, server half: GET /api/users/me/awards and the
// per-game award store behind it (worker/profileAwards.js, recordGameAwards
// and computeGameAwards in worker/ending.js; migration 0177).
//
// Seeds small finished games where every award has a known answer, then:
//
//   * the first request computes and stores; a second computes NOTHING (the
//     spy counts the stat batch, which runs once per computed game) and
//     returns the same payload; recordGameAwards twice = same rows
//   * AI seats, monsters and observers never get rows, even when they WIN an
//     award (an AI seat has the best hull in game one)
//   * a player sees ONLY their own awards (two humans in one game)
//   * more than four finished games: four computed (newest first) with the
//     rest `pending`, then the next request finishes them
//   * totals / best / tied; unfinished games ignored; 401 signed out
//   * opening the ending page also stores; readOnly writes nothing; a failing
//     store never breaks the ending page; a failing game stays pending
//   * 60-award cap, totals still count every award
//   * the payload checked key-by-key against src/multiplayer/profileAwardsTypes.ts
//
// Run: npm run sim:awards     (from the repo root)
// ============================================================

import { readFileSync } from 'node:fs';
import { buildEnding, recordGameAwards, computeGameAwards } from '../worker/ending.js';
import { routes, buildProfileAwards, BACKFILL_PER_REQUEST, MAX_AWARDS } from '../worker/profileAwards.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { checkShape } from './endingShape.mjs';

const CONTRACT = readFileSync('src/multiplayer/profileAwardsTypes.ts', 'utf8');
const ENDING_CONTRACT = readFileSync('src/multiplayer/endingTypes.ts', 'utf8');
const shape = (p) => checkShape(p, CONTRACT, 'ProfileAwardsPayload', [ENDING_CONTRACT]);

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
DB.db.exec('PRAGMA foreign_keys = OFF');   // a read-model fixture: skip body/ship scaffolding

// -- a spy: every game the stat batch runs for = one computed game ---------
let computes = 0;
let failStore = false;     // make the store batch throw (a broken D1)
const realError = console.error;   // the worker logs the failures we cause on purpose; keep the output readable
console.error = (...a) => { if (!a.some(x => /D1 is down/.test(String(x)))) realError(...a); };
const spyDB = {
  prepare(sql) {
    if (sql.includes('SELECT owner_faction_id AS fid, body_id')) computes++;
    return DB.prepare(sql);
  },
  async batch(stmts) {
    if (failStore && stmts.some(s => /game_awards_state/.test(s._sql))) throw new Error('D1 is down');
    return DB.batch(stmts);
  },
};
const env = { DB: spyDB };

const q = (sql, ...a) => DB.prepare(sql).bind(...a);
const all = async (sql, ...a) => (await q(sql, ...a).all()).results;
const count = async (table, where = '1=1', ...a) => (await q(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...a).first()).n;
function ins(table, row) {
  const cols = Object.keys(row);
  return DB.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .bind(...cols.map(c => row[c])).run();
}

const USERS = { alice: 'usr_alice_001', bob: 'usr_bob_002', cara: 'usr_cara_003', dan: 'usr_dan_004', erin: 'usr_erin_005', zed: 'usr_zed_006' };
for (const [k, id] of Object.entries(USERS)) {
  await ins('users', { id, email: `${k}@example.test`, display_name: k, password_hash: 'x', created_at: 0 });
}

let uid = 0;
/**
 * A finished (or not) game. seats: { key: { user, status, ships, settle, dmg, gold, hull } }
 *   ships  -> hulls built (shipwright)     settle -> settlements (landlord)
 *   dmg    -> a hull's damage (heavy_hitter; hull = [name, class, captain])   gold -> credits
 */
async function game(id, name, { completed = null, status = 'completed', winner, seats }) {
  await ins('rooms', { id, name, host_id: USERS.alice, created_at: 0, updated_at: 0 });
  await ins('games', {
    id, status, map_seed: 's', created_at: 1, started_at: 1, tick_interval_ms: 60_000, current_tick: 100,
    completed_at: completed, winner_faction_id: winner ? `${id}:${winner}` : null, victory_type: winner ? 'domination' : null,
  });
  let slot = 0;
  for (const [key, s] of Object.entries(seats)) {
    const fid = `${id}:${key}`;
    await ins('game_factions', {
      id: fid, game_id: id, slot: key === 'mon' ? 900 : key === 'obs' ? 901 : slot++, name: s.name ?? `Empire ${key.toUpperCase()} of ${id}`,
      color: '#112233', joined_at: 0, status: s.status ?? 'active', user_id: s.user ?? null, metal: 0, gold: s.gold ?? 0, science: 0,
    });
    if (s.user) await ins('room_members', { room_id: id, user_id: s.user, joined_at: 0 });
    for (let i = 0; i < (s.ships ?? 0); i++) {
      await ins('chronicle_entries', { id: `${id}:c${++uid}`, game_id: id, tick_number: i + 1, kind: 'ship_built', actor_faction_id: fid, payload: '{}', created_at_ms: 0 });
    }
    for (let i = 0; i < (s.settle ?? 0); i++) {
      await ins('game_settlements', { id: `${id}:st${++uid}`, game_id: id, body_id: `${id}:${key}b${i}`, owner_faction_id: fid, type: 'city', name: 'x', hp: 10, hp_max: 10, created_at_tick: 0 });
    }
    if (s.dmg) {
      const [hn, hc, cap] = s.hull ?? [`Hull ${key}`, 'frigate', null];
      await ins('game_ship_stats', { game_id: id, ship_id: `${id}:h${key}`, faction_id: fid, ship_name: hn, ship_class: hc, damage_dealt: s.dmg });
      if (cap) await ins('battle_participants', { battle_id: `${id}:b`, ship_id: `${id}:h${key}`, faction_id: fid, ship_name: hn, ship_class: hc, captain_name: cap, first_tick: 1, last_tick: 5 });
    }
  }
}

const A = USERS.alice, B = USERS.bob;
// g1: alice + bob + an AI seat + a monster + a human observer. AI has the best hull.
await game('g1_game', 'Game One', {
  completed: 1000, winner: 'B', seats: {
    A: { user: A, ships: 10, settle: 2, gold: 900, name: 'Alpha One Empire' },
    B: { user: B, ships: 6, settle: 3, dmg: 300, hull: ['Bravo Hammer', 'destroyer', 'Cpt Bee'], name: 'Bravo Empire' },
    AI: { ships: 2, settle: 3, dmg: 500, hull: ['Machine Maw', 'cruiser', null], name: 'The Machines' },
    mon: { status: 'monster', dmg: 99_999, ships: 99, settle: 99, gold: 99_999, name: 'The Leviathan' },
    obs: { status: 'observer', user: USERS.cara, name: 'Watcher' },
  },
});
await game('g2_game', 'Game Two', { completed: 2000, winner: 'A', seats: { A: { user: A, ships: 4, name: 'Alpha Two' }, AI: { ships: 4 } } });
await game('g3_game', 'Game Three', {
  completed: 3000, winner: 'A', seats: {
    A: { user: A, ships: 7, dmg: 400, hull: ['Alpha Anvil', 'battleship', 'Cpt Al'], name: 'Alpha Three' },
    AI: { dmg: 250, hull: ['Tin Can', 'corvette', null] },
  },
});
await game('g4_game', 'Game Four', { completed: 4000, winner: 'AI', seats: { A: { user: A, ships: 2, name: 'Alpha Four' }, AI: {} } });
await game('g5_game', 'Game Five', { completed: 5000, winner: 'A', seats: { A: { user: A, ships: 9, name: 'Alpha Five' }, AI: {} } });
await game('g6_game', 'Game Six', { completed: 6000, winner: 'A', seats: { A: { user: A, ships: 1, settle: 2, name: 'Alpha Six' }, AI: {} } });
await game('g7_game', 'Game Seven', { completed: 7000, winner: 'A', seats: { A: { user: A, name: 'Alpha Seven' }, AI: {} } });   // nothing happened: no awards
await game('live_game', 'Still Going', { status: 'active', seats: { A: { user: A, ships: 50, name: 'Alpha Live' }, AI: {} } });
const ALICE_GAMES = ['g7_game', 'g6_game', 'g5_game', 'g4_game', 'g3_game', 'g2_game', 'g1_game'];

const route = routes[0];
const ask = async (userId, e = env) => {
  const res = await route.handle(new Request('https://x/api/users/me/awards'), e, { params: {}, session: userId ? { user_id: userId } : null });
  return { res, body: res.status === 200 ? await res.json() : await res.json().catch(() => null) };
};
const awardRows = (p) => p.awards.map(a => `${a.gameId.split('_')[0]}:${a.awardId}=${a.value}${a.tied ? 'T' : ''}`);

console.log('-- route --');
check('GET /api/users/me/awards, sign-in required', route.method === 'GET' && route.pattern === '/api/users/me/awards' && route.auth === 'required');
{
  const r = await ask(null);
  eq('signed out: 401 and nothing computed', [r.res.status, computes], [401, 0]);
}

console.log('-- first request: computes the newest four, the rest pending --');
let r = await ask(A);
check('200, JSON, private no-store', r.res.status === 200 && /application\/json/.test(r.res.headers.get('content-type'))
  && /private/.test(r.res.headers.get('cache-control')) && /no-store/.test(r.res.headers.get('cache-control')));
const p1 = r.body;
eq('BACKFILL_PER_REQUEST is 4', BACKFILL_PER_REQUEST, 4);
eq('computed exactly four games', computes, 4);
eq('the four NEWEST were computed', (await all('SELECT game_id FROM game_awards_state ORDER BY game_id')).map(x => x.game_id), ['g4_game', 'g5_game', 'g6_game', 'g7_game']);
eq('seven finished games (the live one is ignored), three pending', [p1.gamesFinished, p1.pending], [7, 3]);
eq('only games with an award count: g4, g5, g6', p1.gamesWithAwards, 3);
eq('awards so far (newest game first)', awardRows(p1), ['g6:landlord=2', 'g6:shipwright=1', 'g5:shipwright=9', 'g4:shipwright=2']);
eq('payload is exactly the contract', shape(p1), []);

console.log('-- second request: the rest --');
r = await ask(A);
const p2 = r.body;
eq('three more computed (7 in all), nothing pending', [computes, p2.pending], [7, 0]);
eq('every game is marked, the unfinished one is not', (await count('game_awards_state')), 7);
check('live game is never stored', (await count('game_awards_state', 'game_id = ?', 'live_game')) === 0 && (await count('game_awards', 'game_id = ?', 'live_game')) === 0);
eq('all seven games counted; six with awards (g7 earned none)', [p2.gamesFinished, p2.gamesWithAwards], [7, 6]);
eq('awards, newest game first, then award id', awardRows(p2), [
  'g6:landlord=2', 'g6:shipwright=1', 'g5:shipwright=9', 'g4:shipwright=2',
  'g3:heavy_hitter=400', 'g3:shipwright=7', 'g2:shipwright=4T', 'g1:shipwright=10', 'g1:treasurer=900',
]);
eq('totals: most-earned first, then best', p2.totals.map(t => `${t.awardId}x${t.count}@${t.best}/${t.bestGameName}`), [
  'shipwrightx6@10/Game One', 'treasurerx1@900/Game One', 'heavy_hitterx1@400/Game Three', 'landlordx1@2/Game Six',
]);
eq('best game id carried', p2.totals[0].bestGameId, 'g1_game');
const byGame = (p, g, a) => p.awards.find(x => x.gameId === g && x.awardId === a);
eq('tied: level with the AI on 4 hulls', byGame(p2, 'g2_game', 'shipwright').tied, true);
eq('not tied when the runner-up is behind', byGame(p2, 'g1_game', 'shipwright').tied, false);
eq('a lone winner is not tied', byGame(p2, 'g6_game', 'landlord').tied, false);
eq('hull award carries the ship and the captain', byGame(p2, 'g3_game', 'heavy_hitter').ship, { name: 'Alpha Anvil', shipClass: 'battleship', captainName: 'Cpt Al' });
eq('empire awards have no ship', byGame(p2, 'g1_game', 'treasurer').ship, null);
eq('empire name, win flag, finish time', [byGame(p2, 'g2_game', 'shipwright').empireName, byGame(p2, 'g2_game', 'shipwright').wonGame, byGame(p2, 'g2_game', 'shipwright').completedAtMs], ['Alpha Two', true, 2000]);
eq('wonGame false when the AI won the game', byGame(p2, 'g4_game', 'shipwright').wonGame, false);
eq('wonGame false when someone else won it', byGame(p2, 'g1_game', 'treasurer').wonGame, false);
eq('game name comes from the room', byGame(p2, 'g5_game', 'shipwright').gameName, 'Game Five');
eq('payload is exactly the contract', shape(p2), []);

console.log('-- third request: nothing recomputed --');
const before = computes;
r = await ask(A);
eq('no game computed again', computes, before);
eq('identical payload', r.body, p2);

console.log('-- who gets rows --');
const stored = await all('SELECT * FROM game_awards');
check('every row belongs to a human account', stored.every(x => x.user_id), stored.filter(x => !x.user_id));
check('the AI seat never gets a row, though it won heavy_hitter in game one', !stored.some(x => /:AI$/.test(x.faction_id)) && !stored.some(x => x.game_id === 'g1_game' && x.award_id === 'heavy_hitter'));
check('the monster and the observer never get rows', !stored.some(x => /:(mon|obs)$/.test(x.faction_id)) && !stored.some(x => x.user_id === USERS.cara));
// what the AI/monster would have won: the end page lists them, the store does not
const endG1 = await buildEnding({ DB }, 'g1_game', A, { readOnly: true });
eq('the ending page does show the AI\'s heavy_hitter', endG1.awards.find(a => a.id === 'heavy_hitter')?.factionId, 'g1_game:AI');
eq('the monster won nothing there either', endG1.awards.some(a => a.factionId.endsWith(':mon')), false);

console.log('-- two humans in one game --');
{
  const rb = await ask(B);
  eq('bob: one game, computed nothing new, nothing pending', [rb.body.gamesFinished, computes, rb.body.pending], [1, before, 0]);
  eq('bob has only his own award (landlord, tied with the AI, in a game he won)', awardRows(rb.body), ['g1:landlord=3T']);
  eq('bob\'s empire name and win', [rb.body.awards[0].empireName, rb.body.awards[0].wonGame], ['Bravo Empire', true]);
  check('none of alice\'s awards leak into bob\'s, nor his into hers',
    !rb.body.awards.some(a => ['shipwright', 'treasurer'].includes(a.awardId)) && !p2.awards.some(a => a.awardId === 'landlord' && a.gameId === 'g1_game'));
  eq('bob\'s totals', rb.body.totals, [{ awardId: 'landlord', count: 1, best: 3, bestGameId: 'g1_game', bestGameName: 'Game One' }]);
  eq('payload is exactly the contract', shape(rb.body), []);
  const rc = await ask(USERS.cara);
  eq('an observer played nothing: empty case', rc.body, { gamesFinished: 0, gamesWithAwards: 0, totals: [], awards: [], pending: 0 });
  eq('empty payload is the contract too', shape(rc.body), []);
  const rd = await ask(USERS.dan);
  eq('a player with no games: empty case', rd.body, { gamesFinished: 0, gamesWithAwards: 0, totals: [], awards: [], pending: 0 });
}

console.log('-- recordGameAwards --');
{
  const rowsBefore = await count('game_awards');
  const again = await recordGameAwards(env, 'g3_game');
  eq('second call: nothing computed, nothing stored', [again.computed, again.stored], [false, 0]);
  eq('same row count', await count('game_awards'), rowsBefore);
  // an INSERT OR IGNORE race: the marker is gone but the rows are there
  await q('DELETE FROM game_awards_state WHERE game_id = ?', 'g3_game').run();
  const redo = await recordGameAwards(env, 'g3_game');
  eq('marker lost: recomputed, but the rows are not doubled', [redo.computed, await count('game_awards')], [true, rowsBefore]);
  eq('marker is back', await count('game_awards_state', 'game_id = ?', 'g3_game'), 1);
  const live = await recordGameAwards(env, 'live_game');
  eq('an unfinished game stores nothing, not even a marker', [live.computed, await count('game_awards', 'game_id = ?', 'live_game'), await count('game_awards_state', 'game_id = ?', 'live_game')], [false, 0, 0]);
  const none = await recordGameAwards(env, 'no_such_game');
  eq('an unknown game stores nothing', [none.computed, await count('game_awards_state', 'game_id = ?', 'no_such_game')], [false, 0]);
  const c = await computeGameAwards(env, 'g1_game');
  eq('computeGameAwards: header', c.game, { id: 'g1_game', name: 'Game One', completedAtMs: 1000, winnerFactionId: 'g1_game:B' });
  eq('computeGameAwards: empires are the real ones (no monster, no observer), with their account',
    [...c.empires.entries()].map(([k, v]) => [k, v.userId, v.isWinner]).sort(),
    [['g1_game:A', A, false], ['g1_game:AI', null, false], ['g1_game:B', B, true]]);
  eq('computeGameAwards: null for an unfinished game', await computeGameAwards(env, 'live_game'), null);
}

console.log('-- the ending page also stores --');
{
  await game('ge_game', 'Erin\'s Game', { completed: 9000, winner: 'E', seats: { E: { user: USERS.erin, ships: 5, settle: 4, name: 'Erin Empire' }, AI: { ships: 1 } } });
  const ro = await buildEnding(env, 'ge_game', USERS.erin, { readOnly: true });
  check('readOnly still returns the page', !ro.error && ro.awards.length > 0, ro.error);
  eq('readOnly writes nothing: no rows, no marker', [await count('game_awards', 'game_id = ?', 'ge_game'), await count('game_awards_state', 'game_id = ?', 'ge_game')], [0, 0]);

  // a broken store never breaks the page
  failStore = true;
  const broken = await buildEnding(env, 'ge_game', USERS.erin);
  failStore = false;
  check('a failing store does not break the ending page', !broken.error && broken.awards.length === ro.awards.length, broken.error);
  eq('...and left nothing half-stored', [await count('game_awards', 'game_id = ?', 'ge_game'), await count('game_awards_state', 'game_id = ?', 'ge_game')], [0, 0]);

  const pageBefore = JSON.stringify(ro);
  const page = await buildEnding(env, 'ge_game', USERS.erin);
  eq('opening the page stores the awards: rows for the human only, plus the marker',
    [(await all('SELECT award_id, value, user_id FROM game_awards WHERE game_id = ? ORDER BY award_id', 'ge_game')).map(x => `${x.award_id}=${x.value}:${x.user_id === USERS.erin}`), await count('game_awards_state', 'game_id = ?', 'ge_game')],
    [['landlord=4:true', 'shipwright=5:true'], 1]);
  check('the stored awards ARE the page\'s awards (one function behind both)',
    JSON.stringify(page.awards.filter(a => a.factionId === 'ge_game:E').map(a => [a.id, a.value])) === JSON.stringify([['landlord', 4], ['shipwright', 5]]));
  check('the page is byte-identical whether or not it stored', JSON.stringify(page) === pageBefore);
  const re = await buildEnding(env, 'ge_game', USERS.erin);
  eq('opening it again adds nothing', await count('game_awards', 'game_id = ?', 'ge_game'), 2);
  check('re-opening is the same page', JSON.stringify(re) === JSON.stringify(page));
  const c1 = computes;
  const prof = await ask(USERS.erin);
  eq('erin\'s profile: nothing left to compute', [prof.body.gamesFinished, prof.body.pending, computes - c1], [1, 0, 0]);
  eq('erin\'s awards', awardRows(prof.body), ['ge:landlord=4', 'ge:shipwright=5']);
  eq('payload is exactly the contract', shape(prof.body), []);
}

console.log('-- a failing game stays pending, the rest go on --');
{
  await game('gf1_game', 'Fail One', { completed: 20_000, winner: 'F', seats: { F: { user: USERS.dan, ships: 3, name: 'Dan Empire' }, AI: {} } });
  await game('gf2_game', 'Fail Two', { completed: 21_000, winner: 'F', seats: { F: { user: USERS.dan, ships: 8, name: 'Dan Empire' }, AI: {} } });
  failStore = true;
  const bad = await ask(USERS.dan);
  failStore = false;
  eq('every store failed: 200 anyway, both still pending, nothing stored', [bad.res.status, bad.body.pending, bad.body.awards.length, await count('game_awards_state', 'game_id LIKE ?', 'gf%')], [200, 2, 0, 0]);
  const good = await ask(USERS.dan);
  eq('the next request finishes them', [good.body.pending, awardRows(good.body)], [0, ['gf2:shipwright=8', 'gf1:shipwright=3']]);
}

console.log('-- the 60 cap --');
{
  const zed = USERS.zed;
  for (let i = 0; i < 35; i++) {
    const id = `gz${String(i).padStart(2, '0')}_game`;
    await ins('rooms', { id, name: `Zed ${i}`, host_id: zed, created_at: 0, updated_at: 0 });
    await ins('games', { id, status: 'completed', map_seed: 's', created_at: 1, started_at: 1, tick_interval_ms: 60_000, current_tick: 1, completed_at: 100_000 + i });
    await ins('game_factions', { id: `${id}:Z`, game_id: id, slot: 0, name: 'Zed', color: '#fff', joined_at: 0, user_id: zed });
    await ins('game_awards_state', { game_id: id, computed_at_ms: 1 });
    await ins('game_awards', { game_id: id, award_id: 'shipwright', faction_id: `${id}:Z`, user_id: zed, empire_name: 'Zed', value: 10 + i, completed_at_ms: 100_000 + i });
    await ins('game_awards', { game_id: id, award_id: 'landlord', faction_id: `${id}:Z`, user_id: zed, empire_name: 'Zed', value: 3, completed_at_ms: 100_000 + i });
  }
  const c0 = computes;
  const rz = await ask(zed);
  eq('35 games, 70 awards: list capped at 60, totals count all 70', [rz.body.gamesFinished, rz.body.gamesWithAwards, rz.body.awards.length, rz.body.totals.reduce((n, t) => n + t.count, 0)], [35, 35, MAX_AWARDS, 70]);
  eq('newest first', rz.body.awards[0].gameId, 'gz34_game');
  eq('best shipwright is the biggest, from the right game', [rz.body.totals[0].awardId, rz.body.totals[0].best, rz.body.totals[0].bestGameId], ['shipwright', 44, 'gz34_game']);
  eq('level best goes to the newer game: landlord 3 everywhere', [rz.body.totals[1].awardId, rz.body.totals[1].bestGameId], ['landlord', 'gz34_game']);
  eq('already-marked games are never computed', computes - c0, 0);
  eq('payload is exactly the contract', shape(rz.body), []);
}

console.log('-- the contract check itself bites --');
check('a stray key is caught', shape({ ...p2, extra: 1 }).some(e => /extra/.test(e)));
check('a missing key is caught', shape({ ...p2, pending: undefined }).some(e => /pending/.test(e)));
check('a wrong type is caught', shape({ ...p2, gamesFinished: '7' }).some(e => /gamesFinished/.test(e)));
check('an unknown award id is caught', shape({ ...p2, awards: [{ ...p2.awards[0], awardId: 'bogus' }] }).length > 0);
check('a stray key inside an award is caught', shape({ ...p2, awards: [{ ...p2.awards[0], userId: 'x' }] }).some(e => /userId/.test(e)));
{
  const text = JSON.stringify(p2) + JSON.stringify(await ask(B).then(x => x.body));
  const leaks = [...Object.values(USERS), 'example.test', 'password'].filter(n => text.includes(n));
  check('no user id, email or name leaks into the payload', leaks.length === 0, leaks);
}
{
  const direct = await buildProfileAwards(env, A);
  eq('buildProfileAwards is what the route returns', direct, p2);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
