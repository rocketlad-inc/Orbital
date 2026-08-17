// ============================================================
// Hull surfaces, derived from the icon that made the hull.
//
// The geometry pipeline was never the problem — reviewers called the
// extruded ships "balloon animals", "a brass sofa", "a bath toy",
// "smooth gold cylinders". All of those are one complaint: a flat
// saturated albedo over a rolled solid, with nothing built on it. No
// plates, no seams, no wear, no lights. Colour is not a surface.
//
// So the surface is generated from the same SVG the hull came from.
// Rasterise the icon, take a distance transform of its silhouette, and
// that field gives you almost everything for free:
//
//   * Its isocontours are plate boundaries that follow the hull's own
//     shape, so panel lines run parallel to the edge the way they do on
//     something actually fabricated.
//   * Its low values are the outer edge — where paint chips, where the
//     rim light catches, where wear lives.
//   * Its high values are the spine — where you put the lights.
//
// Nothing is hand-authored per ship: five classes times nineteen
// variants get a plated, worn, lit hull the day they get an icon.
// ============================================================

import * as THREE from 'three';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { ShipIcon, ShipIconClass, ShipIconVariant } from '../components/ShipIcons';
import { hashStr, mulberry32 } from '../render/planetTexture';

const S = 512;

export interface HullMaps {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  emissiveMap: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
}

const cache = new Map<string, HullMaps>();

/** The icon, rasterised big, as a silhouette mask. */
function iconMask(cls: ShipIconClass, variant: ShipIconVariant): Promise<Uint8Array> {
  const svg = renderToStaticMarkup(
    React.createElement(ShipIcon, {
      shipClass: cls, variant, size: 32, color: '#ffffff',
    }),
  );
  // Fill the silhouette rather than stroke it: we want the hull's area,
  // not its outline.
  const filled = svg
    .replace(/fill="none"/g, 'fill="#ffffff"')
    .replace(/stroke-width="[^"]*"/g, 'stroke-width="2.5"');
  return new Promise(resolve => {
    const img = new Image();
    const blob = new Blob([filled], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const g = cv.getContext('2d')!;
      g.drawImage(img, 0, 0, S, S);
      const d = g.getImageData(0, 0, S, S).data;
      const m = new Uint8Array(S * S);
      for (let i = 0; i < S * S; i++) m[i] = d[i * 4 + 3] > 40 ? 1 : 0;
      URL.revokeObjectURL(url);
      resolve(m);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(new Uint8Array(S * S)); };
    img.src = url;
  });
}

/**
 * Chamfer distance transform: for every pixel, how far inside the hull
 * it is. Two passes, which is plenty at this resolution.
 */
function distanceField(mask: Uint8Array): Float32Array {
  const INF = 1e6;
  const d = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) d[i] = mask[i] ? INF : 0;
  const at = (x: number, y: number) =>
    (x < 0 || y < 0 || x >= S || y >= S) ? 0 : d[y * S + x];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!mask[y * S + x]) continue;
      d[y * S + x] = Math.min(d[y * S + x],
        at(x - 1, y) + 1, at(x, y - 1) + 1,
        at(x - 1, y - 1) + 1.41, at(x + 1, y - 1) + 1.41);
    }
  }
  for (let y = S - 1; y >= 0; y--) {
    for (let x = S - 1; x >= 0; x--) {
      if (!mask[y * S + x]) continue;
      d[y * S + x] = Math.min(d[y * S + x],
        at(x + 1, y) + 1, at(x, y + 1) + 1,
        at(x + 1, y + 1) + 1.41, at(x - 1, y + 1) + 1.41);
    }
  }
  return d;
}

/**
 * Albedo, roughness, emissive and normal for one hull.
 *
 * Resolves asynchronously because the icon has to go through an <img>
 * to be rasterised; callers get a flat material until it lands.
 */
