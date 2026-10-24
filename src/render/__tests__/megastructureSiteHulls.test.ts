/**
 * A HULL PARKED AT A MEGASTRUCTURE IS SEEN THERE, AND A STRUCTURE
 * FINISHING IS SEEN TOO.
 *
 * Studio clip "A megastructure completes" (prod, 2026-10-23): the outliner
 * listed TFS FR-01 at the Weapons Station Site and trace.jsonl drew
 * st_fr_0 every frame, but nothing was visible. Every world's parked hulls
 * are laid out at a reference size from its true radius (a 1.6-radius
 * site: 120 px) and drawn at k = drawn radius / reference; a structure's
 * art is capped at 46 px, so k never passed 0.38: the freighter was a
 * third of its size, tucked against the art. And the completion was the
 * discovery firework, fixed at ~70 px, so it stayed inside the art.
 */
import {
  liveBattleFor, battlePlacement, battleScale, battleSpriteScale, resetLiveBattles,
  STRUCTURE_DRAWN_MAX_PX,
} from '../battleLayoutLive';
import { computePresentation, drawnRadiusOf } from '../bodyPresentation';
import { shipIconSize } from '../mapRenderer';
import { drawCompletionBurst } from '../combatFx';
import type { Body } from '../../types';

beforeEach(() => resetLiveBattles());

// The take: Luna close up at scale 34.4, the site 3.75 units off it.
const scale = 34.38;
const sol = { id: 'sol', type: 'star', radius: 20 } as unknown as Body;
const earth = { id: 'earth', type: 'terrestrial', radius: 3, parent: 'sol', orbitRadius: 372 } as unknown as Body;
const luna = { id: 'luna', type: 'moon', radius: 1.5, parent: 'earth', orbitRadius: 20 } as unknown as Body;
const site = { id: 'st_mega_yard', type: 'megastructure', radius: 1.6, parent: 'luna', orbitRadius: 3.75 } as unknown as Body;
const W = { earth: { x: 0, y: 0 }, luna: { x: 0, y: -20 }, st_mega_yard: { x: 0, y: -16.25 }, sol: { x: -372, y: 0 } } as Record<string, { x: number; y: number }>;
const screen = (id: string) => (W[id] ? { x: 480 + W[id].x * scale, y: 270 + W[id].y * scale } : null);

describe('a freighter parked at the site', () => {
  const pres = computePresentation([sol, earth, luna, site], scale, screen, null, { w: 960, h: 540 }, null, 1);
  const drawnR = drawnRadiusOf(pres, site, scale);

  it('the site is drawn, as itself', () => {
    expect(pres.shown.get('st_mega_yard')).toBe(1);
    expect(drawnR).toBe(STRUCTURE_DRAWN_MAX_PX);
  });

  it('is drawn at full size when the site is, clear of the art', () => {
    const fr = { id: 'g:st_fr_0', owner: 'terra', group: null, sizePx: shipIconSize('freighter', false), armed: false };
    const lb = liveBattleFor('st_mega_yard', site, 1, [fr], ['terra']);
    const k = battleScale(lb, drawnR);
    expect(battleSpriteScale(k)).toBeGreaterThan(0.95);
    const pl = battlePlacement(lb, fr.id, 0)!;
    const px = pl.r * k;
    // Its centre sits outside the structure by at least half its own length.
    expect(px).toBeGreaterThan(drawnR + (fr.sizePx * battleSpriteScale(k)) / 2 - 1);
    // ...and near it, not across the screen.
    expect(px).toBeLessThan(drawnR * 4);
  });

  it('a world keeps its own reference size', () => {
    const lb = liveBattleFor('luna', luna, 1,
      [{ id: 'x', owner: 'a', group: null, sizePx: 30, armed: false }], ['a']);
    expect(lb.refR).toBeGreaterThan(100);
  });
});

describe('the structure finishing', () => {
  it('flashes the structure and throws its shockwave well past the art', () => {
    const arcs: number[] = [];
    let filledR = 0;
    const ctx = new Proxy({} as Record<string, unknown>, {
      get(t, prop: string) {
        if (prop in t) return t[prop];
        if (prop === 'createRadialGradient') {
          return (_x0: number, _y0: number, _r0: number, _x1: number, _y1: number, r1: number) => {
            filledR = Math.max(filledR, r1);
            return { addColorStop: () => {} };
          };
        }
        if (prop === 'arc') return (_x: number, _y: number, r: number) => { arcs.push(r); };
        return () => {};
      },
      set(t, prop: string, v) { t[prop] = v; return true; },
    }) as unknown as CanvasRenderingContext2D;
    const R = STRUCTURE_DRAWN_MAX_PX;
    // The opening flash covers the whole structure.
    drawCompletionBurst(ctx, { x: 0, y: 0 }, R, 0.02, '#ffd27a');
    expect(filledR).toBeGreaterThanOrEqual(R);
    // Mid-way, the shockwave is out past twice the structure's radius.
    arcs.length = 0;
    drawCompletionBurst(ctx, { x: 0, y: 0 }, R, 0.6, '#ffd27a');
    expect(Math.max(...arcs)).toBeGreaterThan(2 * R);
  });
});
