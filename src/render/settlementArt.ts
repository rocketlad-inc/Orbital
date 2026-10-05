// ============================================================
// Stations and cities in the hull language (visual overhaul, STAGING
// ONLY — see dev branch).
//
// The orbital station is composed from the STATION designs in
// hulls/capital.ts — a hub with solar wings and a docking ring, then a
// weapons, lab and shipyard module on booms as each is built, growing
// with its level — and rasterised once per (levels, colours) like the
// ship caches. The ship on the slip is its REAL hull, revealed bow to
// stern as it builds. Cities are two-tone isometric buildings drawn
// straight to canvas: habitat towers by population, then a forge, mint,
// lab and thrusters that rise with their levels.
//
// Everything is shaded from the owning empire's two tones, so a world's
// skyline, its station and its fleet read as one faction.
// ============================================================

import type { Settlement, BuildingKind } from '../types';
import { buildingLevel } from '../game/settlements';
import { deriveSecondary } from '../game/colorUtils';
import { hullHex } from '../components/ShipIcons';
import { palette, render } from './hulls/engine';
import { STATION, STATION_HUBS } from './hulls/capital';
import { citySkinOf, stationSkinOf, CitySkin, StationSkin } from '../game/settlementSkins';
import { shipDesign, hullSvgString } from './hulls';

type Pal = ReturnType<typeof palette> & Record<string, string>;
type Part = { t: string; role?: string };

const palettes = new Map<string, Pal>();
function pal(primary: string, secondary?: string): Pal {
  const p = hullHex(primary) ?? '#8c8f92';
  const s = hullHex(secondary) ?? hullHex(deriveSecondary(p)) ?? undefined;
  const k = `${p}|${s ?? ''}`;
  let v = palettes.get(k);
  if (!v) { v = palette(p, s) as Pal; palettes.set(k, v); }
  return v;
}

// ---- image cache (SVG -> <img>, like shipIconCache) ----
const images = new Map<string, HTMLImageElement>();
function svgImage(key: string, build: () => string): HTMLImageElement | null {
  if (typeof document === 'undefined') return null;
  let img = images.get(key);
  if (!img) {
    img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(build());
    images.set(key, img);
    if (images.size > 300) images.delete(images.keys().next().value as string);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

// ------------------------------------------------------------
// Station
// ------------------------------------------------------------

/** Station-local layout, in the same units the old iso station used
 *  (the caller already scales by STATION_STRUCTURE_SCALE). Each module
 *  keeps a fixed direction off the hub — weapons upper-left, lab up,
 *  shipyard right, thrusters below — so the layout stays learnable. */
export const STATION_MOUNTS = {
  hub: { x: 0, y: -1 },
  weapons: { x: -21, y: -19 },
  lab: { x: 5, y: -24 },
  shipyard: { x: 28, y: -1 },
  thrusters: { x: -1, y: 20 },
};
const VIEW = 44; // half-extent of the station image, in local units
const PX = 256;  // raster size — crisp at 1.6x scale on a 2x screen
const CORE_SCALE = 0.85;

const modScale = (level: number) => 0.34 + 0.035 * Math.min(level, 5);

function place(parts: Part[], x: number, y: number, s: number, C: Pal): string {
  return `<g transform="translate(${x} ${y}) scale(${s}) translate(-32 -32)">${render(parts, C)}</g>`;
}

/** Level pips under a module: one dot per level, so a maxed module and a
 *  fresh one differ at a glance even where the art stops growing. */
function pips(x: number, y: number, level: number, C: Pal): string {
  const n = Math.min(level, 9);
  let s = '';
  for (let i = 0; i < n; i++) s += `<circle cx="${(x + (i - (n - 1) / 2) * 2.2).toFixed(2)}" cy="${y}" r="0.75" fill="${C.glow}"/>`;
  return s;
}

function boom(to: { x: number; y: number }, C: Pal): string {
  const h = STATION_MOUNTS.hub;
  return `<line x1="${h.x}" y1="${h.y}" x2="${to.x}" y2="${to.y}" stroke="${C.edge}" stroke-width="2.6" stroke-linecap="round"/>`
    + `<line x1="${h.x}" y1="${h.y}" x2="${to.x}" y2="${to.y}" stroke="${C.plate}" stroke-width="1.4" stroke-linecap="round"/>`;
}

function thrusterBlock(level: number, C: Pal): string {
  const { x, y } = STATION_MOUNTS.thrusters;
  const n = Math.min(3, level);
  const w = 6 + n * 5;
  let s = `<rect x="${x - w / 2}" y="${y - 4}" width="${w}" height="5" rx="1.4" fill="${C.base}" stroke="${C.edge}" stroke-width="0.7"/>`
    + `<rect x="${x - w / 2}" y="${y - 4}" width="${w}" height="1.6" rx="0.8" fill="${C.top}"/>`;
  for (let i = 0; i < n; i++) {
    const nx = x + (i - (n - 1) / 2) * 5;
    s += `<path d="M${nx - 2} ${y + 1} L${nx + 2} ${y + 1} L${nx + 2.8} ${y + 5} L${nx - 2.8} ${y + 5} Z" fill="${C.plate}" stroke="${C.edge}" stroke-width="0.6"/>`
      + `<ellipse cx="${nx}" cy="${y + 5}" rx="2.4" ry="0.9" fill="${C.glow}"/>`;
  }
  return s;
}

type StationLevels = { weaponsLevel: number; labLevel: number; shipyardLevel: number; thrustersLevel: number };

function stationSvg(o: StationLevels, C: Pal, skin: StationSkin): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PX}" height="${PX}" viewBox="${-VIEW} ${-VIEW} ${VIEW * 2} ${VIEW * 2}">${stationMarkup(o, C, skin)}</svg>`;
}

