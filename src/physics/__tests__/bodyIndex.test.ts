// [pure] O(1) body index.
//
// Guards the fix for "everything is fine until I zoom out, then frames
// die" on an iPhone 15. bodyPosition sits at the bottom of the render
// call graph — every body, every ship's parent, every orbit path, every
// FX anchor — and it RECURSES up the parent chain. It used to do a
// linear `bodies.find(b => b.id === ...)` with a fresh closure per call.
//
// Zoomed in, the off-screen cull hides most of that work. Zoomed out
// nothing is culled, so the scan count peaks exactly when the frame
// budget is tightest.
//
// Two properties matter and both are asserted here: the index must
// return the same answers the scan did, and it must not DEGRADE when
// callers pass different arrays (a one-slot memo would rebuild on every
// call and end up slower than the scan it replaced).

import { bodyIndexOf, bodyById, bodyPosition } from '../orbitalMechanics';
import { Body } from '../../types';

const mk = (id: string, parent: string | null, extra: Partial<Body> = {}): Body => ({
  id, name: id, type: 'terrestrial', parent,
  radius: 2, soi: 10, mu: 1,
  orbitRadius: parent ? 100 : 0, orbitPeriod: parent ? 50 : 0, angle0: 0,
  color: '#fff',
  ...extra,
} as unknown as Body);

const CATALOG: Body[] = [
  mk('sol', null, { type: 'star', radius: 50 } as Partial<Body>),
  mk('neptune', 'sol', { orbitRadius: 600, orbitPeriod: 900 }),
  mk('triton', 'neptune', { orbitRadius: 8, orbitPeriod: 12 }),
  mk('earth', 'sol', { orbitRadius: 186, orbitPeriod: 365 }),
];

describe('[pure] body index', () => {
  it('finds exactly what the linear scan found', () => {
    for (const b of CATALOG) {
      expect(bodyById(CATALOG, b.id)).toBe(CATALOG.find(x => x.id === b.id));
    }
  });

  it('misses the same way the scan did, without throwing', () => {
    expect(bodyById(CATALOG, 'pluto')).toBeUndefined();
    // Null/undefined ids reach this from optional orbit fields.
    expect(bodyById(CATALOG, null)).toBeUndefined();
    expect(bodyById(CATALOG, undefined)).toBeUndefined();
  });

  it('returns a stable index for a stable array', () => {
    // Cache hit, not a rebuild — this is the whole point.
    expect(bodyIndexOf(CATALOG)).toBe(bodyIndexOf(CATALOG));
  });

  it('does not degrade when callers alternate between arrays', () => {
    // The one-slot-memo failure mode: A, B, A, B would rebuild four
    // times and be slower than no cache at all. Each array must keep
    // its OWN index, so both stay hits.
    const other: Body[] = [mk('sol', null), mk('mars', 'sol')];
    const a1 = bodyIndexOf(CATALOG);
    const b1 = bodyIndexOf(other);
    expect(bodyIndexOf(CATALOG)).toBe(a1);
    expect(bodyIndexOf(other)).toBe(b1);
    expect(a1).not.toBe(b1);
    // And they must not bleed into each other.
    expect(bodyById(other, 'triton')).toBeUndefined();
    expect(bodyById(CATALOG, 'triton')).toBeDefined();
    expect(bodyById(other, 'mars')).toBeDefined();
    expect(bodyById(CATALOG, 'mars')).toBeUndefined();
  });

  it('leaves bodyPosition answering identically through the parent chain', () => {
    // Triton is two levels deep, so it exercises the recursion that made
    // the scan expensive in the first place.
    // Distance from parent, not an absolute figure: orbit radii get
    // multiplied by SYSTEM_SCALE inside bodyPosition, so asserting a
    // literal 8 would be testing the scale constant, not the lookup.
    const moonGap: number[] = [];
    for (const t of [0, 7, 123.5]) {
      expect(bodyPosition(CATALOG[0], t, CATALOG)).toEqual({ x: 0, y: 0 });
      const nep = bodyPosition(CATALOG[1], t, CATALOG);
      const tri = bodyPosition(CATALOG[2], t, CATALOG);
      expect(Number.isFinite(tri.x) && Number.isFinite(tri.y)).toBe(true);
      moonGap.push(Math.hypot(tri.x - nep.x, tri.y - nep.y));
      // The moon must track its parent rather than the origin — the
      // failure signature if a lookup returned the wrong parent, or
      // undefined (which bodyPosition reports as {0,0}).
      expect(Math.hypot(tri.x, tri.y)).toBeGreaterThan(1);
    }
    // Circular orbit: the gap is constant, and non-zero.
    expect(moonGap[0]).toBeGreaterThan(0);
    for (const g of moonGap) expect(g).toBeCloseTo(moonGap[0], 9);
  });

  it('sees a body that was added in a new array, not a stale cached one', () => {
    // /state replaces the graph wholesale; a new array must not serve
    // the previous array's index.
    const before: Body[] = [mk('sol', null)];
    expect(bodyById(before, 'vesta')).toBeUndefined();
    const after: Body[] = [...before, mk('vesta', 'sol')];
    expect(bodyById(after, 'vesta')).toBeDefined();
  });
});
