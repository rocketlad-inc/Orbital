// ============================================================
// Warships, built as warships.
//
// The previous pipeline extruded each ship's 2D map icon into 3D. It
// was elegant — ninety-five hulls for no art budget, guaranteed never
// to drift from the icons — and it produced lumps. Reviewers called
// them balloon animals, a brass sofa, a bath toy. They were right, and
// the reason is structural: a plan-view silhouette given thickness is a
// PLAN VIEW GIVEN THICKNESS. Real ships read as ships because of what
// sits ON the axis — a prow, a spine, a superstructure offset from it,
// an engine bank at the stern, hardware bolted along the flanks. None
// of that exists in a top-down icon, so no amount of bevelling or
// texturing could put it back.
//
// So these are assembled from primitives instead, to a fixed anatomy
// borrowed from the ships everyone already pictures: the dagger hull
// and offset command tower of a Star Destroyer, the utilitarian ribbed
// spine and exposed drive cones of an Expanse warship.
//
//   prow -> forward hull -> spine -> superstructure -> engine bank
//
// The icon still decides WHICH ship this is: class sets the proportions
// and the hardware count, and the variant letter seeds every random
// choice, so a given ship looks the same every time it is drawn and no
// two variants look alike. The link to the icon is now thematic rather
// than geometric, which is the trade being made deliberately.
//
// Everything is merged into one geometry with primitive UVs intact, so
// a tiling plate texture lands correctly on every face.
// ============================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hashStr, mulberry32 } from '../render/planetTexture';
import type { ShipIconClass, ShipIconVariant } from '../components/ShipIcons';

/** Nose sits at +X. Everything is normalised to unit length at the end. */
interface ClassSpec {
  /** Length relative to beam: destroyers are long, freighters are not. */
  slender: number;
  /** How far the prow tapers to a point (0 blunt, 1 needle). */
  point: number;
  engines: number;
  /** Height of the command superstructure, relative to hull height. */
  tower: number;
  greebles: number;
  /** Radiator/solar fins out of the flanks. */
  fins: number;
  /** Blocky cargo spine instead of a warship's tapered one. */
  freighter?: boolean;
}

const SPEC: Record<ShipIconClass, ClassSpec> = {
  corvette:  { slender: 5.0, point: 0.85, engines: 2, tower: 0.55, greebles: 6,  fins: 0 },
  frigate:   { slender: 5.6, point: 0.7,  engines: 3, tower: 0.8,  greebles: 10, fins: 2 },
  destroyer: { slender: 6.4, point: 0.62, engines: 4, tower: 1.15, greebles: 16, fins: 2 },
  freighter: { slender: 4.2, point: 0.25, engines: 2, tower: 0.6,  greebles: 8,  fins: 4,
               freighter: true },
  colony:    { slender: 3.6, point: 0.2,  engines: 2, tower: 0.5,  greebles: 6,  fins: 6,
               freighter: true },
};

const cache = new Map<string, THREE.BufferGeometry>();

function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/**
 * The hull of a warship: a long tapered body whose beam narrows toward
 * the bow. Built as a 4-sided prism so the flanks are flat plate that
 * catches the key light as a broad face, the way a capital ship does.
 */
function taperedHull(len: number, beamAft: number, beamFwd: number, height: number) {
  const g = new THREE.CylinderGeometry(beamFwd, beamAft, len, 4, 1, false);
  // Cylinder runs along Y; lay it along X, and flatten it so the section
  // is wide and shallow rather than square.
  g.rotateZ(-Math.PI / 2);
  g.rotateX(Math.PI / 4);
  g.scale(1, height, 1);
  return g;
}

