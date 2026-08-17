// ============================================================
// Warships, built as warships — and not all built the same way.
//
// The first pipeline extruded each ship's 2D map icon into 3D and made
// lumps: a plan-view silhouette given thickness is a PLAN VIEW GIVEN
// THICKNESS, and real ships read as ships because of what sits ON the
// axis. So the second pipeline assembled them from primitives to a
// fixed anatomy — prow, hull, spine, tower, engines — which fixed that
// and introduced the next problem: EVERY SHIP WAS THE SAME SHIP. One
// anatomy scaled across five classes and nineteen variants gave a fleet
// that read as one hull at three sizes, and reviewers said so in those
// words ("an instanced array, not a fleet").
//
// So hulls now come in ARCHETYPES, each a different way of building a
// spaceship, drawn from the shapes the genre actually uses:
//
//   wedge        a dagger slab with an offset tower   (Star Destroyer)
//   spinal       a cylinder core slung between two outrigger nacelles
//                on pylons                            (Pelta, Normandy)
//   catamaran    twin hulls bridged by a command deck
//   dreadnought  a heavy centre hull under a dorsal turret line, with
//                sponsons and a bow gun               (Yamato)
//   hauler       an open spine carrying a container stack
//
// CLASS decides which archetypes are plausible and how heavily the ship
// is fitted out; the VARIANT LETTER picks one of them and seeds every
// random choice. Two corvettes of different variants are therefore
// different ships, not the same ship with the greebles moved.
//
// Everything is merged into one geometry with primitive UVs intact, so
// a tiling plate texture lands correctly on every face.
//
// Engine bells, gun mounts and the hull envelope are all produced BY
// THE BUILDER that made the geometry, and cached beside it. They used
// to be derived independently from the class table, which meant a
// plume could come out of a hull that had no engine there.
// ============================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hashStr, mulberry32 } from '../render/planetTexture';
import type { ShipIconClass, ShipIconVariant } from '../components/ShipIcons';

type Archetype = 'wedge' | 'spinal' | 'catamaran' | 'dreadnought' | 'hauler';

interface ClassSpec {
  /** Length relative to beam. */
  slender: number;
  /** How heavily the hull is fitted out. */
  greebles: number;
  /** Which shapes this class is ever built in, in preference order. */
  forms: Archetype[];
}

const SPEC: Record<ShipIconClass, ClassSpec> = {
  corvette:  { slender: 7.0, greebles: 5,  forms: ['spinal', 'wedge', 'catamaran'] },
  frigate:   { slender: 5.8, greebles: 11, forms: ['catamaran', 'spinal', 'wedge'] },
  destroyer: { slender: 4.6, greebles: 22, forms: ['dreadnought', 'wedge', 'catamaran'] },
  freighter: { slender: 4.2, greebles: 8,  forms: ['hauler', 'spinal'] },
  colony:    { slender: 3.6, greebles: 6,  forms: ['hauler', 'dreadnought'] },
};

/** Everything a built hull knows about itself, in unit-length space. */
interface Built {
  geo: THREE.BufferGeometry;
  bells: THREE.Vector3[];
  mounts: THREE.Vector3[];
  halfBeam: number;
  halfHeight: number;
}

const cache = new Map<string, Built>();

// ---- primitives ---------------------------------------------------------

