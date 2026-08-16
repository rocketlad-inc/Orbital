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
 * A tracer: hot at the head, gone at the tail, and thinner as it goes.
 * Painted left-to-right so the quad can be stretched along its flight
 * path with the head at u=1.
 */
export const tracerTex = () => paint('tracer', (g, S) => {
  g.clearRect(0, 0, S, S);
  for (let x = 0; x < S; x++) {
    const u = x / (S - 1);
    // Head-weighted brightness, and a taper that narrows toward the tail.
    const a = Math.pow(u, 3.2);
    const half = (0.10 + 0.34 * Math.pow(u, 1.5)) * S;
    const grad = g.createLinearGradient(0, S / 2 - half, 0, S / 2 + half);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, `rgba(255,255,255,${a.toFixed(3)})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x, S / 2 - half, 1, half * 2);
  }
  // The head sat flush against the tile edge as a razor-cut vertical
  // wall with no anti-aliasing -- a flat vector triangle rather than
  // light. Fade the last few columns so the round has a nose.
  g.globalCompositeOperation = 'destination-in';
  const f = g.createLinearGradient(0, 0, S, 0);
  f.addColorStop(0, 'rgba(0,0,0,1)');
  f.addColorStop(0.955, 'rgba(0,0,0,1)');
  f.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = f;
  g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'source-over';
}, 256, false);

/** The expanding shell of a detonation: bright rim, hollow middle. */
export const ringTex = () => paint('ring', (g, S) => {
  const r = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  r.addColorStop(0, 'rgba(255,255,255,0)');
  r.addColorStop(0.62, 'rgba(255,255,255,0)');
  r.addColorStop(0.80, 'rgba(255,240,210,0.95)');
  r.addColorStop(0.90, 'rgba(255,150,60,0.45)');
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
    if (up.lengthSq() < 1e-6) up.set(0, 1, 0);
    up.normalize();
    const nrm = new THREE.Vector3().crossVectors(up, dir).normalize();
    const basis = new THREE.Matrix4().makeBasis(dir, up, nrm);
    m.quaternion.setFromRotationMatrix(basis);
    m.scale.set(len, width, 1);
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
export function drawBlast(
  bb: Billboards, at: THREE.Vector3, k: number, size: number, seed: number,
): void {
  if (k < 0 || k > 1) return;
  // Flash: two frames of pure white, which is what sells the instant.
  if (k < 0.12) {
    const a = 1 - k / 0.12;
    bb.put(glowTex(), at, size * 4.2 * (0.5 + k * 3), size * 4.2 * (0.5 + k * 3),
      0xffffff, a * 0.95);
  }
  // Fireball: blooms fast, cools through amber, fades.
  const fb = Math.min(1, k / 0.42);
  const fbR = size * (0.35 + 1.5 * (1 - (1 - fb) * (1 - fb)));
  const heat = Math.max(0, 1 - k * 1.25);
  if (heat > 0.01) {
    bb.put(fireTex(), at, fbR * 2, fbR * 2,
      new THREE.Color(1, 0.55 + heat * 0.4, 0.25 + heat * 0.5), heat);
  }
  // Shell: a thin bright ring outrunning the fire.
  if (k < 0.55) {
    const rk = k / 0.55;
    const rR = size * (0.5 + rk * 3.1);
    bb.put(ringTex(), at, rR * 2, rR * 2, 0xffd9a0, (1 - rk) * (1 - rk) * 0.8);
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
  // The root: small, near-white, the brightest thing on the hull.
  bb.put(glowTex(), bell, size * 0.95, size * 0.95, 0xcfe6ff, 0.95 * throttle);
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
  st.addColorStop(0, 'rgba(255,240,214,1)');
  st.addColorStop(0.35, 'rgba(255,196,128,0.5)');
  st.addColorStop(1, 'rgba(255,170,100,0)');
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

const hullMats = new Map<string, THREE.MeshStandardMaterial>();
/**
 * A hull is a MACHINE that wears its owner's colour, not a solid of it.
 *
 * Painting the whole ship in the faction hue is what made every reviewer
 * call these candy: saturated albedo plus a lambert falloff is plastic,
 * whatever shape it is. The body is dark metal; the faction colour goes
 * in at about a quarter strength and comes back as emissive so the hull
 * reads as powered and still identifies its side at battle distance.
 */
export function hullMaterial(hex: string): THREE.MeshStandardMaterial {
  let m = hullMats.get(hex);
  if (!m) {
    const faction = new THREE.Color(hex);
    const body = new THREE.Color(0x2c3138).lerp(faction, 0.26);
    m = new THREE.MeshStandardMaterial({
      color: body,
      metalness: 0.88,
      roughness: 0.42,
      // A low emissive in the faction hue keeps the shadow side from
      // crushing to a silhouette-shaped hole and reads as running lights
      // at distance.
      emissive: faction.clone().multiplyScalar(0.12),
      emissiveIntensity: 1,
      envMapIntensity: 1.15,
    });
    hullMats.set(hex, m);
  }
  return m;
}

/** Cold metal, for what is left after a hull dies. */
export const wreckMaterial = () => new THREE.MeshStandardMaterial({
  color: 0x4a4740, metalness: 0.85, roughness: 0.72,
});

export function disposeFx(): void {
  for (const k of Object.keys(cache)) cache[k].dispose();
  cache = {};
}
