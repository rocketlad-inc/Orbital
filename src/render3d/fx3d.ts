// ============================================================
// Effects for the cinematic view.
//
// Everything here is a BILLBOARD driven by a gradient texture rather
// than a lit solid. A tracer built as a capsule of geometry is a
// capsule: it has a constant width, two rounded ends and no falloff, so
// it reads as a glowstick lying in space. Ordnance has a hot head and a
// tail that dies, which is a gradient, not a mesh.
//
// The textures are painted once into canvases and reused. Everything is
// additive and writes no depth, so effects layer over one another the
// way light does instead of z-fighting.
// ============================================================

import * as THREE from 'three';
import { hashStr, mulberry32 } from '../render/planetTexture';

let cache: Record<string, THREE.Texture> = {};

function paint(
  key: string, draw: (c: CanvasRenderingContext2D, S: number) => void,
  S = 128, clampEdge = true,
) {
  const hit = cache[key];
  if (hit) return hit;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  draw(ctx, S);
  if (clampEdge) {
    // Force alpha to zero before the tile edge. Without this the corners
    // hold the gradient's last stop, bloom amplifies that plateau, and
    // every effect drags a visible rectangle around behind it.
    ctx.globalCompositeOperation = 'destination-in';
    const m = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    m.addColorStop(0, 'rgba(0,0,0,1)');
    m.addColorStop(0.88, 'rgba(0,0,0,1)');
    m.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = m;
    ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = 'source-over';
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  cache[key] = t;
  return t;
}

/** A round falloff: the workhorse for flashes, plumes and embers. */
export const glowTex = () => paint('glow', (g, S) => {
  const r = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.22, 'rgba(255,255,255,0.72)');
  r.addColorStop(0.55, 'rgba(255,255,255,0.2)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, S, S);
});

/**
 * A gun flash: a hot core with four spikes off it, not a circle.
 *
 * Three independent reviewers named the same defect in the same words —
 * "the same circular blob stamped at four different sizes". They were
 * looking at muzzles and impacts, which were bare glowTex. A radial
 * gradient has no orientation, so a dozen of them on screen read as one
 * decal repeated rather than a dozen guns firing; spikes give each one
 * an axis, and the caller rolls it so no two land at the same angle.
 */
export const flareTex = () => paint('flare', (g, S) => {
  const c = S / 2;
  const core = g.createRadialGradient(c, c, 0, c, c, S * 0.2);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = core; g.fillRect(0, 0, S, S);
  // Four spikes, the long pair across the barrel.
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 4; i++) {
    const len = (i % 2 === 0 ? 0.47 : 0.26) * S;
    const wid = (i % 2 === 0 ? 0.035 : 0.05) * S;
    g.save();
    g.translate(c, c); g.rotate((i * Math.PI) / 2);
    const gr = g.createLinearGradient(0, 0, len, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.28)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(0, -wid); g.lineTo(len, 0); g.lineTo(0, wid);
    g.closePath(); g.fill();
    g.restore();
  }
  g.globalCompositeOperation = 'source-over';
});

/**
 * A tracer: hot at the head, gone at the tail, and thinner as it goes.
 * Painted left-to-right so the quad can be stretched along its flight
 * path with the head at u=1.
 */
export const tracerTex = () => paint('tracer', (g, S) => {
  g.clearRect(0, 0, S, S);
  // Constant width. A bolt that widens toward its head reads as a
  // thrown spear, which is precisely what the tapered version looked
  // like -- the shape has to come from brightness, not from geometry.
  const half = 0.17 * S;
  for (let x = 0; x < S; x++) {
    const u = x / (S - 1);
    // Dark at the tail, hot at the head, with a short bright nose.
    const body = Math.pow(u, 2.2) * 0.72;
    const nose = u > 0.86 ? (u - 0.86) / 0.14 : 0;
    const a = Math.min(1, body + nose * 0.5);
    const grad = g.createLinearGradient(0, S / 2 - half, 0, S / 2 + half);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.34, `rgba(255,255,255,${(a * 0.35).toFixed(3)})`);
    grad.addColorStop(0.5, `rgba(255,255,255,${a.toFixed(3)})`);
    grad.addColorStop(0.66, `rgba(255,255,255,${(a * 0.35).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x, S / 2 - half, 1, half * 2);
  }
  // The core: a thin near-white filament the material's tint barely
  // touches, so the middle of the bolt burns white and the sheath
  // carries the faction colour.
  g.globalCompositeOperation = 'lighter';
  for (let x = Math.floor(S * 0.15); x < S; x++) {
    const u = x / (S - 1);
    const a = Math.pow(u, 1.6) * 0.95;
    const ch = 0.035 * S;
    const grad = g.createLinearGradient(0, S / 2 - ch, 0, S / 2 + ch);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, `rgba(255,255,255,${a.toFixed(3)})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x, S / 2 - ch, 1, ch * 2);
  }
  g.globalCompositeOperation = 'source-over';
  // Feather the head so it does not end on a chisel edge.
  g.globalCompositeOperation = 'destination-in';
  const f = g.createLinearGradient(0, 0, S, 0);
  f.addColorStop(0, 'rgba(0,0,0,1)');
  f.addColorStop(0.97, 'rgba(0,0,0,1)');
  f.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = f;
  g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'source-over';
}, 256, false);
/** The expanding shell of a detonation: bright rim, hollow middle. */
export const ringTex = () => paint('ring', (g, S) => {
  const r = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  r.addColorStop(0, 'rgba(255,255,255,0)');
  r.addColorStop(0.55, 'rgba(255,255,255,0)');
  r.addColorStop(0.78, 'rgba(255,240,210,0.7)');
  r.addColorStop(0.88, 'rgba(255,150,60,0.28)');
  r.addColorStop(1, 'rgba(255,110,40,0)');
  g.fillStyle = r; g.fillRect(0, 0, S, S);
});

