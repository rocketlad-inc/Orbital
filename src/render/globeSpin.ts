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
import { globeKeyOf, templateIdOf, hashStr, mulberry32 } from './planetTexture';
import { artUrl } from './artVersion';

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

interface Surface { img: HTMLImageElement; w: number; h: number; px: Uint32Array | null; failed: boolean; mips?: Uint32Array[] }

/** Box-filtered half-size copies of a surface map (level 0 is the map),
 *  down to 64 texels wide, built once per surface. Sampling the level that
 *  matches a pixel's footprint is what stops the foreshortened limb and
 *  the poles from sparkling as the world turns. */
function mipsOf(surf: Surface): Uint32Array[] {
  if (surf.mips) return surf.mips;
  const levels: Uint32Array[] = [surf.px as Uint32Array];
  let w = surf.w, h = surf.h, src = surf.px as Uint32Array;
  while (w > 64 && h > 32) {
    const w2 = w >> 1, h2 = h >> 1;
    const dst = new Uint32Array(w2 * h2);
    const s8 = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    const d8 = new Uint8Array(dst.buffer);
    for (let y = 0; y < h2; y++) {
      const r0 = (y * 2) * w, r1 = r0 + w;
      for (let x = 0; x < w2; x++) {
        const a0 = (r0 + x * 2) * 4, a1 = a0 + 4, b0 = (r1 + x * 2) * 4, b1 = b0 + 4, o = (y * w2 + x) * 4;
        d8[o] = (s8[a0] + s8[a1] + s8[b0] + s8[b1] + 2) >> 2;
        d8[o + 1] = (s8[a0 + 1] + s8[a1 + 1] + s8[b0 + 1] + s8[b1 + 1] + 2) >> 2;
        d8[o + 2] = (s8[a0 + 2] + s8[a1 + 2] + s8[b0 + 2] + s8[b1 + 2] + 2) >> 2;
        d8[o + 3] = 255;
      }
    }
    levels.push(dst);
    w = w2; h = h2; src = dst;
  }
  surf.mips = levels;
  return levels;
}
const surfaces = new Map<string, Surface>();

/** `hi` selects the double-resolution set (public/surfaces/hi), loaded
 *  only when a world is drawn larger than the regular map can fill: the
 *  world-menu close-up and the deepest map zoom. */
function surfaceFor(key: string, hi = false): Surface | null {
  if (typeof document === 'undefined') return null;
  const mk = hi ? `hi/${key}` : key;
  let s = surfaces.get(mk);
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
    img.src = artUrl(`/surfaces/${mk}.webp`);
    surfaces.set(mk, entry);
    s = entry;
  }
  return s.px ? s : null;
}

// ------------------------------------------------------------
// Sterilised surfaces: impact scars painted INTO the map, so they turn
// with the world and foreshorten at the limb like the ground they sit
// on. (A scar sprite laid over a spinning globe stood still while the
// surface slid under it, and on a bare grey world the scars were the
// only thing you could see: the world looked stopped.) The ash grey
// stays an overlay (drawSterilised); only the craters live here.
// ------------------------------------------------------------

const steriles = new Map<string, Surface>();
const ASH = '196, 188, 176';

/** The sterilised twin of a loaded surface, built once. Crater places
 *  come from the body id in longitude/latitude, so the regular and the
 *  hi-res twin carry the same scars. */
function sterileFor(key: string, hi: boolean, seedId: string): Surface | null {
  const mk = `${hi ? 'hi/' : ''}${key}#ster|${seedId}`;
  const got = steriles.get(mk);
  if (got) return got;
  const base = surfaceFor(key, hi);
  if (!base || !base.px) return null;
  const cv = document.createElement('canvas');
  cv.width = base.w;
  cv.height = base.h;
  const g = cv.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  const img = g.createImageData(base.w, base.h);
  new Uint32Array(img.data.buffer).set(base.px);
  g.putImageData(img, 0, 0);
  paintMapScars(g, base.w, base.h, seedId);
  const data = g.getImageData(0, 0, base.w, base.h).data;
  const entry: Surface = { img: base.img, w: base.w, h: base.h, px: new Uint32Array(data.buffer.slice(0)), failed: false };
  steriles.set(mk, entry);
  if (steriles.size > 8) steriles.delete(steriles.keys().next().value as string);
  return entry;
}

/** Draw `f` at map x and again one map-width either side, so a scar
 *  that straddles the date line is whole. */
function wrapped(W: number, x: number, reach: number, f: (x: number) => void) {
  f(x);
  if (x - reach < 0) f(x + W);
  if (x + reach > W) f(x - W);
}

