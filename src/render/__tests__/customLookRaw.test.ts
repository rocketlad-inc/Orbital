// A custom map's world (the Map Maker) wears its maker's living surface
// as its TERRAFORMED face only. Raw, it paints the ordinary raw recipe in
// its own colour: it used to wear the living palette from tick 0, so a
// default 'verdant' planet looked terraformed already and the payload
// changed nothing on screen (2026-10-15 audit). Gas/storm stays banded
// either way, and a shipped world (no look) is untouched.

import { paintSurfaceOnto } from '../planetTexture';
import type { Body } from '../../types';

/** Records every fillStyle a painter sets, in order. */
function recorder() {
  const fills: string[] = [];
  const noop = () => undefined;
  const grad = { addColorStop: noop };
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (_t, k) => {
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => grad;
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return noop;
    },
    set: (_t, k, v) => {
      if (k === 'fillStyle' && typeof v === 'string') fills.push(v);
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills };
}

const world = (over: Partial<Body>): Body => ({
  id: 'cm_home', name: 'Home', type: 'terrestrial', parent: 'sol',
  orbitRadius: 400, orbitPeriod: 600, angle0: 0, radius: 3, soi: 50,
  color: '#8a6f42', ...over,
} as Body);

describe('custom-map surfaces: raw until terraformed', () => {
  it('a raw verdant world floods with its own colour, not the living ocean', () => {
    const raw = recorder();
    paintSurfaceOnto(raw.ctx, world({ look: { surface: 'verdant', rings: false } }), 'raw');
    expect(raw.fills[0]).toBe('#8a6f42');
    const tf = recorder();
    paintSurfaceOnto(tf.ctx, world({ look: { surface: 'verdant', rings: false } }), 'terraformed');
    expect(tf.fills[0]).not.toBe('#8a6f42');
  });

  it('raw is the same face a world with no look paints', () => {
    const custom = recorder();
    paintSurfaceOnto(custom.ctx, world({ look: { surface: 'ocean', rings: false } }), 'raw');
    const plain = recorder();
    paintSurfaceOnto(plain.ctx, world({}), 'raw');
    expect(custom.fills).toEqual(plain.fills);
  });

  it('the terraformed face is the biome its maker chose', () => {
    const desert = recorder();
    paintSurfaceOnto(desert.ctx, world({ look: { surface: 'desert', rings: false } }), 'terraformed');
    const ocean = recorder();
    paintSurfaceOnto(ocean.ctx, world({ look: { surface: 'ocean', rings: false } }), 'terraformed');
    expect(desert.fills[0]).not.toEqual(ocean.fills[0]);
  });
});