/** The station drawing (no <svg> wrapper) in station units, centred on 0,0
 *  and spanning +/-STATION_VIEW, for a DOM <svg> to mount: the world
 *  menu's station badge shows the same station the map draws. */
export const STATION_VIEW = VIEW;
export function stationInnerSvg(o: StationLevels, primary: string, secondary?: string, skin?: string | null): string {
  return stationMarkup(o, pal(primary, secondary), stationSkinOf(skin));
}

function stationMarkup(o: StationLevels, C: Pal, skin: StationSkin = 'hub'): string {
  const M = STATION_MOUNTS;
  let s = '';
  // Booms first so every module sits on top of its own mount.
  if (o.weaponsLevel > 0) s += boom(M.weapons, C);
  if (o.labLevel > 0) s += boom(M.lab, C);
  if (o.shipyardLevel > 0) s += boom({ x: M.shipyard.x - 8, y: M.shipyard.y }, C);
  if (o.thrustersLevel > 0) s += boom(M.thrusters, C) + thrusterBlock(o.thrustersLevel, C);
  // The hub is the skin (0154); every module below keeps its mount.
  s += place((STATION_HUBS[skin] ?? STATION.core.parts) as Part[], M.hub.x, M.hub.y, CORE_SCALE, C);
  if (o.shipyardLevel > 0) {
    // The frame and rails only: the ship on the slip is the real hull,
    // drawn live over this image as it builds.
    const frame = (STATION.shipyard.parts as Part[]).filter(p => p.t !== 'hull' && p.role !== 'glow');
    const sc = modScale(o.shipyardLevel) * 1.25;
    s += place(frame, M.shipyard.x, M.shipyard.y, sc, C) + pips(M.shipyard.x, M.shipyard.y + 17 * sc, o.shipyardLevel, C);
  }
  if (o.weaponsLevel > 0) {
    const sc = modScale(o.weaponsLevel) * 1.3;
    s += place(STATION.weapons.parts as Part[], M.weapons.x, M.weapons.y, sc, C) + pips(M.weapons.x, M.weapons.y + 11 * sc, o.weaponsLevel, C);
  }
  if (o.labLevel > 0) {
    const sc = modScale(o.labLevel) * 1.2;
    s += place(STATION.lab.parts as Part[], M.lab.x, M.lab.y, sc, C) + pips(M.lab.x, M.lab.y + 13 * sc, o.labLevel, C);
  }
  return s;
}

export interface StationArtOpts {
  weaponsLevel: number;
  shipyardLevel: number;
  labLevel: number;
  thrustersLevel: number;
  factionColor: string;
  factionColor2?: string;
  builds: { shipClass: string; progress: number }[];
  nowMs: number;
  /** Station skin (0154); absent or unknown = the free hub. */
  skin?: string | null;
}

/** Draw the station centred on the current origin. False until its image
 *  has loaded (the caller draws the old art for that frame). */
