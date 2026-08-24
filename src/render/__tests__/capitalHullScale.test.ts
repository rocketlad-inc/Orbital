// HOW BIG DOES A SPRITE ACTUALLY DRAW?
//
// Twice now a megastructure sprite has shipped bigger than the planets
// it orbits — first the construction sites, now the two capital hulls —
// and both times the mistake was the same one: the `size` argument was
// read as "roughly how big this is" when the drawing code treats it as a
// half-extent and then hangs radiators, barrels and glow off the far end
// of that. Nobody can eyeball the difference between size and 2.4×size
// in a function that draws forty primitives.
//
// So this measures it. A recording context walks the same affine
// transform stack a real canvas would, collects every coordinate the
// sprite touches, and reports the bounding box. The numbers below are
// therefore the drawn truth rather than the nominal argument, which is
// the only version worth comparing against a planet.

import fs from 'fs';
import path from 'path';
import { drawCapitalHull, isCapitalHull, drawCompletedStructure,
  drawConstructionSite, drawStructureGlyph } from '../megastructureArt';
import { MEGASTRUCTURES, MEGASTRUCTURE_KINDS } from '../../game/megastructures';
import { shipIconSize } from '../mapRenderer';

/** 2D affine matrix as [a, b, c, d, e, f], same order as setTransform. */
type M = [number, number, number, number, number, number];
const IDENT: M = [1, 0, 0, 1, 0, 0];

function mul(m: M, n: M): M {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

interface Box { minX: number; maxX: number; minY: number; maxY: number }

/**
 * A canvas context that draws nothing and remembers where it was asked
 * to. Only the surface megastructureArt actually uses is implemented;
 * anything it grows later shows up as a TypeError rather than a silent
 * miss, which is the failure mode worth having.
 */
function recorder() {
  let m: M = [...IDENT] as M;
  const stack: M[] = [];
  const box: Box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  let lineWidth = 1;

  const mark = (x: number, y: number, pad = 0) => {
    const wx = m[0] * x + m[2] * y + m[4];
    const wy = m[1] * x + m[3] * y + m[5];
    // Stroke width spills half its thickness either side of the path —
    // in LOCAL units, so it has to go through the transform's scale the
    // same way the coordinates just did. Without this the harness
    // over-reports by roughly the stroke weight on every scaled sprite.
    const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
    const localScale = det > 0 ? Math.sqrt(det) : 1;
    const p = (pad + lineWidth / 2) * localScale;
    box.minX = Math.min(box.minX, wx - p);
    box.maxX = Math.max(box.maxX, wx + p);
    box.minY = Math.min(box.minY, wy - p);
    box.maxY = Math.max(box.maxY, wy + p);
  };

  const grad = () => ({ addColorStop: () => {} });

  const g: any = {
    save() { stack.push([...m] as M); },
    restore() { const p = stack.pop(); if (p) m = p; },
    translate(x: number, y: number) { m = mul(m, [1, 0, 0, 1, x, y]); },
    rotate(r: number) {
      const c = Math.cos(r); const s = Math.sin(r);
      m = mul(m, [c, s, -s, c, 0, 0]);
    },
    scale(x: number, y: number) { m = mul(m, [x, 0, 0, y, 0, 0]); },
    beginPath() {}, closePath() {}, clip() {},
    moveTo: mark, lineTo: mark,
    rect(x: number, y: number, w: number, h: number) { mark(x, y); mark(x + w, y + h); },
    arc(x: number, y: number, r: number) { mark(x - r, y - r); mark(x + r, y + r); },
    ellipse(x: number, y: number, rx: number, ry: number) { mark(x - rx, y - ry); mark(x + rx, y + ry); },
    quadraticCurveTo(cx: number, cy: number, x: number, y: number) { mark(cx, cy); mark(x, y); },
    bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number) {
      mark(a, b); mark(c, d); mark(x, y);
    },
    fill() {}, stroke() {},
    fillRect(x: number, y: number, w: number, h: number) { mark(x, y); mark(x + w, y + h); },
    strokeRect(x: number, y: number, w: number, h: number) { mark(x, y); mark(x + w, y + h); },
    arcTo(a1: number, b1: number, c1: number, d1: number) { mark(a1, b1); mark(c1, d1); },
    roundRect(x: number, y: number, w: number, h: number) { mark(x, y); mark(x + w, y + h); },
    createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) {
      // A radial gradient paints out to its far radius wherever it is
      // used as a fill, so it counts toward the drawn size. This is
      // exactly what made the sites read as huge: the glow, not the hull.
      mark(x1 - r1, y1 - r1); mark(x1 + r1, y1 + r1);
      void x0; void y0; void r0;
      return grad();
    },
    createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
      mark(x0, y0); mark(x1, y1);
      return grad();
    },
    setLineDash() {},
  };
  // Style setters are writes we do not care about, except lineWidth.
  for (const k of ['fillStyle', 'strokeStyle', 'lineCap', 'lineJoin', 'globalAlpha',
    'globalCompositeOperation', 'shadowBlur', 'shadowColor', 'filter', 'font',
    'textAlign', 'textBaseline', 'miterLimit', 'lineDashOffset']) {
    Object.defineProperty(g, k, { get: () => '', set: () => {}, configurable: true });
  }
  Object.defineProperty(g, 'lineWidth', {
    get: () => lineWidth, set: (v: number) => { lineWidth = Number(v) || 0; }, configurable: true,
  });

  return { g, box };
}

