// ------------------------------------------------------------
// Combat effect art (visual overhaul, staging).
//
// The hulls are 42-76 px of detailed, two-tone art. The effects were
// drawn for the old flat icons: 2 px lines, 5 px discs, outline rings.
// Next to the new art they read as UI (a link line, a targeting line, a
// sticker). These are the pieces the effects are now built from, shared
// by the map, the battle recap and the theatre recap:
//
//   - LIGHT IN THREE LAYERS: a white-hot core, a coloured glow, then a
//     haze or smoke. Light is additive; smoke and debris are matter and
//     are drawn over it in normal blend.
//   - THE WEAPON COLOURS THE SHOT, not the faction (the hull already
//     carries the faction): kinetic is amber, energy is cyan.
//   - SIZED BY THE CALLER from the hull it belongs to, never fixed px.
//
// Glows are baked once into small radial sprites and stretched, so a
// battle costs drawImage calls, not gradients.
// ------------------------------------------------------------

import { mulberry32 } from './planetTexture';

export interface FxPalette { core: string; glow: string; haze: string }
export const KINETIC_FX: FxPalette = { core: '#fff4d8', glow: '#ffae4a', haze: '#ff7a1a' };
export const ENERGY_FX: FxPalette = { core: '#f2fdff', glow: '#5cc8ff', haze: '#2f86ff' };
export const SHIELD_FX: FxPalette = { core: '#eafffd', glow: '#4ee6d8', haze: '#1fa5c4' };
const FIRE_FX: FxPalette = { core: '#fff6dc', glow: '#ff9a3c', haze: '#d2401a' };

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(ch => ch + ch).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgbCache = new Map<string, [number, number, number]>();
export function rgba(hex: string, a: number): string {
  let c = rgbCache.get(hex);
  if (!c) { c = hexRgb(hex); rgbCache.set(hex, c); }
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

// ---- baked glows ----------------------------------------------------

const GLOW_PX = 64;
const glowCache = new Map<string, HTMLCanvasElement>();

/** A radial glow, `core` at the centre falling through `glow` to nothing. */
export function glowSprite(core: string, glow: string): HTMLCanvasElement | null {
  const key = `${core}|${glow}`;
  const hit = glowCache.get(key);
  if (hit) return hit;
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = GLOW_PX;
  const g = cv.getContext('2d');
  if (!g) return null;
  const r = GLOW_PX / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, rgba(core, 1));
  grad.addColorStop(0.16, rgba(core, 0.85));
  grad.addColorStop(0.34, rgba(glow, 0.55));
  grad.addColorStop(0.62, rgba(glow, 0.16));
  grad.addColorStop(1, rgba(glow, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, GLOW_PX, GLOW_PX);
  glowCache.set(key, cv);
  return cv;
}

/** Stretch a baked glow over radius `r` at (x, y). Uses whatever
 *  composite the caller has set: 'lighter' for light, normal for smoke. */
export function glowAt(
  c: CanvasRenderingContext2D, x: number, y: number, r: number,
  core: string, glow: string, alpha: number,
): void {
  if (alpha <= 0.004 || r <= 0.2) return;
  const s = glowSprite(core, glow);
  const prev = c.globalAlpha;
  c.globalAlpha = prev * Math.min(1, alpha);
  if (s) {
    c.drawImage(s, x - r, y - r, r * 2, r * 2);
  } else {
    c.fillStyle = rgba(glow, 0.5);
    c.beginPath(); c.arc(x, y, r * 0.5, 0, Math.PI * 2); c.fill();
  }
  c.globalAlpha = prev;
}

const easeOut = (k: number) => 1 - (1 - k) * (1 - k) * (1 - k);

// ---- weapons --------------------------------------------------------

// Streaks and petals are baked too: a battle draws hundreds a frame,
// and a fresh gradient each costs ~4.5x a blit (the measurement behind
// the old flash sprites in mapRenderer).
const streakCache = new Map<string, HTMLCanvasElement>();
const STREAK_W = 96, STREAK_H = 24;
function streakSprite(pal: FxPalette): HTMLCanvasElement | null {
  const key = pal.core + pal.glow;
  const hit = streakCache.get(key);
  if (hit) return hit;
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = STREAK_W; cv.height = STREAK_H;
  const g = cv.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(STREAK_W, STREAK_H);
  const [cr, cg, cb] = hexRgb(pal.core);
  const [gr, gg, gb] = hexRgb(pal.glow);
  for (let y = 0; y < STREAK_H; y++) {
    const v = Math.abs(y + 0.5 - STREAK_H / 2) / (STREAK_H / 2);   // 0 centre, 1 edge
    const core = Math.max(0, 1 - v * 4.5);
    const glow = Math.pow(Math.max(0, 1 - v), 2) * 0.55;
    const mix = core / (core + glow + 1e-6);
    for (let x = 0; x < STREAK_W; x++) {
      const t = Math.pow((x + 0.5) / STREAK_W, 1.6);                // tail -> head
      const o = (y * STREAK_W + x) * 4;
      img.data[o] = cr * mix + gr * (1 - mix);
      img.data[o + 1] = cg * mix + gg * (1 - mix);
      img.data[o + 2] = cb * mix + gb * (1 - mix);
      img.data[o + 3] = Math.round(Math.min(1, core + glow) * t * 255);
    }
  }
  g.putImageData(img, 0, 0);
  streakCache.set(key, cv);
  return cv;
}

/** One round in flight, tail -> head: a hot core and a soft glow that
 *  both brighten toward the head, and a glint on the head. */
export function drawRound(
  c: CanvasRenderingContext2D,
  tx: number, ty: number, hx: number, hy: number,
  width: number, alpha: number, pal: FxPalette = KINETIC_FX, head = true,
): void {
  if (alpha <= 0) return;
  const len = Math.hypot(hx - tx, hy - ty);
  const s = streakSprite(pal);
  if (s && len > 0.5) {
    const prev = c.globalAlpha;
    c.globalAlpha = prev * Math.min(1, alpha);
    c.save();
    c.translate(tx, ty);
    c.rotate(Math.atan2(hy - ty, hx - tx));
    c.drawImage(s, 0, -width * 2, len, width * 4);
    c.restore();
    c.globalAlpha = prev;
  }
  if (head) glowAt(c, hx, hy, width * 3.4, pal.core, pal.glow, alpha);
}

const petalCache = new Map<string, HTMLCanvasElement>();
const PETAL_W = 64, PETAL_H = 32;
function petalSprite(pal: FxPalette): HTMLCanvasElement | null {
  const key = pal.core + pal.glow;
  const hit = petalCache.get(key);
  if (hit) return hit;
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = PETAL_W; cv.height = PETAL_H;
  const g = cv.getContext('2d');
  if (!g) return null;
  const grad = g.createLinearGradient(0, 0, PETAL_W, 0);
  grad.addColorStop(0, rgba(pal.core, 1));
  grad.addColorStop(0.35, rgba(pal.glow, 0.75));
  grad.addColorStop(1, rgba(pal.glow, 0));
  g.fillStyle = grad;
  const m = PETAL_H / 2;
  g.beginPath();
  g.moveTo(0, m);
  g.quadraticCurveTo(PETAL_W * 0.35, 0, PETAL_W, m);
  g.quadraticCurveTo(PETAL_W * 0.35, PETAL_H, 0, m);
  g.fill();
  petalCache.set(key, cv);
  return cv;
}

/** A tapered tongue of light from (x, y) along `ang`, `len` long and
 *  `len * half` wide either side at its widest. */
function petal(
  c: CanvasRenderingContext2D, x: number, y: number, ang: number,
  len: number, half: number, pal: FxPalette, alpha: number,
): void {
  const s = petalSprite(pal);
  if (!s || alpha <= 0 || len <= 0.5) return;
  const prev = c.globalAlpha;
  c.globalAlpha = prev * Math.min(1, alpha);
  c.save();
  c.translate(x, y);
  c.rotate(ang);
  // The baked petal is widest at half its height.
  c.drawImage(s, 0, -len * half * 1.1, len, len * half * 2.2);
  c.restore();
  c.globalAlpha = prev;
}

/** Gun flash at the muzzle: a long petal down the barrel, two short ones
 *  either side, and a bloom. `len` is the forward petal's length. */
export function drawMuzzle(
  c: CanvasRenderingContext2D, x: number, y: number, ang: number,
  len: number, alpha: number, pal: FxPalette = KINETIC_FX,
): void {
  if (alpha <= 0) return;
  petal(c, x, y, ang, len, 0.2, pal, alpha);
  petal(c, x, y, ang + 1.75, len * 0.36, 0.32, pal, alpha * 0.8);
  petal(c, x, y, ang - 1.75, len * 0.36, 0.32, pal, alpha * 0.8);
  glowAt(c, x, y, len * 0.6, pal.core, pal.glow, alpha);
}

/** An energy beam: haze, glow and a white core, flickering as it burns,
 *  with pulses running down it and a bright cap at each end. */
export function drawBeam(
  c: CanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number,
  width: number, alpha: number, nowMs: number, seed: number,
  pal: FxPalette = ENERGY_FX,
): void {
  if (alpha <= 0) return;
  const ph = (seed % 997) / 997 * Math.PI * 2;
  const f = 0.84 + 0.16 * Math.sin(nowMs / 29 + ph) * Math.sin(nowMs / 53 + ph * 1.7);
  const w = width * f;
  c.lineCap = 'round';
  const layer = (lw: number, col: string, a: number) => {
    c.strokeStyle = rgba(col, a * alpha);
    c.lineWidth = lw;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  };
  layer(w * 4.4, pal.haze, 0.07);
  layer(w * 2.2, pal.glow, 0.32);
  layer(w * 0.8, pal.core, 0.95);
  // Pulses: the beam is a stream, not a stick.
  for (let i = 0; i < 3; i++) {
    const t = ((nowMs / 170) + i / 3 + ph) % 1;
    glowAt(c, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w * 1.8, pal.core, pal.glow, 0.6 * alpha);
  }
  glowAt(c, x0, y0, w * 3, pal.core, pal.glow, alpha);
  glowAt(c, x1, y1, w * 4.2, pal.core, pal.glow, alpha);
}

/** An emitter charging: a bead swelling with `k`, motes spiralling in. */
export function drawCharge(
  c: CanvasRenderingContext2D, x: number, y: number, r: number,
  k: number, nowMs: number, seed: number, pal: FxPalette = ENERGY_FX,
): void {
  glowAt(c, x, y, r * (0.5 + 0.9 * k), pal.core, pal.glow, 0.35 + 0.65 * k);
  const ph = (seed % 997) / 997 * Math.PI * 2;
  for (let i = 0; i < 4; i++) {
    const t = ((nowMs / 240) + i / 4) % 1;
    const a = ph + i * 1.571 + t * 2.2;
    const d = r * 2.4 * (1 - t);
    glowAt(c, x + Math.cos(a) * d, y + Math.sin(a) * d, Math.max(1.2, r * 0.28), pal.core, pal.glow, 0.8 * k * t);
  }
}

// ---- impacts --------------------------------------------------------

/** Sparks flung from (x, y) along `ang` +- spread/2. `k` 0..1 is their
 *  life; each is a short streak that thins and fades as it flies. */
export function drawSparks(
  c: CanvasRenderingContext2D, x: number, y: number,
  ang: number, spread: number, count: number, reach: number,
  k: number, seed: number, pal: FxPalette = KINETIC_FX, width = 1.2,
): void {
  if (k >= 1) return;
  const rng = mulberry32(seed >>> 0);
  const e = easeOut(k);
  const a = (1 - k) * (1 - k);
  c.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const d = ang + (rng() - 0.5) * spread;
    const sp = 0.45 + rng() * 0.55;
    const head = reach * sp * e;
    const tail = Math.max(0, head - reach * 0.22 * sp * (1 - k * 0.6));
    const cx = Math.cos(d), cy = Math.sin(d);
    c.strokeStyle = rgba(pal.glow, 0.45 * a);
    c.lineWidth = width * 2.4;
    c.beginPath(); c.moveTo(x + cx * tail, y + cy * tail); c.lineTo(x + cx * head, y + cy * head); c.stroke();
    c.strokeStyle = rgba(pal.core, 0.95 * a);
    c.lineWidth = width;
    c.beginPath(); c.moveTo(x + cx * tail, y + cy * tail); c.lineTo(x + cx * head, y + cy * head); c.stroke();
  }
}