export function drawStationArt(c: CanvasRenderingContext2D, o: StationArtOpts): boolean {
  const C = pal(o.factionColor, o.factionColor2);
  const lv = (n: number) => Math.max(0, Math.min(9, n | 0));
  const skin = stationSkinOf(o.skin);
  const key = `st|${skin}|${lv(o.weaponsLevel)}|${lv(o.labLevel)}|${lv(o.shipyardLevel)}|${lv(o.thrustersLevel)}|${C.base}|${C.liv}`;
  const img = svgImage(key, () => stationSvg(o, C, skin));
  if (!img) return false;
  c.drawImage(img, -VIEW, -VIEW, VIEW * 2, VIEW * 2);

  // Hub core breathes, like the old beacon (cosmetic, wall-clock).
  const prev = c.globalAlpha;
  const h = STATION_MOUNTS.hub;
  c.globalAlpha = prev * (0.35 + 0.25 * Math.sin(Math.PI * o.nowMs / 1000));
  c.fillStyle = C.glow;
  c.beginPath();
  c.arc(h.x, h.y, 3.2, 0, Math.PI * 2);
  c.fill();
  c.globalAlpha = prev;

  if (o.shipyardLevel > 0 && o.builds.length) drawSlip(c, o.builds[0], o.shipyardLevel, o.factionColor, o.factionColor2, o.nowMs);
  return true;
}

/** The ship on the slip: a faint full ghost, then the finished part of the
 *  real hull revealed bow-first, with a welding spark at the build line. */
