// ============================================================
// The cinematic view: a battle recap as a scene in space.
//
// Same record the canvas recap plays back — every hull, shot, hit and
// death comes off the theatre payload — but the camera is inside the
// fight instead of above it.
//
// Three rules this file is built on, each learned the hard way:
//
//   STAGE FOR CAMERA, KEEP THE RECORD TRUE. Fleets are two lines facing
//   each other with the world behind them, not rings around a body. An
//   orbital ring is where the ships were and the wrong shape for a
//   film. Who was there, who fired on whom and who died is the record;
//   where a hull sits inside its own line is staging.
//
//   PICK SHOTS, DO NOT ORBIT. A camera circling the action is a
//   surveillance camera. This one chooses a shot per beat out of what
//   happened, and prefers the one with a death in it.
//
//   ONE PLACE PER THING. Effects live in fx3d, hulls in hullGeometry,
//   worlds in planetSphere. An earlier cut of this file grew its own
//   copies of all three, and those copies were the versions reviewers
//   panned while the good ones sat unused beside them.
//
// Timing constants are deliberately shared with the 2D recap so the two
// views can never disagree about when a ship died.
// ============================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { hashStr, mulberry32 } from '../render/planetTexture';
import { shipGeometry, engineBells } from './shipModel';
import { makeWorld } from './planetSphere';
import {
  Billboards, Tracers, drawBlast, drawPlume, platedHullMaterial,
  wreckMaterial, spaceEnv, glowTex,
} from './fx3d';
import { toRenderBody } from '../multiplayer/bodyIdentity';
import type { TheatreDetail } from '../multiplayer/TheatreRecap';
import type { ShipIconClass, ShipIconVariant } from '../components/ShipIcons';

const NEUTRAL = '#8a9fb3';
export const TICK_MS = 2200;
const LAUNCH_SPREAD = 0.34, FLIGHT_FRAC = 0.28;
/** When in a beat a kill lands. Must match the canvas recap. */
const KILL_AT = (LAUNCH_SPREAD / 2 + FLIGHT_FRAC) * TICK_MS;
const FIREBALL_MS = 900;
const WRECK_MS = 9 * TICK_MS;

const ANCHOR_R = 30;
/** Half the gap between two opposing lines of battle. */
const GAP_HALF = 74;

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
  stats(): Record<string, number>;
}