function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** A round hull section running along X. */
function tube(len: number, rAft: number, rFwd: number,
              x: number, y: number, z: number, seg = 14) {
  const g = new THREE.CylinderGeometry(rFwd, rAft, len, seg);
  g.rotateZ(-Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/**
 * A slab hull: four-sided so the flanks are flat plate that catches the
 * key as a broad face, the way a capital ship does.
 */
function slab(len: number, beamAft: number, beamFwd: number, height: number) {
  const g = new THREE.CylinderGeometry(beamFwd, beamAft, len, 4, 1, false);
  g.rotateZ(-Math.PI / 2);
  g.rotateX(Math.PI / 4);
  g.scale(1, height, 1);
  return g;
}

/**
 * Hardware bolted along the deck and flanks; never on the prow.
 *
 * Three authored parts rather than random boxes, and every flank piece
 * placed as a MIRRORED PAIR. Warships are symmetrical and their fittings
 * are repeated stock items; a scatter of one-off blocks at random sizes
 * is the thing a reviewer identified instantly as "procedural sprinkle
 * rather than authored hardware". The randomness now chooses WHICH part
 * goes WHERE, not what a part looks like.
 */
function greeble(parts: THREE.BufferGeometry[], n: number,
                 L: number, B: number, H: number, rnd: () => number) {
  /** A turret: barbette ring with a barrel over it. */
  const turret = (x: number, z: number, s: number) => {
    // Plinth, barbette, barrel. A gun sitting straight on the deck reads
    // as a crate; the raised base is what makes a pair look installed.
    parts.push(box(L * 0.055 * s, H * 0.06, B * 0.16 * s, x, H * 0.5 + H * 0.03, z));
    parts.push(tube(H * 0.2 * s, B * 0.09 * s, B * 0.085 * s, x, H * 0.5 + H * 0.15 * s, z, 10));
    parts.push(box(L * 0.05 * s, H * 0.07 * s, B * 0.05 * s,
      x + L * 0.03 * s, H * 0.5 + H * 0.25 * s, z));
  };
  /** A radiator: a thin flat panel proud of the flank. */
  const radiator = (x: number, z: number, s: number) => {
    parts.push(box(L * 0.09 * s, H * 0.035, B * 0.3 * s, x, -H * 0.05, z));
  };
  /** A sensor: a short mast with a dish block on top. */
  const sensor = (x: number, z: number, s: number) => {
    parts.push(box(L * 0.008, H * 0.24 * s, B * 0.02, x, H * 0.5 + H * 0.12 * s, z));
    parts.push(box(L * 0.022 * s, H * 0.05, B * 0.075 * s, x, H * 0.5 + H * 0.25 * s, z));
  };

  const pairs = Math.max(1, Math.round(n / 2));
  for (let i = 0; i < pairs; i++) {
    // Spread down the hull rather than clustering wherever rnd landed.
    const x = -L * 0.4 + ((i + 0.5) / pairs) * L * 0.68 + (rnd() - 0.5) * L * 0.03;
    const s = 0.85 + rnd() * 0.4;
    const pick = rnd();
    if (pick < 0.45) {
      // Turrets straddle the centreline in pairs.
      const z = B * (0.14 + rnd() * 0.16);
      turret(x, z, s); turret(x, -z, s);
    } else if (pick < 0.78) {
      const z = B * (0.46 + rnd() * 0.1);
      radiator(x, z, s); radiator(x, -z, s);
    } else {
      const z = B * (0.1 + rnd() * 0.12);
      sensor(x, z, s); sensor(x, -z, s);
    }
  }
}

/** The stepped command block that most says "capital ship" in profile. */
function tower(parts: THREE.BufferGeometry[],
               L: number, B: number, H: number, height: number, x: number) {
  // Capped against LENGTH, not just height. Scaling a tower off hull
  // height alone works until a class is stubby: the dreadnought is the
  // tallest and shortest hull in the fleet, so H * 1.7 put a tower on it
  // that was 21% of the whole ship and read, at hero scale, as an office
  // block on a barge. A conning tower is a small fraction of the ship in
  // every reference; this keeps it there whatever the proportions.
  // Tighter again. L * 0.05 still left the wedge tower at 0.83x hull
  // depth and 0.46 of the beam; the Star Destroyer target is nearer a
  // fifth of depth and a sixth of beam. A bridge is a small box on a big
  // ship, and every time this has been generous the ship has looked
  // smaller for it.
  const th = Math.min(H * height, L * 0.026);
  parts.push(box(L * 0.13, th, B * 0.2, x, H * 0.5 + th * 0.5, 0));
  parts.push(box(L * 0.07, th * 0.55, B * 0.13, x + L * 0.012, H * 0.5 + th * 1.28, 0));
  parts.push(box(L * 0.01, th * 0.45, B * 0.025, x - L * 0.02, H * 0.5 + th * 1.78, 0));
}

// ---- archetypes ---------------------------------------------------------
//
// Each returns its parts plus where its engines and guns ended up. All
// work in "beam units": length L along X, beam B = 1 across Z, height H.

interface Frame {
  /** Structure. Wears the faction's primary. */
  parts: THREE.BufferGeometry[];
  /**
   * Trim: towers, nacelles, bells, turrets, fins, containers, greebles.
   * Wears the faction's secondary livery.
   *
   * This split is not invented here — it is the rule the 2D ship icons
   * already use ("the hull is painted in the primary; every DETAIL
   * element is painted in the secondary"), so a ship reads the same two
   * tones on the map and in the cinematic. Ownership meaning stays in
   * the primary for colourblind safety; the secondary is decoration.
   */
  trim: THREE.BufferGeometry[];
  bells: THREE.Vector3[];
  mounts: THREE.Vector3[];
  H: number;
  /** Widest half-beam, which is not B/2 once there are outriggers. */
  halfBeam: number;
}

/** A dagger slab with an offset tower. The classic capital-ship read. */
function buildWedge(L: number, s: ClassSpec, rnd: () => number): Frame {
  const parts: THREE.BufferGeometry[] = [];
  const trim: THREE.BufferGeometry[] = [];
  const B = 1, H = 0.42;
  const prowLen = L * 0.34;
  const prow = slab(prowLen, B * 0.82, B * 0.14, H * 0.92);
  prow.translate(L * 0.5 - prowLen * 0.5, 0, 0);
  parts.push(prow);
  const bodyLen = L - prowLen;
  const body = slab(bodyLen, B, B * 0.84, H);
  body.translate(L * 0.5 - prowLen - bodyLen * 0.5, 0, 0);
  parts.push(body);
  parts.push(box(L * 0.7, H * 0.34, B * 0.3, -L * 0.06, H * 0.5, 0));
  tower(trim, L, B, H, 0.95 + rnd() * 0.5, -L * (0.2 + rnd() * 0.06));

  const bells: THREE.Vector3[] = [];
  const eN = 3 + Math.floor(rnd() * 2);
  for (let i = 0; i < eN; i++) {
    const z = (i / (eN - 1) - 0.5) * B * 0.92;
    trim.push(tube(L * 0.1, B * 0.15, B * 0.13, -L * 0.45, -H * 0.05, z, 12));
    bells.push(new THREE.Vector3(-L * 0.5, -H * 0.05, z));
  }
  greeble(trim, s.greebles, L, B, H, rnd);

  const mounts: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const x = L * (0.3 - i * 0.18);
    mounts.push(i % 2 === 0
      ? new THREE.Vector3(x, H * 0.7, B * (0.16 + rnd() * 0.2))
      : new THREE.Vector3(x, -H * 0.12, B * 0.5));
  }
  return { parts, trim, bells, mounts, H, halfBeam: B * 0.5 };
}

/**
 * A cylinder core slung between two outrigger nacelles on pylons. The
 * silhouette everyone reads as a frigate — Pelta, Normandy, Rocinante.
 */
function buildSpinal(L: number, s: ClassSpec, rnd: () => number): Frame {
  const parts: THREE.BufferGeometry[] = [];
  const trim: THREE.BufferGeometry[] = [];
  const B = 1, H = 0.5;
  const R = B * 0.24;
  // Core: a long pressure hull with a tapered nose cap.
  parts.push(tube(L * 0.78, R, R * 0.92, -L * 0.03, 0, 0, 16));
  parts.push(tube(L * 0.22, R * 0.9, R * 0.16, L * 0.44, 0, 0, 16));
  // Dorsal sensor spine and a low bridge fairing on top of the core.
  parts.push(box(L * 0.36, R * 0.5, B * 0.2, -L * 0.08, R * 0.9, 0));
  trim.push(box(L * 0.1, R * 0.7, B * 0.26, -L * 0.16, R * 1.3, 0));
  trim.push(box(L * 0.01, R * 1.5, B * 0.02, -L * 0.22, R * 2.2, 0));

  // Outriggers: pylon out and back, then the nacelle itself.
  const spread = B * (0.62 + rnd() * 0.18);
  const nacLen = L * (0.46 + rnd() * 0.12);
  const nacR = B * 0.15;
  const nacX = -L * 0.16;
  const bells: THREE.Vector3[] = [];
  for (const side of [1, -1]) {
    trim.push(box(L * 0.13, R * 0.36, spread * 0.9, L * 0.02, -R * 0.2, side * spread * 0.5));
    parts.push(tube(nacLen, nacR, nacR * 0.8, nacX, -R * 0.2, side * spread, 12));
    // The bell, flared.
    trim.push(tube(L * 0.05, nacR * 1.25, nacR * 0.95,
      nacX - nacLen * 0.5, -R * 0.2, side * spread, 12));
    bells.push(new THREE.Vector3(nacX - nacLen * 0.52, -R * 0.2, side * spread));
  }
  greeble(trim, Math.round(s.greebles * 0.7), L, B, H, rnd);

  const mounts: THREE.Vector3[] = [];
  for (let i = 0; i < 3; i++) {
    const x = L * (0.26 - i * 0.2);
    mounts.push(i % 2 === 0
      ? new THREE.Vector3(x, R * 1.2, B * 0.1)
      : new THREE.Vector3(x, -R * 0.5, R * 0.9));
  }
  return { parts, trim, bells, mounts, H, halfBeam: spread + nacR };
}

/** Twin hulls bridged by a command deck. Reads wide from every angle. */
function buildCatamaran(L: number, s: ClassSpec, rnd: () => number): Frame {
  const parts: THREE.BufferGeometry[] = [];
  const trim: THREE.BufferGeometry[] = [];
  const B = 1, H = 0.4;
  const sep = B * (0.42 + rnd() * 0.14);
  const hullLen = L * 0.92;
  const bells: THREE.Vector3[] = [];
  for (const side of [1, -1]) {
    const h = slab(hullLen, B * 0.42, B * 0.1, H * 0.85);
    h.translate(-L * 0.02, 0, side * sep);
    parts.push(h);
    // Two bells per hull, stacked.
    for (const dy of [H * 0.14, -H * 0.14]) {
      trim.push(tube(L * 0.09, B * 0.1, B * 0.085, -L * 0.44, dy, side * sep, 10));
      bells.push(new THREE.Vector3(-L * 0.49, dy, side * sep));
    }
  }
  // The deck that makes them one ship, and the bridge on it.
  parts.push(box(L * 0.42, H * 0.3, sep * 2.05, -L * 0.08, 0, 0));
  tower(trim, L, B, H, 0.7 + rnd() * 0.4, -L * (0.1 + rnd() * 0.08));
  // A spinal gun bridging the bows is what makes this shape read armed.
  trim.push(box(L * 0.5, H * 0.16, B * 0.12, L * 0.16, H * 0.12, 0));
  greeble(trim, s.greebles, L, B, H, rnd);

  const mounts: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    mounts.push(new THREE.Vector3(L * (0.26 - i * 0.16),
      i % 2 === 0 ? H * 0.55 : -H * 0.2, sep + B * 0.18));
  }
  return { parts, trim, bells, mounts, H, halfBeam: sep + B * 0.21 };
}