function drawSlip(
  c: CanvasRenderingContext2D, b: { shipClass: string; progress: number }, level: number,
  primary: string, secondary: string | undefined, nowMs: number,
) {
  const d = shipDesign(b.shipClass, 'A');
  if (!d) return;
  const p1 = hullHex(primary) ?? '#8c8f92', p2 = hullHex(secondary);
  const img = svgImage(`slip|${b.shipClass}|${p1}|${p2 ?? ''}`, () => hullSvgString(d, `${b.shipClass}:A`, 128, p1, p2));
  if (!img) return;
  const M = STATION_MOUNTS.shipyard;
  const size = 30 * modScale(level) * 1.25;
  const x0 = M.x - size / 2, y0 = M.y - size / 2;
  const p = Math.max(0, Math.min(1, b.progress));
  const prev = c.globalAlpha;
  c.globalAlpha = prev * 0.28;
  c.drawImage(img, x0, y0, size, size);
  c.globalAlpha = prev;
  // Bow first: the nose is +x, so reveal from the right edge leftward.
  const cut = x0 + size * (1 - p);
  c.save();
  c.beginPath();
  c.rect(cut, y0, size * p, size);
  c.clip();
  c.drawImage(img, x0, y0, size, size);
  c.restore();
  if (p < 1) {
    const flick = 0.5 + 0.5 * Math.sin(nowMs / 70);
    c.globalAlpha = prev * (0.5 + 0.5 * flick);
    c.fillStyle = '#fff4d6';
    c.beginPath();
    c.arc(cut, M.y + Math.sin(nowMs / 230) * size * 0.12, 0.9 + flick * 0.6, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = prev;
  }
}

// ------------------------------------------------------------
// City
// ------------------------------------------------------------

const ISO_C = Math.cos(Math.PI / 6);

/** An iso block standing with its footprint centred on ground (gx, gy):
 *  lit top, base-toned left face, shadowed right face, empire edges. */
function isoBox(c: CanvasRenderingContext2D, gx: number, gy: number, w: number, d: number, h: number, C: Pal, top: string = C.top) {
  const x = gx - (w - d) / 2 * ISO_C, y = gy - (w + d) / 4;
  const p = (a: number, b: number, z: number): [number, number] => [x + (a - b) * ISO_C, y + (a + b) * 0.5 - z];
  const face = (pts: [number, number][], fill: string) => {
    c.beginPath();
    pts.forEach(([px, py], i) => (i ? c.lineTo(px, py) : c.moveTo(px, py)));
    c.closePath();
    c.fillStyle = fill;
    c.fill();
    c.stroke();
  };
  c.strokeStyle = C.edge;
  c.lineWidth = 0.4;
  c.lineJoin = 'round';
  face([p(0, d, 0), p(w, d, 0), p(w, d, h), p(0, d, h)], C.base);
  face([p(w, 0, 0), p(w, d, 0), p(w, d, h), p(w, 0, h)], C.plate);
  face([p(0, 0, h), p(w, 0, h), p(w, d, h), p(0, d, h)], top);
  // Return the top-face centre, where roof details hang.
  return { tx: x + (w - d) / 2 * ISO_C, ty: y + (w + d) / 4 - h };
}

/** Lit window strips on a tower's left face. */
function windows(c: CanvasRenderingContext2D, gx: number, gy: number, w: number, d: number, h: number, C: Pal) {
  c.fillStyle = C.glass;
  const x = gx - (w - d) / 2 * ISO_C, y = gy - (w + d) / 4;
  const floors = Math.floor(h / 2.6);
  c.globalAlpha *= 0.75;
  for (let i = 1; i < floors; i++) {
    const z = i * 2.6;
    const ax = x - d * ISO_C + w * 0.2 * ISO_C, ay = y + d * 0.5 + w * 0.1 - z;
    c.beginPath();
    c.moveTo(ax, ay);
    c.lineTo(ax + w * 0.6 * ISO_C, ay + w * 0.3);
    c.lineTo(ax + w * 0.6 * ISO_C, ay + w * 0.3 - 0.7);
    c.lineTo(ax, ay - 0.7);
    c.closePath();
    c.fill();
  }
  c.globalAlpha /= 0.75;
}

function glowDot(c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, a: number) {
  const prev = c.globalAlpha;
  c.globalAlpha = prev * a;
  c.fillStyle = color;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
  c.globalAlpha = prev;
}

// ---- One painter per building (ground point gx, gy; "up" is -y) ----

function towerAt(c: CanvasRenderingContext2D, gx: number, gy: number, h: number, C: Pal) {
  isoBox(c, gx, gy, 4.2, 4.2, h, C);
  windows(c, gx, gy, 4.2, 4.2, h, C);
}

function labAt(c: CanvasRenderingContext2D, gx: number, gy: number, level: number, C: Pal) {
  const h = 6 + 1.6 * Math.min(level, 5);
  const { tx, ty } = isoBox(c, gx, gy, 3.6, 3.6, h, C);
  c.strokeStyle = C.plate2; c.lineWidth = 0.8;
  c.beginPath(); c.moveTo(tx, ty); c.lineTo(tx + 2.4, ty - 3.6); c.stroke();
  c.save(); c.translate(tx + 2.8, ty - 4.2); c.rotate(-0.45);
  c.beginPath(); c.ellipse(0, 0, 3.4, 1.8, 0, 0, Math.PI * 2);
  c.fillStyle = C.top; c.fill(); c.strokeStyle = C.edge; c.lineWidth = 0.4; c.stroke();
  c.restore();
  glowDot(c, tx + 2.8, ty - 4.2, 0.7, C.glow, 0.9);
}

function forgeAt(c: CanvasRenderingContext2D, gx: number, gy: number, level: number, C: Pal) {
  isoBox(c, gx, gy, 7, 5, 3.6, C);
  const stacks = Math.min(3, 1 + Math.floor(level / 2));
  for (let i = 0; i < stacks; i++) {
    const sh = 6 + 1.2 * Math.min(level, 5) - i * 1.5;
    const { tx, ty } = isoBox(c, gx - 2 + i * 2.4, gy - 1.4 - i * 0.6, 1.5, 1.5, sh, C);
    glowDot(c, tx, ty - 1.2, 1.4, C.glow, 0.45);
  }
}

function mintAt(c: CanvasRenderingContext2D, gx: number, gy: number, level: number, C: Pal) {
  const { tx, ty } = isoBox(c, gx, gy, 5.5, 5.5, 2.4 + 0.3 * Math.min(level, 5), C);
  const r = 3 + 0.25 * Math.min(level, 5);
  c.beginPath(); c.ellipse(tx, ty, r, r * 0.55, 0, 0, Math.PI * 2);
  c.fillStyle = C.plate2; c.fill();
  c.beginPath(); c.arc(tx, ty, r, Math.PI, 0);
  c.fillStyle = C.top; c.fill(); c.strokeStyle = C.edge; c.lineWidth = 0.4; c.stroke();
  c.strokeStyle = C.liv; c.lineWidth = 0.6;
  c.beginPath(); c.arc(tx, ty, r * 0.62, Math.PI * 1.15, Math.PI * 1.85); c.stroke();
  glowDot(c, tx, ty - r - 0.8, 0.8, C.glow, 0.95);
}

function thrustersAt(c: CanvasRenderingContext2D, gx: number, gy: number, level: number, C: Pal) {
  const { tx, ty } = isoBox(c, gx, gy, 7, 3.5, 2.6, C);
  const n = Math.min(3, level);
  for (let i = 0; i < n; i++) {
    const nx = tx + (i - (n - 1) / 2) * 2.4, ny = ty + (i - (n - 1) / 2) * 1.2;
    c.beginPath(); c.ellipse(nx, ny, 1.2, 0.7, 0, 0, Math.PI * 2);
    c.fillStyle = C.plate; c.fill(); c.strokeStyle = C.edge; c.lineWidth = 0.4; c.stroke();
    glowDot(c, nx, ny, 0.6, C.glow, 0.95);
  }
}

/** A faction building on its own, standing on the origin with "up" = -y,
 *  in city units (a forge is ~14 tall at level 5). The world-menu close-up
 *  draws these on the horizon so its city matches the map's. */
export function drawIsoBuilding(
  c: CanvasRenderingContext2D, kind: 'forge' | 'mint' | 'lab' | 'thrusters' | 'collector',
  level: number, primary: string, secondary?: string,
) {
  const C = pal(primary, secondary);
  if (kind === 'forge') forgeAt(c, 2, 0, level, C);
  else if (kind === 'mint') mintAt(c, 0, 0, level, C);
  else if (kind === 'lab' || kind === 'collector') labAt(c, 0, 0, Math.max(1, level), C);
  else thrustersAt(c, 0, 0, level, C);
}

/** A hex colour with every channel scaled by k (hue kept). */
export function dimHex(hex: string, k: number): string {
  const h = hullHex(hex) ?? '#8c8f92';
  const n = parseInt(h.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, '0');
  return '#' + ch((n >> 16) & 255) + ch((n >> 8) & 255) + ch(n & 255);
}

/** One skyline structure for the world-menu horizon, in screen px at the
 *  origin ("up" = -y): `w` a half-width, `h` a height. Twelve shapes, the
 *  same set the close-up always had (towers, spire, gantry, dome, paired
 *  blocks, terrace, cooling stack, arcology, twin needles, tank farm, ring
 *  habitat, solar array), now built from the city's shaded iso blocks. */
export function drawSkylineStructure(
  c: CanvasRenderingContext2D, kind: number, w: number, h: number,
  primary: string, secondary: string | undefined, lit: boolean,
) {
  const C = pal(primary, secondary);
  const f = w * 1.25; // footprint side
  const box = (gx: number, gy: number, fw: number, fd: number, hh: number) => isoBox(c, gx, gy, fw, fd, hh, C);
  if (kind === 0) {
    const { tx, ty } = box(0, 0, f, f * 0.9, h);
    box(tx, ty + f * 0.22, f * 0.55, f * 0.5, h * 0.22);
    if (lit) windows(c, 0, 0, f, f * 0.9, h, C);
  } else if (kind === 1) {
    const { tx, ty } = box(0, 0, f * 0.6, f * 0.6, h * 1.15);
    box(tx, ty + f * 0.1, f * 0.22, f * 0.22, h * 0.35);
    if (lit) windows(c, 0, 0, f * 0.6, f * 0.6, h * 1.15, C);
  } else if (kind === 2) {
    const { tx, ty } = box(0, 0, f * 0.55, f * 0.55, h);
    c.strokeStyle = C.plate2; c.lineWidth = Math.max(0.6, w * 0.18);
    c.beginPath(); c.moveTo(tx - w * 1.4, ty + h * 0.18); c.lineTo(tx + w * 1.4, ty + h * 0.18); c.stroke();
    c.beginPath(); c.ellipse(tx, ty - w * 0.4, w * 0.8, w * 0.45, -0.4, 0, Math.PI * 2);
    c.fillStyle = C.top; c.fill(); c.strokeStyle = C.edge; c.lineWidth = 0.4; c.stroke();
  } else if (kind === 3) {
    const r = h * 0.42;
    c.beginPath(); c.ellipse(0, 0, r, r * 0.35, 0, 0, Math.PI * 2); c.fillStyle = C.plate2; c.fill();
    c.beginPath(); c.arc(0, 0, r, Math.PI, 0); c.fillStyle = C.top; c.fill();
    c.strokeStyle = C.edge; c.lineWidth = 0.4; c.stroke();
    c.strokeStyle = C.liv; c.lineWidth = Math.max(0.5, r * 0.06);
    c.beginPath(); c.arc(0, 0, r * 0.66, Math.PI * 1.1, Math.PI * 1.9); c.stroke();
  } else if (kind === 4) {
    box(-w * 0.9, 0, f * 0.7, f * 0.7, h * 0.7);
    box(w * 0.8, 0, f * 0.7, f * 0.7, h);
  } else if (kind === 5) {
    box(0, 0, f * 1.8, f * 1.4, h * 0.38);
    box(0, -h * 0.02, f * 1.2, f * 1.0, h * 0.72);
    box(0, -h * 0.04, f * 0.65, f * 0.6, h);
  } else if (kind === 6) {
    const { tx, ty } = box(0, 0, f * 1.2, f * 1.2, h);
    c.beginPath(); c.ellipse(tx, ty, f * 0.55, f * 0.3, 0, 0, Math.PI * 2); c.fillStyle = C.dark; c.fill();
    glowDot(c, tx, ty - h * 0.08, f * 0.5, C.glow, 0.25);
  } else if (kind === 7) {
    const { tx, ty } = box(0, 0, f * 2, f * 1.6, h * 0.85);
    box(tx, ty + f * 0.5, f * 1.0, f * 0.8, h * 0.28);
    if (lit) windows(c, 0, 0, f * 2, f * 1.6, h * 0.85, C);
  } else if (kind === 8) {
    box(-w * 0.55, 0, f * 0.35, f * 0.35, h);
    box(w * 0.5, 0, f * 0.32, f * 0.32, h * 0.78);
  } else if (kind === 9) {
    for (const [dx, hh] of [[-w * 0.9, h * 0.6], [0, h * 0.85], [w * 0.9, h * 0.5]] as [number, number][]) {
      const { tx, ty } = box(dx, 0, f * 0.55, f * 0.55, hh);
      c.beginPath(); c.arc(tx, ty, f * 0.32, Math.PI, 0); c.fillStyle = C.top; c.fill();
    }
  } else if (kind === 10) {
    box(0, 0, f * 0.25, f * 0.25, h * 0.62);
    c.strokeStyle = C.liv; c.lineWidth = Math.max(0.6, w * 0.22);
    c.beginPath(); c.ellipse(0, -h * 0.86, w * 0.9, w * 0.5, 0, 0, Math.PI * 2); c.stroke();
    glowDot(c, 0, -h * 0.86, w * 0.22, C.glow, 0.8);
  } else {
    box(0, 0, f * 0.5, f * 0.5, h * 0.22);
    c.beginPath();
    c.moveTo(-w * 1.6, -h * 0.26); c.lineTo(w * 1.3, -h * 0.62); c.lineTo(w * 1.6, -h * 0.5); c.lineTo(-w * 1.3, -h * 0.14);
    c.closePath(); c.fillStyle = '#1d3b5c'; c.fill(); c.strokeStyle = C.liv; c.lineWidth = 0.5; c.stroke();
  }
}

// ---- City skins (0154) ------------------------------------------------
// A skin is a landing pad and a way of drawing HABITATS. The functional
// buildings (forge, mint, lab, thrusters) are painted by the same code at
// the same spots in every skin: rivals read a city's strength from them.
// Habitats sit behind them (small gy) and grow with population exactly as
// the standard towers do, so a big city reads big in every style.

type Item = { gy: number; draw: () => void };

function padDiamond(c: CanvasRenderingContext2D, C: Pal, fill: string, cross: boolean) {
  c.beginPath();
  c.moveTo(0, -9); c.lineTo(20, 1); c.lineTo(0, 11); c.lineTo(-20, 1);
  c.closePath();
  c.fillStyle = fill;
  c.fill();
  c.strokeStyle = C.liv;
  c.lineWidth = 1;
  c.stroke();
  if (cross) {
    c.strokeStyle = C.edge;
    c.lineWidth = 0.4;
    c.beginPath();
    c.moveTo(-10, -4); c.lineTo(10, 6);
    c.moveTo(10, -4); c.lineTo(-10, 6);
    c.stroke();
  }
}

function padHex(c: CanvasRenderingContext2D, C: Pal) {
  c.beginPath();
  ([[-20, 1], [-10, -8], [10, -8], [20, 1], [10, 10], [-10, 10]] as [number, number][])
    .forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
  c.fillStyle = C.plate; c.fill();
  c.strokeStyle = C.liv; c.lineWidth = 1; c.stroke();
}

/** Standard towers: the original look, unchanged. */
function habsTowers(c: CanvasRenderingContext2D, habs: number, pop: number, C: Pal): Item[] {
  const slots: [number, number, number][] = [[-9, -2, 11], [9, -2, 8], [-2, -5, 14]];
  return slots.slice(0, habs).map(([hx, hy, hh]) => {
    const h = hh + Math.min(4, Math.floor(pop / 6));
    return { gy: hy, draw: () => towerAt(c, hx, hy, h, C) };
  });
}

/** Hive: honeycomb cells, more of them and taller as the city grows. */
function habsHive(c: CanvasRenderingContext2D, habs: number, pop: number, C: Pal): Item[] {
  const cells: [number, number, number][] = [
    [-6, -6, 12], [2, -7, 14], [-2, -3, 10], [6, -4, 9], [-10, -3, 8], [10, -2, 7], [0, -9, 11], [-4, -9, 9], [5, -9, 8],
  ];
  const n = Math.min(cells.length, 3 + habs * 2);
  const grow = Math.min(6, Math.floor(pop / 3));
  return cells.slice(0, n).map(([x, y, h0]) => ({
    gy: y,
    draw: () => {
      const h = h0 + grow;
      const r = 2.6;
      c.fillStyle = C.base; c.fillRect(x - r * 0.87, y - h, r * 1.74, h);
      c.fillStyle = C.plate; c.fillRect(x, y - h, r * 0.87, h);
      c.strokeStyle = C.edge; c.lineWidth = 0.4; c.strokeRect(x - r * 0.87, y - h, r * 1.74, h);
      c.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (60 * i + 30) * Math.PI / 180;
        const px = x + Math.cos(a) * r, py = y - h + Math.sin(a) * r * 0.55;
        if (i) c.lineTo(px, py); else c.moveTo(px, py);
      }
      c.closePath();
      c.fillStyle = C.top; c.fill(); c.stroke();
      glowDot(c, x, y - h, 0.7, C.glow, 0.8);
    },
  }));
}

