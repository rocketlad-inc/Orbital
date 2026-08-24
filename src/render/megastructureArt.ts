// ============================================================
// Megastructure art — orbital construction, not iconography.
//
// The first pass of this file drew hexagons and glowing rings. They read
// as UI: a symbol FOR a structure rather than a structure. What makes
// something look like it was assembled in orbit is not its outline, it
// is the hardware — triangulated girder trusses, hull modules bolted on
// at slightly wrong angles, solar wings on booms, radiator fins, a
// gantry crane still attached, running lights.
//
// So this is a small kit of that hardware (truss, module, solarWing,
// radiator, gantry, navLight) and five structures composed out of it.
// Two rules keep the composition honest:
//
//   ASYMMETRY. Real stations are not radially symmetric — they grew.
//   Perfect six-fold symmetry is the strongest tell that a thing was
//   drawn rather than built, so every structure here is deliberately
//   lopsided somewhere.
//
//   MASS BEFORE LIGHT. Fill the plating, stroke the edges, and add glow
//   last and sparingly. The old sprites were mostly glow, which is why
//   they looked like holograms of stations rather than stations.
//
// THE BUILD IS THE STORY, as terraforming taught: a world blooms rather
// than flipping, and the bloom is what makes anyone care they paid. A
// megastructure is thirty freighter runs, so it gets five readable
// states — and the scaffolding is genuinely scaffolding, girders and a
// crane, dismantled as hull goes on.
//
// Canvas, not SVG: these sit in the body-drawing hot path and animate.
// ============================================================

import type { MegastructureKind } from '../game/megastructures';

/** How far through the build each visual stage begins. */
export const BUILD_STAGES = [
  { at: 0.00, name: 'Keel laid' },
  { at: 0.25, name: 'Frame' },
  { at: 0.50, name: 'Plating' },
  { at: 0.75, name: 'Fitting out' },
] as const;

/** The stage label for a progress fraction — also used by the panel, so
 *  the words under the bar match the shape on the map. */
export function buildStageName(progress: number): string {
  let name = BUILD_STAGES[0].name as string;
  for (const s of BUILD_STAGES) if (progress >= s.at) name = s.name;
  return name;
}

type G = CanvasRenderingContext2D;

