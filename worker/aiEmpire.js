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
// THREE LAYERS.
//   - DOCTRINE (here, from sim/bots.mjs, which the balance sweeps ran on):
//     its economy. What to research, build and settle.
//   - PERSONALITY (aiPersona.js): Ally, Warlord or Snake. How it treats
//     the person, when it goes to war, when it makes peace.
//   - SHARPNESS (aiTactics.js): the difficulty. How well it fights: does
//     it weigh the odds, keep a home guard, defend, retreat.
// It decides from its own fog-cut GET /state, never from the tables:
// what it cannot see, it does not know.
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
import * as stateMod from './state.js';
import { currentTerm } from './senateTerms.js';
import { makeRouteMath } from './routeMath.js';
import { isFarSystemBody } from './systems.js';
import { due, readView, wageWar, SHARPNESS } from './aiTactics.js';
import { conduct, readMemory, voteFor, answerInbox } from './aiPersona.js';

export { due };

const MODULES = [actions, wars, senate, trades, stateMod];

/** sim/bots.mjs ARCHETYPES, with the war rules difficulty layers on.
 *  `law`: the slider law it files when it holds the gavel. */
export const DOCTRINES = {
  rusher: {
    research: ['weapons', 'construction', 'armor', 'industry'],
    build: ['corvette', 'corvette', 'frigate'],
    buildings: ['forge', 'mint'],
    // It settles with the colony ship every empire starts with (it builds
    // none): a Warlord that never took a world looked asleep (playtest).
    colonise: true,
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
  // The Snake's economy: takes ground like an Expander, but its yard
  // turns out warships all the while, for the day it turns.
  schemer: {
    research: ['construction', 'weapons', 'industry', 'propulsion'],
    build: ['colony', 'corvette', 'frigate', 'corvette', 'freighter'],
    buildings: ['mint', 'forge', 'lab'],
    colonise: true,
    buildEvery: 8,
    attack: { every: 8, minFleet: 3 },
    warlike: false,
    law: ['ship_build_cost_multiplier', 0.8],
  },
};

const ARMED = ['corvette', 'frigate', 'destroyer', 'capital'];
/** worker/actions.js TECH_DEFS and TECH_MAX_LEVEL. */
const ALL_TECHS = ['weapons', 'armor', 'propulsion', 'construction', 'industry', 'sensors'];
const TECH_CAP = 10;
/** Spending: one extra build order per doubling of the stockpile past
 *  RICH_AT metal (credits weighed 8:1), at most MAX_EXTRA_ORDERS. */
const RICH_AT = 2000;
const MAX_EXTRA_ORDERS = 4;
/** How often an empire plays, in real time: at most one turn per this
 *  many ms (a 30 s tick: every tick; a 7 s tick: every third). The
 *  crucible ran six empires every 7 s tick and their /state reads held
 *  the database the tick needed: the room fell 50 ticks behind. */
const TURN_EVERY_MS = 20_000;
/** Ticks into a war after which a sharp empire attacks at even odds. */
const SIEGE_AFTER = 100;
const SETTLE_TYPES = ['terrestrial', 'moon', 'dwarf'];
const SETTLE_SQL = SETTLE_TYPES.map(c => `'${c}'`).join(',');
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
        const res = await r.handle(req, env, { session: { user_id: userId }, params, url });
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

/**
 * A PERSON'S OFFER IS ANSWERED AT ONCE (playtest R2-B3/B4). A computer
 * empire answered offers on its turn, a tick or more later, and never
 * while the clock was paused: a pact the player had just proposed read
 * NEUTRAL until then. trades.js calls this right after a person proposes
 * to (or counters) a computer empire; it answers that one offer the way
 * its turn would (aiPersona.js answerInbox). Never throws.
 */
export async function answerNow(env, gameId, factionId, tradeId) {
  try {
    const fac = await env.DB.prepare(
      `SELECT f.id, f.user_id, f.status, f.ai_doctrine, f.ai_personality, f.ai_state, g.current_tick, g.status AS game_status
         FROM game_factions f JOIN games g ON g.id = f.game_id
        WHERE f.id = ? AND f.game_id = ?`,
    ).bind(factionId, gameId).first();
    if (!fac?.ai_doctrine || fac.status !== 'active' || fac.game_status !== 'active') return false;
    const doctrine = DOCTRINES[fac.ai_doctrine] ?? DOCTRINES.expander;
    const personality = fac.ai_personality ?? (doctrine.warlike ? 'warlord' : 'ally');
    const mem = readMemory(fac.ai_state);
    const G = `/api/games/${encodeURIComponent(gameId)}`;
    const call = (method, path, body) => callAs(env, fac.user_id, method, `${G}${path}`, body);
    await answerInbox(env, {
      gameId, me: fac.id, personality, mem, tick: Number(fac.current_tick ?? 0), call, only: tradeId,
    });
    // Only what this answer changed: its turn may be writing the rest.
    const fresh = readMemory((await env.DB.prepare('SELECT ai_state FROM game_factions WHERE id = ?').bind(fac.id).first())?.ai_state);
    fresh.favour = mem.favour;
    fresh.favourAt = mem.favourAt;
    await env.DB.prepare('UPDATE game_factions SET ai_state = ? WHERE id = ?').bind(JSON.stringify(fresh), fac.id).run();
    return true;
  } catch (e) {
    console.error('answerNow failed', e, { gameId, factionId, tradeId });
    return false;
  }
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
    DB.prepare(`SELECT id, user_id, status, capital_body_id, ai_doctrine, ai_last_tick, ai_personality, ai_state
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
export async function takeTurn(env, g, fac, difficulty, { trial = false } = {}) {
  const DB = env.DB;
  const { gameId, tick } = g;
  const doctrine = DOCTRINES[fac.ai_doctrine] ?? DOCTRINES.expander;
  const personality = fac.ai_personality ?? (doctrine.warlike ? 'warlord' : 'ally');
  const sharp = SHARPNESS[difficulty] ?? SHARPNESS.normal;
  const last = fac.ai_last_tick == null ? null : Number(fac.ai_last_tick);
  const me = fac.id;
  const G = `/api/games/${encodeURIComponent(gameId)}`;
  const call = (method, path, body) => callAs(env, fac.user_id, method, `${G}${path}`, body);
  const tally = {};
  const note = (k, r) => {
    const key = r ? (r.ok ? `${k}_ok` : `${k}_${r.data?.error?.code ?? r.status}`) : k;
    tally[key] = (tally[key] ?? 0) + 1;
  };
  const home = fac.capital_body_id && g.bodyById.has(fac.capital_body_id) ? fac.capital_body_id : null;

  // --- what it can see: its own /state, fog and all ----------------------
  const seen = await call('GET', '/state');
  const view = seen.ok && seen.data?.me ? { ...readView(seen.data), db: DB, gameId } : null;
  if (!view) note('blind', seen);
  const mem = readMemory(fac.ai_state);

  // --- who it is: diplomacy, by personality ------------------------------
  let foes = new Set();
  let force = false;
  let prey = null;
  if (view) {
    const r = await conduct(env, {
      view, rm: g.rm, call, note, personality, difficulty, last, wars: g.wars, gameId, mem, trial,
    });
    foes = r.foes;
    force = r.force;
    prey = r.prey ?? null;
  }

  // --- research: never idle ---------------------------------------------
  // Sensors 1 first, whatever the doctrine: it is Capital Ping, and under
  // fog a rival's capital is not on the map without it (state.js). A
  // person who wants to find their enemies researches it too.
  // Its own list first; a track at the cap is skipped, and once its list
  // is done it carries on with whatever is lowest (the crucible: 548 turns
  // asking for maxed tracks while Armor sat at 0).
  const purse = await DB.prepare('SELECT research_tech_id, metal, gold FROM game_factions WHERE id = ?').bind(me).first();
  const levels = seen.data?.me?.tech_levels ?? {};
  const needSensors = Number(levels.sensors ?? 0) < 1;
  if (!purse?.research_tech_id) {
    const open = (t) => Number(levels[t] ?? 0) < TECH_CAP;
    const mine = doctrine.research.filter(open);
    const rest = ALL_TECHS.filter(t => open(t) && !mine.includes(t))
      .sort((a, b) => Number(levels[a] ?? 0) - Number(levels[b] ?? 0));
    const queue = [...(needSensors ? ['sensors'] : []), ...mine.filter(t => !(needSensors && t === 'sensors')), ...rest];
    if (queue.length) {
      const pick = needSensors ? 'sensors' : (mine.length ? mine[(tick + me.length) % mine.length] : queue[0]);
      note('research', await call('POST', '/research', { tech_id: pick, queue }));
    }
  }

  // --- ships, at the capital --------------------------------------------
  // A rich empire spends: one order on its rhythm, and more the deeper
  // its stockpile (the crucible: 8 million metal banked, one hull at a
  // time). It stops at the first refusal (a full yard, an empty purse).
  if (home && doctrine.build.length && due(tick, last, doctrine.buildEvery)) {
    const wealth = Math.min(Number(purse?.metal ?? 0), Number(purse?.gold ?? 0) * 8);
    const orders = 1 + Math.min(MAX_EXTRA_ORDERS, Math.floor(Math.log2(Math.max(1, wealth / RICH_AT))));
    const n = Math.floor(tick / doctrine.buildEvery);
    for (let k = 0; k < orders; k++) {
      let cls = doctrine.build[(n + k) % doctrine.build.length];
      // At war, the yard turns out warships.
      if (foes.size > 0 && !ARMED.includes(cls)) cls = 'corvette';
      let r = await call('POST', `/bodies/${encodeURIComponent(home)}/build`, { ship_class: cls });
      note(`build_${cls}`, r);
      // A hull it has not researched yet: the one every yard can build.
      if (!r.ok && r.data?.error?.code === 'not_researched' && cls !== 'corvette') {
        r = await call('POST', `/bodies/${encodeURIComponent(home)}/build`, { ship_class: 'corvette' });
        note('build_corvette', r);
      }
      if (!r.ok) break;
    }
  }

  // --- city buildings ---------------------------------------------------
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

  // --- war: how sharply it fights ----------------------------------------
  if (view && foes.size > 0) {
    // A war past SIEGE_AFTER ticks: the empire settles for an even fight.
    const longWar = g.wars.some(w => (w.faction_a === me || w.faction_b === me)
      && tick - Number(w.declared_at_tick ?? tick) >= SIEGE_AFTER);
    for (const [label, r] of await wageWar(view, g.rm, call, foes, sharp, { force, longWar, prey })) note(label, r);
  }

  // --- expansion: claim, terraform, settle ------------------------------
  if (doctrine.colonise) await expand(env, g, me, call, note, tick, view);

  // --- the senate -------------------------------------------------------
  const open = (await DB.prepare(
    `SELECT p.id, p.kind, p.proposer_faction_id, p.payload FROM senate_proposals p
      WHERE p.game_id = ? AND p.status IN ('debating','voting')
        AND p.vote_opens_at_tick <= ? AND p.vote_closes_at_tick > ?
        AND NOT EXISTS (SELECT 1 FROM senate_votes v WHERE v.proposal_id = p.id AND v.faction_id = ?)`,
  ).bind(gameId, tick, tick, me).all()).results ?? [];
  for (const p of open) {
    const vote = voteFor(p, { me, human: view?.human ?? null, personality, enemies: foes, mem, tick });
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
      const foe = [...foes][0] ?? null;
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

  // --- what it remembers ------------------------------------------------
  await DB.prepare('UPDATE game_factions SET ai_state = ? WHERE id = ?').bind(JSON.stringify(mem), me).run();
  tally[`personality:${personality}`] = 1;
  return tally;
}

/**
 * Taking ground, sim/bots.mjs's four moves in order of the most finished
 * work first: a city on a terraformed world, a station on a raw one, a
 * freighter route to terraform it, then a colony ship flown out.
 */
async function expand(env, g, me, call, note, tick, view) {
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
  // The nearest rock in the main system that looks open from here (fog:
  // a world it cannot see may already be someone's, and it finds out on
  // arrival) and that none of its own colony ships is already bound for.
  const claimed = new Set(((await DB.prepare(
    `SELECT DISTINCT n.target_body_id AS id FROM game_ship_nodes n JOIN game_ships s ON s.id = n.ship_id
      WHERE s.game_id = ? AND s.owner_faction_id = ? AND s.ship_class = 'colony'
        AND n.status IN ('pending','committed','in_transit')`,
  ).bind(gameId, me).all()).results ?? []).map(r => r.id));
  let best = null;
  for (const b of g.bodies) {
    const owned = view ? view.owner.has(b.id) : !!b.owner_faction_id;
    if (owned || !SETTLE_TYPES.includes(b.type) || !b.parent_body_id) continue;
    // Every capital's place is public (the roster), fog or not: never
    // settle at a rival's home. Under fog it looks open (its owner and
    // settlements are hidden), so a colony ship could fly at the player's.
    if (view?.capitals?.has(b.id)) continue;
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

/** Play every computer empire in one game whose turn is due, one after
 *  another (each claims its tick first, so a pass that overlaps another
 *  never plays one twice; one at a time because D1 serves one query at a
 *  time and the tick needs it too).
 *  Returns how many played; `sink` (the sim) collects the tallies. With
 *  games.ai_log set (the crucible), every turn is written to
 *  ai_turn_log: what it tried, what was refused, and any error. */
export async function runSoloGame(env, gameId, sink = null, { lagOnly = false } = {}) {
  const row = await env.DB.prepare(
    `SELECT id, current_tick, solo_difficulty, status, tick_interval_ms, COALESCE(ai_log, 0) AS ai_log,
            COALESCE(trial, 0) AS trial FROM games WHERE id = ? AND solo = 1`,
  ).bind(gameId).first();
  if (!row || row.status !== 'active') return 0;
  const tick = Number(row.current_tick ?? 0);
  const g = await readGame(env, gameId, tick);
  // lagOnly (the cron's fallback): only empires a whole tick behind, so
  // the cron never races the room's own pass for the current tick.
  // Pacing: an empire plays every `every` ticks, on its own beat (seat i
  // plays when (tick + i) % every === 0), so a fast game spreads its
  // empires across ticks instead of all of them at once.
  const every = Math.max(1, Math.ceil(TURN_EVERY_MS / Math.max(1000, Number(row.tick_interval_ms) || 30_000)));
  const behind = lagOnly ? tick - every : tick - every + 1;
  const due = g.factions.filter((f, i) => f.ai_doctrine && f.status === 'active'
    && (f.ai_last_tick == null || Number(f.ai_last_tick) < behind)
    && (lagOnly || every === 1 || (tick + i) % every === 0 || f.ai_last_tick == null));
  const results = [];
  for (const fac of due) results.push(await (async () => {
    const claim = await env.DB.prepare(
      `UPDATE game_factions SET ai_last_tick = ?
        WHERE id = ? AND (ai_last_tick IS NULL OR ai_last_tick < ?)`,
    ).bind(tick, fac.id, tick).run();
    if (!(claim?.meta?.changes > 0)) return 0;
    const t0 = Date.now();
    let tally = null;
    let error = null;
    try {
      tally = await takeTurn(env, g, fac, row.solo_difficulty ?? 'normal', { trial: Number(row.trial) === 1 });
      if (sink) for (const [k, v] of Object.entries(tally)) sink[`${fac.ai_doctrine}:${k}`] = (sink[`${fac.ai_doctrine}:${k}`] ?? 0) + v;
    } catch (e) {
      error = String(e?.stack ?? e).slice(0, 1500);
      console.error(`ai turn failed ${gameId} ${fac.id}`, e);
    }
    if (Number(row.ai_log) === 1) {
      try {
        await env.DB.prepare(
          `INSERT INTO ai_turn_log (game_id, faction_id, tick, personality, tally, error, ms, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(gameId, fac.id, tick, fac.ai_personality ?? null, tally ? JSON.stringify(tally) : null,
               error, Date.now() - t0, Date.now()).run();
      } catch (e) { console.error('ai_turn_log write failed', e); }
    }
    return tally ? 1 : 0;
  })());
  const played = results.reduce((a, b) => a + b, 0);
  if (played > 0) {
    await env.DB.prepare('UPDATE games SET state_version = state_version + 1 WHERE id = ?').bind(gameId).run();
  }
  return played;
}

/** The cron's FALLBACK pass. The room plays its computer empires right
 *  after each tick (room.js runComputerEmpires); this catches any empire
 *  a whole tick behind (a pass that failed, a room that was evicted). */
export async function runSoloTurns(env) {
  const rows = (await env.DB.prepare(
    `SELECT g.id FROM games g
      WHERE g.solo = 1 AND g.status = 'active'
        -- A paused game's empires wait (a trial waits for its tutorial);
        -- a STEP plays them through the room's own pass.
        AND COALESCE(g.paused, 0) = 0
        AND EXISTS (SELECT 1 FROM game_factions f WHERE f.game_id = g.id AND f.ai_doctrine IS NOT NULL
                     AND f.status = 'active'
                     AND (f.ai_last_tick IS NULL OR f.ai_last_tick < COALESCE(g.current_tick, 0)))`,
  ).all()).results ?? [];
  for (const r of rows) {
    try { await runSoloGame(env, r.id, null, { lagOnly: true }); } catch (e) { console.error(`solo turns failed ${r.id}`, e); }
  }
}
