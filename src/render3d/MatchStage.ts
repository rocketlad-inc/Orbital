// ============================================================
// The match film: an entire game replayed tick by tick.
//
// Same construction kit as the battle film — worlds from planetSphere,
// hulls, livery and plumes from shipModel/fx3d — but the subject is the
// CAMPAIGN, not an engagement: months of a game at one second per tick,
// fleets massing and moving between worlds, settlements founding and
// falling, empires spreading across a system.
//
// The three battle-stage rules hold here with one amendment each:
//
//   STAGE FOR CAMERA, KEEP THE RECORD TRUE. Orbit radii are compressed
//   on a log scale or the system is 99.9% void; who owns what and who
//   is where per tick is the record.
//
//   PICK SHOTS, DO NOT ORBIT. The director's beats here are EVENTS
//   mined from the snapshot stream itself — fleets lost, settlements
//   founded, battles from the battle table — with wide establishing
//   shots between them.
//
//   ONE PLACE PER THING. Nothing graphical is defined in this file
//   that fx3d/shipModel/planetSphere already provide.
//
// The data is the keyframe+delta stream match_snapshots serves: reset
// the world at a key, upsert/delete at a delta, absent tick = hold.
// ============================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { hashStr, mulberry32, terraformBiome } from '../render/planetTexture';
import { shipGeometry, hullProfile, engineBells } from './shipModel';
import { makeWorld, type WorldFace } from './planetSphere';
import {
  Billboards, Tracers, drawPlume, drawBlast, platedHullMaterial,
  hullDecalMaterial, stripeMaterial, attachLivery, spaceEnv,
} from './fx3d';
import type { ShipIconClass, ShipIconVariant } from '../components/ShipIcons';

const NEUTRAL = '#8a9fb3';

// ---- payloads -----------------------------------------------------------

export interface MatchSummary {
  game: { id: string; name: string | null; status: string;
    winner_faction_id: string | null };
  ticks: { lo: number | null; hi: number | null; rows: number };
  firstLiveTick: number | null;
  factions: Array<{ id: string; name: string; color: string | null;
    color2: string | null }>;
  bodies: Array<{ id: string; name: string | null; type: string;
    color: string | null; radius: number; orbit_radius: number | null;
    orbit_period: number | null; angle0: number | null;
    parent_body_id: string | null; terraformed_at_tick: number | null;
    destroyed_at_tick: number | null }>;
  battles: Array<{ id: string; body_id: string | null;
    started_tick: number; ended_tick: number | null }>;
}

export interface SnapshotRow {
  t: number; kind: 'key' | 'delta';
  state: { v: number; syn?: number; put: any[][]; del: string[] };
}

// ---- the world state machine -------------------------------------------

interface ShipRow { fid: string | null; cls: string; parent: string | null;
  iv: ShipIconVariant; syn: boolean }
interface StlRow { body: string; fid: string | null; pop: number }

/**
 * The replay's world, advanced by applying snapshot rows in order.
 * Rebuilding from the nearest keyframe is how scrubbing works, so apply
 * must stay cheap: plain map writes, no allocation beyond the rows.
 */
export class MatchWorld {
  ships = new Map<string, ShipRow>();
  stls = new Map<string, StlRow>();
  stock = new Map<string, number[]>();
  pacts = new Map<string, string[]>();
  synthetic = false;

  apply(row: SnapshotRow): void {
    if (row.kind === 'key') {
      this.ships.clear(); this.stls.clear();
      this.stock.clear(); this.pacts.clear();
    }
    this.synthetic = !!row.state.syn;
    for (const r of row.state.put) {
      switch (r[0]) {
        case 's':
          this.ships.set(r[1], { fid: r[2], cls: r[3], parent: r[4],
            iv: (r[13] ?? 'A') as ShipIconVariant, syn: r[5] == null });
          break;
        case 't':
          this.stls.set(r[1], { body: r[2], fid: r[3], pop: r[5] ?? 0 });
          break;
        case 'f':
          this.stock.set(r[1], [r[2], r[3], r[4], r[5]]);
          break;
        case 'p':
          this.pacts.set(r[1], r.slice(3));
          break;
        default: break; // routes drawn in a later pass
      }
    }
    for (const k of row.state.del) {
      const id = k.slice(2);
      if (k[0] === 's') this.ships.delete(id);
      else if (k[0] === 't') this.stls.delete(id);
      else if (k[0] === 'f') this.stock.delete(id);
      else if (k[0] === 'p') this.pacts.delete(id);
    }
  }
}

