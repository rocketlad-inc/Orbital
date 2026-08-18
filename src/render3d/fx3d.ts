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
 * A LASER: a bolt of light that connects two ships.
 *
 * Deliberately not the tracer. A tracer is hot at the head and gone at the
 * tail, which is right for a slug in flight and wrong for a beam -- a beam
 * is lit all at once, so it is the SAME along its whole length. The
 * structure lives across its width instead: a white-hot filament down the
 * centre line inside a soft bloom, with only the last few percent at each
 * end feathered so the bolt does not stop on a guillotine edge.
 */
export const beamTex = () => paint('beam', (g, S) => {
  g.clearRect(0, 0, S, S);
  const half = 0.42 * S;
  for (let x = 0; x < S; x++) {
    const u = x / (S - 1);
    const ends = Math.min(1, Math.min(u, 1 - u) / 0.04);
    const grad = g.createLinearGradient(0, S / 2 - half, 0, S / 2 + half);
    grad.addColorStop(0.00, 'rgba(255,255,255,0)');
    grad.addColorStop(0.30, `rgba(255,255,255,${(ends * 0.16).toFixed(3)})`);
    grad.addColorStop(0.42, `rgba(255,255,255,${(ends * 0.55).toFixed(3)})`);
    grad.addColorStop(0.50, `rgba(255,255,255,${ends.toFixed(3)})`);
    grad.addColorStop(0.58, `rgba(255,255,255,${(ends * 0.55).toFixed(3)})`);
    grad.addColorStop(0.70, `rgba(255,255,255,${(ends * 0.16).toFixed(3)})`);
    grad.addColorStop(1.00, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x, S / 2 - half, 1, half * 2);
  }
  // clampEdge OFF: the default mask is RADIAL and would fade a beam out at
  // both ends and pinch its middle -- the one thing a laser must not do.
}, 128, false);

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
/**
 * A drive plume, painted left-to-right from the bell mouth.
 *
 * Its own texture, because the tracer's is a BOLT -- constant width with
 * a blunt end -- and stretching that into a long quad makes a hard-edged
 * wedge. Rendered big and opaque, a wedge reads as a solid cone stuck to
 * the stern, which is exactly what it looked like.
 *
 * A flame is bright and narrow where it leaves the throat, spreads as it
 * cools, and has NO EDGE anywhere: the alpha has to reach zero smoothly
 * in both axes or the quad's own outline shows.
 */
