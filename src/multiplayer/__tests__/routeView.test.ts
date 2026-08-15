// ============================================================
// The logic under the Trade views — the selectors five surfaces share,
// and the placement that decides where a hull is drawn on its circuit.
//
// Written after two UI bugs shipped that no existing check could catch:
// a route card that read "Runs it · none" for a staffed lane, and a
// button that never rendered at all. The sims prove the server end to
// end but never mount a component, so anything that only exists in the
// client was untested by construction.
//
// This is the half of that gap which needs no new dependency: the pure
// functions. Render-level coverage would need @testing-library, which
// this project doesn't carry.
// ============================================================

import type { TradeRoute } from '../../types';
import {
  routeStops, routeShips, routeCarriers, routeGuards,
  routeForShip, employedShipIds, anyRouteCollectsFrom,
  routeDeliversTo, routeFinalDropoff, stallTicksLeft, isStalled,
} from '../../game/routeSelectors';
import { placeShip } from '../RouteDiagram';

const baseRoute = (over: Partial<TradeRoute> = {}): TradeRoute => ({
  id: 'r1',
  ownedBy: 'player',
  shipId: 'freighter1',
  originBodyId: 'ceres',
  destBodyId: 'luna',
  status: 'returning',
  cargo: { fuel: 0, ore: 0, credits: 0, science: 0 },
  createdAtTick: 0,
  ...over,
});

describe('routeSelectors — a route with no stops or crew still answers', () => {
  // A route from a stale bundle, or one the server hasn't backfilled,
  // has neither array. Every surface has to keep working.
  const legacy = baseRoute();

  it('synthesises the two-stop itinerary from origin/dest', () => {
    const stops = routeStops(legacy);
    expect(stops.map(s => [s.bodyId, s.action])).toEqual([
      ['ceres', 'pickup'],
      ['luna', 'dropoff'],
    ]);
  });

  it('synthesises a carrier from shipId', () => {
    expect(routeShips(legacy)).toHaveLength(1);
    expect(routeCarriers(legacy)[0].shipId).toBe('freighter1');
    expect(routeGuards(legacy)).toHaveLength(0);
  });

  it('still reports collection and delivery correctly', () => {
    expect(anyRouteCollectsFrom([legacy], 'ceres')).toBe(true);
    expect(anyRouteCollectsFrom([legacy], 'luna')).toBe(false);
    expect(routeDeliversTo(legacy, 'luna')).toBe(true);
    expect(routeFinalDropoff(legacy)).toBe('luna');
  });
});

describe('routeSelectors — a ship is employed in ANY role', () => {
  // The bug this guards: reading r.shipId alone counted only the
  // primary, so a second carrier or a guard sorted as "idle" and
  // offered itself for reassignment while it was mid-run.
  const crewed = baseRoute({
    ships: [
      { shipId: 'f1', role: 'carrier', nextStopSeq: 1, cargo: { fuel: 0, ore: 0, credits: 0, science: 0 } },
      { shipId: 'f2', role: 'carrier', nextStopSeq: 0, cargo: { fuel: 0, ore: 0, credits: 0, science: 0 } },
      { shipId: 'g1', role: 'guard', followShipId: 'f1', nextStopSeq: 1, cargo: { fuel: 0, ore: 0, credits: 0, science: 0 } },
    ],
  });

  it('counts every carrier and guard as employed', () => {
    expect([...employedShipIds([crewed])].sort()).toEqual(['f1', 'f2', 'g1']);
  });

  it('finds the route for a NON-primary carrier', () => {
    expect(routeForShip([crewed], 'f2')?.id).toBe('r1');
  });

  it('finds the route for a guard', () => {
    expect(routeForShip([crewed], 'g1')?.id).toBe('r1');
  });

  it('separates the two roles', () => {
    expect(routeCarriers(crewed).map(c => c.shipId)).toEqual(['f1', 'f2']);
    expect(routeGuards(crewed).map(c => c.shipId)).toEqual(['g1']);
  });

  it('reports a staffed lane as staffed — the "Runs it · none" bug', () => {
    expect(routeCarriers(crewed).length).toBeGreaterThan(0);
  });
});

describe('routeSelectors — a milk run serves EVERY stop, not just its origin', () => {
  // Asking only about originBodyId made the middle stops of a multi-stop
  // run look unserved, so the body menu nagged about output a route was
  // already collecting.
  const milkRun = baseRoute({
    stops: [
      { sequence: 0, bodyId: 'ceres', action: 'pickup', takeMetal: true, takeGold: true, takeScience: true },
      { sequence: 1, bodyId: 'pallas', action: 'pickup', takeMetal: true, takeGold: false, takeScience: true },
      { sequence: 2, bodyId: 'luna', action: 'dropoff', takeMetal: true, takeGold: true, takeScience: true },
    ],
  });

  it('collects from a MIDDLE stop', () => {
    expect(anyRouteCollectsFrom([milkRun], 'pallas')).toBe(true);
  });

  it('does not claim to collect from its dropoff', () => {
    expect(anyRouteCollectsFrom([milkRun], 'luna')).toBe(false);
  });

  it('reports the last dropoff as the final destination', () => {
    expect(routeFinalDropoff(milkRun)).toBe('luna');
  });

  it('keeps stops in visiting order even when they arrive shuffled', () => {
    const shuffled = baseRoute({ stops: [...milkRun.stops!].reverse() });
    expect(routeStops(shuffled).map(s => s.bodyId)).toEqual(['ceres', 'pallas', 'luna']);
  });
});

describe('routeSelectors — the stall countdown', () => {
  it('is silent on a healthy route', () => {
    expect(isStalled(baseRoute())).toBe(false);
    expect(stallTicksLeft(baseRoute(), 50)).toBeNull();
  });

  it('counts down from the tick it stalled', () => {
    const r = baseRoute({ stalledSinceTick: 40 });
    expect(isStalled(r)).toBe(true);
    expect(stallTicksLeft(r, 40)).toBe(30);
    expect(stallTicksLeft(r, 55)).toBe(15);
  });

  it('floors at zero rather than going negative', () => {
    expect(stallTicksLeft(baseRoute({ stalledSinceTick: 10 }), 999)).toBe(0);
  });
});

describe('placeShip — where a hull is drawn on its circuit', () => {
  const circuit = ['ceres', 'pallas', 'luna'];

  it('puts a parked hull ON the stop it is sitting at', () => {
    expect(placeShip({ orbit: { parentBodyId: 'pallas' } }, 2, circuit)).toEqual({ at: 1 });
  });

  it('puts a flying hull on the leg INTO the stop it is heading for', () => {
    expect(placeShip({ orbit: { parentBodyId: 'ceres' }, transit: {} }, 2, circuit))
      .toEqual({ leg: 2 });
  });

  it('places nothing for a hull parked off the circuit', () => {
    // A guard still burning to join, or a freighter the player flew
    // away by hand. Better to draw nothing than to draw a lie.
    expect(placeShip({ orbit: { parentBodyId: 'mars' } }, 0, circuit)).toBeNull();
  });

  it('places nothing for a ship that no longer exists', () => {
    expect(placeShip(undefined, 0, circuit)).toBeNull();
  });

  it('clamps a cursor that points past the end of the list', () => {
    // A stop list edited shorter under a flying hull must not index out
    // of the circuit and render an undefined leg.
    expect(placeShip({ orbit: { parentBodyId: 'ceres' }, transit: {} }, 99, circuit))
      .toEqual({ leg: 2 });
  });
});
