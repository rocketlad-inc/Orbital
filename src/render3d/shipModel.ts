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
  /**
   * A radiator: a thin panel held CLEAR of the flank on a short arm.
   *
   * These used to be centred at z = 0.46-0.56 with a depth of 0.3, on a
   * hull whose skin is at 0.50 -- so every one of them was half buried,
   * and the buried half fought the hull surface. That produced fixed
   * light rectangles along the flank which survived changes to the
   * albedo, roughness, emissive, environment, normal scale and the
   * lights, because none of those was ever the cause. Geometry that
   * intersects geometry does not care how you shade it.
   */
  const radiator = (x: number, z: number, s: number) => {
    const d = B * 0.26 * s;
    const zc = Math.sign(z) * (B * 0.5 + d * 0.5 + B * 0.04);
    parts.push(box(L * 0.012, H * 0.05, B * 0.09, x, -H * 0.05,
      Math.sign(z) * (B * 0.5 + B * 0.02)));
    parts.push(box(L * 0.09 * s, H * 0.03, d, x, -H * 0.05, zc));
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
      radiator(x, B * 0.5, s); radiator(x, -B * 0.5, s);
    } else {
      const z = B * (0.1 + rnd() * 0.12);
      sensor(x, z, s); sensor(x, -z, s);
    }
  }
}

/**
 * The thrust deck: a recessed aft face carrying shrouded nozzles.
 *
 * Every hull used to simply END — a raw quad with the panel lines
 * running straight off the edge, or an open cylinder cap. Four reviews
 * running named this as the single loudest reason none of them read as
 * powered warships, and they were right: an engine is the one piece of
 * hardware every reference ship has and this fleet had none.
 *
 * Each bell sits in a collar that stands proud of the skin, so a nozzle
 * is never flush with the hull. Returns the bell mouths, which is what
 * the stage hangs its plumes on.
 */
