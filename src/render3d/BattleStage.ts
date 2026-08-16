// ============================================================
// The cinematic view: a battle recap rendered as a scene in space.
//
// Same record as the canvas recap, different renderer. Nothing here is
// invented — every hull, shot, hit and death comes off the same theatre
// payload the 2D view plays back — but the camera is inside the fight
// rather than above it.
//
// STAGING, NOT SIMULATION. Distances are compressed hard. True scale in
// a planetary system is a few specks against a great deal of nothing,
// which is honest and unwatchable; the geography is kept truthful —
// which world, which side of it, who crossed from where — and the
// separation between hulls is squeezed until a fight fills a frame.
// That is the same trade every space film makes.
//
// The planet texture is the game's own, seeded on the same body id, so
// the world keeps its palette and character. It is painted as a
// face-on disc rather than an equirectangular map, so wrapped onto a
// sphere the continents land differently than they do on the 2D map —
// the same world, not the same projection.
// ============================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { getPlanetTexture, hashStr, mulberry32 } from '../render/planetTexture';
import { hullGeometry, HULL_LENGTH } from './hullGeometry';
import { toRenderBody } from '../multiplayer/bodyIdentity';
import type { TheatreDetail } from '../multiplayer/TheatreRecap';
import type { ShipIconClass, ShipIconVariant } from '../components/ShipIcons';
import type { Body } from '../types';

const NEUTRAL = '#8a9fb3';
/** Ticks are played at the same rate as the canvas recap. */
export const TICK_MS = 2200;
const LAUNCH_SPREAD = 0.34, FLIGHT_FRAC = 0.28;
/** When in a beat a kill lands — must match the 2D recap. */
const KILL_AT = (LAUNCH_SPREAD / 2 + FLIGHT_FRAC) * TICK_MS;
const FIREBALL_MS = 900;
const WRECK_MS = 9 * TICK_MS;

/** World units. The anchor world is the yardstick for everything. */
const ANCHOR_R = 30;
/** How far off a world its combatants hold. Compressed, deliberately. */
const GUARD = 13;
/** Half the gap between two opposing battle lines. */
const GAP_HALF = 78;

const ICON_CLASSES = ['corvette', 'frigate', 'destroyer', 'freighter', 'colony'];
const iconClassOf = (c: string | null): ShipIconClass =>
  (ICON_CLASSES.includes((c ?? '').toLowerCase())
    ? (c as string).toLowerCase() : 'corvette') as ShipIconClass;

interface Hull {
  fid: string | null; cls: string | null; name: string | null;
  kind: string; variant: ShipIconVariant; diedTick: number | null;
}
interface Beat {
  tick: number;
  at: Map<string, { roster: any[]; shots: any[] }>;
  where: Map<string, string>;
}

export interface Stage {
  setPos(pos: number): void;
  render(): void;
  resize(w: number, h: number): void;
  beats: number;
  dispose(): void;
  /** Diagnostics for the review harness. */
  stats(): Record<string, number>;
}

/**
 * The evenly-lit middle of a painted world, as a wrappable surface.
 *
 * The game paints a planet as a face-on DISC, with the limb darkening
 * and the terminator baked into the art. Wrapped onto a sphere that
 * baked shading becomes horizontal bands, and a second lighting model
 * fights the real one. Cropping to the centre of the disc throws the
 * baked lighting away and keeps the surface: the same seed, the same
 * palette, the same continents, now lit by the scene's own star.
 */
function surfaceOf(disc: HTMLCanvasElement): HTMLCanvasElement {
  const s = disc.width;
  const keep = Math.round(s * 0.78);
  const off = document.createElement('canvas');
  off.width = keep * 2;
  off.height = keep;
  const g = off.getContext('2d')!;
  const x0 = Math.round((s - keep) / 2), y0 = Math.round((s - keep) / 2);
  // Twice around, mirrored on the second pass, so the seam where the
  // texture meets itself falls on matching pixels instead of a hard cut.
  g.drawImage(disc, x0, y0, keep, keep, 0, 0, keep, keep);
  g.save();
  g.translate(keep * 2, 0);
  g.scale(-1, 1);
  g.drawImage(disc, x0, y0, keep, keep, 0, 0, keep, keep);
  g.restore();
  return off;
}

