// ============================================================
// How a computer empire SEES and FIGHTS (worker/aiEmpire.js).
//
// FOG-HONEST. Everything here about other empires comes from the
// empire's own GET /state: the same payload, cut by the same sensors and
// fog, that a person's client gets. A rival's fleet it cannot see does
// not exist to it; an ally's intel share widens what it sees, exactly as
// it would for a person. (Version one read the tables directly and saw
// through the fog: the cheating Lorne ruled out.)
//
// SHARPNESS is the difficulty (Lorne, 2026-10-24): how well it plays,
// never what it is given.
//   peaceful  loose: attacks the nearest world with everything it has,
//             leaves nothing home, never retreats
//   normal    weighs a fight before it picks one, keeps a home guard,
//             answers an attack on its worlds, pulls out of a lost fight
//   ruthless  all of that with a wider margin and a bigger guard, and it
//             prefers worlds whose fleet has just left
// ============================================================

import { isFarSystemBody } from './systems.js';
import { hullLimits } from './legGuard.js';
import { legTicks } from './burn.js';

export const ARMED = new Set(['corvette', 'frigate', 'destroyer', 'capital']);

/** Did a multiple of `every` (shifted by `offset`) pass since the last
 *  turn? `last` null: the empire's first turn. Turns can skip ticks (a
 *  30 s game ticks twice between two cron minutes), so never `tick % N`. */
export function due(tick, last, every, offset = 0) {
  if (!(every > 0)) return false;
  if (last == null) return true;
  return Math.floor((tick - offset) / every) > Math.floor((last - offset) / every);
}

/** The numbers each difficulty plays by. `margin`: its strength over
 *  what it can see at the target before it commits; `guard`: share of
 *  its warships kept at home; `defend` / `retreat`: whether it answers an
 *  inbound attack and leaves a fight it is losing (`retreatAt`: the
 *  enemy's edge that sends it home). */
export const SHARPNESS = {
  peaceful: { margin: 0, guard: 0, defend: false, retreat: false, retreatAt: Infinity, opening: false },
  normal: { margin: 1.5, guard: 0.25, defend: true, retreat: true, retreatAt: 1.5, opening: false },
  ruthless: { margin: 2.0, guard: 0.35, defend: true, retreat: true, retreatAt: 1.25, opening: true },
};

/** Settlement value as a prize: a capital is worth most. */
const PRIZE = { capital: 3, city: 2, station: 1 };

/** Fighting strength of a group: Lanchester's square law in miniature,
 *  total hull times total firepower, so twice the ships is four times
 *  the strength. Settlements add their hull (they soak fire). */
export function power(ships, settlementHp = 0) {
  let hp = settlementHp;
  let dps = 0;
  for (const s of ships) {
    hp += Math.max(0, Number(s.hp) || 0);
    dps += Math.max(0, Number(s.damage_per_tick) || 0);
  }
  return hp * Math.max(dps, ships.length ? 1 : 0);
}

/**
 * The empire's picture of the board, from its own /state.
 *   me, tick, factions (by id), human (the person's faction id)
 *   at[bodyId]          visible parked ships, by owner
 *   inbound[bodyId]     visible ships in flight to it, with arrival ticks
 *   owner[bodyId]       visible owner of each world
 *   prize[bodyId]       what a world is worth (settlement kind)
 *   settleHp[bodyId]    settlement hull at a world
 *   mine                my ships, parked and idle, by body
 *   wars                pairs at war (public), peace / allies (mine)
 */
