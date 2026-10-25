// ============================================================
// Who a computer empire IS (worker/aiEmpire.js): how it treats the
// others, and when it goes to war. Lorne's picks, 2026-10-24: three
// personalities, chosen per rival at setup or dealt by "Surprise me";
// actions only, no messages; difficulty is how sharply they play
// (aiTactics.js SHARPNESS), never what they are given.
//
//   ALLY     offers non-aggression pacts, then a defence pact and an intel
//            share to its closest partner (you, when you are in the game).
//            Declares on whoever goes to war with a partner. Never turns on
//            anyone unless wronged: break a pact with it or attack it, and
//            it holds a grudge.
//   WARLORD  refuses every pact. Once it has a fleet it picks a victim
//            (you, when you are in the game; else the weakest fleet it can
//            see) and comes for its weakest world. Makes peace only when it
//            is losing.
//   SNAKE    courts everyone: non-aggression pacts, then intel shares (which
//            let it watch their fleets). Builds warships all the while. When
//            the odds are good (on Ruthless, when the victim's fleet is away
//            or busy in another war) it declares on one partner, you first:
//            the declaration breaks the pact, and the chronicle says so.
//            Once it has taken something, or is losing, it makes peace, and
//            later starts courting again.
//
// The person is preferred, never required: in a game of computer empires
// alone (the overnight crucible) each one plays the same rules against
// the others.
//
// Its memory lives in game_factions.ai_state (JSON): grudges, when it
// last made peace with whom, the Snake's phase and victim.
// ============================================================

import { due, power, visibleFleet, myArmed, pickTarget, scout, SHARPNESS, ARMED } from './aiTactics.js';
import { factionTechLevels, gatingEnabled, hasFeature } from './researchUnlocks.js';

export const PERSONALITIES = ['ally', 'warlord', 'snake'];

/** "Surprise me", seat by seat, per difficulty. */
export const SURPRISE_DECKS = {
  peaceful: ['ally', 'ally', 'snake', 'warlord', 'ally'],
  normal: ['warlord', 'ally', 'snake', 'ally', 'warlord'],
  ruthless: ['warlord', 'snake', 'warlord', 'snake', 'ally'],
};

/** The economy each personality runs (aiEmpire.js DOCTRINES). */
export function doctrineFor(personality, seat) {
  if (personality === 'warlord') return 'rusher';
  if (personality === 'snake') return 'schemer';
  return seat % 2 === 0 ? 'expander' : 'economist';
}

/** The timings, in ticks, per difficulty.
 *  warlordFrom   the earliest a Warlord declares
 *  snakeFrom     the earliest a Snake looks for its opening
 *  snakePatience how long past snakeFrom it waits for a good one before
 *                it settles for an even fight
 *  cooldown      after a peace, how long before the same empire may be
 *                attacked by it again (and a Snake courts it again)
 *  wars          most wars a Warlord starts at once */
export const TIMING = {
  peaceful: { warlordFrom: 72, snakeFrom: 96, snakePatience: 48, cooldown: 96, wars: 1 },
  normal: { warlordFrom: 36, snakeFrom: 60, snakePatience: 60, cooldown: 48, wars: 1 },
  ruthless: { warlordFrom: 18, snakeFrom: 40, snakePatience: 72, cooldown: 24, wars: 2 },
};
/** A trial's Warlord declares from this tick. */
export const TRIAL_WARLORD_FROM = 20;
/** Ticks between two of its offers to the same empire. */
const OFFER_EVERY = 24;
/** A grudge lasts this long after the wrong. */
const GRUDGE_TICKS = 96;
/** Peace in a war outside its personality's plans: accepted after,
 *  offered after. */
const PEACE_AFTER = 24;
const PEACE_OFFER = 48;
/** The Warlord and the Snake make peace when their visible fleet is
 *  below this share of the enemy's. */
const LOSING = 0.5;
/** A war in which no world has changed hands for this many ticks ends in
 *  peace, whoever the empires are (the crucible: four wars open for 5000
 *  ticks, nobody attacking, nobody yielding). */
const STALEMATE = 150;
/** The defensive pacts (an Ally answers for these partners). */
const DEFENSIVE = new Set(['nap', 'defense_pact']);

