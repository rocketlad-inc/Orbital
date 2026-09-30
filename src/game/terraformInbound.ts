// ============================================================
// What is on its way to a raw world's terraform meter.
//
// A terraform run takes the metal and credits out of the pool when the
// freighter LOADS, and the meter only moves when it LANDS. In between,
// the world's card said "⇢ 2 routes feeding" over a bar at zero, and a
// player whose credits had gone reported the terraform as broken ("it
// took my credits... no progress on the progress bar", 2026-09-30) while
// 372/372 was twelve ticks out from Io. This names what is in flight and
// when it lands, so the gap between paying and progress is visible.
// ============================================================

import type { GameState, Ship, TradeRoute } from '../types';
import { routeDeliversTo, routeStops } from './routeSelectors';

export interface TerraformInbound {
  routeId: string;
  shipName: string;
  /** 'inbound': loaded and flying here. 'aboard': loaded, not yet under
   *  way to this world. 'to_pickup': empty, flying to load first. */
  stage: 'inbound' | 'aboard' | 'to_pickup';
  metal: number;
  credits: number;
  /** Tick it arrives at THIS world (inbound) or at the loading dock
   *  (to_pickup); null when not flying. */
  arriveTick: number | null;
  /** Where it loads, for 'to_pickup'. */
  pickupBodyId: string | null;
}

function carrierOf(route: TradeRoute, ships: Ship[]): Ship | undefined {
  const crewId = route.ships?.find(c => c.role === 'carrier')?.shipId;
  return ships.find(s => s.id === (crewId ?? route.shipId));
}

/** Every freighter of `factionId` working a terraform run to `bodyId`
 *  that has something to report: a load aboard, or a flight to pick one
 *  up. Soonest first. */
export function terraformInbound(gameState: GameState, bodyId: string, factionId = 'player'): TerraformInbound[] {
  const out: TerraformInbound[] = [];
  for (const r of gameState.tradeRoutes ?? []) {
    if (r.kind !== 'terraform' || r.ownedBy !== factionId || !routeDeliversTo(r, bodyId)) continue;
    const ship = carrierOf(r, gameState.ships);
    if (!ship) continue;
    const metal = Math.round(Number(r.cargo?.ore ?? 0));
    const credits = Math.round(Number(r.cargo?.credits ?? 0));
    const plan = ship.transit?.currentTransfer;
    const pickup = routeStops(r).find(s => s.action === 'pickup')?.bodyId ?? r.originBodyId;
    const base = { routeId: r.id, shipName: ship.name, metal, credits, pickupBodyId: null };
    if (metal + credits > 0) {
      const flyingHere = plan?.targetBodyId === bodyId;
      out.push({ ...base, stage: flyingHere ? 'inbound' : 'aboard', arriveTick: flyingHere ? plan!.arriveTick : null });
    } else if (plan && plan.targetBodyId === pickup) {
      out.push({ ...base, stage: 'to_pickup', arriveTick: plan.arriveTick, pickupBodyId: pickup });
    }
  }
  const rank = (x: TerraformInbound) => (x.stage === 'to_pickup' ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || (a.arriveTick ?? Infinity) - (b.arriveTick ?? Infinity));
}

/** "~8:00 PM", or "Thu ~8:00 PM" when it is not today, for a future
 *  tick; null without a live cadence (single-player, or a paused game). */
export function tickClock(tick: number, gameState: GameState, now = Date.now()): string | null {
  const { nextTickAt, tickIntervalMs, currentTick } = gameState;
  if (nextTickAt == null || !tickIntervalMs) return null;
  const at = new Date(nextTickAt + (tick - (currentTick + 1)) * tickIntervalMs);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return sameDay ? `~${time}` : `${at.toLocaleDateString([], { weekday: 'short' })} ~${time}`;
}
