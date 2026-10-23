// A colony ship that settles on arrival becomes its station in ONE motion
// (2026-10-23, the colony clip at f602 -> f603).
//
// The server parks the hull and founds the station in the same tick
// (room.js settleOnArrival), so the next /state has no ship and a new
// station: the hull vanished from where it was last drawn and the station
// appeared in its orbit slot, ~300 px away at that zoom. Now the new
// station starts where the hull was drawn and glides into its slot,
// riding the world while it does.

import { seedSettleGlide, settleGlideCanvasPos, SETTLE_GLIDE_MS } from '../mapRenderer';

// worldToCanvas for a camera at the origin, 20 px a unit, on a 1000x600 canvas.
const ctx = {
  camera: { x: 0, y: 0, scale: 20 },
  canvas: { width: 1000, height: 600 },
} as unknown as Parameters<typeof settleGlideCanvasPos>[3];
const toCanvas = (w: { x: number; y: number }) => ({ x: 500 + w.x * 20, y: 300 + w.y * 20 });

describe('settle glide', () => {
  const world = { x: 0, y: 0 };
  const slot = toCanvas({ x: 7, y: 0 });          // the station's own orbit spot
  const hull = { x: -19, y: -13 };                 // where the colony ship was drawn

  it('starts where the hull was drawn', () => {
    seedSettleGlide('st1', hull, world, 1000);
    const p = settleGlideCanvasPos('st1', world, slot, ctx, 1000);
    expect(p.x).toBeCloseTo(toCanvas(hull).x, 5);
    expect(p.y).toBeCloseTo(toCanvas(hull).y, 5);
  });

  it('is between the two halfway through, and in its slot at the end', () => {
    seedSettleGlide('st2', hull, world, 1000);
    const mid = settleGlideCanvasPos('st2', world, slot, ctx, 1000 + SETTLE_GLIDE_MS / 2);
    const a = toCanvas(hull);
    expect(mid.x).toBeGreaterThan(a.x);
    expect(mid.x).toBeLessThan(slot.x);
    const end = settleGlideCanvasPos('st2', world, slot, ctx, 1000 + SETTLE_GLIDE_MS + 1);
    expect(end).toEqual(slot);
  });

  it('rides the world while it glides', () => {
    seedSettleGlide('st3', hull, world, 1000);
    const moved = { x: 5, y: 2 };
    const p = settleGlideCanvasPos('st3', moved, toCanvas({ x: 12, y: 2 }), ctx, 1000);
    const want = toCanvas({ x: hull.x + 5, y: hull.y + 2 });
    expect(p.x).toBeCloseTo(want.x, 5);
    expect(p.y).toBeCloseTo(want.y, 5);
  });

  it('leaves every other station where it is', () => {
    expect(settleGlideCanvasPos('other', world, slot, ctx, 1000)).toBe(slot);
  });
});