/** Its memory, with defaults. */
export function readMemory(raw) {
  let m = {};
  try { m = raw ? JSON.parse(raw) : {}; } catch { m = {}; }
  return {
    grudge: m.grudge ?? {},       // factionId -> tick it ends
    peaceAt: m.peaceAt ?? {},     // factionId -> tick of the last peace
    worldsAt: m.worldsAt ?? {},   // factionId -> my world count when that war began
    snake: m.snake ?? 'court',    // 'court' | 'war'
    victim: m.victim ?? null,     // the Snake's (or Warlord's) current target
    since: m.since ?? 0,          // tick the phase began
    warLast: m.warLast ?? [],     // who it was at war with last turn
    front: m.front ?? {},         // factionId -> { key, since }: the war's map, unchanged since
    pending: m.pending ?? {},     // factionId -> id of my open offer to them
    snub: m.snub ?? {},           // factionId -> tick they declined or countered my offer
    favour: m.favour ?? {},       // factionId -> worth the Snake gave them beyond its price
    favourAt: m.favourAt ?? {},   // factionId -> tick of the latest such deal
    favourAsk: m.favourAsk ?? {}, // factionId -> id of its offer asking the favour back
  };
}

// ---- what it will trade (playtest R2-B10) -------------------------------
//
// "The AI refuses any resource terms": every request for goods got a flat
// "they ship no goods". Now each personality answers a request for goods
// in its own way, within reason (Lorne's picks for the three):
//   ALLY     generous: a small ask is a gift, a bigger one at half price
//   WARLORD  refuses: it trades with no one
//   SNAKE    accepts at a friendly discount, and REMEMBERS the favour:
//            later it asks for it back, and a refusal is a grudge
// None of this touches the economy: the goods move by the ordinary
// delivery, on its own freighter (crewDeliveries), at the ordinary rates.
// The values below are only how it weighs a bundle, not prices.

/** How it weighs a unit of each good (credits are the scarce one: the
 *  8:1 cross-pairing the economy runs on). */
export const TRADE_VALUE = { metal: 1, fuel: 0, gold: 8, science: 4 };
/** The most of any one stockpile it will part with in one deal. */
export const SPARE_SHARE = 0.25;
/** What it asks in return, as a share of what it gives. */
export const PRICE_SHARE = { ally: 0.5, snake: 0.75 };
/** An Ally gives this share of its stockpile's worth for nothing. */
export const ALLY_GIFT_SHARE = 0.05;
/** A favour the Snake asks back once it is worth this much. */
export const FAVOUR_ASK_AT = 40;
const GOODS = ['metal', 'gold', 'science'];

const bundle = (o, side) => Object.fromEntries(GOODS.map(k => [k, Math.max(0, Math.floor(Number(o[`${side}_${k}`] ?? 0)))]));
export const worth = (b) => GOODS.reduce((s, k) => s + (Number(b[k]) || 0) * TRADE_VALUE[k], 0);

/**
 * Its answer to an offer. Returns
 *   { action: 'accept', favour? }       favour: worth it gave beyond the
 *                                       price (the Snake remembers it)
 *   { action: 'decline', reason }       a trades.js DECLINE_REASONS code
 *   { action: 'counter', offer, request } the terms it would take
 * `o` is the trade_offers row, `purse` its own stockpile, `hauler`
 * whether a freighter of its own is free to carry what it gives.
 */
export function decideOffer(o, friendly, { personality, grudge = false, purse = {}, hauler = true } = {}) {
  let pacts = [];
  try { pacts = [...JSON.parse(o.offer_pacts || '[]'), ...JSON.parse(o.request_pacts || '[]')]; } catch { return { action: 'decline', reason: 'unknown_terms' }; }
  if (Number(o.request_fuel ?? 0) > 0 || Number(o.offer_fuel ?? 0) > 0) return { action: 'decline', reason: 'unknown_terms' };
  const give = bundle(o, 'request');   // what the proposer asks of it
  const get = bundle(o, 'offer');      // what the proposer gives it
  const giveV = worth(give);
  if (pacts.length && !friendly) {
    return { action: 'decline', reason: grudge && personality !== 'warlord' ? 'no_trust' : 'no_pacts' };
  }
  if (giveV <= 0) return { action: 'accept' };             // a gift, or pacts it wants
  if (personality === 'warlord') return { action: 'decline', reason: 'no_trade' };
  if (!friendly) return { action: 'decline', reason: 'no_trust' };
  if (Number(o.recurring ?? 0) === 1) return { action: 'decline', reason: 'one_off_only' };
  if (!hauler) return { action: 'decline', reason: 'no_freighter' };

  // What it can spare of each good, and the price it asks.
  const spare = Object.fromEntries(GOODS.map(k => [k, Math.floor(SPARE_SHARE * Math.max(0, Number(purse[k] ?? 0)))]));
  const share = PRICE_SHARE[personality] ?? 1;
  const freeUpTo = personality === 'ally' ? ALLY_GIFT_SHARE * worth(Object.fromEntries(GOODS.map(k => [k, Number(purse[k] ?? 0)]))) : 0;
  const priceOf = (v) => (v <= freeUpTo ? 0 : v * share);
  const fits = GOODS.every(k => give[k] <= spare[k]);
  const getV = worth(get);
  if (fits && getV >= priceOf(giveV)) {
    return { action: 'accept', favour: personality === 'snake' ? Math.max(0, Math.round(giveV - getV)) : 0 };
  }

  // A COUNTER: as much of the ask as it can spare, for its price, paid
  // in what they offered (else in what it is not giving away).
  const give2 = Object.fromEntries(GOODS.map(k => [k, Math.min(give[k], spare[k])]));
  const give2V = worth(give2);
  if (give2V <= 0) return { action: 'decline', reason: 'cannot_spare' };
  const need = priceOf(give2V);
  let request = { ...get };
  if (getV > need && getV > 0) {
    // They offered more than it now asks for the smaller load: scale down.
    const f = need / getV;
    request = Object.fromEntries(GOODS.map(k => [k, Math.ceil(get[k] * f)]));
  } else if (getV < need) {
    const payIn = GOODS.find(k => get[k] > 0)
      ?? (give2.gold > 0 ? 'metal' : 'gold');
    request = { ...get, [payIn]: get[payIn] + Math.ceil((need - getV) / TRADE_VALUE[payIn]) };
  }
  // The same terms straight back would be an accept, not a counter.
  const same = GOODS.every(k => give2[k] === give[k] && request[k] === get[k]);
  if (same) return { action: 'accept', favour: 0 };
  return { action: 'counter', offer: give2, request };
}