/** Needle spires: thin, tall, banded, a beacon at every tip. */
function habsSpires(c: CanvasRenderingContext2D, habs: number, pop: number, C: Pal): Item[] {
  const slots: [number, number, number][] = [[-2, -6, 28], [-9, -2, 22], [9, -2, 18], [4, -4, 14]];
  const grow = Math.min(4, Math.floor(pop / 6)) * 1.5;
  return slots.slice(0, Math.min(slots.length, habs + 1)).map(([x, y, h0]) => ({
    gy: y,
    draw: () => {
      const h = h0 + grow;
      const { tx, ty } = isoBox(c, x, y, 2.6, 2.6, h, C);
      c.beginPath(); c.moveTo(tx - 1.3, ty + 0.6); c.lineTo(tx, ty - 6); c.lineTo(tx + 1.3, ty + 0.6); c.closePath();
      c.fillStyle = C.top; c.fill(); c.strokeStyle = C.edge; c.lineWidth = 0.4; c.stroke();
      c.strokeStyle = C.liv; c.lineWidth = 0.5;
      for (let z = 4; z < h; z += 5) { c.beginPath(); c.moveTo(x - 2.2, y - z); c.lineTo(x, y - z + 1.1); c.stroke(); }
      glowDot(c, tx, ty - 6.5, 1.1, C.glow, 0.95);
    },
  }));
}