/** Fire: white core through amber to a dark smoky edge. */
export const fireTex = () => paint('fire', (g, S) => {
  const r = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  r.addColorStop(0, 'rgba(255,255,248,1)');
  r.addColorStop(0.16, 'rgba(255,238,180,0.96)');
  r.addColorStop(0.38, 'rgba(255,150,52,0.72)');
  r.addColorStop(0.66, 'rgba(196,58,16,0.3)');
  r.addColorStop(1, 'rgba(70,16,6,0)');
  g.fillStyle = r; g.fillRect(0, 0, S, S);
});

/** A recycled pool of additive billboards. */
export class Billboards {
  private pool: THREE.Sprite[] = [];
  private used = 0;
  constructor(private scene: THREE.Scene) {}

  begin() { this.used = 0; }

  /** Place one sprite. `rot` is roll in radians; `w`/`h` are world size. */
  put(
    tex: THREE.Texture, at: THREE.Vector3, w: number, h: number,
    color: THREE.ColorRepresentation, opacity: number, rot = 0,
  ) {
    let s = this.pool[this.used];
    if (!s) {
      s = new THREE.Sprite(new THREE.SpriteMaterial({
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: true,
      }));
      this.scene.add(s);
      this.pool[this.used] = s;
    }
    const m = s.material as THREE.SpriteMaterial;
    m.map = tex;
    m.color.set(color);
    m.opacity = Math.max(0, Math.min(1, opacity));
    m.rotation = rot;
    m.needsUpdate = true;
    s.position.copy(at);
    s.scale.set(w, h, 1);
    s.visible = true;
    this.used++;
    return s;
  }

  end() {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false;
  }
}

/**
 * A tracer between two points, drawn as a camera-facing quad so it keeps
 * its taper from every angle.
 *
 * Sprites cannot be stretched along an arbitrary world axis, so this
 * uses a plane that is re-oriented each frame: aligned to the flight
 * path, then rolled to face the camera around that path.
 */
export class Tracers {
  private pool: THREE.Mesh[] = [];
  private used = 0;
  private geo = new THREE.PlaneGeometry(1, 1);
  constructor(private scene: THREE.Scene) {}

  begin() { this.used = 0; }

  put(
    from: THREE.Vector3, to: THREE.Vector3, width: number,
    color: THREE.ColorRepresentation, opacity: number, camera: THREE.Camera,
  ) {
    let m = this.pool[this.used];
    if (!m) {
      m = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({
        map: tracerTex(), transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide,
      }));
      this.scene.add(m);
      this.pool[this.used] = m;
    }
    const mat = m.material as THREE.MeshBasicMaterial;
    mat.color.set(color);
    mat.opacity = opacity;

    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 1e-4) { m.visible = false; this.used++; return m; }
    dir.normalize();
    m.position.copy(from).add(to).multiplyScalar(0.5);
    // +X down the flight path, then roll so the quad's normal points at
    // the camera around that axis.
    const toCam = camera.position.clone().sub(m.position).normalize();
    let up = new THREE.Vector3().crossVectors(dir, toCam);
    // A round flying almost straight at or away from the lens.
    //
    // The cross product degenerates, the old code fell back to world +Y,
    // and the quad ended up standing on end: a reviewer spotted the
    // result as "perfectly vertical screen-aligned streaks, identical
    // length" in exactly the frames where fire ran up the view axis.
    // A bolt coming at you is a point, not a stripe, so it fades out
    // as it lines up with the camera rather than snapping upright.
    const edgeOn = up.length();          // = |sin(angle to view)|
    if (edgeOn < 1e-3) { m.visible = false; this.used++; return m; }
    mat.opacity = opacity * Math.min(1, edgeOn * 3.2);
    if (mat.opacity < 0.01) { m.visible = false; this.used++; return m; }
    up.normalize();
    const nrm = new THREE.Vector3().crossVectors(up, dir).normalize();
    const basis = new THREE.Matrix4().makeBasis(dir, up, nrm);
    m.quaternion.setFromRotationMatrix(basis);
    // Never wider than it is long. A short kinetic slug at a wide beam
    // width becomes a near-square quad, and a camera-facing square of
    // flat colour is not a bolt -- it is the "flat magenta rectangular
    // slab sitting on the planet" two reviewers independently reported
    // as a bug. Bolts stay bolt-shaped.
    m.scale.set(len, Math.min(width, len * 0.45), 1);
    m.visible = true;
    this.used++;
    return m;
  }

  end() {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false;
  }
}