/** Its own freighters free to carry a shipment: active, on no route, on
 *  no other shipment, not mid-burn (trades.js handleDeliveryOptions). */
export async function idleFreighters(env, gameId, me) {
  return (await env.DB.prepare(
    `SELECT sh.id FROM game_ships sh
      WHERE sh.game_id = ? AND sh.owner_faction_id = ? AND sh.ship_class = 'freighter' AND sh.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM game_trade_routes r WHERE r.ship_id = sh.id AND r.cancelled_at_tick IS NULL)
        AND NOT EXISTS (SELECT 1 FROM game_trade_route_ships c JOIN game_trade_routes r ON r.id = c.route_id
                         AND r.cancelled_at_tick IS NULL WHERE c.ship_id = sh.id)
        AND NOT EXISTS (SELECT 1 FROM trade_deliveries d WHERE d.ship_id = sh.id AND d.resolved_at_tick IS NULL)
        AND NOT EXISTS (SELECT 1 FROM game_ship_nodes n WHERE n.ship_id = sh.id AND n.status IN ('committed','in_transit'))`,
  ).bind(gameId, me).all()).results ?? [];
}

/**
 * CREW WHAT IT OWES. Every shipment of a deal it agreed to, still with
 * no freighter, gets an idle one of its own, bound for the other side's
 * capital (else any world of theirs that can receive). Without this a
 * deal it accepted would stall half done.
 */
export async function crewDeliveries(env, gameId, me, call, note = () => {}) {
  const owed = (await env.DB.prepare(
    `SELECT d.id, d.trade_id, d.recipient_faction_id FROM trade_deliveries d
      WHERE d.game_id = ? AND d.sender_faction_id = ? AND d.status = 'unassigned' AND d.resolved_at_tick IS NULL
      ORDER BY d.created_at_tick`,
  ).bind(gameId, me).all()).results ?? [];
  if (!owed.length) return;
  const free = await idleFreighters(env, gameId, me);
  for (const d of owed) {
    const ship = free.shift();
    if (!ship) {
      // None free: one on the ways will do, else it orders one at its
      // capital (it agreed to the deal knowing it could: canHaul).
      const onOrder = await env.DB.prepare(
        `SELECT 1 AS x FROM game_body_build_queue
          WHERE game_id = ? AND faction_id = ? AND ship_class = 'freighter' AND cancelled_at_tick IS NULL LIMIT 1`,
      ).bind(gameId, me).first();
      if (!onOrder) {
        const home = await env.DB.prepare('SELECT capital_body_id FROM game_factions WHERE id = ?').bind(me).first();
        if (home?.capital_body_id) {
          note('crew_order', await call('POST', `/bodies/${encodeURIComponent(home.capital_body_id)}/build`, { ship_class: 'freighter' }));
        }
      } else note('crew_waits');
      break;
    }
    const dest = await env.DB.prepare(
      `SELECT s.body_id FROM game_settlements s
         JOIN game_bodies b ON b.id = s.body_id AND b.game_id = s.game_id
         JOIN game_factions f ON f.id = s.owner_faction_id
        WHERE s.game_id = ? AND s.owner_faction_id = ? AND b.terraformed_at_tick IS NOT NULL
          AND s.destroyed_at_tick IS NULL AND b.destroyed_at_tick IS NULL
        ORDER BY CASE WHEN s.body_id = f.capital_body_id THEN 0 ELSE 1 END LIMIT 1`,
    ).bind(gameId, d.recipient_faction_id).first();
    if (!dest) { note('crew_no_dest'); continue; }
    note('crew', await call('POST', `/trades/${encodeURIComponent(d.trade_id)}/deliveries/${encodeURIComponent(d.id)}/assign`,
      { ship_id: ship.id, dest_body_id: dest.body_id }));
  }
}