// ---- events: what the director cuts to ---------------------------------

export interface MatchEvent {
  tick: number; kind: 'battle' | 'loss' | 'founded' | 'fallen' | 'pact';
  bodyId: string | null; weight: number;
}

/**
 * Mine the beats out of the stream itself. A ship key vanishing is a
 * loss; a settlement appearing is a founding; the battles table names
 * the fights. The director wants moments, and the diff IS the moment.
 */
export function mineEvents(rows: SnapshotRow[], summary: MatchSummary): MatchEvent[] {
  const events: MatchEvent[] = [];
  const shipParent = new Map<string, string | null>();
  const stlBody = new Map<string, string>();
  for (const row of rows) {
    let losses = 0; let lossBody: string | null = null;
    for (const k of row.state.del) {
      if (k[0] === 's') {
        losses++;
        lossBody = shipParent.get(k.slice(2)) ?? lossBody;
        shipParent.delete(k.slice(2));
      } else if (k[0] === 't') {
        const b = stlBody.get(k.slice(2));
        events.push({ tick: row.t, kind: 'fallen', bodyId: b ?? null, weight: 5 });
        stlBody.delete(k.slice(2));
      }
    }
    if (losses > 0) {
      events.push({ tick: row.t, kind: 'loss', bodyId: lossBody,
        weight: Math.min(6, 1 + losses) });
    }
    for (const r of row.state.put) {
      if (r[0] === 's' && !shipParent.has(r[1]) && row.kind !== 'key') {
        // a new hull is quiet news; arrival shots come from battles
      }
      if (r[0] === 's') shipParent.set(r[1], r[4]);
      if (r[0] === 't') {
        if (!stlBody.has(r[1]) && row.kind !== 'key') {
          events.push({ tick: row.t, kind: 'founded', bodyId: r[2], weight: 3 });
        }
        stlBody.set(r[1], r[2]);
      }
      if (r[0] === 'p' && row.kind !== 'key') {
        events.push({ tick: row.t, kind: 'pact', bodyId: null, weight: 2 });
      }
    }
  }
  for (const b of summary.battles) {
    events.push({ tick: b.started_tick, kind: 'battle',
      bodyId: b.body_id ? b.body_id.split(':').pop()! : null, weight: 8 });
  }
  events.sort((a, b) => a.tick - b.tick || b.weight - a.weight);
  return events;
}

// ---- the stage ----------------------------------------------------------

export interface MatchStage {
  setTick(tick: number, frac: number): void;
  render(): void;
  resize(w: number, h: number): void;
  applyRows(rows: SnapshotRow[]): void;
  dispose(): void;
  worldAt(tick: number): MatchWorld;
}