/**
 * A heavy centre hull under a dorsal line of turrets, with sponsons out
 * of the flanks and a bow gun. The shape that should look expensive.
 */
function buildDreadnought(L: number, s: ClassSpec, rnd: () => number): Frame {
  const parts: THREE.BufferGeometry[] = [];
  const trim: THREE.BufferGeometry[] = [];
  const B = 1, H = 0.56;
  const body = slab(L * 0.86, B, B * 0.7, H);
  body.translate(-L * 0.05, 0, 0);
  parts.push(body);
  const prow = slab(L * 0.2, B * 0.68, B * 0.18, H * 0.8);
  prow.translate(L * 0.44, 0, 0);
  parts.push(prow);
  // Bow gun, down the centreline and proud of the prow.
  trim.push(tube(L * 0.3, B * 0.07, B * 0.055, L * 0.4, H * 0.1, 0, 10));

  // Dorsal turret line: the single most identifiable thing about this
  // archetype, so it is real geometry rather than greebling.
  const mounts: THREE.Vector3[] = [];
  const tN = 4;
  for (let i = 0; i < tN; i++) {
    const x = L * (0.24 - i * 0.16);
    trim.push(tube(H * 0.22, B * 0.16, B * 0.15, x, H * 0.56, 0, 10));
    trim.push(box(L * 0.11, H * 0.13, B * 0.14, x + L * 0.03, H * 0.68, 0));
    mounts.push(new THREE.Vector3(x, H * 0.75, B * 0.07));
  }
  tower(trim, L, B, H, 1.5 + rnd() * 0.4, -L * (0.16 + rnd() * 0.06));

  // Sponsons out of the flanks, each with its own drive.
  const bells: THREE.Vector3[] = [];
  for (const side of [1, -1]) {
    trim.push(tube(L * 0.34, B * 0.17, B * 0.13, -L * 0.24, -H * 0.1, side * B * 0.56, 12));
    bells.push(new THREE.Vector3(-L * 0.41, -H * 0.1, side * B * 0.56));
    mounts.push(new THREE.Vector3(L * 0.05, -H * 0.05, side * B * 0.72));
  }
  // Main bank, in the centre.
  for (let i = 0; i < 3; i++) {
    const z = (i - 1) * B * 0.3;
    trim.push(tube(L * 0.1, B * 0.19, B * 0.16, -L * 0.44, -H * 0.04, z, 12));
    bells.push(new THREE.Vector3(-L * 0.5, -H * 0.04, z));
  }
  greeble(trim, s.greebles, L, B, H, rnd);
  return { parts, trim, bells, mounts, H, halfBeam: B * 0.73 };
}