function paintMapScars(g: CanvasRenderingContext2D, W: number, H: number, seedId: string) {
  const rng = mulberry32(hashStr(seedId) ^ 0x5f3a);
  const pxPerRad = W / (Math.PI * 2);
  // A point spread evenly over the SPHERE, not the map.
  const place = () => {
    const lon = rng() * Math.PI * 2;
    const lat = Math.max(-1.2, Math.min(1.2, Math.asin(rng() * 2 - 1)));
    return { x: (lon / (Math.PI * 2)) * W, y: (0.5 - lat / Math.PI) * H, sx: 1 / Math.max(0.3, Math.cos(lat)) };
  };

  // Soot: broad charred fields where the firestorm burned hottest.
  const soot = 8 + Math.floor(rng() * 4);
  for (let i = 0; i < soot; i++) {
    const p = place(), s = (0.22 + rng() * 0.33) * pxPerRad;
    wrapped(W, p.x, s * p.sx, (x) => {
      g.save(); g.translate(x, p.y); g.scale(p.sx, 1);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, s);
      gr.addColorStop(0, 'rgba(14, 12, 11, 0.34)');
      gr.addColorStop(1, 'rgba(14, 12, 11, 0)');
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, s, 0, Math.PI * 2); g.fill();
      g.restore();
    });
  }

  type Crater = { x: number; y: number; sx: number; r: number; rays: number[] };
  const n = 40 + Math.floor(rng() * 16);
  const craters: Crater[] = [];
  for (let i = 0; i < n; i++) {
    const p = place();
    const ang = 0.022 + 0.16 * Math.pow(rng(), 2.6);
    const rays: number[] = [];
    if (ang > 0.08) { const m = 5 + Math.floor(rng() * 6); for (let k = 0; k < m; k++) rays.push(rng(), rng(), rng(), rng()); }
    craters.push({ ...p, r: ang * pxPerRad, rays });
  }
  // Big first, so small pits land on top of old basins, as they would.
  craters.sort((a, b) => b.r - a.r);

  for (const c of craters) {
    const cr = c.r;
    wrapped(W, c.x, cr * 6 * c.sx, (x) => {
      g.save(); g.translate(x, c.y); g.scale(c.sx, 1);
      const ej = g.createRadialGradient(0, 0, cr * 0.9, 0, 0, cr * 2.5);
      ej.addColorStop(0, `rgba(${ASH}, 0.09)`); ej.addColorStop(1, `rgba(${ASH}, 0)`);
      g.fillStyle = ej; g.beginPath(); g.arc(0, 0, cr * 2.5, 0, Math.PI * 2); g.fill();
      for (let k = 0; k < c.rays.length; k += 4) {
        const ra = c.rays[k] * Math.PI * 2, len = cr * (3 + c.rays[k + 1] * 6), w = cr * (0.05 + c.rays[k + 2] * 0.09);
        const cx = Math.cos(ra), cy = Math.sin(ra);
        const lg = g.createLinearGradient(cx * cr, cy * cr, cx * len, cy * len);
        lg.addColorStop(0, `rgba(${ASH}, ${(0.03 + c.rays[k + 3] * 0.06).toFixed(3)})`); lg.addColorStop(1, `rgba(${ASH}, 0)`);
        g.fillStyle = lg; g.beginPath();
        g.moveTo(cx * cr - cy * w, cy * cr + cx * w); g.lineTo(cx * len, cy * len); g.lineTo(cx * cr + cy * w, cy * cr - cx * w);
        g.closePath(); g.fill();
      }
      const rim = g.createRadialGradient(0, 0, cr * 0.72, 0, 0, cr * 1.14);
      rim.addColorStop(0, `rgba(${ASH}, 0)`); rim.addColorStop(0.55, `rgba(${ASH}, 0.15)`); rim.addColorStop(1, `rgba(${ASH}, 0)`);
      g.fillStyle = rim; g.beginPath(); g.arc(0, 0, cr * 1.14, 0, Math.PI * 2); g.fill();
      // Relief baked the way planetary maps bake it, from a fixed light at
      // the upper left: the lip facing it catches light, the bowl's far
      // wall is lit and its near wall falls into shadow. The game's own
      // terminator still shades the world as it turns.
      const LX = -0.7, LY = -0.7;
      const lip = g.createRadialGradient(LX * cr * 0.9, LY * cr * 0.9, 0, LX * cr * 0.9, LY * cr * 0.9, cr * 0.7);
      lip.addColorStop(0, `rgba(${ASH}, 0.2)`); lip.addColorStop(1, `rgba(${ASH}, 0)`);
      g.fillStyle = lip; g.beginPath(); g.arc(0, 0, cr * 1.1, 0, Math.PI * 2); g.fill();
      g.save();
      g.beginPath(); g.arc(0, 0, cr * 0.84, 0, Math.PI * 2); g.clip();
      const bowl = g.createRadialGradient(0, 0, 0, 0, 0, cr * 0.84);
      bowl.addColorStop(0, 'rgba(22, 20, 19, 0.46)');
      bowl.addColorStop(0.8, 'rgba(16, 14, 13, 0.58)');
      bowl.addColorStop(1, 'rgba(16, 14, 13, 0.3)');
      g.fillStyle = bowl; g.fillRect(-cr, -cr, cr * 2, cr * 2);
      const ox = LX * cr * 0.42, oy = LY * cr * 0.42;
      const wall = g.createRadialGradient(ox, oy, cr * 0.62, ox, oy, cr * 1.2);
      wall.addColorStop(0, `rgba(${ASH}, 0)`);
      wall.addColorStop(0.35, `rgba(${ASH}, 0.3)`);
      wall.addColorStop(1, `rgba(${ASH}, 0.08)`);
      g.fillStyle = wall; g.fillRect(-cr, -cr, cr * 2, cr * 2);
      g.restore();
      if (cr > 0.09 * pxPerRad) {
        const pk = g.createRadialGradient(0, 0, 0, 0, 0, cr * 0.16);
        pk.addColorStop(0, `rgba(${ASH}, 0.35)`); pk.addColorStop(1, `rgba(${ASH}, 0)`);
        g.fillStyle = pk; g.beginPath(); g.arc(0, 0, cr * 0.16, 0, Math.PI * 2); g.fill();
      }
      g.restore();
    });
  }
}