export function createMatchStage(
  summary: MatchSummary, canvas: HTMLCanvasElement,
): MatchStage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true,
    preserveDrawingBuffer: true });
  renderer.setClearColor(0x010204, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.86;

  const scene = new THREE.Scene();
  scene.environment = spaceEnv(renderer);
  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.5, 30000);

  const STAR_DIR = new THREE.Vector3(-1, 0.42, 0.72).normalize();
  const star = new THREE.DirectionalLight(0xf6f4f0, 2.6);
  star.position.copy(STAR_DIR).multiplyScalar(4000);
  scene.add(star);
  const fill = new THREE.DirectionalLight(0x4a6d99, 0.4);
  fill.position.set(2000, -800, -1600);
  scene.add(fill);
  const RIM_LAYER = 1;
  const rim = new THREE.DirectionalLight(0xbcd6ff, 1.4);
  rim.position.copy(STAR_DIR).multiplyScalar(-4000).setY(900);
  rim.layers.set(RIM_LAYER);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0x9fb6d8, 0x30201a, 0.32));

  // Starfield, same recipe as the battle stage but wider.
  {
    const n = 3200;
    const pos = new Float32Array(n * 3);
    const rnd = mulberry32(0xa57e);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5)
        .normalize().multiplyScalar(20000 + rnd() * 6000);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xcfe0f2, size: 2.2, sizeAttenuation: false,
      transparent: true, opacity: 0.85 })));
  }

  // ---- the system ------------------------------------------------------
  //
  // Log-compressed orbits: real proportions are 99.9% void, and a film
  // of the void is the thing the battle stage taught us not to make.
  // Radii keep their ORDER and lose their emptiness.
  const bodies = summary.bodies.filter(b => b.type !== 'star'
    ? true : true);
  const bodyR = new Map<string, number>();
  const bodyMesh = new Map<string, THREE.Group>();
  const colorOfFaction = (fid: string | null) => {
    const f = summary.factions.find(x => x.id === fid);
    return (f && f.color) || NEUTRAL;
  };
  const color2OfFaction = (fid: string | null) => {
    const f = summary.factions.find(x => x.id === fid);
    return (f && (f.color2 || f.color)) || NEUTRAL;
  };

  const ORBIT_SCALE = 320;
  const orbitR = (r: number | null) =>
    r && r > 0 ? Math.log10(1 + r) * ORBIT_SCALE : 0;

  for (const b of bodies) {
    const isStar = b.type === 'star';
    const r = isStar ? 90
      : Math.max(7, Math.min(60, 8 + (Number(b.radius) || 1) * 5));
    bodyR.set(b.id, r);
    const face: WorldFace =
      b.type === 'gas_giant' || b.type === 'ice_giant' ? 'giant'
      : b.terraformed_at_tick != null
        ? (() => { try { return terraformBiome(b as any) as WorldFace; }
                   catch { return 'verdant'; } })()
        : 'rock';
    const w = makeWorld(b.id, b.color || '#b06a3f', r,
      /ice|ocean/.test(b.type), isStar ? 'rock' : face);
    if (isStar) {
      // The sun is a light, not a rock: strip the surface to an emissive
      // ball so it reads as the source of the key.
      w.traverse(o => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (m && 'emissive' in m) {
          m.emissive = new THREE.Color(0xffd9a0);
          m.emissiveIntensity = 1.4;
        }
      });
    }
    scene.add(w);
    bodyMesh.set(b.id, w);
  }

  /** Where a body sits at a tick: circular orbit off its own elements. */
  const bodyPos = (id: string, tick: number, out: THREE.Vector3): THREE.Vector3 => {
    const b = bodies.find(x => x.id === id);
    if (!b) return out.set(0, 0, 0);
    if (!b.parent_body_id || !b.orbit_radius || !b.orbit_period) {
      return out.set(0, 0, 0);
    }
    const parent = bodyPos(b.parent_body_id, tick, new THREE.Vector3());
    const ang = (b.angle0 ?? 0) + (tick / Math.max(1, b.orbit_period)) * Math.PI * 2;
    const rr = orbitR(b.orbit_radius)
      + (bodyR.get(b.parent_body_id) ?? 0) + (bodyR.get(id) ?? 0) + 24;
    return out.set(parent.x + Math.cos(ang) * rr, parent.y,
      parent.z + Math.sin(ang) * rr);
  };

  // ---- the fleet -------------------------------------------------------
  const LENGTH: Record<string, number> = {
    corvette: 3, frigate: 5, destroyer: 10, freighter: 6, colony: 8,
  };
  const shipMesh = new Map<string, THREE.Mesh>();
  const iconClassOf = (c: string | null): ShipIconClass =>
    (['corvette', 'frigate', 'destroyer', 'freighter', 'colony']
      .includes((c ?? '').toLowerCase())
      ? (c as string).toLowerCase() : 'corvette') as ShipIconClass;

  const meshFor = (id: string, sh: ShipRow) => {
    let m = shipMesh.get(id);
    if (!m) {
      const cls = iconClassOf(sh.cls);
      m = new THREE.Mesh(shipGeometry(cls, sh.iv), [
        platedHullMaterial(colorOfFaction(sh.fid), sh.iv),
        platedHullMaterial(color2OfFaction(sh.fid), sh.iv, true),
      ]);
      m.scale.setScalar(LENGTH[cls] ?? 3);
      m.layers.enable(RIM_LAYER);
      const prof = hullProfile(cls, sh.iv);
      attachLivery(m, prof.halfBeam, prof.halfHeight,
        hullDecalMaterial('', colorOfFaction(sh.fid), color2OfFaction(sh.fid),
          String(100 + (hashStr(id) % 900))),
        stripeMaterial(colorOfFaction(sh.fid), color2OfFaction(sh.fid)));
      scene.add(m);
      shipMesh.set(id, m);
    }
    return m;
  };

  /** A hull's berth in its parent's harbour: hashed ring, per-faction arc. */
  const berth = (id: string, sh: ShipRow, tick: number, out: THREE.Vector3) => {
    const parent = sh.parent ?? bodies.find(b => b.type === 'star')?.id;
    bodyPos(parent ?? '', tick, out);
    const j = mulberry32(hashStr(id));
    const fidArc = (hashStr(sh.fid ?? 'n') % 628) / 100;
    const ang = fidArc + j() * 1.6 + tick * 0.002;
    const rr = (bodyR.get(parent ?? '') ?? 10) + 14 + j() * 16;
    out.x += Math.cos(ang) * rr;
    out.y += (j() - 0.5) * 8;
    out.z += Math.sin(ang) * rr;
    return out;
  };

  // ---- rows + worlds ---------------------------------------------------
  //
  // Keyframe checkpoints let the scrubber jump: worldAt(t) replays from
  // the nearest checkpoint, never from the beginning.
  const allRows: SnapshotRow[] = [];
  const checkpoints = new Map<number, MatchWorld>();
  const applyRows = (rows: SnapshotRow[]) => {
    for (const r of rows) {
      if (allRows.length && r.t <= allRows[allRows.length - 1].t) continue;
      allRows.push(r);
    }
  };
  const worldAt = (tick: number): MatchWorld => {
    let base: MatchWorld | null = null; let baseTick = -1;
    for (const [t, w] of checkpoints) {
      if (t <= tick && t > baseTick) { base = w; baseTick = t; }
    }
    const w = new MatchWorld();
    if (base) {
      w.ships = new Map(base.ships); w.stls = new Map(base.stls);
      w.stock = new Map(base.stock); w.pacts = new Map(base.pacts);
      w.synthetic = base.synthetic;
    }
    for (const r of allRows) {
      if (r.t <= baseTick || r.t > tick) continue;
      w.apply(r);
      if (r.kind === 'key' && !checkpoints.has(r.t)) {
        const cp = new MatchWorld();
        cp.ships = new Map(w.ships); cp.stls = new Map(w.stls);
        cp.stock = new Map(w.stock); cp.pacts = new Map(w.pacts);
        cp.synthetic = w.synthetic;
        checkpoints.set(r.t, cp);
      }
    }
    return w;
  };

  // ---- effects ---------------------------------------------------------
  const bb = new Billboards(scene);
  const tr = new Tracers(scene);

  // ---- composer --------------------------------------------------------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1280, 720), 0.5, 0.7, 0.86));
  composer.addPass(new OutputPass());
  function resize(w: number, h: number) {
    const pr = Math.min(2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
    composer.setPixelRatio(pr); composer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  resize(canvas.width || 1280, canvas.height || 720);

  // ---- the director ----------------------------------------------------
  //
  // Same grammar as the battle film at campaign tempo: a shot list over
  // the whole timeline, minimum hold per take, every take a slow move.
  // Events pull the camera to a world; quiet stretches get the system
  // wide, because an empire spreading across a map IS the wide shot.
  const MIN_SHOT_TICKS = 12;
  let events: MatchEvent[] = [];
  type Shot = { from: number; to: number; kind: 'wide' | 'body';
    bodyId: string | null };
  let shots: Shot[] = [];
  const rebuildShots = () => {
    events = mineEvents(allRows, summary);
    shots = [];
    const lo = summary.ticks.lo ?? 0, hi = summary.ticks.hi ?? lo;
    let cursor = lo;
    while (cursor <= hi) {
      const end = cursor + MIN_SHOT_TICKS;
      const inWindow = events.filter(e => e.tick >= cursor && e.tick < end);
      const best = inWindow.sort((a, b) => b.weight - a.weight)[0];
      shots.push(best && best.bodyId
        ? { from: cursor, to: end, kind: 'body', bodyId: best.bodyId }
        : { from: cursor, to: end, kind: 'wide', bodyId: null });
      cursor = end;
    }
  };

  const camP = new THREE.Vector3(), camL = new THREE.Vector3();
  const aim = (tick: number, frac: number) => {
    if (!shots.length) rebuildShots();
    const pos = tick + frac;
    const shot = shots.find(s => pos >= s.from && pos < s.to)
      ?? shots[shots.length - 1];
    if (!shot) return;
    const u = Math.max(0, Math.min(1, (pos - shot.from) / (shot.to - shot.from)));
    if (shot.kind === 'body' && shot.bodyId && bodyR.has(shot.bodyId)) {
      const P = bodyPos(shot.bodyId, pos, new THREE.Vector3());
      const R = bodyR.get(shot.bodyId)!;
      const ang = u * 0.5 + hashStr(shot.bodyId) % 6;
      camP.set(P.x + Math.cos(ang) * R * 4.4, P.y + R * 1.6,
        P.z + Math.sin(ang) * R * 4.4);
      camL.copy(P);
    } else {
      // The wide: high over the ecliptic, drifting, the sun anchoring
      // one third and the outer system falling away.
      const sweep = pos * 0.004;
      camP.set(Math.cos(sweep) * 1500, 700 + Math.sin(pos * 0.01) * 80,
        Math.sin(sweep) * 1500);
      camL.set(0, 0, 0);
    }
    camera.position.lerp(camP, u < 0.05 ? 1 : 0.12);
    camera.lookAt(camL);
  };

  // ---- per-frame -------------------------------------------------------
  let lastWorldTick = -1;
  let world = new MatchWorld();
  const tmp = new THREE.Vector3();

  const setTick = (tick: number, frac: number) => {
    if (tick !== lastWorldTick) {
      world = worldAt(tick);
      lastWorldTick = tick;
    }
    aim(tick, frac);

    for (const [, g] of bodyMesh) g.visible = true;
    for (const b of bodies) {
      const g = bodyMesh.get(b.id)!;
      bodyPos(b.id, tick + frac, tmp);
      g.position.copy(tmp);
      if (b.destroyed_at_tick != null && tick >= b.destroyed_at_tick) {
        g.visible = false;
      }
    }

    bb.begin(); tr.begin();
    for (const m of shipMesh.values()) m.visible = false;
    for (const [id, sh] of world.ships) {
      const m = meshFor(id, sh);
      berth(id, sh, tick + frac, tmp);
      m.position.copy(tmp);
      // Prograde around the harbour: face the direction the berth arc
      // carries the hull.
      m.lookAt(berth(id, sh, tick + frac + 0.5, new THREE.Vector3()));
      m.rotateY(-Math.PI / 2);
      m.visible = true;
      // A small idle burn keeps the fleet alive; drawPlume scales fine.
      const len = m.scale.x;
      m.updateMatrixWorld();
      const aft = new THREE.Vector3(-1, 0, 0)
        .transformDirection(m.matrixWorld).negate();
      for (const bell of engineBells(iconClassOf(sh.cls), sh.iv)) {
        drawPlume(tr, bb, m.localToWorld(bell.clone()), aft, len * 0.4,
          colorOfFaction(sh.fid), 0.3, camera, (tick + frac) * 900);
      }
    }

    // Losses flash: any event at this tick with a body gets a blast at
    // that body's harbour — the campaign-scale read of "a fight".
    for (const e of events) {
      if (e.tick !== tick || (e.kind !== 'loss' && e.kind !== 'battle')) continue;
      if (!e.bodyId || !bodyR.has(e.bodyId)) continue;
      bodyPos(e.bodyId, tick + frac, tmp);
      const R = bodyR.get(e.bodyId)!;
      tmp.x += R * 1.5;
      drawBlast(bb, tmp, Math.min(1, frac), R * 0.5, hashStr(e.bodyId + e.tick));
    }
    bb.end(); tr.end();
  };

  return {
    setTick,
    render: () => composer.render(),
    resize,
    applyRows: (rows) => { applyRows(rows); rebuildShots(); },
    dispose: () => { renderer.dispose(); composer.dispose(); },
    worldAt,
  };
}
