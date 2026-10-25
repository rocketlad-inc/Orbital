// ============================================================
// SOLO TRADE (playtest round 2): how computer empires answer a person.
//
//   R2-B3/B4  a person's offer is answered at once, not on the next tick
//             (a pact proposed while paused read NEUTRAL until then)
//   R2-B10    goods, per personality, within reason:
//     ALLY     a small ask is a gift; a big one gets a counter with a price
//     WARLORD  refuses: it trades with no one
//     SNAKE    takes a deal at a friendly discount, remembers the favour,
//              asks for it back, and holds a grudge when refused
//   and what a computer empire agreed to ship gets one of its freighters.
//
// Run: node sim/soloTrade.mjs
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
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('uH','h@t','Hana','x',0)`).run();

const solo = await import('../worker/solo.js');
const trades = await import('../worker/trades.js');
const ai = await import('../worker/aiEmpire.js');
const { Room } = await import('../worker/room.js');

async function call(mod, method, path, userId, body) {
  for (const r of mod.routes) {
    if (r.method !== method) continue;
    const m = typeof r.pattern === 'string' ? (r.pattern === path ? { groups: {} } : null) : path.match(r.pattern);
    if (!m) continue;
    const req = new Request(`https://x${path}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const res = await r.handle(req, env, { url: new URL(`https://x${path}`), params: m.groups ?? {}, session: { user_id: userId } });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  }
  throw new Error(`no route matched ${method} ${path}`);
}

const made = await call(solo, 'POST', '/api/solo', 'uH', {
  rivals: 3, difficulty: 'peaceful', speed_ms: 30000, personalities: ['ally', 'warlord', 'snake'],
});
const G = made.data.game_id;
// The trial's way: paused, so no computer turn runs between our steps.
await DB.prepare('UPDATE games SET paused = 1 WHERE id = ?').bind(G).run();
const fac = async (p) => DB.prepare('SELECT id, user_id FROM game_factions WHERE game_id = ? AND ai_personality = ?').bind(G, p).first();
const ally = await fac('ally');
const warlord = await fac('warlord');
const snake = await fac('snake');
const me = await DB.prepare('SELECT id FROM game_factions WHERE game_id = ? AND ai_doctrine IS NULL').bind(G).first();
const status = async (id) => DB.prepare('SELECT status, decline_reason FROM trade_offers WHERE id = ?').bind(id).first();
const propose = (to, offer, request, pacts = []) => call(trades, 'POST', `/api/games/${G}/trades`, 'uH', {
  responder_faction_id: to, offer, request, offer_pacts: pacts, request_pacts: [],
});

// ---- R2-B9: computer empires are named for the world they hold ----------
const named = (await DB.prepare(`SELECT f.name, b.name AS capital, f.ai_doctrine FROM game_factions f
                                   JOIN game_bodies b ON b.id = f.capital_body_id WHERE f.game_id = ? ORDER BY f.slot`).bind(G).all()).results;
check('B9. each computer empire is named for its capital', named.filter(r => r.ai_doctrine).every(r => r.name.startsWith(`${r.capital} `)),
  JSON.stringify(named));
check('    and the capital city follows the name', (await DB.prepare(`SELECT COUNT(*) AS n FROM game_settlements s JOIN game_factions f ON f.id = s.owner_faction_id
                                   WHERE s.game_id = ? AND f.ai_doctrine IS NOT NULL AND s.name = f.name || ' Capital'`).bind(G).first()).n === 3);
check('    the person keeps the default name', named[0].name === 'Solar Directorate', JSON.stringify(named[0]));

// ---- R2-B3/B4: answered at once ---------------------------------------
const nap = await propose(ally.id, {}, {}, ['nap']);
const napRow = await status(nap.data?.trade?.id);
check('B4. a pact you offer the Ally is signed at once, clock paused', napRow?.status === 'accepted', JSON.stringify({ nap, napRow }));
const pacts = await call(trades, 'GET', `/api/games/${G}/pacts`, 'uH');
check('   and your pacts list shows it straight away', (pacts.data?.pacts ?? []).some(p => p.kind === 'nap' && p.counterparty_faction_ids.includes(ally.id)),
  JSON.stringify(pacts.data));

// ---- R2-B10: the Ally ---------------------------------------------------
// No freighter yet, and none it may build: it says so.
const early = await propose(ally.id, {}, { metal: 50 });
const earlyRow = await status(early.data?.trade?.id);
check('Ally, before it can field a freighter: declines, and says why', earlyRow?.status === 'declined' && earlyRow.decline_reason === 'no_freighter',
  JSON.stringify(earlyRow));
