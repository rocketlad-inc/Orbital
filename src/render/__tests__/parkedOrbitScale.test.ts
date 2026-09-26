// Parked orbits around a world drawn bigger than true scale: always
// outside the drawn disc, always inside the world's first shown moon, and
// the hull always on the ring the player sees.
//
// Lorne, 2026-09-26: "are we sure orbit radius won't be messed up by
// bigger worlds?" It was: parked hulls were scaled out with the enlarged
// world, so at scale ~0.2 a ship parked at Earth was drawn OUTSIDE Luna,
// and the selected ship's ring and Ap/Pe markers were still at the true
// orbit, inside the disc, with the hull outside them.

import fs from 'fs';
import path from 'path';
import { parkedOrbitMap } from '../mapRenderer';
import type { RenderContext } from '../mapRenderer';
import { computePresentation, parkedRadiusMap } from '../bodyPresentation';

const sol = { id: 'sol', type: 'star', radius: 100, parent: null } as never;
const earth = { id: 'earth', type: 'terrestrial', radius: 6, parent: 'sol', orbitRadius: 744 } as never;
const luna = { id: 'luna', type: 'moon', radius: 3, parent: 'earth', orbitRadius: 160 } as never;
const neptune = { id: 'neptune', type: 'ice_giant', radius: 10, parent: 'sol', orbitRadius: 6000 } as never;

/** The live map at one zoom, with the floors growing as in play. */
function at(scale: number) {
  const pos = (id: string) => (id === 'sol' ? { x: 0, y: 0 }
    : id === 'earth' ? { x: 744 * scale, y: 0 }
    : id === 'neptune' ? { x: 0, y: 6000 * scale } : { x: (744 + 160) * scale, y: 0 });
  const presentation = computePresentation([sol, earth, luna, neptune], scale, pos, null, { w: 1440, h: 900 });
  const ctx = { camera: { x: 0, y: 0, scale }, presentation } as unknown as RenderContext;
  return { presentation, ctx };
}

const ORBITS = [
  { name: 'a circular park orbit', rp: 9, ra: 9 },
  { name: "a starter's 1.5r-2r ellipse", rp: 9, ra: 12 },
];

describe('single-player (no presentation): the true orbit, untouched', () => {
  it('no map at all', () => {
    const ctx = { camera: { x: 0, y: 0, scale: 0.1 } } as unknown as RenderContext;
    expect(parkedOrbitMap({ orbit: { rp: 9, ra: 9 } } as never, earth, ctx, 30)).toBeNull();
  });
});

describe('never inside the disc, never past the moon (the question asked)', () => {
  for (let s = 0.002; s < 60; s *= 1.15) {
    const scale = s;
    it(`at scale ${scale.toFixed(3)}`, () => {
      const { presentation, ctx } = at(scale);
      const drawnR = presentation.radius.get('earth')!;
      const lunaShown = (presentation.shown.get('luna') ?? 0) >= 0.5;
      const lunaInner = 160 * scale - presentation.radius.get('luna')!;
      for (const o of ORBITS) {
        for (const icon of [17, 36]) {                 // half-size, and selected
          const map = parkedOrbitMap({ orbit: o } as never, earth, ctx, icon);
          const px = (r: number) => (map ? map(r) : r * scale);
          // The orbit's closest point clears the drawn disc.
          expect(px(o.rp)).toBeGreaterThanOrEqual(drawnR + icon * 0.5 + 2 - 1e-6);
          if (!lunaShown) continue;
          const band = lunaInner - drawnR - icon - 4;   // room for the orbit
          // Folding GUARANTEES a band whenever the moon is drawn, for a
          // hull at its ordinary (half) size. Without this the check below
          // would skip exactly the frames the bug lived in.
          if (icon === 17) expect(band).toBeGreaterThan(0);
          // Its farthest point stays inside the moon.
          if (band > 0) expect(px(o.ra)).toBeLessThanOrEqual(lunaInner - icon * 0.5 - 2 + 1e-6);
        }
      }
    });
  }
});

describe('the map keeps the orbit in order and in shape where it can', () => {
  it('monotone: farther in truth is never nearer on screen', () => {
    const { presentation } = at(0.4);
    const map = parkedRadiusMap(presentation, earth, 0.4, 9, 12, 20)!;
    let prev = -Infinity;
    for (let r = 9; r <= 14; r += 0.25) { expect(map(r)).toBeGreaterThanOrEqual(prev); prev = map(r); }
  });
  it('close in at true size, with room to spare: null -- the true orbit', () => {
    const { presentation } = at(40);
    expect(parkedRadiusMap(presentation, earth, 40, 9, 12, 20)).toBeNull();
  });
});

describe('the hull, its ring and its markers use the same map', () => {
  const renderer = fs.readFileSync(path.resolve(__dirname, '../mapRenderer.ts'), 'utf8');
  const canvas = fs.readFileSync(path.resolve(__dirname, '../../components/MapCanvas.tsx'), 'utf8');

  it('drawShip places the parked hull by parkedOrbitMap', () => {
    const i = renderer.indexOf('export function drawShip(');
    expect(renderer.slice(i, i + 12000)).toMatch(/parkedOrbitMap\(\s*ship, parentBody, ctx/);
  });
  it('drawApsisMarkers places Ap/Pe by it', () => {
    const i = renderer.indexOf('export function drawApsisMarkers(');
    expect(renderer.slice(i, i + 1500)).toMatch(/parkedOrbitMap\(/);
  });
  it('drawOrbitEllipse maps every point of the ring', () => {
    const i = renderer.indexOf('export function drawOrbitEllipse(');
    expect(renderer.slice(i, i + 2500)).toMatch(/mapRadial\(radiusMap/);
  });
  it('both parked orbit-ring calls in MapCanvas pass it', () => {
    const calls = canvas.split('drawOrbitEllipse(\n            ship.orbit').length - 1;
    const mapped = (canvas.match(/parkedRingMap\(\),\n\s*\);/g) ?? []).length;
    expect(calls).toBe(2);
    expect(mapped).toBe(2);
  });
});