interface Lut { size: number; n: number; idx: Int32Array; row: Int32Array; col: Int32Array; lvl: Uint8Array }
const luts = new Map<string, Lut>();

/** For a size-S sprite of a sphere squashed by `flat`, which map row and
 *  which fixed-point (x256) column each disc pixel shows at zero spin. */
function lutFor(S: number, flat: number, W: number, H: number, maxLevel: number): Lut {
  const k = `${S}|${flat}|${W}|${H}|${maxLevel}`;
  let l = luts.get(k);
  if (l) return l;
  const half = S / 2;
  const margin = 1.5 / half; // a pixel of overdraw, so the clip edge anti-aliases onto surface
  const lim = (1 + margin) * (1 + margin);
  // Two passes straight into typed arrays: a 1024 close-up has ~800k
  // disc pixels, too many to stage in plain arrays.
  let n = 0;
  for (let y = 0; y < S; y++) {
    const ny0 = (y + 0.5 - half) / (half * (1 - flat));
    for (let x = 0; x < S; x++) {
      const nx0 = (x + 0.5 - half) / half;
      if (nx0 * nx0 + ny0 * ny0 <= lim) n++;
    }
  }
  const idx = new Int32Array(n), row = new Int32Array(n), col = new Int32Array(n), lvl = new Uint8Array(n);
  // One screen pixel spans (2/S) of the disc; on the sphere that is 1/nz
  // longer radially. The level comes from the MOST stretched axis and is
  // rounded, the way a GPU picks a mip, so no pixel spans more than ~1.4
  // texels. (Averaging the two axes left the limb on level 0 at medium
  // sizes, where it kept sparkling.)
  const pix = 2 / S, texLat = Math.PI / H, texLon = (Math.PI * 2) / W;
  let i = 0;
  for (let y = 0; y < S; y++) {
    const ny0 = (y + 0.5 - half) / (half * (1 - flat));
    for (let x = 0; x < S; x++) {
      const nx0 = (x + 0.5 - half) / half;
      const d2 = nx0 * nx0 + ny0 * ny0;
      if (d2 > lim) continue;
      const d = Math.sqrt(d2);
      const s = d > 1 ? 1 / d : 1;
      const nx = nx0 * s, ny = ny0 * s;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const lat = Math.asin(Math.max(-1, Math.min(1, -ny)));
      const lon = Math.atan2(nx, nz);
      const foot = Math.max(pix / (Math.max(0.04, nz) * texLat), pix / (texLon * Math.max(0.03, Math.cos(lat))));
      const L = Math.max(0, Math.min(maxLevel, Math.floor(Math.log2(Math.max(1, foot)) + 0.5)));
      const Wl = W >> L, Hl = H >> L;
      const r = Math.max(0, Math.min(Hl - 1, Math.round((0.5 - lat / Math.PI) * (Hl - 1))));
      idx[i] = y * S + x;
      row[i] = r * Wl;
      col[i] = Math.round((lon / (Math.PI * 2)) * Wl * 256);
      lvl[i] = L;
      i++;
    }
  }
  l = { size: S, n, idx, row, col, lvl };
  luts.set(k, l);
  if (luts.size > 20) luts.delete(luts.keys().next().value as string);
  return l;
}

interface Spun { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; image: ImageData; out: Uint32Array; texel: number; waited: number }
const spun = new Map<string, Spun>();