/** A round landing on a hull: a white flash and sparks fanned back
 *  toward the shooter (`back` is the angle from the hit toward it). */
export function drawHullHit(
  c: CanvasRenderingContext2D, x: number, y: number, back: number,
  size: number, k: number, seed: number, pal: FxPalette = KINETIC_FX,
): void {
  if (k >= 1) return;
  const fk = Math.min(1, k / 0.45);
  glowAt(c, x, y, size * (0.5 + 0.7 * easeOut(fk)), pal.core, pal.glow, (1 - fk) * 1.0);
  drawSparks(c, x, y, back, 2.4, 7, size * 2.2, k, seed, pal, Math.max(0.8, size * 0.07));
}

function hexagon(c: CanvasRenderingContext2D, x: number, y: number, s: number, rot: number) {
  c.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = rot + i * Math.PI / 3;
    const px = x + Math.cos(a) * s, py = y + Math.sin(a) * s;
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
  c.closePath();
}

/** A shield taking a round: the struck arc of the bubble lights up, its
 *  hexagon cells flare as a ripple runs out from the contact point, and
 *  the round sparks off. `ang` points from the centre to the contact. */
export function drawShieldHit(
  c: CanvasRenderingContext2D, cx: number, cy: number, R: number,
  ang: number, k: number, strength: number, seed: number,
  pal: FxPalette = SHIELD_FX,
): void {
  if (k >= 1) return;
  const a = 1 - k;
  const span = 0.55 + 0.6 * easeOut(k);
  c.lineCap = 'round';
  const band = (lw: number, col: string, al: number, sp: number) => {
    c.strokeStyle = rgba(col, al * a);
    c.lineWidth = lw;
    c.beginPath(); c.arc(cx, cy, R, ang - sp, ang + sp); c.stroke();
  };
  band(R * 0.26, pal.haze, 0.14 * (0.7 + 0.3 * strength), span);
  band(R * 0.1, pal.glow, 0.4, span * 0.8);
  band(Math.max(1, R * 0.035), pal.core, 0.85, span * 0.55);
  // Cells light as the ripple passes them.
  const cell = R * 0.13;
  c.lineWidth = Math.max(0.8, R * 0.025);
  for (let i = -4; i <= 4; i++) {
    const ca = ang + i * (cell * 1.75 / R);
    const ring = Math.abs(i) / 4;
    const lit = Math.max(0, 1 - Math.abs(ring - k * 1.5) * 3);
    if (lit <= 0.02) continue;
    c.strokeStyle = rgba(pal.core, 0.75 * lit * a);
    hexagon(c, cx + Math.cos(ca) * R, cy + Math.sin(ca) * R, cell, ca);
    c.stroke();
  }
  const px = cx + Math.cos(ang) * R, py = cy + Math.sin(ang) * R;
  glowAt(c, px, py, R * 0.45, pal.core, pal.glow, a);
  drawSparks(c, px, py, ang, 1.8, 5, R * 0.9, k, seed, KINETIC_FX, Math.max(0.7, R * 0.03));
}