/** Deterministic 0..1 — stable placement rather than per-frame jitter. */
function h01(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/** `#rrggbb` + alpha -> rgba(). The catalogue stores hex; canvas
 *  gradients need per-stop alpha. */
export function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(160, 190, 210, ${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// ------------------------------------------------------------
// THE HARDWARE KIT
// ------------------------------------------------------------

const HULL_LIT = 'rgba(176, 190, 204, 0.95)';
const HULL_MID = 'rgba(120, 134, 150, 0.95)';
const HULL_DARK = 'rgba(52, 62, 76, 0.95)';
const EDGE = 'rgba(214, 228, 240, 0.85)';

/**
 * A triangulated girder run between two points. The single most
 * important shape in the file: a zig-zag inside two rails is what the
 * eye reads as structural steel, and without it nothing else here would
 * look like construction.
 */
function truss(g: G, x1: number, y1: number, x2: number, y2: number, w: number, bays: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * w * 0.5;
  const ny = (dx / len) * w * 0.5;

  g.lineWidth = Math.max(0.6, w * 0.16);
  g.strokeStyle = HULL_MID;
  g.beginPath();
  g.moveTo(x1 + nx, y1 + ny); g.lineTo(x2 + nx, y2 + ny);
  g.moveTo(x1 - nx, y1 - ny); g.lineTo(x2 - nx, y2 - ny);
  g.stroke();

  g.lineWidth = Math.max(0.5, w * 0.12);
  g.beginPath();
  for (let i = 0; i < bays; i++) {
    const t0 = i / bays;
    const t1 = (i + 1) / bays;
    const ax = x1 + dx * t0, ay = y1 + dy * t0;
    const bx = x1 + dx * t1, by = y1 + dy * t1;
    if (i % 2 === 0) { g.moveTo(ax + nx, ay + ny); g.lineTo(bx - nx, by - ny); }
    else { g.moveTo(ax - nx, ay - ny); g.lineTo(bx + nx, by + ny); }
    g.moveTo(bx + nx, by + ny); g.lineTo(bx - nx, by - ny);
  }
  g.stroke();
}

/** A hull module: a plated box with a lit edge and a shadowed one, so it
 *  reads as a solid under a light rather than a flat rectangle. */
function moduleBox(
  g: G, cx: number, cy: number, w: number, h: number, rot: number, tint?: string,
) {
  g.save();
  g.translate(cx, cy);
  g.rotate(rot);
  const grad = g.createLinearGradient(0, -h / 2, 0, h / 2);
  grad.addColorStop(0, HULL_LIT);
  grad.addColorStop(0.55, HULL_MID);
  grad.addColorStop(1, HULL_DARK);
  g.fillStyle = grad;
  g.fillRect(-w / 2, -h / 2, w, h);
  if (tint) {
    g.fillStyle = withAlpha(tint, 0.2);
    g.fillRect(-w / 2, -h / 2, w, h);
  }
  g.strokeStyle = EDGE;
  g.lineWidth = Math.max(0.5, Math.min(w, h) * 0.09);
  g.strokeRect(-w / 2, -h / 2, w, h);
  // Panel lines — surface detail at almost no cost.
  g.strokeStyle = 'rgba(30, 38, 48, 0.55)';
  g.lineWidth = Math.max(0.4, Math.min(w, h) * 0.05);
  g.beginPath();
  for (let i = 1; i < 3; i++) {
    const x = -w / 2 + (w * i) / 3;
    g.moveTo(x, -h / 2); g.lineTo(x, h / 2);
  }
  g.stroke();
  g.restore();
}

/** A solar wing on a boom: a gridded panel. */
function solarWing(g: G, x: number, y: number, len: number, wide: number, rot: number) {
  if (len <= 0.5) return;
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.strokeStyle = HULL_MID;
  g.lineWidth = Math.max(0.6, wide * 0.14);
  g.beginPath(); g.moveTo(0, 0); g.lineTo(len * 0.28, 0); g.stroke();

  const px = len * 0.28;
  const pw = len * 0.72;
  g.fillStyle = 'rgba(34, 52, 92, 0.95)';
  g.fillRect(px, -wide / 2, pw, wide);
  g.strokeStyle = 'rgba(150, 180, 215, 0.75)';
  g.lineWidth = Math.max(0.4, wide * 0.08);
  g.strokeRect(px, -wide / 2, pw, wide);
  // Cell grid — the thing that says solar rather than flag.
  g.strokeStyle = 'rgba(120, 155, 200, 0.5)';
  g.lineWidth = Math.max(0.3, wide * 0.05);
  g.beginPath();
  for (let i = 1; i < 5; i++) {
    const gx = px + (pw * i) / 5;
    g.moveTo(gx, -wide / 2); g.lineTo(gx, wide / 2);
  }
  g.moveTo(px, 0); g.lineTo(px + pw, 0);
  g.stroke();
  g.restore();
}

/** A radiator fin — flat, pale, ribbed. */
function radiator(g: G, x: number, y: number, len: number, wide: number, rot: number) {
  if (len <= 0.5) return;
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.fillStyle = 'rgba(196, 204, 214, 0.9)';
  g.fillRect(0, -wide / 2, len, wide);
  g.strokeStyle = 'rgba(90, 100, 114, 0.9)';
  g.lineWidth = Math.max(0.3, wide * 0.09);
  g.beginPath();
  for (let i = 1; i < 4; i++) {
    const rx = (len * i) / 4;
    g.moveTo(rx, -wide / 2); g.lineTo(rx, wide / 2);
  }
  g.stroke();
  g.restore();
}

/** A gantry crane with a swaying hook — plant, not structure, so it is
 *  the one thing here drawn in work yellow. */
function gantry(g: G, x: number, y: number, arm: number, rot: number, swing: number) {
  if (arm <= 1) return;
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.strokeStyle = 'rgba(198, 168, 92, 0.9)';
  g.lineWidth = Math.max(0.7, arm * 0.07);
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(arm * 0.55, -arm * 0.35);
  g.lineTo(arm, -arm * 0.35);
  g.stroke();
  g.strokeStyle = 'rgba(180, 190, 200, 0.7)';
  g.lineWidth = Math.max(0.4, arm * 0.035);
  const hx = arm * 0.86;
  const hy = -arm * 0.35 + arm * (0.3 + 0.1 * swing);
  g.beginPath(); g.moveTo(hx, -arm * 0.35); g.lineTo(hx, hy); g.stroke();
  g.fillStyle = 'rgba(198, 168, 92, 0.95)';
  g.fillRect(hx - arm * 0.05, hy, arm * 0.1, arm * 0.07);
  g.restore();
}

/** A running light — small, and the only saturated colour on the hull. */
function navLight(g: G, x: number, y: number, r: number, rgb: string, on: number) {
  if (on <= 0.05) return;
  g.fillStyle = `rgba(${rgb}, ${on})`;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

function bloom(g: G, cx: number, cy: number, r: number, tint: string, alpha: number) {
  const grad = g.createRadialGradient(cx, cy, r * 0.25, cx, cy, r);
  grad.addColorStop(0, withAlpha(tint, alpha));
  grad.addColorStop(1, withAlpha(tint, 0));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
}

// ------------------------------------------------------------
// THE SLIPWAY
// ------------------------------------------------------------

/**
 * A site under construction: a real drydock. A keel spine with truss
 * ribs, a crane working it, and hull modules going on one at a time.
 *
 * One sprite for all seven, because from any distance an unfinished gate
 * and an unfinished gun platform ARE the same thing — a frame somebody
 * is pouring freight into. What differs is how much of it exists.
 */
export function drawConstructionSite(
  g: G,
  cx: number, cy: number, R: number,
  progress: number,
  tint: string,
  nowMs: number,
  /** The finished form, faded in under the scaffold while fitting out. */
  ghost?: () => void,
) {
  const p = Math.max(0, Math.min(1, progress));
  const spin = (nowMs / 26000) % (Math.PI * 2);   // very slow: this is heavy
  const swing = Math.sin(nowMs / 1700);

  g.save();
  g.translate(cx, cy);
  g.rotate(spin);
  g.lineCap = 'butt';

  // --- KEEL. A spine and one rib, there from the first delivery, so the
  // site reads as a drydock rather than a marker.
  truss(g, -R * 0.95, 0, R * 0.95, 0, R * 0.3, 7);
  truss(g, 0, -R * 0.8, 0, R * 0.8, R * 0.24, 6);

  // --- FRAME. Ribs grow outward into a cradle that will hold the hull.
  if (p >= 0.25) {
    const f = Math.min(1, (p - 0.25) / 0.25);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      truss(g,
        Math.cos(a) * R * 0.35, Math.sin(a) * R * 0.35,
        Math.cos(a) * R * (0.35 + 0.75 * f), Math.sin(a) * R * (0.35 + 0.75 * f),
        R * 0.2, 4);
    }
  }

  // --- PLATING. Modules bolt onto the cradle in the structure's colour,
  // deliberately unevenly: hull goes on where the crane happens to be.
  if (p >= 0.5) {
    const f = Math.min(1, (p - 0.5) / 0.25);
    const n = Math.round(6 * f);
    for (let i = 0; i < n; i++) {
      const a = (i / 6) * Math.PI * 2 + h01(i) * 0.5;
      const rr = R * (0.55 + 0.28 * h01(i + 9));
      moduleBox(g,
        Math.cos(a) * rr, Math.sin(a) * rr,
        R * (0.34 + 0.16 * h01(i + 3)), R * (0.2 + 0.1 * h01(i + 17)),
        a + h01(i + 5) * 0.7, tint);
    }
  }

  // --- FITTING OUT. Radiators and a solar wing deploy, and a ghost of
  // the finished form fades up. Until this existed every structure
  // looked identical right until it completed, so the last quarter of a
  // thirty-run project said nothing about what you were getting.
  if (p >= 0.75) {
    const f = Math.min(1, (p - 0.75) / 0.25);
    radiator(g, R * 0.2, -R * 0.75, R * 0.55 * f, R * 0.16, -0.2);
    radiator(g, -R * 0.2, R * 0.75, R * 0.55 * f, R * 0.16, Math.PI - 0.2);
    solarWing(g, -R * 0.7, -R * 0.25, R * 0.8 * f, R * 0.22, Math.PI * 0.86);
    if (ghost) {
      g.save();
      g.globalAlpha = 0.4 * f;
      g.rotate(-spin);
      g.translate(-cx, -cy);
      ghost();
      g.restore();
    }
  }

  // --- THE CRANE. At full reach on an empty frame and gone by the time
  // the hull closes up — the clearest single read of how far along this
  // is, without looking at a number.
  const craneF = 1 - Math.min(1, Math.max(0, (p - 0.35) / 0.55));
  if (craneF > 0.02) gantry(g, R * 0.15, -R * 0.1, R * 0.95 * craneF, -0.5, swing);

  // --- Work lights. Somebody is here right now.
  if (p > 0.02 && R >= 7) {
    for (let i = 0; i < 5; i++) {
      const blink = Math.sin(nowMs / (520 + i * 190) + i * 2.1);
      const a = h01(i) * Math.PI * 2;
      const rr = R * (0.5 + 0.45 * h01(i + 40));
      navLight(g, Math.cos(a) * rr, Math.sin(a) * rr,
        Math.max(0.7, R * 0.05), '255, 226, 160', Math.max(0, blink));
    }
  }

  g.restore();

  // --- Progress arc, outermost and unrotated. The one thing a rival
  // needs from across the map: how long have I got.
  g.save();
  g.strokeStyle = 'rgba(140, 165, 185, 0.2)';
  g.lineWidth = Math.max(1, R * 0.055);
  g.beginPath(); g.arc(cx, cy, R * 1.35, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = withAlpha(tint, 0.9);
  g.lineWidth = Math.max(1.5, R * 0.1);
  g.lineCap = 'butt';
  g.beginPath();
  g.arc(cx, cy, R * 1.35, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
  g.stroke();
  g.restore();
}

// ------------------------------------------------------------
// THE FINISHED THINGS
// ------------------------------------------------------------

export function drawCompletedStructure(
  g: G,
  cx: number, cy: number, R: number,
  kind: MegastructureKind,
  tint: string,
  nowMs: number,
) {
  switch (kind) {
    case 'warp_gate':       return drawWarpGate(g, cx, cy, R, tint, nowMs);
    case 'weapons_station': return drawWeaponsStation(g, cx, cy, R, tint, nowMs);
    case 'gravity_sink':    return drawGravitySink(g, cx, cy, R, tint, nowMs);
    case 'deep_array':      return drawDeepArray(g, cx, cy, R, tint, nowMs);
    case 'null_field':      return drawNullField(g, cx, cy, R, tint, nowMs);
    default:                return drawGenericComplete(g, cx, cy, R, tint, nowMs);
  }
}

/**
 * A gate: a segmented accelerator ring on truss spines, with emitter
 * housings at the quarters and a control module off to one side. The
 * ring is built in EIGHT visible segments with flanges between them,
 * because a smooth torus reads as a drawn circle and a segmented one
 * reads as something that arrived in pieces.
 */
function drawWarpGate(g: G, cx: number, cy: number, R: number, tint: string, now: number) {
  const spin = (now / 30000) % (Math.PI * 2);
  const pulse = 0.5 + 0.5 * Math.sin(now / 900);
  g.save();
  g.translate(cx, cy);
  bloom(g, 0, 0, R * 2.1, tint, 0.13 + 0.05 * pulse);

  // The aperture, behind the hardware.
  const throat = g.createRadialGradient(0, 0, 0, 0, 0, R * 0.72);
  throat.addColorStop(0, `rgba(226, 248, 255, ${0.75 * (0.65 + 0.35 * pulse)})`);
  throat.addColorStop(0.5, withAlpha(tint, 0.45));
  throat.addColorStop(1, 'rgba(14, 26, 60, 0.9)');
  g.fillStyle = throat;
  g.beginPath(); g.arc(0, 0, R * 0.72, 0, Math.PI * 2); g.fill();

  g.rotate(spin);

  // Eight ring segments with flanges between.
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2 + 0.055;
    const a1 = ((i + 1) / 8) * Math.PI * 2 - 0.055;
    g.lineCap = 'butt';
    g.strokeStyle = i % 2 ? HULL_MID : HULL_LIT;
    g.lineWidth = R * 0.26;
    g.beginPath(); g.arc(0, 0, R * 0.93, a0, a1); g.stroke();
    g.strokeStyle = 'rgba(28, 36, 46, 0.55)';
    g.lineWidth = R * 0.05;
    g.beginPath(); g.arc(0, 0, R * 0.93, a0, a1); g.stroke();
  }

  // Inner emitter lip.
  g.strokeStyle = withAlpha(tint, 0.55 + 0.35 * pulse);
  g.lineWidth = Math.max(1, R * 0.07);
  g.beginPath(); g.arc(0, 0, R * 0.79, 0, Math.PI * 2); g.stroke();

  // Emitter housings on truss spines.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 8;
    const ox = Math.cos(a), oy = Math.sin(a);
    truss(g, ox * R * 1.06, oy * R * 1.06, ox * R * 1.46, oy * R * 1.46, R * 0.2, 3);
    moduleBox(g, ox * R * 1.54, oy * R * 1.54, R * 0.3, R * 0.42, a);
    navLight(g, ox * R * 1.7, oy * R * 1.7, Math.max(0.7, R * 0.05),
      '120, 230, 255', 0.5 + 0.5 * pulse);
  }

  // ASYMMETRY: a control block and its wing, so the ring stops looking
  // like a symbol.
  moduleBox(g, R * 1.12, -R * 1.12, R * 0.5, R * 0.3, -0.6);
  solarWing(g, R * 1.34, -R * 1.26, R * 0.8, R * 0.2, -0.35);

  g.restore();
}

/** A gun platform: armoured core, two turret sponsons with twin barrels,
 *  an ammunition drum, radiators, and a sensor mast off one shoulder. */
function drawWeaponsStation(g: G, cx: number, cy: number, R: number, tint: string, now: number) {
  const spin = (now / 22000) % (Math.PI * 2);
  const charge = 0.5 + 0.5 * Math.sin(now / 700);
  g.save();
  g.translate(cx, cy);
  bloom(g, 0, 0, R * 1.9, tint, 0.1 + 0.04 * charge);
  g.rotate(spin);

  // Radiators sit behind the hull.
  radiator(g, 0, -R * 0.5, R * 1.15, R * 0.17, -Math.PI / 2 - 0.25);
  radiator(g, 0, R * 0.5, R * 1.15, R * 0.17, Math.PI / 2 - 0.25);

  // Core: two stacked boxes rather than one, so it reads as assembled.
  moduleBox(g, 0, 0, R * 1.05, R * 0.72, 0, tint);
  moduleBox(g, 0, 0, R * 0.62, R * 1.0, 0);

  // Turret sponsons on opposite corners, twin barrels each.
  for (const s of [1, -1]) {
    const bx = s * R * 0.72, by = s * R * 0.42;
    moduleBox(g, bx, by, R * 0.44, R * 0.44, 0.35 * s);
    g.strokeStyle = HULL_LIT;
    g.lineWidth = Math.max(1, R * 0.1);
    g.lineCap = 'round';
    for (const o of [-0.13, 0.13]) {
      const a = 0.35 * s + o;
      const ex = bx + Math.cos(a) * R * s * 0.95;
      const ey = by + Math.sin(a) * R * s * 0.95;
      g.beginPath(); g.moveTo(bx, by); g.lineTo(ex, ey); g.stroke();
      navLight(g, ex, ey, Math.max(0.8, R * 0.07), '255, 190, 140', 0.35 + 0.55 * charge);
    }
  }

  // Ammunition drum, off-centre.
  g.fillStyle = HULL_MID;
  g.strokeStyle = EDGE;
  g.lineWidth = Math.max(0.6, R * 0.05);
  g.beginPath(); g.arc(-R * 0.55, R * 0.62, R * 0.26, 0, Math.PI * 2);
  g.fill(); g.stroke();

  // Sensor mast.
  truss(g, R * 0.2, -R * 0.6, R * 0.52, -R * 1.3, R * 0.14, 3);
  moduleBox(g, R * 0.56, -R * 1.4, R * 0.2, R * 0.2, 0.4);

  g.restore();
}

/** A well: a ring of generator drums on truss, wrapped around a
 *  distortion that pulls inward. */
function drawGravitySink(g: G, cx: number, cy: number, R: number, tint: string, now: number) {
  const spin = (now / 34000) % (Math.PI * 2);
  g.save();
  g.translate(cx, cy);
  bloom(g, 0, 0, R * 2.1, tint, 0.1);

  // Rings marching INWARD — the only thing on the board that animates
  // toward its own centre.
  for (let i = 0; i < 4; i++) {
    const phase = ((now / 2600) + i / 4) % 1;
    const rr = R * (1.35 - 1.0 * phase);
    g.strokeStyle = withAlpha(tint, (1 - Math.abs(phase - 0.5) * 2) * 0.65);
    g.lineWidth = Math.max(1, R * 0.08 * (0.5 + phase));
    g.beginPath(); g.arc(0, 0, Math.max(1, rr), 0, Math.PI * 2); g.stroke();
  }
  const well = g.createRadialGradient(0, 0, 0, 0, 0, R * 0.6);
  well.addColorStop(0, 'rgba(3, 2, 9, 0.99)');
  well.addColorStop(0.75, withAlpha(tint, 0.3));
  well.addColorStop(1, withAlpha(tint, 0));
  g.fillStyle = well;
  g.beginPath(); g.arc(0, 0, R * 0.6, 0, Math.PI * 2); g.fill();

  g.rotate(spin);

  // Six generator drums on a truss ring — the machinery doing the work.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const b = ((i + 1) / 6) * Math.PI * 2;
    truss(g,
      Math.cos(a) * R * 1.1, Math.sin(a) * R * 1.1,
      Math.cos(b) * R * 1.1, Math.sin(b) * R * 1.1, R * 0.16, 2);
    moduleBox(g, Math.cos(a) * R * 1.1, Math.sin(a) * R * 1.1,
      R * 0.3, R * 0.46, a + Math.PI / 2, tint);
  }
  // Spokes reaching in toward nothing: the load path is the point — the
  // machinery holds a hole open.
  g.strokeStyle = HULL_DARK;
  g.lineWidth = Math.max(0.8, R * 0.06);
  g.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    g.moveTo(Math.cos(a) * R * 0.62, Math.sin(a) * R * 0.62);
    g.lineTo(Math.cos(a) * R * 1.08, Math.sin(a) * R * 1.08);
  }
  g.stroke();

  g.restore();
}

/** A listening post: one big dish on a truss spine with a counterweight
 *  and a service module, plus two juniors. Deliberately lopsided — a
 *  dish farm grows one antenna at a time. */
function drawDeepArray(g: G, cx: number, cy: number, R: number, tint: string, now: number) {
  const spin = (now / 40000) % (Math.PI * 2);
  const sweep = (now / 3200) % 1;
  g.save();
  g.translate(cx, cy);
  bloom(g, 0, 0, R * 1.8, tint, 0.09);

  g.strokeStyle = withAlpha(tint, 0.45 * (1 - sweep));
  g.lineWidth = Math.max(1, R * 0.06);
  g.beginPath(); g.arc(0, 0, R * (0.8 + 1.5 * sweep), 0, Math.PI * 2); g.stroke();

  g.rotate(spin);

  truss(g, -R * 1.15, 0, R * 1.2, 0, R * 0.22, 8);
  moduleBox(g, -R * 0.15, R * 0.02, R * 0.5, R * 0.36, 0, tint);
  moduleBox(g, R * 1.3, 0, R * 0.26, R * 0.4, 0);
  solarWing(g, -R * 0.3, R * 0.3, R * 1.0, R * 0.22, Math.PI * 0.55);

  /** A parabolic dish: a filled arc, ribs, and a feed horn on a tripod. */
  const dish = (x: number, y: number, r: number, face: number) => {
    g.save();
    g.translate(x, y);
    g.rotate(face);
    g.fillStyle = 'rgba(206, 218, 230, 0.95)';
    g.strokeStyle = EDGE;
    g.lineWidth = Math.max(0.5, r * 0.1);
    g.beginPath();
    g.arc(0, 0, r, -1.35, 1.35);
    g.closePath();
    g.fill(); g.stroke();
    g.strokeStyle = 'rgba(92, 104, 118, 0.75)';
    g.lineWidth = Math.max(0.35, r * 0.06);
    g.beginPath();
    for (const t of [-0.8, -0.3, 0.3, 0.8]) {
      g.moveTo(0, 0); g.lineTo(Math.cos(t) * r, Math.sin(t) * r);
    }
    g.stroke();
    g.strokeStyle = HULL_MID;
    g.lineWidth = Math.max(0.4, r * 0.07);
    g.beginPath();
    g.moveTo(Math.cos(-1) * r * 0.9, Math.sin(-1) * r * 0.9); g.lineTo(r * 0.72, 0);
    g.moveTo(Math.cos(1) * r * 0.9, Math.sin(1) * r * 0.9); g.lineTo(r * 0.72, 0);
    g.stroke();
    g.fillStyle = 'rgba(255, 255, 255, 0.9)';
    g.beginPath(); g.arc(r * 0.72, 0, Math.max(0.5, r * 0.11), 0, Math.PI * 2); g.fill();
    g.restore();
  };

  dish(R * 0.7, -R * 0.15, R * 0.82, -0.35);
  dish(-R * 0.82, -R * 0.5, R * 0.4, -0.9);
  dish(-R * 0.92, R * 0.55, R * 0.34, 0.9);

  g.restore();
}

/** An emitter: four heavy pylons caging a core darker than space, with
 *  conduit between them. The one structure that should look like a fault
 *  in the picture. */
function drawNullField(g: G, cx: number, cy: number, R: number, tint: string, now: number) {
  const spin = (now / 45000) % (Math.PI * 2);
  g.save();
  g.translate(cx, cy);

  const haze = g.createRadialGradient(0, 0, R * 0.3, 0, 0, R * 2.2);
  haze.addColorStop(0, 'rgba(16, 22, 32, 0.6)');
  haze.addColorStop(1, 'rgba(16, 22, 32, 0)');
  g.fillStyle = haze;
  g.beginPath(); g.arc(0, 0, R * 2.2, 0, Math.PI * 2); g.fill();

  g.rotate(spin);

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const ox = Math.cos(a), oy = Math.sin(a);
    truss(g, ox * R * 0.62, oy * R * 0.62, ox * R * 1.38, oy * R * 1.38, R * 0.2, 4);
    moduleBox(g, ox * R * 1.46, oy * R * 1.46, R * 0.34, R * 0.5, a);
    navLight(g, ox * R * 1.62, oy * R * 1.62, Math.max(0.7, R * 0.05),
      '255, 90, 90', 0.35 + 0.4 * Math.abs(Math.sin(now / 1400 + i)));
  }
  g.strokeStyle = HULL_DARK;
  g.lineWidth = Math.max(0.9, R * 0.09);
  g.beginPath(); g.arc(0, 0, R * 1.18, 0, Math.PI * 2); g.stroke();

  g.rotate(-spin);

  // Core: near-black with a hard COLD WHITE rim. The structure's own
  // slate colour is useless as an outline against a starfield, and the
  // most strategically alarming object on the board should not be the
  // hardest to see.
  g.fillStyle = 'rgba(8, 11, 18, 0.98)';
  g.beginPath(); g.arc(0, 0, R * 0.62, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(186, 204, 224, 0.95)';
  g.lineWidth = Math.max(1.2, R * 0.1);
  g.beginPath(); g.arc(0, 0, R * 0.62, 0, Math.PI * 2); g.stroke();

  g.save();
  g.beginPath(); g.arc(0, 0, R * 0.62, 0, Math.PI * 2); g.clip();
  for (let i = 0; i < 6; i++) {
    const y = -R * 0.7 + (((now / 900) + i / 6) % 1) * R * 1.4;
    g.fillStyle = `rgba(180, 205, 225, ${0.06 + 0.14 * h01(i)})`;
    g.fillRect(-R * 0.7, y, R * 1.4, Math.max(0.6, R * 0.06));
  }
  g.restore();

  g.restore();
}

/** Fallback for anything without bespoke art: a plated drum in a truss
 *  collar, which at least reads as hardware. */
function drawGenericComplete(g: G, cx: number, cy: number, R: number, tint: string, now: number) {
  const spin = (now / 30000) % (Math.PI * 2);
  g.save();
  g.translate(cx, cy);
  bloom(g, 0, 0, R * 1.8, tint, 0.1);
  g.rotate(spin);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    truss(g,
      Math.cos(a) * R * 0.55, Math.sin(a) * R * 0.55,
      Math.cos(a) * R * 1.25, Math.sin(a) * R * 1.25, R * 0.18, 3);
  }
  moduleBox(g, 0, 0, R * 1.0, R * 0.8, 0, tint);
  g.restore();
}