// Per-frame budget, in pixels gathered: a frame is identified by its
// nowMs. Roughly one full close-up, or several map-sized globes.
let frameNow = -1;
let framePixels = 0;
const MAX_PIXELS_PER_FRAME = 1_000_000;
// Every globe the map draws turns (the map draws real globes from 2.5px).
// A 10px floor left small worlds - Luna at a normal zoom - standing still,
// where the old procedural textures had always spun; a small turn IS visible.
const MIN_SPIN_RADIUS = 3;
/** Past this many device pixels across, the regular map runs out of
 *  detail and the hi-res set takes over (up to a 1024 sprite). */
const HI_RES_FROM = 512;
const SIZES = [32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];

export interface SpinningGlobe { canvas: HTMLCanvasElement; flatten: number; lean: number }

/**
 * The world's globe turned to `nowMs`, sized for a disc of `radius` css px,
 * or null while its surface map is still loading (draw the sprite).
 */
export function getSpinningGlobe(
  body: Body, terraformed: boolean, radius: number, nowMs: number, sterile = false,
): SpinningGlobe | null {
  // Only the tiniest dots keep the static sprite.
  if (radius < MIN_SPIN_RADIUS) return null;
  const key = globeKeyOf(body, terraformed);
  if (!key) return null;
  const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
  const want = radius * 2 * dpr;
  // Big on screen: the hi-res map once it has arrived (the regular one
  // keeps the world turning while it loads).
  // A sterilised world turns its own scarred twin of the same map.
  const pick = (hi: boolean) => {
    const s = surfaceFor(key, hi);
    return s && sterile ? sterileFor(key, hi, body.id) : s;
  };
  const hiSurf = want > HI_RES_FROM ? pick(true) : null;
  const surf = hiSurf ?? pick(false);
  if (!surf || !surf.px) return null;
  const hi = surf === hiSurf;
  const id = templateIdOf(body.id);
  const flat = FLATTEN[id] ?? 0;
  // Half-octave sizes, the smallest that covers the disc (10% slack):
  // drawn at most ~1.1x up or 1.5x down, instead of up to 2x off with
  // power-of-two sizes, which is what made the worlds soft.
  const cap = hi ? 1024 : 512;
  let S = SIZES[SIZES.length - 1];
  for (const z of SIZES) { if (z >= want * 0.9) { S = z; break; } }
  S = Math.min(S, cap);

  const W = surf.w, H = surf.h;
  const mips = mipsOf(surf);
  const lut = lutFor(S, flat, W, H, mips.length - 1);
  const ck = `${hi ? 'hi/' : ''}${key}${sterile ? '#ster' : ''}|${S}`;
  let e = spun.get(ck);
  if (!e) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const g = canvas.getContext('2d');
    if (!g) return null;
    const image = g.createImageData(S, S);
    e = { canvas, g, image, out: new Uint32Array(image.data.buffer), texel: Number.NaN, waited: 0 };
    spun.set(ck, e);
    // Sized for every world on screen at once: a cache smaller than the
    // visible set evicts and rebuilds canvases every frame.
    if (spun.size > 96) spun.delete(spun.keys().next().value as string);
  }

  const phase = ((nowMs * spinRate(body.type)) / 2) % 1;
  const shiftFx = Math.floor(phase * W * 256);
  const texel = shiftFx >> 8;
  // Re-render once the surface has moved about a pixel at this size (a
  // hi-res close-up waits for two texels: still under a pixel and a half
  // at its centre, and half the uploads of a 1024 image).
  const step = Math.max(hi ? 2 : 1, Math.floor(W / (Math.PI * S)));
  const moved = Number.isNaN(e.texel) ? Infinity : Math.min(Math.abs(texel - e.texel), W - Math.abs(texel - e.texel));
  if (nowMs !== frameNow) { frameNow = nowMs; framePixels = 0; }
  // The budget spreads work across frames; it must never STARVE a globe.
  // A world due to turn but passed over twice in a row renders anyway.
  // (A close-up drawn after other big worlds lost the race every frame
  // and froze: a sterilised world zoomed in stood completely still.)
  const due = moved >= step;
  if (due && (Number.isNaN(e.texel) || e.waited >= 2 || framePixels + lut.n <= MAX_PIXELS_PER_FRAME)) {
    framePixels += lut.n;
    e.waited = 0;
    const { idx, row, col, lvl, n } = lut;
    const out = e.out;
    const masks = mips.map((_, L) => (W >> L) - 1);
    for (let i = 0; i < n; i++) {
      const L = lvl[i];
      out[idx[i]] = mips[L][row[i] + (((col[i] - (shiftFx >> L)) >> 8) & masks[L])];
    }
    e.g.putImageData(e.image, 0, 0);
    e.texel = texel;
  } else if (due) {
    e.waited++;
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
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
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