/**
 * One detonation, staged over its life rather than scaled as a single
 * blob: a white flash that is gone almost immediately, a fireball that
 * blooms and cools, an expanding shell, and embers thrown clear.
 *
 * `k` is 0..1 across the blast's life. `size` is the radius the
 * fireball reaches.
 */
/**
 * A round landing on plating: a hot core, a ring driven off the point of
 * impact, and a few pieces of spall thrown back down the incoming line.
 *
 * `k` runs 0 (arrival) to 1 (gone). `held` means the target's shields
 * ate it, which flares cold and wide instead of burning.
 */
export function drawImpact(
  bb: Billboards, at: THREE.Vector3, back: THREE.Vector3,
  k: number, size: number, seed: number, held: boolean, tint: number,
): void {
  if (k < 0 || k > 1) return;
  const jr = ((seed * 61) % 89) / 89;
  const roll = jr * Math.PI * 2;
  const f = (1 - k) * (1 - k);
  // Core: white for two frames, then the weapon's own colour.
  bb.put(flareTex(), at, size * (0.9 + k * 1.5), size * (0.9 + k * 1.5),
    k < 0.25 ? 0xffffff : tint, f, roll);
  // Ring: driven off the plating, gone before the core is.
  if (k < 0.55) {
    const rk = k / 0.55;
    bb.put(ringTex(), at, size * (0.5 + rk * 3.4), size * (0.5 + rk * 3.4),
      held ? 0x8fd8ff : 0xffd9a0, (1 - rk) * (1 - rk) * (held ? 0.7 : 0.5), roll);
  }
  // Spall, thrown back along the incoming round. Shields hold, so a
  // stopped hit throws nothing.
  if (held) return;
  for (let i = 0; i < 5; i++) {
    const s = Math.sin(seed + i * 31.7) * 43758.5453;
    const r1 = s - Math.floor(s);
    const s2 = Math.sin(seed + i * 17.3) * 43758.5453;
    const r2 = s2 - Math.floor(s2);
    const dist = size * (0.4 + r1 * 2.6) * k;
    const p = at.clone()
      .add(back.clone().multiplyScalar(dist))
      .add(new THREE.Vector3(r2 - 0.5, r1 - 0.5, r2 * r1 - 0.25)
        .multiplyScalar(dist * 0.8));
    bb.put(glowTex(), p, size * 0.22 * (1 - k), size * 0.22 * (1 - k),
      0xffc070, f * 0.9);
  }
}

export function drawBlast(
  bb: Billboards, at: THREE.Vector3, k: number, size: number, seed: number,
): void {
  if (k < 0 || k > 1) return;
  // No two kills are the same blast: the seed moves the scale and the
  // pacing, because a cloned explosion is spotted by the third kill.
  const jr = ((seed * 137) % 97) / 97;
  // Every blast is rolled to its own angle: an unrotated billboard
  // reused across a reel is spotted as one decal by the third kill.
  const roll = jr * Math.PI * 2;
  const sz = size * (0.75 + jr * 0.7);
  const kk = Math.min(1, k * (0.9 + jr * 0.25));
  // Flash: two frames of pure white, which is what sells the instant.
  if (kk < 0.12) {
    const a = 1 - kk / 0.12;
    bb.put(glowTex(), at, sz * 4.2 * (0.5 + kk * 3), sz * 4.2 * (0.5 + kk * 3),
      0xffffff, a * 0.95);
  }
  // Fireball: blooms fast, cools through amber, fades. This carries the
  // event -- the shell is an accent, not the subject.
  const fb = Math.min(1, kk / 0.42);
  const fbR = sz * (0.5 + 1.7 * (1 - (1 - fb) * (1 - fb)));
  const heat = Math.max(0, 1 - kk * 1.15);
  if (heat > 0.01) {
    bb.put(fireTex(), at, fbR * 2, fbR * 2,
      new THREE.Color(1, 0.55 + heat * 0.4, 0.25 + heat * 0.5), heat, roll);
  }
  // Shell: brief and thin. Left to linger past the fire it reads as a
  // donut, and the donut was every reviewer's first complaint.
  if (kk < 0.3) {
    const rk = kk / 0.3;
    const rR = sz * (0.6 + rk * 2.6);
    bb.put(ringTex(), at, rR * 2, rR * 2, 0xffd9a0,
      (1 - rk) * (1 - rk) * 0.55, roll * 0.6);
  }
  // Embers: thrown clear, cooling, gone before the smoke.
  const n = 9;
  for (let i = 0; i < n; i++) {
    const s = Math.sin(seed + i * 12.9898) * 43758.5453;
    const r1 = s - Math.floor(s);
    const s2 = Math.sin(seed + i * 78.233) * 43758.5453;
    const r2 = s2 - Math.floor(s2);
    const s3 = Math.sin(seed + i * 39.425) * 43758.5453;
    const r3 = s3 - Math.floor(s3);
    const th = r1 * Math.PI * 2, ph = Math.acos(2 * r2 - 1);
    const d = size * (0.8 + r3 * 3.4) * (1 - (1 - k) * (1 - k));
    const p = at.clone().add(new THREE.Vector3(
      Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th),
    ).multiplyScalar(d));
    const a = Math.max(0, 1 - k * 1.5) * (0.5 + r3 * 0.5);
    if (a <= 0.02) continue;
    const es = size * (0.1 + r3 * 0.14);
    bb.put(glowTex(), p, es * 2, es * 2,
      new THREE.Color(1, 0.5 + r3 * 0.3, 0.15), a);
  }
}

