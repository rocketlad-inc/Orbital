// ============================================================
// routeMath.js — the ONE owner of trade-route movement math and
// cargo planning (DESIGN-trade-v2 §4).
//
// Two consumers, deliberately: the tick's route walker in room.js
// and the composer's hold-projection endpoint in actions.js. The
// hold gauge's whole promise is that it is computed by the same
// code the tick runs — a projection that forks this logic becomes
// a second source of truth that quietly lies, which is the exact
// mirror-drift failure this codebase keeps re-learning (emblem
// tables, upkeep tables, the settlement-cost literals).
//
// Everything here was MOVED from room.js runTradeAutopilot, not
// rewritten: byte-equivalence with the pre-stops loop is the
// cutover's acceptance test, so the math must be the same math.
// ============================================================

import { orbitAngle, ORBITAL_SPEED_SCALE } from './orbitPos.js';
import { isEccentric, eccentricLocalPosition } from './transitCombat.js';
import { parseTraits, traitMul } from './captains.js';

// Per-resource cargo cap. Raised 50 -> 500 alongside the 10%/90%
// economy rewrite — see the original note in room.js history. The
// composer's "full" line is THIS number times the captain's cargo
// trait, and nothing else.
export const CARGO_CAP = 400;

/** Hold cap for a freighter given its captain's traits_json
 *  (Quartermaster: +25% hold). Applies PER RESOURCE, matching the
 *  sweep loop it was lifted from. */
export function holdCapFor(captainTraitsJson) {
  return Math.round(CARGO_CAP * traitMul(parseTraits(captainTraitsJson), 'cargoMul'));
}

// Torch trip-time anchors — mirror src/physics/torchTransfer.ts.
const G_ANCHOR = 4 * 132.6;
const DEFAULT_ENGINE_G = 0.05;
const fromG = (g) => g * G_ANCHOR;

/**
 * Factory for the position/leg-time helpers, carrying the same
 * per-call caches the loop always had. Build one per autopilot pass
 * (or per projection request) so caches never go stale across ticks.
 */
export function makeRouteMath(db, gameId) {
  const bodyCache = new Map();
  const fetchBody = async (id) => {
    if (bodyCache.has(id)) return bodyCache.get(id);
    const row = await db
      .prepare(
        `SELECT id, parent_body_id, orbit_radius, orbit_period, angle0,
                orbit_rp, orbit_ra, orbit_omega, orbit_m0
           FROM game_bodies WHERE id = ? AND game_id = ?`,
      )
      .bind(id, gameId)
      .first();
    bodyCache.set(id, row);
    return row;
  };
  const bodyPosAt = async (id, t) => {
    const b = await fetchBody(id);
    if (!b || b.parent_body_id == null) return { x: 0, y: 0 };
    const parent = await bodyPosAt(b.parent_body_id, t);
    // ECCENTRIC BODIES ARE NOT WHERE THE CIRCULAR SHORTCUT SAYS.
    //
    // Every default system seeds Kuiper rogues on long ellipses, and a
    // station can be built on one — so a route can legitimately start or
    // end at a body whose true position is up to ~900 units from the
    // circular approximation. That error sized the leg time, and since
    // trade legs now carry a launch plan built from this function, it
    // would also draw the freighter departing from empty space.
    if (isEccentric(b)) {
      const local = eccentricLocalPosition(b, t, ORBITAL_SPEED_SCALE);
      return { x: parent.x + local.x, y: parent.y + local.y };
    }
    const angle = orbitAngle(b.angle0, b.orbit_period, t);
    return {
      x: parent.x + Math.cos(angle) * (b.orbit_radius ?? 0),
      y: parent.y + Math.sin(angle) * (b.orbit_radius ?? 0),
    };
  };

  const factionAccelCache = new Map();
  const getFactionAccel = async (factionId) => {
    if (factionAccelCache.has(factionId)) return factionAccelCache.get(factionId);
    const f = await db
      .prepare('SELECT engine_g FROM game_factions WHERE id = ?')
      .bind(factionId)
      .first();
    const g = f?.engine_g ?? DEFAULT_ENGINE_G;
    const accel = fromG(g);
    factionAccelCache.set(factionId, accel);
    return accel;
  };

  // Closed-form brachistochrone T = 2·√(d/a) with a 5-iteration
  // intercept refinement so target-body motion during the trip is
  // accounted for. Integer ticks >= 1.
  const computeLegTicks = async (factionId, originId, destId, refTick) => {
    const accel = await getFactionAccel(factionId);
    const startPos = await bodyPosAt(originId, refTick);
    let T = 1;
    for (let i = 0; i < 5; i++) {
      const destPos = await bodyPosAt(destId, refTick + T);
      const dx = destPos.x - startPos.x;
      const dy = destPos.y - startPos.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const Tnew = 2 * Math.sqrt(Math.max(d, 0.01) / accel);
      if (Math.abs(Tnew - T) < 0.05) { T = Tnew; break; }
      T = Tnew;
    }
    return Math.max(1, Math.ceil(T));
  };

  return { bodyPosAt, computeLegTicks, getFactionAccel };
}