/** Arcology domes: one glass dome per habitat, two towers inside each. */
function habsDomes(c: CanvasRenderingContext2D, habs: number, pop: number, C: Pal): Item[] {
  const slots: [number, number, number][] = [[0, -6, 8], [-9, -3, 6.5], [9, -2, 5.5]];
  const grow = Math.min(1.5, pop / 12);
  return slots.slice(0, habs).map(([x, y, r0]) => ({
    gy: y,
    draw: () => {
      const r = r0 + grow;
      isoBox(c, x, y, r * 1.1, r * 1.1, 1.4, C);
      c.beginPath(); c.ellipse(x, y - 2, r, r * 0.5, 0, 0, Math.PI * 2); c.fillStyle = C.plate2; c.fill();
      isoBox(c, x - r * 0.25, y - 2.4, 1.7, 1.7, r * 0.75, C);
      isoBox(c, x + r * 0.3, y - 2, 1.7, 1.7, r * 0.5, C);
      c.beginPath(); c.ellipse(x, y - 2, r, r * 1.05, 0, Math.PI, 0);
      c.fillStyle = 'rgba(200, 235, 255, 0.24)'; c.fill();
      c.strokeStyle = C.glass; c.lineWidth = 0.55; c.stroke();
      c.strokeStyle = 'rgba(232, 248, 255, 0.4)'; c.lineWidth = 0.35;
      c.beginPath(); c.ellipse(x, y - 2, r * 0.5, r * 1.05, 0, Math.PI, 0); c.stroke();
      glowDot(c, x, y - 2 - r * 1.05, 0.8, C.glow, 0.9);
    },
  }));
}

