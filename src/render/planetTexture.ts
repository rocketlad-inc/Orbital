// ============================================================
// planetTexture — procedural per-body surface textures.
//
// Each body gets ONE offscreen canvas (256px), painted lazily the
// first time the body renders above the textured-sphere threshold
// and cached in a small LRU. Painting is seeded by the body id, so
// a given world always looks the same — across frames, sessions,
// and every player's client (no network sync needed).
//
// The map renderer draws the texture clipped to the planet disk and
// layers the sun-relative terminator on top, so this module knows
// nothing about lighting or camera — it just paints flat "daylight"
// surface art.
//
// Perf contract: zero per-frame painting. A body's texture is painted
// exactly once (~1–2ms), then every frame is a single drawImage.
// ============================================================

import { Body } from '../types';
import { COLORS, lighten, darken, withOpacity } from './colors';

export const TEX_SIZE = 256;
const TEX_R = TEX_SIZE / 2;      // feature-space radius — art is composed
                                 // for the disk inscribed in the square

// ------------------------------------------------------------
// Seeded RNG — FNV-1a hash + mulberry32. Deterministic per body id.
// Exported for reuse (night-light scatter in mapRenderer).
// ------------------------------------------------------------

export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------
// LRU cache. Bodies are bounded (~60/game) but far-system maps can
// push more; cap keeps worst-case memory ~10MB (40 × 256² RGBA).
// ------------------------------------------------------------

// CAP MUST EXCEED THE LIVE BODY COUNT (~60-70 with rogue asteroids +
// far systems). A cap below it causes classic sequential-scan LRU
// thrash: every frame, every body misses and REPAINTS its texture —
// observed as multi-second frames at high zoom. 160 × 256²px RGBA
// ≈ 40MB worst case, and in practice only bodies that ever exceeded
// the 8px threshold allocate at all.
const CACHE_CAP = 160;
const cache = new Map<string, HTMLCanvasElement | null>();

export function getPlanetTexture(body: Body): HTMLCanvasElement | null {
  const hit = cache.get(body.id);
  if (hit !== undefined) {
    // Refresh recency (Map preserves insertion order).
    cache.delete(body.id);
    cache.set(body.id, hit);
    return hit;
  }
  const tex = paintTexture(body);
  cache.set(body.id, tex);
  if (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return tex;
}

// ------------------------------------------------------------
// Cloud layer — a SECOND cached 256² canvas per terrestrial body,
// scrolled slowly across the surface texture by the renderer for
// live cloud drift. Separate Map so evicting a surface texture
// doesn't drop its clouds (and vice versa); same cap discipline.
// ------------------------------------------------------------

const cloudCache = new Map<string, HTMLCanvasElement | null>();

export function getCloudTexture(body: Body): HTMLCanvasElement | null {
  const hit = cloudCache.get(body.id);
  if (hit !== undefined) {
    cloudCache.delete(body.id);
    cloudCache.set(body.id, hit);
    return hit;
  }
  const tex = paintClouds(body);
  cloudCache.set(body.id, tex);
  if (cloudCache.size > CACHE_CAP) {
    const oldest = cloudCache.keys().next().value;
    if (oldest !== undefined) cloudCache.delete(oldest);
  }
  return tex;
}

function paintClouds(body: Body): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const off = document.createElement('canvas');
  off.width = TEX_SIZE;
  off.height = TEX_SIZE;
  const c = off.getContext('2d');
  if (!c) return null;

  // Distinct seed stream from the surface art so the clouds don't echo
  // the body layout beneath them.
  const rand = mulberry32(hashStr(body.id + ':clouds'));
  if (body.type === 'gas_giant' || body.type === 'ice_giant') {
    paintGiantClouds(c, body, rand);
  } else {
    paintTerrestrialClouds(c, rand);
  }
  return off;
}

/** Puffy weather banks for terrestrials — sparse clusters biased into
 *  horizontal streaks, plus lone wisps. */
function paintTerrestrialClouds(c: CanvasRenderingContext2D, rand: () => number) {
  /** One soft puff. Painted at x, x−TEX_SIZE and x+TEX_SIZE so the
   *  horizontal wrap seam (the drift scroll) stays continuous. */
  const puff = (px: number, py: number, pr: number, alpha: number) => {
    for (const wx of [px - TEX_SIZE, px, px + TEX_SIZE]) {
      const g = c.createRadialGradient(wx, py, 0, wx, py, pr);
      g.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
      g.addColorStop(0.6, `rgba(255, 255, 255, ${alpha * 0.55})`);
      g.addColorStop(1, 'rgba(255, 255, 255, 0)');
      c.fillStyle = g;
      c.fillRect(wx - pr, py - pr, pr * 2, pr * 2);
    }
  };

  const clusters = 4 + Math.floor(rand() * 3);
  for (let i = 0; i < clusters; i++) {
    const cx = rand() * TEX_SIZE;
    const cy = TEX_SIZE * (0.15 + rand() * 0.7);
    const puffs = 3 + Math.floor(rand() * 4);
    for (let j = 0; j < puffs; j++) {
      puff(
        cx + (rand() - 0.5) * TEX_R * 0.9,       // wide horizontal spread
        cy + (rand() - 0.5) * TEX_R * 0.28,      // tight vertical spread
        TEX_R * (0.07 + rand() * 0.1),
        0.4 + rand() * 0.25,
      );
    }
  }
  for (let i = 0; i < 3; i++) {
    puff(rand() * TEX_SIZE, rand() * TEX_SIZE, TEX_R * (0.05 + rand() * 0.05), 0.3);
  }
}