/**
 * An engine: a white-hot root at the bell falling away down a plume that
 * points where the ship is NOT going.
 *
 * The plume has to be an oriented quad, not a billboard. A sprite is
 * screen-aligned, so a plume built from sprites renders as a blob beside
 * the hull instead of a flame behind it -- which is exactly how the
 * first version came out on the bench.
 */
export function drawPlume(
  tr: Tracers, bb: Billboards, bell: THREE.Vector3, back: THREE.Vector3,
  size: number, color: THREE.ColorRepresentation, throttle: number,
  camera: THREE.Camera,
): void {
  if (throttle <= 0.01) return;
  const dir = back.clone().normalize();
  const len = size * 3.4 * (0.45 + throttle * 0.55);
  // The tracer texture is hot at the head, so the plume is drawn from
  // its tail toward the bell: the brightest end lands at the engine.
  tr.put(bell.clone().add(dir.clone().multiplyScalar(len)), bell,
    size * 1.15, color, 0.6 * throttle, camera);
  // The root: small, near-white, the brightest thing on the hull -- but
  // a GLOW, not a ball. Oversized and opaque it read as a snowball
  // bolted to the stern.
  bb.put(glowTex(), bell, size * 0.42, size * 0.42, 0xd8ecff, 0.66 * throttle);
}


// ---- hull material ----------------------------------------------------

let envTex: THREE.Texture | null = null;
/**
 * Something for metal to reflect.
 *
 * A hull at metalness 0.9 with no environment renders BLACK, because a
 * mirror in an empty room shows an empty room. This is a cheap
 * equirectangular sky: cold starlight overhead, the star's warmth on one
 * side, and a dark floor -- enough for a spec lobe to travel across a
 * bevel and describe its shape, which is the whole point of making the
 * hulls metal in the first place.
 */
export function spaceEnv(renderer: THREE.WebGLRenderer): THREE.Texture {
  if (envTex) return envTex;
  const W = 256, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#243a55');
  sky.addColorStop(0.45, '#0f1826');
  sky.addColorStop(1, '#05070c');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  // The star: a hot pool on one side, which is what a bevel picks up as
  // it rolls.
  const st = g.createRadialGradient(W * 0.26, H * 0.33, 0, W * 0.26, H * 0.33, W * 0.3);
  st.addColorStop(0, 'rgba(248,246,240,1)');
  st.addColorStop(0.35, 'rgba(206,214,226,0.5)');
  st.addColorStop(1, 'rgba(150,170,200,0)');
  g.fillStyle = st; g.fillRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(cv);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  envTex = pmrem.fromEquirectangular(t).texture;
  pmrem.dispose();
  t.dispose();
  return envTex;
}

/** Cold metal, for what is left after a hull dies. */
export const wreckMaterial = () => new THREE.MeshStandardMaterial({
  color: 0x776b5c, metalness: 0.55, roughness: 0.7,
  emissive: new THREE.Color(0x38180a), emissiveIntensity: 0.5,
});


// ---- hull plating -----------------------------------------------------

let plateMaps: {
  map: THREE.Texture; rough: THREE.Texture; norm: THREE.Texture; emis: THREE.Texture;
} | null = null;

/**
 * Tiling hull plate: panel seams, plate-to-plate tone variation, rivet
 * lines and wear.
 *
 * Generic and tiled rather than derived per ship, because the models are
 * built from primitives now and primitives come with sane UVs. One
 * texture serves every hull in the fleet, which is also why it can
 * afford to be detailed.
 */