/** Widest dimension the sprite actually paints, for a given size arg. */
function drawnSpan(shipClass: string, size: number): number {
  const { g, box } = recorder();
  drawCapitalHull(g, shipClass, size, '#7fd4ff', 0);
  return Math.max(box.maxX - box.minX, box.maxY - box.minY);
}

const CAPITALS = ['mega_destroyer', 'mobile_foundry'];

describe('capital hulls draw at the size they are given', () => {
  it.each(CAPITALS)('%s stays inside its own size argument', (cls) => {
    // The whole bug in one assertion. `size` is what the renderer sizes
    // the hitbox from and what every other sprite honours, so a hull
    // that paints wider than it has silently opted out of the map's
    // scale — and out of being clickable where it looks.
    const span = drawnSpan(cls, 100);
    expect(span).toBeLessThanOrEqual(100);
  });

  it.each(CAPITALS)('%s is not a dot either', (cls) => {
    // The other direction: a hull that shrank to nothing would pass the
    // test above while being unfindable on the map.
    expect(drawnSpan(cls, 100)).toBeGreaterThan(55);
  });

  it('scales linearly with the size argument', () => {
    // If it does not, tuning the rest size does not do what it looks
    // like it does.
    for (const cls of CAPITALS) {
      const a = drawnSpan(cls, 50);
      const b = drawnSpan(cls, 200);
      expect(b / a).toBeCloseTo(4, 1);
    }
  });
});

describe('capital hulls are ships, not planets', () => {
  // Venus is radius 3 in the catalogue and the map multiplies by a
  // body_scale of 2, so it renders 12 units across. A capital hull that
  // draws wider than a terrestrial world reads as a moon with engines —
  // which is exactly what shipped.
  const VENUS_DIAMETER_UNITS = 12;

  it.each(CAPITALS)('%s is smaller on screen than Venus', (cls) => {
    // shipIconSize already folds in SHIP_ICON_SCALE, so this is the
    // number the renderer really passes in at rest.
    const size = shipIconSize(cls, false);
    const span = drawnSpan(cls, size);
    // At the zoom where a body unit is one pixel, Venus is 12px. Ships
    // are drawn in screen pixels rather than world units, so the honest
    // comparison is against the pixels-per-unit the map uses when a
    // planet fills a comfortable part of the frame — 12.5, measured off
    // the real canvas.
    const venusPx = VENUS_DIAMETER_UNITS * 12.5;
    expect(span).toBeLessThan(venusPx);
  });

  it('the destroyer is the bigger of the two', () => {
    // It is the one with a gun the length of the ship. If this flips,
    // the two sprites have been swapped somewhere.
    expect(shipIconSize('mega_destroyer', false))
      .toBeGreaterThan(shipIconSize('mobile_foundry', false));
  });

  it('both are classed as capital hulls by the renderer', () => {
    for (const cls of CAPITALS) expect(isCapitalHull(cls)).toBe(true);
    expect(isCapitalHull('destroyer')).toBe(false);
  });
});

