// A HAIRLINE CROSSED EVERY WORLD IN CLOSE-UP (QA, 2026-10-23: Venus f194
// x~480 y~130-300; also Io, Ganymede, Callisto, Luna and the gate). It
// read as an orbit trail drawn over the disc. It was the NAME LABEL's
// leader: drawn from the anchor's centre to the label's centre, and a
// label with a yield line, set just above or below its world, clears the
// "displaced" test by three px, so every such world wore a line from its
// limb to the middle of its globe.

import { requestLabel, flushLabels, leaderSegment } from '../labelLayer';

type Call = { name: string; args: number[] };

function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(t, key) {
      if (key in t) return t[key as string];
      if (key === 'measureText') return (s: string) => ({ width: s.length * 6 });
      return (...args: number[]) => { calls.push({ name: String(key), args }); };
    },
    set(t, key, value) { t[key as string] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

/** Distance from (cx, cy) to the segment a-b. */
function segDist(cx: number, cy: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / l2)) : 0;
  return Math.hypot(cx - (ax + dx * t), cy - (ay + dy * t));
}

describe('a world name label never draws a line across its world', () => {
  it('a name with a yield line, set just beside a big world', () => {
    const { ctx, calls } = recordingCtx();
    const drawnR = 140;
    requestLabel({
      id: 'body:venus', kind: 'body', text: 'VENUS', sub: '1M 3C 4S',
      x: 400, y: 300, radius: drawnR + 4, priority: 52,
      font: '10px "Audiowide", monospace', subFont: '9px "Audiowide", monospace',
      color: '#8aa0b4', leader: true,
    });
    flushLabels(ctx, 4, 800, 700);
    // Every stroked segment stays outside the drawn disc.
    let from: number[] | null = null;
    for (const c of calls) {
      if (c.name === 'moveTo') from = c.args;
      else if (c.name === 'lineTo' && from) {
        expect(segDist(400, 300, from[0], from[1], c.args[0], c.args[1])).toBeGreaterThanOrEqual(drawnR);
        from = c.args;
      }
    }
  });

  it('a label displaced well away still gets a leader, from the limb to the label', () => {
    const seg = leaderSegment({ x: 400, y: 300, radius: 50 }, { x: 500, y: 200, w: 60, h: 20 })!;
    expect(seg).not.toBeNull();
    expect(Math.hypot(seg.x1 - 400, seg.y1 - 300)).toBeCloseTo(50, 5);
    // ...ending on the label's nearest corner.
    expect(seg.x2).toBe(500);
    expect(seg.y2).toBe(220);
  });

  it('a label sitting right at the limb needs none', () => {
    expect(leaderSegment({ x: 400, y: 300, radius: 50 }, { x: 380, y: 356, w: 40, h: 20 })).toBeNull();
  });
});