export async function hullMaps(
  cls: ShipIconClass, variant: ShipIconVariant, factionHex: string,
): Promise<HullMaps> {
  const key = `${cls}:${variant}:${factionHex}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const mask = await iconMask(cls, variant);
  const dist = distanceField(mask);
  let maxD = 1;
  for (let i = 0; i < dist.length; i++) if (dist[i] > maxD) maxD = dist[i];

  const rnd = mulberry32(hashStr(key));
  const faction = new THREE.Color(factionHex);
  // Hull steel, pulled a fifth of the way toward the owner's colour.
  // All-grey plate is unreadable at battle distance; all-faction plate
  // is the plastic toy this pipeline exists to escape.
  const bc = new THREE.Color(0x8a93a0).lerp(faction, 0.2);
  const base = { r: bc.r * 255, g: bc.g * 255, b: bc.b * 255 };

  const alb = document.createElement('canvas'); alb.width = alb.height = S;
  const rgh = document.createElement('canvas'); rgh.width = rgh.height = S;
  const emi = document.createElement('canvas'); emi.width = emi.height = S;
  const ag = alb.getContext('2d')!, rg = rgh.getContext('2d')!, eg = emi.getContext('2d')!;

  // Ground: dark hull metal everywhere, so anything outside the
  // silhouette still shades as machine rather than as a hole.
  ag.fillStyle = '#8e97a4'; ag.fillRect(0, 0, S, S);
  rg.fillStyle = '#6e6e6e'; rg.fillRect(0, 0, S, S);
  eg.fillStyle = '#000000'; eg.fillRect(0, 0, S, S);

  const aimg = ag.getImageData(0, 0, S, S);
  const rimg = rg.getImageData(0, 0, S, S);

  // Plate bands from the distance field's isocontours, each with its own
  // slightly different metal, so the hull is assembled from parts.
  const bandW = Math.max(7, maxD / 5.5);
  const bandTone: number[] = [];
  for (let i = 0; i < 14; i++) bandTone.push(0.82 + rnd() * 0.36);

  // A jittered plate grid, clipped to the hull, so plates are finite
  // rather than continuous rings.
  const gx = 34 + rnd() * 16, gy = 30 + rnd() * 14;
  const gxo = rnd() * gx, gyo = rnd() * gy;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const dv = dist[i];
      const o = i * 4;
      if (dv <= 0) continue;                    // outside the hull
      const band = Math.floor(dv / bandW);
      const t = bandTone[band % bandTone.length];
      // Base metal, per plate.
      let r = base.r * t, g = base.g * t, b = base.b * t;
      // Edge wear: the outer few pixels are scuffed brighter, which is
      // what makes a silhouette read as worn plate rather than as a cut.
      const edge = Math.max(0, 1 - dv / 9);
      r += edge * 52; g += edge * 50; b += edge * 46;
      // Panel seams: dark grooves on the band boundaries and the grid.
      const onBand = Math.abs((dv % bandW) - bandW / 2) > bandW / 2 - 1.4;
      const onGrid = ((x + gxo) % gx) < 1.6 || ((y + gyo) % gy) < 1.6;
      if ((onBand || onGrid) && dv > 5) { r *= 0.6; g *= 0.62; b *= 0.66; }
      aimg.data[o] = r; aimg.data[o + 1] = g; aimg.data[o + 2] = b; aimg.data[o + 3] = 255;
      // Grooves are rougher, plate faces smoother, so light breaks up.
      const rv = (onBand || onGrid) ? 210 : 96 + (t - 0.82) * 180;
      rimg.data[o] = rimg.data[o + 1] = rimg.data[o + 2] = rv;
      rimg.data[o + 3] = 255;
    }
  }
  ag.putImageData(aimg, 0, 0);
  rg.putImageData(rimg, 0, 0);

  // Faction paint: blocks along the spine, not a wash over everything.
  // The livery is a marking on a machine, which is why the hull can be
  // metal and still read as its owner's at a glance.
  ag.save();
  ag.globalAlpha = 0.9;
  ag.fillStyle = `#${faction.getHexString()}`;
  const spineY = S / 2;
  // A stripe down the flank, clipped to the hull it is painted on.
  const stripeY = spineY + (rnd() - 0.5) * 46;
  const stripeH = 9 + rnd() * 9;
  for (let x = 0; x < S; x++) {
    for (let y = Math.floor(stripeY); y < stripeY + stripeH; y++) {
      if (y < 0 || y >= S) continue;
      if (dist[y * S + x] > 7) ag.fillRect(x, y, 1, 1);
    }
  }
  for (let k = 0; k < 7; k++) {
    const bw = 30 + rnd() * 66, bh = 14 + rnd() * 30;
    const bx = S * (0.14 + rnd() * 0.64), by = spineY + (rnd() - 0.5) * 92;
    const px = Math.round(bx), py = Math.round(by);
    if (dist[Math.min(S * S - 1, Math.max(0, py * S + px))] > 6) {
      ag.fillRect(bx, by, bw, bh);
    }
  }
  ag.restore();

  // Running lights and windows along the spine, where the distance field
  // says the hull is thickest.
  eg.fillStyle = '#bfe4ff';
  for (let k = 0; k < 46; k++) {
    const x = Math.floor(S * (0.12 + rnd() * 0.78));
    const y = Math.floor(spineY + (rnd() - 0.5) * 96);
    const i = y * S + x;
    if (i < 0 || i >= S * S || dist[i] < maxD * 0.35) continue;
    eg.globalAlpha = 0.4 + rnd() * 0.4;
    eg.fillRect(x, y, 2 + Math.floor(rnd() * 4), 1);
  }
  eg.globalAlpha = 1;

  // Normals from the albedo's own luminance: the seams are the only
  // real relief on the surface, and they are already drawn.
  const nrm = document.createElement('canvas'); nrm.width = nrm.height = S;
  const ng = nrm.getContext('2d')!;
  const src = ag.getImageData(0, 0, S, S).data;
  const nimg = ng.createImageData(S, S);
  const lum = (x: number, y: number) => {
    const xi = Math.max(0, Math.min(S - 1, x)), yi = Math.max(0, Math.min(S - 1, y));
    const o = (yi * S + xi) * 4;
    return (src[o] + src[o + 1] + src[o + 2]) / 765;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (lum(x + 1, y) - lum(x - 1, y)) * 2.2;
      const dy = (lum(x, y + 1) - lum(x, y - 1)) * 2.2;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * S + x) * 4;
      nimg.data[o] = ((-dx / len) * 0.5 + 0.5) * 255;
      nimg.data[o + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      nimg.data[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      nimg.data[o + 3] = 255;
    }
  }
  ng.putImageData(nimg, 0, 0);

  const mk = (cv: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(cv);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  const maps: HullMaps = {
    map: mk(alb, true),
    roughnessMap: mk(rgh, false),
    emissiveMap: mk(emi, true),
    normalMap: mk(nrm, false),
  };
  cache.set(key, maps);
  return maps;
}

export function disposeHullMaps(): void {
  for (const m of cache.values()) {
    m.map.dispose(); m.roughnessMap.dispose();
    m.emissiveMap.dispose(); m.normalMap.dispose();
  }
  cache.clear();
}
