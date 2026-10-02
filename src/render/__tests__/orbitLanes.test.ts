// NOTHING AT A WORLD IS DRAWN ON TOP OF ANYTHING ELSE.
//
// orbitLanes is the one layout for parked hulls, fleets, battle lines
// and the station. These hold its promises over a spread of worlds:
// no two items overlap, nothing sits inside the disc, the station keeps
// its own angle, crowding shrinks everything before it adds lanes, and
// in a fight each side keeps to its own wedge.

import { layoutLanes, LaneItem, LaneWorld, LANE_GAP_PX, LANE_MIN_SCALE } from '../orbitLanes';

const TAU = Math.PI * 2;
const angDist = (a: number, b: number) => {
  const d = Math.abs(((a - b) % TAU + TAU) % TAU);
  return Math.min(d, TAU - d);
};

function rng(seed: number) {
  let a = seed;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIZES = [42, 48, 51, 66, 76];

function world(seed: number, n: number, opts: Partial<LaneWorld> = {}, station = false, sides = 0): LaneWorld {
  const r = rng(seed);
  const items: LaneItem[] = [];
  for (let i = 0; i < n; i++) {
    const s = SIZES[Math.floor(r() * SIZES.length)];
    const fleet = r() < 0.2;
    items.push({
      id: `s${i}`,
      length: fleet ? s + 40 + r() * 60 : s,
      height: fleet ? Math.max(s, 50) : s,
      anchor: fleet ? s / 2 : undefined,
      side: sides ? `f${i % sides}` : undefined,
    });
  }
  if (station) items.push({ id: 'station', length: 99, height: 99, pinned: r() * TAU });
  return {
    discR: 30 + r() * 200,
    items,
    dir: r() < 0.5 ? 1 : -1,
    budgetR: 0,
    spin: r() * TAU,
    sides: sides ? Array.from({ length: sides }, (_, k) => `f${k}`) : null,
    battleCenter: r() * TAU,
    ...opts,
  };
}

function overlaps(w: LaneWorld) {
  const L = layoutLanes(w);
  const bad: string[] = [];
  const byId = new Map(w.items.map(i => [i.id, i]));
  const placed = [...L.places.entries()];
  for (const [id, p] of placed) {
    const it = byId.get(id)!;
    if (p.r - (it.height * p.scale) / 2 < w.discR - 1e-6) bad.push(`${id} inside the disc`);
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const [ia, a] = placed[i], [ib, b] = placed[j];
      const A = byId.get(ia)!, B = byId.get(ib)!;
      if (a.lane !== b.lane) {
        if (Math.abs(a.r - b.r) + 1e-6 < ((A.height + B.height) / 2) * a.scale) bad.push(`${ia}/${ib} lanes touch`);
        continue;
      }
      // Same lane: their arc spans must not meet. Centres of span, from
      // the anchor: the anchor offset from the middle shifts the span.
      const mid = (it: LaneItem, p: typeof a) => {
        const off = ((it.length / 2) - (it.anchor ?? it.length / 2)) * p.scale;
        // The front is in +dir; the span centre is `off` behind the anchor.
        return p.angle - (w.dir >= 0 ? 1 : -1) * (off / p.r);
      };
      const d = angDist(mid(A, a), mid(B, b)) * a.r;
      if (d + 1e-6 < ((A.length + B.length) / 2) * a.scale) bad.push(`${ia}/${ib} overlap in lane ${a.lane}`);
    }
  }
  return { L, bad };
}

