// ============================================================
// PLAY FOR FREE (worker/trial.js), on the real seeder, handlers and tick
// (Lorne, 2026-10-24).
//
//   1. POST /api/trial with no account: a shadow user, a session cookie,
//      a trial game (30 s, an Ally and a Warlord on the roster), and
//      auto-load set so they land in it
//   2. asking again with that session gives the same game back
//   3. thirty trials an hour per address, then 429
//   4. the trial's Warlord declares on the player from tick 20, takes a
//      world, and its warships reach an idle player within 60 ticks
//   5. saving: a new account made from the shadow session gets the game
//      (members, faction, host), the shadow is retired, its sessions end
//   6. a trial nobody plays pauses after 15 minutes; it wakes on return
//   7. a trial starts paused for its tutorial: no ticks, no empire moves
//
// Run: npm run sim:trial
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}
function makeState() {
  const kv = new Map();
  return {
    storage: {
      get: async (k) => kv.get(k), put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => kv.delete(k), setAlarm: async () => {}, getAlarm: async () => null,
    },
    id: { toString: () => 'sim-room' }, acceptWebSocket: () => {}, getWebSockets: () => [],
  };
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const roomCalls = [];
// The game's paused flag at the moment the world finished seeding
// (startGame tells the room /game-started): a cron pass could run then.
const pausedAtSeed = [];
const env = {
  DB,
  ROOM: { idFromName: () => 'x', get: () => ({ fetch: async (u, init) => {
    roomCalls.push([String(u), init?.body ?? null]);
    if (String(u).endsWith('/game-started')) {
      const gid = JSON.parse(init?.body ?? '{}').gameId;
      pausedAtSeed.push((await DB.prepare('SELECT paused FROM games WHERE id = ?').bind(gid).first())?.paused);
    }
    return new Response('{}');
  } }) },
};

const trial = await import('../worker/trial.js');
const auth = await import('../worker/auth.js');
const ai = await import('../worker/aiEmpire.js');
const { Room } = await import('../worker/room.js');

const req = (cookie, ip = '1.2.3.4', body = {}) => new Request('https://x/api/trial', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});
const cookieOf = (res) => (res.headers.get('set-cookie') ?? '').split(';')[0];

// ---- 1. start ---------------------------------------------------------
const r1 = await trial.handleStart(req(null, '1.2.3.4', { attribution: { source: 'reddit' } }), env, null);
const b1 = await r1.json();
check('POST /api/trial starts a game with no account', r1.status === 201 && !!b1.game_id, JSON.stringify(b1));
const cookie = cookieOf(r1);
check('and sets a session cookie', /^orbital_session=/.test(cookie), cookie);
const G = b1.game_id;
const shadowId = b1.user.id;
const u = await DB.prepare('SELECT email, shadow, autoload_room_id, display_name FROM users WHERE id = ?').bind(shadowId).first();
check('a shadow account: never emailable, never a login', u.shadow === 1 && /@shadow\.orbital\.local$/.test(u.email), JSON.stringify(u));
check('auto-load lands them in the trial', u.autoload_room_id === G);
const g = await DB.prepare('SELECT trial, solo, tick_interval_ms, solo_difficulty FROM games WHERE id = ?').bind(G).first();
check('a trial game at 30 s, loose play', g.trial === 1 && g.solo === 1 && g.tick_interval_ms === 30000 && g.solo_difficulty === 'peaceful', JSON.stringify(g));
const fleet = (await DB.prepare(`SELECT ship_class, COUNT(*) AS n FROM game_ships s JOIN game_factions f ON f.id = s.owner_faction_id
                                   WHERE s.game_id = ? AND f.user_id = ? AND s.hp > 0 GROUP BY ship_class`).bind(G, shadowId).all()).results;
const count = (c) => fleet.find(x => x.ship_class === c)?.n ?? 0;
check('a head start: 3 extra corvettes and a freighter, at the capital', count('corvette') >= 4 && count('freighter') >= 1, JSON.stringify(fleet));
const colonyOrder = await DB.prepare(`SELECT s.deploy_on_arrival AS d FROM game_ships s JOIN game_factions f ON f.id = s.owner_faction_id
                                        WHERE s.game_id = ? AND f.user_id = ? AND s.ship_class = 'colony'`).bind(G, shadowId).first();