/** Can it carry a shipment: a freighter free now, or one it is allowed to
 *  build (Propulsion 1; crewDeliveries orders it). */
export async function canHaul(env, gameId, me, freeCount) {
  if (freeCount > 0) return true;
  const [levels, gated] = await Promise.all([factionTechLevels(env, gameId, me), gatingEnabled(env, gameId)]);
  return hasFeature('hull.freighter', levels, gated);
}

/** Who it is willing to sign with, from its memory alone. */
export function friendlyFrom(personality, mem, tick, f) {
  if ((mem.grudge[f] ?? -1) > tick) return false;
  if (personality === 'warlord') return false;
  if (personality === 'snake') return !(mem.snake === 'war' && mem.victim === f);
  return true;
}

/**
 * Answer every open offer addressed to it: accept, decline with a
 * reason, or counter. Shared by its turn and by the instant answer to a
 * person's offer (answerNow), so both say the same thing.
 */
export async function answerInbox(env, { gameId, me, personality, mem, tick, call, note = () => {}, only = null }) {
  const inbox = (await env.DB.prepare(
    `SELECT id, proposer_faction_id, request_metal, request_fuel, request_gold, request_science,
            offer_metal, offer_fuel, offer_gold, offer_science, offer_pacts, request_pacts, recurring
       FROM trade_offers WHERE game_id = ? AND responder_faction_id = ? AND status = 'open'`,
  ).bind(gameId, me).all()).results ?? [];
  if (!inbox.length) return 0;
  const purse = await env.DB.prepare('SELECT metal, gold, science FROM game_factions WHERE id = ?').bind(me).first() ?? {};
  let free = (await idleFreighters(env, gameId, me)).length;
  // One shipment at a time on a freighter still to be built.
  let canBuild = free > 0 ? false : await canHaul(env, gameId, me, 0);
  let gave = false;
  for (const o of inbox) {
    if (only && o.id !== only) continue;
    const f = o.proposer_faction_id;
    const d = decideOffer(o, friendlyFrom(personality, mem, tick, f), {
      personality, grudge: (mem.grudge[f] ?? -1) > tick, purse, hauler: free > 0 || canBuild,
    });
    const path = `/trades/${encodeURIComponent(o.id)}`;
    if (d.action === 'accept') {
      const r = await call('POST', `${path}/accept`, {});
      note('offer_accept', r);
      if (r.ok && worth(bundle(o, 'request')) > 0) {
        if (free > 0) free -= 1; else canBuild = false;
        gave = true;
      }
      if (r.ok && d.favour > 0) {
        mem.favour[f] = (mem.favour[f] ?? 0) + d.favour;
        mem.favourAt[f] = tick;
      }
    } else if (d.action === 'counter') {
      note('offer_counter', await call('POST', `${path}/counter`, {
        offer: d.offer, request: d.request, offer_pacts: [], request_pacts: [],
      }));
    } else {
      // A REAL ANSWER. A no that says why (a counter asking it for goods
      // was declined in silence, and read as ignored).
      note('offer_decline', await call('POST', `${path}/decline`, { reason: d.reason }));
    }
  }
  if (gave) await crewDeliveries(env, gameId, me, call, note);
  return inbox.length;
}

/**
 * THE SNAKE CALLS IN ITS FAVOURS. Once what it gave beyond its price is
 * worth FAVOUR_ASK_AT, it asks for that worth back in credits (or metal,
 * if they have none to speak of), nothing offered. Paid, the favour is
 * settled; refused, it holds a grudge.
 */