function platingTextures() {
  if (plateMaps) return plateMaps;
  const S = 512;
  const alb = document.createElement('canvas'); alb.width = alb.height = S;
  const rgh = document.createElement('canvas'); rgh.width = rgh.height = S;
  const ag = alb.getContext('2d')!, rg = rgh.getContext('2d')!;
  const rnd = mulberry32(0x51a7);

  ag.fillStyle = '#8b929c'; ag.fillRect(0, 0, S, S);
  rg.fillStyle = '#8c8c8c'; rg.fillRect(0, 0, S, S);

  // Plates: an irregular grid, each with its own tone, so the hull is
  // assembled rather than moulded.
  const cols = 6, rows = 5;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c / cols) * S, y = (r / rows) * S;
      const w = S / cols, h = S / rows;
      // Plate-to-plate variation lives in ROUGHNESS, not albedo. At
      // 0.68-1.30 every plate was a different shade of grey and the hull
      // read as urban camouflage; a real hull is one paint colour whose
      // plates have weathered differently. Narrow the tone, widen the
      // gloss, and the seams do the describing.
      const t = 0.9 + rnd() * 0.16;
      ag.fillStyle = `rgb(${Math.round(139 * t)},${Math.round(146 * t)},${Math.round(156 * t)})`;
      ag.fillRect(x, y, w - 1, h - 1);
      // Narrower, and never mirror-bright. Widening this to 96-228 to
      // carry the plate variation put the glossiest plates at ~0.32
      // final roughness, which caught the rim light as hard white
      // rectangles a reviewer read as a missing texture. Weathering
      // varies gloss; it does not polish a plate to chrome.
      const rv = Math.round(150 + rnd() * 78);
      rg.fillStyle = `rgb(${rv},${rv},${rv})`;
      rg.fillRect(x, y, w - 1, h - 1);
      // A sub-panel inside some plates, for a second scale of detail.
      if (rnd() > 0.55) {
        const iw = w * (0.3 + rnd() * 0.4), ih = h * (0.3 + rnd() * 0.4);
        const t2 = t * (0.93 + rnd() * 0.07);
        ag.fillStyle =
          `rgb(${Math.round(139 * t2)},${Math.round(146 * t2)},${Math.round(156 * t2)})`;
        ag.fillRect(x + (w - iw) * rnd(), y + (h - ih) * rnd(), iw, ih);
      }
    }
  }
  // Seams between plates.
  ag.strokeStyle = 'rgba(16,18,24,1)';
  ag.lineWidth = 2.6;
  for (let c = 0; c <= cols; c++) {
    ag.beginPath(); ag.moveTo((c / cols) * S, 0); ag.lineTo((c / cols) * S, S); ag.stroke();
  }
  for (let r = 0; r <= rows; r++) {
    ag.beginPath(); ag.moveTo(0, (r / rows) * S); ag.lineTo(S, (r / rows) * S); ag.stroke();
  }
  // Rivets along the seams: the detail that reads as "fabricated" even
  // when it is too small to resolve individually.
  // Rivets, barely there. At 0.35 they were the "bright white speckle"
  // a reviewer read as noise across every hull in the fleet.
  ag.fillStyle = 'rgba(178,186,198,0.14)';
  for (let c = 0; c <= cols; c++) {
    for (let k = 0; k < 26; k++) {
      ag.fillRect((c / cols) * S - 1, (k / 26) * S + 3, 2, 2);
    }
  }
  // Wear: streaks running with the airflow, and scorch patches.
  for (let k = 0; k < 90; k++) {
    const x = rnd() * S, y = rnd() * S, w = 8 + rnd() * 70;
    ag.fillStyle = `rgba(${rnd() > 0.5 ? '58,54,50' : '196,200,208'},${0.05 + rnd() * 0.13})`;
    ag.fillRect(x, y, w, 1 + rnd() * 2);
  }

  // Window rows and running lights, as an emissive layer.
  const emi = document.createElement('canvas'); emi.width = emi.height = S;
  const eg = emi.getContext('2d')!;
  eg.fillStyle = '#000'; eg.fillRect(0, 0, S, S);
  for (let r = 0; r < rows; r++) {
    // Two lit strips per plate row, broken into ports.
    // One lit strip per plate row, not two, and only on some rows. At
    // the coarser plate pitch these became long dotted lines running the
    // length of every hull -- the last of the "white speckle" a reviewer
    // read as noise. A lit ship wants a few windows, not a grid of them.
    if (rnd() > 0.55) continue;
    for (const frac of [0.46]) {
      const y = Math.round((r / rows) * S + (S / rows) * frac);
      let x = Math.round(rnd() * 24);
      while (x < S) {
        const w = 2 + Math.floor(rnd() * 3);
        if (rnd() > 0.28) {
          const warm = rnd() > 0.72;
          eg.fillStyle = warm ? 'rgba(255,214,150,0.6)' : 'rgba(190,224,255,0.55)';
          eg.fillRect(x, y, w, 1);
        }
        x += w + 7 + Math.floor(rnd() * 14);
      }
    }
  }
  // A few bright beacons.
  for (let k = 0; k < 5; k++) {
    eg.fillStyle = rnd() > 0.5 ? 'rgba(255,120,110,1)' : 'rgba(160,235,255,1)';
    const bx = rnd() * S, by = rnd() * S;
    eg.fillRect(bx, by, 3, 3);
  }

  const src = ag.getImageData(0, 0, S, S).data;
  const nrm = document.createElement('canvas'); nrm.width = nrm.height = S;
  const ng = nrm.getContext('2d')!;
  const nimg = ng.createImageData(S, S);
  const lum = (x: number, y: number) => {
    const xi = (x + S) % S, yi = (y + S) % S;
    const o = (yi * S + xi) * 4;
    return (src[o] + src[o + 1] + src[o + 2]) / 765;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (lum(x + 1, y) - lum(x - 1, y)) * 3;
      const dy = (lum(x, y + 1) - lum(x, y - 1)) * 3;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * S + x) * 4;
      nimg.data[o] = ((-dx / l) * 0.5 + 0.5) * 255;
      nimg.data[o + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      nimg.data[o + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      nimg.data[o + 3] = 255;
    }
  }
  ng.putImageData(nimg, 0, 0);

  const mk = (cv: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(cv);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(5, 3);
    t.anisotropy = 8;
    return t;
  };
  plateMaps = { map: mk(alb, true), rough: mk(rgh, false), norm: mk(nrm, false),
    emis: mk(emi, true) };
  return plateMaps;
}

