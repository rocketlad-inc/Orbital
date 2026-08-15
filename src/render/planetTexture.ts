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
  return getCachedTexture(body, 'raw');
}

/** The TERRAFORMED face of a body (DESIGN-terraforming stage 7).
 *  Painted from the SAME seed stream as the raw texture, so every
 *  continent silhouette, mare and crater sits exactly where it does on
 *  the raw art — only the surface is reinterpreted (regolith → ocean,
 *  rock → vegetation, craters → lakes). The renderer crossfades
 *  raw → this across the transformation window. Cached like any other
 *  texture; the crossfade costs one extra drawImage only WHILE a world
 *  is mid-transformation. */
export function getTerraformedTexture(body: Body): HTMLCanvasElement | null {
  return getCachedTexture(body, 'terraformed');
}

/** How long the raw→terraformed crossfade reads over, in ticks. */
const TF_VISUAL_DURATION = 24;

/**
 * How terraformed a body should LOOK right now: 0 = raw, 1 = fully
 * terraformed, in between = mid-transformation crossfade.
 *
 * Lives here rather than in the map renderer because it answers a
 * texture question — which face to paint and how far to blend — and
 * because every surface that draws a body needs the same answer. The
 * map, the world-menu closeup and the Outliner icon all call this, so a
 * world can never look terraformed in one panel and raw in another.
 *
 * Deliberately never returns exactly 1 while the window is open: the
 * world isn't terraformed until the SERVER flips terraformedAtTick, and
 * art that finished early would be lying about a gameplay state.
 */
export function terraformFraction(body: Body, t: number): number {
  if (body.terraformedAtTick != null) return 1;
  const at = body.terraformCompletesAtTick;
  if (at == null) return 0;
  return Math.max(0.15, Math.min(0.92, 1 - (at - t) / TF_VISUAL_DURATION));
}