check('the colony ship is set to found a station where it lands', colonyOrder?.d === 'station', JSON.stringify(colonyOrder));
const pausedAtStart = await DB.prepare('SELECT paused, auto_paused, next_tick_at FROM games WHERE id = ?').bind(G).first();
check('it starts with the clock stopped, for the tutorial', pausedAtStart.paused === 1 && pausedAtStart.auto_paused === 0 && pausedAtStart.next_tick_at == null, JSON.stringify(pausedAtStart));
check('it is born paused: no moment after seeding when a cron pass could play its empires', pausedAtSeed[0] === 1, JSON.stringify(pausedAtSeed));
await ai.runSoloTurns(env);
const early = await DB.prepare('SELECT COUNT(*) AS n FROM game_factions WHERE game_id = ? AND ai_last_tick IS NOT NULL').bind(G).first();
const earlyOffers = await DB.prepare('SELECT COUNT(*) AS n FROM trade_offers WHERE game_id = ?').bind(G).first();
check('no computer empire moves or offers while it is paused', early.n === 0 && earlyOffers.n === 0, JSON.stringify({ early, earlyOffers }));
const seats = (await DB.prepare('SELECT user_id, ai_personality, ai_personality_shown FROM game_factions WHERE game_id = ? ORDER BY slot').bind(G).all()).results;
check('two neighbours on the roster: an Ally and a Warlord',
  seats.length === 3 && seats.filter(s => s.ai_personality_shown === 1).map(s => s.ai_personality).sort().join() === 'ally,warlord',
  JSON.stringify(seats));
const session = await auth.lookupSession(DB, cookie.split('=')[1]);
check('the session knows it is a shadow', Number(session?.shadow) === 1);

// ---- 2. again ------------------------------------------------------------
const r2 = await trial.handleStart(req(cookie), env, session);
const b2 = await r2.json();
check('asking again gives the same game back', r2.status === 200 && b2.game_id === G && b2.resumed === true, JSON.stringify(b2));

// ---- 3. rate limit --------------------------------------------------------
let last = null;
for (let i = 0; i < 30; i++) last = await trial.handleStart(req(null, '9.9.9.9'), env, null);
const thirtieth = last.status;
const next = await trial.handleStart(req(null, '9.9.9.9'), env, null);
check('thirty trials an hour from one address, then 429', thirtieth === 201 && next.status === 429, `${thirtieth} then ${next.status}`);

// The stand-in name is in the language the app is showing.
const rPt = await trial.handleStart(req(null, '5.5.5.5', { lang: 'pt-BR' }), env, null);
const bPt = await rPt.json();
const uPt = await DB.prepare('SELECT display_name, locale FROM users WHERE id = ?').bind(bPt.user?.id).first();
check('a Portuguese trial player is "Comandante", and keeps the language',
  rPt.status === 201 && bPt.user?.display_name === 'Comandante' && uPt?.display_name === 'Comandante' && uPt?.locale === 'pt-BR',
  JSON.stringify({ user: bPt.user, uPt }));
check('an English one is "Commander"', u.display_name === 'Commander', JSON.stringify(u));

// ---- 4. the Warlord comes at tick 20 -------------------------------------
const human = seats[0];
const war = (await DB.prepare('SELECT id FROM game_factions WHERE game_id = ? AND ai_personality = ?').bind(G, 'warlord').first()).id;
const humanF = (await DB.prepare('SELECT id FROM game_factions WHERE game_id = ? AND user_id = ?').bind(G, human.user_id).first()).id;
/**
 * Play a trial for `ticks` ticks with a player who does nothing (or, with
 * `pact`, only signs whatever pact is offered), and watch the Warlord.
 * Playtest 2026-10-24: it never took a world, offered a ceasefire before
 * its corvettes had landed, and testers saw no attack in half an hour.
 */