/**
 * WHERE TO FLY NEXT, given that gates exist.
 *
 * Trade legs are re-planned every tick from wherever the hull actually
 * is, so a multi-hop journey needs no plan object and no new state --
 * only an honest answer to "what is the next body". This returns that
 * body plus the ticks that leg costs, choosing the gate whenever the
 * whole detour through it beats flying direct.
 *
 * Three cases, in the order they occur to a freighter:
 *   - sitting ON a near end: the next leg IS the crossing, at a
 *     quarter burn, and it is worth taking only if gate + onward beats
 *     flying direct from here.
 *   - somewhere else with a worthwhile gate: fly to the near end first.
 *   - no gate helps: fly direct, exactly as before.
 *
 * The comparison is always on the TOTAL journey, never on the next leg
 * alone -- a gate two days behind you is not a shortcut, and comparing
 * legs would happily fly toward one.
 *
 * `computeLegTicks` is injected, so this is testable without a DB.
 */
export async function planGateAwareHop({
  computeLegTicks, gateTransitTicks, gates, factionId, fromId, toId, tick,
}) {
  const direct = await computeLegTicks(factionId, fromId, toId, tick);
  if (fromId === toId || !gates || gates.length === 0) {
    return { target: toId, ticks: direct, total: direct, viaGate: false };
  }

  let best = { target: toId, ticks: direct, total: direct, viaGate: false };
  for (const g of gates) {
    // A pair is usable in both directions; try each as the near end.
    for (const [near, far] of [[g.a, g.b], [g.b, g.a]]) {
      if (!near || !far || near === far) continue;
      // Already through, or the destination IS the far end we would
      // arrive at — flying direct already covers it.
      if (fromId === far) continue;

      if (fromId === near) {
        // The crossing itself, then whatever is left on the far side.
        const hop = gateTransitTicks(
          await computeLegTicks(factionId, near, far, tick));
        const onward = far === toId
          ? 0
          : await computeLegTicks(factionId, far, toId, tick + hop);
        const total = hop + onward;
        if (total < best.total) {
          best = { target: far, ticks: hop, total, viaGate: true };
        }
        continue;
      }

      const toGate = await computeLegTicks(factionId, fromId, near, tick);
      const hop = gateTransitTicks(
        await computeLegTicks(factionId, near, far, tick + toGate));
      const onward = far === toId
        ? 0
        : await computeLegTicks(factionId, far, toId, tick + toGate + hop);
      const total = toGate + hop + onward;
      if (total < best.total) {
        // The next leg is only as far as the near end; the hull will be
        // asked again from there.
        best = { target: near, ticks: toGate, total, viaGate: true };
      }
    }
  }
  return best;
}

/**
 * The pickup sweep DECISION, pure. Given settlement stockpile rows,
 * the per-resource hold cap, what's already aboard, and the stop's
 * resource filters, returns per-settlement takes plus totals — the
 * walker applies the debits, the projection just reads the totals,
 * and both therefore load the exact same amounts.
 *
 * Fuel is dead in the economy but legacy stockpile columns exist;
 * it stays swept (matching the loop this was lifted from) and is
 * simply always 0 in practice.
 */
