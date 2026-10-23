// THE BEAM LANDS ON OR BEFORE THE FRAME THE KILL SHOWS (Studio clip
// "mega-destroyer-sterilises-venus", 2026-10-23, f30-f32). The cities and
// the charge ring left the map, and debris flew, on f30; the beam only
// appeared on f31-32. Two causes: the beam faded in from alpha 0 over its
// first 156 ms (so on its first frame only its sparks drew), and a world
// strike queued behind other effects waited out their stagger.

import { spawnSterilisation, drawSterilisations } from '../combatFx';
import { ingestChronicleFx, drainVisibleFx, resetPendingFx, PendingFx } from '../pendingFx';
import type { RenderContext } from '../mapRenderer';
import type { Body } from '../../types';

// jsdom has no 2D canvas: the baked glow sprites fall back to plain arcs.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

type Call = { name: string; args: unknown[]; alpha: number; strokeStyle?: unknown };

function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(t, key) {
      if (key in t) return t[key as string];
      return (...args: unknown[]) => {
        calls.push({ name: String(key), args, alpha: t.globalAlpha as number, strokeStyle: t.strokeStyle });
        return { addColorStop: () => {} };
      };
    },
    set(t, key, value) { t[key as string] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const R = 120;
const VENUS = { id: 'venus-s', name: 'Venus', type: 'terrestrial', radius: 3 } as unknown as Body;

describe('the sterilisation beam', () => {
  it('is fully drawn on the frame the strike begins', () => {
    const { ctx, calls } = recordingCtx();
    const rc = {
      ctx, canvas: { width: 800, height: 600 }, camera: { x: 0, y: 0, scale: R / 3 },
      t: 30, nowMs: 0, bodies: [VENUS], presentation: { radius: new Map([[VENUS.id, R]]) },
    } as unknown as RenderContext;
    spawnSterilisation('ster-1', VENUS.id);
    drawSterilisations(rc, performance.now());
    // The beam's strokes leave the gun (no Mega drawn here: above the
    // world, cp.y - 6R) at full strength: its core layer is 0.95 opaque.
    const beamStarts = calls.filter(c => c.name === 'moveTo'
      && Math.abs((c.args[0] as number) - 400) < 1 && Math.abs((c.args[1] as number) - (300 - 6 * R)) < 1);
    expect(beamStarts.length).toBeGreaterThanOrEqual(3);
    const core = calls.find(c => c.name === 'stroke' && typeof c.strokeStyle === 'string'
      && /rgba\(255, 244, 234, 0\.9/.test(c.strokeStyle as string));
    expect(core).toBeDefined();
  });
});

describe('a world strike does not wait its turn', () => {
  beforeEach(() => {
    resetPendingFx();
    try { localStorage.clear(); } catch { /* jsdom */ }
  });

  it('plays the frame it can be seen, ahead of the stagger', () => {
    ingestChronicleFx('gs1', [
      { id: 'boom', kind: 'ship_destroyed', bodyId: 'venus', shipId: 'g:s1' },
      { id: 'strike', kind: 'terraform_destroyed', bodyId: 'venus', cause: 'mega_destroyer' },
    ]);
    const fired: PendingFx[] = [];
    const now = performance.now() + 1000;
    drainVisibleFx(now, () => ({ x: 100, y: 100 }), fx => { fired.push(fx); });
    expect(fired.map(f => f.kind)).toContain('sterilise');
  });

  it('...and a strike fired just after another effect is not held back either', () => {
    ingestChronicleFx('gs2', [{ id: 'boom2', kind: 'ship_destroyed', bodyId: 'venus', shipId: 'g:s2' }]);
    const fired: PendingFx[] = [];
    const now = performance.now() + 1000;
    drainVisibleFx(now, () => ({ x: 100, y: 100 }), fx => { fired.push(fx); });
    ingestChronicleFx('gs2', [{ id: 'strike2', kind: 'world_obliterated', bodyId: 'venus' }]);
    drainVisibleFx(now + 33, () => ({ x: 100, y: 100 }), fx => { fired.push(fx); });
    expect(fired.map(f => f.id)).toEqual(['boom2', 'strike2']);
  });
});
