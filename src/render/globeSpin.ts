// ============================================================
// Spinning globes (visual overhaul, STAGING ONLY — see dev branch).
//
// The real-map globes used to be static sprites. Here each world's flat
// (equirectangular) surface map is wrapped onto a sphere at run time and
// turned about an upright axis, the surface sliding left to right the
// way the procedural worlds always have, at the same rates.
//
// Cheap by construction:
//   * the projection is a LOOKUP TABLE per sprite size, built once: for
//     every pixel of the disc, which map row and which (fixed-point)
//     column it shows. Turning the world is then one subtraction and a
//     mask per pixel — a pure gather, no trig, no shading.
//   * limb darkening is a radial gradient drawn over the result, not
//     work in the loop.
//   * a globe re-renders only when its surface has moved at least one
//     pixel at the size it is drawn, and at most a few globes re-render
//     in any one frame; the rest reuse their last image.
// Until a world's map has loaded the caller keeps drawing the static
// sprite, so nothing ever pops to empty.
// ============================================================

import type { Body } from '../types';
import { globeKeyOf, templateIdOf } from './planetTexture';

/** Oblate worlds keep their squash (sprite values). */
const FLATTEN: Record<string, number> = { jupiter: 0.065, saturn: 0.1, haumea: 0.38 };
/** Ringed worlds lean with their rings; every other axis stands upright. */
const LEAN: Record<string, number> = { saturn: 0.35, uranus: 0.35 };

/** One full turn takes 2 / rate ms: the procedural surfaces scroll a
 *  2r-wide texture at r * rate px/ms, so this matches them exactly. */
function spinRate(type: string): number {
  if (type === 'gas_giant') return 0.00006;
  if (type === 'ice_giant') return 0.00005;
  return 0.000035;
}

interface Surface { img: HTMLImageElement; w: number; h: number; px: Uint32Array | null; failed: boolean }
const surfaces = new Map<string, Surface>();

function surfaceFor(key: string): Surface | null {
  if (typeof document === 'undefined') return null;
  let s = surfaces.get(key);
  if (!s) {
    const img = new Image();
    img.decoding = 'async';
    const entry: Surface = { img, w: 0, h: 0, px: null, failed: false };
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth;
        cv.height = img.naturalHeight;
        const g = cv.getContext('2d', { willReadFrequently: true });
        if (!g) { entry.failed = true; return; }
        g.drawImage(img, 0, 0);
        const data = g.getImageData(0, 0, cv.width, cv.height).data;
        entry.px = new Uint32Array(data.buffer.slice(0));
        entry.w = cv.width;
        entry.h = cv.height;
      } catch {
        entry.failed = true;
      }
    };
    img.onerror = () => { entry.failed = true; };
    img.src = `/surfaces/${key}.webp`;
    surfaces.set(key, entry);
    s = entry;
  }
  return s.px ? s : null;
}

interface Lut { size: number; n: number; idx: Int32Array; row: Int32Array; col: Int32Array }
const luts = new Map<string, Lut>();

/** For a size-S sprite of a sphere squashed by `flat`, which map row and
 *  which fixed-point (x256) column each disc pixel shows at zero spin. */
function lutFor(S: number, flat: number, W: number, H: number): Lut {
  const k = `${S}|${flat}|${W}|${H}`;
  let l = luts.get(k);
  if (l) return l;
  const half = S / 2;
  const margin = 1.5 / half; // a pixel of overdraw, so the clip edge anti-aliases onto surface
  const idx: number[] = [], row: number[] = [], col: number[] = [];
  for (let y = 0; y < S; y++) {
    const ny0 = (y + 0.5 - half) / (half * (1 - flat));
    for (let x = 0; x < S; x++) {
      const nx0 = (x + 0.5 - half) / half;
      const d2 = nx0 * nx0 + ny0 * ny0;
      if (d2 > (1 + margin) * (1 + margin)) continue;
      const d = Math.sqrt(d2);
      const s = d > 1 ? 1 / d : 1;
      const nx = nx0 * s, ny = ny0 * s;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const lat = Math.asin(Math.max(-1, Math.min(1, -ny)));
      const lon = Math.atan2(nx, nz);
      const r = Math.max(0, Math.min(H - 1, Math.round((0.5 - lat / Math.PI) * (H - 1))));
      idx.push(y * S + x);
      row.push(r * W);
      col.push(Math.round((lon / (Math.PI * 2)) * W * 256));
    }
  }
  l = { size: S, n: idx.length, idx: Int32Array.from(idx), row: Int32Array.from(row), col: Int32Array.from(col) };
  luts.set(k, l);
  if (luts.size > 24) luts.delete(luts.keys().next().value as string);
  return l;
}