/** Terraced ziggurats: stepped tiers in alternating tones, lit at the
 *  summit. Taller tiers and stronger contrast than the concept pass, which
 *  turned to mush at map size. */
function habsZiggurat(c: CanvasRenderingContext2D, habs: number, pop: number, C: Pal): Item[] {
  const slots: [number, number, number][] = [[-5, -4, 12], [9, -3, 8.5], [0, -8, 7.5]];
  const tiers = pop >= 8 ? 4 : 3;
  return slots.slice(0, habs).map(([x, y, w0]) => ({
    gy: y,
    draw: () => {
      let gy = y;
      let topY = y;
      for (let k = 0; k < tiers; k++) {
        const w = w0 * (1 - k * 0.24);
        const r = isoBox(c, x, gy, w, w, 3.4, C, k % 2 ? C.top : C.plate2);
        topY = r.ty;
        gy = r.ty + w * 0.5 - 0.6;
      }
      glowDot(c, x, topY - 0.4, 1.3, C.glow, 0.95);
    },
  }));
}

const CITY_STYLE: Record<CitySkin, {
  pad: (c: CanvasRenderingContext2D, C: Pal) => void;
  habs: (c: CanvasRenderingContext2D, habs: number, pop: number, C: Pal) => Item[];
}> = {
  towers: { pad: (c, C) => padDiamond(c, C, C.plate, true), habs: habsTowers },
  hive: { pad: padHex, habs: habsHive },
  spires: { pad: (c, C) => padDiamond(c, C, C.dark, false), habs: habsSpires },
  domes: { pad: (c, C) => padDiamond(c, C, C.plate, false), habs: habsDomes },
  ziggurat: { pad: (c, C) => padDiamond(c, C, C.plate, true), habs: habsZiggurat },
};