export function planPickup(stocks, hold, aboard, filters) {
  const f = {
    metal:   filters?.metal   !== 0 && filters?.metal   !== false,
    gold:    filters?.gold    !== 0 && filters?.gold    !== false,
    science: filters?.science !== 0 && filters?.science !== false,
  };
  let cf = Number(aboard?.fuel ?? 0);
  let cm = Number(aboard?.metal ?? 0);
  let cg = Number(aboard?.gold ?? 0);
  let csci = Number(aboard?.science ?? 0);
  const startF = cf, startM = cm, startG = cg, startS = csci;
  const takes = [];
  for (const s of stocks) {
    const take = {
      settlementId: s.id,
      f:  Math.max(0, Math.min(hold - cf, Number(s.stockpile_fuel ?? 0))),
      m:  f.metal   ? Math.max(0, Math.min(hold - cm,   Number(s.stockpile_metal   ?? 0))) : 0,
      g:  f.gold    ? Math.max(0, Math.min(hold - cg,   Number(s.stockpile_gold    ?? 0))) : 0,
      sc: f.science ? Math.max(0, Math.min(hold - csci, Number(s.stockpile_science ?? 0))) : 0,
    };
    if (take.f + take.m + take.g + take.sc <= 0) continue;
    cf += take.f; cm += take.m; cg += take.g; csci += take.sc;
    takes.push(take);
    if (cf >= hold && cm >= hold && cg >= hold && csci >= hold) break;
  }
  return {
    takes,
    loaded: { fuel: cf - startF, metal: cm - startM, gold: cg - startG, science: csci - startS },
    aboardAfter: { fuel: cf, metal: cm, gold: cg, science: csci },
  };
}

/**
 * Simulate one full loop of a route AS OF NOW — the composer's hold
 * gauge and readouts. Walks the stop list from stop 0 with an empty
 * hold, projecting each pickup against CURRENT stockpiles and each
 * leg against real torch math.
 *
 * Honest limitations, stated rather than hidden (the client shows a
 * tilde for exactly this reason): stockpiles regrow while the loop
 * runs, and bodies keep orbiting, so live numbers drift from this
 * projection. What CANNOT drift is the logic — same sweep, same cap,
 * same leg math the tick uses.
 */
export async function projectRoute(db, gameId, ownerFactionId, stops, opts = {}) {
  const math = makeRouteMath(db, gameId);
  const hold = Number(opts.hold ?? CARGO_CAP);
  const refTick = Number(opts.tick ?? 0);
  let aboard = { fuel: 0, metal: 0, gold: 0, science: 0 };
  let loopTicks = 0;
  let delivered = { fuel: 0, metal: 0, gold: 0, science: 0 };
  let peak = 0;
  const out = [];
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    let loaded = { fuel: 0, metal: 0, gold: 0, science: 0 };
    let dropped = { fuel: 0, metal: 0, gold: 0, science: 0 };
    if (stop.action === 'dropoff') {
      dropped = aboard;
      delivered = {
        fuel: delivered.fuel + aboard.fuel, metal: delivered.metal + aboard.metal,
        gold: delivered.gold + aboard.gold, science: delivered.science + aboard.science,
      };
      aboard = { fuel: 0, metal: 0, gold: 0, science: 0 };
    } else {
      const stocks = (await db
        .prepare(
          `SELECT id, stockpile_fuel, stockpile_metal, stockpile_gold, stockpile_science
             FROM game_settlements
            WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
              AND destroyed_at_tick IS NULL`,
        )
        .bind(gameId, stop.body_id, ownerFactionId)
        .all()).results ?? [];
      const plan = planPickup(stocks, hold, aboard, {
        metal: stop.take_metal, gold: stop.take_gold, science: stop.take_science,
      });
      loaded = plan.loaded;
      aboard = plan.aboardAfter;
    }
    const aboardTotal = aboard.fuel + aboard.metal + aboard.gold + aboard.science;
    peak = Math.max(peak, aboard.metal, aboard.gold, aboard.science, aboard.fuel);
    // Leg to the NEXT stop (wrapping — the loop-back arc is real time too).
    const next = stops[(i + 1) % stops.length];
    const legTicks = next.body_id === stop.body_id
      ? 0
      : await math.computeLegTicks(ownerFactionId, stop.body_id, next.body_id, refTick + loopTicks);
    loopTicks += legTicks;
    out.push({
      sequence: stop.sequence ?? i,
      body_id: stop.body_id,
      action: stop.action,
      loaded, dropped,
      aboard_after: { ...aboard },
      aboard_total: aboardTotal,
      leg_ticks: legTicks,
    });
  }
  return { stops: out, loop_ticks: loopTicks, hold_cap: hold, peak_per_resource: peak, delivered };
}