/** An open spine carrying a container stack. Civilian, and looks it. */
function buildHauler(L: number, s: ClassSpec, rnd: () => number): Frame {
  const parts: THREE.BufferGeometry[] = [];
  const trim: THREE.BufferGeometry[] = [];
  const B = 1, H = 0.62;
  // Tug up front, spine down the middle, drive block at the back.
  parts.push(slab(L * 0.22, B * 0.6, B * 0.42, H * 0.7).translate(L * 0.39, 0, 0));
  // A CONTINUOUS KEEL, bow to stern, with cross-braces. The modules used
  // to sit near a short spine with visible daylight between them, and two
  // reviewers running read the result as cargo flying in formation rather
  // than as one vessel.
  parts.push(box(L * 0.94, H * 0.24, B * 0.26, -L * 0.02, 0, 0));
  parts.push(box(L * 0.9, H * 0.08, B * 0.5, -L * 0.02, -H * 0.06, 0));
  for (let i = 0; i < 4; i++) {
    parts.push(box(L * 0.02, H * 0.5, B * 0.46, -L * 0.3 + i * L * 0.2, H * 0.16, 0));
  }
  parts.push(slab(L * 0.24, B * 0.86, B * 0.7, H * 0.9).translate(-L * 0.38, 0, 0));
  tower(trim, L, B, H * 0.7, 0.8, L * 0.33);

  // The load: stacked containers, deliberately uneven so two haulers
  // never look like the same delivery.
  const rows = 3, cols = 2;
  for (let i = 0; i < rows * cols; i++) {
    if (rnd() < 0.16) continue;
    const cx = -L * 0.24 + (i % rows) * L * 0.19;
    const cz = (Math.floor(i / rows) - 0.5) * B * 0.42;
    // Seated ON the keel, not hovering over it.
    const ch = H * (0.5 + rnd() * 0.22);
    trim.push(box(L * 0.17, ch, B * 0.36, cx, H * 0.12 + ch * 0.5, cz));
  }
  // Radiator fins, because a hauler is all thermal mass.
  for (let i = 0; i < 4; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    trim.push(box(L * (0.12 + rnd() * 0.1), H * 0.05, B * 0.5,
      -L * (0.05 + rnd() * 0.2), 0, side * B * 0.5));
  }
  greeble(trim, s.greebles, L, B, H, rnd);

  const bells: THREE.Vector3[] = [];
  for (const z of [B * 0.24, -B * 0.24]) {
    trim.push(tube(L * 0.09, B * 0.2, B * 0.17, -L * 0.46, 0, z, 12));
    bells.push(new THREE.Vector3(-L * 0.51, 0, z));
  }
  const mounts = [
    new THREE.Vector3(L * 0.3, H * 0.5, B * 0.16),
    new THREE.Vector3(-L * 0.3, H * 0.5, B * 0.16),
  ];
  return { parts, trim, bells, mounts, H, halfBeam: B * 0.5 };
}

