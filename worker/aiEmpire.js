// ============================================================
// Computer empires — the players a solo game seats (worker/solo.js).
//
// A computer empire is an ordinary faction played by an agent user. It
// acts through the SAME route handlers a person's client calls, with a
// fabricated session, so it pays the same costs, waits on the same
// build queues and is refused by the same rules (legGuard included).
// No cheating: nothing here writes game state except ai_last_tick.
//
// WHEN IT PLAYS. Once per new tick, from the minute cron (index.js
// scheduled()) and right after a STEP. Not inside the tick: the handlers
// call back into the room's Durable Object, and the tick runs inside it.
// A 30 s game can tick twice between two cron minutes, so every "every N
// ticks" decision asks whether a multiple of N passed SINCE THE LAST
// TURN (due()), never `tick % N === 0`, which a skipped tick would miss.
//
// THE DOCTRINES are sim/bots.mjs's, which the balance sweeps were run
// with: what to research, which hulls to build, which city buildings,
// whether to take ground. On top of them, difficulty (Lorne's pick:
// peaceful / normal / ruthless) only decides how soon and how hard an
// empire goes to war, and how it treats a ceasefire.
//
// THE SENATE. Quorum counts every active faction, so a computer empire
// that never voted would block every bill. Each one votes on every open
// bill once, in its own interest (voteFor()).
// ============================================================

import * as actions from './actions.js';
import * as wars from './wars.js';
import * as senate from './senate.js';
import { describeSlider } from './senate.js';
import * as trades from './trades.js';
import { currentTerm } from './senateTerms.js';
import { makeRouteMath } from './routeMath.js';
import { isFarSystemBody } from './systems.js';

const MODULES = [actions, wars, senate, trades];

/** sim/bots.mjs ARCHETYPES, with the war rules difficulty layers on.
 *  `law`: the slider law it files when it holds the gavel. */
export const DOCTRINES = {
  rusher: {
    research: ['weapons', 'construction', 'armor', 'industry'],
    build: ['corvette', 'corvette', 'frigate'],
    buildings: ['forge', 'mint'],
    colonise: false,
    buildEvery: 6,
    attack: { every: 8, minFleet: 3 },
    warlike: true,
    law: ['ship_build_cost_multiplier', 0.8],
  },
  expander: {
    research: ['construction', 'propulsion', 'industry'],
    build: ['colony', 'freighter', 'corvette'],
    buildings: ['mint', 'forge', 'lab'],
    colonise: true,
    buildEvery: 10,
    attack: { every: 20, minFleet: 6 },
    warlike: false,
    law: ['metal_yield_multiplier', 1.25],
  },
  economist: {
    research: ['industry', 'propulsion', 'construction'],
    build: ['freighter', 'corvette'],
    buildings: ['mint', 'forge', 'lab'],
    colonise: false,
    buildEvery: 14,
    attack: { every: 24, minFleet: 4 },
    warlike: false,
    law: ['gold_yield_multiplier', 1.25],
  },
  technocrat: {
    research: ['industry', 'sensors', 'weapons'],
    build: ['corvette'],
    buildings: ['lab', 'mint'],
    colonise: false,
    buildEvery: 16,
    attack: { every: 24, minFleet: 4 },
    warlike: false,
    law: ['science_yield_multiplier', 1.25],
  },
};

/** How each difficulty goes to war. `from`: the first tick a warlike
 *  empire may declare; `fleet`: armed hulls it wants first; `wars`: most
 *  open wars it starts; `everyone`: even the peaceable doctrines declare;
 *  `human`: aims at the person first; `peaceAfter`: ticks into a war it
 *  takes a ceasefire (null: never), `offerAfter`: when it offers one. */
export const TEMPERS = {
  peaceful: { from: null, fleet: 0, wars: 0, everyone: false, human: false, peaceAfter: 0, offerAfter: 12 },
  normal: { from: 48, fleet: 4, wars: 1, everyone: false, human: false, peaceAfter: 24, offerAfter: 72 },
  ruthless: { from: 24, fleet: 3, wars: 2, everyone: true, human: true, peaceAfter: null, offerAfter: null },
};