// ---------------------------------------------------------------------
// BOTH DRAW PATHS HAVE TO KNOW ABOUT CAPITAL HULLS.
//
// There are two: drawShip for a parked hull and drawTorchTransitShip for
// one under burn. Only the parked one had the capital-hull branch, so a
// Mega Destroyer mid-flight fell through to the dot-and-nose fallback
// and rendered as a 5px dot with a full-size exhaust plume behind it —
// the engine appeared to have lost its ship.
//
// The cause is worth pinning rather than the symptom: getShipIconImage
// is keyed on ShipIconClass, the two mega classes are not in that union,
// and a miss returns null instead of failing. Any new draw path will hit
// the same trapdoor.
describe('every ship draw path handles capital hulls', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'mapRenderer.ts'), 'utf8',
  );

  /** Body of a named function, to its closing brace at column 0. */
  function fnBody(name: string): string {
    const i = src.indexOf(`function ${name}(`);
    expect(i).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', i);
    return src.slice(i, end === -1 ? src.length : end);
  }

  it.each(['drawShip', 'drawTorchTransitShip'])('%s draws capital hulls itself', (fn) => {
    const body = fnBody(fn);
    expect(body).toMatch(/isCapitalHull\(ship\.class\)/);
    expect(body).toMatch(/drawCapitalHull\(/);
  });

  it('the transit fallback dot never fires for a capital hull', () => {
    // Belt and braces: even with the branch above present, the old
    // else-branch would still paint a dot on top if it were reachable.
    expect(fnBody('drawTorchTransitShip')).toMatch(/\} else if \(!capital\) \{/);
  });
});

// ---------------------------------------------------------------------
// THE STRUCTURE SPRITES, MEASURED THE SAME WAY.
//
// The sites were the FIRST thing to ship bigger than the planets they
// orbit — a warp gate site rendered about three times the width of
// Venus — and the fix at the time was to bring the catalogue radii down
// by hand and look at a screenshot. Nothing pinned it, so the capital
// hulls made the identical mistake two weeks later.
//
// These take a RADIUS rather than a box width, and the art deliberately
// reaches past it (gantries, rings, glow). That is fine; what is not
// fine is not knowing by how much. The bound below is the measured
// truth, so a future edit that doubles a radiator fails here instead of
// in a screenshot.
describe('structure sprites stay inside their radius budget', () => {
  const R = 100;
  /** Widest dimension painted for a given radius argument. */
  function structureSpan(fn: (g: unknown) => void): number {
    const { g, box } = recorder();
    fn(g);
    return Math.max(box.maxX - box.minX, box.maxY - box.minY);
  }

  const KINDS = MEGASTRUCTURE_KINDS;

  // A RATCHET, NOT A DESIGN TARGET. The widest kind measures 4.41R
  // today — rings and gantries reaching about 2.2 radii from centre —
  // and at the radii the catalogue actually uses that puts a finished
  // gate at roughly 0.7x Venus on screen, which is the size these were
  // signed off at. The bound sits just above the measured worst case so
  // it catches a future edit that doubles something, without pretending
  // the current art is wrong.
  const SPAN_BUDGET = 4.6;

  it.each(KINDS)('completed %s stays within its span budget', (kind) => {
    const span = structureSpan(g => drawCompletedStructure(
      g as never, 0, 0, R, kind, MEGASTRUCTURES[kind].color, 0));
    expect(span).toBeLessThanOrEqual(SPAN_BUDGET * R);
  });

  it.each(KINDS)('completed %s is not a dot', (kind) => {
    const span = structureSpan(g => drawCompletedStructure(
      g as never, 0, 0, R, kind, MEGASTRUCTURES[kind].color, 0));
    expect(span).toBeGreaterThan(R);
  });

  it.each([0, 0.25, 0.5, 0.75, 1])('a site at %s progress stays in budget', (p) => {
    const span = structureSpan(g => drawConstructionSite(
      g as never, 0, 0, R, p as number, '#7fd4ff', 0));
    expect(span).toBeLessThanOrEqual(SPAN_BUDGET * R);
  });

  it('the far-zoom glyph is bounded by its own radius', () => {
    // The glyph exists to be legible when the sprite cannot be. If it
    // overdrew it would collide with neighbouring bodies at exactly the
    // zoom where things are already crowded.
    for (const complete of [true, false]) {
      const span = structureSpan(g => drawStructureGlyph(
        g as never, 0, 0, R, '#7fd4ff', complete));
      expect(span).toBeLessThanOrEqual(2.2 * R);
      expect(span).toBeGreaterThan(R);
    }
  });
});
