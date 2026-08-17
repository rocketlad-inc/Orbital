// ============================================================
// Ship hulls, extruded from the icons the game already draws.
//
// The fleet icons are not sprites — every one of them is a handful of
// SVG paths in a 32x32 box (src/components/ShipIcons.tsx). That means
// the 3D ships do not need to be modelled: the silhouette a player has
// been looking at all game IS the plan view of the hull, so it can be
// lifted straight off the icon and given thickness.
//
// Doing it this way is not just cheaper than modelling. It is the only
// version that cannot drift: five classes times nineteen variants is
// ninety-five hulls, and any variant added later gets a 3D model the
// day it gets an icon, with no second asset to keep in sync.
//
// The icons carry a documented convention — the FIRST child of every
// icon is the hull and the rest are detail accents — which is what
// makes the split below reliable rather than a guess.
//
// Axes. The icon is a plan view: +x is the nose, y is the beam, and the
// midline sits at y=16. Geometry is built in the shape's XY plane,
// extruded along its Z, then rotated so length runs along world +X,
// beam along world Z, and thickness along world +Y (up). Everything is
// finally normalised to unit length so a class's size is applied by the
// caller rather than baked into the mesh.
// ============================================================

import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { ShipIcon, ShipIconClass, ShipIconVariant } from '../components/ShipIcons';

/** Thickness of the main hull, in icon units (the box is 32 wide). */
const HULL_DEPTH = 5.2;
/** Detail shapes sit proud of the hull rather than being cut into it. */
const GREEBLE_DEPTH = 7.4;
/**
 * How much of the depth is spent rolling the edge over.
 *
 * Near half, deliberately. A small chamfer leaves a flat deck and a
 * flat keel joined by a vertical wall — the icon cut out of sheet
 * metal. Taking the bevel most of the way to the mid-plane turns the
 * cross-section into a rounded spine, which is what makes an extruded
 * silhouette read as a hull instead of a cutout.
 */
const HULL_ROLL = 0.42;

/**
 * How long each class reads at, relative to a corvette. Applied by the
 * stage, not baked in, so one geometry serves every instance.
 */
export const HULL_LENGTH: Record<ShipIconClass, number> = {
  corvette: 1, frigate: 1.5, destroyer: 2.4, freighter: 1.7, colony: 1.9,
};

const cache = new Map<string, THREE.BufferGeometry>();

/**
 * The icon as standalone SVG markup.
 *
 * Rendered with a non-hex colour on purpose: a hex colour switches the
 * icon into its shaded treatment, which clones the hull into a <defs>
 * clipPath. That clone would then be the first path in document order
 * and the extruder would take the clip, not the hull.
 */
function iconMarkup(cls: ShipIconClass, variant: ShipIconVariant): string {
  return renderToStaticMarkup(
    React.createElement(ShipIcon, {
      shipClass: cls, variant, size: 32, color: 'currentColor',
    }),
  );
}

/** Every closed shape in a path, largest first. */
function shapesOf(path: ReturnType<typeof SVGLoader.prototype.parse>['paths'][number]) {
  return SVGLoader.createShapes(path);
}

function areaOf(shape: THREE.Shape): number {
  return Math.abs(THREE.ShapeUtils.area(shape.getPoints(12)));
}

/**
 * The hull for one class and variant, nose along +X, centred on its own
 * bounding box, normalised to unit length.
 */
export function hullGeometry(
  cls: ShipIconClass, variant: ShipIconVariant,
): THREE.BufferGeometry {
  const key = `${cls}:${variant}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const parsed = new SVGLoader().parse(iconMarkup(cls, variant));
  const parts: THREE.BufferGeometry[] = [];

  parsed.paths.forEach((p, i) => {
    const shapes = shapesOf(p).filter(s => areaOf(s) > 0.4);
    if (!shapes.length) return;
    // The first path is the hull; everything after it is detail that
    // sits on the surface. An open accent stroke (an engine flare, a
    // rail) encloses no area and has already been dropped above.
    const isHull = i === 0;
    const depth = isHull ? HULL_DEPTH : GREEBLE_DEPTH;
    for (const shape of shapes) {
      const g = new THREE.ExtrudeGeometry(shape, {
        depth: depth * (1 - 2 * HULL_ROLL),
        bevelEnabled: true,
        bevelThickness: depth * HULL_ROLL,
        bevelSize: isHull ? depth * HULL_ROLL * 0.62 : depth * 0.16,
        bevelSegments: isHull ? 4 : 2,
        curveSegments: 10,
      });
      // Greebles are raised, so they read as hardware bolted to the
      // spine rather than as coplanar decals fighting the hull for
      // depth buffer.
      g.translate(0, 0, isHull ? 0 : -(GREEBLE_DEPTH - HULL_DEPTH) / 2);
      parts.push(g);
    }
  });

  if (!parts.length) {
    // Nothing parsed — a box is a visible failure rather than an
    // invisible one, which is what we want to notice in review.
    const fallback = new THREE.BoxGeometry(1, 0.22, 0.4);
    cache.set(key, fallback);
    return fallback;
  }

  const merged = mergeGeometries(parts, false) ?? parts[0];
  for (const p of parts) if (p !== merged) p.dispose();

  // Shape XY + extrude Z  ->  world X length, Y up, Z beam.
  merged.rotateX(-Math.PI / 2);
  // The icon box is y-down; after the rotation that leaves the ship
  // mirrored across its own keel, which matters for asymmetric hulls.
  merged.scale(1, 1, -1);
  // Winding order flipped with the mirror, so faces must follow.
  const idx = merged.getIndex();
  if (idx) {
    const a = idx.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i]; a[i] = a[i + 2]; a[i + 2] = t;
    }
    idx.needsUpdate = true;
  }

  const creased = toCreasedNormals(merged, Math.PI / 4.5);
  merged.dispose();
  return finishHull(creased, key);
}

function finishHull(merged: THREE.BufferGeometry, key: string): THREE.BufferGeometry {
  merged.computeBoundingBox();
  const bb = merged.boundingBox!;
  const centre = bb.getCenter(new THREE.Vector3());
  merged.translate(-centre.x, -centre.y, -centre.z);
  const len = Math.max(1e-3, bb.max.x - bb.min.x);
  merged.scale(1 / len, 1 / len, 1 / len);

  // UVs by planar projection down the hull's vertical axis.
  //
  // ExtrudeGeometry's own UVs are in raw icon units and use a different
  // space for caps and sides, so a texture applied through them lands at
  // a different scale on the deck than on the flanks. Projecting from
  // the plan silhouette instead means the surface art -- which is
  // DERIVED from that same silhouette -- registers with the hull it is
  // painted on: a panel line drawn along the icon's edge comes out along
  // the hull's edge.
  merged.computeBoundingBox();
  const nb = merged.boundingBox!;
  const sx = Math.max(1e-4, nb.max.x - nb.min.x);
  const sz = Math.max(1e-4, nb.max.z - nb.min.z);
  const pos = merged.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - nb.min.x) / sx;
    uv[i * 2 + 1] = (pos.getZ(i) - nb.min.z) / sz;
  }
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.computeBoundingSphere();

  cache.set(key, merged);
  return merged;
}

/** Drop every cached hull. Only used when tearing the stage down. */
export function disposeHulls(): void {
  for (const g of cache.values()) g.dispose();
  cache.clear();
}