async function watchWarlord(gameId, warId, humanId, humanUser, { ticks = 60, pact = false } = {}) {
  const rm = new Room(makeState(), env);
  rm.broadcast = () => {};
  const out = { arrivedAt: null, earlyCeasefire: null, worldsAt: {} };
  for (let t = 1; t <= ticks; t++) {
    await rm.resolveTick(gameId, t);
    await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, gameId).run();
    if (pact) {
      const open = (await DB.prepare(`SELECT id FROM trade_offers WHERE game_id = ? AND responder_faction_id = ? AND status = 'open'`)
        .bind(gameId, humanId).all()).results ?? [];
      for (const o of open) await ai.callAs(env, humanUser, 'POST', `/api/games/${gameId}/trades/${o.id}/accept`, {});
    }
    await ai.runSoloGame(env, gameId);
    // Its warships parked (no leg left) at one of the player's worlds.
    const there = await DB.prepare(
      `SELECT COUNT(*) AS n FROM game_ships s JOIN game_bodies b ON b.id = s.parent_body_id
        WHERE s.owner_faction_id = ? AND s.hp > 0 AND s.ship_class IN ('corvette','frigate','destroyer','capital')
          AND b.owner_faction_id = ?
          AND NOT EXISTS (SELECT 1 FROM game_ship_nodes n WHERE n.ship_id = s.id AND n.status IN ('committed','in_transit'))`,
    ).bind(warId, humanId).first();
    if (out.arrivedAt == null && there.n > 0) out.arrivedAt = t;
    const cf = await DB.prepare('SELECT ceasefire_at_tick FROM game_wars WHERE game_id = ? AND ceasefire_by = ?').bind(gameId, warId).first();
    if (out.earlyCeasefire == null && cf && out.arrivedAt == null) out.earlyCeasefire = cf.ceasefire_at_tick;
    out.worldsAt[t] = (await DB.prepare('SELECT COUNT(DISTINCT body_id) AS n FROM game_settlements WHERE game_id = ? AND owner_faction_id = ? AND destroyed_at_tick IS NULL')
      .bind(gameId, warId).first()).n;
  }
  return out;
}

const idle = await watchWarlord(G, war, humanF, human.user_id);
const w = await DB.prepare(`SELECT declared_by, declared_at_tick FROM game_wars WHERE game_id = ? AND declared_by = ?`).bind(G, war).first();
check('the trial Warlord declares on the player from tick 20', w && w.declared_at_tick >= 20 && w.declared_at_tick <= 40, JSON.stringify(w));
check('the trial Warlord takes a second world by tick 30 (it visibly expands)', idle.worldsAt[30] >= 2, JSON.stringify(idle.worldsAt[30]));
check('its warships reach the idle player\'s worlds within 30 minutes (tick 60)', idle.arrivedAt != null && idle.arrivedAt <= 60, `arrived at ${idle.arrivedAt}`);
check('it does not offer a ceasefire before its strike has landed', idle.earlyCeasefire == null, `offered at ${idle.earlyCeasefire}`);
const allyOffer = await DB.prepare(`SELECT COUNT(*) AS n FROM trade_offers WHERE game_id = ? AND responder_faction_id = ? AND offer_pacts LIKE '%nap%'`).bind(G, humanF).first();
check('the trial Ally offers a pact', allyOffer.n >= 1);

// A player who signs the Ally's pact: the Ally joins the war (the second
// "war declared" testers saw), and the Warlord still comes for the player.
{
  const rp = await trial.handleStart(req(null, '7.7.7.7'), env, null);
  const GP = (await rp.json()).game_id;
  await DB.prepare('UPDATE games SET paused = 0 WHERE id = ?').bind(GP).run();
  const fs = (await DB.prepare('SELECT id, user_id, ai_personality FROM game_factions WHERE game_id = ?').bind(GP).all()).results;
  const hp = fs.find(f => !f.ai_personality);
  const wp = fs.find(f => f.ai_personality === 'warlord').id;
  const ap = fs.find(f => f.ai_personality === 'ally').id;
  const res = await watchWarlord(GP, wp, hp.id, hp.user_id, { pact: true });
  const allyWar = await DB.prepare('SELECT declared_at_tick FROM game_wars WHERE game_id = ? AND declared_by = ?').bind(GP, ap).first();
  check('with the Ally\'s pact signed, the Ally joins the war', !!allyWar, JSON.stringify(allyWar));
  check('and the Warlord\'s warships still reach the player by tick 60', res.arrivedAt != null && res.arrivedAt <= 60, `arrived at ${res.arrivedAt}`);
}