async function callInFavours(ctx, mem, rivals, offered, warWith) {
  const { env, gameId, call, note, view } = ctx;
  const tick = view.tick;
  for (const f of rivals) {
    const owed = Number(mem.favour[f] ?? 0);
    if (owed < FAVOUR_ASK_AT || warWith.has(f) || mem.favourAsk[f]) continue;
    if (tick - Number(mem.favourAt[f] ?? tick) < OFFER_EVERY) continue;
    const them = await env.DB.prepare('SELECT gold, metal FROM game_factions WHERE id = ?').bind(f).first();
    const inGold = Math.ceil(owed / TRADE_VALUE.gold);
    const request = Number(them?.gold ?? 0) >= inGold ? { gold: inGold } : { metal: Math.ceil(owed) };
    const r = await call('POST', '/trades', {
      responder_faction_id: f, offer: {}, request, offer_pacts: [], request_pacts: [],
    });
    note('favour_ask', r);
    if (r.ok && r.data?.trade?.id) { mem.favourAsk[f] = r.data.trade.id; offered.add(f); }
  }
  // How the asks went.
  for (const [f, id] of Object.entries(mem.favourAsk)) {
    const row = await env.DB.prepare('SELECT status FROM trade_offers WHERE id = ?').bind(id).first();
    if (!row || row.status === 'open') continue;
    if (row.status !== 'accepted') mem.grudge[f] = Math.max(mem.grudge[f] ?? 0, tick + GRUDGE_TICKS);
    delete mem.favour[f];
    delete mem.favourAt[f];
    delete mem.favourAsk[f];
    note(row.status === 'accepted' ? 'favour_repaid' : 'favour_refused');
  }
}

/** The pacts on my side of the table, by other faction. */
async function myTreaties(env, gameId, me) {
  const rows = (await env.DB.prepare(
    `SELECT t.kind, t.status, t.broken_at_tick, t.breaker_faction_id,
            o.faction_id AS other, m.signed_at_tick AS mine_at, o.signed_at_tick AS theirs_at
       FROM treaties t
       JOIN treaty_signatories m ON m.treaty_id = t.id AND m.faction_id = ?
       JOIN treaty_signatories o ON o.treaty_id = t.id AND o.faction_id != ?
      WHERE t.game_id = ?`,
  ).bind(me, me, gameId).all()).results ?? [];
  const live = new Map();     // other -> [{kind, since}]
  const broken = [];          // {other, by, at}
  for (const r of rows) {
    if (r.status === 'active' && r.mine_at != null && r.theirs_at != null) {
      if (!live.has(r.other)) live.set(r.other, []);
      live.get(r.other).push({ kind: r.kind, since: Math.max(Number(r.mine_at), Number(r.theirs_at)) });
    } else if (r.status === 'broken') {
      broken.push({ other: r.other, by: r.breaker_faction_id, at: Number(r.broken_at_tick ?? 0) });
    }
  }
  return { live, broken };
}

/** My open offers, by responder. */
async function myOpenOffers(env, gameId, me) {
  const rows = (await env.DB.prepare(
    `SELECT responder_faction_id FROM trade_offers WHERE game_id = ? AND proposer_faction_id = ? AND status = 'open'`,
  ).bind(gameId, me).all()).results ?? [];
  return new Set(rows.map(r => r.responder_faction_id));
}

/** Small, stable per-pair offset, so one empire's offers to several
 *  others land on different ticks rather than all at once. */
function spread(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 997;
  return h % OFFER_EVERY;
}

/**
 * One turn of diplomacy. Returns { foes, force, mem, prey }: who to fight
 * this turn (every empire it is at war with), whether a strike was just
 * launched (fight now whatever the odds), its updated memory, and the
 * victim its strike goes for first (null: any foe).
 */