interface Spun { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; image: ImageData; out: Uint32Array; texel: number }
const spun = new Map<string, Spun>();

// Per-frame budget: a frame is identified by its nowMs.
let frameNow = -1;
let frameRenders = 0;
const MAX_RENDERS_PER_FRAME = 4;
const MIN_SPIN_RADIUS = 10;

export interface SpinningGlobe { canvas: HTMLCanvasElement; flatten: number; lean: number }

/**
 * The world's globe turned to `nowMs`, sized for a disc of `radius` css px,
 * or null while its surface map is still loading (draw the sprite).
 */
export function getSpinningGlobe(body: Body, terraformed: boolean, radius: number, nowMs: number): SpinningGlobe | null {
  // Below ~20px across a turn is invisible; the static sprite is free.
  if (radius < MIN_SPIN_RADIUS) return null;
  const key = globeKeyOf(body, terraformed);
  if (!key) return null;
  const surf = surfaceFor(key);
  if (!surf || !surf.px) return null;
  const id = templateIdOf(body.id);
  const flat = FLATTEN[id] ?? 0;
  const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
  const want = radius * 2 * dpr;
  let S = 32;
  while (S < want && S < 512) S *= 2;

  const W = surf.w, H = surf.h, mask = W - 1;
  const lut = lutFor(S, flat, W, H);
  const ck = `${key}|${S}`;
  let e = spun.get(ck);
  if (!e) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const g = canvas.getContext('2d');
    if (!g) return null;
    const image = g.createImageData(S, S);
    e = { canvas, g, image, out: new Uint32Array(image.data.buffer), texel: Number.NaN };
    spun.set(ck, e);
    // Sized for every world on screen at once: a cache smaller than the
    // visible set evicts and rebuilds canvases every frame.
    if (spun.size > 96) spun.delete(spun.keys().next().value as string);
  }

  const phase = ((nowMs * spinRate(body.type)) / 2) % 1;
  const shiftFx = Math.floor(phase * W * 256);
  const texel = shiftFx >> 8;
  // Re-render once the surface has moved about a pixel at this size.
  const step = Math.max(1, Math.floor(W / (Math.PI * S)));
  const moved = Number.isNaN(e.texel) ? Infinity : Math.min(Math.abs(texel - e.texel), W - Math.abs(texel - e.texel));
  if (nowMs !== frameNow) { frameNow = nowMs; frameRenders = 0; }
  if (moved >= step && (Number.isNaN(e.texel) || frameRenders < MAX_RENDERS_PER_FRAME)) {
    frameRenders++;
    const { idx, row, col, n } = lut;
    const src = surf.px, out = e.out;
    for (let i = 0; i < n; i++) out[idx[i]] = src[row[i] + (((col[i] - shiftFx) >> 8) & mask)];
    e.g.putImageData(e.image, 0, 0);
    e.texel = texel;
  }
  return { canvas: e.canvas, flatten: flat, lean: LEAN[id] ?? 0 };
}

/** Draw a spun globe: clipped to its (possibly oblate) disc, leaned for
 *  ringed worlds, with the limb darkening the static sprites had baked in. */
export function drawSpinningGlobe(c: CanvasRenderingContext2D, g: SpinningGlobe, x: number, y: number, r: number) {
  const ry = r * (1 - g.flatten);
  c.save();
  c.translate(x, y);
  if (g.lean) c.rotate(g.lean);
  c.beginPath();
  c.ellipse(0, 0, r, ry, 0, 0, Math.PI * 2);
  c.clip();
  c.drawImage(g.canvas, -r, -r, r * 2, r * 2);
  if (r > 3) {
    c.scale(1, 1 - g.flatten);
    // shade = 0.72 + 0.28 * nz^0.9 * (1 - 0.3 (1 - nz)^2), as the sprites
    const lg = c.createRadialGradient(0, 0, 0, 0, 0, r);
    for (const d of [0, 0.5, 0.7, 0.82, 0.9, 0.95, 1]) {
      const nz = Math.sqrt(Math.max(0, 1 - d * d));
      const shade = 0.72 + 0.28 * Math.pow(nz, 0.9) * (1 - 0.3 * (1 - nz) * (1 - nz));
      lg.addColorStop(d, `rgba(0, 0, 0, ${(1 - shade).toFixed(3)})`);
    }
    c.fillStyle = lg;
    c.fillRect(-r, -r, r * 2, r * 2);
  }
  c.restore();
}
