// [pure] How big a world looks, when it folds away, and when its ships
// break out of their badge -- the zoom rules every map layer reads.
//
// Lorne, 2026-09-26: "The Number icons are giving way to individual ships
// before we've zoomed enough to see planets. Planets and moons are so
// small for 99% of the zoom that you can't see them, despite vast usable
// space on the screen." Numbers here are the live 8-player dials
// (system_scale 4, body_scale 2, moon_scale 8): Jupiter r16, Earth r6,
// Luna r3 at 160 from Earth, Callisto at 600 from Jupiter.

import {
  computePresentation, blendRadius, floorGrowth, hullReveal, hullSize,
  inflationOf, DISPLAY_FLOOR_PX, HULL_OPEN_PX, FLOOR_GROWTH_MAX,
} from '../bodyPresentation';
import type { PresentBody } from '../bodyPresentation';
import { systemOpenness } from '../mapRenderer';

const body = (id: string, type: string, radius: number, parent: string | null, orbitRadius = 0): PresentBody =>
  ({ id, type: type as PresentBody['type'], radius, parent, orbitRadius });

/** Everything laid out on the x axis at its orbit radius, screen px. */
function present(bodies: PresentBody[], scale: number, keep: string | null = null, viewport?: { w: number; h: number }) {
  const byId = new Map(bodies.map(b => [b.id, b]));
  const world = (id: string): number => {
    const b = byId.get(id)!;
    return b.parent ? world(b.parent) + (b.orbitRadius ?? 0) : 0;
  };
  return computePresentation(bodies, scale, id => ({ x: world(id) * scale, y: 0 }), keep, viewport);
}

const sol = body('sol', 'star', 100, null);
const earth = body('earth', 'terrestrial', 6, 'sol', 744);
const luna = body('luna', 'moon', 3, 'earth', 160);
const jupiter = body('jupiter', 'gas_giant', 16, 'sol', 1840);
const callisto = body('callisto', 'moon', 4, 'jupiter', 600);
const neptune = body('neptune', 'ice_giant', 10, 'sol', 6000);
const MAP = [sol, earth, luna, jupiter, callisto, neptune];

describe('drawn radius', () => {
  it('a star outranks a giant, a giant a planet, a planet a moon', () => {
    const f = DISPLAY_FLOOR_PX;
    expect(f.star > f.giant && f.giant > f.planet && f.planet > f.dwarf && f.dwarf > f.moon).toBe(true);
  });

  it('far out a world is its floor, not a 3px speck (the reported case)', () => {
    const p = present(MAP, 0.03);
    expect(p.radius.get('earth')!).toBeGreaterThanOrEqual(DISPLAY_FLOOR_PX.planet);
    expect(earth.radius * 0.03).toBeLessThan(1);  // true size: a fifth of a pixel
  });

  it('close in it is exactly true scale, which the world menu frames', () => {
    expect(blendRadius(400, 9)).toBeCloseTo(400, 1);
    const p = present(MAP, 63);
    expect(p.radius.get('earth')!).toBeCloseTo(6 * 63, 0);
  });

  it('grows with every notch of zoom, never shrinks (seamless)', () => {
    const vp = { w: 1440, h: 900 };
    let prev = 0;
    for (let s = 0.002; s < 60; s *= 1.15) {
      const r = present(MAP, s, null, vp).radius.get('earth')!;
      expect(r).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = r;
    }
  });

  it('floor growth is clamped both ways', () => {
    expect(floorGrowth(1e-6)).toBeGreaterThan(0);
    expect(floorGrowth(1e6)).toBe(FLOOR_GROWTH_MAX);
  });

  it('inflation is 1 at true scale and above 1 when the floor is showing', () => {
    const far = present(MAP, 0.03);
    const near = present(MAP, 63);
    expect(inflationOf(far, earth, 0.03)).toBeGreaterThan(5);
    expect(inflationOf(near, earth, 63)).toBeCloseTo(1, 2);
  });
});

describe('folding', () => {
  it('a moon folds into its planet while their discs would touch', () => {
    const p = present(MAP, 0.1);           // Earth shows; Luna 16px from it
    expect(p.shown.get('earth')).toBe(1);
    expect(p.shown.get('luna')).toBe(0);
    expect(p.host.get('luna')).toBe('earth');
  });

  it('...and unfolds once there is room', () => {
    const p = present(MAP, 1);             // 160px from Earth
    expect(p.shown.get('luna')).toBe(1);
    expect(p.host.get('luna')).toBe('luna');
  });

  it('the innermost planets fold into the sun at full zoom-out, and their moons go with them', () => {
    const p = present(MAP, 0.002);
    expect(p.host.get('earth')).toBe('sol');
    expect(p.host.get('luna')).toBe('sol');
  });

  it('two siblings on top of each other: the lesser folds into the greater', () => {
    const a = body('ceres', 'dwarf', 2, 'sol', 1100);
    const b = body('rock', 'asteroid', 0.4, 'sol', 1101);
    const p = present([sol, a, b], 0.05);
    expect(p.shown.get('ceres')).toBe(1);
    expect(p.host.get('rock')).toBe('ceres');
  });

  it('the SELECTED world never folds -- it is what the player asked to see', () => {
    const p = present(MAP, 0.03, 'luna');
    expect(p.shown.get('luna')).toBe(1);
  });
});

describe('hulls break out of the badge only when their world is visible', () => {
  it('Jupiter at moon_scale 8: the old rule opened its hulls while the planet was a speck', () => {
    // The system opens on its moons' reach (Callisto 600 * 0.14 = 84px)...
    expect(systemOpenness(jupiter as never, [jupiter, callisto] as never, 0.14)).toBeGreaterThanOrEqual(1);
    // ...while Jupiter itself is 2.2px. The new rule keeps its badge.
    expect(jupiter.radius * 0.14).toBeLessThan(3);
    expect(hullReveal(jupiter, 0.14)).toBe(0);
  });

  it('hulls arrive once the world itself is big enough to orbit', () => {
    expect(hullReveal(earth, HULL_OPEN_PX / earth.radius - 0.01)).toBe(0);
    expect(hullReveal(earth, 40 / earth.radius)).toBe(1);
  });

  it('a moon keeps its own rule: its hulls wait for the moon, not the planet', () => {
    const s = 20 / jupiter.radius;              // Jupiter a 20px disc
    expect(hullReveal(jupiter, s)).toBe(1);
    expect(hullReveal(callisto, s)).toBe(0);    // Callisto still 5px
  });

  it('hull size grows from half to full', () => {
    expect(hullSize(earth, HULL_OPEN_PX / earth.radius)).toBeCloseTo(0.5, 2);
    expect(hullSize(earth, 100)).toBe(1);
  });

  it('a star keeps its disc-against-80px rule', () => {
    expect(hullReveal(sol, 0.5)).toBe(0);       // a 50px sun: badge
    expect(hullReveal(sol, 1.5)).toBe(1);       // a 150px sun: hulls
  });
});