/** Cloud deck for gas / ice giants — the moving layer the base bands
 *  scud under. Full-width translucent streaks form the banded backdrop
 *  (they wrap trivially, being uniform in x); the drift the renderer
 *  applies is CARRIED by the flattened wisps and the storm oval, which
 *  DO vary horizontally and so visibly churn across the disk. */
function paintGiantClouds(c: CanvasRenderingContext2D, body: Body, rand: () => number) {
  // Cream / white / pale-tan cloud tops — the tones gas-giant highlights
  // read as, independent of the (often vivid) base hue underneath.
  const TINTS = ['245, 240, 228', '255, 255, 255', '226, 212, 190'];

  /** Flattened elliptical puff, wrap-tripled in x. A unit-circle radial
   *  gradient is scaled into a wide, thin streak (giant cloud shear). */
  const wisp = (px: number, py: number, prx: number, pry: number, alpha: number, tint: string) => {
    for (const wx of [px - TEX_SIZE, px, px + TEX_SIZE]) {
      c.save();
      c.translate(wx, py);
      c.scale(prx, pry);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, `rgba(${tint}, ${alpha})`);
      g.addColorStop(0.6, `rgba(${tint}, ${alpha * 0.5})`);
      g.addColorStop(1, `rgba(${tint}, 0)`);
      c.fillStyle = g;
      c.fillRect(-1, -1, 2, 2);
      c.restore();
    }
  };

  // Banded backdrop — soft full-width streaks.
  const streaks = 6 + Math.floor(rand() * 4);
  for (let i = 0; i < streaks; i++) {
    const y = rand() * TEX_SIZE;
    const h = TEX_R * (0.03 + rand() * 0.1);
    const alpha = 0.1 + rand() * 0.16;
    const tint = TINTS[Math.floor(rand() * TINTS.length)];
    const g = c.createLinearGradient(0, y - h, 0, y + h);
    g.addColorStop(0, `rgba(${tint}, 0)`);
    g.addColorStop(0.5, `rgba(${tint}, ${alpha})`);
    g.addColorStop(1, `rgba(${tint}, 0)`);
    c.fillStyle = g;
    c.fillRect(0, y - h, TEX_SIZE, h * 2);
  }

  // Turbulent wisps riding the bands — these drift visibly.
  const wisps = 16 + Math.floor(rand() * 10);
  for (let i = 0; i < wisps; i++) {
    wisp(
      rand() * TEX_SIZE, rand() * TEX_SIZE,
      TEX_R * (0.08 + rand() * 0.14),          // wide
      TEX_R * (0.02 + rand() * 0.05),          // thin
      0.1 + rand() * 0.16,
      TINTS[Math.floor(rand() * TINTS.length)],
    );
  }

  // Great storm — a bright cyclonic oval with a darker eye. Ice giants
  // get a fainter, cooler one; gas giants a bold warm one.
  const warm = body.type === 'gas_giant';
  const sx = rand() * TEX_SIZE;
  const sy = TEX_SIZE * (0.3 + rand() * 0.45);
  const srx = TEX_R * (0.12 + rand() * 0.06);
  const sry = srx * 0.55;
  wisp(sx, sy, srx, sry, warm ? 0.5 : 0.3, warm ? '255, 236, 210' : '210, 226, 240');
  wisp(sx, sy, srx * 0.5, sry * 0.5, warm ? 0.4 : 0.24, warm ? '150, 90, 70' : '90, 120, 150');
}

/** Test hook / hot-reload safety. */
export function clearPlanetTextureCache() {
  cache.clear();
  cloudCache.clear();
}

// ------------------------------------------------------------
// Recipes
// ------------------------------------------------------------

