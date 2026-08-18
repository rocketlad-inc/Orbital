// ============================================================
// Worlds for the cinematic view.
//
// The game paints a planet as a face-on DISC, with limb darkening and a
// terminator baked into the art. That is exactly right for a 2D map and
// exactly wrong for a sphere: wrapped on geometry, the baked shading
// becomes a second lighting model fighting the real one. A review of
// the first build measured it — the brightest pixel on the planet sat
// ninety percent of the way out toward the silhouette, and one column
// got BRIGHTER as it moved away from the star. Both are impossible
// under real light and both are that baked gradient.
//
// So the surface is generated here instead, as an equirectangular
// ALBEDO map with no shading in it at all, and the scene's own star
// does one hundred percent of the lighting. The same measurement found
// no terrain either: luminance variance inside the disc came out at
// 0.8 where a credible world reads 10–30. This is multi-octave value
// noise with domain warping, crater fields at three size tiers, broad
// albedo provinces, and a frost cap drawn INTO the map with a
// noise-broken edge rather than pasted on as a decal.
//
// Seeded on the body id, so a world keeps its identity across views and
// across sessions.
// ============================================================

import * as THREE from 'three';
import { hashStr, mulberry32 } from '../render/planetTexture';

// 1024 stays. 2048 was measured at 23 SECONDS of init -- the height field
// is five octaves of noise per texel, and quadrupling the texels froze
// the tab for the length of a trailer. Close-up sharpness is the tiling
// detail normal's whole job; the base map only has to carry continents.
const W = 1024, H = 512;

/**
 * Where the star is. ONE definition, because there were two: the scene's
 * key light and the atmosphere shell each carried their own copy, and
 * they disagreed (-1, 0.42, 0.72 against -1, 0.4, 0.7). A haze band whose
 * lit side sits a couple of degrees off the surface's lit side is exactly
 * the sort of defect that reads as "something is subtly wrong" without
 * ever being nameable. Anything that needs to know where the light comes
 * from imports this.
 */
export const STAR_DIR = new THREE.Vector3(-1, 0.42, 0.72).normalize();

/** Smooth value noise on a wrapping 3D lattice. */
function makeNoise3(seed: number) {
  const G = 48;
  const rnd = mulberry32(seed);
  const grid = new Float32Array(G * G * G);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const at = (x: number, y: number, z: number) =>
    grid[((((z % G) + G) % G) * G + (((y % G) + G) % G)) * G + (((x % G) + G) % G)];
  const sm = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number, z: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = sm(x - xi), yf = sm(y - yi), zf = sm(z - zi);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const c00 = lerp(at(xi, yi, zi), at(xi + 1, yi, zi), xf);
    const c10 = lerp(at(xi, yi + 1, zi), at(xi + 1, yi + 1, zi), xf);
    const c01 = lerp(at(xi, yi, zi + 1), at(xi + 1, yi, zi + 1), xf);
    const c11 = lerp(at(xi, yi + 1, zi + 1), at(xi + 1, yi + 1, zi + 1), xf);
    return lerp(lerp(c00, c10, yf), lerp(c01, c11, yf), zf);
  };
}

/**
 * The height field the albedo, the normals and the roughness are all
 * derived from, so they agree with each other.
 *
 * Sampled as 3D noise ON THE SPHERE rather than 2D noise on the
 * unwrapped map. The 2D version could not wrap in longitude -- the
 * per-latitude scale that stopped pole smearing also broke the lattice
 * period, and the map met itself at a hard vertical seam that ran
 * straight down the middle of the planet. Points on a sphere have no
 * seam and no poles to smear, so both problems go away at once.
 */
function heightField(seed: number): Float32Array {
  const n1 = makeNoise3(seed), n2 = makeNoise3(seed ^ 0x9e37), n3 = makeNoise3(seed ^ 0x51ed);
  const out = new Float32Array(W * H);
  const S = 7.5;
  for (let y = 0; y < H; y++) {
    const lat = (y / H) * Math.PI;
    const sy = Math.cos(lat), r = Math.sin(lat);
    for (let x = 0; x < W; x++) {
      const lon = (x / W) * Math.PI * 2;
      const px = r * Math.cos(lon) * S, py = sy * S, pz = r * Math.sin(lon) * S;
      // Domain warp: noise offsetting the lookup of noise, which is what
      // turns bland blobs into coastlines and ridges.
      const wx = px + n2(px * 0.6, py * 0.6, pz * 0.6) * 2.6;
      const wy = py + n3(px * 0.6, py * 0.6, pz * 0.6) * 2.6;
      let a = 0, amp = 0.5, f = 1;
      for (let o = 0; o < 5; o++) {
        a += n1(wx * f, wy * f, pz * f) * amp;
        amp *= 0.5; f *= 2.03;
      }
      out[y * W + x] = a;
    }
  }
  return out;
}