export const plumeTex = () => paint('plume', (g, S) => {
  g.clearRect(0, 0, S, S);
  for (let x = 0; x < S; x++) {
    const u = x / (S - 1);
    // Narrow at the throat, spreading downstream.
    const half = (0.06 + u * 0.34) * S;
    // Hot at the throat, dying along the length -- and dying to nothing
    // well before the quad's far edge, so the end is never a cut.
    const a = Math.pow(1 - u, 1.7) * (u < 0.06 ? u / 0.06 : 1);
    if (a <= 0.001) continue;
    const grad = g.createLinearGradient(0, S / 2 - half, 0, S / 2 + half);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.32, `rgba(255,255,255,${(a * 0.32).toFixed(3)})`);
    grad.addColorStop(0.5, `rgba(255,255,255,${a.toFixed(3)})`);
    grad.addColorStop(0.68, `rgba(255,255,255,${(a * 0.32).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x, S / 2 - half, 1, half * 2);
  }
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
  // A fireball is TURBULENT, not radial. The perfectly smooth gradient
  // version earned the same words from two reviewers -- "a flat radial
  // gradient sphere, no internal structure" and "flat circular colour
  // smudges with visible concentric stepping". So: a radial base, then
  // hot convective lobes and dark occluding clumps layered over it at
  // seeded positions, and a film of fine noise to break the 8-bit
  // banding that additive blending amplifies into countable rings.
  const r = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  r.addColorStop(0, 'rgba(255,255,248,1)');
  r.addColorStop(0.16, 'rgba(255,238,180,0.96)');
  r.addColorStop(0.38, 'rgba(255,150,52,0.72)');
  r.addColorStop(0.66, 'rgba(196,58,16,0.3)');
  r.addColorStop(1, 'rgba(70,16,6,0)');
  g.fillStyle = r; g.fillRect(0, 0, S, S);
  const rnd = mulberry32(0xf1ae);
  // Hot lobes: brighter convection cells inside the ball.
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 14; i++) {
    const a = rnd() * Math.PI * 2, d = rnd() * S * 0.26;
    const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d;
    const rad = S * (0.04 + rnd() * 0.09);
    const l = g.createRadialGradient(x, y, 0, x, y, rad);
    l.addColorStop(0, `rgba(255,${200 + Math.floor(rnd() * 55)},120,${0.25 + rnd() * 0.3})`);
    l.addColorStop(1, 'rgba(255,160,60,0)');
    g.fillStyle = l;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // Dark clumps: soot occluding the glow, which is what gives an
  // explosion a silhouette instead of a halo.
  //
  // 'source-atop', NOT 'multiply'. The multiply version's gradients ended
  // in OPAQUE white, so every clump wrote alpha into the transparent
  // corners of its own rect -- and a fresh review panel unanimously
  // described the result: "hard-edged translucent cubes arranged in
  // plus-shapes", the loudest amateur tell in the set. source-atop can
  // only darken pixels the fireball already owns, so the silhouette
  // stays the fireball's own.
  g.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < 10; i++) {
    const a = rnd() * Math.PI * 2, d = S * 0.12 + rnd() * S * 0.24;
    const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d;
    const rad = S * (0.05 + rnd() * 0.1);
    const l = g.createRadialGradient(x, y, 0, x, y, rad);
    l.addColorStop(0, `rgba(40,26,20,${0.35 + rnd() * 0.3})`);
    l.addColorStop(1, 'rgba(40,26,20,0)');
    g.fillStyle = l;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // Dither film: +-3 levels of per-pixel noise, invisible as noise,
  // fatal to banding.
  g.globalCompositeOperation = 'source-over';
  const img = g.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] === 0) continue;
    const n = (rnd() - 0.5) * 6;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
  }
  g.putImageData(img, 0, 0);
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
    tex?: THREE.Texture,
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
    const want = tex ?? tracerTex();
    if (mat.map !== want) { mat.map = want; mat.needsUpdate = true; }
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
  // Born SMALL. The flare used to start at 90% size on its first frame,
  // which the motion review read as a pop -- "already at peak brightness
  // in one interval". One visible cell of growth sells the strike.
  const grow = 0.3 + 0.7 * Math.min(1, k / 0.22);
  // Core: white for two frames, then the weapon's own colour.
  bb.put(flareTex(), at, size * (0.9 + k * 1.5) * grow, size * (0.9 + k * 1.5) * grow,
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
  // THE ENVELOPE. An animation review tracked these on exposure sheets
  // and reported the exact failure: the blast went 0 to 100% inside one
  // 110ms sample, then sat at a frozen radius for up to 700ms with only
  // its brightness fading -- "explosions read as pasted decals, not
  // events". The old code was doing precisely that: the flash drew at
  // 4.2x size from its first frame, and the fireball's radius stopped
  // growing at 42% of its life while alpha faded linearly.
  //
  // A real fireball has a shape in TIME: a fast but visible attack, and
  // then it NEVER stops expanding -- it grows quickly while hot, slowly
  // while cooling, and its light dies exponentially. The same review
  // rated the shield ring's grow/hold/decay the one correct envelope in
  // the reel; this is that curve, sized for fire.
  const fbR = sz * (0.35 + 1.85 * Math.pow(kk, 0.45));
  // Flash: born small, swells WITH the fireball, gone in ~90ms.
  if (kk < 0.09) {
    const a = 1 - kk / 0.09;
    bb.put(glowTex(), at, fbR * 2.6, fbR * 2.6, 0xffffff, a * 0.95);
  }
  const heat = Math.exp(-2.4 * kk) * (1 - kk);
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
  camera: THREE.Camera, phase = 0,
): void {
  if (throttle <= 0.01) return;
  const dir = back.clone().normalize();

  // MODEST. The previous pass ran three nested cones at six times the
  // bell's own size and high alpha, which is how a drive flame becomes a
  // traffic cone bolted to the stern. An exhaust is a small bright thing
  // close to the ship; it is the BRIGHTNESS that has to read at
  // distance, never the size.
  const flick = 0.92 + 0.08 * Math.sin(phase * 0.019 + bell.x * 3.1);
  const L = size * 3.4 * (0.5 + throttle * 0.5) * flick;
  const tex = plumeTex();

  // Outer wash: the faction's colour, narrow and very faint.
  tr.put(bell, bell.clone().addScaledVector(dir, L), size * 0.72,
    color, 0.30 * throttle, camera, tex);
  // Core: short, pale, and the part that actually reads.
  tr.put(bell, bell.clone().addScaledVector(dir, L * 0.55), size * 0.34,
    0xcfe6ff, 0.72 * throttle, camera, tex);

  // THE BELL GLOW HAS TO DIE WITH ITS OWN STREAK.
  //
  // A tracer quad hides itself when it goes edge-on, because a bolt coming
  // straight at the lens is a point and not a stripe. That is right for
  // ordnance and wrong here: when a ship's engines point toward or away
  // from the camera BOTH plume streaks vanish and this glow is left behind
  // on its own -- a soft round ball with no tail, sitting in open space.
  // That is the "tailless glowing blob indistinguishable from a round
  // head" that reviewers reported in frame after frame, and it is also why
  // engine glow and weapons fire kept being confused for one another.
  //
  // So the glow fades with the same geometry the streaks use. Head-on it
  // stays a small hot point (you are looking down the throat of a drive,
  // which should read), never a wide soft sphere.
  const toCam = camera.position.clone().sub(bell);
  const camLen = toCam.length();
  const sideOn = camLen > 1e-4
    ? Math.sqrt(Math.max(0, 1 - Math.pow(dir.dot(toCam) / camLen, 2)))
    : 1;
  const ball = 0.30 + 0.70 * sideOn;
  bb.put(glowTex(), bell, size * 0.20 * ball, size * 0.20 * ball,
    0xe4f2ff, 0.45 * throttle * (0.45 + 0.55 * sideOn));
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
let wreckMat: THREE.MeshStandardMaterial | null = null;
export const wreckMaterial = () => {
  // Wreckage is scorched HULL, not clay. The flat untextured version was
  // called out in two separate reviews as "a completely bare, untextured
  // cone floating at frame bottom" -- a fragment of a plated ship has to
  // carry the same plating, darkened, with heat in the seams.
  if (!wreckMat) {
    const shared = platingTextures();
    wreckMat = new THREE.MeshStandardMaterial({
      color: 0x6a6055, metalness: 0.55, roughness: 0.85,
      map: shared.map, normalMap: shared.norm, roughnessMap: shared.rough,
      emissive: new THREE.Color(0x38180a), emissiveIntensity: 0.5,
    });
  }
  return wreckMat;
};


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

  // PANEL COURSES, NOT A GRID. Two reviewers independently called the
  // old plating "a checkerboard" and "bathroom tile", and they were
  // right about the geometry: a regular 6x5 grid of equal cells with
  // heavy seams IS a checkerboard, whatever its colours are doing. A
  // fabricated hull is welded in long staggered courses -- bands of
  // varying height, split into panels several times longer than they are
  // tall, with joints that never line up between neighbouring bands. The
  // seams come free: panels are drawn 1px short over a darker base, so
  // the base shows through as a hairline, and the heavy 2.6px grid
  // strokes that shouted "tile" are gone entirely.
  ag.fillStyle = '#5a5f68'; ag.fillRect(0, 0, S, S);
  const courses: { y: number; h: number }[] = [];
  {
    let y = 0;
    while (y < S) {
      const h = 26 + Math.floor(rnd() * 38);
      courses.push({ y, h: Math.min(h, S - y) });
      y += h;
    }
  }
  for (const { y, h } of courses) {
    let x = -Math.floor(rnd() * 80);
    while (x < S) {
      const w = Math.max(24, Math.floor(h * (2.2 + rnd() * 3.8)));
      // Tone philosophy unchanged from the last tuning round: albedo
      // stays NARROW (one paint job, weathered) and the plate-to-plate
      // variation lives in roughness.
      const t = 0.9 + rnd() * 0.16;
      ag.fillStyle = `rgb(${Math.round(139 * t)},${Math.round(146 * t)},${Math.round(156 * t)})`;
      ag.fillRect(x, y, w - 1, h - 1);
      const rv = Math.round(150 + rnd() * 78);
      rg.fillStyle = `rgb(${rv},${rv},${rv})`;
      rg.fillRect(x, y, w - 1, h - 1);
      // Sparse fittings, one scale down: an inset hatch or vent on a few
      // panels, dark and small, so close passes find machinery rather
      // than empty paint.
      if (rnd() > 0.8 && w > 40 && h > 30) {
        const fw = 8 + rnd() * 16, fh = 4 + rnd() * 8;
        ag.fillStyle = `rgba(30,33,40,${0.5 + rnd() * 0.3})`;
        ag.fillRect(x + 6 + rnd() * (w - fw - 12), y + 4 + rnd() * (h - fh - 8), fw, fh);
      }
      x += w;
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
  for (const { y: cy, h: ch } of courses) {
    // One lit strip on some courses, broken into ports. A lit ship wants
    // a few windows, not a grid of them.
    if (rnd() > 0.45) continue;
    const y = Math.round(cy + ch * 0.46);
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
      // 0.75, up from 0.22. Two panels running called hero-distance hulls
      // "flat cardboard": the welded courses exist, but at 0.22 their
      // seams cast no shadow and the surface only described itself in
      // albedo. Relief is what catches a key light moving across a hull.
      normalScale: new THREE.Vector2(0.75, 0.75),
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
    if (trim) {
      // A FACTION-TINTED FLOOR ON THE TRIM.
      //
      // The key and rim in this scene are both cool, so a warm livery
      // has almost no light of its own colour to reflect: UTEF's gold
      // superstructure measured (20,21,21) -- black -- at battle range
      // while Frowny's pale trim stayed clearly visible, and the red
      // navy's hull ended up reading COOLER than the blue navy's. A
      // livery that only works for half the colour wheel is not a
      // livery. This gives trim a little of its own colour that no
      // lighting can take away, without turning it into a lamp.
      // Keep the plate map on the emissive so the floor follows the
      // plating instead of flooding the whole part. At 0.26 with no map
      // the trim went flat plastic gold and lost every panel line under
      // it -- the exact toy-ship look this pipeline exists to avoid.
      m.emissive = new THREE.Color(hex);
      m.emissiveIntensity = 0.14;
      m.needsUpdate = true;
    }
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

  // EVERYTHING IN THE TOP OF THE CANVAS.
  //
  // Only the upper part of the flank panel is ever on visible hull: the
  // section is a diamond and the camera sits above the plane of battle,
  // so the ship occludes the panel's lower half. Content drawn below
  // about 60% of canvas height is simply never seen -- which is why a
  // reviewer measured, correctly, that the faction stripe "does not
  // exist anywhere" when it was being drawn every frame.
  const W = 1024, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;

  const no = (hullNo || '00').slice(0, 4);
  const label = (shipName || 'UNNAMED').toUpperCase();
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';

  // The number: the hero mark, in the faction primary. No backing card —
  // it rendered darker than the hull, flattened the plating inside its
  // bounds, and stopped at the last digit, so the name sat outside it
  // and the two read as unrelated stickers.
  g.font = '800 132px Arial, Helvetica, sans-serif';
  const nw = g.measureText(no).width;
  const BASE = H * 0.48;
  g.fillStyle = primary;
  g.fillText(no, 26, BASE);

  // The name, on the SAME BASELINE, sized to whatever room is left.
  let size = 62;
  g.font = `700 ${size}px Arial, Helvetica, sans-serif`;
  const room = W - nw - 90;
  while (g.measureText(label).width > room && size > 22) {
    size -= 2;
    g.font = `700 ${size}px Arial, Helvetica, sans-serif`;
  }
  g.fillStyle = secondary;
  g.fillText(label, nw + 56, BASE);

  // ONE painted stripe under both marks, so they read as a single block,
  // with the band below it. Both sit inside the visible upper band.
  g.fillStyle = primary;
  g.fillRect(20, H * 0.58, W * 0.94, 7);
  g.fillStyle = secondary;
  g.fillRect(20, H * 0.64, W * 0.94, 16);

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
    // A HAIR of bias, not a crowbar. At -4/-4 a quad buried inside the
    // hull still won the depth test and drew over the plating, so a
    // placement bug rendered as a floating card instead of as nothing --
    // hiding the real fault for several rounds. Small enough now that
    // anything genuinely inside the hull stays hidden.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    depthWrite: false,
  });
  decalCache.set(key, m);
  return m;
}

const stripeCache = new Map<string, THREE.MeshStandardMaterial>();

/**
 * The empire's stripe: a long band of the SECONDARY colour with a
 * keyline of the primary, run down the length of the hull.
 *
 * The secondary had no job. It tinted trim and drew the name, both of
 * which are small or dark at battle range, so a viewer never actually
 * saw the second colour of a two-tone livery. A stripe is what the
 * references all use for exactly this: a long, simple shape that reads
 * as ownership from further away than any glyph.
 */
export function stripeMaterial(primary: string, secondary: string): THREE.MeshStandardMaterial {
  const key = `${primary}|${secondary}`;
  const hit = stripeCache.get(key);
  if (hit) return hit;
  const W = 16, H = 64;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  g.fillStyle = secondary;
  g.fillRect(0, H * 0.3, W, H * 0.4);
  g.fillStyle = primary;
  g.fillRect(0, H * 0.24, W, H * 0.07);
  g.fillRect(0, H * 0.69, W, H * 0.07);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshStandardMaterial({
    map: tex, transparent: true, roughness: 0.7, metalness: 0.15,
    // The stripe is the ship's SIDE BADGE, and at 0.12 emissive it went
    // dark the moment a hull was in shadow or at range -- a reviewer
    // scored side identity 1/10 with "I cannot point at one ship and say
    // mine". The livery band now GLOWS in the faction colour, the way
    // running lights do, so whose ship this is survives distance,
    // shadow, and the planet's night side.
    emissiveMap: tex, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.85,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    depthWrite: false,
  });
  stripeCache.set(key, m);
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
  stripe?: THREE.MeshStandardMaterial,
): void {
  // The flank IS a vertical wall, and always was.
  //
  // slab() rotates its four-sided section by 45 degrees, which turns the
  // diamond into an AXIS-ALIGNED RECTANGLE: flat vertical sides at the
  // beam, flat deck and keel. I spent several rounds building panels on
  // an imagined sloping facet to explain markings that would not sit on
  // the hull, when the only fault was that hullProfile understated the
  // beam by 29% and everything was being placed inside the ship. With
  // the profile measured off the mesh, a plain vertical quad a hair
  // outside the beam lies exactly on the plating.
  const z = halfBeam + 0.0015;
  const h = halfHeight * 1.05;
  const w = h * 4;                        // the decal canvas is 1024x256
  for (const side of [1, -1]) {
    if (stripe) {
      // A long band down most of the hull, high on the flank. This is
      // the empire's colour doing the job glyphs cannot: reading as
      // ownership from further away than any lettering.
      // Short, and kept AFT. halfBeam is the hull's widest point, so a
      // stripe run the full length carries that width forward into the
      // prow taper and lifts off the plating as the hull narrows under
      // it -- a band hovering over the bow. The parallel-sided middle
      // is the only place a flat quad can lie flush.
      const sp = new THREE.Mesh(
        new THREE.PlaneGeometry(0.42, halfHeight * 0.22), stripe);
      sp.position.set(-0.16, halfHeight * 0.5, side * z);
      if (side < 0) sp.rotation.y = Math.PI;
      sp.renderOrder = 2;
      mesh.add(sp);
    }
    const q = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    q.position.set(-0.14, -halfHeight * 0.2, side * z);
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
    // Two incommensurate sines: the single-sine version cycled visibly
    // every second and the motion review called it "a repeating emitter,
    // not a burning ship". Beat frequencies never quite repeat.
    const f = 0.62 + 0.38 * (0.6 * Math.sin(phase * 0.006 + i * 2.1)
      + 0.4 * Math.sin(phase * 0.0163 + i * 1.7));
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
