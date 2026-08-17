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
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { hashStr, mulberry32, terraformBiome } from '../render/planetTexture';
import {
  shipGeometry, engineBells, hullProfile, hullFragments,
} from './shipModel';
import { makeWorld, STAR_DIR, type WorldFace } from './planetSphere';
import {
  Billboards, Tracers, drawBlast, drawImpact, drawPlume, drawHullFire,
  platedHullMaterial, wreckMaterial, spaceEnv, glowTex, flareTex,
  hullDecalMaterial, stripeMaterial, attachLivery,
} from './fx3d';
import { deriveSecondary } from '../game/colorUtils';
import { toRenderBody } from '../multiplayer/bodyIdentity';
import type { TheatreDetail } from '../multiplayer/TheatreRecap';
import type { ShipIconClass, ShipIconVariant } from '../components/ShipIcons';

const NEUTRAL = '#8a9fb3';
/** The core of an energy lance, whoever fired it. */
const ENERGY_CORE = 0xdff4ff;
/**
 * How long an impact flash lives after the round arrives, in units of
 * flight time — about 200ms, which is a flash. Anything longer and the
 * hit reads as the bolt stopping on the hull rather than landing.
 */
// How long an arrival stays on screen, as a fraction of the round's
// flight. Raised from 0.35: at the old value the flash was gone almost as
// soon as it appeared, and all three reviewers of the weapons round
// reported that arrivals simply do not exist -- "nothing flashes on a
// hull, nothing stops short, nothing sparks". The event was real and too
// brief to see.
const IMPACT_TAIL = 0.62;
export const TICK_MS = 2200;
const LAUNCH_SPREAD = 0.34, FLIGHT_FRAC = 0.28;
/** When in a beat a kill lands. Must match the canvas recap. */
const KILL_AT = (LAUNCH_SPREAD / 2 + FLIGHT_FRAC) * TICK_MS;
const FIREBALL_MS = 1500;
/** How long a hull takes to come apart before it is only wreckage. */
const DEATH_MS = 1900;
const WRECK_MS = 9 * TICK_MS;

// Mars fills the sky. Four times its old radius, which is what lets the
// hulls be big without the scale reading as toys: everything is close to
// something enormous, the way the Coruscant plates are staged.
const ANCHOR_R = 120;

/**
 * Hull length by class, in world units. THE SPREAD IS THE POINT.
 *
 * These used to run 14/19/28 — a 2:1 range across the whole navy, which
 * meant a screen of corvettes and a line of destroyers were the same
 * thing at slightly different sizes and the fleet had no hierarchy to
 * read. A destroyer is now four and a half times a corvette, so a
 * corvette is a gnat next to one and the shot composes itself: put the
 * big hull in frame and the small ones give it scale.
 *
 * Everything staged — formation spacing, the gap between the lines, how
 * far the camera stands off — is derived from these rather than tuned
 * beside them, so this table is the one place size is decided.
 */
const LENGTH: Record<string, number> = {
  corvette: 10, frigate: 20, destroyer: 46, freighter: 26, colony: 36,
};
const lengthOf = (cls: string, kind: string) =>
  (LENGTH[cls] ?? 10) * (kind === 'ship' ? 1 : 1.3);
/**
 * How fast the whole engagement carries around the world it is fighting
 * over, in radians per tick.
 *
 * Fleets ORBIT. Parked ships are the single loudest thing wrong with a
 * space battle: nothing reads as fast, nothing reads as committed, and
 * the eye has nothing to track. Everything here is carried around Mars
 * on one arc so the planet slides through frame, hulls hold a prograde
 * heading, and the camera has real motion to sit inside.
 */
const ORBIT_RATE = 0.052;

const ICON_CLASSES = ['corvette', 'frigate', 'destroyer', 'freighter', 'colony'];
const iconClassOf = (c: string | null): ShipIconClass =>
  (ICON_CLASSES.includes((c ?? '').toLowerCase())
    ? (c as string).toLowerCase() : 'corvette') as ShipIconClass;

interface Hull {
  fid: string | null; cls: string | null; name: string | null;
  kind: string; variant: ShipIconVariant; diedTick: number | null;
  /** Carries an armour part, so a landed round spalls off plate. */
  armored?: boolean;
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
        // WHAT THIS SHIP IS PROTECTED BY. `parts` arrives as a JSON
        // string like ["kinetic","energy","shield","armor"]. Shields
        // already had a look and armour had none at all, so an armoured
        // hit was pixel-identical to a bare-hull hit and the "what
        // defended it" question was unanswerable by construction. A
        // substring test is enough and cannot throw on a malformed blob.
        armored: /armor/i.test(String(p.parts ?? '')),
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
  const firstTick = new Map<string, number>();
  for (const b of beats) {
    for (const [id, bid] of b.where) {
      lastSeen.set(id, bid);
      if (!firstTick.has(id)) firstTick.set(id, b.tick);
    }
  }