/** Craters: bright rim, dark floor, a soft ejecta blanket. */
function punchCraters(h: Float32Array, seed: number) {
  const rnd = mulberry32(seed ^ 0xc7a7);
  for (const [count, rad] of [[14, 46], [60, 20], [220, 7]] as const) {
    for (let i = 0; i < count; i++) {
      const cx = rnd() * W, cy = H * (0.16 + rnd() * 0.68);
      const r = rad * (0.55 + rnd() * 0.9);
      const depth = 0.05 + rnd() * 0.12;
      const x0 = Math.floor(cx - r * 2), x1 = Math.ceil(cx + r * 2);
      const y0 = Math.max(0, Math.floor(cy - r * 2)), y1 = Math.min(H - 1, Math.ceil(cy + r * 2));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x - cx, y - cy) / r;
          if (d > 2) continue;
          const ix = ((x % W) + W) % W;
          let dz = 0;
          if (d < 0.82) dz = -depth * (1 - d * d * 0.4);      // floor
          else if (d < 1.06) dz = depth * 0.85;                // rim
          else dz = depth * 0.2 * (1 - (d - 1.06) / 0.94);     // ejecta
          h[y * W + ix] += dz;
        }
      }
    }
  }
}

/**
 * A seamless, tiling DETAIL normal map — the fix for a problem that is
 * arithmetic rather than art.
 *
 * The anchor world is radius 120, so its 1024-wide equirect map lays
 * 1024 texels over a 754-unit circumference: 1.36 texels per world
 * unit. Cinema framings put the camera inside ~280 units, which is
 * about 7.6 screen pixels per world unit — so every base texel is
 * stretched across roughly 5.6 screen pixels. Craters at the 7px tier
 * are sub-pixel mush and the 46px tier survives only as the soft brown
 * smears three reviewers independently described. Reaching 1:1 would
 * need a map about 5700px wide; at three maps and 33M pixels of
 * multi-octave noise that is not happening in a browser.
 *
 * So apparent detail is DECOUPLED from map size: one small tiling
 * normal map, shared by every world, sampled at a high repeat. It adds
 * the high-frequency grain the base map cannot carry at any affordable
 * resolution, and it stays crisp however close the camera gets.
 *
 * Tiling has to be exact or the seams are worse than the blur. The
 * lattice period divides the map width, and every octave's frequency is
 * an integer multiple of it, so the field meets itself on all four
 * edges.
 */
const DETAIL_PX = 512;
let detailTex: THREE.CanvasTexture | null = null;