function paintTexture(body: Body): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const off = document.createElement('canvas');
  off.width = TEX_SIZE;
  off.height = TEX_SIZE;
  const c = off.getContext('2d');
  if (!c) return null;

  const rand = mulberry32(hashStr(body.id));
  const base = body.color || COLORS.planetDefault;

  // Hand-authored worlds keep their signature art (ported from the
  // old drawSurfaceFeatures), everything else gets a seeded recipe.
  if (body.id === 'earth') {
    paintEarth(c);
  } else if (body.id === 'mars') {
    paintMars(c, base);
  } else if (body.type === 'gas_giant') {
    paintGasGiant(c, base, rand);
  } else if (body.type === 'ice_giant') {
    paintIceGiant(c, base, rand);
  } else if (body.type === 'terrestrial' || body.type === 'dwarf') {
    paintTerrestrial(c, base, rand);
  } else {
    // moons, asteroids, lagrange rocks — cratered regolith
    paintRocky(c, base, rand);
  }
  return off;
}

function fillBase(c: CanvasRenderingContext2D, color: string) {
  c.fillStyle = color;
  c.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
}

/** Blob cluster — the organic-landmass trick from the old Earth art:
 *  several overlapping circles filled as one mass. */
function blobCluster(
  c: CanvasRenderingContext2D,
  rand: () => number,
  cx: number, cy: number,
  count: number, spread: number, rMin: number, rMax: number,
  color: string,
) {
  c.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const bx = cx + (rand() - 0.5) * spread * 2;
    const by = cy + (rand() - 0.5) * spread * 2;
    const br = rMin + rand() * (rMax - rMin);
    c.beginPath();
    c.arc(bx, by, br, 0, Math.PI * 2);
    c.fill();
  }
}