function thrustDeck(
  parts: THREE.BufferGeometry[], trim: THREE.BufferGeometry[],
  n: number, aft: number, r: number, y: number, spread: number,
  L: number, H: number,
): THREE.Vector3[] {
  const bells: THREE.Vector3[] = [];
  // Recessed housing: the deck the bells are sunk into.
  trim.push(box(L * 0.05, H * 0.9, spread * 2 + r * 2.4, aft + L * 0.025, y, 0));
  for (let i = 0; i < n; i++) {
    const z = n === 1 ? 0 : (i / (n - 1) - 0.5) * spread * 2;
    // Collar, proud of the skin, then the bell flaring out of it.
    trim.push(tube(L * 0.03, r * 1.35, r * 1.3, aft + L * 0.012, y, z, 12));
    trim.push(tube(L * 0.035, r * 1.15, r * 0.82, aft - L * 0.012, y, z, 12));
    bells.push(new THREE.Vector3(aft - L * 0.03, y, z));
  }
  return bells;
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
  // Overcorrected the other way: at L * 0.026 nothing on any dorsal rose
  // more than a tenth of hull height and a reviewer reported that no
  // capital ship had a command superstructure at all. A tower should be
  // a small fraction of the SHIP and a large fraction of its HEIGHT.
  const th = Math.max(H * 0.55, Math.min(H * height, L * 0.045));
  parts.push(box(L * 0.14, th, B * 0.24, x, H * 0.5 + th * 0.5, 0));
  parts.push(box(L * 0.08, th * 0.6, B * 0.15, x + L * 0.014, H * 0.5 + th * 1.3, 0));
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

  const bells = thrustDeck(parts, trim, 3 + Math.floor(rnd() * 2),
    -L * 0.5, B * 0.14, -H * 0.05, B * 0.42, L, H);
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
    bells.push(...thrustDeck(parts, trim, 1,
      nacX - nacLen * 0.5, nacR * 0.92, -R * 0.2, 0, L, R * 2));
    // The pod is slung on a pylon, so its deck rides at the pod's Z.
    for (const g of trim.slice(-3)) g.translate(0, 0, side * spread);
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
    const hullBells = thrustDeck(parts, trim, 2, -L * 0.48, B * 0.085, 0, H * 0.16, L, H);
    for (const g of trim.slice(-6)) g.translate(0, 0, side * sep);
    for (const b of hullBells) bells.push(b.setZ(side * sep));
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
  bells.push(...thrustDeck(parts, trim, 4, -L * 0.5, B * 0.17, -H * 0.04, B * 0.34, L, H));
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

  const bells = thrustDeck(parts, trim, 2, -L * 0.5, B * 0.22, 0, B * 0.26, L, H);
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

  // The envelope of the HULL, measured before trim is merged in.
  //
  // Taken off the whole ship it includes the tower, the masts and every
  // turret, so "half height" came out well above the deck and a stripe
  // placed at a fraction of it hovered over the ship rather than lying
  // on the flank. Markings belong on structure, so structure is what
  // gets measured.
  hull.computeBoundingBox();
  const hbb = hull.boundingBox!;
  const hullExtentY = hbb.max.y - hbb.min.y;
  const hullExtentZ = hbb.max.z - hbb.min.z;

  merged.computeBoundingBox();
  const bb = merged.boundingBox!;
  const c = bb.getCenter(new THREE.Vector3());
  // Read the extents BEFORE transforming. translate() and scale() call
  // applyMatrix4, which updates boundingBox in place -- so anything
  // measured from `bb` afterwards has already had the normalisation
  // applied, and scaling it by k again shrinks it by a second factor of
  // the hull's length. That is how the beam ended up seven times too
  // small and the markings vanished inside the ship.
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
    // MEASURED off the merged mesh, not declared by the builder.
    //
    // slab() is a CylinderGeometry, whose radius runs to the VERTEX and
    // not to the face, so a "beam" of B actually reaches B * sqrt(1/2)
    // across -- the builders were understating every hull by 29%. Things
    // placed on the hull surface from those numbers therefore sat well
    // inside it, and the decal only appeared at all because its depth
    // bias punched it back out through the plating, which is exactly
    // what "floating above the ship" looks like. The bounding box cannot
    // be wrong about this.
    halfBeam: hullExtentZ * 0.5 * k,
    halfHeight: hullExtentY * 0.5 * k,
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

// ---- breaking up -------------------------------------------------------

export interface Fragment {
  geo: THREE.BufferGeometry;
  /** Where this piece sat on the intact hull, in unit-length space. */
  offset: THREE.Vector3;
}

const fragCache = new Map<string, Fragment[]>();

/**
 * Cut a hull into pieces along its length.
 *
 * Four review rounds running said the same thing: ships sit inside their
 * own fireballs fully intact and then drift away whole, so a kill has no
 * consequence on screen. A wreck has to come APART.
 *
 * The cut is by triangle centroid, so every triangle lands in exactly
 * one piece and the union of the pieces is the original hull — no gaps,
 * no doubled surfaces, and the cheapest possible thing that is still
 * true to the model. Faces are left open: a warship broken across its
 * spine shows its frames, and closing the cut would read as three
 * smaller ships flying in formation.
 */
export function hullFragments(
  cls: ShipIconClass, variant: ShipIconVariant, n = 3,
): Fragment[] {
  const key = `${cls}:${variant}:${n}`;
  const hit = fragCache.get(key);
  if (hit) return hit;

  const src = build(cls, variant).geo.toNonIndexed();
  const pos = src.getAttribute('position') as THREE.BufferAttribute;
  const nrm = src.getAttribute('normal') as THREE.BufferAttribute | null;
  const uv = src.getAttribute('uv') as THREE.BufferAttribute | null;
  src.computeBoundingBox();
  const bb = src.boundingBox!;
  const x0 = bb.min.x, span = Math.max(1e-6, bb.max.x - x0);

  const buckets: Array<{ p: number[]; n: number[]; u: number[] }> =
    Array.from({ length: n }, () => ({ p: [], n: [], u: [] }));

  for (let t = 0; t < pos.count; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    const b = Math.min(n - 1, Math.max(0, Math.floor(((cx - x0) / span) * n)));
    const bk = buckets[b];
    for (let k = 0; k < 3; k++) {
      bk.p.push(pos.getX(t + k), pos.getY(t + k), pos.getZ(t + k));
      if (nrm) bk.n.push(nrm.getX(t + k), nrm.getY(t + k), nrm.getZ(t + k));
      if (uv) bk.u.push(uv.getX(t + k), uv.getY(t + k));
    }
  }
  src.dispose();

  const out: Fragment[] = [];
  for (const bk of buckets) {
    if (bk.p.length < 9) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(bk.p, 3));
    if (bk.n.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(bk.n, 3));
    if (bk.u.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(bk.u, 2));
    // Recentre each piece on its own middle, so it can be spun about
    // itself rather than about the ship it used to be part of.
    g.computeBoundingBox();
    const c = g.boundingBox!.getCenter(new THREE.Vector3());
    g.translate(-c.x, -c.y, -c.z);
    g.computeBoundingSphere();
    out.push({ geo: g, offset: c });
  }
  fragCache.set(key, out);
  return out;
}