describe('orbital lanes', () => {
  it('places every item, with nothing overlapping and nothing inside the disc', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const w = world(seed, 1 + (seed % 25), { budgetR: 400 }, seed % 3 === 0);
      const { L, bad } = overlaps(w);
      expect(L.places.size).toBe(w.items.length);
      expect(bad).toEqual([]);
    }
  });

  it('holds in a battle, every side in its own wedge', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const sides = 2 + (seed % 3);
      const w = world(seed * 7, 4 + (seed % 30), { budgetR: 500 }, seed % 2 === 0, sides);
      const { L, bad } = overlaps(w);
      expect(L.places.size).toBe(w.items.length);
      expect(bad).toEqual([]);
      // Sides do not interleave: walking round the sector from its start,
      // each side's hulls form one contiguous block.
      const order = [...L.places.entries()]
        .filter(([id]) => id !== 'station')
        .map(([id, p]) => ({ side: w.items.find(i => i.id === id)!.side!, a: ((p.angle - (w.battleCenter ?? 0) + Math.PI) % TAU + TAU) % TAU }))
        .sort((x, y) => x.a - y.a)
        .map(x => x.side);
      const runs = order.filter((s, i) => i === 0 || order[i - 1] !== s);
      expect(new Set(runs).size).toBe(runs.length);
    }
  });

  it('a big fight widens round the world before it stacks deeper than three ranks', () => {
    // Three empires of fifteen hulls at a mid-size world: room for all of
    // them within three ranks once the sector opens up.
    const items: LaneItem[] = [];
    for (let i = 0; i < 45; i++) items.push({ id: `h${i}`, length: 48, height: 48, side: `f${i % 3}` });
    const w: LaneWorld = { discR: 120, items, dir: 1, budgetR: 2000, spin: 0, sides: ['f0', 'f1', 'f2'], battleCenter: 1 };
    const L = layoutLanes(w);
    expect(L.lanes).toBeLessThanOrEqual(3);
    expect(L.scale).toBe(1);
    expect(overlaps(w).bad).toEqual([]);
  });

  it('a cluster of structures eases apart, and any that cannot fit move out a lane', () => {
    for (const n of [2, 5, 10, 24]) {
      const items: LaneItem[] = [];
      for (let i = 0; i < n; i++) items.push({ id: `m${i}`, length: 90, height: 90, pinned: 1 + i * 0.02 });
      for (let i = 0; i < 12; i++) items.push({ id: `s${i}`, length: 48, height: 48 });
      const w: LaneWorld = { discR: 80, items, dir: 1, budgetR: 3000, spin: 0.4 };
      const { L, bad } = overlaps(w);
      expect(L.places.size).toBe(items.length);
      expect(bad).toEqual([]);
    }
    // Two that barely touch are barely moved.
    const w2: LaneWorld = { discR: 200, items: [
      { id: 'a', length: 90, height: 90, pinned: 1 }, { id: 'b', length: 90, height: 90, pinned: 1.3 },
    ], dir: 1, budgetR: 3000, spin: 0 };
    const p = layoutLanes(w2).places;
    expect(Math.abs(p.get('a')!.angle - 1)).toBeLessThan(0.1);
    expect(Math.abs(p.get('b')!.angle - 1.3)).toBeLessThan(0.1);
  });

  it('a side with more hulls holds a wider front', () => {
    const items: LaneItem[] = [];
    for (let i = 0; i < 40; i++) items.push({ id: `big${i}`, length: 48, height: 48, side: 'big' });
    for (let i = 0; i < 4; i++) items.push({ id: `few${i}`, length: 48, height: 48, side: 'few' });
    const w: LaneWorld = { discR: 120, items, dir: 1, budgetR: 2000, spin: 0, sides: ['big', 'few'], battleCenter: 0 };
    const L = layoutLanes(w);
    const span = (side: string) => {
      const as = [...L.places.entries()].filter(([id]) => id.startsWith(side)).map(([, p]) => p.angle);
      return Math.max(...as) - Math.min(...as);
    };
    expect(span('big')).toBeGreaterThan(span('few') * 2);
    expect(overlaps(w).bad).toEqual([]);
  });

  it('a small side with one long fleet still fights on the inner lanes', () => {
    const items: LaneItem[] = [];
    for (let i = 0; i < 40; i++) items.push({ id: `big${i}`, length: 50, height: 50, side: 'big' });
    // One flagship trailing a long escort block.
    items.push({ id: 'fleet', length: 160, height: 60, anchor: 25, side: 'fleet' });
    const w: LaneWorld = { discR: 60, items, dir: 1, budgetR: 2000, spin: 0, sides: ['big', 'fleet'], battleCenter: 0 };
    const L = layoutLanes(w);
    expect(L.places.get('fleet')!.lane).toBeLessThanOrEqual(1);
    expect(overlaps(w).bad).toEqual([]);
  });

  it('keeps the station at its own angle', () => {
    const w = world(3, 10, { budgetR: 400 }, true);
    const st = w.items.find(i => i.id === 'station')!;
    expect(layoutLanes(w).places.get('station')!.angle).toBeCloseTo(st.pinned!, 9);
  });

  it('shrinks together before adding lanes, and never below the floor', () => {
    const roomy = world(11, 12, { discR: 120, budgetR: 1000 });
    expect(layoutLanes(roomy).scale).toBe(1);
    const tight = world(11, 12, { discR: 120, budgetR: 200 });
    const t = layoutLanes(tight);
    expect(t.scale).toBeLessThan(1);
    expect(t.scale).toBeGreaterThanOrEqual(LANE_MIN_SCALE);
    // At the floor it does not give up: the lanes run on outward.
    const packed = world(11, 80, { discR: 40, budgetR: 60 });
    const p = layoutLanes(packed);
    expect(p.scale).toBeCloseTo(LANE_MIN_SCALE, 9);
    expect(p.places.size).toBe(80);
    expect(overlaps(packed).bad).toEqual([]);
  });

  it('starts one gap clear of the disc', () => {
    const w: LaneWorld = { discR: 100, items: [{ id: 'a', length: 40, height: 40 }], dir: 1, budgetR: 500, spin: 0 };
    const p = layoutLanes(w).places.get('a')!;
    expect(p.r).toBeCloseTo(100 + LANE_GAP_PX + 20, 6);
  });

  it('points every hull along its lane, in the direction of travel', () => {
    for (const dir of [1, -1]) {
      const w: LaneWorld = { discR: 100, items: [{ id: 'a', length: 40, height: 40 }], dir, budgetR: 500, spin: 0.3 };
      const p = layoutLanes(w).places.get('a')!;
      expect(angDist(p.heading, p.angle + dir * Math.PI / 2)).toBeLessThan(1e-9);
    }
  });
});