// ---- 4b. a counter-offer gets a real answer --------------------------------
// Playtest B4: a counter asking the Ally for credits was declined in
// silence, and the same pact offer came straight back.
{
  const rc = await trial.handleStart(req(null, '6.6.6.6'), env, null);
  const GC = (await rc.json()).game_id;
  await DB.prepare('UPDATE games SET paused = 0 WHERE id = ?').bind(GC).run();
  const fs = (await DB.prepare('SELECT id, user_id, ai_personality FROM game_factions WHERE game_id = ?').bind(GC).all()).results;
  const hp = fs.find(f => !f.ai_personality);
  const ap = fs.find(f => f.ai_personality === 'ally').id;
  const rmC = new Room(makeState(), env);
  rmC.broadcast = () => {};
  const step = async (t) => {
    await rmC.resolveTick(GC, t);
    await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, GC).run();
    await ai.runSoloGame(env, GC);
  };
  await step(1);
  const first = await DB.prepare(`SELECT id FROM trade_offers WHERE game_id = ? AND proposer_faction_id = ? AND responder_faction_id = ? AND status = 'open'`)
    .bind(GC, ap, hp.id).first();
  const ctr = await ai.callAs(env, hp.user_id, 'POST', `/api/games/${GC}/trades/${first.id}/counter`,
    { offer: {}, request: { gold: 100 }, offer_pacts: ['nap'], request_pacts: [] });
  check('the player counters the Ally\'s pact, asking for credits', ctr.ok, JSON.stringify(ctr.data));
  await step(2);
  const answered = await DB.prepare('SELECT status, decline_reason FROM trade_offers WHERE id = ?').bind(ctr.data?.trade?.id).first();
  // Round 2 (R2-B10): goods are no longer a flat no; this early it has no
  // freighter to carry them, and says so. It is answered at once.
  check('the Ally answers it: declined, with a reason', answered?.status === 'declined' && answered?.decline_reason === 'no_freighter', JSON.stringify(answered));
  for (let t = 3; t <= 26; t++) await step(t);
  const again = await DB.prepare(`SELECT created_at_tick FROM trade_offers WHERE game_id = ? AND proposer_faction_id = ? AND responder_faction_id = ?
                                   AND id != ? ORDER BY created_at_tick LIMIT 1`).bind(GC, ap, hp.id, first.id).first();
  check('and does not send the same offer straight back (not within 24 ticks)', !again || again.created_at_tick >= 2 + 24, JSON.stringify(again));
  // A counter it can take (the pact, sweetened with a gift) is accepted.
  for (let t = 27; t <= 60 && !(await DB.prepare(`SELECT 1 AS x FROM trade_offers WHERE game_id = ? AND proposer_faction_id = ? AND responder_faction_id = ? AND status = 'open'`).bind(GC, ap, hp.id).first()); t++) await step(t);
  const second = await DB.prepare(`SELECT id FROM trade_offers WHERE game_id = ? AND proposer_faction_id = ? AND responder_faction_id = ? AND status = 'open'`)
    .bind(GC, ap, hp.id).first();
  const ctr2 = second ? await ai.callAs(env, hp.user_id, 'POST', `/api/games/${GC}/trades/${second.id}/counter`,
    { offer: { metal: 10 }, request: {}, offer_pacts: ['nap'], request_pacts: [] }) : null;
  const cur = Number((await DB.prepare('SELECT current_tick AS t FROM games WHERE id = ?').bind(GC).first()).t);
  await step(cur + 1);
  const took = ctr2?.data?.trade?.id ? await DB.prepare('SELECT status FROM trade_offers WHERE id = ?').bind(ctr2.data.trade.id).first() : null;
  check('a counter it can take (the pact plus a gift) is accepted', took?.status === 'accepted', JSON.stringify({ second: !!second, took }));
}