export function createStage(d: TheatreDetail, canvas: HTMLCanvasElement): Stage {
  // ---- record -> beats -------------------------------------------------
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
  const fought = new Set<string>();
  for (const b of d.battles) {
    const bid = b.body_id ? (b.body_id.split(':').pop() ?? b.body_id) : '';
    if (bid) fought.add(bid);
    for (const f of b.frames ?? []) {
      let beat = byTick.get(f.tick);
      if (!beat) {
        beat = { tick: f.tick, at: new Map(), where: new Map() };
        byTick.set(f.tick, beat);
      }
      beat.at.set(bid, { roster: f.roster ?? [], shots: f.shot_log ?? [] });
      for (const r of f.roster ?? []) beat.where.set(r.id, bid);
    }
  }
  const beats = [...byTick.values()].sort((a, b) => a.tick - b.tick);
  const lastSeen = new Map<string, string>();
  for (const b of beats) for (const [id, bid] of b.where) lastSeen.set(id, bid);

  const anchorBare = (d.theatre.anchor_body_id ?? '').split(':').pop() ?? '';
  const bodies = d.bodies.map(b => toRenderBody(b))
    .filter(b => fought.has(b.id) || b.id === anchorBare);
  const colorOf = (fid: string | null) => (fid && d.factions[fid]?.color) || NEUTRAL;

  // ---- scene -----------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, preserveDrawingBuffer: true,
  });
  renderer.setClearColor(0x010204, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.86;

  const scene = new THREE.Scene();
  scene.environment = spaceEnv(renderer);
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 9000);

  // One star, fixed in world space, so the sun never appears to move
  // between shots. A cool fill and a warm-dark ambient keep the shadow
  // side readable: an unlit hull that matches the void is a hole, not a
  // silhouette, and matching it in HUE is what made ships disappear.
  const STAR_DIR = new THREE.Vector3(-1, 0.42, 0.72).normalize();
  const star = new THREE.DirectionalLight(0xf6f4f0, 2.8);
  star.position.copy(STAR_DIR).multiplyScalar(600);
  scene.add(star);
  const fill = new THREE.DirectionalLight(0x4a6d99, 0.55);
  fill.position.set(400, -160, -320);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight(0x9fb6d8, 0x30201a, 0.5));

  // ---- starfield -------------------------------------------------------
  {
    const n = 2600;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const rnd = mulberry32(0xbeef);
    for (let i = 0; i < n; i++) {
      const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1), R = 3400;
      pos[i * 3] = Math.sin(ph) * Math.cos(th) * R;
      pos[i * 3 + 1] = Math.cos(ph) * R;
      pos[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * R;
      const t = rnd(), b = 0.35 + rnd() * rnd() * 1.1;
      col[i * 3] = b * (t > 0.78 ? 1 : t < 0.22 ? 0.72 : 0.93);
      col[i * 3 + 1] = b * 0.9;
      col[i * 3 + 2] = b * (t < 0.22 ? 1 : t > 0.78 ? 0.74 : 0.93);
      size[i] = 1 + rnd() * rnd() * 3.4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    // Magnitude and colour-temperature variation: a field of identical
    // dots reads as dust on the lens rather than as depth.
    scene.add(new THREE.Points(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexColors: true,
      uniforms: { uMap: { value: glowTex() } },
      vertexShader: `
        attribute float aSize; varying vec3 vC;
        void main() {
          vC = color;
          gl_PointSize = aSize * 2.2;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D uMap; varying vec3 vC;
        void main() {
          float a = texture2D(uMap, gl_PointCoord).a;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vC, a);
        }`,
    })));
  }

  // ---- worlds ----------------------------------------------------------
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
      const ring = ANCHOR_R * (3.4 + i * 2.4);
      const a = phase + i * 2.4;
      worldPos.set(m.id, new THREE.Vector3(
        Math.cos(a) * ring, (i % 2 ? 1 : -1) * ANCHOR_R * 0.5, Math.sin(a) * ring));
      worldR.set(m.id, Math.max(8, ANCHOR_R * 0.34 * (Number(m.radius) || 1) * 0.6));
    });
  }
  for (const b of bodies) {
    const w = makeWorld(b.id, b.color || '#b06a3f', worldR.get(b.id)!,
      /ice|ocean|terran/.test(b.type));
    w.position.copy(worldPos.get(b.id)!);
    w.rotation.y = (hashStr(b.id) % 628) / 100;
    w.rotation.z = 0.24;
    scene.add(w);
  }

  // ---- staging ---------------------------------------------------------
  const bodyAxes = new Map<string, { W: THREE.Vector3; A: THREE.Vector3; C: THREE.Vector3 }>();
  const axesOf = (bodyId: string | undefined) => {
    const key = bodyId ?? '';
    let ax = bodyAxes.get(key);
    if (!ax) {
      const P = (bodyId && worldPos.get(bodyId)) || new THREE.Vector3();
      const R = (bodyId && worldR.get(bodyId)) || ANCHOR_R;
      const seed = mulberry32(hashStr(key + ':stage'));
      const th = seed() * Math.PI * 2, ph = (seed() - 0.5) * 0.4;
      // W points away from the world. The engagement is staged in front
      // of it, so a camera outside looking back sees fleets against a
      // planet filling the sky. Kept close: the whole point is for the
      // world to overtake the background.
      const Wv = new THREE.Vector3(
        Math.cos(th) * Math.cos(ph), Math.sin(ph), Math.sin(th) * Math.cos(ph)).normalize();
      const C = P.clone().add(Wv.clone().multiplyScalar(R * 1.5));
      const A = new THREE.Vector3().crossVectors(Wv, new THREE.Vector3(0, 1, 0));
      if (A.lengthSq() < 1e-4) A.set(1, 0, 0);
      A.normalize();
      ax = { W: Wv, A, C };
      bodyAxes.set(key, ax);
    }
    return ax;
  };

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
    const { W: Wv, A, C } = axesOf(bodyId);
    const si = sideIndex.get(id) ?? 0;
    const rank = rankOf.get(id) ?? 0;
    const facing = si % 2 === 0 ? -1 : 1;
    const across = new THREE.Vector3().crossVectors(A, Wv).normalize();
    const row = Math.floor(rank / 5), col = rank % 5;
    const j = mulberry32(hashStr(id + ':pose'));
    // Ranks fall back from the line, files spread across it, every hull
    // nudged off its slot so a formation is a formation, not a lattice.
    const p = C.clone()
      .add(A.clone().multiplyScalar(facing * (GAP_HALF + row * 13 + j() * 8)))
      .add(across.clone().multiplyScalar((col - 2) * 17 + (j() - 0.5) * 9))
      .add(Wv.clone().multiplyScalar((j() - 0.5) * 32));
    // NO STATION INSIDE A WORLD. A moon's line runs along an axis chosen
    // without regard to the anchor planet a hundred units away, so the
    // far end of the line could land inside it.
    for (const [wid, wc] of worldPos) {
      const wr = (worldR.get(wid) ?? 0) * 1.3;
      const d = p.distanceTo(wc);
      if (d < wr) {
        const out = d < 1e-3 ? Wv.clone() : p.clone().sub(wc).normalize();
        p.copy(wc).add(out.multiplyScalar(wr + 4));
      }
    }
    return p;
  };
  const facingOf = (bodyId: string | undefined, id: string) => {
    const { A } = axesOf(bodyId);
    return A.clone().multiplyScalar((sideIndex.get(id) ?? 0) % 2 === 0 ? 1 : -1);
  };

  // ---- hull instances --------------------------------------------------
  const meshes = new Map<string, THREE.Mesh>();
  const wreckMat = wreckMaterial();
  /** Hull length by class, in world units. */
  const LENGTH: Record<string, number> = {
    corvette: 14, frigate: 19, destroyer: 28, freighter: 21, colony: 24,
  };
  const meshFor = (id: string, h: Hull) => {
    let m = meshes.get(id);
    if (!m) {
      const cls = iconClassOf(h.cls);
      m = new THREE.Mesh(shipGeometry(cls, h.variant), platedHullMaterial(colorOf(h.fid)));
      m.scale.setScalar((LENGTH[cls] ?? 9) * (h.kind === 'ship' ? 1 : 1.3));
      scene.add(m);
      meshes.set(id, m);
    }
    return m;
  };

  const bb = new Billboards(scene);
  const tr = new Tracers(scene);
  // A kill throws real light on what is near it — the one thing the
  // canvas view could never do.
  const killLights = [0, 1].map(() => {
    const l = new THREE.PointLight(0xffa860, 0, 220, 2);
    scene.add(l); return l;
  });

  // ---- composer --------------------------------------------------------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1280, 720), 0.5, 0.65, 0.9);
  composer.addPass(bloom);

  function resize(w: number, h: number) {
    // The composer must be told the same ratio the renderer uses, or the
    // bloom chain samples a sub-rectangle of the frame.
    const pr = Math.min(2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize(canvas.width || 1280, canvas.height || 720);

  let stats = { ships: 0, tracers: 0, blasts: 0, wrecks: 0 };

  // ---- the director ----------------------------------------------------
  function aimCamera(i: number, t: number, beat: Beat) {
    let hot = anchor.id, most = -1;
    for (const [bid, slot] of beat.at) {
      if (slot.shots.length > most) { most = slot.shots.length; hot = bid; }
    }
    const { W: Wv, A, C } = axesOf(hot);
    const P = worldPos.get(hot) ?? new THREE.Vector3();
    const R = worldR.get(hot) ?? ANCHOR_R;
    const up = new THREE.Vector3().crossVectors(A, Wv).normalize();

    let duel: { a: string; t: string } | null = null;
    for (const [, slot] of beat.at) {
      for (const sh of slot.shots) {
        if (sh.kill && sh.a && sh.t) { duel = { a: sh.a, t: sh.t }; break; }
      }
      if (duel) break;
    }

    if (duel) {
      // OVER THE SHOULDER: behind the killer's quarter, looking down its
      // line of fire at the ship it is about to destroy, so the kill
      // lands in frame at the end of its own tracers. The lens tightens
      // as the round flies, so the death is the end of a push.
      const from = stationOf(beat.where.get(duel.a) ?? hot, duel.a);
      const to = stationOf(beat.where.get(duel.t) ?? hot, duel.t);
      const dir = to.clone().sub(from).normalize();
      // Alternate shoulders beat to beat, and put the victim on a third
      // line rather than dead centre -- the same kill parked at (640,370)
      // eight frames running was the reviewers' first note on the camera.
      const hand = i % 2 === 0 ? 1 : -1;
      const side = new THREE.Vector3().crossVectors(dir, up).normalize()
        .multiplyScalar(hand);
      camera.position.copy(from)
        .add(dir.clone().multiplyScalar(-(19 + 11 * (1 - t))))
        .add(side.clone().multiplyScalar(9))
        .add(up.clone().multiplyScalar(5.5));
      camera.lookAt(to.clone()
        .add(side.clone().multiplyScalar(15))
        .add(up.clone().multiplyScalar(4)));
      camera.fov = 44 - 10 * t;
      camera.updateProjectionMatrix();
      return;
    }

    if (most >= 3) {
      // BROADSIDE: outside the engagement looking back along W, both
      // lines across frame, the world filling the sky behind them.
      const drift = i * 0.19 + t * 0.19;
      camera.position.copy(C)
        .add(Wv.clone().multiplyScalar(R * 1.5 + 120))
        .add(A.clone().multiplyScalar(Math.sin(drift) * 48))
        .add(up.clone().multiplyScalar(20 + Math.cos(drift) * 12));
      camera.lookAt(C.clone().add(Wv.clone().multiplyScalar(-R * 0.55)));
      camera.fov = 42;
      camera.updateProjectionMatrix();
      return;
    }

    // LULL: push in on a hull that is about to matter — one that dies
    // within the next couple of ticks — rather than an arbitrary one.
    // Picking any ship is what made the quiet beats look like empty sky.
    let subject: string | null = null;
    for (const [id, h] of hulls) {
      if (h.diedTick != null && h.diedTick >= beat.tick && h.diedTick <= beat.tick + 2
        && beat.where.has(id)) { subject = id; break; }
    }
    if (!subject) {
      const live = [...beat.where.keys()];
      subject = live.length ? live[i % live.length] : null;
    }
    const pick = subject ? stationOf(beat.where.get(subject) ?? hot, subject) : C.clone();
    const ang = i * 1.7 + t * 0.42;
    camera.position.copy(pick)
      .add(A.clone().multiplyScalar(Math.cos(ang) * 17))
      .add(up.clone().multiplyScalar(5))
      .add(Wv.clone().multiplyScalar(Math.sin(ang) * 10 + 15));
    camera.lookAt(pick.clone().lerp(P, 0.06));
    camera.fov = 42;
    camera.updateProjectionMatrix();
  }

  // ---- playback --------------------------------------------------------
  function setPos(pos: number) {
    const i = Math.max(0, Math.min(beats.length - 1, Math.floor(pos)));
    const t = Math.max(0, Math.min(1, pos - i));
    const beat = beats[i];
    const beatMs = t * TICK_MS;
    stats = { ships: 0, tracers: 0, blasts: 0, wrecks: 0 };

    for (const m of meshes.values()) m.visible = false;
    for (const l of killLights) l.intensity = 0;
    bb.begin(); tr.begin();
    let lightN = 0;

    aimCamera(i, t, beat);

    const posOf = (id: string) => stationOf(beat.where.get(id) ?? lastSeen.get(id), id);

    const place = (id: string, h: Hull, bodyId: string | undefined) => {
      const m = meshFor(id, h);
      const p = stationOf(bodyId, id);
      m.position.copy(p);
      const nose = facingOf(bodyId, id);
      m.lookAt(p.clone().add(nose.clone().multiplyScalar(20)));
      m.rotateY(Math.PI / 2);
      return { m, p, nose };
    };

    // --- hulls ---
    for (const [id, bodyId] of beat.where) {
      const h = hulls.get(id);
      if (!h) continue;
      const dying = h.diedTick != null && beat.tick >= h.diedTick
        && (beat.tick > h.diedTick || beatMs > KILL_AT);
      const { m, p, nose } = place(id, h, bodyId);
      if (dying) {
        const age = (beat.tick - h.diedTick!) * TICK_MS + (beatMs - KILL_AT);
        // Gone inside the flash, back as a wreck once the fire clears --
        // an intact black slab parked inside its own fireball was the
        // most-cited artefact of the round.
        if (age >= WRECK_MS || age < FIREBALL_MS * 0.55) { m.visible = false; continue; }
        m.material = wreckMat;
        m.rotation.x += age / 2400;
        m.rotation.z += age / 3100;
        m.visible = true;
        stats.wrecks++;
      } else {
        m.material = platedHullMaterial(colorOf(h.fid));
        m.visible = true;
        stats.ships++;
        // One plume per engine bell, placed by transforming the model's
        // own bell positions into world space -- the geometry knows
        // where its engines are, so nothing has to be guessed.
        const len = m.scale.x;
        const aft = nose.clone().negate();
        m.updateMatrixWorld();
        for (const bell of engineBells(iconClassOf(h.cls))) {
          const at = m.localToWorld(bell.clone());
          drawPlume(tr, bb, at, aft, len * 0.16, colorOf(h.fid), 1, camera);
        }
      }
    }
    // Wrecks whose hull has dropped out of the roster entirely.
    for (const [id, h] of hulls) {
      if (h.diedTick == null || beat.tick <= h.diedTick) continue;
      if (beat.where.has(id) || h.kind !== 'ship') continue;
      const age = (beat.tick - h.diedTick) * TICK_MS + (beatMs - KILL_AT);
      if (age >= WRECK_MS) continue;
      const { m } = place(id, h, lastSeen.get(id));
      m.material = wreckMat;
      m.rotation.set(age / 2400, age / 1800, age / 3100);
      m.visible = true;
      stats.wrecks++;
    }

    // --- fire ---
    for (const [, slot] of beat.at) {
      for (const sh of slot.shots) {
        if (!sh.a || !sh.t) continue;
        const shooter = hulls.get(sh.a);
        if (shooter?.diedTick != null && beat.tick > shooter.diedTick) continue;
        const w = ((hashStr(sh.a + sh.t) % 1000) / 1000) * LAUNCH_SPREAD;
        if (t < w) continue;
        const flown = Math.min(1, (t - w) / FLIGHT_FRAC);
        const from = posOf(sh.a), to = posOf(sh.t);
        const gap = from.distanceTo(to);
        const head = from.clone().lerp(to, flown);
        const tail = Math.min(gap * flown, Math.max(9, Math.min(34, gap * 0.26)));
        if (tail < 0.5) continue;
        const dir = to.clone().sub(from).normalize();
        const col = colorOf(shooter?.fid ?? null);
        tr.put(head.clone().sub(dir.clone().multiplyScalar(tail)), head, 1.4, col, 1, camera);
        // A round has a nose: a hot bloom riding the head so it reads as
        // light rather than as a flat wedge with a chisel end.
        bb.put(glowTex(), head, 2.8, 2.8, 0xfff2dc, 0.75);
        stats.tracers++;
        if (flown < 0.22) bb.put(glowTex(), from, 7, 7, col, (1 - flown / 0.22) * 0.85);
        if (sh.hit && flown > 0.9) {
          const k = (flown - 0.9) / 0.1;
          bb.put(glowTex(), to, 8 + 12 * k, 8 + 12 * k, 0xffd9a8, 1 - k);
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
      const len = (LENGTH[iconClassOf(h.cls)] ?? 9) * (h.kind === 'ship' ? 1 : 1.3);
      drawBlast(bb, at, k, len * 0.62, hashStr(id) % 1000);
      if (lightN < killLights.length) {
        const l = killLights[lightN++];
        l.position.copy(at);
        l.intensity = 420 * Math.max(0, 1 - k * 1.3);
      }
      stats.blasts++;
    }

    bb.end(); tr.end();
  }

  return {
    beats: beats.length,
    setPos,
    render: () => composer.render(),
    resize,
    stats: () => ({ ...stats }),
    dispose: () => { renderer.dispose(); composer.dispose(); },
  };
}
