// The reach ring draws at the zoom where you can SEE it.
//
// Noah, 2026-09-24: "the 'show reach' button ... just zooms the map out
// but doesn't show a radius". A structure is a glyph once it is under
// ~9px, and drawMegastructureBody returned right after the glyph --
// before the reach. So the ring only ever drew zoomed in close, where a
// 2800-unit circle is entirely off-screen, and SHOW REACH zoomed out to
// exactly the view that skipped it.

import { drawMegastructureBody } from '../mapRenderer';
import type { RenderContext } from '../mapRenderer';
import { setReachPinned } from '../../game/structureReach';

/** A 2D context that draws nothing and remembers every arc. */
function arcRecorder() {
  const arcs: number[] = [];
  const noop = () => {};
  const gradient = { addColorStop: noop };
  const target: Record<string, unknown> = {
    arc: (_x: number, _y: number, r: number) => { arcs.push(r); },
    measureText: (s: string) => ({ width: s.length * 6 }),
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    getLineDash: () => [],
    globalAlpha: 1,
    canvas: { width: 1200, height: 800 },
  };
  const ctx = new Proxy(target, {
    get: (t, k: string) => (k in t ? t[k] : noop),
    set: (t, k: string, v) => { t[k] = v; return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, arcs };
}

function draw(scale: number, radiusPx: number, pinned: boolean, ownedBy: string) {
  const { ctx, arcs } = arcRecorder();
  const body = { id: 'mega_1', type: 'megastructure', ownedBy, radius: 1.4 } as never;
  setReachPinned('mega_1', pinned);
  const rc = {
    ctx, canvas: ctx.canvas, camera: { x: 0, y: 0, scale },
    t: 0, nowMs: 0, bodies: [], sensorScale: 4, systemScale: 4,
  } as unknown as RenderContext;
  drawMegastructureBody(body, { x: 600, y: 400 }, radiusPx, rc, 1, true, 'null_field', '#c0392b');
  setReachPinned('mega_1', false);
  // The Null Field's ring: 700 x sensorScale 4 = 2800 world units.
  return arcs.some(r => Math.abs(r - 2800 * scale) < 0.5);
}

describe('structure reach ring', () => {
  it('draws when zoomed OUT, where the structure is only a glyph (the reported case)', () => {
    // 2800 * 0.1 = 280px ring; the structure itself is 3px.
    expect(draw(0.1, 3, true, 'player')).toBe(true);
  });

  it('still draws zoomed in, under the full sprite', () => {
    expect(draw(0.1, 30, true, 'player')).toBe(true);
  });

  it('is not drawn unless pinned, selected or focused', () => {
    expect(draw(0.1, 3, false, 'player')).toBe(false);
  });

  it('is never drawn for a rival structure', () => {
    expect(draw(0.1, 3, true, 'enemy')).toBe(false);
  });
});
