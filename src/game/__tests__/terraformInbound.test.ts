// ============================================================
// A raw world's card names the terraform payload already paid for.
//
// Player report, 2026-09-30 (The NEXT Zone, DoubleVictory): "The
// terraforming didn't work lol but it took my credits. No progress on the
// progress bar." It had worked: 372 metal + 372 credits loaded at Callisto
// on tick 114 and were twelve ticks out from Io. The card said "2 routes
// feeding" over a bar at zero. These are the lines it now shows instead.
// ============================================================

import fs from 'fs';
import path from 'path';
import { terraformInbound, tickClock } from '../terraformInbound';
import type { GameState, Ship, TradeRoute } from '../../types';

const IO = 'io';
const CALLISTO = 'callisto';

function ship(id: string, name: string, target?: string, arriveTick?: number): Ship {
  return {
    id, name, class: 'freighter', ownedBy: 'player',
    orbit: { parentBodyId: CALLISTO, radius: 2, angle0: 0, epoch: 0, direction: 1 },
    transit: target ? { currentTransfer: { targetBodyId: target, arriveTick, startTick: 114 } } : undefined,
  } as unknown as Ship;
}
function route(id: string, shipId: string, cargo: [number, number], extra: Partial<TradeRoute> = {}): TradeRoute {
  return {
    id, ownedBy: 'player', shipId, kind: 'terraform', originBodyId: CALLISTO, destBodyId: IO,
    status: 'outbound', createdAtTick: 103,
    cargo: { fuel: 0, ore: cargo[0], credits: cargo[1], science: 0 },
    stops: [
      { sequence: 0, bodyId: CALLISTO, action: 'pickup', takeMetal: true, takeGold: true },
      { sequence: 1, bodyId: IO, action: 'dropoff', takeMetal: true, takeGold: true },
    ],
    ...extra,
  } as unknown as TradeRoute;
}
function state(routes: TradeRoute[], ships: Ship[], extra: Partial<GameState> = {}): GameState {
  return { currentTick: 117, tradeRoutes: routes, ships, bodies: [], ...extra } as unknown as GameState;
}

describe('what is on its way to the meter', () => {
  it('the reported case: 372/372 aboard, flying to Io, lands tick 126', () => {
    const got = terraformInbound(state(
      [route('r1', 'sister', [372, 372])],
      [ship('sister', 'Sister Kept the Ring', IO, 126)],
    ), IO);
    expect(got).toEqual([{
      routeId: 'r1', shipName: 'Sister Kept the Ring', stage: 'inbound',
      metal: 372, credits: 372, arriveTick: 126, pickupBodyId: null,
    }]);
  });

  it('an empty freighter still flying to load says so, after the loaded one', () => {
    const got = terraformInbound(state(
      [route('r2', 'mowteng', [0, 0]), route('r1', 'sister', [372, 372])],
      [ship('mowteng', 'Mowteng', CALLISTO, 136), ship('sister', 'Sister Kept the Ring', IO, 126)],
    ), IO);
    expect(got.map(x => [x.shipName, x.stage, x.arriveTick, x.pickupBodyId])).toEqual([
      ['Sister Kept the Ring', 'inbound', 126, null],
      ['Mowteng', 'to_pickup', 136, CALLISTO],
    ]);
  });

  it('loaded but not yet under way to this world', () => {
    const got = terraformInbound(state([route('r1', 'sister', [372, 372])], [ship('sister', 'S')]), IO);
    expect(got[0]).toMatchObject({ stage: 'aboard', arriveTick: null });
  });

  it('an idle, empty freighter has nothing to report', () => {
    expect(terraformInbound(state([route('r1', 'sister', [0, 0])], [ship('sister', 'S')]), IO)).toEqual([]);
  });

  it('only terraform runs, only to THIS world, only mine', () => {
    const s = [ship('a', 'A', IO, 120), ship('b', 'B', IO, 120), ship('c', 'C', IO, 120)];
    const got = terraformInbound(state([
      route('logistics', 'a', [50, 50], { kind: 'logistics' }),
      route('rival', 'b', [50, 50], { ownedBy: 'f3' }),
      route('elsewhere', 'c', [50, 50], {
        destBodyId: 'europa',
        stops: [
          { sequence: 0, bodyId: CALLISTO, action: 'pickup', takeMetal: true, takeGold: true },
          { sequence: 1, bodyId: 'europa', action: 'dropoff', takeMetal: true, takeGold: true },
        ] as TradeRoute['stops'],
      }),
    ], s), IO);
    expect(got).toEqual([]);
  });

  it('follows the route crew carrier when there is one', () => {
    const r = route('r1', 'old', [10, 20], {
      ships: [{ shipId: 'new', role: 'carrier' }] as TradeRoute['ships'],
    });
    expect(terraformInbound(state([r], [ship('old', 'Old'), ship('new', 'New', IO, 130)]), IO)[0])
      .toMatchObject({ shipName: 'New', stage: 'inbound', arriveTick: 130 });
  });
});

describe('when a tick lands, on the clock', () => {
  const NOW = new Date(2026, 8, 30, 12, 0).getTime();
  const gs = (extra: Partial<GameState>) => state([], [], { currentTick: 117, ...extra });

  it('counts from the next tick at the game cadence', () => {
    // Tick 118 at 12:30, one hour a tick: tick 126 is 8:30 PM the same day.
    const next = new Date(2026, 8, 30, 12, 30).getTime();
    const want = new Date(2026, 8, 30, 20, 30).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(tickClock(126, gs({ nextTickAt: next, tickIntervalMs: 3_600_000 }), NOW)).toBe(`~${want}`);
  });

  it('names the day when it is not today', () => {
    const next = new Date(2026, 8, 30, 12, 30).getTime();
    const out = tickClock(150, gs({ nextTickAt: next, tickIntervalMs: 3_600_000 }), NOW)!;
    const day = new Date(2026, 9, 1, 20, 30).toLocaleDateString([], { weekday: 'short' });
    expect(out.startsWith(`${day} ~`)).toBe(true);
  });

  it('says nothing without a live cadence', () => {
    expect(tickClock(126, gs({ nextTickAt: null }), NOW)).toBeNull();
  });
});

describe('the raw world card shows it', () => {
  it('WmTerraformCard renders terraformInbound lines under the bars', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../multiplayer/WorldMenuOverlay.tsx'), 'utf8')
      .replace(/\r\n/g, '\n');
    const card = src.slice(src.indexOf('const WmTerraformCard'), src.indexOf('wm-terraform-assign'));
    expect(card).toMatch(/terraformInbound\(gameState, body\.id\)/);
    expect(card.indexOf('terraformInbound(')).toBeGreaterThan(card.lastIndexOf('wm-terraform-bar'));
  });
});