const BUILD: Record<Archetype, (L: number, s: ClassSpec, r: () => number) => Frame> = {
  wedge: buildWedge,
  spinal: buildSpinal,
  catamaran: buildCatamaran,
  dreadnought: buildDreadnought,
  hauler: buildHauler,
};

/** Which shape a given variant of a given class is built in. */
export function archetypeOf(cls: ShipIconClass, variant: ShipIconVariant): Archetype {
  const s = SPEC[cls] ?? SPEC.corvette;
  const i = variant.charCodeAt(0) - 65;
  return s.forms[((i % s.forms.length) + s.forms.length) % s.forms.length];
}

function build(cls: ShipIconClass, variant: ShipIconVariant): Built {
  const key = `${cls}:${variant}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const s = SPEC[cls] ?? SPEC.corvette;
  const rnd = mulberry32(hashStr(key));
  const L = s.slender;
  const frame = BUILD[archetypeOf(cls, variant)](L, s, rnd);

  // TWO GROUPS, always in this order: 0 = structure, 1 = trim. The
  // caller hands in a two-element material array, so the faction's
  // primary and secondary land on the right halves of the ship without
  // anything here knowing what colour either one is.
  const hull = mergeGeometries(frame.parts, false) ?? frame.parts[0];
  for (const p of frame.parts) if (p !== hull) p.dispose();
  const trimGeo = frame.trim.length
    ? mergeGeometries(frame.trim, false) : null;
  for (const p of frame.trim) if (p !== trimGeo) p.dispose();
  // A hull with no trim still gets a second, empty group, so the two
  // material slots mean the same thing on every ship in the fleet.
  const merged = trimGeo
    ? (mergeGeometries([hull, trimGeo], true) ?? hull)
    : (() => { hull.addGroup(0, Infinity, 0); hull.addGroup(0, 0, 1); return hull; })();
  if (trimGeo && merged !== hull) { hull.dispose(); trimGeo.dispose(); }

  merged.computeBoundingBox();
  const bb = merged.boundingBox!;
  const c = bb.getCenter(new THREE.Vector3());
  merged.translate(-c.x, -c.y, -c.z);
  const len = Math.max(1e-3, bb.max.x - bb.min.x);
  const k = 1 / len;
  merged.scale(k, k, k);
  merged.computeVertexNormals();
  merged.computeBoundingSphere();

  // The hardpoints came out of the same builder, so they move to unit
  // space by exactly the same transform the geometry did.
  const toUnit = (v: THREE.Vector3) => v.sub(c).multiplyScalar(k);
  const out: Built = {
    geo: merged,
    bells: frame.bells.map(toUnit),
    mounts: frame.mounts.map(v => {
      const u = toUnit(v);
      u.z = Math.abs(u.z);       // callers mirror toward the target
      return u;
    }),
    halfBeam: frame.halfBeam * k,
    halfHeight: frame.H * 0.5 * k,
  };
  cache.set(key, out);
  return out;
}

export function shipGeometry(
  cls: ShipIconClass, variant: ShipIconVariant,
): THREE.BufferGeometry {
  return build(cls, variant).geo;
}

/** Where the engine bells sit, in unit-length local space. */
export function engineBells(
  cls: ShipIconClass, variant: ShipIconVariant,
): THREE.Vector3[] {
  return build(cls, variant).bells.map(v => v.clone());
}

/**
 * Gun stations, in unit-length local space, all on the +Z beam.
 *
 * The hull never turns — guns traverse, ships do not — so the caller
 * mirrors Z toward whatever is being shot at, which is the same thing
 * as a turret slewing round.
 */
export function turretMounts(
  cls: ShipIconClass, variant: ShipIconVariant,
): THREE.Vector3[] {
  return build(cls, variant).mounts.map(v => v.clone());
}

/** How far out the flanks and the deck are, for landing a hit ON a ship. */
export function hullProfile(
  cls: ShipIconClass, variant: ShipIconVariant,
): { halfBeam: number; halfHeight: number } {
  const b = build(cls, variant);
  return { halfBeam: b.halfBeam, halfHeight: b.halfHeight };
}

export function disposeShips(): void {
  for (const b of cache.values()) b.geo.dispose();
  cache.clear();
}