/** A shield bubble taking a blow: a bright rim and a ring of hexagon
 *  cells flaring all the way round, the ripple running out from `ang`
 *  (where the blow landed) to the far side as `k` runs 0..1. */
export function drawShieldRipple(
  c: CanvasRenderingContext2D, cx: number, cy: number, R: number,
  ang: number, k: number, strength: number, pal: FxPalette = SHIELD_FX,
): void {
  if (k >= 1 || R <= 2) return;
  const a = 1 - k;
  c.lineCap = 'round';
  c.strokeStyle = rgba(pal.glow, 0.32 * a * (0.6 + 0.4 * strength));
  c.lineWidth = Math.max(1.5, R * 0.07);
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = rgba(pal.core, 0.6 * a);
  c.lineWidth = Math.max(0.8, R * 0.018);
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
  const cell = Math.max(2.5, R * 0.075);
  const n = Math.max(8, Math.round((Math.PI * 2 * R) / (cell * 1.8)));
  c.lineWidth = Math.max(0.7, R * 0.012);
  for (let i = 0; i < n; i++) {
    const ca = (i / n) * Math.PI * 2;
    // Angular distance from the blow, 0..1 (1 = the far side).
    let d = Math.abs(((ca - ang) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI) / Math.PI;
    d = 1 - d;
    const lit = Math.max(0, 1 - Math.abs(d - k * 1.25) * 4);
    if (lit <= 0.03) continue;
    c.strokeStyle = rgba(pal.core, 0.7 * lit * a);
    hexagon(c, cx + Math.cos(ca) * R, cy + Math.sin(ca) * R, cell, ca);
    c.stroke();
  }
  glowAt(c, cx + Math.cos(ang) * R, cy + Math.sin(ang) * R, R * 0.35, pal.core, pal.glow, a);
}

/** Energy burning into a hull: a molten spot that blooms white, then
 *  cools through orange, with droplets thrown off. */
export function drawScorch(
  c: CanvasRenderingContext2D, x: number, y: number, size: number,
  k: number, back: number, seed: number,
): void {
  if (k >= 1) return;
  const hot = k < 0.35 ? ['#ffffff', '#9fe6ff'] : k < 0.7 ? ['#fff0c8', '#ff9a3c'] : ['#ffb070', '#c2381a'];
  glowAt(c, x, y, size * (0.6 + 0.5 * easeOut(k)), hot[0], hot[1], 1 - k * 0.8);
  drawSparks(c, x, y, back, 2.8, 5, size * 1.8, k, seed, FIRE_FX, Math.max(0.7, size * 0.06));
}

// ---- explosions -----------------------------------------------------

/** A hull exploding, sized by `R` (about the hull's radius). `k` 0..1
 *  is the whole event: a white flash, rolling fire that cools from
 *  white to deep red, a soft shockwave (no outline), sparks, then smoke
 *  that outlives the fire. Sets its own composite. */
export function drawExplosion(
  c: CanvasRenderingContext2D, x: number, y: number, R: number,
  k: number, seed: number,
): void {
  if (k >= 1 || R <= 0) return;
  const rng = mulberry32(seed >>> 0);
  const e = easeOut(k);
  c.save();
  // Smoke: matter, normal blend, rising as the fire dies.
  c.globalCompositeOperation = 'source-over';
  // Smoke only once the fire has room to show it: early, it read as a
  // dark disc behind the fireball.
  const smokeA = k < 0.25 ? 0 : k < 0.45 ? (k - 0.25) / 0.2 : 1 - (k - 0.45) / 0.55;
  for (let i = 0; i < 6; i++) {
    const a = rng() * Math.PI * 2, d = R * (0.3 + 1.1 * e) * (0.5 + rng() * 0.5);
    glowAt(c, x + Math.cos(a) * d, y + Math.sin(a) * d, R * (0.5 + 1.0 * e) * (0.7 + rng() * 0.4),
      '#2b2724', '#1b1816', 0.42 * smokeA);
  }
  c.globalCompositeOperation = 'lighter';
  // Shockwave: a soft band of light, no line.
  // It starts outside the fireball and stays a band, never a disc.
  const sr = R * (1.3 + 4.4 * e);
  const th = R * 1.0;
  const sa = 0.18 * (1 - k) * (1 - k) * Math.min(1, k / 0.06);
  if (sa > 0.01) {
    const g = c.createRadialGradient(x, y, Math.max(0, sr - th), x, y, sr + th * 0.25);
    g.addColorStop(0, 'rgba(255, 214, 170, 0)');
    g.addColorStop(0.7, `rgba(255, 214, 170, ${sa.toFixed(3)})`);
    g.addColorStop(1, 'rgba(255, 214, 170, 0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, sr + th * 0.25, 0, Math.PI * 2); c.fill();
  }
  // Fire: puffs cooling as k runs.
  const [core, glow] = k < 0.14 ? ['#ffffff', '#ffe2a0']
    : k < 0.42 ? ['#ffe6a8', '#ff7a1f'] : ['#ff9a4a', '#a8240e'];
  const fireA = Math.pow(1 - k, 1.5);
  for (let i = 0; i < 7; i++) {
    const a = rng() * Math.PI * 2, d = R * 0.6 * e * rng();
    glowAt(c, x + Math.cos(a) * d, y + Math.sin(a) * d, R * (0.55 + 0.45 * rng()) * (0.6 + 0.8 * e),
      core, glow, fireA);
  }
  if (k < 0.12) glowAt(c, x, y, R * 2.6, '#ffffff', '#fff0c8', 1 - k / 0.12);
  drawSparks(c, x, y, 0, Math.PI * 2, 12, R * 4.2, Math.min(1, k * 1.6), seed ^ 0x9e3779b9, KINETIC_FX,
    Math.max(0.9, R * 0.07));
  c.restore();
}

// ---- hull breakup ---------------------------------------------------

/** What a dying hull looked like when it was last drawn. */
export interface HullLook {
  img: CanvasImageSource;
  /** Drawn size (px at the zoom it was recorded at). */
  size: number;
  /** Drawn rotation, radians. */
  heading: number;
}

const charred = new WeakMap<object, HTMLCanvasElement>();
let charredBytes = 0;
function charredOf(img: CanvasImageSource): HTMLCanvasElement | null {
  const hit = charred.get(img as object);
  if (hit) return hit;
  if (typeof document === 'undefined') return null;
  const w = (img as HTMLImageElement).naturalWidth || (img as HTMLCanvasElement).width;
  const h = (img as HTMLImageElement).naturalHeight || (img as HTMLCanvasElement).height;
  if (!w || !h) return null;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  if (!g) return null;
  charredBytes += w * h * 4;
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = 'rgba(26, 21, 18, 0.62)';
  g.fillRect(0, 0, w, h);
  charred.set(img as object, cv);
  return cv;
}

interface Piece { a0: number; a1: number; jx: number; jy: number; spin: number; push: number }
const pieceCache = new Map<number, Piece[]>();
function piecesOf(seed: number): Piece[] {
  const hit = pieceCache.get(seed);
  if (hit) return hit;
  const rng = mulberry32(seed >>> 0);
  const n = 3 + Math.floor(rng() * 2);
  const cuts: number[] = [];
  const base = rng() * Math.PI * 2;
  for (let i = 0; i < n; i++) cuts.push(base + (i + 0.25 + rng() * 0.5) * (Math.PI * 2 / n));
  const ps: Piece[] = [];
  for (let i = 0; i < n; i++) {
    ps.push({
      a0: cuts[i], a1: cuts[(i + 1) % n] + (i === n - 1 ? Math.PI * 2 : 0),
      jx: (rng() - 0.5) * 0.12, jy: (rng() - 0.5) * 0.12,
      spin: (rng() - 0.5) * 1.6, push: 0.7 + rng() * 0.6,
    });
  }
  if (pieceCache.size > 400) pieceCache.clear();
  pieceCache.set(seed, ps);
  return ps;
}

/** The hull coming apart: its own sprite cut into 3-4 wedges that fly
 *  apart and tumble, glowing at the breaks, cooling to char. `ageMs` is
 *  time since death; `alpha` fades the whole wreck at the end of its
 *  life. Pieces are what remains at the kill site. */
export function drawHullBreakup(
  c: CanvasRenderingContext2D, look: HullLook, x: number, y: number,
  scale: number, ageMs: number, seed: number, alpha: number,
): void {
  const img = charredOf(look.img);
  if (!img || alpha <= 0) return;
  const S = look.size * scale;
  const fly = easeOut(Math.min(1, ageMs / 1800));
  const drift = Math.min(ageMs, 120000) / 1000;
  const heat = Math.max(0, 1 - ageMs / 2600);
  const R = S * 0.78;
  for (const p of piecesOf(seed)) {
    const mid = (p.a0 + p.a1) / 2;
    const dir = look.heading + mid;
    const d = S * (0.06 + 0.42 * fly * p.push) + S * 0.012 * drift * p.push;
    const px = x + Math.cos(dir) * d, py = y + Math.sin(dir) * d;
    const rot = look.heading + p.spin * (0.5 * fly + 0.04 * drift);
    c.save();
    c.translate(px, py);
    c.rotate(rot);
    c.globalAlpha *= alpha;
    c.beginPath();
    const ox = p.jx * S, oy = p.jy * S;
    c.moveTo(ox, oy);
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      const a = p.a0 + (p.a1 - p.a0) * (i / steps);
      c.lineTo(Math.cos(a) * R, Math.sin(a) * R);
    }
    c.closePath();
    c.save();
    c.clip();
    // The hull itself for a moment, then char.
    if (ageMs < 500) {
      c.drawImage(look.img, -S / 2, -S / 2, S, S);
      c.globalAlpha *= ageMs / 500;
    }
    c.drawImage(img, -S / 2, -S / 2, S, S);
    c.restore();
    if (heat > 0) {
      // The torn edges, white-hot and cooling.
      c.globalCompositeOperation = 'lighter';
      c.lineCap = 'round';
      const edge = (a: number) => {
        c.beginPath(); c.moveTo(ox, oy); c.lineTo(Math.cos(a) * R * 0.62, Math.sin(a) * R * 0.62);
      };
      c.strokeStyle = rgba(heat > 0.5 ? '#ffd27a' : '#ff6a2a', 0.85 * heat);
      c.lineWidth = Math.max(1, S * 0.035);
      edge(p.a0); c.stroke();
      edge(p.a1); c.stroke();
      glowAt(c, ox, oy, S * 0.22, '#fff0c8', '#ff7a1f', heat);
    }
    c.restore();
  }
}

/** Plates of an unknown hull: irregular charred slabs with a glint, the
 *  fallback when the dead ship's look was never recorded. Normal blend. */
export function drawPlates(
  c: CanvasRenderingContext2D, x: number, y: number, size: number,
  alpha: number, ageMs: number, seed: number,
): void {
  const rng = mulberry32(seed >>> 0);
  const fly = easeOut(Math.min(1, ageMs / 1800));
  const tumble = ageMs / 5000;
  for (let i = 0; i < 4; i++) {
    const a = rng() * Math.PI * 2;
    const d = size * (0.12 + 0.5 * fly) * (0.5 + rng() * 0.6);
    const s = size * (0.22 + rng() * 0.2);
    c.save();
    c.translate(x + Math.cos(a) * d, y + Math.sin(a) * d);
    c.rotate(a * 1.7 + tumble * (rng() - 0.5) * 2);
    c.beginPath();
    c.moveTo(-s * 0.5, -s * 0.2);
    c.lineTo(s * (0.3 + rng() * 0.2), -s * 0.32);
    c.lineTo(s * 0.5, s * 0.18);
    c.lineTo(-s * (0.2 + rng() * 0.2), s * 0.3);
    c.closePath();
    c.fillStyle = `rgba(58, 54, 52, ${(0.9 * alpha).toFixed(3)})`;
    c.fill();
    c.strokeStyle = `rgba(150, 142, 132, ${(0.5 * alpha).toFixed(3)})`;
    c.lineWidth = Math.max(0.6, s * 0.06);
    c.stroke();
    c.restore();
  }
}

// ---- fire on a hull -------------------------------------------------

/** A hull on fire: flames at seeded points ON the hull, flickering, and
 *  smoke streaming one way off it. `sev` 0..1 sets how many and how big.
 *  Sets its own composite. */
export function drawHullFire(
  c: CanvasRenderingContext2D, x: number, y: number, hullR: number,
  sev: number, nowMs: number, seed: number,
): void {
  if (sev <= 0) return;
  const rng = mulberry32(seed >>> 0);
  const ph = rng() * Math.PI * 2;
  const windA = ph + 1.1;
  const fires = 1 + Math.round(sev * 2.2);
  const spots: [number, number][] = [];
  for (let i = 0; i < fires; i++) {
    const a = rng() * Math.PI * 2, d = hullR * (0.15 + rng() * 0.4);
    spots.push([x + Math.cos(a) * d, y + Math.sin(a) * d]);
  }
  c.save();
  c.globalCompositeOperation = 'source-over';
  spots.forEach(([fx, fy], i) => {
    for (let j = 0; j < 3; j++) {
      const t = ((nowMs / 1700) + j / 3 + i * 0.29) % 1;
      const d = hullR * (0.15 + 1.4 * t);
      glowAt(c, fx + Math.cos(windA) * d, fy + Math.sin(windA) * d, hullR * (0.18 + 0.4 * t) * (0.6 + sev * 0.6),
        '#3a3532', '#24201e', 0.55 * (1 - t) * (0.4 + 0.6 * sev));
    }
  });
  c.globalCompositeOperation = 'lighter';
  spots.forEach(([fx, fy], i) => {
    const f = 0.62 + 0.38 * Math.sin(nowMs / 85 + i * 2.1 + ph) * Math.sin(nowMs / 137 + i);
    const r = hullR * (0.16 + 0.16 * sev) * (0.75 + 0.5 * f);
    glowAt(c, fx, fy, r * 2.1, '#ffd890', '#ff6a1f', 0.55 * f);
    glowAt(c, fx, fy, r * 0.8, '#fffaf0', '#ffc062', 0.9 * f);
    // A tongue of flame streaming with the smoke.
    petal(c, fx, fy, windA + Math.sin(nowMs / 160 + i) * 0.25, r * 2.6, 0.32, FIRE_FX, 0.7 * f);
  });
  c.restore();
}

/** Backing-store bytes of every baked effect sprite, for the renderer's
 *  memory gauge (mapRenderer.rendererCanvasBytes). Charred hulls are
 *  counted as made; they are few (one per distinct hull look). */
export function fxSpriteBytes(): number {
  let b = charredBytes;
  for (const m of [glowCache, streakCache, petalCache]) for (const cv of m.values()) b += cv.width * cv.height * 4;
  return b;
}

/** One flak air-burst at (x, y), `k` 0..1 over its life: an orange flash,
 *  shrapnel flung all round, and a dark puff of smoke that lingers and
 *  spreads. Not aimed at a hull: flak fills the space round a fleet.
 *  Sets its own composite. */
export function drawFlakBurst(
  c: CanvasRenderingContext2D, x: number, y: number, size: number,
  k: number, seed: number,
): void {
  if (k >= 1 || size <= 0) return;
  const e = easeOut(k);
  c.save();
  c.globalCompositeOperation = 'source-over';
  // Smoke a shade lighter than space, or it vanishes against it.
  glowAt(c, x, y, size * (0.6 + 0.9 * e), '#7a7168', '#3e3833', 0.6 * (1 - k) * Math.min(1, k / 0.08));
  c.globalCompositeOperation = 'lighter';
  if (k < 0.28) {
    const fk = k / 0.28;
    glowAt(c, x, y, size * (1.0 + 0.9 * fk), '#fff6dc', '#ff9a3c', 1 - fk);
    glowAt(c, x, y, size * 0.45, '#ffffff', '#ffd27a', (1 - fk) * 0.9);
  }
  drawSparks(c, x, y, 0, Math.PI * 2, 9, size * 2.1, Math.min(1, k * 1.4), seed, KINETIC_FX,
    Math.max(0.8, size * 0.08));
  c.restore();
}

/** Shrapnel hanging round a hull a flak screen has slowed: glinting specks
 *  drifting about it and a faint haze, thicker the harder it is slowed
 *  (`slow` 0..1, where 1 is the 50% floor). Sets its own composite. */
export function drawFlakDrag(
  c: CanvasRenderingContext2D, x: number, y: number, hullR: number,
  slow: number, nowMs: number, seed: number,
): void {
  if (slow <= 0) return;
  const rng = mulberry32(seed >>> 0);
  c.save();
  c.globalCompositeOperation = 'source-over';
  glowAt(c, x, y, hullR * 1.25, '#3a3632', '#22201e', 0.22 * slow);
  c.globalCompositeOperation = 'lighter';
  const n = 3 + Math.round(6 * slow);
  for (let i = 0; i < n; i++) {
    const a0 = rng() * Math.PI * 2, rr = hullR * (0.65 + rng() * 0.6);
    const a = a0 + (nowMs / (2600 + rng() * 1800)) * (rng() < 0.5 ? 1 : -1);
    const glint = 0.35 + 0.65 * Math.max(0, Math.sin(nowMs / (90 + rng() * 140) + i * 1.9));
    glowAt(c, x + Math.cos(a) * rr, y + Math.sin(a) * rr, Math.max(1.1, hullR * 0.06),
      '#fff1d6', '#ff9a3c', 0.75 * glint * (0.5 + 0.5 * slow));
  }
  c.restore();
}