  const anchorBare = (d.theatre.anchor_body_id ?? '').split(':').pop() ?? '';
  const bodies = d.bodies.map(b => toRenderBody(b))
    .filter(b => fought.has(b.id) || b.id === anchorBare);
  const colorOf = (fid: string | null) => (fid && d.factions[fid]?.color) || NEUTRAL;
  /**
   * The faction's secondary livery, derived exactly as the 2D recap
   * derives it — same field, same fallback. A ship that is maroon and
   * gold on the map has to be maroon and gold in the cinematic, and the
   * only way to guarantee that is to ask the same function.
   */
  const color2Of = (fid: string | null) =>
    (fid && (d.factions[fid]?.color2
      || deriveSecondary(d.factions[fid]?.color || NEUTRAL))) || NEUTRAL;

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
  // Imported, not redeclared: the atmosphere shell needs the same vector
  // and used to keep its own slightly different copy.
  const star = new THREE.DirectionalLight(0xf6f4f0, 2.8);
  star.position.copy(STAR_DIR).multiplyScalar(600);
  scene.add(star);
  // Fill is kept LOW on purpose. Raising it to 0.95 to keep the smaller
  // hulls readable did that, and flattened every ship in the fleet:
  // reviewers read the result as no directional light at all, because a
  // strong fill from the opposite side cancels the key's modelling. The
  // small ships get their readability from a rim instead, which lifts an
  // edge without touching the broad faces the key is shaping.
  const fill = new THREE.DirectionalLight(0x4a6d99, 0.4);
  fill.position.set(400, -160, -320);
  scene.add(fill);
  // Rim, opposite the key: separates a dark hull from the void by
  // drawing its outline rather than by washing it out.
  //
  // HULLS ONLY. A directional light has no falloff, so pointing one
  // back down the key's axis lit the planet's night side as brightly as
  // its day side and erased the terminator -- a reviewer read the ships
  // and the world as being lit by contradictory suns, correctly. Layer
  // 1 carries the rim; worlds stay on layer 0 and never see it.
  const RIM_LAYER = 1;
  const rim = new THREE.DirectionalLight(0xbcd6ff, 1.5);
  rim.position.copy(STAR_DIR).multiplyScalar(-620).setY(180);
  rim.layers.set(RIM_LAYER);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0x9fb6d8, 0x30201a, 0.34));

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
      const ring = ANCHOR_R * (1.9 + i * 0.85);
      const a = phase + i * 2.4;
      worldPos.set(m.id, new THREE.Vector3(
        Math.cos(a) * ring, (i % 2 ? 1 : -1) * ANCHOR_R * 0.28, Math.sin(a) * ring));
      worldR.set(m.id, Math.max(14, ANCHOR_R * 0.13 * (Number(m.radius) || 1) * 0.6));
    });
  }
  /**
   * What face a world wears, from the same rules the map uses.
   *
   * Giants are giants whatever else is true of them. A terraformed body
   * wears its biome; a raw one keeps its cratered rock, which is right
   * for asteroids and dwarfs and was wrong for everything else.
   */
  const faceOf = (b: any): WorldFace => {
    if (b.type === 'gas_giant' || b.type === 'ice_giant') return 'giant';
    const done = b.terraformedAtTick != null;
    if (!done) return 'rock';
    try { return terraformBiome(b as any); } catch { return 'verdant'; }
  };
  for (const b of bodies) {
    const w = makeWorld(b.id, b.color || '#b06a3f', worldR.get(b.id)!,
      /ice|ocean|terran/.test(b.type), faceOf(b));
    w.position.copy(worldPos.get(b.id)!);
    w.rotation.y = (hashStr(b.id) % 628) / 100;
    w.rotation.z = 0.24;
    scene.add(w);
  }

  // ---- staging ---------------------------------------------------------
  const ANCHOR_C = worldPos.get(anchor.id) ?? new THREE.Vector3();
  /** The plane the whole engagement is carried around on. */
  const ORBIT_AXIS = new THREE.Vector3(0.13, 1, 0.07).normalize();
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
      const C = P.clone().add(Wv.clone().multiplyScalar(R * 1.16));
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

  const lenOfId = (id: string) => {
    const h = hulls.get(id);
    return lengthOf(iconClassOf(h?.cls ?? null), h?.kind ?? 'ship');
  };
  const biggest = Math.max(14, ...[...hulls.keys()].map(lenOfId));
  /** Half the gap between the two lines of battle. Knife range. */
  const GAP_HALF = biggest;

  /**
   * The line of battle, laid out ONCE as offsets in the (facing, across,
   * depth) frame, so every body stages the same formation in its own
   * axes and the extent of it can be measured before anything is drawn.
   *
   * Files are packed by the hulls actually in them rather than dropped
   * into a slot sized on the largest ship in the fight. A uniform slot
   * is fine when the whole navy is within 2:1; at 4.6:1 it spaces forty
   * corvettes as though each were a destroyer, and the fleet becomes a
   * scattering of specks with the camera nowhere near any of it.
   *
   * Big hulls form up first and small ones screen ahead of them, which
   * is both what a fleet does and what composes — the eye gets a capital
   * ship with corvettes crossing in front of it for scale.
   */
  const berthOffset = new Map<string, THREE.Vector3>();
  /** How far the formation actually reaches. Every camera works off it. */
  let SPAN = 90;
  {
    const bySide = new Map<number, string[]>();
    for (const id of [...hulls.keys()].sort()) {
      const si = sideIndex.get(id) ?? 0;
      if (!bySide.has(si)) bySide.set(si, []);
      bySide.get(si)!.push(id);
    }
    let far = 0;
    for (const [si, ids] of bySide) {
      const facing = si % 2 === 0 ? -1 : 1;
      const ordered = [...ids].sort((x, y) => lenOfId(y) - lenOfId(x) || (x < y ? -1 : 1));
      // Wide and shallow: a line of battle, not a column of march.
      const perRow = Math.max(3, Math.round(Math.sqrt(ordered.length * 1.8)));
      let depth = 0;
      for (let r0 = 0; r0 < ordered.length; r0 += perRow) {
        const row = ordered.slice(r0, r0 + perRow);
        const lens = row.map(lenOfId);
        const rowMax = Math.max(...lens);
        // Hulls lie along the FACING axis — prograde is the axis the two
        // lines are drawn up on — so abeam they need beam clearance, not
        // length clearance. Spacing on length drew the line out four
        // times wider than it needed to be and the camera had to back
        // off until every corvette was a speck. Ranks, which do stack
        // nose-to-tail, still fall back by a full hull length below.
        const xs: number[] = [];
        let x = 0;
        for (let i = 0; i < row.length; i++) {
          if (i > 0) x += (lens[i - 1] + lens[i]) * 0.33;
          xs.push(x);
        }
        const mid = xs[xs.length - 1] / 2;
        for (let i = 0; i < row.length; i++) {
          const j = mulberry32(hashStr(row[i] + ':pose'));
          const off = new THREE.Vector3(
            facing * (GAP_HALF + depth + j() * rowMax * 0.3),
            xs[i] - mid + (j() - 0.5) * lens[i] * 0.22,
            (j() - 0.5) * rowMax * 1.6);
          berthOffset.set(row[i], off);
          far = Math.max(far, Math.hypot(off.x, off.y));
        }
        depth += rowMax * 1.5;
      }
    }
    SPAN = Math.max(60, far);
  }

  /** Where a hull sits before the orbit carries it anywhere. */
  const berthOf = (bodyId: string | undefined, id: string) => {
    const { W: Wv, A, C } = axesOf(bodyId);
    const across = new THREE.Vector3().crossVectors(A, Wv).normalize();
    const o = berthOffset.get(id) ?? new THREE.Vector3();
    const p = C.clone()
      .add(A.clone().multiplyScalar(o.x))
      .add(across.clone().multiplyScalar(o.y))
      .add(Wv.clone().multiplyScalar(o.z));
    for (const [wid, wc] of worldPos) {
      const wr = (worldR.get(wid) ?? 0) * 1.06;
      const d = p.distanceTo(wc);
      if (d < wr) {
        const out = d < 1e-3 ? Wv.clone() : p.clone().sub(wc).normalize();
        p.copy(wc).add(out.multiplyScalar(wr + biggest * 0.6));
      }
    }
    return p;
  };

  /** Carry a point around the anchor world on the battle's own arc. */
  const orbit = (p: THREE.Vector3, pos: number) => {
    const q = p.clone().sub(ANCHOR_C);
    q.applyAxisAngle(ORBIT_AXIS, pos * ORBIT_RATE);
    return q.add(ANCHOR_C);
  };
  const stationOf = (bodyId: string | undefined, id: string, pos: number) =>
    orbit(berthOf(bodyId, id), pos);

  /**
   * Prograde. Hulls hold the heading their orbit gives them and do NOT
   * turn to face what they are shooting: guns traverse, ships do not.
   * Taken as the tangent to the arc the hull is actually travelling.
   */
  const facingOf = (bodyId: string | undefined, id: string, pos: number) => {
    const a = stationOf(bodyId, id, pos);
    const b = stationOf(bodyId, id, pos + 0.05);
    const d = b.sub(a);
    return d.lengthSq() < 1e-8 ? new THREE.Vector3(1, 0, 0) : d.normalize();
  };

  // ---- hull instances --------------------------------------------------
  const meshes = new Map<string, THREE.Mesh>();
  const wreckMat = wreckMaterial();
  const meshFor = (id: string, h: Hull) => {
    let m = meshes.get(id);
    if (!m) {
      const cls = iconClassOf(h.cls);
      // Structure in the primary, trim in the secondary livery -- the
      // two material slots the geometry's groups were built for.
      m = new THREE.Mesh(shipGeometry(cls, h.variant), [
        platedHullMaterial(colorOf(h.fid), h.variant),
        platedHullMaterial(color2Of(h.fid), h.variant, true),
      ]);
      m.scale.setScalar(lengthOf(cls, h.kind));
      // LIVERY. Warships only: a station or a city is not a ship of the
      // line and should not be wearing a pennant number.
      if (h.kind === 'ship') {
        const prof = hullProfile(cls, h.variant);
        // A pennant number the record does not carry, derived from the
        // hull id so it is stable for the life of the ship and never
        // collides with its neighbour in the line.
        const no = String(100 + (hashStr(id) % 900));
        attachLivery(m, prof.halfBeam, prof.halfHeight,
          hullDecalMaterial(h.name ?? '', colorOf(h.fid), color2Of(h.fid), no),
          stripeMaterial(colorOf(h.fid), color2Of(h.fid)));
      }
      // Hulls take the rim as well as the key; worlds take only the key.
      m.layers.enable(RIM_LAYER);
      scene.add(m);
      meshes.set(id, m);
    }
    return m;
  };

  /**
   * The pieces a dead hull comes apart into.
   *
   * One group per wreck, holding the fragments at the offsets they had
   * on the intact ship. The group takes the ship's transform, so the
   * wreck inherits its heading and its drift for free; each piece then
   * tumbles and separates in the group's own local space.
   */
  const wrecks = new Map<string, THREE.Group>();
  const wreckGroupFor = (id: string, h: Hull) => {
    let grp = wrecks.get(id);
    if (!grp) {
      const cls = iconClassOf(h.cls);
      grp = new THREE.Group();
      for (const f of hullFragments(cls, h.variant, 3)) {
        const piece = new THREE.Mesh(f.geo, wreckMat);
        piece.userData.home = f.offset.clone();
        grp.add(piece);
      }
      grp.scale.setScalar(lengthOf(cls, h.kind));
      grp.layers.enable(RIM_LAYER);
      for (const c of grp.children) c.layers.enable(RIM_LAYER);
      scene.add(grp);
      wrecks.set(id, grp);
    }
    return grp;
  };

  /**
   * Break a hull open. `age` is milliseconds since the kill.
   *
   * Pieces separate along the line from the ship's centre through each
   * piece's own position -- a hull opens outward from where it was hit,
   * not in a puff -- and each one tumbles about itself at its own rate.
   * Separation eases off rather than running linearly: an explosion
   * throws wreckage hard and then space stops doing anything to it.
   */
  const breakUp = (id: string, h: Hull, m: THREE.Mesh, age: number) => {
    const grp = wreckGroupFor(id, h);
    grp.position.copy(m.position);
    grp.quaternion.copy(m.quaternion);
    grp.visible = true;
    const t = Math.min(1, age / WRECK_MS);
    const spread = 1 - Math.pow(1 - t, 2.2);
    let i = 0;
    for (const c of grp.children) {
      const home = (c.userData.home as THREE.Vector3);
      const j = mulberry32(hashStr(id + ':frag' + i));
      // Outward along its own axis, plus a little sideways so the pieces
      // do not stay collinear and read as one hull with gaps in it.
      const dir = home.clone().normalize();
      if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
      const kick = 0.55 + j() * 0.9;
      c.position.copy(home)
        .addScaledVector(dir, spread * kick)
        .add(new THREE.Vector3(
          (j() - 0.5) * 0.5, (j() - 0.5) * 0.42, (j() - 0.5) * 0.5)
          .multiplyScalar(spread));
      const rate = 0.00055 + j() * 0.0011;
      c.rotation.set(
        (j() - 0.5) * rate * age, (j() - 0.5) * rate * age, (j() - 0.5) * rate * age);
      i++;
    }
    return grp;
  };

  const bb = new Billboards(scene);
  const tr = new Tracers(scene);
  // A kill throws real light on what is near it — the one thing the
  // canvas view could never do.
  const killLights = [0, 1, 2, 3, 4, 5].map(() => {
    const l = new THREE.PointLight(0xffa860, 0, 420, 2);
    scene.add(l); return l;
  });

  // ---- composer --------------------------------------------------------
  // TONE MAP AFTER THE BLOOM, NOT BEFORE IT.
  //
  // The chain was RenderPass -> bloom, with the renderer's ACES applied
  // inside the scene render. That means bloom was adding light on top of
  // values already compressed into [0,1], with nothing downstream to
  // roll the sum back off -- so a detonation next to an engine next to a
  // beam simply saturated, and reviewers got a frame washed to flat
  // orange-white with the planet and the starfield gone. Rendering the
  // scene linear and tone mapping once at the end is what lets a blast
  // core go white-hot while its surroundings keep their colour.
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1280, 720), 0.55, 0.7, 0.85);
  composer.addPass(bloom);
  // OutputPass reads the tone mapping off the RENDERER, so the settings
  // stay where they are; three skips tone mapping for anything drawn
  // into a render target, which is why the scene reaches the bloom in
  // linear and gets compressed exactly once, here at the end.
  composer.addPass(new OutputPass());

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

  // ---- the shot list ----------------------------------------------------
  //
  // Cut no more often than every six seconds, and cut FOR A REASON. The
  // camera used to re-decide its framing every beat, which is why
  // consecutive frames read as a stall instead of a hold -- a shot that
  // changes slightly is worse than one that changes not at all.
  //
  // The list is built once, in a pass over the whole record, so each
  // shot knows what it is about before it starts: the pair in a duel,
  // the hull that is about to die, the world a fleet just arrived at.
  // That is what lets the reel tell the story rather than survey it.
  const MIN_SHOT_BEATS = 15000 / TICK_MS;

  type Shot = {
    kind: 'duel' | 'line' | 'arrival' | 'wide';
    from: number; to: number;
    a?: string; t?: string; body?: string;
  };
  const shots: Shot[] = (() => {
    const out: Shot[] = [];
    let cursor = 0;
    while (cursor < beats.length) {
      const end = Math.min(beats.length, cursor + MIN_SHOT_BEATS);
      // What is the most interesting thing that happens in this window?
      // WHICH EXCHANGE IS THIS WINDOW ABOUT?
      //
      // A duel was only picked when somebody DIED in the window
      // (`sh.kill`). Kills are rare, so most windows fell through to the
      // line or wide framings -- and those aim at a BODY, not at a pair,
      // which is why ten of eighteen sampled cells came back marked
      // "cannot attribute" and why this axis sat near 3 for three rounds.
      // The duel framing is the only one that puts a shooter and its
      // target on screen together, and reviewers found the one cell that
      // used it to be the only fully readable frame in the reel.
      //
      // So every window with fire in it now names a pair. A kill still
      // wins, because a kill is the story; failing that, the pair that
      // exchanged the most rounds is what the window is actually about.
      let killPair: { a: string; t: string } | null = null;
      const pairCount = new Map<string, { a: string; t: string; n: number }>();
      let hottest = { body: anchor.id, shots: -1 };
      for (let n = Math.floor(cursor); n < end && n < beats.length; n++) {
        const b = beats[n];
        for (const [bid, slot] of b.at) {
          if (slot.shots.length > hottest.shots) {
            hottest = { body: bid, shots: slot.shots.length };
          }
          for (const sh of slot.shots) {
            if (!sh.a || !sh.t) continue;
            if (!killPair && sh.kill) killPair = { a: sh.a, t: sh.t };
            const k = `${sh.a}>${sh.t}`;
            const e = pairCount.get(k);
            if (e) e.n++; else pairCount.set(k, { a: sh.a, t: sh.t, n: 1 });
          }
        }
      }
      let busiest: { a: string; t: string; n: number } | null = null;
      for (const p of pairCount.values()) if (!busiest || p.n > busiest.n) busiest = p;
      const duel = killPair ?? (busiest ? { a: busiest.a, t: busiest.t } : null);
      const from = cursor, to = Math.min(beats.length, cursor + MIN_SHOT_BEATS);
      if (duel) {
        out.push({ kind: 'duel', from, to, a: duel.a, t: duel.t, body: hottest.body });
      } else if (hottest.shots >= 3) {
        out.push({ kind: 'line', from, to, body: hottest.body });
      } else {
        out.push({ kind: 'wide', from, to, body: hottest.body });
      }
      cursor = to;
    }
    return out;
  })();
  const shotAt = (pos: number) => {
    for (const s of shots) if (pos >= s.from && pos < s.to) return s;
    return shots[shots.length - 1];
  };

  // ---- the director ----------------------------------------------------
  function aimCamera(pos: number) {
    const shot = shotAt(pos);
    const body = shot.body ?? anchor.id;
    const { W: Wv, A, C } = axesOf(body);
    const P = worldPos.get(body) ?? new THREE.Vector3();
    const R = worldR.get(body) ?? ANCHOR_R;
    // Everything the camera looks at is being carried around the world,
    // so the camera rides the same arc: the planet slides through frame
    // instead of the fleet sliding across a static planet.
    const Wo = Wv.clone().applyAxisAngle(ORBIT_AXIS, pos * ORBIT_RATE);
    const Ao = A.clone().applyAxisAngle(ORBIT_AXIS, pos * ORBIT_RATE);
    const Co = orbit(C, pos);
    const up = new THREE.Vector3().crossVectors(Ao, Wo).normalize();
    // How far through this shot we are: every shot moves while it is
    // held, so a six second take is a dolly, not a freeze.
    const u = Math.max(0, Math.min(1, (pos - shot.from) / Math.max(0.001, shot.to - shot.from)));

    if (shot.kind === 'duel' && shot.a && shot.t) {
      // OVER THE SHOULDER, held: sit off the killer's quarter and look
      // down its line of fire at the ship it is going to destroy. The
      // lens creeps in across the whole take so the kill lands at the
      // end of a push.
      const from = stationOf(lastSeen.get(shot.a), shot.a, pos);
      const to = stationOf(lastSeen.get(shot.t), shot.t, pos);
      const dir = to.clone().sub(from);
      if (dir.lengthSq() < 1e-6) dir.copy(Ao);
      dir.normalize();
      const side = new THREE.Vector3().crossVectors(dir, up).normalize();
      // Stand off by the SHOOTER'S OWN LENGTH, not by a constant. A
      // fixed 26 units sat over a corvette's shoulder and inside a
      // destroyer's engine room; as a multiple it frames either.
      const sh = hulls.get(shot.a);
      const L = lengthOf(iconClassOf(sh?.cls ?? null), sh?.kind ?? 'ship');
      // FRAME THE EXCHANGE, NOT THE GUN.
      //
      // The standoff used to be a multiple of the SHOOTER'S HULL LENGTH
      // (-L * 1.9). The engagement distance has nothing to do with the
      // shooter's length, so on any long shot this parked the camera a
      // corvette-length behind the muzzle and left the target a speck
      // hundreds of units away -- or framed the target and lost the
      // shooter off the edge. It is the scale bug this file already warns
      // about: effects and framing sized in world units against a scene
      // whose scale keeps changing.
      //
      // Two rounds of weapon-legibility review scored attribution 2.67
      // twice while both ends of every shot were already correctly
      // anchored -- origin on a turret mount, terminus on the hull. What
      // was missing was both ends being ON SCREEN AT ONCE. All three
      // reviewers independently picked out the single cell where shooter
      // and target were both visible as the only one they could read:
      // "origin on a hull, repeating heads marking the path, flare on the
      // shield boundary". So the standoff is now derived from the GAP,
      // which is what actually has to fit.
      // OVER THE SHOULDER OF THE GUN, AIMED DOWN THE SHOT.
      //
      // Framing the whole run does not work: at a 400-unit gap, holding
      // both ends means standing off ~500 units and a 20-unit frigate is
      // then four pixels of nothing. That trades attribution for the
      // "ships are specks" defect the earlier rounds already flagged.
      //
      // The shape that works is the one reviewers picked out unaided: the
      // firing hull LARGE in the near foreground with the victim centred
      // beyond it. Keeping the camera a couple of hull-lengths off the
      // shooter gives the foreground; aiming DEAD AT the target is what
      // guarantees the far end is on screen, because the look-at point is
      // the frame centre by construction.
      //
      // The old aim added a full hull-length of sideways offset to the
      // target (`to + side * L`), and since the camera was offset the same
      // way, that pushed the victim toward -- and often past -- the frame
      // edge. That one term is why two rounds of review could name a
      // target or a shooter but never both.
      camera.position.copy(from)
        .add(dir.clone().multiplyScalar(-L * (2.1 - u * 0.5)))
        .add(side.clone().multiplyScalar(L * (0.95 - u * 0.2)))
        .add(up.clone().multiplyScalar(L * 0.5));
      camera.lookAt(to);
      camera.fov = 46 - u * 6;
      camera.updateProjectionMatrix();
      return;
    }

    if (shot.kind === 'line') {
      // THE LINE: both fleets across frame with the world filling the
      // sky behind them, drifting along the formation as it burns.
      // Closer than it was. Every reviewer marked the same defect — half
      // the frame handed to bare starfield — and the cause is standing
      // off far enough to hold the whole formation with room to spare.
      // A line of battle running out of frame reads as a bigger fleet
      // than one sitting comfortably inside it.
      camera.position.copy(Co)
        .add(Wo.clone().multiplyScalar(SPAN * (0.66 + u * 0.2)))
        .add(Ao.clone().multiplyScalar(SPAN * (-0.4 + u * 0.8)))
        .add(up.clone().multiplyScalar(SPAN * (0.13 + u * 0.07)));
      // Aim at the formation, not past it into the planet. Looking at
      // -R/2 put the fleet against the left edge with half the frame
      // empty; the world still fills that side, it just is not the
      // subject any more.
      camera.lookAt(Co.clone().add(Wo.clone().multiplyScalar(-R * 0.16)));
      camera.fov = 44;
      camera.updateProjectionMatrix();
      return;
    }

    // WIDE: the fleet small against the world, the planet doing the
    // work. Still moving, because everything is in orbit.
    camera.position.copy(Co)
      .add(Wo.clone().multiplyScalar(SPAN * (1.1 + u * 0.3)))
      .add(Ao.clone().multiplyScalar(SPAN * (0.52 - u * 0.22)))
      .add(up.clone().multiplyScalar(SPAN * (0.34 - u * 0.14)));
    camera.lookAt(P.clone().lerp(Co, 0.84));
    camera.fov = 50;
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
    for (const g of wrecks.values()) g.visible = false;
    for (const l of killLights) l.intensity = 0;
    bb.begin(); tr.begin();
    let lightN = 0;

    aimCamera(pos);

    // What each hull has left this tick. The record carries it, and it
    // is what lets a ship burn before it dies instead of being pristine
    // right up to the instant it is a fireball.
    const hpNow = new Map<string, number>();
    for (const [, slot] of beat.at) {
      for (const r of slot.roster) {
        if (r.hpMax) hpNow.set(r.id, Math.max(0, Math.min(1, r.hp / r.hpMax)));
      }
    }

    const place = (id: string, h: Hull, bodyId: string | undefined) => {
      const m = meshFor(id, h);
      const p = stationOf(bodyId, id, pos);
      const nose = facingOf(bodyId, id, pos);
      // The approach: on the tick a hull first appears it flies in from
      // off-stage along its heading and decelerates onto its station.
      let burn = 0.32;
      if (firstTick.get(id) === beat.tick) {
        const u = Math.max(0, Math.min(1, t));
        const ease = 1 - Math.pow(1 - u, 3);
        // Off-stage by the formation's own scale, not by the hull's: a
        // corvette and a destroyer should make the same entrance, and
        // 34 hull-lengths is a different county for the big one.
        const back = nose.clone().multiplyScalar(-SPAN * 5 * (1 - ease));
        p.add(back);
        // Hard burn coming in, easing off as it makes station.
        burn = 1 - ease * 0.6;
      }
      m.position.copy(p);
      m.lookAt(p.clone().add(nose.clone().multiplyScalar(20)));
      m.rotateY(-Math.PI / 2);
      // Every hull holds its own attitude, and holds it loosely.
      //
      // Station-keeping computed from one formula gave every ship the
      // identical heading down to the last radian, and a reviewer read
      // the result exactly as it was built: "an instanced array, not a
      // fleet under fire". A few degrees of roll and pitch per hull,
      // seeded off its id and breathing slowly against the beat, is the
      // whole difference. Guns traverse, so this costs nothing in aim.
      const ja = mulberry32(hashStr(id + ':att'));
      const roll = (ja() - 0.5) * 0.36, pitch = (ja() - 0.5) * 0.17;
      const breathe = Math.sin(pos * 0.6 + ja() * 6.283) * 0.05;
      m.rotateX(roll + breathe);
      m.rotateZ(pitch + breathe * 0.4);
      return { m, p, nose, burn };
    };

    // --- hulls ---
    for (const [id, bodyId] of beat.where) {
      const h = hulls.get(id);
      if (!h) continue;
      const dying = h.diedTick != null && beat.tick >= h.diedTick
        && (beat.tick > h.diedTick || beatMs > KILL_AT);
      const { m, p, nose, burn } = place(id, h, bodyId);
      if (dying) {
        const age = (beat.tick - h.diedTick!) * TICK_MS + (beatMs - KILL_AT);
        if (age >= WRECK_MS) { m.visible = false; continue; }
        // THE HULL COMES APART. Swapping the material left a pristine
        // ship drifting away from its own fireball, which four review
        // rounds running called out as a kill with no consequence.
        m.visible = false;
        for (const c of m.children) c.visible = false;
        if (age < DEATH_MS) {
          // COMING APART. Secondaries walk down the hull while the main
          // blast burns, so the ship is visibly destroyed rather than
          // swapped for a wreck between frames.
          const nose = facingOf(bodyId, id, pos);
          const jj = mulberry32(hashStr(id + ':sec'));
          for (let sIdx = 0; sIdx < 4; sIdx++) {
            const at0 = 120 + sIdx * 330 + jj() * 190;
            const sk = (age - at0) / 620;
            if (sk < 0 || sk > 1) continue;
            const along = (jj() - 0.5) * m.scale.x * 0.8;
            drawBlast(bb, m.position.clone().add(nose.clone().multiplyScalar(along)),
              sk, m.scale.x * 0.4, hashStr(id) * 7 + sIdx * 131);
          }
          // The whole hull is alight while it breaks up.
          drawHullFire(bb, m.position, m.scale.x * 1.15, 1,
            hashStr(id) % 991, age * 1.7);
        }
        // The whole wreck still drifts off the line it was holding,
        // because nothing is keeping station any more -- but it drifts
        // as a field of pieces, not as a ship.
        m.position.add(facingOf(bodyId, id, pos)
          .multiplyScalar(-(age / WRECK_MS) * m.scale.x * 0.9)
          .add(new THREE.Vector3(0, -(age / WRECK_MS) * m.scale.x * 0.3, 0)));
        breakUp(id, h, m, age);
        // Wrecks burn. A dark hull drifting silently reads as a prop;
        // a burning one reads as something that just died.
        drawHullFire(bb, m.position, m.scale.x,
          Math.max(0, 1 - age / (WRECK_MS * 0.6)),
          hashStr(id) % 991, age);
        // Debris: small pieces thrown clear of the big ones, fading as
        // the field spreads. Without them the break reads as three
        // tidy chunks rather than a ship coming apart.
        const jd = mulberry32(hashStr(id + ':debris'));
        const spread = Math.min(1, age / WRECK_MS);
        for (let d = 0; d < 10; d++) {
          const dir = new THREE.Vector3(jd() - 0.5, jd() - 0.5, jd() - 0.5).normalize();
          const at = m.position.clone()
            .addScaledVector(dir, m.scale.x * (0.4 + jd() * 1.5) * spread);
          bb.put(glowTex(), at, m.scale.x * 0.05, m.scale.x * 0.05,
            0x9a8b7a, Math.max(0, 0.7 - spread * 0.7));
        }
        stats.wrecks++;
      } else {
        m.material = [
          platedHullMaterial(colorOf(h.fid), h.variant),
          platedHullMaterial(color2Of(h.fid), h.variant, true),
        ];
        for (const c of m.children) c.visible = true;
        m.visible = true;
        // WHOSE SHIP IS THIS. Bolts already carry the firing faction's
        // colour, but nothing on a HULL did at any distance the camera
        // actually uses: the livery is a painted decal and a stripe, and
        // reviewers reported the numerals and names as unreadable except
        // under 6x magnification on a still. So every hull read as "grey,
        // tan or brown", the colour of the fire could not be matched to a
        // fleet, and the question a player actually asks -- which of these
        // is MINE -- had no answer in eighteen frames. One reviewer's
        // single request was "colour every ship and every shot by whose
        // side it's on".
        //
        // A running light in the faction's own colour does that, and it
        // survives distance because it is emissive rather than painted.
        // Kept dim and small so it reads as a marker light and not as a
        // hull fire or an arriving round.
        bb.put(glowTex(), m.position,
          m.scale.x * 0.30, m.scale.x * 0.30, colorOf(h.fid), 0.40);
        stats.ships++;
        // A hull that is losing burns.
        const frac = hpNow.get(id);
        if (frac != null && frac < 0.72) {
          const sev = Math.min(1, (0.72 - frac) / 0.6);
          drawHullFire(bb, p, m.scale.x, sev, hashStr(id) % 997, beatMs + beat.tick * 900);
        }
        // One plume per engine bell, placed by transforming the model's
        // own bell positions into world space -- the geometry knows
        // where its engines are, so nothing has to be guessed.
        const len = m.scale.x;
        const aft = nose.clone().negate();
        m.updateMatrixWorld();
        for (const bell of engineBells(iconClassOf(h.cls), h.variant)) {
          const at = m.localToWorld(bell.clone());
          // 0.16 was tuned when a corvette was 14 units long. At 10 the
          // whole plume came out under two units across and vanished at
          // any camera distance -- a reviewer reported six frames with
          // no engine plumes anywhere, and was right. Effects sized in
          // world units have to be rechecked every time the scene's
          // scale moves; this is the third one this file has caught.
          drawPlume(tr, bb, at, aft, len * 0.42, colorOf(h.fid), burn, camera,
            beatMs + beat.tick * 700);
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
      m.visible = false;
      for (const c of m.children) c.visible = false;
      m.position.add(facingOf(lastSeen.get(id), id, pos)
        .multiplyScalar(-(age / WRECK_MS) * m.scale.x * 0.9));
      breakUp(id, h, m, age);
      drawHullFire(bb, m.position, m.scale.x,
        Math.max(0, 1 - age / (WRECK_MS * 0.6)), hashStr(id) % 991, age);
      stats.wrecks++;
    }

    // --- fire ---
    //
    // A shot runs from a GUN to a HULL. Both ends used to be the ships'
    // origins nudged along the line between them, which is why nothing
    // ever looked like it was fired: the bolt left a point floating near
    // the shooter and ended at a point floating near the target, and at
    // this range those points are metres off the models.
    //
    // Now the near end is the turret that bears — the hull does not
    // turn, so the mount on the flank the target is on is the one that
    // fires — and the far end is a spot on the target's own plating.
    for (const [, slot] of beat.at) {
      for (const sh of slot.shots) {
        if (!sh.a || !sh.t) continue;
        const shooter = hulls.get(sh.a);
        const target = hulls.get(sh.t);
        if (shooter?.diedTick != null && beat.tick > shooter.diedTick) continue;
        const aAt = beat.where.get(sh.a) ?? lastSeen.get(sh.a);
        const tAt = beat.where.get(sh.t) ?? lastSeen.get(sh.t);
        if (aAt && tAt && aAt !== tAt) continue;
        const seed = hashStr(sh.a + ':' + sh.t);
        const w = ((seed % 1000) / 1000) * LAUNCH_SPREAD;
        if (t < w) continue;
        // NOT clamped. It used to be Math.min(1, ...), which meant that
        // once a round arrived its head stopped at the target and the
        // streak went on being drawn at full length for the rest of the
        // beat -- a bolt that hit and then sat there. Past 1 is the
        // impact flash decaying, and past IMPACT_TAIL there is nothing.
        const flown = (t - w) / FLIGHT_FRAC;

        // Both hulls were positioned by the pass above, so their own
        // matrices are the truth about where their plating is.
        const sm = meshes.get(sh.a), tm = meshes.get(sh.t);
        if (!sm || !tm) continue;
        sm.updateMatrixWorld(); tm.updateMatrixWorld();
        const rnd = mulberry32(seed);

        // ---- THE FIRING SOLUTION, FROZEN AT LAUNCH ----
        //
        // Both ends used to be read off the two hulls' CURRENT matrices,
        // every frame, for the whole flight. So a round was never flying a
        // path -- it was strung between two anchors that moved under it.
        // Ships station-keep and orbit, so the segment translated and
        // rotated while the round was on it, and the round slid sideways
        // instead of travelling: "tracers are moving somewhat sideways,
        // and there's a lot of noise in their trajectory". A line that
        // wanders cannot join two ships by eye, which is the whole of
        // attribution.
        //
        // A shot is fired ONCE, so its geometry is fixed once. stationOf
        // is a pure function of position, so asking it for the launch
        // instant costs nothing and needs no stored state -- which matters,
        // because this stage has to stay reproducible from `pos` alone.
        const sCls = iconClassOf(shooter?.cls ?? null);
        const launchPos = i + w;
        const psL = stationOf(aAt, sh.a, launchPos);
        const ptL = stationOf(tAt, sh.t, launchPos);
        const lineDir = ptL.clone().sub(psL);
        const centreGap = Math.max(1e-3, lineDir.length());
        lineDir.divideScalar(centreGap);
        // The muzzle sits on the firing line at the shooter's own skin, so
        // fire leaves the hull rather than appearing beside it. This gives
        // up the specific turret it came from; a stable line between two
        // ships is worth more than which barrel it left, because the
        // barrel was never legible at these framings anyway.
        const sLen = lengthOf(sCls, shooter?.kind ?? 'ship');
        const from = psL.clone().addScaledVector(lineDir, sLen * 0.46);

        // ---- and where it lands, on the plating ----
        const prof = hullProfile(iconClassOf(target?.cls ?? null), target?.variant ?? 'A');
        // WHERE THE ROUND ACTUALLY MEETS THE HULL.
        //
        // This used to be a random point: the station along the hull and
        // the height were both dice rolls, and only the SIDE responded to
        // where the shooter was. Three reviewers independently reported
        // the consequence without being able to name it -- the arrival
        // flash "sits at the bow in every instance regardless of where the
        // incoming fire is coming from", and rounds "cross the hull and
        // continue past it". A flash that is not on the line the round
        // came in on cannot be paired with that round by eye, which is
        // why attribution scored 2.67 out of 10.
        //
        // The hull is built in unit-length local space, so its envelope is
        // an ellipsoid with semi-axes (0.5, halfHeight, halfBeam). For a
        // ray fired at the hull's centre there is a closed form for where
        // it crosses that envelope: normalise the shooter's local position
        // by the semi-axes, and the crossing is simply S / |S/axes|. No
        // solver, no iteration, and it lands on the face the shooter can
        // actually see.
        // SIZED TO THE SILHOUETTE, NOT THE PLATING. hullProfile reports
        // the plating extents, and an inscribed ellipsoid at exactly those
        // extents sits INSIDE the shape a viewer sees -- spars, wings,
        // nacelles and masts all reach past it. Terminating a round there
        // put it visibly within the hull: "a magenta wedge sitting inside
        // the bubble halfway across the hull, still travelling", and
        // rounds that appear to penetrate teach the viewer that endpoints
        // mean nothing. Inflated so a round stops at or just outside the
        // skin, where a hit reads as a hit.
        // The ellipsoid solve had to go with the moving anchors: it was
        // expressed in the target's CURRENT local frame, so it re-derived
        // every frame and dragged the far end of the round around with the
        // hull's own drift and yaw. On the frozen line the terminus is the
        // point where that line first meets the target's skin, which is a
        // sphere of the hull's cross-section -- orientation-free, so it
        // cannot wander even as the hull turns underneath it.
        //
        // SIZED TO THE SILHOUETTE, NOT THE PLATING. hullProfile reports the
        // plating extents, and stopping exactly there puts the round inside
        // the shape a viewer sees, because spars, wings, nacelles and masts
        // all reach past it: "a magenta wedge sitting inside the bubble
        // halfway across the hull, still travelling". Rounds that appear to
        // penetrate teach the viewer that endpoints mean nothing.
        const SKIN = 1.22;
        const tLen = lengthOf(
          iconClassOf(target?.cls ?? null), target?.kind ?? 'ship');
        const tSkin = tLen
          * Math.max(prof.halfBeam, prof.halfHeight, 0.16) * SKIN;
        // Never past the shooter, and never so close it swallows the flight.
        const stop = Math.min(tSkin, centreGap * 0.55);
        const to = ptL.clone().addScaledVector(lineDir, -stop);
        /**
         * Outward normal at the contact point. On a sphere that is simply
         * the incoming line reversed, which is also the direction a shield
         * flare has to bloom to face the gun that caused it.
         */
        const hitNormal = lineDir.clone().negate();

        const gap = from.distanceTo(to);
        if (gap < 1e-3) continue;
        const dir = to.clone().sub(from).normalize();
        const col = colorOf(shooter?.fid ?? null);
        // Effects are sized off the hulls at each end, not off constants.
        // A corvette is now a fifth of a destroyer, and a muzzle flash
        // tuned for one swallows the other whole.
        const L = lengthOf(sCls, shooter?.kind ?? 'ship');
        /** Every gun flash lands at its own angle, so none of them clone. */
        const muzzleRoll = rnd() * Math.PI * 2;
        const tL = lengthOf(iconClassOf(target?.cls ?? null), target?.kind ?? 'ship');
        // The record carries what the volley was fired with. An energy
        // hit is one long lance; a kinetic one is a string of slugs.
        const energy = sh.e != null ? sh.e >= 0.5 : false;

        // A MUZZLE MARK THAT LASTS AS LONG AS THE ROUND IS OUT.
        //
        // Every reviewer across three rounds reported the same thing --
        // shots "begin in empty space", "the trail just begins in black",
        // "in 17 of 18 cells there is no gun-end anywhere" -- and every
        // one of them singled out the rare frame where a bead sat ON the
        // firing hull as the only readable attribution in the reel. One
        // called it "the correct behaviour; it is just rare".
        //
        // The per-round flashes are brief by design, so between them the
        // gun goes dark while its rounds are still visibly in flight, and
        // the line loses the end that says WHO. This is a steady mark held
        // for the whole flight instead: it is in the FIRING FACTION'S
        // colour, so it doubles as the one ownership cue that survives
        // distance, and it sits at the turret rather than the hull centre
        // so it reads as a gun and not as damage.
        // Deliberately modest. It ADDS to the per-round flashes rather than
        // replacing them, and at 0.44/0.62 the sum blew out into a cream
        // bloom that swallowed the ship it belonged to -- the exact defect
        // reviewers have flagged in every round ("blooms swallow the
        // shooters", "the struck ship renders as a flat black silhouette
        // inside its own bloom"). A marker only has to be unmistakable,
        // not bright.
        if (flown > 0 && flown < 1.25) {
          const fade = flown < 1 ? 1 : 1 - (flown - 1) / 0.25;
          bb.put(glowTex(), from, L * 0.26, L * 0.26, col, 0.40 * fade);
          bb.put(glowTex(), from, L * 0.10, L * 0.10, 0xfff6e6, 0.55 * fade);
        }

        /** A round that lands flashes and is gone; nothing lingers. */
        const impactAt = (arrived: number) => {
          if (!sh.hit) return;
          const k = (flown - arrived) / IMPACT_TAIL;
          if (k < 0 || k > 1) return;
          // What the shields ate versus what went into the hull: a held
          // round flares cold and wide, a landed one burns and throws
          // spall back down the line the round came in on.
          //
          // THE TEST USED TO BE `abs > dmg * 0.5` AND IT NEVER ONCE FIRED.
          // In the largest recorded battle, 30 shots had a shield absorb
          // real damage, but absorption runs about a quarter of the round
          // (abs 4.5 against dmg 16 is typical), so demanding it beat half
          // the damage meant the shield flare was dead code across all 431
          // shots. Any absorption at all is a shield doing its job, so any
          // absorption now shows -- and the strength of the flare carries
          // HOW MUCH it ate, which is the part a viewer can actually read.
          const absorbed = Math.max(0, Number(sh.abs) || 0);
          const landed = Math.max(0, Number(sh.dmg) || 0);
          const incoming = absorbed + landed;
          const heldFrac = incoming > 0 ? absorbed / incoming : 0;
          const held = absorbed > 0.01;
          // THREE DEFENCE STATES, THREE LOOKS. Cold blue and wide = the
          // shield ate it. Hard steel-white and tight = it struck ARMOUR
          // and spalled off the plate. Warm orange and open = it went into
          // bare hull. Previously the last two were the same event, so a
          // viewer could not tell armour from no armour at all.
          const armored = !held && (target?.armored ?? false);
          const tint = held
            ? 0x8fd8ff
            : armored ? 0xe8f0f8 : (energy ? 0xbfe9ff : 0xffcf8a);
          // A HELD ROUND FLARES OUT ON THE SHIELD, NOT ON THE PLATING.
          // The shield volume stands off the hull, and reviewers rated
          // that standoff the single best-reading element in the reel --
          // but the flare itself was landing on the hull, uniformly, with
          // no relationship to the side the fire came from. Pushing it
          // out along the contact normal puts the flash on the face of
          // the bubble that the round actually struck, which is what
          // makes "it stopped THERE" readable.
          // The standoff is DELIBERATELY SMALL. At 0.30 of the target's
          // length this detached the flare from the ship it belonged to:
          // reviewers reported the core "entirely below the hull box",
          // "centred to the left of the ship's nose, overlapping a second
          // pale ship", so shield OWNERSHIP became ambiguous -- a worse
          // problem than the one it fixed. What actually reads is the
          // flare sitting on the boundary with the hull visibly beyond it,
          // and that needs only a hair of standoff.
          const at = held
            ? to.clone().add(hitNormal.clone().multiplyScalar(tL * 0.10))
            : to;
          // A round the shield swallowed whole splashes wider than one it
          // only grazed, so the two do not read as the same event.
          // Armour reads TIGHT and hot -- a round that fails to open a
          // hull makes a small bright scar, not a wide bloom. Bare hull
          // gets the widest burn of the three, because that is the one
          // that actually hurt.
          drawImpact(bb, at, dir.clone().negate(), k,
            tL * (held ? 0.34 * (1 + heldFrac * 0.55) : armored ? 0.30 : 0.50),
            seed + Math.round(arrived * 97), held, tint);
        };

        if (energy) {
          // ANCHORED AT THE GUN. The tail used to be capped at 150 units
          // while the gap across a formation runs into the hundreds, so
          // mid-flight the streak was a bar of light with neither end on
          // a hull -- it had no origin, no destination, and therefore no
          // direction. A lance now reaches from the muzzle to wherever
          // its head has got to, so it is always visibly being fired BY
          // something AT something.
          if (flown <= 1) {
            const head = from.clone().lerp(to, flown);
            if (gap * flown >= 0.5) {
              // Width scales with the gun's ship. Fixed world widths
              // were tuned against a 14-unit corvette; the tracer
              // texture only fills a third of its quad, so a nominal
              // 3.2 came out a few pixels wide and six reviews in a row
              // called the beams flat hairlines.
              // WEAPON TYPE HAS TO SURVIVE THE COLOUR BEING TAKEN.
              //
              // Colour already means FACTION here, and that is worth
              // keeping -- but it means weapon type has only shape left to
              // carry it, and at the old widths it could not. All three
              // reviewers enumerated the weapons wrong in the same way:
              // they read the two faction colours as two weapon types and
              // never identified the lance at all, calling it a "salmon
              // hairline ... identical width and brightness end to end, no
              // head, no taper", which they could not classify as a weapon.
              //
              // So a lance is now unmistakably a BEAM: near twice as wide,
              // with a broad white-hot core running its whole length and a
              // bright head. Against a burst of short discrete slugs that
              // is a difference of kind, not of degree, and it survives
              // both fleets' colours.
              tr.put(from, head, L * 0.92, col, 1, camera);
              tr.put(from, head, L * 0.40, ENERGY_CORE, 1, camera);
              bb.put(glowTex(), head, L * 0.34, L * 0.34, 0xe6f6ff, 0.95);
              stats.tracers++;
            }
          }
          // The gun stays lit for as long as the beam is out of it.
          if (flown < 1) {
            const mk = 1 - flown;
            bb.put(flareTex(), from, L * 0.5 * (0.6 + mk), L * 0.5 * (0.6 + mk),
              0xffffff, 0.4 + mk * 0.55, muzzleRoll);
            bb.put(glowTex(), from, L * 0.34 * (1 + mk), L * 0.34 * (1 + mk),
              col, 0.2 + mk * 0.3);
          }
          impactAt(1);
        } else {
          // A kinetic mount fires a burst, not a shot. Rounds leave in
          // sequence, so what is in flight is a string of slugs with
          // daylight between them — the thing that reads as a volley.
          const N = 3 + (seed % 2);
          const STEP = 0.15;
          // THE PATH, not just the rounds. A burst of separate slugs
          // shows where ordnance IS and never where it is going, so the
          // eye cannot join a shooter to a target -- which is what "no
          // clear line between ships" means. Tracer rounds solve this
          // in reality by burning the whole way, so the burst lays a
          // faint continuous streak from the muzzle to its leading
          // round. Kept dim: it guides the eye, it is not the subject.
          // A MUZZLE-ANCHORED STUB, NOT A FULL-LENGTH WIRE.
          //
          // This used to run the whole way from the gun to the leading
          // round at width L*0.1 and alpha 0.4. All three reviewers of
          // the weapons round independently picked that line out as the
          // worst offender and described it identically: a 1-2px line of
          // "identical width and brightness end to end, no head, no
          // taper", spanning 30-60% of frame, which "gives it no
          // direction -- I cannot tell which end is the muzzle". One
          // called it a wire rather than ordnance. It was also being
          // mistaken for a second kind of weapon, because a thin
          // continuous line is exactly what an energy lance looks like.
          //
          // What it was FOR was anchoring the shot to its shooter, and
          // that is worth keeping -- the two cells where fire visibly
          // left a hull were the only ones any reviewer could attribute.
          // So it now reaches only a short way out of the gun, brighter
          // and thicker, and fades: unmistakably "fire coming out of THIS
          // ship" and impossible to read as a beam spanning the frame.
          if (flown > 0 && flown <= 1.05) {
            const stub = from.clone().lerp(to, Math.min(0.42, flown * 0.42));
            if (from.distanceTo(stub) > 0.5) {
              tr.put(from, stub, L * 0.17, col, 0.7, camera);
            }
          }
          for (let r = 0; r < N; r++) {
            const f = flown - r * STEP;
            if (f <= 0) continue;
            if (f <= 1) {
              const head = from.clone().lerp(to, f);
              const tail = Math.min(gap * f, Math.max(L * 0.35, Math.min(22, gap * 0.1)));
              if (tail >= 0.4) {
                tr.put(head.clone().sub(dir.clone().multiplyScalar(tail)), head,
                  L * 0.3, col, 1, camera);
                // A HOT AMBER HEAD, brighter than its own trail, because
                // the old one was DULLER than its trail and so read as a
                // separate object. But kept SMALL: at 0.19 the glow was
                // wider than the trail behind it and the pair came apart
                // again the other way -- reviewers described "orb, gap,
                // wedge" and orbs that "stay huge while their paired
                // wedges shrink to 3-px specks" at distance. Hotter, not
                // bigger, is what welds a nose to its own trail.
                bb.put(glowTex(), head, L * 0.11, L * 0.11, 0xffb347, 1);
                bb.put(glowTex(), head, L * 0.055, L * 0.055, 0xfff4e0, 1);
                stats.tracers++;
              }
            }
            // A slug leaves a short streak behind the gun as it clears,
            // so the burst reads as coming OUT of the ship rather than
            // appearing beside it.
            if (f > 0 && f < 0.3) {
              const e = 1 - f / 0.3;
              tr.put(from, from.clone().lerp(to, Math.min(f, 0.09)),
                L * 0.34, 0xffe0ac, 1, camera);
              bb.put(glowTex(), from, L * 0.2 * e, L * 0.2 * e, col, e * 0.5);
            }
            // The gun flashes once per round away, so the muzzle
            // stutters in time with what is leaving it.
            //
            // The window was f < 0.09 -- the flash existed for nine
            // percent of the round's flight, which in motion is a single
            // frame and in any still is almost never caught. "In 17 of 18
            // cells there is no gun-end anywhere" was the result. Widened
            // so the gun is still lit while its round is visibly on its
            // way, which is the whole point of a muzzle flash.
            const mk = 1 - f / 0.32;
            if (mk > 0 && mk <= 1) {
              bb.put(flareTex(), from, L * 0.44 * (0.5 + mk), L * 0.44 * (0.5 + mk),
                0xfff1cc, mk * 0.95, muzzleRoll + r * 0.7);
              bb.put(glowTex(), from, L * 0.3 * (1 + mk), L * 0.3 * (1 + mk),
                col, mk * 0.5);
            }
            // Each round in the burst lands on its own.
            impactAt(1 + r * STEP);
          }
        }
      }
    }

    // --- kills ---
    for (const [id, h] of hulls) {
      if (h.diedTick == null || h.diedTick !== beat.tick) continue;
      const since = beatMs - KILL_AT;
      if (since < 0 || since > FIREBALL_MS) continue;
      const k = since / FIREBALL_MS;
      const at = stationOf(beat.where.get(id) ?? lastSeen.get(id), id, pos);
      const len = lengthOf(iconClassOf(h.cls), h.kind);
      // A fireball can never be bigger than the room the camera has for
      // it. The duel shot stands off by about two hull lengths and a
      // kill blast reaches three, so the lens ended up INSIDE the
      // explosion and the whole frame went to milky orange -- which
      // three reviewers read, reasonably, as bloom with no ceiling. It
      // was not the post chain; it was the camera standing in the fire.
      const room = camera.position.distanceTo(at);
      drawBlast(bb, at, k, Math.min(len * 1.35, room * 0.34), hashStr(id) % 1000);
      if (lightN < killLights.length) {
        const l = killLights[lightN++];
        l.position.copy(at);
        l.intensity = 2600 * Math.max(0, 1 - k * 1.3);
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