export function shipGeometry(
  cls: ShipIconClass, variant: ShipIconVariant,
): THREE.BufferGeometry {
  const key = `${cls}:${variant}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const s = SPEC[cls] ?? SPEC.corvette;
  const rnd = mulberry32(hashStr(key));
  const parts: THREE.BufferGeometry[] = [];

  const L = s.slender;              // total length in beam-units
  const B = 1;                      // beam
  const H = s.freighter ? 0.62 : 0.42;

  // ---- prow ------------------------------------------------------------
  const prowLen = L * (s.freighter ? 0.16 : 0.34);
  const prow = taperedHull(prowLen, B * 0.82, B * (1 - s.point) * 0.8 + 0.06, H * 0.92);
  prow.translate(L * 0.5 - prowLen * 0.5, 0, 0);
  parts.push(prow);

  // ---- main hull -------------------------------------------------------
  const bodyLen = L - prowLen;
  const body = taperedHull(bodyLen, B, B * 0.84, H);
  body.translate(L * 0.5 - prowLen - bodyLen * 0.5, 0, 0);
  parts.push(body);

  // ---- dorsal spine ----------------------------------------------------
  // A raised ridge running most of the length. It is what stops the
  // silhouette being one smooth extrusion from every angle.
  parts.push(box(L * 0.7, H * 0.34, B * 0.3, -L * 0.06, H * 0.5, 0));

  // ---- superstructure --------------------------------------------------
  // Offset aft, stepped, with a bridge block on top. This is the single
  // feature that most says "capital ship" in a silhouette.
  const tx = -L * (0.2 + rnd() * 0.06);
  const th = H * s.tower;
  parts.push(box(L * 0.15, th, B * 0.46, tx, H * 0.5 + th * 0.5, 0));
  parts.push(box(L * 0.085, th * 0.55, B * 0.3, tx + L * 0.012,
    H * 0.5 + th + th * 0.28, 0));
  // Sensor mast.
  parts.push(box(L * 0.012, th * 0.7, B * 0.03, tx - L * 0.02,
    H * 0.5 + th * 1.55 + th * 0.35, 0));

  // ---- engine bank -----------------------------------------------------
  const eN = s.engines;
  const eR = B * (s.freighter ? 0.19 : 0.15);
  const eLen = L * 0.1;
  const aft = -L * 0.5;
  for (let i = 0; i < eN; i++) {
    const spread = eN === 1 ? 0 : (i / (eN - 1) - 0.5) * B * 0.92;
    const eg = new THREE.CylinderGeometry(eR, eR * 0.86, eLen, 12);
    eg.rotateZ(Math.PI / 2);
    eg.translate(aft + eLen * 0.42, -H * 0.05, spread);
    parts.push(eg);
  }

  // ---- fins / radiators -------------------------------------------------
  for (let i = 0; i < s.fins; i++) {
    const fx = -L * (0.05 + rnd() * 0.3);
    const side = i % 2 === 0 ? 1 : -1;
    const fw = L * (0.1 + rnd() * 0.12);
    parts.push(box(fw, H * 0.06, B * (0.5 + rnd() * 0.4), fx, 0,
      side * B * (0.62 + rnd() * 0.2)));
  }

  // ---- hardware ---------------------------------------------------------
  // Blocks bolted along the deck and flanks. Small, varied, and never on
  // the prow, so the bow stays clean and the ship still reads sharp.
  for (let i = 0; i < s.greebles; i++) {
    const gx = -L * 0.44 + rnd() * L * 0.74;
    const onTop = rnd() > 0.42;
    const gw = L * (0.02 + rnd() * 0.05);
    const gh = H * (0.15 + rnd() * 0.4);
    const gd = B * (0.08 + rnd() * 0.22);
    if (onTop) {
      parts.push(box(gw, gh, gd, gx, H * 0.5 + gh * 0.4, (rnd() - 0.5) * B * 0.5));
    } else {
      const side = rnd() > 0.5 ? 1 : -1;
      parts.push(box(gw, gh * 0.7, gd, gx, -H * 0.1, side * B * (0.42 + rnd() * 0.12)));
    }
  }

  // Freighters carry their load as a visible stack: the shape reads as a
  // hauler rather than a warship without needing a different anatomy.
  if (s.freighter) {
    for (let i = 0; i < 6; i++) {
      const cx = -L * 0.3 + (i % 3) * L * 0.19;
      const cz = (Math.floor(i / 3) - 0.5) * B * 0.5;
      parts.push(box(L * 0.16, H * 0.7, B * 0.42, cx, H * 0.55, cz));
    }
  }

  const merged = mergeGeometries(parts, false) ?? parts[0];
  for (const p of parts) if (p !== merged) p.dispose();

  merged.computeBoundingBox();
  const bb = merged.boundingBox!;
  const c = bb.getCenter(new THREE.Vector3());
  merged.translate(-c.x, -c.y, -c.z);
  const len = Math.max(1e-3, bb.max.x - bb.min.x);
  merged.scale(1 / len, 1 / len, 1 / len);
  merged.computeVertexNormals();
  merged.computeBoundingSphere();

  cache.set(key, merged);
  return merged;
}

/** Where the engine bells sit, in unit-length local space. */
export function engineBells(cls: ShipIconClass): THREE.Vector3[] {
  const s = SPEC[cls] ?? SPEC.corvette;
  const L = s.slender;
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < s.engines; i++) {
    const spread = s.engines === 1 ? 0 : (i / (s.engines - 1) - 0.5) * 0.92;
    out.push(new THREE.Vector3(-0.5, -0.02, spread / L));
  }
  return out;
}

export function disposeShips(): void {
  for (const g of cache.values()) g.dispose();
  cache.clear();
}