const platedMats = new Map<string, THREE.MeshStandardMaterial>();
/**
 * A plated warship hull in its owner's colours.
 *
 * The plate texture is shared and neutral; the faction lives in a tint
 * on top of it. Grey plate alone is unreadable at battle distance and a
 * solid faction hull is the plastic toy this pipeline exists to escape,
 * so it sits between: steel that has clearly been painted.
 */
export function platedHullMaterial(
  hex: string, variant: string = 'A', trim = false,
): THREE.MeshStandardMaterial {
  const key = `${hex}:${variant}:${trim ? 't' : 'h'}`;
  let m = platedMats.get(key);
  if (!m) {
    const shared = platingTextures();
    // Same plate image, different build. Panel pitch and paint vary per
    // variant, so a line of one class is a line of sister ships rather
    // than one ship copied down the rank: clones share the image data,
    // so this costs a texture object and no memory that matters.
    const rnd = mulberry32(hashStr(`livery:${variant}`));
    // Trim is smaller hardware, so it wears a finer plate pitch. Sharing
    // the hull's pitch made a turret look like a hull offcut.
    // The plate image already contains many plates per tile, so the
    // repeat multiplies that. At 3.4-7.0 the hull came out looking like
    // brickwork or bathroom tile rather than panel plating -- the single
    // loudest "not a real ship" tell at close range.
    // Trim gets a COARSER pitch, not a finer one. I had this backwards:
    // a smaller object has smaller UVs, so doubling the repeat put 1-2m
    // nubs on a 25m bridge block and the texture actively shrank the
    // ship. Fewer, larger plates on small hardware is what keeps the
    // scale cue pointing the right way.
    // ~28-38 plates along a flank, at six plates per tile. The original
    // 3.4-7.0 was roughly RIGHT ON SCALE and wrong on tone: the hull
    // read as camouflage because every plate was a different grey, and
    // pulling the pitch down "fixed" that by hiding it. The tone fix
    // (narrow albedo, variation in roughness) was the real one, so the
    // scale can go back where it belonged. Two problems, one knob --
    // worth separating before turning it next time.
    const pitch = (4.7 + rnd() * 1.6) * (trim ? 0.35 : 1);
    const skew = 0.72 + rnd() * 0.7;
    // ONE offset, shared by all four maps.
    //
    // This was drawn inside clone(), which is called once per map, so
    // albedo, roughness, normal and emissive each got a DIFFERENT slide.
    // The roughness map was therefore misaligned from the plating: its
    // glossy cells landed part-way across a plate instead of on one, and
    // the mismatch showed up as hard-edged rectangles of raised specular
    // whose borders sat a pixel or two inboard of the visible seams,
    // quantised per plate, random in amplitude, view-dependent, on
    // grazing flanks only, absent from the untextured greeble material.
    //
    // I chased that artifact through the lights, the emissive, the
    // environment map, the normal scale and a set of intersecting
    // radiators, ruling each out by controlled test and finding it
    // survived all of them -- because none of them was ever it. What
    // found it was a reviewer measuring the thing instead of theorising
    // about it: per-plate quantisation with edges OFF the seams is a
    // sampling misalignment and essentially nothing else.
    const offU = rnd() * 0.5, offV = rnd() * 0.5;
    const clone = (t: THREE.Texture) => {
      const c = t.clone();
      c.needsUpdate = true;
      c.repeat.set(pitch, pitch * 0.6 * skew);
      c.offset.set(offU, offV);
      return c;
    };
    const p = {
      map: clone(shared.map), rough: clone(shared.rough),
      norm: clone(shared.norm), emis: clone(shared.emis),
    };
    const faction = new THREE.Color(hex);
    m = new THREE.MeshStandardMaterial({
      map: p.map,
      roughnessMap: p.rough,
      normalMap: p.norm,
      // Softened. The normal map is derived from albedo luminance, so
      // every plate seam becomes a ridge and every sub-panel a step; at
      // 0.55 those steps caught the key hard enough to read as lighter
      // plates. Ruled out albedo, roughness, emissive and the
      // environment one at a time before arriving here -- the maps were
      // clean, so the relief had to be doing it.
      normalScale: new THREE.Vector2(0.22, 0.22),
      color: (() => {
        const h = { h: 0, s: 0, l: 0 };
        faction.getHSL(h);
        // Hull greys run from cold steel to a warm bone, per variant, so
        // the fleet is not one paint code with the lights turned down.
        const base = new THREE.Color().setHSL(0.55 - rnd() * 0.12,
          0.05 + rnd() * 0.05, 0.34 + rnd() * 0.12);
        if (trim) {
          // TRIM IS WHERE THE FACTION LIVES, and it has to survive the
          // lighting. Pulled down to a whisper it disappeared entirely:
          // a reviewer counted 4,733 blue pixels and 4 red ones on a
          // ship that is supposed to be red, and correctly called the
          // two navies indistinguishable. Trim is superstructure,
          // turrets, engine housings and cargo -- a large, everywhere
          // area on every archetype -- so it can carry real saturation
          // where the broad hull plate cannot. This is the two-tone.
          // KEEP THE FACTION'S OWN LIGHTNESS. Forcing every livery to
          // L = 0.34 crushed all four colours in the test set, and it
          // was fatal for the pale ones: a reviewer measured Frowny's
          // #c9d6e8 trim rendering DARKER than the hull it sits on, so
          // half the roster had no visible livery at all. A navy that
          // paints pale grey stays pale grey.
          const paint = new THREE.Color().setHSL(h.h,
            Math.max(0.35, Math.min(0.85, h.s)),
            Math.max(0.34, Math.min(0.66, h.l)));
          return base.clone().multiplyScalar(0.7).lerp(paint, 0.85);
        }
        // The hull keeps a grey identity, but leans further toward the
        // faction than before: a blue key light was making a red navy
        // read bluer than a blue one, which is worse than no tint.
        const muted = new THREE.Color().setHSL(h.h, Math.min(0.6, h.s * 0.72), 0.45);
        return base.lerp(muted, 0.4 + rnd() * 0.12);
      })(),
      // Hull metal, not matte plastic. At 0.28 with a weak environment
      // nothing specular travelled across a curved surface, so the
      // spinal hulls' cylinders shaded purely by normal-to-light and
      // read as painted cardboard. The roughness map still does the
      // varying; this is the ceiling it varies under.
      metalness: 0.52,
      roughness: 0.86,
      emissiveMap: p.emis,
      emissive: new THREE.Color(0xffffff),
      // 1.5 made the window rows the brightest thing on the hull. Three
      // reviewers described "panels jumping to near-pure white"; the map
      // dump showed albedo and roughness were both clean, and the bright
      // rectangles lined up exactly with the window dashes. Lit windows,
      // not a broken texture -- but far too hot to read as windows.
      emissiveIntensity: 0.55,
      envMapIntensity: 0.35,
    });
    platedMats.set(key, m);
  }
  return m;
}

