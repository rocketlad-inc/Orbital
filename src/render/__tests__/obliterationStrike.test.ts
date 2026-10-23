// AN OBLITERATION HAS A STRIKE (Studio clip "mega-destroyer-obliterates-
// callisto", 2026-10-23, f155-f157). Callisto went whole -> one frame of
// flat placeholder discs -> rubble, with no beam and no blast: the queue
// played world_obliterated as the ship-death flash, a pinpoint at the
// centre, and the body renderer drew the debris field the frame the tick
// landed, before its rock art had loaded.
//
// Now: the Mega's beam, the world held whole under it, then a planet-
// scale burst; and the rubble's art is fetched while the world is held.

import { fxKindFor } from '../pendingFx';
import {
  spawnObliteration, obliterationHoldsWorldWhole, drawSterilisations,
  OBLITERATE_LIFE_MS, OBLITERATE_BURST,
} from '../combatFx';
import { drawsAsDebris, rubbleArtRequested, type RenderContext } from '../mapRenderer';
import type { Body } from '../../types';

// jsdom has no 2D canvas: the baked glow sprites fall back to plain arcs.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

type Call = { name: string; args: unknown[]; fillStyle?: unknown; strokeStyle?: unknown };

/** A 2D context that records every call, with the styles at that moment. */
function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(t, key) {
      if (key in t) return t[key as string];
      return (...args: unknown[]) => {
        calls.push({ name: String(key), args, fillStyle: t.fillStyle, strokeStyle: t.strokeStyle });
        return { addColorStop: () => {} };
      };
    },
    set(t, key, value) { t[key as string] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const R = 100;
const CALLISTO = { id: 'callisto-ob', name: 'Callisto', type: 'moon', radius: 2 } as unknown as Body;

function rcAt(ctx: CanvasRenderingContext2D, t = 30, nowMs = 0): RenderContext {
  return {
    ctx, canvas: { width: 800, height: 600 }, camera: { x: 0, y: 0, scale: R / 2 },
    t, nowMs, bodies: [CALLISTO],
    presentation: { radius: new Map([[CALLISTO.id, R]]) },
  } as unknown as RenderContext;
}

describe('world_obliterated plays a strike, not a ship death', () => {
  it('the Mega Destroyer\'s obliteration has its own effect', () => {
    expect(fxKindFor('world_obliterated')).toBe('obliterate');
    expect(fxKindFor('world_obliterated', 'mega_destroyer')).toBe('obliterate');
  });

  it("the Leviathan's keeps its own set piece", () => {
    expect(fxKindFor('world_obliterated', 'kaiju')).toBe('kaiju_break');
  });
});

describe('the strike', () => {
  it('fires its beam on the very first frame', () => {
    const { ctx, calls } = recordingCtx();
    spawnObliteration('obl-1', CALLISTO.id);
    drawSterilisations(rcAt(ctx), performance.now());
    // No Mega drawn in this test: the gun is above the world (cp.y - 6R).
    const beam = calls.filter(c => c.name === 'moveTo'
      && Math.abs((c.args[0] as number) - 400) < 1 && Math.abs((c.args[1] as number) - (300 - 6 * R)) < 1);
    expect(beam.length).toBeGreaterThan(0);
  });

  it('holds the world whole under the beam, then lets it burst', () => {
    const t0 = performance.now();
    spawnObliteration('obl-2', 'europa-ob');
    expect(obliterationHoldsWorldWhole('europa-ob', t0 + 50)).toBe(true);
    expect(obliterationHoldsWorldWhole('europa-ob', t0 + OBLITERATE_LIFE_MS * (OBLITERATE_BURST + 0.05))).toBe(false);
    expect(obliterationHoldsWorldWhole('io-ob', t0 + 50)).toBe(false);
  });

  it('the burst is planet-sized: a shockwave several radii out, and shards of rock', () => {
    const { ctx, calls } = recordingCtx();
    spawnObliteration('obl-3', CALLISTO.id);
    const t0 = performance.now();
    drawSterilisations(rcAt(ctx), t0 + OBLITERATE_LIFE_MS * (OBLITERATE_BURST + 0.15));
    const arcs = calls.filter(c => c.name === 'arc').map(c => c.args[2] as number);
    expect(Math.max(...arcs)).toBeGreaterThan(R * 2.5);
    // Rock-toned shards, not the world's map-dot colour.
    const shardFills = calls.filter(c => c.name === 'fill' && typeof c.fillStyle === 'string'
      && /^#(8a8178|6f6860|5a544d|4a4540)$/.test(c.fillStyle as string));
    expect(shardFills.length).toBeGreaterThan(10);
  });
});

describe('the body renderer', () => {
  it('a world this client drew whole stays whole until its strike begins, then until the burst', () => {
    const ctx = recordingCtx().ctx;
    const whole = { ...CALLISTO, id: 'ganymede-ob', obliteratedAtTick: null } as unknown as Body;
    expect(drawsAsDebris(whole, rcAt(ctx, 26))).toBe(false);
    const struck = { ...whole, obliteratedAtTick: 27 } as unknown as Body;
    // The tick landed; the strike has not started playing here yet.
    expect(drawsAsDebris(struck, rcAt(ctx, 27.1, performance.now()))).toBe(false);
    const t0 = performance.now();
    spawnObliteration('obl-4', 'ganymede-ob');
    expect(drawsAsDebris(struck, rcAt(ctx, 27.2, t0 + 100))).toBe(false);
    expect(drawsAsDebris(struck, rcAt(ctx, 28, t0 + OBLITERATE_LIFE_MS * 0.9))).toBe(true);
  });

  it('fetches the rubble art while the world is held, so the burst never shows placeholder discs', () => {
    const ctx = recordingCtx().ctx;
    const whole = { ...CALLISTO, id: 'titan-ob', obliteratedAtTick: null } as unknown as Body;
    drawsAsDebris(whole, rcAt(ctx, 26));
    drawsAsDebris({ ...whole, obliteratedAtTick: 27 } as unknown as Body, rcAt(ctx, 27.1));
    expect(rubbleArtRequested()).toBe(true);
  });

  it('a world destroyed before this client ever drew it is simply rubble', () => {
    const ctx = recordingCtx().ctx;
    const old = { ...CALLISTO, id: 'dione-ob', obliteratedAtTick: 27 } as unknown as Body;
    expect(drawsAsDebris(old, rcAt(ctx, 27.1))).toBe(true);
  });
});