function paintEarth(c: CanvasRenderingContext2D) {
  fillBase(c, '#2c5d82');
  const land = '#3f8a4f';
  const landDark = '#356b3f';
  // Same hand-placed continents as the old drawSurfaceFeatures, in
  // radius-units → texture space (unit = TEX_R, center = TEX_R).
  const groups: Array<[string, Array<[number, number, number]>]> = [
    [land, [[-0.45, -0.35, 0.30], [-0.55, 0.05, 0.28], [-0.40, 0.40, 0.26], [-0.30, 0.10, 0.22]]],
    [landDark, [[0.30, -0.25, 0.34], [0.50, 0.05, 0.26], [0.25, 0.20, 0.30], [0.55, -0.35, 0.20]]],
    [land, [[0.05, 0.62, 0.20], [-0.12, 0.66, 0.16]]],
  ];
  for (const [color, blobs] of groups) {
    c.fillStyle = color;
    for (const [dx, dy, r] of blobs) {
      c.beginPath();
      c.arc(TEX_R + dx * TEX_R, TEX_R + dy * TEX_R, r * TEX_R, 0, Math.PI * 2);
      c.fill();
    }
  }
  // Polar caps
  c.fillStyle = 'rgba(234, 242, 247, 0.92)';
  c.beginPath();
  c.ellipse(TEX_R, TEX_R * 0.16, TEX_R * 0.5, TEX_R * 0.14, 0, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.ellipse(TEX_R, TEX_SIZE - TEX_R * 0.12, TEX_R * 0.42, TEX_R * 0.12, 0, 0, Math.PI * 2);
  c.fill();
}

function paintMars(c: CanvasRenderingContext2D, base: string) {
  fillBase(c, base);
  // Darker highland smudges for texture
  c.fillStyle = withOpacity(darken(base, 0.75), 0.5);
  const patches: Array<[number, number, number, number]> = [
    [0.7, 1.05, 0.42, 0.20], [1.35, 0.85, 0.34, 0.16], [1.0, 1.4, 0.5, 0.18],
  ];
  for (const [px, py, rx, ry] of patches) {
    c.beginPath();
    c.ellipse(px * TEX_R, py * TEX_R, rx * TEX_R, ry * TEX_R, 0.3, 0, Math.PI * 2);
    c.fill();
  }
  // Ice caps — the signature look
  c.fillStyle = '#eaf2f7';
  c.beginPath();
  c.ellipse(TEX_R, TEX_R * 0.22, TEX_R * 0.62, TEX_R * 0.30, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = 'rgba(234, 242, 247, 0.8)';
  c.beginPath();
  c.ellipse(TEX_R, TEX_SIZE - TEX_R * 0.14, TEX_R * 0.40, TEX_R * 0.20, 0, 0, Math.PI * 2);
  c.fill();
}

function paintTerrestrial(c: CanvasRenderingContext2D, base: string, rand: () => number) {
  fillBase(c, base);
  // Land tones lean warm/organic; pick a seeded pair.
  const palettes: Array<[string, string]> = [
    ['#3f8a4f', '#356b3f'],   // verdant
    ['#8a6f42', '#6f5834'],   // arid
    ['#7a5a3a', '#5e452c'],   // rocky brown
    ['#5d7a45', '#4a6136'],   // scrub
  ];
  const [landA, landB] = palettes[Math.floor(rand() * palettes.length)];
  const clusters = 3 + Math.floor(rand() * 3);
  for (let i = 0; i < clusters; i++) {
    const cx = TEX_R + (rand() - 0.5) * TEX_R * 1.3;
    const cy = TEX_R + (rand() - 0.5) * TEX_R * 1.3;
    blobCluster(c, rand, cx, cy, 3 + Math.floor(rand() * 3), TEX_R * 0.22,
      TEX_R * 0.12, TEX_R * 0.3, i % 2 === 0 ? landA : landB);
  }
  // Occasional polar cap
  if (rand() < 0.5) {
    c.fillStyle = 'rgba(234, 242, 247, 0.85)';
    c.beginPath();
    c.ellipse(TEX_R, TEX_R * 0.18, TEX_R * 0.48, TEX_R * 0.14, 0, 0, Math.PI * 2);
    c.fill();
  }
}

function paintRocky(c: CanvasRenderingContext2D, base: string, rand: () => number) {
  fillBase(c, base);
  // Maria — broad darker patches under the craters
  for (let i = 0; i < 3; i++) {
    c.fillStyle = withOpacity(darken(base, 0.8), 0.45);
    c.beginPath();
    c.ellipse(
      TEX_R + (rand() - 0.5) * TEX_R * 1.2,
      TEX_R + (rand() - 0.5) * TEX_R * 1.2,
      TEX_R * (0.2 + rand() * 0.3), TEX_R * (0.15 + rand() * 0.25),
      rand() * Math.PI, 0, Math.PI * 2,
    );
    c.fill();
  }
  // Craters — shadowed floor + a bright rim arc on the up-sun side.
  const craters = 8 + Math.floor(rand() * 8);
  for (let i = 0; i < craters; i++) {
    const cx = TEX_R + (rand() - 0.5) * TEX_R * 1.6;
    const cy = TEX_R + (rand() - 0.5) * TEX_R * 1.6;
    const cr = TEX_R * (0.03 + rand() * 0.08);
    c.fillStyle = withOpacity(darken(base, 0.65), 0.8);
    c.beginPath();
    c.arc(cx, cy, cr, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = withOpacity(lighten(base, 1.35), 0.7);
    c.lineWidth = Math.max(1, cr * 0.22);
    c.beginPath();
    c.arc(cx, cy, cr, Math.PI * 0.75, Math.PI * 1.6);
    c.stroke();
  }
}

function paintGasGiant(c: CanvasRenderingContext2D, base: string, rand: () => number) {
  // The base is now just the giant's BODY — a smooth banded atmosphere.
  // All the moving detail (storm, wisps, bright streaks) lives in the
  // separate, scrolling cloud deck (paintGiantClouds), so this stays a
  // clean underlayer that reads well beneath it.
  //
  // Vertical depth gradient: lighter toward the equator-ish top, deeper
  // toward the poles, so the disk feels spherical before shading.
  const bg = c.createLinearGradient(0, 0, 0, TEX_SIZE);
  bg.addColorStop(0, lighten(base, 1.14));
  bg.addColorStop(0.5, base);
  bg.addColorStop(1, darken(base, 0.8));
  c.fillStyle = bg;
  c.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  // Bold soft-edged latitudinal bands — the deep atmosphere layers.
  // Soft (gradient) edges, not hard rects, so the cloud deck sits over
  // a believable body instead of a striped flag.
  const bands = 7 + Math.floor(rand() * 3);
  let y = 0;
  for (let i = 0; i < bands; i++) {
    const h = (TEX_SIZE / bands) * (0.7 + rand() * 0.6);
    const tint = i % 2 === 0 ? lighten(base, 1.16) : darken(base, 0.8);
    const g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, withOpacity(tint, 0));
    g.addColorStop(0.5, withOpacity(tint, 0.45 + rand() * 0.15));
    g.addColorStop(1, withOpacity(tint, 0));
    c.fillStyle = g;
    c.fillRect(0, y, TEX_SIZE, h);
    y += h;
  }
}

function paintIceGiant(c: CanvasRenderingContext2D, base: string, rand: () => number) {
  fillBase(c, base);
  // Three wide, soft bands — ice giants read smooth.
  const bandYs = [0.25, 0.55, 0.8];
  for (let i = 0; i < bandYs.length; i++) {
    const tint = i % 2 === 0 ? lighten(base, 1.12) : darken(base, 0.88);
    c.fillStyle = withOpacity(tint, 0.4);
    c.fillRect(0, bandYs[i] * TEX_SIZE - 18, TEX_SIZE, 36 + rand() * 10);
  }
  // One faint streak
  c.fillStyle = withOpacity(lighten(base, 1.3), 0.3);
  c.fillRect(0, (0.3 + rand() * 0.4) * TEX_SIZE, TEX_SIZE, 2);
}