export function readView(v) {
  const meId = v.me.faction_id;
  const tick = Number(v.game.current_tick ?? 0);
  const factions = new Map((v.factions ?? []).map(f => [f.id, f]));
  const human = (v.factions ?? []).find(f => !f.ai && f.status !== 'monster')?.id ?? null;

  const flying = new Map();
  for (const n of v.nodes ?? []) {
    const arr = Number(n.arrival_at_tick);
    if (n.target_body_id && Number.isFinite(arr) && arr >= tick) {
      const prev = flying.get(n.ship_id);
      if (!prev || arr > prev.arrival) flying.set(n.ship_id, { target: n.target_body_id, arrival: arr });
    }
  }

  const at = new Map();
  const inbound = new Map();
  const mine = new Map();
  for (const s of v.ships ?? []) {
    if (!(Number(s.hp) > 0) || s.status === 'destroyed') continue;
    if (s.ship_class === 'missile' || s.missile_count != null) continue;
    const fl = flying.get(s.id);
    if (fl) {
      if (!inbound.has(fl.target)) inbound.set(fl.target, []);
      inbound.get(fl.target).push({ ...s, arrival: fl.arrival });
      continue;
    }
    if (!s.parent_body_id) continue;
    if (!at.has(s.parent_body_id)) at.set(s.parent_body_id, new Map());
    const byOwner = at.get(s.parent_body_id);
    if (!byOwner.has(s.owner_faction_id)) byOwner.set(s.owner_faction_id, []);
    byOwner.get(s.owner_faction_id).push(s);
    if (s.owner_faction_id === meId) {
      if (!mine.has(s.parent_body_id)) mine.set(s.parent_body_id, []);
      mine.get(s.parent_body_id).push(s);
    }
  }

  const owner = new Map();
  const bodies = new Map();
  for (const b of v.bodies ?? []) {
    bodies.set(b.id, b);
    if (b.owner_faction_id) owner.set(b.id, b.owner_faction_id);
  }
  const prize = new Map();
  const settleHp = new Map();
  const capitals = new Set((v.factions ?? []).map(f => f.capital_body_id).filter(Boolean));
  for (const st of v.settlements ?? []) {
    if (!(Number(st.hp) > 0)) continue;
    const kind = capitals.has(st.body_id) ? 'capital' : st.type === 'city' ? 'city' : 'station';
    prize.set(st.body_id, Math.max(prize.get(st.body_id) ?? 0, PRIZE[kind]));
    settleHp.set(st.body_id, (settleHp.get(st.body_id) ?? 0) + Number(st.hp));
    if (!owner.has(st.body_id) && st.owner_faction_id) owner.set(st.body_id, st.owner_faction_id);
  }

  const wars = new Set();
  for (const pair of v.war_pairs ?? []) {
    const [a, b] = Array.isArray(pair) ? pair : String(pair).split('|');
    if (a && b) wars.add(`${a}|${b}`).add(`${b}|${a}`);
  }
  return {
    me: meId, tick, factions, human, at, inbound, mine, owner, bodies, prize, settleHp, capitals,
    capital: v.me.capital_body_id ?? null,
    peace: new Set(v.me.peace_faction_ids ?? []),
    allies: new Set(v.me.ally_faction_ids ?? []),
    atWar: (a, b) => wars.has(`${a}|${b}`),
    enemiesOf: (id) => [...factions.keys()].filter(f => f !== id && wars.has(`${id}|${f}`)),
  };
}

/** Visible warships an owner has parked at a body. */
export function shipsAt(view, bodyId, ownerId) {
  return (view.at.get(bodyId)?.get(ownerId) ?? []).filter(s => ARMED.has(s.ship_class));
}

/** Warships parked at a body that would fight me there: anyone at war
 *  with me, or (planning a war not yet declared) anyone in `hostile`. */
export function defendersAt(view, bodyId, hostile = null) {
  const out = [];
  for (const [ownerId, list] of view.at.get(bodyId) ?? []) {
    if (ownerId === view.me) continue;
    if (view.atWar(view.me, ownerId) || hostile?.has(ownerId)) out.push(...list.filter(s => ARMED.has(s.ship_class)));
  }
  return out;
}

/** My idle warships, by body. */
export function myArmed(view) {
  const out = [];
  for (const [bodyId, list] of view.mine) {
    for (const s of list) if (ARMED.has(s.ship_class)) out.push({ ...s, parent_body_id: bodyId });
  }
  return out;
}

/** The whole visible fleet of a faction (parked and flying). */
export function visibleFleet(view, ownerId) {
  const out = [];
  for (const byOwner of view.at.values()) out.push(...(byOwner.get(ownerId) ?? []).filter(s => ARMED.has(s.ship_class)));
  for (const list of view.inbound.values()) out.push(...list.filter(s => s.owner_faction_id === ownerId && ARMED.has(s.ship_class)));
  return out;
}

/**
 * The world to hit among `foes`, or null. Worth / (1 + what guards it
 * relative to my strike) / (1 + trip length): a rich, thin, near world
 * first. `opening` (ruthless) doubles the score of a world whose own
 * fleet has gone (its owner's ships are elsewhere).
 */