/**
 * A hull that is losing burns. Fires ride the ship, cooling and
 * flaring, so a viewer can see a ship in trouble before it dies --
 * every reference plate has a capital ship on fire somewhere on it.
 */
// ---- livery ------------------------------------------------------------
//
// WHO OWNS THIS SHIP, AND WHICH SHIP IS IT.
//
// The plate texture tiles about five times along a hull, which is right
// for plating and fatal for markings: anything painted into it repeats
// five times too. So the livery is its own geometry — a thin panel on
// each flank carrying a per-ship canvas with its own UVs, mapped once.
//
// That panel is where the two-tone actually happens. Previous rounds
// tried to carry the faction in a tint across the whole hull, which is
// the choice that made ships read as plastic when it was strong enough
// to see and read as nothing when it was not. A navy paints its hull
// grey and its MARKINGS in its colours, and every reference does the
// same: the identity is in a band, a stripe, a number and a name.

const decalCache = new Map<string, THREE.MeshStandardMaterial>();

/**
 * One ship's flank markings: faction band, accent stripe, name, number.
 *
 * Drawn white-on-transparent so the panel only paints where there is
 * ink, and sized so the NAME is the largest thing on it — legibility at
 * a distance is the whole point, and a name nobody can read is just
 * noise on the hull.
 */