/** A soft round dot, so a star is a star and not a square. */
function dotTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * A blast, as a gradient rather than a solid.
 *
 * An additive sphere clips to a flat white disc the moment bloom
 * touches it. A hot core falling through amber to nothing keeps its
 * shape at any exposure.
 */
function fireTexture(core = 1): THREE.Texture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, `rgba(255,255,246,${(0.98 * core).toFixed(2)})`);
  gr.addColorStop(0.18, `rgba(255,232,168,${(0.92 * core).toFixed(2)})`);
  gr.addColorStop(0.42, `rgba(255,146,48,${(0.6 * core).toFixed(2)})`);
  gr.addColorStop(0.72, 'rgba(184,54,16,0.18)');
  gr.addColorStop(1, 'rgba(120,26,8,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}


export function createStage(d: TheatreDetail, canvas: HTMLCanvasElement): Stage {
  // ---- record -> beats ------------------------------------------------
  const hulls = new Map<string, Hull>();
  for (const b of d.battles) {
    for (const p of b.participants ?? []) {
      hulls.set(p.ship_id, {
        fid: p.faction_id, cls: p.ship_class, name: p.ship_name,
        kind: p.kind ?? 'ship',
        variant: ((p.icon_variant as ShipIconVariant) ?? 'A'),
        diedTick: p.died_tick,
      });
    }
  }
  const byTick = new Map<number, Beat>();
  for (const b of d.battles) {
    const bid = b.body_id ? (b.body_id.split(':').pop() ?? b.body_id) : '';
    for (const f of b.frames ?? []) {
      let beat = byTick.get(f.tick);
      if (!beat) { beat = { tick: f.tick, at: new Map(), where: new Map() }; byTick.set(f.tick, beat); }
      beat.at.set(bid, { roster: f.roster ?? [], shots: f.shot_log ?? [] });
      for (const r of f.roster ?? []) beat.where.set(r.id, bid);
    }
  }
  const beats = [...byTick.values()].sort((a, b) => a.tick - b.tick);

  // Worlds that were actually fought over, as in the 2D view.
  const fought = new Set<string>();
  for (const b of d.battles) {
    if (b.body_id) fought.add(b.body_id.split(':').pop() ?? b.body_id);
  }
  const anchorBare = (d.theatre.anchor_body_id ?? '').split(':').pop() ?? '';
  const bodies = d.bodies.map(b => toRenderBody(b))
    .filter(b => fought.has(b.id) || b.id === anchorBare);

  const colorOf = (fid: string | null) =>
    (fid && d.factions[fid]?.color) || NEUTRAL;

  // ---- scene ----------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, preserveDrawingBuffer: true,
  });
  renderer.setClearColor(0x000000, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.82;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.5, 6000);

  // The star. One hard key from a long way off, which is what makes
  // space read as space: a bright side, a black side, no soft wrap.
  const star = new THREE.DirectionalLight(0xffeede, 1.15);
  star.position.set(-320, 130, 220);
  scene.add(star);
  scene.add(new THREE.AmbientLight(0x2a4160, 0.55));
  // A dim bounce so the unlit side is not a silhouette-shaped hole.
  const bounce = new THREE.DirectionalLight(0x3d6a99, 0.45);
  bounce.position.set(260, -80, -180);
  scene.add(bounce);

  // ---- starfield ------------------------------------------------------
  {
    const n = 2200;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const rnd = mulberry32(0xbeef);
    for (let i = 0; i < n; i++) {
      // On a far shell, so the field has parallax against the action.
      const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1), R = 2600;
      pos[i * 3] = Math.sin(ph) * Math.cos(th) * R;
      pos[i * 3 + 1] = Math.cos(ph) * R;
      pos[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * R;
      // Stars are not all the same white; a little temperature spread
      // stops the field reading as uniform dust.
      const t = rnd(), warm = t > 0.75, cool = t < 0.2;
      const b = 0.5 + rnd() * rnd() * 0.9;
      col[i * 3] = b * (warm ? 1 : cool ? 0.75 : 0.95);
      col[i * 3 + 1] = b * 0.92;
      col[i * 3 + 2] = b * (cool ? 1 : warm ? 0.78 : 0.95);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({
      size: 3.4, sizeAttenuation: false, vertexColors: true,
      transparent: true, depthWrite: false, map: dotTexture(),
      alphaTest: 0.02,
    })));
  }

  // ---- worlds ---------------------------------------------------------
  const anchor = bodies.find(b => b.id === anchorBare) ?? bodies[0];
  const worldPos = new Map<string, THREE.Vector3>();
  const worldR = new Map<string, number>();
  {
    const moons = bodies.filter(b => b.id !== anchor?.id)
      .sort((a, b) => (Number(a.orbitRadius) || 0) - (Number(b.orbitRadius) || 0));
    worldPos.set(anchor.id, new THREE.Vector3(0, 0, 0));
    worldR.set(anchor.id, ANCHOR_R);
    const phase = ((hashStr(anchor?.id ?? 'a') % 1000) / 1000) * Math.PI * 2;
    moons.forEach((m, i) => {
      // Spread for legibility, in true order of distance. Same choice
      // the 2D view makes and for the same reason.
      const ring = ANCHOR_R * (3.1 + i * 2.3);
      const a = phase + i * 2.4;
      worldPos.set(m.id, new THREE.Vector3(
        Math.cos(a) * ring, (i % 2 ? 1 : -1) * ANCHOR_R * 0.45, Math.sin(a) * ring));
      worldR.set(m.id, Math.max(7, ANCHOR_R * 0.3 * (Number(m.radius) || 1) * 0.55));
    });
  }
  for (const b of bodies) {
    const r = worldR.get(b.id)!;
    const tex = getPlanetTexture(b as unknown as Body);
    const map = tex ? new THREE.CanvasTexture(surfaceOf(tex)) : null;
    if (map) {
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = 4;
      map.wrapS = THREE.RepeatWrapping;
    }
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(r, 64, 48),
      new THREE.MeshStandardMaterial({
        map: map ?? undefined,
        color: map ? 0xffffff : new THREE.Color(b.color || '#8899aa'),
        roughness: 1, metalness: 0,
      }),
    );
    mesh.position.copy(worldPos.get(b.id)!);
    mesh.rotation.y = (hashStr(b.id) % 628) / 100;
    scene.add(mesh);
  }

  // ---- hull instances --------------------------------------------------
  const shipMat = new Map<string, THREE.MeshStandardMaterial>();
  const matFor = (hex: string) => {
    let m = shipMat.get(hex);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color: new THREE.Color(hex), metalness: 0.55, roughness: 0.42,
      });
      shipMat.set(hex, m);
    }
    return m;
  };
  const wreckMat = new THREE.MeshStandardMaterial({
    color: 0x6a6154, metalness: 0.75, roughness: 0.62,
    emissive: new THREE.Color(0x1a0d06), emissiveIntensity: 1,
  });

  const shipMeshes = new Map<string, THREE.Mesh>();
  const meshFor = (id: string, h: Hull) => {
    let m = shipMeshes.get(id);
    if (!m) {
      const cls = iconClassOf(h.cls);
      m = new THREE.Mesh(hullGeometry(cls, h.variant), matFor(colorOf(h.fid)));
      const len = HULL_LENGTH[cls] * (h.kind === 'ship' ? 6.2 : 8.5);
      m.scale.setScalar(len);
      scene.add(m);
      shipMeshes.set(id, m);
    }
    return m;
  };

  // ---- transient pools -------------------------------------------------
  const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  const beams: THREE.Mesh[] = [];
  const beamMat = new Map<string, THREE.MeshBasicMaterial>();
  const beamMatFor = (hex: string) => {
    let m = beamMat.get(hex);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        color: new THREE.Color(hex).multiplyScalar(2.4),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      beamMat.set(hex, m);
    }
    return m;
  };
  // Sprites, each with its own material so one blast fading does not
  // fade every other blast on screen with it.
  const flashes: THREE.Sprite[] = [];
  const takeSprite = (n: number) => {
    let s = flashes[n];
    if (!s) {
      s = new THREE.Sprite(flashMat.clone());
      scene.add(s); flashes[n] = s;
    }
    return s;
  };
  const flashMat = new THREE.SpriteMaterial({
    color: 0xfff0d0, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const fireTex = fireTexture();
  const flashTex = fireTexture(0.55);
  // A kill throws real light on everything near it. This is the single
  // thing the 2D view could never do and every reviewer named.
  const killLights = [0, 1, 2].map(() => {
    const l = new THREE.PointLight(0xffa050, 0, 95, 2);
    scene.add(l); return l;
  });

  // ---- composer --------------------------------------------------------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  // Threshold kept high so bloom is reserved for fire and tracers and
  // does not lift the whole frame off black.
  const bloom = new UnrealBloomPass(new THREE.Vector2(1280, 720), 1.15, 0.7, 0.86);
  composer.addPass(bloom);

  function resize(w: number, h: number) {
    const pr = Math.min(2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize(canvas.width || 1280, canvas.height || 720);

  // ---- layout ----------------------------------------------------------
  const seatOf = new Map<string, number>();
  {
    const sides = [...new Set([...hulls.values()].map(h => h.fid ?? 'n'))];
    for (const [id, h] of hulls) {
      const si = Math.max(0, sides.indexOf(h.fid ?? 'n'));
      seatOf.set(id, (si / Math.max(1, sides.length)) * Math.PI * 2
        + ((hashStr(id) % 1000) / 1000 - 0.5) * 1.6);
    }
  }
  // ---- staging ---------------------------------------------------------
  //
  // FLEETS ARE ARRANGED FOR CAMERA, NOT FOR ORBIT.
  //
  // An orbital ring is where the ships actually were, and it is the
  // wrong shape for a film: hulls face along the ring, fire crosses the
  // middle at every angle, and the world being fought over sits off to
  // one side. Two lines facing each other with the planet filling the
  // sky behind them is the shape every space battle ever shot has used,
  // because it puts the enemy, the fire and the stake in one frame.
  //
  // What stays true is the record: who was there, who fired on whom, who
  // died and when. Where a hull sits in its own line is staging.
  const bodyAxes = new Map<string, { W: THREE.Vector3; A: THREE.Vector3; C: THREE.Vector3 }>();
  const axesOf = (bodyId: string | undefined) => {
    const key = bodyId ?? '';
    let ax = bodyAxes.get(key);
    if (!ax) {
      const P = (bodyId && worldPos.get(bodyId)) || new THREE.Vector3();
      const R = (bodyId && worldR.get(bodyId)) || ANCHOR_R;
      // W points away from the planet. The engagement is staged in front
      // of the world, so a camera looking back along W sees the world
      // filling the frame behind the fleets.
      const seed = mulberry32(hashStr(key + ':stage'));
      const th = seed() * Math.PI * 2, ph = (seed() - 0.5) * 0.5;
      const W = new THREE.Vector3(
        Math.cos(th) * Math.cos(ph), Math.sin(ph), Math.sin(th) * Math.cos(ph)).normalize();
      const C = P.clone().add(W.clone().multiplyScalar(R * 2.15));
      // A is the firing axis, laid across the frame so the two lines read
      // left and right of each other rather than one behind the other.
      const A = new THREE.Vector3().crossVectors(W, new THREE.Vector3(0, 1, 0));
      if (A.lengthSq() < 1e-4) A.set(1, 0, 0);
      A.normalize();
      ax = { W, A, C };
      bodyAxes.set(key, ax);
    }
    return ax;
  };

  /** Which line a faction holds, and a hull's place in it. */
  const sideIndex = new Map<string, number>();
  const rankOf = new Map<string, number>();
  {
    const order = [...new Set([...hulls.values()].map(h => h.fid ?? 'n'))];
    const perSide = new Map<number, number>();
    for (const id of [...hulls.keys()].sort()) {
      const si = order.indexOf(hulls.get(id)!.fid ?? 'n');
      sideIndex.set(id, si);
      const n = perSide.get(si) ?? 0;
      rankOf.set(id, n);
      perSide.set(si, n + 1);
    }
  }

  const stationOf = (bodyId: string | undefined, id: string) => {
    const { W, A, C } = axesOf(bodyId);
    const si = sideIndex.get(id) ?? 0;
    const rank = rankOf.get(id) ?? 0;
    const facing = si % 2 === 0 ? -1 : 1;
    const across = new THREE.Vector3().crossVectors(A, W).normalize();
    const row = Math.floor(rank / 5), col = rank % 5;
    const j = mulberry32(hashStr(id + ':pose'));
    // Ranks fall back from the line, files spread across it, and every
    // hull is nudged off its slot so a formation is a formation and not
    // a lattice.
    return C.clone()
      .add(A.clone().multiplyScalar(facing * (GAP_HALF + row * 12 + j() * 7)))
      .add(across.clone().multiplyScalar((col - 2) * 16 + (j() - 0.5) * 8))
      .add(W.clone().multiplyScalar((j() - 0.5) * 30));
  };
  /** A hull's nose points down the line, at the other side. */
  const facingOf = (bodyId: string | undefined, id: string) => {
    const { A } = axesOf(bodyId);
    return A.clone().multiplyScalar((sideIndex.get(id) ?? 0) % 2 === 0 ? 1 : -1);
  };

  let stats = { ships: 0, beams: 0, blasts: 0, wrecks: 0 };

  // ---- playback --------------------------------------------------------
  function setPos(pos: number) {
    const i = Math.max(0, Math.min(beats.length - 1, Math.floor(pos)));
    const t = Math.max(0, Math.min(1, pos - i));
    const beat = beats[i];
    const beatMs = t * TICK_MS;

    for (const m of shipMeshes.values()) m.visible = false;
    for (const b of beams) b.visible = false;
    for (const f of flashes) f.visible = false;
    for (const l of killLights) l.intensity = 0;
    let beamN = 0, flashN = 0, lightN = 0;
    stats = { ships: 0, beams: 0, blasts: 0, wrecks: 0 };

    const posOf = (id: string) => stationOf(beat.where.get(id), id);

    // --- hulls ---
    for (const [id, bodyId] of beat.where) {
      const h = hulls.get(id);
      if (!h) continue;
      const dead = h.diedTick != null && beat.tick >= h.diedTick
        && (beat.tick > h.diedTick || beatMs > KILL_AT);
      const m = meshFor(id, h);
      const p = stationOf(bodyId, id);
      m.position.copy(p);
      // Bows to the enemy: a line of battle points at the other line.
      const nose = facingOf(bodyId, id);
      m.lookAt(p.clone().add(nose.multiplyScalar(20)));
      m.rotateY(Math.PI / 2);
      if (dead) {
        const age = (beat.tick - h.diedTick!) * TICK_MS + (beatMs - KILL_AT);
        if (age >= WRECK_MS) { m.visible = false; continue; }
        m.material = wreckMat;
        m.rotation.x += age / 2600;
        m.rotation.z += age / 3400;
        m.visible = true;
        stats.wrecks++;
      } else {
        m.material = matFor(colorOf(h.fid));
        m.visible = true;
        stats.ships++;
        // Engines. A stern glow and a short plume, sized to the hull.
        const g = takeSprite(flashN++);
        const gm = g.material as THREE.SpriteMaterial;
        gm.map = flashTex;
        gm.color.set(colorOf(h.fid));
        gm.opacity = 0.85;
        gm.needsUpdate = true;
        const len = m.scale.x;
        const back = facingOf(bodyId, id).multiplyScalar(-len * 0.52);
        g.position.copy(p).add(back);
        g.scale.set(len * 0.5, len * 0.5, 1);
        g.visible = true;
      }
    }
    // Wrecks whose hull has dropped out of the roster entirely.
    for (const [id, h] of hulls) {
      if (h.diedTick == null || beat.tick <= h.diedTick) continue;
      if (beat.where.has(id) || h.kind !== 'ship') continue;
      const age = (beat.tick - h.diedTick) * TICK_MS + (beatMs - KILL_AT);
      if (age >= WRECK_MS) continue;
      const m = meshFor(id, h);
      m.material = wreckMat;
      m.position.copy(stationOf(lastSeen.get(id), id));
      m.rotation.set(age / 2600, age / 1900, age / 3400);
      m.visible = true;
      stats.wrecks++;
    }

    // --- fire ---
    for (const [, slot] of beat.at) {
      for (const sh of slot.shots) {
        if (!sh.a || !sh.t) continue;
        const shooter = hulls.get(sh.a);
        if (shooter?.diedTick != null && beat.tick > shooter.diedTick) continue;
        const w = (hashStr(sh.a + sh.t) % 1000) / 1000 * LAUNCH_SPREAD;
        if (t < w) continue;
        const flown = Math.min(1, (t - w) / FLIGHT_FRAC);
        const from = posOf(sh.a), to = posOf(sh.t);
        const head = from.clone().lerp(to, flown);
        const gap = from.distanceTo(to);
        const tail = Math.min(gap * flown, Math.max(6, Math.min(26, gap * 0.3)));
        if (tail < 0.4) continue;
        const dir = to.clone().sub(from).normalize();
        const b = beams[beamN] ?? (() => {
          const mm = new THREE.Mesh(beamGeo, beamMatFor('#ffffff'));
          scene.add(mm); beams.push(mm); return mm;
        })();
        b.material = beamMatFor(colorOf(shooter?.fid ?? null));
        b.position.copy(head.clone().sub(dir.clone().multiplyScalar(tail / 2)));
        b.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        b.scale.set(0.55, tail, 0.55);
        b.visible = true;
        beamN++; stats.beams++;

        // Muzzle and impact as small additive spheres.
        const addFlash = (at: THREE.Vector3, s: number, hot: boolean, a: number) => {
          const f = takeSprite(flashN++);
          const m = f.material as THREE.SpriteMaterial;
          m.map = hot ? fireTex : flashTex;
          m.color.setHex(hot ? 0xffffff : 0xfff0d0);
          m.opacity = a;
          m.needsUpdate = true;
          f.position.copy(at); f.scale.set(s, s, 1); f.visible = true;
        };
        if (flown < 0.3) {
          addFlash(from, 5 * (1 - flown / 0.3) + 1.6, false, 1 - flown / 0.3);
        }
        if (sh.hit && flown > 0.88) {
          const k = (flown - 0.88) / 0.12;
          addFlash(to, 4 + 7 * k, false, 1 - k);
        }
      }
    }

    // --- kills ---
    for (const [id, h] of hulls) {
      if (h.diedTick == null || h.diedTick !== beat.tick) continue;
      const since = beatMs - KILL_AT;
      if (since < 0 || since > FIREBALL_MS) continue;
      const k = since / FIREBALL_MS;
      const at = stationOf(beat.where.get(id) ?? lastSeen.get(id), id);
      const f = takeSprite(flashN++);
      const m = f.material as THREE.SpriteMaterial;
      m.map = fireTex;
      m.color.setHex(0xffffff);
      m.opacity = Math.max(0, 1 - k * 1.15);
      m.needsUpdate = true;
      f.position.copy(at);
      const s = 5 + 17 * (1 - (1 - k) * (1 - k));
      f.scale.set(s, s, 1);
      f.visible = true;
      if (lightN < killLights.length) {
        const l = killLights[lightN++];
        l.position.copy(at);
        l.color.setHex(0xffa050);
        l.intensity = 260 * Math.max(0, 1 - k * 1.3);
      }
      stats.blasts++;
    }
    for (let n = beamN; n < beams.length; n++) beams[n].visible = false;
    for (let n = flashN; n < flashes.length; n++) flashes[n].visible = false;

    aimCamera(i, t, beat);
  }

  // Where each hull was last seen, for wrecks off the roster.
  const lastSeen = new Map<string, string>();
  for (const b of beats) for (const [id, bid] of b.where) lastSeen.set(id, bid);

  // ---- the director ----------------------------------------------------
  //
  // A camera that orbits the action is a surveillance camera. This one
  // picks a SHOT for each beat out of what the record says happened, and
  // the shot it prefers is the one with a death in it.
  //
  //   OVER THE SHOULDER  a kill this beat -> sit behind the killer and
  //                      look down its line of fire at the ship it is
  //                      about to destroy, so the explosion happens in
  //                      frame, at the far end of its own tracers.
  //   BROADSIDE          heavy fire, no kill -> both lines across the
  //                      frame with the world filling the sky behind.
  //   LOW PASS           a lull -> a hull crossing frame, close, with
  //                      the planet turning behind it.
  function aimCamera(i: number, t: number, beat: Beat) {
    // Which world this beat belongs to, and its staging frame.
    let hot = anchor.id, most = -1;
    for (const [bid, slot] of beat.at) {
      if (slot.shots.length > most) { most = slot.shots.length; hot = bid; }
    }
    const { W, A, C } = axesOf(hot);
    const P = worldPos.get(hot) ?? new THREE.Vector3();
    const R = worldR.get(hot) ?? ANCHOR_R;
    const up = new THREE.Vector3().crossVectors(A, W).normalize();

    // The killing shot, if there was one.
    let duel: { a: string; t: string } | null = null;
    for (const [, slot] of beat.at) {
      for (const sh of slot.shots) {
        if (sh.kill && sh.a && sh.t) { duel = { a: sh.a, t: sh.t }; break; }
      }
      if (duel) break;
    }

    if (duel) {
      // OVER THE SHOULDER. Tuck in behind the shooter's quarter, look
      // past it at the target. The lens tightens as the round flies so
      // the kill lands at the end of a push, not on a static hold.
      const from = stationOf(beat.where.get(duel.a) ?? hot, duel.a);
      const to = stationOf(beat.where.get(duel.t) ?? hot, duel.t);
      const dir = to.clone().sub(from).normalize();
      const side = new THREE.Vector3().crossVectors(dir, up).normalize();
      const back = 16 + 10 * (1 - t);
      camera.position.copy(from)
        .add(dir.clone().multiplyScalar(-back))
        .add(side.multiplyScalar(7.5))
        .add(up.clone().multiplyScalar(4.5));
      // Aim slightly past the victim so the shooter sits low in frame
      // and the target has room to blow up into.
      camera.lookAt(to.clone().add(up.clone().multiplyScalar(1.5)));
      camera.fov = 42 - 9 * t;
      camera.updateProjectionMatrix();
      return;
    }

    if (most >= 3) {
      // BROADSIDE. Camera outside the engagement looking back along W,
      // which puts both lines across the frame and the world behind
      // them, filling the sky.
      const drift = (i * 0.21 + t * 0.21);
      const dist = R * 2.4 + 190;
      camera.position.copy(C)
        .add(W.clone().multiplyScalar(dist))
        .add(A.clone().multiplyScalar(Math.sin(drift) * 55))
        .add(up.clone().multiplyScalar(26 + Math.cos(drift) * 14));
      // Look between the lines, a touch toward the planet, so the world
      // sits behind the fire rather than under it.
      camera.lookAt(C.clone().add(W.clone().multiplyScalar(-R * 0.35)));
      camera.fov = 40;
      camera.updateProjectionMatrix();
      return;
    }

    // LOW PASS. Something close and moving, with the world behind it.
    const ids = [...beat.where.keys()];
    const pick = ids.length
      ? stationOf(beat.where.get(ids[i % ids.length]), ids[i % ids.length])
      : C.clone();
    const ang = i * 0.5 + t * 0.5;
    camera.position.copy(pick)
      .add(A.clone().multiplyScalar(Math.cos(ang) * 46))
      .add(up.clone().multiplyScalar(11))
      .add(W.clone().multiplyScalar(Math.sin(ang) * 30 + 34));
    camera.lookAt(P.clone().lerp(pick, 0.72));
    camera.fov = 46;
    camera.updateProjectionMatrix();
  }

  return {
    beats: beats.length,
    setPos,
    render: () => composer.render(),
    resize,
    stats: () => ({ ...stats }),
    dispose: () => {
      renderer.dispose();
      composer.dispose();
    },
  };
}