export async function conduct(env, ctx) {
  const { view, rm, call, note, personality, difficulty, last, wars, gameId } = ctx;
  const mem = ctx.mem;
  const tick = view.tick;
  const me = view.me;
  const H = view.human;
  // A Play for Free trial (trial.js): the Warlord comes at tick 20,
  // about ten minutes in at 30 s ticks (Lorne's pick).
  const T = ctx.trial ? { ...(TIMING[difficulty] ?? TIMING.normal), warlordFrom: TRIAL_WARLORD_FROM }
                      : (TIMING[difficulty] ?? TIMING.normal);
  const sharp = SHARPNESS[difficulty] ?? SHARPNESS.normal;
  const enemyOf = (w) => (w.faction_a === me ? w.faction_b : w.faction_a);
  // A war with an empire that is gone never formally ends: ignore it (the
  // crucible scouted a dead capital 200 times and filed bills against it).
  const standing = (f) => view.factions.get(f)?.status === 'active';
  const myWars = wars.filter(w => (w.faction_a === me || w.faction_b === me) && standing(enemyOf(w)));
  const warWith = new Map(myWars.map(w => [enemyOf(w), w]));
  const { live: pacts, broken } = await myTreaties(env, gameId, me);
  const offered = await myOpenOffers(env, gameId, me);
  const myWorlds = [...view.owner.values()].filter(o => o === me).length;
  const rivals = [...view.factions.values()]
    .filter(f => f.id !== me && f.status === 'active').map(f => f.id);

  // ---- memory --------------------------------------------------------
  for (const b of broken) {
    if (b.by && b.by !== me && tick - b.at <= GRUDGE_TICKS) mem.grudge[b.by] = Math.max(mem.grudge[b.by] ?? 0, b.at + GRUDGE_TICKS);
  }
  for (const w of myWars) {
    if (w.declared_by && w.declared_by !== me) {
      mem.grudge[w.declared_by] = Math.max(mem.grudge[w.declared_by] ?? 0, Number(w.declared_at_tick ?? tick) + GRUDGE_TICKS);
    }
    if (mem.worldsAt[enemyOf(w)] == null) mem.worldsAt[enemyOf(w)] = myWorlds;
  }
  for (const f of Object.keys(mem.worldsAt)) if (!warWith.has(f)) delete mem.worldsAt[f];
  // The front: both sides' world counts. Unchanged for STALEMATE ticks,
  // the war is going nowhere.
  const worldsOf = (f) => [...view.owner.values()].filter(o => o === f).length;
  for (const f of warWith.keys()) {
    const key = `${myWorlds}:${worldsOf(f)}`;
    if (mem.front[f]?.key !== key) mem.front[f] = { key, since: tick };
  }
  for (const f of Object.keys(mem.front)) if (!warWith.has(f)) delete mem.front[f];
  const stalled = (f) => warWith.has(f) && tick - (mem.front[f]?.since ?? tick) >= STALEMATE;
  // A war that was there last turn and is gone now ended in peace.
  for (const f of mem.warLast) if (!warWith.has(f)) mem.peaceAt[f] = tick;
  mem.warLast = [...warWith.keys()];

  const grudge = (f) => (mem.grudge[f] ?? -1) > tick;
  const cooled = (f) => tick - (mem.peaceAt[f] ?? -9999) >= T.cooldown;
  const pactsWith = (f) => pacts.get(f) ?? [];
  const hasPeace = (f) => pactsWith(f).some(p => DEFENSIVE.has(p.kind));
  const losing = (f) => {
    const mineP = power(myArmed(view));
    const theirs = power(visibleFleet(view, f));
    return (theirs > 0 && mineP < LOSING * theirs) || myWorlds < (mem.worldsAt[f] ?? myWorlds);
  };
  const tookSomething = (f) => myWorlds > (mem.worldsAt[f] ?? myWorlds);
  /** My warships in flight to one of f's worlds. */
  const striking = (f) => [...view.inbound].some(([bodyId, list]) => view.owner.get(bodyId) === f
    && list.some(s => s.owner_faction_id === me && ARMED.has(s.ship_class)));
  const ageOf = (f) => tick - Number(warWith.get(f)?.declared_at_tick ?? tick);
  const theyOffered = (f) => !!warWith.get(f)?.ceasefire_by && warWith.get(f).ceasefire_by === f;

  const declare = async (f, label) => {
    const r = await call('POST', '/wars/declare', { target_faction_id: f });
    note(label, r);
    if (r.ok) { mem.worldsAt[f] = myWorlds; warWith.set(f, { declared_by: me, declared_at_tick: tick }); }
    return r.ok;
  };
  const endWar = async (f, label) => note(label, await call('POST', '/wars/end', { target_faction_id: f }));
  // NOT THE SAME OFFER STRAIGHT BACK. An offer of mine they declined or
  // countered is a "no" to those terms: it is not made again for a full
  // OFFER_EVERY ticks (playtest 2026-10-24: a countered pact was declined
  // in silence and re-sent unchanged).
  for (const [f, id] of Object.entries(mem.pending)) {
    if (offered.has(f)) continue;
    const row = await env.DB.prepare('SELECT status FROM trade_offers WHERE id = ?').bind(id).first();
    if (row?.status === 'declined' || row?.status === 'countered') mem.snub[f] = tick;
    delete mem.pending[f];
  }
  const snubbed = (f) => tick - (mem.snub[f] ?? -Infinity) < OFFER_EVERY;
  const offerPacts = async (f, kinds, label) => {
    if (offered.has(f) || snubbed(f)) return;
    const r = await call('POST', '/trades', {
      responder_faction_id: f, offer: {}, request: {}, offer_pacts: kinds, request_pacts: [],
    });
    note(label, r);
    if (r.ok) {
      offered.add(f);
      if (r.data?.trade?.id) mem.pending[f] = r.data.trade.id;
    }
  };
  // Who it is willing to sign with.
  const friendlyTo = (f) => friendlyFrom(personality, mem, tick, f);

  // ---- offers addressed to me ----------------------------------------
  // (A person's offer is usually answered the moment it is made:
  // answerNow. This catches the rest.)
  await answerInbox(env, { gameId, me, personality, mem, tick, call, note });
  // What it owes from deals already agreed.
  await crewDeliveries(env, gameId, me, call, note);
  if (personality === 'snake') await callInFavours({ env, gameId, call, note, view }, mem, rivals, offered, warWith);

  let force = false;
  const handled = new Set();   // wars whose peace this personality decided

  // ---- ALLY ----------------------------------------------------------
  if (personality === 'ally') {
    for (const f of rivals) {
      if (warWith.has(f)) continue;
      if (grudge(f) && !hasPeace(f) && difficulty !== 'peaceful') { await declare(f, 'declare_grudge'); continue; }
      if (!hasPeace(f) && !grudge(f) && due(tick, last, OFFER_EVERY, spread(f))) await offerPacts(f, ['nap'], 'offer_nap');
    }
    // One closest partner: the person when present, else its oldest pact.
    const partners = rivals.filter(hasPeace);
    const best = (H && partners.includes(H)) ? H
      : partners.sort((a, b) => Math.min(...pactsWith(a).map(p => p.since)) - Math.min(...pactsWith(b).map(p => p.since)))[0];
    if (best && !pactsWith(best).some(p => p.kind === 'defense_pact')
        && tick - Math.min(...pactsWith(best).map(p => p.since)) >= 24 && due(tick, last, OFFER_EVERY * 2, 7)) {
      await offerPacts(best, ['defense_pact', 'intel_share'], 'offer_alliance');
    }
    // A partner's wars are its wars (never at the cost of breaking a pact).
    for (const p of partners) {
      for (const x of view.enemiesOf(p)) {
        if (x === me || warWith.has(x) || hasPeace(x) || view.factions.get(x)?.status === 'monster') continue;
        if (myArmed(view).length >= 2 && due(tick, last, 6, 1)) await declare(x, 'declare_for_ally');
      }
    }
    for (const [f] of warWith) {
      if (view.factions.get(f)?.status === 'monster') continue;
      if (stalled(f)) continue;
      handled.add(f);
      // It keeps fighting a partner's enemy while that war lasts.
      if (partners.some(p => view.atWar(p, f))) continue;
      if (theyOffered(f) && (!grudge(f) || ageOf(f) >= PEACE_AFTER)) await endWar(f, 'ceasefire_accept');
      else if (!warWith.get(f).ceasefire_by && !grudge(f) && ageOf(f) >= 12) await endWar(f, 'ceasefire_offer');
    }
  }

  // ---- WARLORD -------------------------------------------------------
  if (personality === 'warlord') {
    const started = [...warWith.values()].filter(w => w.declared_by === me).length;
    if (tick >= T.warlordFrom && started < T.wars && myArmed(view).length >= 3) {
      // The person first; else the weakest fleet it can see.
      const open = rivals.filter(f => !warWith.has(f) && cooled(f) && view.factions.get(f)?.status !== 'monster');
      const victim = (H && open.includes(H)) ? H
        : open.sort((a, b) => power(visibleFleet(view, a)) - power(visibleFleet(view, b)))[0];
      if (victim && await declare(victim, victim === H ? 'declare' : 'declare_rival')) mem.victim = victim;
    }
    for (const [f] of warWith) {
      if (view.factions.get(f)?.status === 'monster' || stalled(f)) continue;
      handled.add(f);
      // Not beaten before it has fought: a war it just declared, or one
      // whose strike is still in flight, is not judged by fleet counts
      // (playtest 2026-10-24: outnumbered by a trial's head start, it
      // offered peace before its corvettes had even arrived).
      const beaten = losing(f) && ageOf(f) >= PEACE_AFTER && !striking(f);
      if (theyOffered(f) && beaten) await endWar(f, 'ceasefire_accept');
      else if (!warWith.get(f).ceasefire_by && beaten) await endWar(f, 'ceasefire_offer');
    }
  }

  // ---- SNAKE ---------------------------------------------------------
  if (personality === 'snake') {
    if (mem.snake === 'war' && mem.victim && !warWith.has(mem.victim)) { mem.snake = 'court'; mem.since = tick; mem.victim = null; }
    // Court everyone it is not at war with.
    for (const f of rivals) {
      if (warWith.has(f) || !friendlyTo(f)) continue;
      if (!hasPeace(f) && cooled(f) && due(tick, last, OFFER_EVERY, spread(f))) await offerPacts(f, ['nap'], 'offer_nap');
      else if (hasPeace(f) && !pactsWith(f).some(p => p.kind === 'intel_share') && due(tick, last, OFFER_EVERY * 2, (spread(f) + 9) % 48)) {
        await offerPacts(f, ['intel_share'], 'offer_intel');
      }
    }
    if (mem.snake === 'court' && tick >= T.snakeFrom - 12) {
      // Its victim: the person first, else whichever partner offers the
      // best opening. It must see them first: a friendly visit to their
      // capital (an intel share makes that moot).
      const candidates = (H && !warWith.has(H) && cooled(H)) ? [H]
        : rivals.filter(f => !warWith.has(f) && cooled(f) && view.factions.get(f)?.status !== 'monster');
      const strike = myArmed(view);
      let best = null;
      for (const f of candidates) {
        if (!strike.length) break;
        const tgt = await pickTarget(view, rm, new Set([f]), strike, { opening: true, against: new Set([f]) });
        if (tgt && (!best || tgt.score > best.tgt.score)) best = { f, tgt };
      }
      if (!best && strike.length) {
        const f = candidates[0];
        const r = f ? await scout(view, rm, call, view.factions.get(f)?.capital_body_id) : null;
        if (r) note('snake_visit', r);
      }
      if (best && tick >= T.snakeFrom) {
        const mine = power(strike);
        const patient = tick < T.snakeFrom + T.snakePatience;
        const busy = view.enemiesOf(best.f).length > 0;
        const away = best.tgt.guarded === 0 && visibleFleet(view, best.f).length > 0;
        const odds = mine >= Math.max(sharp.margin, 1) * best.tgt.theirs;
        const go = difficulty === 'peaceful'
          ? true
          : difficulty === 'ruthless'
            ? (odds && (busy || away)) || (!patient && mine >= best.tgt.theirs)
            : odds || (!patient && mine >= best.tgt.theirs);
        if (go && await declare(best.f, best.f === H ? 'betray' : 'betray_rival')) {
          mem.snake = 'war';
          mem.victim = best.f;
          mem.since = tick;
          force = true;
        } else note('snake_waits');
      }
    }
    if (mem.snake === 'war' && mem.victim && warWith.has(mem.victim) && !stalled(mem.victim)) {
      const v = mem.victim;
      handled.add(v);
      if (theyOffered(v) && (tookSomething(v) || losing(v))) await endWar(v, 'ceasefire_accept');
      else if (!warWith.get(v).ceasefire_by && (tookSomething(v) || losing(v))) await endWar(v, 'ceasefire_offer');
    }
  }

  // ---- a stalemate ends every war, whatever the personality -------------
  for (const [f, w] of warWith) {
    if (!stalled(f) || view.factions.get(f)?.status === 'monster') continue;
    handled.add(f);
    if (theyOffered(f)) await endWar(f, 'stalemate_accept');
    else if (!w.ceasefire_by) await endWar(f, 'stalemate_offer');
  }

  // ---- every other war: fight back, then make peace -------------------
  for (const [f, w] of warWith) {
    if (handled.has(f) || view.factions.get(f)?.status === 'monster') continue;
    if (theyOffered(f) && ageOf(f) >= PEACE_AFTER) await endWar(f, 'peace_accept');
    else if (!w.ceasefire_by && ageOf(f) >= PEACE_OFFER) await endWar(f, 'peace_offer');
  }

  // The view was read before this turn's declarations: add them.
  const foes = new Set(view.enemiesOf(me).filter(standing));
  for (const [f, w] of warWith) if (w.declared_by === me && w.declared_at_tick === tick) foes.add(f);
  // The one it came for: a Warlord's or a Snake's strike goes at its
  // victim, not at whoever else joined the war (an Ally answering for its
  // partner turned the trial's Warlord away from the player).
  const prey = (personality === 'warlord' || (personality === 'snake' && mem.snake === 'war'))
    && mem.victim && foes.has(mem.victim) ? mem.victim : null;
  return { foes, force, mem, prey };
}

/** How it votes: for itself, for its friends, against its enemies. */
export function voteFor(p, ctx) {
  const { me, human, personality, enemies, mem, tick } = ctx;
  if (p.proposer_faction_id === me) return 'yea';
  let payload = {};
  try { payload = JSON.parse(p.payload || '{}'); } catch { payload = {}; }
  const target = payload?.target_faction_id ?? null;
  if (target === me) return 'nay';
  const wronged = (f) => (mem.grudge[f] ?? -1) > tick;
  const friendOf = (f) => !!f && !enemies.has(f) && !wronged(f)
    && (personality === 'ally' || (personality === 'snake' && mem.victim !== f));
  if (friendOf(p.proposer_faction_id)) return 'yea';
  if (target && friendOf(target)) return 'nay';
  if (target && enemies.has(target)) return 'yea';
  if (p.proposer_faction_id && enemies.has(p.proposer_faction_id)) return 'nay';
  if (personality === 'warlord' && human) {
    if (p.proposer_faction_id === human) return 'nay';
    if (target === human) return 'yea';
  }
  // A chancellor bid can end the game: only a friend's gets its vote.
  if (p.kind === 'chancellor_vote') return friendOf(p.proposer_faction_id) ? 'yea' : 'nay';
  return 'abstain';
}