function detailNormal(): THREE.CanvasTexture {
  if (detailTex) return detailTex;
  // Each octave is indexed modulo ITS OWN frequency, which is what makes
  // it tile. The first attempt used one lattice period of 32 for every
  // octave and assumed frequencies 4/8/16/32 would wrap: they do not. At
  // u=1 an octave of frequency f samples lattice cell f, and only wraps
  // back to cell 0 if f is a multiple of the period -- so 4, 8 and 16 all
  // met a different value at the edge than they started from, and the
  // seams showed up on screen as a dark perpendicular grid ruled across
  // the planet. Indexing each octave modulo f makes every octave complete
  // a whole number of periods across the map by construction.
  const G = 64;                       // lattice storage; must be >= max f
  const rnd = mulberry32(0x5eed1);
  const grid = new Float32Array(G * G);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const sm = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number, f: number) => {
    const xs = x * f, ys = y * f;
    const xi = Math.floor(xs), yi = Math.floor(ys);
    const xf = sm(xs - xi), yf = sm(ys - yi);
    const at = (a: number, b: number) =>
      grid[(((b % f) + f) % f) * G + (((a % f) + f) % f)];
    const c0 = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * xf;
    const c1 = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * xf;
    return c0 + (c1 - c0) * yf;
  };

  const h = new Float32Array(DETAIL_PX * DETAIL_PX);
  for (let y = 0; y < DETAIL_PX; y++) {
    for (let x = 0; x < DETAIL_PX; x++) {
      const u = x / DETAIL_PX, v = y / DETAIL_PX;
      // Weighted FLAT on purpose. A standard 0.5 rolloff put six times
      // more energy in the coarsest octave than the finest, and the
      // result read as soft blobs -- the same complaint the base map
      // already earns. The point of this map is the fine end, so the
      // decay is gentle and the finest octave still carries real weight.
      let a = 0, amp = 0.5, tot = 0;
      for (const f of [8, 16, 32, 64]) {
        a += noise(u, v, f) * amp; tot += amp; amp *= 0.78;
      }
      h[y * DETAIL_PX + x] = a / tot;
    }
  }
  // Sobel to tangent-space normals, wrapping on both axes.
  const cv = document.createElement('canvas');
  cv.width = cv.height = DETAIL_PX;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(DETAIL_PX, DETAIL_PX);
  const S = 26;
  for (let y = 0; y < DETAIL_PX; y++) {
    for (let x = 0; x < DETAIL_PX; x++) {
      const xl = (x - 1 + DETAIL_PX) % DETAIL_PX, xr = (x + 1) % DETAIL_PX;
      const yu = (y - 1 + DETAIL_PX) % DETAIL_PX, yd = (y + 1) % DETAIL_PX;
      const dx = (h[y * DETAIL_PX + xr] - h[y * DETAIL_PX + xl]) * S;
      const dy = (h[yd * DETAIL_PX + x] - h[yu * DETAIL_PX + x]) * S;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * DETAIL_PX + x) * 4;
      img.data[o] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[o + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  detailTex = t;
  return t;
}

/** 0..1 through a 5-stop palette. */
function ramp(stops: number[][], t: number): [number, number, number] {
  const c = Math.max(0, Math.min(0.999, t)) * (stops.length - 1);
  const i = Math.floor(c), f = c - i;
  const a = stops[i], b = stops[i + 1] ?? stops[i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export interface WorldMaps {
  albedo: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
  rough: THREE.CanvasTexture;
}

const cache = new Map<string, WorldMaps>();

/**
 * Albedo, normal and roughness for one body. Pure surface: nothing in
 * the albedo knows where the star is.
 */
/**
 * What a world's surface actually looks like.
 *
 * 'rock' is the cratered regolith every body used to get regardless of
 * what it was, which made Jupiter a big grey moon. The rest come from
 * the SAME classifier the 2D map uses -- terraformBiome -- so a world
 * that reads as a desert on the map reads as a desert in the film, and
 * neither view can drift from the other.
 */
/**
 * The palette each terraformed face is painted from.
 *
 * `sea` is where the coastline falls on the world's own height field,
 * so a world with more water simply floods further up its own terrain.
 * These read against the map's biome colours rather than reinventing
 * them: a verdant world is blue and green, an arid one is rust and
 * bone, a tundra one is pale, an ocean world is almost all water.
 */
const BIOME_PALETTE: Record<string, {
  sea: number; capFrom: number;
  water: THREE.Color; shallow: THREE.Color;
  low: THREE.Color; high: THREE.Color;
}> = {
  verdant: {
    sea: 0.42, capFrom: 0.74,
    water: new THREE.Color(0x123f6b), shallow: new THREE.Color(0x2d7fa8),
    low: new THREE.Color(0x3f6b34), high: new THREE.Color(0x9a8b62),
  },
  oceanic: {
    // Melt the shell and the body IS the sea: a few ridges, no continents.
    sea: 0.78, capFrom: 0.7,
    water: new THREE.Color(0x0d3a68), shallow: new THREE.Color(0x2a86bd),
    low: new THREE.Color(0x51705f), high: new THREE.Color(0x8f9a86),
  },
  arid: {
    sea: 0.06, capFrom: 0.88,
    water: new THREE.Color(0x2c5a72), shallow: new THREE.Color(0x4a7d86),
    low: new THREE.Color(0x8a4f30), high: new THREE.Color(0xd8bb8a),
  },
  tundra: {
    sea: 0.34, capFrom: 0.44,
    water: new THREE.Color(0x1d4a63), shallow: new THREE.Color(0x4d8aa2),
    low: new THREE.Color(0x6d7a70), high: new THREE.Color(0xcfd8dc),
  },
  volcanic: {
    sea: 0.38, capFrom: 0.95,
    water: new THREE.Color(0x2a1108), shallow: new THREE.Color(0x54210d),
    low: new THREE.Color(0x33292a), high: new THREE.Color(0x6b5a52),
  },
};

export type WorldFace =
  | 'rock' | 'giant' | 'verdant' | 'arid' | 'tundra' | 'volcanic' | 'oceanic';

export function worldMaps(
  id: string, base: string, icy: boolean, face: WorldFace = 'rock',
): WorldMaps {
  const key = `${id}|${base}|${icy}|${face}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const seed = hashStr(id);
  const h = heightField(seed);
  // Craters are a RECORD OF IMPACTS ON BARE ROCK. A gas giant has no
  // surface to crater and a terraformed world has weather to erase them.
  if (face === 'rock') punchCraters(h, seed);

  // Normalise, then build a palette around the body's own colour so the
  // world keeps the identity the rest of the game gave it -- but at a
  // fraction of the saturation, because a real surface is mostly dust.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < h.length; i++) { if (h[i] < lo) lo = h[i]; if (h[i] > hi) hi = h[i]; }
  const span = Math.max(1e-4, hi - lo);

  const c = new THREE.Color(base || '#b06a3f');
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  const shade = (s: number, l: number) => {
    // Capped well below the body's UI colour: a map chip can be vivid,
    // a thousand kilometres of regolith cannot.
    const k = new THREE.Color().setHSL(hsl.h, Math.min(0.42, hsl.s * s * 0.7), l);
    return [k.r * 255, k.g * 255, k.b * 255];
  };
  // Basalt dark, rust, mid dust, pale dust, highland bright.
  const stops = [
    shade(0.75, 0.13), shade(0.95, 0.24), shade(0.7, 0.38),
    shade(0.45, 0.52), shade(0.28, 0.66),
  ];

  const alb = document.createElement('canvas'); alb.width = W; alb.height = H;
  const ag = alb.getContext('2d')!;
  const img = ag.createImageData(W, H);
  const prov3 = makeNoise3(seed ^ 0x1234);

  for (let y = 0; y < H; y++) {
    const lat = y / H;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = (h[i] - lo) / span;
      // A broad province term so the world has continent-scale contrast
      // and not just per-pixel fizz.
      const lon = (x / W) * Math.PI * 2, latr = (y / H) * Math.PI;
      const pr = Math.sin(latr);
      const p = prov3(pr * Math.cos(lon) * 1.4, Math.cos(latr) * 1.4, pr * Math.sin(lon) * 1.4);
      let [r, g, b] = ramp(stops, Math.max(0, Math.min(1, t * 0.78 + p * 0.3 - 0.04)));

      if (face === 'giant') {
        // BANDS. A giant is weather all the way down: zonal jets smeared
        // flat along latitude, with turbulence allowed to wander only a
        // little across them. The band pattern is the whole read -- it
        // is what makes Jupiter unmistakable at any distance.
        const jet = Math.sin(latr * 11 + p * 2.2) * 0.5 + 0.5;
        const fine = prov3(pr * Math.cos(lon) * 5, Math.cos(latr) * 22, pr * Math.sin(lon) * 5);
        const band = Math.max(0, Math.min(1, jet * 0.78 + fine * 0.28));
        const pale = new THREE.Color().setHSL(hsl.h, Math.min(0.3, hsl.s * 0.45), 0.82);
        const dark = new THREE.Color().setHSL(
          (hsl.h + 0.03) % 1, Math.min(0.55, hsl.s * 0.85), 0.42);
        const mix = dark.clone().lerp(pale, band);
        r = mix.r * 255; g = mix.g * 255; b = mix.b * 255;
        // One great storm, an oval well off the equator, with a curl of
        // its own so it does not read as a painted dot.
        const sy = 0.62, sx = ((seed % 100) / 100);
        const dx = Math.abs(((x / W) - sx + 1.5) % 1 - 0.5) * 2.6;
        const dy = (lat - sy) * 9;
        const storm = Math.max(0, 1 - Math.hypot(dx, dy) * 1.6);
        if (storm > 0) {
          const sc = new THREE.Color().setHSL((hsl.h + 0.02) % 1, 0.62, 0.5);
          const k = storm * storm * (0.7 + fine * 0.5);
          r += (sc.r * 255 - r) * k; g += (sc.g * 255 - g) * k; b += (sc.b * 255 - b) * k;
        }
      } else if (face !== 'rock') {
        // A TERRAFORMED FACE. Sea level cuts the same height field the
        // rock face uses, so the coastline follows the world's own
        // terrain rather than a shape pasted over it.
        const land = t * 0.8 + p * 0.32;
        const P = BIOME_PALETTE[face];
        const sea = land < P.sea;
        const col = sea
          ? P.water.clone().lerp(P.shallow, Math.max(0, land / Math.max(1e-3, P.sea)))
          : P.low.clone().lerp(P.high, Math.min(1, (land - P.sea) / 0.45));
        r = col.r * 255; g = col.g * 255; b = col.b * 255;
        // Ice caps, by latitude, broken by terrain so the edge is ragged.
        const cap = Math.max(0, Math.abs(lat - 0.5) * 2 - P.capFrom);
        const ice = Math.max(0, Math.min(1, cap * 3.4 + (t - 0.6) * cap * 4));
        if (ice > 0) {
          r += (236 - r) * ice; g += (242 - g) * ice; b += (250 - b) * ice;
        }
        // Lava, on volcanic worlds only, following the deepest fissures.
        if (face === 'volcanic') {
          const vein = Math.max(0, 1 - Math.abs(land - P.sea) * 14);
          if (vein > 0) {
            const k = vein * vein;
            r += (255 - r) * k; g += (110 - g) * k * 0.9; b += (30 - b) * k * 0.7;
          }
        }
      }
      // Frost, drawn INTO the surface: coverage rises toward the poles
      // and the edge is broken by the terrain itself, so it is a
      // latitude band with outliers rather than a pasted ellipse.
      const polar = Math.max(0, Math.abs(lat - 0.5) * 2 - (icy ? 0.5 : 0.82));
      const frost = Math.max(0, Math.min(1, polar * 3.2 + (t - 0.62) * polar * 5));
      if (frost > 0) {
        // Warm cream, not neutral grey: ice under a warm star is not UI.
        r += (246 - r) * frost; g += (240 - g) * frost; b += (226 - b) * frost;
      }
      const o = i * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  ag.putImageData(img, 0, 0);

  // Normals from the same field, so relief and colour agree.
  const nrm = document.createElement('canvas'); nrm.width = W; nrm.height = H;
  const ng = nrm.getContext('2d')!;
  const nimg = ng.createImageData(W, H);
  const S = 5.5;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const xl = (x - 1 + W) % W, xr = (x + 1) % W;
      const yu = Math.max(0, y - 1), yd = Math.min(H - 1, y + 1);
      const dx = (h[y * W + xr] - h[y * W + xl]) * S;
      const dy = (h[yd * W + x] - h[yu * W + x]) * S;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * W + x) * 4;
      // Relief fades out near the poles: every column of the map meets
      // at one point there, and sobel normals across that pinch shade a
      // dark 'eye' onto the pole of every close framing.
      const pole = Math.min(1, Math.max(0, (Math.abs(y / H - 0.5) * 2 - 0.78) / 0.22));
      const flat = 1 - pole;
      nimg.data[o] = (((-dx / len) * 0.5) * flat + 0.5) * 255;
      nimg.data[o + 1] = (((-dy / len) * 0.5) * flat + 0.5) * 255;
      nimg.data[o + 2] = (((1 / len) * flat + (1 - flat)) * 0.5 + 0.5) * 255;
      nimg.data[o + 3] = 255;
    }
  }
  ng.putImageData(nimg, 0, 0);

  // Roughness: dust plains smoother than highlands, so the spec lobe
  // is not one flat wash across the whole world.
  const rgh = document.createElement('canvas'); rgh.width = W; rgh.height = H;
  const rg = rgh.getContext('2d')!;
  const rimg = rg.createImageData(W, H);
  for (let i = 0; i < h.length; i++) {
    const t = (h[i] - lo) / span;
    const v = 215 + t * 40;
    const o = i * 4;
    rimg.data[o] = rimg.data[o + 1] = rimg.data[o + 2] = v;
    rimg.data[o + 3] = 255;
  }
  rg.putImageData(rimg, 0, 0);

  const mk = (cv: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(cv);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  };
  const maps: WorldMaps = {
    albedo: mk(alb, true), normal: mk(nrm, false), rough: mk(rgh, false),
  };
  cache.set(key, maps);
  return maps;
}

/**
 * A world, plus the thin shell of air around it.
 *
 * The atmosphere is a back-face fresnel shell at a hair over the
 * surface radius. It costs almost nothing and it is the single cheapest
 * change that stops a sphere reading as a snooker ball: it softens the
 * hard cut into space, warms the lit limb, and leaves a rim on the
 * night side so the planet keeps its silhouette instead of becoming a
 * hole punched in the starfield.
 */
export function makeWorld(
  id: string, baseColor: string, radius: number, icy = false,
  face: WorldFace = 'rock',
): THREE.Group {
  const g = new THREE.Group();
  // A body this small holds no air. The fresnel shell on a tiny moon
  // reads as a specular rim on a marble, not as an atmosphere.
  const hasAir = radius >= 14;
  const maps = worldMaps(id, baseColor, icy, face);
  // Grain held at a constant PHYSICAL size, so a moon is not covered in
  // the same absolute pebbles as a planet six times its radius. 14
  // repeats is what puts the anchor's detail texels at roughly one
  // screen pixel in a cinema framing; everything else scales off it.
  const detailRepeat = Math.min(24, Math.max(3, (radius / 120) * 14));
  // Tuned DOWN from 0.75. At full strength the grain covered the whole
  // face evenly and the world read as crumpled foil: one roughness at one
  // scale everywhere, which is its own kind of unreal. The amplitude is
  // also modulated by the base map in the shader, so plains stay smoother
  // than highlands and the detail varies across the surface.
  const detailStrength = face === 'giant' ? 0.16 : 0.42;
  const surfaceMat = new THREE.MeshStandardMaterial({
    map: maps.albedo,
    normalMap: maps.normal,
    // Cloud tops are not rock: relief that describes a crater rim
    // reads as corrugation on a gas giant.
    normalScale: face === 'giant'
      ? new THREE.Vector2(0.2, 0.2) : new THREE.Vector2(0.8, 0.8),
    roughnessMap: maps.rough,
    roughness: 1, metalness: 0,
  });
  // The detail map rides along inside the standard material rather than
  // replacing it: the lighting, the environment and the tone mapping all
  // stay exactly as they were, and only the normal gains a second,
  // higher-frequency term.
  //
  // It must be anchored on the `#include` DIRECTIVE, not on the chunk's
  // contents. onBeforeCompile runs at WebGLRenderer.js:1645, before
  // WebGLProgram resolves includes, so at this point the source still
  // says `#include <normal_fragment_maps>` and any attempt to match the
  // text inside that chunk finds nothing. String.replace fails silently
  // when it misses, so the first version of this compiled fine, rendered
  // fine, and changed nothing -- caught only because the sharpness
  // measurement came back at a ratio of exactly 1.00. Hence the assert.
  surfaceMat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetailMap = { value: detailNormal() };
    shader.uniforms.uDetailRepeat = { value: detailRepeat };
    shader.uniforms.uDetailStrength = { value: detailStrength };
    shader.uniforms.uDetailAO = { value: face === 'giant' ? 0.07 : 0.21 };
    const patch = (src: string, find: string, into: string) => {
      if (!src.includes(find)) {
        throw new Error(`planetSphere: shader anchor missing: ${find}`);
      }
      return src.replace(find, into);
    };
    let f = patch(shader.fragmentShader, 'void main() {',
      `uniform sampler2D uDetailMap;
       uniform float uDetailRepeat;
       uniform float uDetailStrength;
       uniform float uDetailAO;
       void main() {`);
    f = patch(f, '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
       #ifdef USE_NORMALMAP_TANGENTSPACE
       {
         // Equirect: u spans 360 degrees and v spans 180, so the
         // vertical repeat is half the horizontal or the grain comes out
         // stretched into stripes. tbn is in scope from
         // normal_fragment_begin, so the detail is bent into the same
         // tangent frame the base normal map already used.
         vec2 duv = vNormalMapUv * vec2(uDetailRepeat, uDetailRepeat * 0.5);
         vec3 dN = texture2D(uDetailMap, duv).xyz * 2.0 - 1.0;
         // Roughness varies BY PROVINCE. Keyed off the base albedo, which
         // is itself derived from the height field, so bright highland
         // ground breaks up and dark low plains stay comparatively smooth.
         float prov = texture2D(map, vMapUv).g;
         float dmul = mix(0.45, 1.4, smoothstep(0.18, 0.72, prov));
         normal = normalize(
           normal + (tbn[0] * dN.x + tbn[1] * dN.y) * uDetailStrength * dmul);
       }
       #endif`);
    // Perturbing the normal alone is not enough, and the reason is
    // measurable: the base height field's finest octave has a wavelength
    // of about 6 world units, which at cinema framing is a 45-pixel
    // feature. NOTHING in the albedo is smaller than that, so below 45px
    // the surface has colour detail of exactly zero and relies entirely
    // on shading -- which all but vanishes wherever the star is near
    // head-on, as it is through most of this reel. Micro-relief also
    // self-shadows, so slope darkens the surface: that gives crisp
    // small-scale tonal variation at every light angle, not just at the
    // terminator.
    f = patch(f, '#include <map_fragment>',
      `#include <map_fragment>
       {
         vec2 auv = vMapUv * vec2(uDetailRepeat, uDetailRepeat * 0.5);
         vec3 aN = texture2D(uDetailMap, auv).xyz * 2.0 - 1.0;
         float slope = clamp(length(aN.xy) * 1.6, 0.0, 1.0);
         float aprov = smoothstep(0.18, 0.72, diffuseColor.g);
         diffuseColor.rgb *= 1.0
           - uDetailAO * mix(0.45, 1.4, aprov) * (slope - 0.35);
       }`);
    shader.fragmentShader = f;
  };
  const surface = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 128, 96), surfaceMat,
  );
  g.add(surface);

  if (!hasAir) return g;
  // The limb is where a sphere either becomes a world or stays a
  // snooker ball. Three reviewers independently described the old edge
  // as "a hard cut to black" with "no glow, no haze band, no thinning",
  // and the numbers agree: the previous shell peaked at alpha 0.17 with
  // a pow-5.5 falloff, so the band was both faint and only a few pixels
  // wide. This one is thicker, falls off more slowly so the haze has
  // width, and carries a forward-scattering term so the limb flares
  // where the line of sight grazes the atmosphere toward the star.
  const air = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.035, 96, 64),
    new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uLight: { value: STAR_DIR.clone() },
        uWarm: { value: new THREE.Color(baseColor || '#b06a3f') },
      },
      vertexShader: `
        varying vec3 vN; varying vec3 vV;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vV = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform vec3 uLight; uniform vec3 uWarm;
        varying vec3 vN; varying vec3 vV;
        void main() {
          // Back faces, so the normal points inward: flip it.
          vec3 n = -vN;
          float grz = 1.0 - max(dot(n, vV), 0.0);
          // Two lobes: a broad haze that gives the band width, and a
          // tight one that keeps a bright thread right on the edge.
          float band = pow(grz, 2.6);
          float edge = pow(grz, 7.0);
          // A SOFT terminator, carried a little onto the night side --
          // air is lit before the ground under it is, which is what
          // draws the blue thread past the day/night line.
          float lit = dot(n, uLight);
          float day = smoothstep(-0.22, 0.30, lit);
          // Forward scatter: looking through the limb toward the star.
          float fwd = pow(max(dot(-vV, uLight), 0.0), 6.0);
          vec3 cold = vec3(0.20, 0.34, 0.62);
          vec3 warm = mix(uWarm, vec3(1.0, 0.92, 0.82), 0.45);
          vec3 col = mix(cold, warm * 1.35, day);
          float a = band * (0.06 + day * 0.42) + edge * (0.05 + day * 0.30)
                  + fwd * band * 0.45;
          gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
        }`,
    }),
  );
  g.add(air);
  return g;
}