const ARMED = ['corvette', 'frigate', 'destroyer', 'capital'];
const ARMED_SQL = ARMED.map(c => `'${c}'`).join(',');
const SETTLE_TYPES = ['terrestrial', 'moon', 'dwarf'];
const SETTLE_SQL = SETTLE_TYPES.map(c => `'${c}'`).join(',');
/** Fewest ticks between two of an empire's declarations. */
const DECLARE_EVERY = 12;

/** Did a multiple of `every` (shifted by `offset`) pass since the last
 *  turn? `last` null: the empire's first turn. */
export function due(tick, last, every, offset = 0) {
  if (!(every > 0)) return false;
  if (last == null) return true;
  return Math.floor((tick - offset) / every) > Math.floor((last - offset) / every);
}

// ---- the door every action goes through --------------------------------

function matchPattern(pattern, pathname) {
  if (typeof pattern === 'string') return pattern === pathname ? {} : null;
  const m = pathname.match(pattern);
  if (!m) return null;
  const out = {};
  for (const [k, v] of Object.entries(m.groups ?? {})) {
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

/** Call the game's own route as `userId`. Never throws on a refusal:
 *  being told no is a normal outcome for a computer player. */
export async function callAs(env, userId, method, path, body) {
  const url = new URL(`https://orbital.internal${path}`);
  for (const mod of MODULES) {
    for (const r of mod.routes ?? []) {
      if (r.method !== method) continue;
      const params = matchPattern(r.pattern, url.pathname);
      if (params === null) continue;
      const req = new Request(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body == null || method === 'GET' ? undefined : JSON.stringify(body),
      });
      try {
        const res = await r.handle(req, env, { session: { user_id: userId }, params });
        let data = null;
        try { data = await res.clone().json(); } catch { /* not json */ }
        return { ok: res.ok, status: res.status, data };
      } catch (e) {
        console.error(`ai ${method} ${url.pathname} threw`, e);
        return { ok: false, status: 500, data: null };
      }
    }
  }
  return { ok: false, status: 404, data: null };
}

// ---- one empire's turn ---------------------------------------------------

/**
 * Everything one turn needs about the game, read once and shared by every
 * computer empire in it.
 */
async function readGame(env, gameId, tick) {
  const DB = env.DB;
  const [bodies, factions, warRows] = await Promise.all([
    DB.prepare(`SELECT id, parent_body_id, orbit_radius, orbit_period, angle0,
                       orbit_rp, orbit_ra, orbit_omega, orbit_m0,
                       type, owner_faction_id, terraformed_at_tick, template_id,
                       emerge_from_tick, destroyed_at_tick, obliterated_at_tick
                  FROM game_bodies WHERE game_id = ?`).bind(gameId).all(),
    DB.prepare(`SELECT id, user_id, status, capital_body_id, ai_doctrine, ai_last_tick
                  FROM game_factions WHERE game_id = ?`).bind(gameId).all(),
    DB.prepare(`SELECT id, faction_a, faction_b, declared_by, declared_at_tick, ceasefire_by
                  FROM game_wars WHERE game_id = ? AND ended_at_tick IS NULL`).bind(gameId).all(),
  ]);
  const rm = makeRouteMath(DB, gameId);
  const bodyRows = bodies.results ?? [];
  rm.preloadBodies(bodyRows);
  const live = bodyRows.filter(b => b.destroyed_at_tick == null && b.obliterated_at_tick == null
    && !(b.emerge_from_tick != null && Number(b.emerge_from_tick) > tick));
  return {
    gameId, tick, rm,
    bodies: live,
    bodyById: new Map(live.map(b => [b.id, b])),
    factions: factions.results ?? [],
    wars: warRows.results ?? [],
  };
}

/** Straight-line distance between two bodies now. */
async function dist(g, a, b) {
  const [p, q] = await Promise.all([g.rm.bodyPosAt(a, g.tick), g.rm.bodyPosAt(b, g.tick)]);
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/** The arrival tick the hull's engines really allow, from the server's
 *  own leg timer (the legGuard refuses anything sooner). */
async function arrivalFor(g, factionId, from, to) {
  const legs = await g.rm.computeLegTicks(factionId, from, to, g.tick);
  return g.tick + Math.max(1, legs);
}

/**
 * One computer empire's decisions for one turn. Returns a tally of what
 * it tried, for logs and the sim.
 */
export async function takeTurn(env, g, fac, difficulty) {
  const DB = env.DB;
  const { gameId, tick } = g;
  const doctrine = DOCTRINES[fac.ai_doctrine] ?? DOCTRINES.expander;
  const temper = TEMPERS[difficulty] ?? TEMPERS.normal;
  const last = fac.ai_last_tick == null ? null : Number(fac.ai_last_tick);
  const me = fac.id;
  const G = `/api/games/${encodeURIComponent(gameId)}`;
  const call = (method, path, body) => callAs(env, fac.user_id, method, `${G}${path}`, body);
  const tally = {};
  const note = (k, r) => {
    const key = r ? (r.ok ? `${k}_ok` : `${k}_${r.data?.error?.code ?? r.status}`) : k;
    tally[key] = (tally[key] ?? 0) + 1;
  };

  const myWars = g.wars.filter(w => w.faction_a === me || w.faction_b === me);
  const enemyOf = (w) => (w.faction_a === me ? w.faction_b : w.faction_a);
  const enemies = new Set(myWars.map(enemyOf));
  const rivals = g.factions.filter(f => f.id !== me && f.status === 'active');
  const home = fac.capital_body_id && g.bodyById.has(fac.capital_body_id) ? fac.capital_body_id : null;

  // --- diplomacy: offers on the table ---------------------------------
  const offers = (await DB.prepare(
    `SELECT id, request_metal, request_fuel, request_gold, request_science, request_pacts
       FROM trade_offers WHERE game_id = ? AND responder_faction_id = ? AND status = 'open'`,
  ).bind(gameId, me).all()).results ?? [];
  for (const o of offers) {
    const asks = Number(o.request_metal) + Number(o.request_fuel) + Number(o.request_gold) + Number(o.request_science);
    let pacts = [];
    try { pacts = JSON.parse(o.request_pacts || '[]'); } catch { pacts = ['?']; }
    // A gift is taken; a non-aggression pact is taken by anyone not out
    // for blood; anything that costs it is turned down.
    const take = asks === 0 && pacts.every(p => p === 'nap' && difficulty !== 'ruthless');
    note(take ? 'trade_accept' : 'trade_decline',
      await call('POST', `/trades/${encodeURIComponent(o.id)}/${take ? 'accept' : 'decline'}`, {}));
  }

  // --- ceasefires -----------------------------------------------------
  for (const w of myWars) {
    const other = enemyOf(w);
    const age = tick - Number(w.declared_at_tick ?? tick);
    if (w.ceasefire_by && w.ceasefire_by === other) {
      if (temper.peaceAfter != null && age >= temper.peaceAfter) {
        note('ceasefire_accept', await call('POST', '/wars/end', { target_faction_id: other }));
      }
    } else if (!w.ceasefire_by && temper.offerAfter != null && age >= temper.offerAfter
               && w.declared_by !== me) {
      // It did not start this one, and has had enough.
      note('ceasefire_offer', await call('POST', '/wars/end', { target_faction_id: other }));
    }
  }

  // --- research: never idle -------------------------------------------
  const purse = await DB.prepare('SELECT research_tech_id FROM game_factions WHERE id = ?').bind(me).first();
  if (!purse?.research_tech_id && doctrine.research.length) {
    const pick = doctrine.research[(tick + me.length) % doctrine.research.length];
    note('research', await call('POST', '/research', { tech_id: pick, queue: doctrine.research }));
  }

  // --- ships, at the capital ------------------------------------------
  if (home && doctrine.build.length && due(tick, last, doctrine.buildEvery)) {
    const n = Math.floor(tick / doctrine.buildEvery);
    let cls = doctrine.build[n % doctrine.build.length];
    // At war, the yard turns out warships.
    if (enemies.size > 0 && !ARMED.includes(cls)) cls = 'corvette';
    const r = await call('POST', `/bodies/${encodeURIComponent(home)}/build`, { ship_class: cls });
    note(`build_${cls}`, r);
    // A hull it has not researched yet: the one every yard can build.
    if (!r.ok && r.data?.error?.code === 'not_researched' && cls !== 'corvette') {
      note('build_corvette', await call('POST', `/bodies/${encodeURIComponent(home)}/build`, { ship_class: 'corvette' }));
    }
  }

  // --- city buildings -------------------------------------------------
  if (doctrine.buildings.length && due(tick, last, doctrine.buildEvery, 3)) {
    const city = await DB.prepare(
      `SELECT id FROM game_settlements
        WHERE game_id = ? AND owner_faction_id = ? AND type = 'city' AND hp > 0
        ORDER BY CASE WHEN body_id = ? THEN 0 ELSE 1 END, id LIMIT 1`,
    ).bind(gameId, me, home ?? '').first();
    if (city) {
      // Its list in turn, skipping what it has not researched yet.
      const k0 = Math.floor(tick / doctrine.buildEvery);
      for (let i = 0; i < doctrine.buildings.length; i++) {
        const kind = doctrine.buildings[(k0 + i) % doctrine.buildings.length];
        const r = await call('POST', `/settlements/${encodeURIComponent(city.id)}/buildings`, { kind });
        note(`bld_${kind}`, r);
        if (r.ok || r.data?.error?.code !== 'not_researched') break;
      }
    }
  }

  // --- war: declaring -------------------------------------------------
  const armedHome = (await DB.prepare(
    `SELECT s.id, s.parent_body_id FROM game_ships s
      WHERE s.game_id = ? AND s.owner_faction_id = ? AND s.hp > 0
        AND s.ship_class IN (${ARMED_SQL}) AND s.parent_body_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM game_ship_nodes n
                         WHERE n.ship_id = s.id AND n.status IN ('pending','committed','in_transit'))`,
  ).bind(gameId, me).all()).results ?? [];
  const startedWars = myWars.filter(w => w.declared_by === me).length;
  if (temper.from != null && tick >= temper.from && (doctrine.warlike || temper.everyone)
      && startedWars < temper.wars && armedHome.length >= temper.fleet
      && due(tick, last, DECLARE_EVERY, 5) && home) {
    const candidates = rivals.filter(f => !enemies.has(f.id) && f.capital_body_id && g.bodyById.has(f.capital_body_id));
    if (candidates.length) {
      const scored = [];
      for (const f of candidates) {
        let d = await dist(g, home, f.capital_body_id);
        if (temper.human && !f.ai_doctrine) d *= 0.25;
        scored.push([d, f]);
      }
      scored.sort((a, b) => a[0] - b[0]);
      note('declare', await call('POST', '/wars/declare', { target_faction_id: scored[0][1].id }));
    }
  }

  // --- war: attacking -------------------------------------------------
  if (enemies.size > 0 && due(tick, last, doctrine.attack.every, 1)
      && armedHome.length >= doctrine.attack.minFleet) {
    // The nearest enemy world, from where the fleet sits.
    const from = armedHome[0].parent_body_id;
    let best = null;
    for (const b of g.bodies) {
      if (!b.owner_faction_id || !enemies.has(b.owner_faction_id) || isFarSystemBody(b)) continue;
      const d = await dist(g, from, b.id);
      if (!best || d < best[0]) best = [d, b.id];
    }
    if (best) {
      // Every warship at once: staggered arrivals lose in detail.
      const arrivals = new Map();
      const orders = [];
      for (const s of armedHome.slice(0, 50)) {
        if (s.parent_body_id === best[1]) continue;
        if (!arrivals.has(s.parent_body_id)) arrivals.set(s.parent_body_id, await arrivalFor(g, me, s.parent_body_id, best[1]));
        orders.push({ ship_id: s.id, target_body_id: best[1], scheduled_t: tick, arrival_t: arrivals.get(s.parent_body_id), replace: true });
      }
      if (orders.length) note('attack', await call('POST', '/transfers', { orders }));
    } else {
      note('attack_no_target');
    }
  }

  // --- expansion: claim, terraform, settle ----------------------------
  if (doctrine.colonise) await expand(env, g, me, call, note, tick);

  // --- the senate -----------------------------------------------------
  const open = (await DB.prepare(
    `SELECT p.id, p.kind, p.proposer_faction_id, p.payload FROM senate_proposals p
      WHERE p.game_id = ? AND p.status IN ('debating','voting')
        AND p.vote_opens_at_tick <= ? AND p.vote_closes_at_tick > ?
        AND NOT EXISTS (SELECT 1 FROM senate_votes v WHERE v.proposal_id = p.id AND v.faction_id = ?)`,
  ).bind(gameId, tick, tick, me).all()).results ?? [];
  for (const p of open) {
    const vote = voteFor(p, me, enemies, difficulty, g);
    note(`vote_${vote}`, await call('POST', `/senate/proposals/${encodeURIComponent(p.id)}/vote`, { vote }));
  }

  // Only the chairman puts a bill on the floor, so a computer chairman
  // that filed nothing would leave its whole term silent. One bill a
  // term: at war, dearer ships for the enemy; else its doctrine's law.
  const term = await currentTerm(env, gameId, tick).catch(() => null);
  if (term && term.faction_id === me && doctrine.law) {
    const filed = await DB.prepare(
      `SELECT COUNT(*) AS c FROM senate_proposals
        WHERE game_id = ? AND proposer_faction_id = ? AND proposed_at_tick >= ?`,
    ).bind(gameId, me, Number(term.start_tick ?? 0)).first();
    if (Number(filed?.c ?? 0) === 0) {
      const foe = [...enemies][0] ?? null;
      const [slider, value] = foe ? ['ship_build_cost_multiplier', 1.3] : doctrine.law;
      const d = describeSlider(slider, value);
      if (d) {
        note('propose', await call('POST', '/senate/proposals', {
          kind: 'slider_law', title: d.name, summary: d.effect,
          slider_id: slider, target_value: value, ...(foe ? { target_faction_id: foe } : {}),
        }));
      }
    }
  }

  return tally;
}

/**
 * How a computer empire votes. For itself, yes; against itself, no; a
 * bill aimed at an enemy, yes. A chancellor bid by anyone else: a
 * ruthless empire votes it down, a normal one only when the candidate is
 * the person (who is the one it is playing against), a peaceful one
 * stands aside. Everything else it leaves to the others.
 */
export function voteFor(p, me, enemies, difficulty, g) {
  if (p.proposer_faction_id === me) return 'yea';
  let payload = {};
  try { payload = JSON.parse(p.payload || '{}'); } catch { payload = {}; }
  const target = payload?.target_faction_id ?? null;
  if (target === me) return 'nay';
  if (target && enemies.has(target)) return 'yea';
  if (p.kind === 'chancellor_vote') {
    if (difficulty === 'ruthless') return 'nay';
    const proposer = g.factions.find(f => f.id === p.proposer_faction_id);
    if (difficulty === 'normal' && proposer && !proposer.ai_doctrine) return 'nay';
    return 'abstain';
  }
  if (p.proposer_faction_id && enemies.has(p.proposer_faction_id)) return 'nay';
  return 'abstain';
}

/**
 * Taking ground, sim/bots.mjs's four moves in order of the most finished
 * work first: a city on a terraformed world, a station on a raw one, a
 * freighter route to terraform it, then a colony ship flown out.
 */
async function expand(env, g, me, call, note, tick) {
  const DB = env.DB;
  const { gameId } = g;
  const idle = `NOT EXISTS (SELECT 1 FROM game_ship_nodes n
                             WHERE n.ship_id = s.id AND n.status IN ('pending','committed','in_transit'))`;

  const cityReady = await DB.prepare(
    `SELECT s.parent_body_id FROM game_ships s JOIN game_bodies b ON b.id = s.parent_body_id
      WHERE s.game_id = ? AND s.owner_faction_id = ? AND s.ship_class = 'colony' AND s.hp > 0
        AND b.terraformed_at_tick IS NOT NULL AND b.owner_faction_id = ?
        AND NOT EXISTS (SELECT 1 FROM game_settlements c WHERE c.body_id = b.id AND c.type = 'city'
                         AND c.destroyed_at_tick IS NULL)
        AND ${idle} LIMIT 1`,
  ).bind(gameId, me, me).first();
  if (cityReady) {
    note('city', await call('POST', `/bodies/${encodeURIComponent(cityReady.parent_body_id)}/settlement`, { type: 'city' }));
    return;
  }

  const parked = await DB.prepare(
    `SELECT s.parent_body_id FROM game_ships s JOIN game_bodies b ON b.id = s.parent_body_id
      WHERE s.game_id = ? AND s.owner_faction_id = ? AND s.ship_class = 'colony' AND s.hp > 0
        AND b.owner_faction_id IS NULL AND b.type IN (${SETTLE_SQL})
        AND NOT EXISTS (SELECT 1 FROM game_settlements c WHERE c.body_id = b.id AND c.type = 'station'
                         AND c.destroyed_at_tick IS NULL)
        AND ${idle} LIMIT 1`,
  ).bind(gameId, me).first();
  if (parked) {
    note('claim', await call('POST', `/bodies/${encodeURIComponent(parked.parent_body_id)}/settlement`, { type: 'station' }));
    return;
  }

  const needsRoute = await DB.prepare(
    `SELECT b.id FROM game_bodies b
      WHERE b.game_id = ? AND b.owner_faction_id = ? AND b.terraformed_at_tick IS NULL
        AND b.terraform_completes_at_tick IS NULL
        AND b.destroyed_at_tick IS NULL AND b.type IN (${SETTLE_SQL})
        AND (b.secret_kind IS NULL OR b.secret_revealed = 1)
        AND NOT EXISTS (SELECT 1 FROM game_trade_routes tr WHERE tr.dest_body_id = b.id
                         AND tr.owner_faction_id = ? AND tr.cancelled_at_tick IS NULL)
      LIMIT 1`,
  ).bind(gameId, me, me).first();
  if (needsRoute) {
    const origin = await DB.prepare(
      `SELECT b.id FROM game_bodies b
        WHERE b.game_id = ? AND b.terraformed_at_tick IS NOT NULL
          AND EXISTS (SELECT 1 FROM game_settlements s WHERE s.body_id = b.id
                       AND s.owner_faction_id = ? AND s.destroyed_at_tick IS NULL)
        LIMIT 1`,
    ).bind(gameId, me).first();
    const hauler = await DB.prepare(
      `SELECT s.id FROM game_ships s
        WHERE s.game_id = ? AND s.owner_faction_id = ? AND s.ship_class = 'freighter' AND s.hp > 0
          AND NOT EXISTS (SELECT 1 FROM game_trade_routes tr WHERE tr.ship_id = s.id
                           AND tr.cancelled_at_tick IS NULL)
        LIMIT 1`,
    ).bind(gameId, me).first();
    if (origin && hauler) {
      note('tfroute', await call('POST', '/trade-routes',
        { ship_id: hauler.id, origin_body_id: origin.id, dest_body_id: needsRoute.id }));
      return;
    }
  }

  const ship = await DB.prepare(
    `SELECT s.id, s.parent_body_id FROM game_ships s
      WHERE s.game_id = ? AND s.owner_faction_id = ? AND s.ship_class = 'colony' AND s.hp > 0
        AND s.parent_body_id IS NOT NULL AND ${idle} LIMIT 1`,
  ).bind(gameId, me).first();
  if (!ship) return;
  // The nearest open rock in the main system that nobody else is
  // already flying a colony ship to.
  const claimed = new Set(((await DB.prepare(
    `SELECT DISTINCT n.target_body_id AS id FROM game_ship_nodes n JOIN game_ships s ON s.id = n.ship_id
      WHERE s.game_id = ? AND s.ship_class = 'colony' AND n.status IN ('pending','committed','in_transit')`,
  ).bind(gameId).all()).results ?? []).map(r => r.id));
  let best = null;
  for (const b of g.bodies) {
    if (b.owner_faction_id || !SETTLE_TYPES.includes(b.type) || !b.parent_body_id) continue;
    if (isFarSystemBody(b) || claimed.has(b.id) || b.id === ship.parent_body_id) continue;
    const d = await dist(g, ship.parent_body_id, b.id);
    if (!best || d < best[0]) best = [d, b.id];
  }
  if (!best) return;
  note('fly_out', await call('POST', `/ships/${encodeURIComponent(ship.id)}/transfer`, {
    target_body_id: best[1], scheduled_t: tick,
    arrival_t: await arrivalFor(g, me, ship.parent_body_id, best[1]), replace: true,
  }));
}

// ---- every solo game -----------------------------------------------------

/** Play every computer empire in one game that has not had this tick's
 *  turn. Returns how many played; `sink` (the sim) collects the tallies. */
export async function runSoloGame(env, gameId, sink = null) {
  const row = await env.DB.prepare(
    `SELECT id, current_tick, solo_difficulty, status FROM games WHERE id = ? AND solo = 1`,
  ).bind(gameId).first();
  if (!row || row.status !== 'active') return 0;
  const tick = Number(row.current_tick ?? 0);
  const g = await readGame(env, gameId, tick);
  const due = g.factions.filter(f => f.ai_doctrine && f.status === 'active'
    && (f.ai_last_tick == null || Number(f.ai_last_tick) < tick));
  let played = 0;
  for (const fac of due) {
    // Claim the turn first: a slow turn overlapping the next cron minute
    // must not play twice.
    const claim = await env.DB.prepare(
      `UPDATE game_factions SET ai_last_tick = ?
        WHERE id = ? AND (ai_last_tick IS NULL OR ai_last_tick < ?)`,
    ).bind(tick, fac.id, tick).run();
    if (!(claim?.meta?.changes > 0)) continue;
    try {
      const tally = await takeTurn(env, g, fac, row.solo_difficulty ?? 'normal');
      played++;
      if (sink) for (const [k, v] of Object.entries(tally)) sink[`${fac.ai_doctrine}:${k}`] = (sink[`${fac.ai_doctrine}:${k}`] ?? 0) + v;
      if (env.AI_EMPIRE_LOG) console.log(`ai ${gameId} t${tick} ${fac.ai_doctrine}`, JSON.stringify(tally));
    } catch (e) {
      console.error(`ai turn failed ${gameId} ${fac.id}`, e);
    }
  }
  if (played > 0) {
    await env.DB.prepare('UPDATE games SET state_version = state_version + 1 WHERE id = ?').bind(gameId).run();
  }
  return played;
}

/** The cron's pass: every running solo game (a paused one still plays
 *  the ticks a STEP advanced). */
export async function runSoloTurns(env) {
  const rows = (await env.DB.prepare(
    `SELECT g.id FROM games g
      WHERE g.solo = 1 AND g.status = 'active'
        AND EXISTS (SELECT 1 FROM game_factions f WHERE f.game_id = g.id AND f.ai_doctrine IS NOT NULL
                     AND f.status = 'active'
                     AND (f.ai_last_tick IS NULL OR f.ai_last_tick < COALESCE(g.current_tick, 0)))`,
  ).all()).results ?? [];
  for (const r of rows) {
    try { await runSoloGame(env, r.id); } catch (e) { console.error(`solo turns failed ${r.id}`, e); }
  }
}