// ---- 5. saving -------------------------------------------------------------
const realId = 'realUser1';
await DB.prepare(`INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, 'hana@t', 'Hana', 'x', 0)`).bind(realId).run();
roomCalls.length = 0;
const claim = await trial.claimShadow(env, req(cookie), realId);
check('saving moves the trial into the account', claim?.gameId === G, JSON.stringify(claim));
const member = await DB.prepare('SELECT user_id FROM room_members WHERE room_id = ? AND join_method = ?').bind(G, 'host').first();
const fac = await DB.prepare('SELECT user_id FROM game_factions WHERE id = ?').bind(humanF).first();
const host = await DB.prepare('SELECT host_id FROM rooms WHERE id = ?').bind(G).first();
check('seat, faction and host are the account\'s now', member.user_id === realId && fac.user_id === realId && host.host_id === realId,
  JSON.stringify({ member, fac, host }));
const after = await DB.prepare('SELECT shadow FROM users WHERE id = ?').bind(shadowId).first();
const sessLeft = await DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(shadowId).first();
check('the shadow is retired and signed out', after.shadow === 2 && sessLeft.n === 0);
check('the room hears the seat changed hands', roomCalls.some(([u, b]) => u.endsWith('/member-renamed') && b.includes(realId)));
const auto = await DB.prepare('SELECT autoload_room_id FROM users WHERE id = ?').bind(realId).first();
check('the saved game opens on their next launch', auto.autoload_room_id === G);
const again = await trial.claimShadow(env, req(cookie), realId);
check('a second save is a no-op', again === null);

// the room's own copy follows
const r = new Room(makeState(), env);
await r.state.storage.put('members', { [shadowId]: { userId: shadowId, displayName: 'Commander' }, aiX: { userId: 'aiX' } });
await r.state.storage.put('meta', { hostId: shadowId, maxPlayers: 2 });
await r.fetch(new Request('https://room/member-renamed', { method: 'POST', body: JSON.stringify({ from: shadowId, to: realId }) }));
const mem = await r.state.storage.get('members');
const meta = await r.state.storage.get('meta');
check('the room renames the seat (no "room full" on reconnect)', !!mem[realId] && !mem[shadowId] && meta.hostId === realId, JSON.stringify({ mem, meta }));

// ---- 6. idle -------------------------------------------------------------------
const r3 = await trial.handleStart(req(null, '5.5.5.5'), env, null);
const G3 = (await r3.json()).game_id;
await DB.prepare('UPDATE games SET paused = 0 WHERE id = ?').bind(G3).run(); // the tutorial started its clock
await DB.prepare('UPDATE games SET host_seen_ms = ? WHERE id = ?').bind(Date.now() - 16 * 60_000, G3).run();
await trial.sweepIdleTrials(env);
let g3 = await DB.prepare('SELECT paused, auto_paused, next_tick_at FROM games WHERE id = ?').bind(G3).first();
check('a trial nobody plays for 15 minutes pauses', g3.paused === 1 && g3.auto_paused === 1 && g3.next_tick_at == null, JSON.stringify(g3));
await trial.touchTrial(env, G3);
g3 = await DB.prepare('SELECT paused, auto_paused, next_tick_at FROM games WHERE id = ?').bind(G3).first();
check('and wakes when they come back', g3.paused === 0 && g3.auto_paused === 0 && g3.next_tick_at > Date.now(), JSON.stringify(g3));
await DB.prepare('UPDATE games SET paused = 1, auto_paused = 0, host_seen_ms = 0 WHERE id = ?').bind(G3).run();
await trial.touchTrial(env, G3);
g3 = await DB.prepare('SELECT paused FROM games WHERE id = ?').bind(G3).first();
check('a pause the player chose is theirs (no auto-wake)', g3.paused === 1);

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