export async function pickTarget(view, rm, foes, strike, { opening = false, against = null } = {}) {
  const from = strike[0]?.parent_body_id;
  if (!from) return null;
  const mine = power(strike);
  let best = null;
  for (const [bodyId, ownerId] of view.owner) {
    if (!foes.has(ownerId)) continue;
    const b = view.bodies.get(bodyId);
    if (!b || isFarSystemBody(b)) continue;
    const guard = defendersAt(view, bodyId, against);
    const theirs = power(guard, view.settleHp.get(bodyId) ?? 0);
    const legs = await rm.computeLegTicks(view.me, from, bodyId, view.tick).catch(() => 99);
    let score = (view.prize.get(bodyId) ?? 0.5) / (1 + theirs / Math.max(mine, 1)) / (1 + legs / 20);
    if (opening && guard.length === 0 && visibleFleet(view, ownerId).length > 0) score *= 2;
    if (!best || score > best.score) best = { bodyId, ownerId, theirs, guarded: guard.length, legs, score };
  }
  return best;
}

/**
 * Send `ships` to a world, all arriving together (the slowest leg).
 *
 * The arrival must pass the LEG GUARD (legGuard.js), which times the
 * straight line from where the hull is to where the target will be, at
 * that hull's own top push. The route timer is the first guess; the
 * guard's own rule, per hull, is the check, so an order is never refused
 * as too fast (staging, 2026-10-24: a retreat refused 13 turns running).
 * The batch answers 200 with per-order refusals, so the result says
 * `ok` only when every order landed.
 */
export async function sendAll(view, rm, call, ships, bodyId) {
  const go = ships.filter(s => s.parent_body_id !== bodyId).slice(0, 50);
  if (!go.length) return null;
  const limits = await hullLimits(view.db, view.gameId, go.map(s => s.id)).catch(() => new Map());
  let arrive = view.tick + 1;
  const legsFrom = new Map();
  for (const s of go) {
    if (!legsFrom.has(s.parent_body_id)) {
      legsFrom.set(s.parent_body_id, Number(await rm.computeLegTicks(view.me, s.parent_body_id, bodyId, view.tick)));
    }
    arrive = Math.max(arrive, view.tick + Math.max(1, legsFrom.get(s.parent_body_id)));
  }
  // The guard's own sum, twice over (the target moves with the arrival).
  for (let pass = 0; pass < 2; pass++) {
    const to = await rm.bodyPosAt(bodyId, arrive);
    for (const s of go) {
      const a0 = limits.get(s.id);
      if (!(a0 > 0)) continue;
      const from = await rm.bodyPosAt(s.parent_body_id, view.tick);
      const legal = legTicks(Math.max(0.01, Math.hypot(to.x - from.x, to.y - from.y)), a0);
      arrive = Math.max(arrive, view.tick + Math.ceil(legal) + 1);
    }
  }
  const orders = go.map(s => ({ ship_id: s.id, target_body_id: bodyId, scheduled_t: view.tick, arrival_t: arrive, replace: true }));
  const r = await call('POST', '/transfers', { orders });
  const refused = (r.data?.results ?? []).filter(x => x && x.ok === false);
  if (r.ok && refused.length) {
    return { ok: false, status: r.status, data: { error: { code: refused[0].error?.code ?? 'refused' } } };
  }
  return r;
}

/**
 * Go and look. Under fog an empire may not see a single world of its
 * enemy's; a capital's place is public (the roster), so one ship, the
 * weakest idle warship, goes there. Not when one of mine is already
 * there or on its way. Returns the result, or null when none went.
 */
export async function scout(view, rm, call, bodyId) {
  if (!bodyId) return null;
  if ((view.mine.get(bodyId) ?? []).length) return null;
  if ((view.inbound.get(bodyId) ?? []).some(s => s.owner_faction_id === view.me)) return null;
  const cheapest = myArmed(view).filter(s => s.parent_body_id !== bodyId)
    .sort((a, b) => (Number(a.hp) * Number(a.damage_per_tick)) - (Number(b.hp) * Number(b.damage_per_tick)))[0];
  if (!cheapest) return null;
  return sendAll(view, rm, call, [cheapest], bodyId);
}

/** The nearest enemy capital to my capital, by trip length. */
async function nearestCapital(view, rm, foes, from) {
  let best = null;
  for (const f of foes) {
    const cap = view.factions.get(f)?.capital_body_id;
    if (!cap || !from) continue;
    const legs = Number(await rm.computeLegTicks(view.me, from, cap, view.tick).catch(() => 999));
    if (!best || legs < best.legs) best = { bodyId: cap, legs };
  }
  return best?.bodyId ?? null;
}

