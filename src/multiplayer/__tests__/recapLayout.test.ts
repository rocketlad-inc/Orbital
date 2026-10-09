// The recap lays its hulls out by the game's whole-orbit rule (Lorne,
// 2026-10-09: a 72-hull fight at Mars drew as one blob). These hold the
// two promises that matter on screen: no two sprites touch at ANY angle
// the tilted battle turns through, and the fight stays in the frame.

import { layoutRecap, glideSlot, type RecapBeat } from '../recapLayout';

const TILT = 0.58;
const OPTS = { planetR: 84, tilt: TILT, rMax: 293, stationPx: 75, seed: 7, order: ['f1', 'f2', 'f3', 'f6'] };

/** A beat with `n` hulls per faction, ids unique to the beat's roster. */
function beat(counts: Record<string, number>, size = 23, station = false): RecapBeat {
  const units = Object.entries(counts).flatMap(([f, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `${f}-${i}`, faction: f, size, armed: true })));
  return { units, stationId: station ? 'stn' : undefined };
}

function screenOverlaps(b: RecapBeat, slots: Map<string, { r: number; theta: number }>, k: number) {
  const size = new Map(b.units.map(u => [u.id, u.size * k]));
  if (b.stationId) size.set(b.stationId, OPTS.stationPx * k);
  const ids = [...slots.keys()];
  let worst = 0;
  for (let rot = 0; rot < Math.PI * 2; rot += 0.15) {
    const p = ids.map(id => {
      const s = slots.get(id)!;
      return { x: s.r * Math.cos(s.theta + rot), y: s.r * Math.sin(s.theta + rot) * TILT, s: size.get(id)! };
    });
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
      const need = (p[i].s + p[j].s) * 0.42;
      worst = Math.max(worst, need - Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y));
    }
  }
  return worst;
}

describe('recap battle layout', () => {
  it('spreads a big four-sided fight with no sprites touching on screen', () => {
    const b = beat({ f1: 9, f2: 6, f3: 4, f6: 1 }, 23, true);
    const lay = layoutRecap([b], OPTS);
    expect(lay.beats[0].size).toBe(21);
    expect(screenOverlaps(b, lay.beats[0], lay.k)).toBeLessThanOrEqual(0.5);
    for (const s of lay.beats[0].values()) expect(s.r).toBeGreaterThan(OPTS.planetR);
  });

  it('shrinks the sprites to keep a crowded fight in the frame, once for the whole recap', () => {
    const small = beat({ f1: 2, f2: 2 });
    const huge = beat({ f1: 40, f2: 40 }, 30);
    const lay = layoutRecap([small, huge, small], OPTS);
    expect(lay.k).toBeLessThan(1);
    for (const [bi, b] of [small, huge, small].entries()) {
      for (const u of b.units) {
        const s = lay.beats[bi].get(u.id)!;
        expect(s.r + (u.size * lay.k) / 2).toBeLessThanOrEqual(OPTS.rMax + 40);
      }
    }
  });

  it('keeps a hull that left the board where it last stood (its wreck)', () => {
    const a = beat({ f1: 3, f2: 3 });
    const b = { units: a.units.filter(u => u.id !== 'f1-0') };
    const lay = layoutRecap([a, b], OPTS);
    expect(lay.beats[1].has('f1-0')).toBe(false);
    expect(lay.carry[1].get('f1-0')).toEqual(lay.beats[0].get('f1-0'));
  });

  it('does not move anyone when a hull leaves or dies', () => {
    const a = beat({ f1: 6, f2: 5 });
    const b = { units: a.units.filter(u => u.id !== 'f1-2' && u.id !== 'f2-0') };
    const lay = layoutRecap([a, b], OPTS);
    for (const u of b.units) expect(lay.beats[1].get(u.id)).toEqual(lay.beats[0].get(u.id));
  });

  it('fits an arrival in without moving the hulls already there', () => {
    const a = beat({ f1: 6, f2: 5 });
    const b = { units: [...a.units, { id: 'f1-new', faction: 'f1', size: 28, armed: true },
      { id: 'f2-new', faction: 'f2', size: 36, armed: true }] };
    const lay = layoutRecap([a, b], OPTS);
    for (const u of a.units) expect(lay.beats[1].get(u.id)).toEqual(lay.beats[0].get(u.id));
    expect(lay.beats[1].has('f1-new')).toBe(true);
    expect(screenOverlaps(b, lay.beats[1], lay.k)).toBeLessThanOrEqual(0.5);
  });

  it('re-solves when a new side joins the fight', () => {
    const a = beat({ f1: 4, f2: 4 });
    const b = beat({ f1: 4, f2: 4, f3: 4 });
    const lay = layoutRecap([a, b], OPTS);
    expect(lay.beats[1].size).toBe(12);
    expect(screenOverlaps(b, lay.beats[1], lay.k)).toBeLessThanOrEqual(0.5);
  });

  it('keeps every hull in view behind the world (its orbit clears the disc)', () => {
    const b = beat({ f1: 9, f2: 6, f3: 4 }, 23, true);
    b.units.push({ id: 'big', faction: 'f1', size: 64, armed: true });
    const lay = layoutRecap([b], OPTS);
    // Straight behind the world, a hull is drawn r x TILT above its centre.
    for (const s of lay.beats[0].values()) expect(s.r * TILT).toBeGreaterThanOrEqual(OPTS.planetR - 0.5);
  });

  it('glides the short way round', () => {
    const g = glideSlot({ r: 100, theta: 3.0, jitter: 0 }, { r: 120, theta: -3.0, jitter: 0 }, 0.5);
    expect(g.r).toBe(110);
    expect(Math.abs(g.theta - (3.0 + (2 * Math.PI - 6) / 2))).toBeLessThan(1e-9);
  });
});