function getCachedTexture(body: Body, variant: TexVariant): HTMLCanvasElement | null {
  const key = variant === 'raw' ? body.id : body.id + '\u0000tf';
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh recency (Map preserves insertion order).
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const tex = paintTexture(body, variant);
  cache.set(key, tex);
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

type TexVariant = 'raw' | 'terraformed';

/** Terraformed surface palette. The GEOMETRY of the art never changes
 *  between variants (same rand stream, same code path) — only these
 *  fills do, so continents/craters keep their silhouettes. */
interface TfPalette {
  ocean: string;      // replaces the raw base (regolith → sea)
  landA: string;      // replaces raw land tone A (vegetation)
  landB: string;      // replaces raw land tone B
  lake: string;       // crater floors → water
  capAlpha: number;   // polar-ice presence (tundra worlds cap harder)
  /** Emissive lava, volcanic worlds only. Painted as a SEPARATE pass
   *  after the shared geometry (see paintLavaSeams) so it can't disturb
   *  the rand() stream the continents are built from. */
  lava?: string;
  lavaGlow?: string;
  /** How much of the surface runs molten, 0..1. */
  lavaAmount?: number;
}

/** The four faces a terraformed world can wear. */
type Biome = 'verdant' | 'arid' | 'tundra' | 'volcanic' | 'oceanic';

/**
 * What a world BECOMES, decided by what it already IS.
 *
 * Terraforming in this game doesn't paste the same garden onto every
 * rock — it works with the world's existing character, so Io (the most
 * volcanically violent body in the solar system) comes out a volcano
 * world and Callisto comes out frozen taiga. Players who know the real
 * solar system should find the results obvious in hindsight.
 *
 * Curated first for bodies with real-world character, then a heuristic
 * for procedurally-added and far-system worlds.
 */
const CURATED_BIOME: Record<string, Biome> = {
  // Molten: active volcanism or a runaway greenhouse in the raw world.
  io: 'volcanic',          // 400+ active volcanoes; the obvious one
  venus: 'volcanic',       // volcanically resurfaced, furnace-hot
  vesta: 'volcanic',       // differentiated protoplanet, ancient basalt flows
  // Baked: rock and dust, close to the fire or long since dried out.
  mercury: 'arid',
  mars: 'arid',            // the archetypal desert world
  phobos: 'arid',
  deimos: 'arid',
  ceres: 'arid',
  pallas: 'arid',
  juno: 'arid',
  hygiea: 'arid',
  // Ocean: ice shells over liquid water. There is no continent under
  // there to uncover — melt the shell and the whole body IS the sea, so
  // these terraform into blue marbles with a few ridges above the
  // waterline rather than into gardens. (Lorne: "they're iceballs, so
  // terraformed they'd be mostly water".)
  europa: 'oceanic',       // ~100km of ocean under the ice — more liquid water than Earth has
  enceladus: 'oceanic',    // global subsurface ocean, venting it into space already
  // Living: worlds with water to work with but rock to stand on.
  ganymede: 'verdant',     // largest moon, subsurface ocean
  luna: 'verdant',         // greening the Moon: the oldest dream in the genre
  // Frozen: far, icy, or cryovolcanic — habitable, but never warm.
  callisto: 'tundra',
  titan: 'tundra',         // thick atmosphere already, methane lakes
  triton: 'tundra',
  rhea: 'tundra', miranda: 'tundra', ariel: 'tundra', umbriel: 'tundra',
  titania: 'tundra', oberon: 'tundra', nereid: 'tundra', proteus: 'tundra',
  charon: 'tundra', pluto: 'tundra', eris: 'tundra', sedna: 'tundra',
  makemake: 'tundra', haumea: 'tundra', quaoar: 'tundra',
};

/** Rough "how red is this rock" — volcanic and desert worlds skew warm,
 *  icy ones skew neutral-to-blue. Returns -1..1. */
function warmth(hex: string): number {
  if (!hex.startsWith('#') || hex.length !== 7) return 0;
  const p = parseInt(hex.slice(1), 16);
  // Red-minus-blue only; green carries no heat signal here.
  const r = (p >> 16) & 255, b = p & 255;
  return (r - b) / 255;
}

/** The single colour a terraformed world reads as from far away.
 *
 *  The map draws bodies below the texture threshold as a flat disc, and
 *  it used to blend every terraformed world toward one sea-and-forest
 *  teal — so a blue marble that is unmistakable at high zoom turned back
 *  into the same green dot as everything else the moment you zoomed out.
 *  Kept here, beside the palette it summarises, so the disc and the
 *  texture can never disagree about what a world looks like. */
export function terraformTint(body: Body): { r: number; g: number; b: number } {
  switch (terraformBiome(body)) {
    case 'oceanic':  return { r: 31,  g: 111, b: 168 };   // open water
    case 'arid':     return { r: 176, g: 138, b: 85  };   // sand
    case 'tundra':   return { r: 159, g: 192, b: 212 };   // frost
    case 'volcanic': return { r: 74,  g: 54,  b: 48  };   // basalt
    default:         return { r: 62,  g: 126, b: 120 };   // sea and forest
  }
}

function terraformBiome(body: Body): Biome {
  const curated = CURATED_BIOME[body.id];
  if (curated) return curated;

  // Procedural / far-system bodies: read their character off the same
  // properties a player can see. Heat falls off with distance, so orbit
  // radius is the dominant term; a warm-hued metal-rich rock still has
  // an internal furnace and can go volcanic anywhere.
  const rand = mulberry32(hashStr(body.id + ':biome'));
  const w = warmth(body.color || COLORS.planetDefault);
  const metal = body.resources?.metal ?? 0;
  const r = body.orbitRadius ?? 0;

  // Iron-red and metal-rich reads as "still geologically alive".
  if (w > 0.18 && metal >= 3 && rand() < 0.75) return 'volcanic';
  if (r < 260) return w > 0.05 ? 'arid' : 'verdant';
  if (r < 700) return rand() < 0.55 ? 'verdant' : 'arid';
  if (r < 1400) return rand() < 0.5 ? 'verdant' : 'tundra';
  return 'tundra';
}

/** Two-hex blend (t = weight of `b`). Local — colors.ts has no mix. */
function mixHex(a: string, bcol: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(bcol.slice(1), 16);
  const ch = (sh: number) => Math.round(
    ((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t,
  );
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

/** Biome by body type + orbital distance (DESIGN-terraforming):
 *  inner terrestrial → arid savanna, outer terrestrial + dwarf →
 *  tundra, moons a seeded mix leaning cold. The ocean inherits a
 *  whisper of the body's own raw hue, so a rusty moon terraforms
 *  into subtly rustier seas than an ash-grey one — the world keeps
 *  its identity through the change. */
function terraformPalette(body: Body): TfPalette {
  const biome = terraformBiome(body);
  const raw = body.color || COLORS.planetDefault;
  const tint = (hex: string) => (raw.startsWith('#') ? mixHex(hex, raw, 0.14) : hex);

  // THE FOUR CLASSES MUST READ AS FOUR CLASSES.
  //
  // An earlier cut gave all three non-volcanic biomes a deep-blue ocean
  // and only varied the land, which measured as near-identical: arid
  // rgb(104,133,110), verdant rgb(73,131,107), tundra rgb(69,114,108).
  // Three greens is not three worlds.
  //
  // The fix doesn't touch geometry (it can't — see paintTexture). It
  // reassigns what each colour SLOT means per biome. `ocean` is really
  // "the base the whole disc is flooded with", so a desert floods with
  // sand and gets rare blue seas in the `lake` slot, while an ice world
  // floods with pale frost. Same brushstrokes, four completely
  // different planets.
  if (biome === 'volcanic') {
    // Young, fertile and violent: black basalt shelves, steaming dark
    // water, molten seams still open, and almost no ice.
    return {
      ocean: tint('#1b3c44'), landA: '#2b2526', landB: '#46312a',
      lake: '#8c3a1f', capAlpha: 0.10,
      lava: '#ff6a1e', lavaGlow: '#ffd08a',
      lavaAmount: body.id === 'io' ? 1 : 0.7,
    };
  }
  if (biome === 'arid') {
    // A DESERT world: the disc floods with sand, the "continents"
    // become dune fields and rock, and water survives only where the
    // craters were deep enough to hold it.
    return {
      ocean: tint('#c9a068'), landA: '#a87844', landB: '#835a31',
      lake: '#2f7f96', capAlpha: 0.22,
    };
  }
  if (biome === 'oceanic') {
    // A WATER world. Every slot that means "land" elsewhere becomes a
    // depth instead, so the same continent silhouettes read as shelves
    // and banks under the surface rather than as ground. Only the
    // crater floors — the `lake` slot — come up as actual islands, which
    // is what sells the scale: a handful of green specks in open ocean.
    return {
      ocean: tint('#0f4c7a'), landA: '#1d6a9c', landB: '#2f8ab8',
      lake: '#5f9c6d', capAlpha: 0.9,
    };
  }
  if (biome === 'tundra') {
    // An ICE world: frost plain rather than ocean, taiga in grey-green
    // where anything grows, and caps that never retreat.
    return {
      ocean: tint('#9fc0d4'), landA: '#5f7d69', landB: '#83998f',
      lake: '#4b86a8', capAlpha: 1,
    };
  }
  // Verdant — the Earth-like end of the scale, and the only one that
  // keeps a true deep-blue ocean.
  return {
    ocean: tint('#245a80'), landA: '#3f8a4f', landB: '#2f6238',
    lake: '#3a7ba0', capAlpha: 0.8,
  };
}

/**
 * Molten seams and calderas for a volcanic world.
 *
 * Runs AFTER the shared geometry from its own seed stream, which is the
 * whole reason it's a separate pass: the raw and terraformed faces must
 * make an identical sequence of rand() calls while painting continents,
 * or the two variants would disagree about where the land is and the
 * crossfade would visibly slide. Painting lava afterwards can't disturb
 * that.
 *
 * Drawn with 'lighter' compositing so seams read as EMITTING rather than
 * as orange paint — the glow survives the terminator shading that gets
 * layered over the disk later.
 */
function paintLavaSeams(c: CanvasRenderingContext2D, body: Body, tf: TfPalette) {
  if (!tf.lava) return;
  const rand = mulberry32(hashStr(body.id + ':lava'));
  const amount = tf.lavaAmount ?? 0.7;
  c.save();
  c.globalCompositeOperation = 'lighter';

  // Fissure networks: short jagged chains, each wrapped across the seam
  // so the horizontal spin scroll stays continuous.
  const seams = Math.round(5 + rand() * 4 * amount);
  for (let i = 0; i < seams; i++) {
    const sx = rand() * TEX_SIZE;
    const sy = TEX_R * 0.35 + rand() * TEX_SIZE * 0.55;
    const segs = 3 + Math.floor(rand() * 4);
    const w = (1.6 + rand() * 2.4) * amount;
    for (const wrap of [-TEX_SIZE, 0, TEX_SIZE]) {
      let x = sx + wrap, y = sy;
      c.beginPath();
      c.moveTo(x, y);
      for (let s = 0; s < segs; s++) {
        x += (rand() - 0.45) * TEX_R * 0.30;
        y += (rand() - 0.5) * TEX_R * 0.16;
        c.lineTo(x, y);
      }
      c.strokeStyle = tf.lava!;
      c.lineWidth = w;
      c.lineCap = 'round';
      c.globalAlpha = 0.85;
      c.stroke();
      // Hot core down the middle of the seam.
      c.strokeStyle = tf.lavaGlow ?? '#ffe0a8';
      c.lineWidth = w * 0.4;
      c.globalAlpha = 0.95;
      c.stroke();
    }
  }

  // Calderas: a few glowing pools with soft halos.
  const pools = Math.round(2 + rand() * 3 * amount);
  for (let i = 0; i < pools; i++) {
    const px = rand() * TEX_SIZE;
    const py = TEX_R * 0.4 + rand() * TEX_SIZE * 0.5;
    const pr = (TEX_R * 0.05 + rand() * TEX_R * 0.09) * (0.6 + amount * 0.4);
    for (const wrap of [-TEX_SIZE, 0, TEX_SIZE]) {
      const g = c.createRadialGradient(px + wrap, py, 0, px + wrap, py, pr * 2.6);
      g.addColorStop(0, tf.lavaGlow ?? '#ffe0a8');
      g.addColorStop(0.28, tf.lava!);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = 0.9;
      c.fillStyle = g;
      c.beginPath();
      c.arc(px + wrap, py, pr * 2.6, 0, Math.PI * 2);
      c.fill();
    }
  }
  c.restore();
}

function paintTexture(body: Body, variant: TexVariant = 'raw'): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const off = document.createElement('canvas');
  off.width = TEX_SIZE;
  off.height = TEX_SIZE;
  const c = off.getContext('2d');
  if (!c) return null;

  const rand = mulberry32(hashStr(body.id));
  const base = body.color || COLORS.planetDefault;
  // Giants and stars can't be terraformed (no city, no terraform route)
  // — and Earth starts terraformed, its signature art already IS the
  // terraformed face.
  const tf = variant === 'terraformed'
    && body.id !== 'earth'
    && (body.type === 'terrestrial' || body.type === 'dwarf' || body.type === 'moon'
        || body.type === 'asteroid')
    ? terraformPalette(body) : null;

  // Hand-authored worlds keep their signature art (ported from the
  // old drawSurfaceFeatures), everything else gets a seeded recipe.
  // IMPORTANT: the tf palette must never change how many rand() calls
  // a recipe makes — geometry has to land identically in both variants.
  if (body.id === 'earth') {
    paintEarth(c);
  } else if (body.id === 'mars') {
    paintMars(c, base, tf);
  } else if (body.type === 'gas_giant') {
    paintGasGiant(c, base, rand);
  } else if (body.type === 'ice_giant') {
    paintIceGiant(c, base, rand);
  } else if (body.type === 'terrestrial' || body.type === 'dwarf') {
    paintTerrestrial(c, base, rand, tf);
  } else {
    // moons, asteroids, lagrange rocks — cratered regolith
    paintRocky(c, base, rand, tf);
  }
  // Volcanic worlds get their molten seams last, on a separate seed
  // stream, so the geometry above stays byte-identical between variants.
  if (tf?.lava) paintLavaSeams(c, body, tf);
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

function paintMars(c: CanvasRenderingContext2D, base: string, tf: TfPalette | null = null) {
  // Terraformed Mars: the seas of Elysium. Same highland geometry, but
  // the lowlands flood (base → ocean) and the highlands green over.
  fillBase(c, tf ? tf.ocean : base);
  // Darker highland smudges for texture — or, terraformed, the same
  // smudges as emergent vegetated continents.
  c.fillStyle = tf ? withOpacity(tf.landA, 0.9) : withOpacity(darken(base, 0.75), 0.5);
  const patches: Array<[number, number, number, number]> = [
    [0.7, 1.05, 0.42, 0.20], [1.35, 0.85, 0.34, 0.16], [1.0, 1.4, 0.5, 0.18],
  ];
  for (const [px, py, rx, ry] of patches) {
    c.beginPath();
    c.ellipse(px * TEX_R, py * TEX_R, rx * TEX_R, ry * TEX_R, 0.3, 0, Math.PI * 2);
    c.fill();
  }
  // Ice caps — the signature look (kept in both variants; a living Mars
  // still wears its poles).
  c.fillStyle = '#eaf2f7';
  c.beginPath();
  c.ellipse(TEX_R, TEX_R * 0.22, TEX_R * 0.62, TEX_R * 0.30, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = 'rgba(234, 242, 247, 0.8)';
  c.beginPath();
  c.ellipse(TEX_R, TEX_SIZE - TEX_R * 0.14, TEX_R * 0.40, TEX_R * 0.20, 0, 0, Math.PI * 2);
  c.fill();
}

function paintTerrestrial(
  c: CanvasRenderingContext2D, base: string, rand: () => number,
  tf: TfPalette | null = null,
) {
  // Terraformed: the raw ground floods into ocean, and the SAME
  // seeded landmasses re-emerge as vegetated continents — silhouettes
  // preserved, surface reinterpreted.
  fillBase(c, tf ? tf.ocean : base);
  // Land tones lean warm/organic; pick a seeded pair. The pick always
  // runs (identical rand consumption in both variants) even when tf
  // overrides the colors.
  const palettes: Array<[string, string]> = [
    ['#3f8a4f', '#356b3f'],   // verdant
    ['#8a6f42', '#6f5834'],   // arid
    ['#7a5a3a', '#5e452c'],   // rocky brown
    ['#5d7a45', '#4a6136'],   // scrub
  ];
  let [landA, landB] = palettes[Math.floor(rand() * palettes.length)];
  if (tf) { landA = tf.landA; landB = tf.landB; }
  const clusters = 3 + Math.floor(rand() * 3);
  for (let i = 0; i < clusters; i++) {
    const cx = TEX_R + (rand() - 0.5) * TEX_R * 1.3;
    const cy = TEX_R + (rand() - 0.5) * TEX_R * 1.3;
    blobCluster(c, rand, cx, cy, 3 + Math.floor(rand() * 3), TEX_R * 0.22,
      TEX_R * 0.12, TEX_R * 0.3, i % 2 === 0 ? landA : landB);
  }
  // Occasional polar cap — terraformed worlds always cap (weather
  // means water means ice), raw worlds keep the seeded coin flip. The
  // flip still runs in both variants so the rand stream stays aligned.
  const capRoll = rand();
  if (tf ? true : capRoll < 0.5) {
    c.fillStyle = `rgba(234, 242, 247, ${tf ? 0.85 * tf.capAlpha : 0.85})`;
    c.beginPath();
    c.ellipse(TEX_R, TEX_R * 0.18, TEX_R * 0.48, TEX_R * 0.14, 0, 0, Math.PI * 2);
    c.fill();
  }
}

function paintRocky(
  c: CanvasRenderingContext2D, base: string, rand: () => number,
  tf: TfPalette | null = null,
) {
  // Terraformed regolith: the ground greens over, the old maria flood
  // into shallow seas, and every crater becomes a round lake with a
  // vegetated rim — the impact history stays legible, just alive now.
  fillBase(c, tf ? tf.landA : base);
  // Maria — broad darker patches under the craters (→ seas when tf)
  for (let i = 0; i < 3; i++) {
    c.fillStyle = tf ? withOpacity(tf.ocean, 0.9) : withOpacity(darken(base, 0.8), 0.45);
    c.beginPath();
    c.ellipse(
      TEX_R + (rand() - 0.5) * TEX_R * 1.2,
      TEX_R + (rand() - 0.5) * TEX_R * 1.2,
      TEX_R * (0.2 + rand() * 0.3), TEX_R * (0.15 + rand() * 0.25),
      rand() * Math.PI, 0, Math.PI * 2,
    );
    c.fill();
  }
  // Craters — shadowed floor + a bright rim arc on the up-sun side
  // (→ crater lakes with darker vegetated rims when tf).
  const craters = 8 + Math.floor(rand() * 8);
  for (let i = 0; i < craters; i++) {
    const cx = TEX_R + (rand() - 0.5) * TEX_R * 1.6;
    const cy = TEX_R + (rand() - 0.5) * TEX_R * 1.6;
    const cr = TEX_R * (0.03 + rand() * 0.08);
    c.fillStyle = tf ? withOpacity(tf.lake, 0.9) : withOpacity(darken(base, 0.65), 0.8);
    c.beginPath();
    c.arc(cx, cy, cr, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = tf
      ? withOpacity(tf.landB, 0.8)
      : withOpacity(lighten(base, 1.35), 0.7);
    c.lineWidth = Math.max(1, cr * 0.22);
    c.beginPath();
    c.arc(cx, cy, cr, Math.PI * 0.75, Math.PI * 1.6);
    c.stroke();
  }
  // Tundra-grade polar cap on terraformed rocky worlds — weather has
  // arrived, and cold little worlds wear it at the poles.
  if (tf) {
    c.fillStyle = `rgba(234, 242, 247, ${0.75 * tf.capAlpha})`;
    c.beginPath();
    c.ellipse(TEX_R, TEX_R * 0.16, TEX_R * 0.46, TEX_R * 0.13, 0, 0, Math.PI * 2);
    c.fill();
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