/** Draw the city standing on the surface at the current origin, "up" =
 *  outward (the caller rotates). Same footprint as the old cluster. The
 *  skin (0154) picks the pad and the habitats; absent = standard towers. */
export function drawCityArt(
  c: CanvasRenderingContext2D, settlement: Settlement, primary: string, secondary?: string, skin?: string | null,
) {
  const C = pal(primary, secondary);
  const style = CITY_STYLE[citySkinOf(skin)];
  style.pad(c, C);

  const L = (k: string) => buildingLevel(settlement, k as BuildingKind);
  const forgeL = L('forge'), mintL = L('mint'), labL = L('lab'), ttL = L('trajectory_thrusters');
  const pop = settlement.population ?? 0;
  const habs = Math.min(3, 1 + Math.floor(pop / 3));

  // Painter's order: everything sorted back (small gy) to front.
  const items: Item[] = style.habs(c, habs, pop, C);
  if (labL > 0) items.push({ gy: 5, draw: () => labAt(c, -12, 5, labL, C) });
  if (forgeL > 0) items.push({ gy: 4, draw: () => forgeAt(c, 1, 4, forgeL, C) });
  if (mintL > 0) items.push({ gy: 3, draw: () => mintAt(c, 12, 3, mintL, C) });
  if (ttL > 0) items.push({ gy: 10, draw: () => thrustersAt(c, -3, 10, ttL, C) });
  items.sort((a, b) => a.gy - b.gy).forEach(it => it.draw());
}