// From here each computer empire has a freighter at home.
for (const f of [ally, warlord, snake]) {
  const cap = await DB.prepare('SELECT capital_body_id FROM game_factions WHERE id = ?').bind(f.id).first();
  await DB.prepare(`INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
                      orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
                      fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick, home_body_id)
                    VALUES (?, ?, ?, 'Packhorse', 'freighter', ?, 8, 8, 0, 0, 0, 1, 1200, 1200, 'active', 0, 60, 60, 0, ?)`)
    .bind(`${f.id}:sim_fr`, G, f.id, cap.capital_body_id, cap.capital_body_id).run();
}
const big = await propose(ally.id, { metal: 10 }, { gold: 100 });
const bigRow = await status(big.data?.trade?.id);
const counter = await DB.prepare(`SELECT * FROM trade_offers WHERE parent_offer_id = ?`).bind(big.data?.trade?.id).first();
check('Ally: a big ask for too little gets a counter with a price', bigRow?.status === 'countered' && !!counter
  && counter.offer_gold === 100 && counter.request_metal > 10 && counter.status === 'open',
  JSON.stringify({ bigRow, counter: counter && { og: counter.offer_gold, om: counter.offer_metal, rm: counter.request_metal, rg: counter.request_gold } }));
check('   at half price (100 credits for 400 metal)', counter?.request_metal === 400, JSON.stringify(counter?.request_metal));
// Not taken up: the counter is withdrawn before the next ask.
if (counter) await call(trades, 'POST', `/api/games/${G}/trades/${counter.id}/decline`, 'uH', {});

const gift = await propose(ally.id, {}, { metal: 50 });
const giftRow = await status(gift.data?.trade?.id);
check('Ally: a small ask is a gift (accepted)', giftRow?.status === 'accepted', JSON.stringify(giftRow));
const leg = await DB.prepare('SELECT ship_id, status, sender_faction_id FROM trade_deliveries WHERE trade_id = ?').bind(gift.data?.trade?.id).first();
check('   and it puts one of its freighters on the shipment', !!leg?.ship_id && leg.status === 'to_pickup' && leg.sender_faction_id === ally.id, JSON.stringify(leg));

// ---- the Warlord --------------------------------------------------------
const wl = await propose(warlord.id, { gold: 50 }, { metal: 20 });
const wlRow = await status(wl.data?.trade?.id);
check('Warlord: refuses, and says it trades with no one', wlRow?.status === 'declined' && wlRow.decline_reason === 'no_trade', JSON.stringify(wlRow));

// ---- the Snake ----------------------------------------------------------
const sn = await propose(snake.id, { metal: 600 }, { gold: 100 });
const snRow = await status(sn.data?.trade?.id);
check('Snake: accepts a deal at a friendly discount', snRow?.status === 'accepted', JSON.stringify(snRow));
let mem = JSON.parse((await DB.prepare('SELECT ai_state FROM game_factions WHERE id = ?').bind(snake.id).first()).ai_state ?? '{}');
check('   and remembers the favour', Number(mem.favour?.[me.id] ?? 0) === 200, JSON.stringify(mem.favour));

// Play on: it asks for the favour back.
await DB.prepare('UPDATE games SET paused = 0 WHERE id = ?').bind(G).run();
const room = new Room(makeState(), env);
room.broadcast = () => {};
let ask = null;
for (let t = 1; t <= 40 && !ask; t++) {
  await room.resolveTick(G, t);
  await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, G).run();
  await ai.runSoloGame(env, G);
  ask = await DB.prepare(`SELECT * FROM trade_offers WHERE game_id = ? AND proposer_faction_id = ? AND responder_faction_id = ?
                           AND status = 'open' AND request_gold > 0 AND offer_metal = 0 AND offer_gold = 0`).bind(G, snake.id, me.id).first();
}
check('Snake: later it asks for the favour back (25 credits)', ask?.request_gold === 25, JSON.stringify(ask));
if (ask) {
  await call(trades, 'POST', `/api/games/${G}/trades/${ask.id}/decline`, 'uH', {});
  const t0 = Number((await DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(G).first()).current_tick);
  for (let t = t0 + 1; t <= t0 + 3; t++) {
    await room.resolveTick(G, t);
    await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, G).run();
    await ai.runSoloGame(env, G);
  }
  mem = JSON.parse((await DB.prepare('SELECT ai_state FROM game_factions WHERE id = ?').bind(snake.id).first()).ai_state ?? '{}');
  check('   refused, it holds a grudge', Number(mem.grudge?.[me.id] ?? -1) > t0, JSON.stringify(mem.grudge));
  const after = await propose(snake.id, { gold: 50 }, { metal: 20 });
  const afterRow = await status(after.data?.trade?.id);
  check('   and will not deal with you now', afterRow?.status === 'declined' && afterRow.decline_reason === 'no_trust', JSON.stringify(afterRow));
}

// ---- R2-B9: their hulls carry names from the ordinary pool --------------
const built = (await DB.prepare(`SELECT s.name FROM game_ships s JOIN game_factions f ON f.id = s.owner_faction_id
                                   WHERE s.game_id = ? AND f.ai_doctrine IS NOT NULL AND s.built_at_tick > 0`).bind(G).all()).results;
check('B9. computer empires\' new hulls are named from the pool, not "Corvette T13-384"',
  built.length > 0 && built.every(r => !/ T\d+-\d{3}$/.test(r.name)), JSON.stringify(built.map(r => r.name)));

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