/**
 * One turn of war against `foes` (a Set of faction ids). Returns a list
 * of [label, result] for the tally. Order of business: pull out of a
 * lost fight, answer an attack on my worlds, then strike.
 */
export async function wageWar(view, rm, call, foes, sharp, { force = false, longWar = false, prey = null } = {}) {
  const out = [];
  const armed = myArmed(view);
  if (!armed.length) return out;
  const myWorlds = [...view.owner].filter(([, o]) => o === view.me).map(([b]) => b);

  // 1. Retreat: parked where the enemy outguns me badly.
  const moved = new Set();
  if (sharp.retreat && view.capital) {
    for (const [bodyId, list] of view.mine) {
      if (view.owner.get(bodyId) === view.me) continue;
      const mineHere = list.filter(s => ARMED.has(s.ship_class));
      const theirs = power(defendersAt(view, bodyId, foes), foes.has(view.owner.get(bodyId)) ? (view.settleHp.get(bodyId) ?? 0) : 0);
      if (mineHere.length && theirs > sharp.retreatAt * power(mineHere)) {
        out.push(['retreat', await sendAll(view, rm, call, mineHere.map(s => ({ ...s, parent_body_id: bodyId })), view.capital)]);
        for (const s of mineHere) moved.add(s.id);
      }
    }
  }

  // 2. Defence: hostile ships inbound to one of my worlds, more than its
  //    guard can hold, and my ships can get there first.
  if (sharp.defend) {
    for (const bodyId of myWorlds) {
      const coming = (view.inbound.get(bodyId) ?? []).filter(s => foes.has(s.owner_faction_id) && ARMED.has(s.ship_class));
      if (!coming.length) continue;
      const firstHit = Math.min(...coming.map(s => s.arrival));
      const guard = shipsAt(view, bodyId, view.me);
      if (power(guard, view.settleHp.get(bodyId) ?? 0) >= power(coming)) continue;
      const helpers = [];
      for (const s of armed) {
        if (moved.has(s.id) || s.parent_body_id === bodyId) continue;
        const legs = Number(await rm.computeLegTicks(view.me, s.parent_body_id, bodyId, view.tick).catch(() => 999));
        if (view.tick + legs <= firstHit) helpers.push(s);
      }
      if (helpers.length) {
        out.push(['defend', await sendAll(view, rm, call, helpers, bodyId)]);
        for (const s of helpers) moved.add(s.id);
      }
    }
  }

  // 3. Strike: everything but the home guard, at the best target, when
  //    the odds are good enough (or regardless, when loose or forced).
  const free = armed.filter(s => !moved.has(s.id));
  const keep = Math.ceil(free.length * sharp.guard);
  // The guard is the weakest hulls at the capital; the strike the rest.
  const atHome = free.filter(s => s.parent_body_id === view.capital)
    .sort((a, b) => (Number(a.hp) * Number(a.damage_per_tick)) - (Number(b.hp) * Number(b.damage_per_tick)));
  const guardIds = new Set(atHome.slice(0, keep).map(s => s.id));
  const strike = free.filter(s => !guardIds.has(s.id));
  if (!strike.length) return out;
  // The strike goes at its victim when it has one; defence and retreat
  // above answer every foe.
  const aim = prey && foes.has(prey) ? new Set([prey]) : foes;
  const target = await pickTarget(view, rm, aim, strike, { opening: sharp.opening, against: foes });
  if (!target) {
    // Nothing of theirs in sight. Loose (or a strike already launched):
    // go at their capital blind. Sharp: send one ship to look first.
    const cap = await nearestCapital(view, rm, aim, view.capital ?? strike[0].parent_body_id);
    if (!cap) return out;
    if (force || sharp.margin === 0) out.push(['attack_blind', await sendAll(view, rm, call, strike, cap)]);
    else { const r = await scout(view, rm, call, cap); if (r) out.push(['scout', r]); }
    return out;
  }
  // A long war lowers the bar to an even fight: waiting for 1.5x odds
  // forever is how the crucible's fleets sat at home for 5000 ticks.
  const margin = longWar ? Math.min(sharp.margin, 1) : sharp.margin;
  if (!force && margin > 0 && power(strike) < margin * target.theirs) {
    out.push(['hold']);
    return out;
  }
  out.push(['attack', await sendAll(view, rm, call, strike, target.bodyId)]);
  return out;
}
