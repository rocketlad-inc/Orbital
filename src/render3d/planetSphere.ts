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

const W = 1024, H = 512;

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
export function worldMaps(id: string, base: string, icy: boolean): WorldMaps {
  const key = `${id}|${base}|${icy}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const seed = hashStr(id);
  const h = heightField(seed);
  punchCraters(h, seed);

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
): THREE.Group {
  const g = new THREE.Group();
  // A body this small holds no air. The fresnel shell on a tiny moon
  // reads as a specular rim on a marble, not as an atmosphere.
  const hasAir = radius >= 14;
  const maps = worldMaps(id, baseColor, icy);
  const surface = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 128, 96),
    new THREE.MeshStandardMaterial({
      map: maps.albedo,
      normalMap: maps.normal,
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughnessMap: maps.rough,
      roughness: 1, metalness: 0,
    }),
  );
  g.add(surface);

  if (!hasAir) return g;
  const air = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.012, 96, 64),
    new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uLight: { value: new THREE.Vector3(-1, 0.4, 0.7).normalize() },
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
          float rim = pow(1.0 - max(dot(n, vV), 0.0), 5.5);
          float lit = max(dot(n, uLight), 0.0);
          // Warm where the star grazes it, cold and faint on the night
          // side -- but never zero, so the limb always holds an edge.
          vec3 col = mix(vec3(0.16, 0.26, 0.44), uWarm * 1.5, lit);
          gl_FragColor = vec4(col, rim * (0.03 + lit * 0.14));
        }`,
    }),
  );
  g.add(air);
  return g;
}
