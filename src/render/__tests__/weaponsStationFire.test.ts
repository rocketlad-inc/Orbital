// A WEAPONS STATION'S FIRE MUST BE ITS OWN (Studio clip "weapons-station-
// shreds-a-raid", 2026-10-23, f156/f160/f170: "every tracer runs from the
// home fleet through the station icon; there is no muzzle flash on the
// station"). The station drew no fire at all: its occlusion test measured
// against its OWN body, whose centre every shot starts from, so every
// shot counted as blocked. Now it fires, from the station, in a colour no
// hull's gun uses, with a flash on the station itself.

import { drawEngagementFire, STATION_FX } from '../combatFx';
import type { RenderContext } from '../mapRenderer';
import type { Body, Ship } from '../../types';
import type { MegastructureState } from '../../game/megastructures';

// jsdom has no 2D canvas: the baked glow sprites fall back to plain arcs.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

type Call = { name: string; args: number[]; fillStyle?: unknown; strokeStyle?: unknown };

function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(t, key) {
      if (key in t) return t[key as string];
      return (...args: number[]) => {
        calls.push({ name: String(key), args, fillStyle: t.fillStyle, strokeStyle: t.strokeStyle });
        return { addColorStop: () => {} };
      };
    },
    set(t, key, value) { t[key as string] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const MARS = { id: 'mars', name: 'Mars', type: 'terrestrial', radius: 2, ownedBy: 'red' } as unknown as Body;
// The station orbits Mars, 40 units out (x = +40 at this zoom: 80 px).
const STATION = {
  id: 'wstn', name: 'Weapons Station', type: 'megastructure', radius: 1, parent: 'mars',
  orbitRadius: 40, orbitPeriod: 1e9, angle0: 0, ownedBy: 'red',
} as unknown as Body;

const raider = {
  id: 'g:raid1', ownedBy: 'blue', class: 'destroyer', hp: 100, damagePerTick: 10,
  orbit: { parentBodyId: 'deimos', rp: 1, ra: 1, omega: 0, M0: 0, epoch: 0, period: 100, direction: 1 },
  transit: { pos: { x: 120, y: -60 }, vel: { x: 0, y: 0 }, currentTransfer: { targetBodyId: 'mars' } },
} as unknown as Ship;

const mega: Record<string, MegastructureState> = {
  wstn: {
    bodyId: 'wstn', kind: 'weapons_station', status: 'complete', hp: 1e9,
    lastCombatTick: 50, lastTargetId: 'g:raid1',
  } as unknown as MegastructureState,
};

function sweep(): { calls: Call[]; station: { x: number; y: number } } {
  const { ctx, calls } = recordingCtx();
  const rc = {
    ctx, canvas: { width: 800, height: 600 }, camera: { x: 0, y: 0, scale: 2 },
    t: 50, bodies: [MARS, STATION], shipHitboxes: new Map(), fleetSlots: new Map(),
  } as unknown as RenderContext;
  // The raider is drawn up and to the right of the station.
  const transitPos = new Map([['g:raid1', { x: 640, y: 180 }]]);
  for (let ms = 0; ms < 6000; ms += 16) {
    drawEngagementFire(rc, [raider], [], ms, 50, transitPos, ['blue|red'], true, mega);
  }
  return { calls, station: { x: 400 + 80, y: 300 } };
}

const lime = /^rgba\(168, 255, 62,/;

describe('a Weapons Station fires, and its fire is its own', () => {
  it('draws fire at all', () => {
    const { calls } = sweep();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('in the station battery colour, not the kinetic amber every hull uses', () => {
    const { calls } = sweep();
    const limeDraws = calls.filter(c => (typeof c.fillStyle === 'string' && lime.test(c.fillStyle))
      || (typeof c.strokeStyle === 'string' && lime.test(c.strokeStyle)));
    expect(limeDraws.length).toBeGreaterThan(0);
    expect(STATION_FX.glow).toBe('#a8ff3e');
    const amber = calls.filter(c => typeof c.fillStyle === 'string' && /^rgba\(255, 174, 74,/.test(c.fillStyle));
    expect(amber).toHaveLength(0);
  });

  it('with a flash on the station itself', () => {
    const { calls, station } = sweep();
    const atStation = calls.filter(c => c.name === 'arc'
      && Math.hypot(c.args[0] - station.x, c.args[1] - station.y) < 2
      && ((typeof c.fillStyle === 'string' && lime.test(c.fillStyle))
        || (typeof c.strokeStyle === 'string' && lime.test(c.strokeStyle))));
    expect(atStation.length).toBeGreaterThan(0);
  });
});
