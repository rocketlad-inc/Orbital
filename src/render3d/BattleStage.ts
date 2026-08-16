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
  const stationOf = (bodyId: string | undefined, id: string) => {
    const c = (bodyId && worldPos.get(bodyId)) || new THREE.Vector3();
    const r = (bodyId && worldR.get(bodyId)) || ANCHOR_R;
    const a = seatOf.get(id) ?? 0;
    const lane = (hashStr(id) % 3) * 6;
    const ring = r + GUARD + lane;
    // Orbits are inclined per hull so a fleet is a cloud, not a ring of
    // beads on a table.
    const inc = (((hashStr(id + 'i') % 1000) / 1000) - 0.5) * 0.5;
    return new THREE.Vector3(
      c.x + Math.cos(a) * ring,
      c.y + Math.sin(inc) * ring * 0.55,
      c.z + Math.sin(a) * ring,
    );
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
      // Prograde: the nose follows the orbit, guns traverse, hulls do not.
      const a = seatOf.get(id) ?? 0;
      m.lookAt(p.x - Math.sin(a) * 10, p.y, p.z + Math.cos(a) * 10);
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

  // ---- camera ----------------------------------------------------------
  function aimCamera(i: number, t: number, beat: Beat) {
    // Frame the world that is under fire, from a low three-quarter angle
    // so the planet fills one side and the fight reads against it.
    let hot = anchor.id;
    let most = -1;
    for (const [bid, slot] of beat.at) {
      if (slot.shots.length > most) { most = slot.shots.length; hot = bid; }
    }
    const c = worldPos.get(hot) ?? new THREE.Vector3();
    const r = worldR.get(hot) ?? ANCHOR_R;
    const shots = most > 0 ? most : 0;
    // Heat pushes in.
    const dist = r * (5.4 - Math.min(1, shots / 18) * 1.5);
    const swing = (i * 0.37 + t * 0.37) * 0.55;
    camera.position.set(
      c.x + Math.cos(swing) * dist,
      c.y + r * 1.15,
      c.z + Math.sin(swing) * dist,
    );
    camera.lookAt(c.x, c.y, c.z);
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