export function hullDecalMaterial(
  shipName: string, primary: string, secondary: string, hullNo: string,
): THREE.MeshStandardMaterial {
  const key = `${shipName}|${primary}|${secondary}|${hullNo}`;
  const hit = decalCache.get(key);
  if (hit) return hit;

  // A TALL canvas, and the number is the hero.
  //
  // A full ship name rendered across a flank came out about 30 screen
  // pixels wide, where no glyph resolves at any distance -- a reviewer
  // could see a smear and count word gaps but not read a letter. Digits
  // resolve at roughly a quarter the pixels a name needs, so the hull
  // NUMBER carries identity at distance and the name sits under it for
  // anyone close enough to care. Same information, ordered by what
  // survives being small.
  const W = 1024, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;

  // Faction band across the lower third, hard-edged: the block of
  // colour that has to read before any glyph does.
  g.fillStyle = secondary;
  g.fillRect(0, H * 0.42, W, H * 0.14);
  g.fillStyle = primary;
  g.fillRect(0, H * 0.37, W, H * 0.045);

  // The number, enormous, in the faction primary on a dark plate.
  const no = (hullNo || '00').slice(0, 4);
  g.font = '800 210px Arial, Helvetica, sans-serif';
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  const nw = g.measureText(no).width;
  g.fillStyle = 'rgba(8,11,17,0.55)';
  g.fillRect(0, 0, nw + 60, H * 0.43);
  g.fillStyle = primary;
  g.fillText(no, 30, H * 0.3);
  // A hairline of the secondary under the digits ties them to the band.
  // One painted stripe running under the number AND the name, so they
  // read as a single marking block rather than two decals.
  g.fillStyle = primary;
  g.fillRect(24, H * 0.335, W * 0.9, 14);

  // The name, aft of the number, sized to whatever room is left.
  const label = (shipName || 'UNNAMED').toUpperCase();
  let size = 96;
  g.font = `700 ${size}px Arial, Helvetica, sans-serif`;
  const room = W - nw - 110;
  while (g.measureText(label).width > room && size > 30) {
    size -= 4;
    g.font = `700 ${size}px Arial, Helvetica, sans-serif`;
  }
  g.fillStyle = secondary;
  g.fillText(label, nw + 76, H * 0.27);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const m = new THREE.MeshStandardMaterial({
    map: tex,
    transparent: true,
    roughness: 0.72,
    metalness: 0.1,
    // Markings carry a little of their own light. Paint on the shadow
    // flank of a hull in space receives almost nothing, and a name you
    // can only read on one side of the ship is not identification --
    // it is a coin toss. Low enough that it never reads as a lightbox.
    emissiveMap: tex,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.16,
    // Sits ON the plating, so it must win the depth test at the same
    // depth without being pushed visibly off the hull.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    depthWrite: false,
  });
  decalCache.set(key, m);
  return m;
}

/**
 * Hang the markings on both flanks of a hull.
 *
 * Children of the mesh, so they ride every transform the ship gets —
 * arrival, orbit, tumble — without any of those places knowing markings
 * exist. Sized off the hull's own envelope so a corvette's name is
 * proportionally as big as a destroyer's.
 */
export function attachLivery(
  mesh: THREE.Mesh, halfBeam: number, halfHeight: number,
  material: THREE.MeshStandardMaterial,
): void {
  // Sized to FILL the flank, because there is barely any flank to fill.
  //
  // A wedge hull is 6% of its own length tall, so the side of the ship is
  // a letterbox: the only way a name is legible there is to give it the
  // entire height and let the canvas aspect set the width. Placed at
  // y = 0, which is where a four-sided prism carries its widest beam --
  // above or below that the hull narrows away from a flat quad and
  // swallows the markings, which is exactly how the first two attempts
  // lost them.
  // PROUD OF THE BEAM, not flush with it.
  //
  // These hulls have a diamond section -- full beam at y = 0, tapering
  // to nothing at deck and keel -- so a flat quad set at the beam is
  // buried across its middle and pokes out only at its edges. That is
  // why the name appeared while it sat at the top of the canvas and
  // disappeared the moment it was centred: the middle of the panel was
  // inside the ship. Standing it a little off the flank keeps the whole
  // marking on the outside of the hull at every height.
  const h = halfHeight * 1.55;
  const w = h * 2;                        // the decal canvas is 1024x512
  for (const side of [1, -1]) {
    const q = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    q.position.set(-0.1, 0, side * (halfBeam + 0.005));
    if (side < 0) q.rotation.y = Math.PI;
    q.renderOrder = 2;
    mesh.add(q);
  }
}

export function drawHullFire(
  bb: Billboards, at: THREE.Vector3, size: number, severity: number,
  seed: number, phase: number,
): void {
  const n = 1 + Math.floor(severity * 3);
  for (let i = 0; i < n; i++) {
    const s1 = Math.sin(seed + i * 91.7) * 43758.5453;
    const r1 = s1 - Math.floor(s1);
    const s2 = Math.sin(seed + i * 41.3) * 43758.5453;
    const r2 = s2 - Math.floor(s2);
    // Flicker: a fire that does not move is a decal.
    const f = 0.6 + 0.4 * Math.sin(phase * 0.006 + i * 2.1);
    const off = new THREE.Vector3(
      (r1 - 0.5) * size * 0.7, (r2 - 0.3) * size * 0.16, (r1 - 0.5) * size * 0.2);
    // Rolled, and never square. Unrotated equal-sided copies of one
    // sprite are what reviewers keep identifying as "the same orange
    // disc pasted on the hull" -- the tell is not the texture, it is
    // that every instance has the same orientation and aspect.
    const roll = r1 * Math.PI * 2 + phase * 0.0004;
    const w = size * 0.3 * f * (0.8 + r2 * 0.55);
    const h = size * 0.3 * f * (0.7 + r1 * 0.5);
    bb.put(fireTex(), at.clone().add(off), w, h,
      new THREE.Color(1, 0.42 + r2 * 0.2, 0.14 + r1 * 0.16),
      (0.5 + severity * 0.5) * f, roll);
  }
}

export function disposeFx(): void {
  for (const k of Object.keys(cache)) cache[k].dispose();
  cache = {};
}
