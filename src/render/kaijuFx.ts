// ============================================================
// THE LEVIATHAN'S STRIKES AND ITS DEATH (worker/kaiju.js).
//
// Lorne, 2026-10-08: "build the strike and death animations". Until now
// the ring closed and the world simply changed its look, and a killed
// beast vanished between two frames. Three set pieces, each played from
// the pending-FX queue (pendingFx.ts) so a moment that happened while
// you were elsewhere plays when you next look, exactly once:
//
//   SCORCH  its first strike. The arms REACH out and latch onto the
//           world, violet light pulses DOWN them into it, and the
//           surface burns: the Mega Destroyer's own fire and ash
//           (combatFx spawnSterilisation, with the beam turned off,
//           because this is no gun), then the arms let go.
//   BREAK   its second. The arms WRAP the world and constrict, light
//           cracks open across the disc, the world shakes, flashes
//           white and BURSTS into tumbling shards; the debris field the
//           game already draws is what is left. The planet keeps its
//           own sprite until the burst (kaijuHoldsWorldWhole).
//   DEATH   it thrashes, its eyes flare, its lights die out from violet
//           to grey while ichor spills from it, it goes slack, a last
//           pulse, and it comes apart. The carcass rock remains.
//
// The beast itself is drawn by the game while it lives (mapRenderer
// drawKaijuHull), which notes where it drew it (noteKaijuDrawn) so the
// arms grow from the hull you are looking at. The death draws the
// animal here, because by then it has left /state.
// ============================================================

import { Body } from '../types';
import { bodyPosition } from '../physics/orbitalMechanics';
import { RenderContext, worldToCanvas } from './mapRenderer';
import { drawnRadiusOf } from './bodyPresentation';
import { drawSunSquid, LEVIATHAN_PALETTE, SquidPalette } from './sunSquid';
import { glowAt } from './fxArt';
import { hashStr, mulberry32 } from './planetTexture';

type G = CanvasRenderingContext2D;
type P = { x: number; y: number };

const TWO_PI = Math.PI * 2;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => { const x = clamp01(v); return x * x * (3 - 2 * x); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Timings, ms. The beats matter more than the drawing. */
export const KAIJU_SCORCH_MS = 5600;
export const KAIJU_BREAK_MS = 6400;
export const KAIJU_DEATH_MS = 7600;
/** Where in the break the world bursts (fraction). */
const BREAK_BURST = 0.6;

// ---- where the beast was drawn -----------------------------------------

interface Drawn { x: number; y: number; heading: number; size: number; ms: number }
let lastDrawn: Drawn | null = null;
let lastDrawnShip: string | null = null;

/** mapRenderer calls this every frame it draws the beast (world coords). */
export function noteKaijuDrawn(shipId: string, x: number, y: number, heading: number, size: number): void {
  lastDrawnShip = shipId;
  lastDrawn = { x, y, heading, size, ms: performance.now() };
}

// ---- the queue ----------------------------------------------------------

type Kind = 'scorch' | 'break' | 'death';
interface Fx { id: string; kind: Kind; bodyId: string; startMs: number; seed: number;
  /** For the death: the animal as last drawn, frozen at the start. */
  beast?: Drawn | null }
const live: Fx[] = [];
const seen = new Set<string>();
let deathPlayed = false;

const LIFE: Record<Kind, number> = { scorch: KAIJU_SCORCH_MS, break: KAIJU_BREAK_MS, death: KAIJU_DEATH_MS };

/** Queue a strike. Idempotent on the chronicle entry id. */
export function spawnKaijuStrike(entryId: string, bodyId: string, mode: 'scorch' | 'break'): void {
  if (seen.has(entryId)) return;
  seen.add(entryId);
  if (live.length >= 4) live.shift();
  live.push({ id: entryId, kind: mode, bodyId, startMs: performance.now(), seed: hashStr(entryId) });
}

/** Queue its death, once per page: the hull vanishing on screen (the
 *  live path) and the kaiju_dead chronicle row (the queued path) both
 *  call this, and the first one wins. */
export function spawnKaijuDeath(entryId: string, bodyId: string): void {
  if (deathPlayed || seen.has(entryId)) return;
  seen.add(entryId);
  deathPlayed = true;
  const fresh = lastDrawn && performance.now() - lastDrawn.ms < 120_000 ? { ...lastDrawn } : null;
  live.push({ id: entryId, kind: 'death', bodyId, startMs: performance.now(), seed: hashStr(entryId), beast: fresh });
}

/** Is a hull id the beast? (Its id is fixed per game: `<game>:leviathan`.) */
export function isKaijuShipId(id: string | undefined | null): boolean {
  return !!id && /(^|:)leviathan$/.test(id);
}

export function hasActiveKaijuFx(nowMs: number): boolean {
  return live.some(f => nowMs - f.startMs < LIFE[f.kind]);
}

/**
 * The body renderer asks this before drawing a destroyed world as a
 * debris field: while the Leviathan is still crushing it, it is still a
 * world, and the planet's own sprite stays until the burst.
 */
export function kaijuHoldsWorldWhole(bodyId: string, nowMs: number): boolean {
  for (const f of live) {
    if (f.kind !== 'break' || f.bodyId !== bodyId) continue;
    const k = (nowMs - f.startMs) / KAIJU_BREAK_MS;
    if (k >= 0 && k < BREAK_BURST) return true;
  }
  return false;
}

// ---- drawing helpers ------------------------------------------------------

function bodyOf(rc: RenderContext, id: string): Body | undefined {
  return rc.bodies.find(b => b.id === id);
}

/** A tapered ribbon along a polyline. */
function ribbon(g: G, pts: P[], w0: number, w1: number) {
  const n = pts.length;
  if (n < 2) return;
  const left: P[] = [], right: P[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y;
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    const w = lerp(w0, w1, i / (n - 1)) / 2;
    left.push({ x: pts[i].x - ty * w, y: pts[i].y + tx * w });
    right.push({ x: pts[i].x + ty * w, y: pts[i].y - tx * w });
  }
  g.beginPath();
  g.moveTo(left[0].x, left[0].y);
  for (let i = 1; i < n; i++) g.lineTo(left[i].x, left[i].y);
  for (let i = n - 1; i >= 0; i--) g.lineTo(right[i].x, right[i].y);
  g.closePath();
  g.fill();
}

const quad = (a: P, c: P, b: P, s: number): P => ({
  x: (1 - s) * (1 - s) * a.x + 2 * (1 - s) * s * c.x + s * s * b.x,
  y: (1 - s) * (1 - s) * a.y + 2 * (1 - s) * s * c.y + s * s * b.y,
});

/**
 * One arm from the beast to the world. `reach` 0..1 grows it out; `wrap`
 * (radians, signed) carries it on round the rim once it arrives, which is
 * how the break coils the arms about the planet.
 */
function armPath(root: P, sway: P, hit: P, centre: P, R: number, reach: number, wrap: number, wobble: number): P[] {
  const pts: P[] = [];
  const N = 22;
  const span = Math.max(0, Math.min(1, reach));
  for (let i = 0; i <= N; i++) {
    const s = (i / N) * span;
    const p = quad(root, sway, hit, s);
    // A living thing, not a cable: a travelling ripple along it.
    const nx = -(hit.y - root.y), ny = hit.x - root.x;
    const nl = Math.hypot(nx, ny) || 1;
    const rip = Math.sin(s * 9 - wobble) * R * 0.08 * Math.sin(Math.PI * s);
    pts.push({ x: p.x + (nx / nl) * rip, y: p.y + (ny / nl) * rip });
  }
  if (span >= 1 && Math.abs(wrap) > 0.01) {
    const a0 = Math.atan2(hit.y - centre.y, hit.x - centre.x);
    const M = Math.max(4, Math.ceil(Math.abs(wrap) / 0.12));
    for (let j = 1; j <= M; j++) {
      const a = a0 + (wrap * j) / M;
      const rr = R * 1.02;
      pts.push({ x: centre.x + Math.cos(a) * rr, y: centre.y + Math.sin(a) * rr });
    }
  }
  return pts;
}

/** Draw a set of arms in the beast's colours, with light running down them. */
function drawArms(g: G, arms: P[][], width: number, pulse: number, light: number, nowMs: number,
  tip = 0.22, pal = LEVIATHAN_PALETTE) {
  g.save();
  // Rim first, so a dark limb still reads against space and planet.
  g.fillStyle = `rgba(${pal.glow}, 0.5)`;
  for (const a of arms) ribbon(g, a, width * 1.4, width * (tip + 0.2));
  g.fillStyle = pal.mid;
  for (const a of arms) ribbon(g, a, width, width * tip);
  g.fillStyle = pal.lit;
  for (const a of arms) ribbon(g, a, width * 0.4, width * tip * 0.45);
  // The charge, running from the beast into the world.
  if (light > 0.01) {
    g.globalCompositeOperation = 'lighter';
    arms.forEach((a, i) => {
      for (let q = 0; q < 3; q++) {
        const s = ((nowMs / 520) * (0.8 + pulse) + i * 0.17 + q / 3) % 1;
        const p = a[Math.min(a.length - 1, Math.floor(s * (a.length - 1)))];
        glowAt(g, p.x, p.y, width * (1.6 + 1.4 * light), `rgb(${pal.hot})`, `rgb(${pal.glow})`, 0.85 * light);
      }
    });
  }
  g.restore();
}

/** Where the arms leave the beast (its head, the collar of the mantle). */
function armRoots(beast: Drawn, count: number): P[] {
  const u = beast.size / 6;
  const out: P[] = [];
  for (let i = 0; i < count; i++) {
    const yb = (i / Math.max(1, count - 1) - 0.5) * 0.7 * u;
    const lx = -0.6 * u, ly = yb;
    const c = Math.cos(beast.heading), s = Math.sin(beast.heading);
    out.push({ x: beast.x + lx * c - ly * s, y: beast.y + lx * s + ly * c });
  }
  return out;
}

// ---- the set pieces -------------------------------------------------------

function drawStrike(rc: RenderContext, f: Fx, k: number, nowMs: number) {
  const g = rc.ctx;
  const body = bodyOf(rc, f.bodyId);
  if (!body) return;
  const wp = bodyPosition(body, rc.t, rc.bodies);
  const cp = worldToCanvas(wp.x, wp.y, rc);
  const R = Math.max(6, drawnRadiusOf(rc.presentation, body, rc.camera.scale));
  // The beast where the game drew it; failing that, out on its parking
  // ring on the side away from the Sun.
  const fresh = lastDrawn && nowMs - lastDrawn.ms < 4000 ? lastDrawn : null;
  const bc = fresh ? worldToCanvas(fresh.x, fresh.y, rc) : null;
  const awayA = Math.atan2(wp.y, wp.x);
  const beast: Drawn = bc
    ? { x: bc.x, y: bc.y, heading: fresh!.heading, size: fresh!.size, ms: fresh!.ms }
    : { x: cp.x + Math.cos(awayA) * R * 2.4, y: cp.y + Math.sin(awayA) * R * 2.4, heading: awayA + Math.PI, size: R * 2.2, ms: nowMs };
  const toBeast = Math.atan2(beast.y - cp.y, beast.x - cp.x);
  const rng = mulberry32(f.seed);
  const breakIt = f.kind === 'break';
  const N = breakIt ? 6 : 5;
  const roots = armRoots(beast, N);
  const width = Math.max(3, beast.size * 0.075);

  // Timeline. Scorch: reach 0-.22, pour .22-.62, release .62-.85.
  // Break: reach 0-.2, wrap .2-.36, crush .36-BURST, burst after.
  const reach = breakIt ? smooth(k / 0.2) : smooth(k / 0.22);
  const release = breakIt ? 0 : smooth((k - 0.62) / 0.23);
  const wrapK = breakIt ? smooth((k - 0.2) / 0.16) : 0;
  const crush = breakIt ? smooth((k - 0.36) / (BREAK_BURST - 0.36)) : 0;
  const light = breakIt ? (k < BREAK_BURST ? smooth((k - 0.22) / 0.2) : 0) : (k < 0.66 ? smooth((k - 0.18) / 0.08) : 0);
  const shake = breakIt && k < BREAK_BURST ? crush * R * 0.06 : 0;
  const sx = shake ? Math.sin(nowMs / 23) * shake : 0;
  const sy = shake ? Math.cos(nowMs / 29) * shake : 0;
  const centre = { x: cp.x + sx, y: cp.y + sy };

  const showArms = breakIt ? k < BREAK_BURST + 0.04 : release < 1;
  if (showArms) {
    const arms = roots.map((root, i) => {
      // Contact points: the near face for a scorch, spread right round
      // the world for a break.
      const spread = breakIt ? (i / (N - 1) - 0.5) * 2.6 : (i / (N - 1) - 0.5) * 1.9;
      const a = toBeast + spread + (rng() - 0.5) * 0.15;
      const hit = { x: centre.x + Math.cos(a) * R * (1 - 0.06 * crush), y: centre.y + Math.sin(a) * R * (1 - 0.06 * crush) };
      const mid = { x: (root.x + hit.x) / 2, y: (root.y + hit.y) / 2 };
      const bow = (i - (N - 1) / 2) * R * 0.55;
      const nx = -(hit.y - root.y), ny = hit.x - root.x, nl = Math.hypot(nx, ny) || 1;
      const sway = { x: mid.x + (nx / nl) * bow, y: mid.y + (ny / nl) * bow };
      const wrap = breakIt ? Math.sign(spread || 1) * wrapK * (1.1 + 0.5 * rng()) : 0;
      return armPath(root, sway, hit, centre, R * (1 - 0.06 * crush), reach * (1 - release), wrap, nowMs / 140 + i);
    });
    // A coiling arm keeps its girth round the world; a reaching one tapers.
    drawArms(rc.ctx, arms, width, crush, light, nowMs, breakIt ? 0.6 : 0.22);
    // Where they hold on, the world glows violet.
    if (light > 0.02 || crush > 0.02) {
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (const a of arms) {
        const tip = a[a.length - 1];
        glowAt(g, tip.x, tip.y, R * (0.35 + 0.3 * light), `rgb(${LEVIATHAN_PALETTE.hot})`, `rgb(${LEVIATHAN_PALETTE.glow})`, 0.7 * Math.max(light, crush));
      }
      g.restore();
    }
  }

  if (breakIt) {
    // CRACKS: light splitting the crust from the core outward.
    if (k > 0.34 && k < BREAK_BURST) {
      g.save();
      g.beginPath(); g.arc(centre.x, centre.y, R, 0, TWO_PI); g.clip();
      g.globalCompositeOperation = 'lighter';
      const cr = mulberry32(f.seed + 7);
      const cracks = 14;
      for (let i = 0; i < cracks; i++) {
        let a = cr() * TWO_PI, x = centre.x + (cr() - 0.5) * R * 0.3, y = centre.y + (cr() - 0.5) * R * 0.3;
        const len = R * (0.5 + 0.7 * cr()) * crush;
        const steps = 7;
        g.beginPath(); g.moveTo(x, y);
        for (let sI = 0; sI < steps; sI++) {
          a += (cr() - 0.5) * 0.9;
          x += Math.cos(a) * len / steps; y += Math.sin(a) * len / steps;
          g.lineTo(x, y);
        }
        g.strokeStyle = `rgba(${LEVIATHAN_PALETTE.glow}, ${(0.28 * crush).toFixed(3)})`;
        g.lineWidth = Math.max(1.5, R * 0.06 * crush);
        g.stroke();
        g.strokeStyle = `rgba(${LEVIATHAN_PALETTE.hot}, ${(0.35 + 0.55 * crush).toFixed(3)})`;
        g.lineWidth = Math.max(0.8, R * 0.016 * (0.6 + crush));
        g.stroke();
      }
      g.restore();
    }
    // THE BURST.
    if (k >= BREAK_BURST - 0.02) {
      const bk = clamp01((k - BREAK_BURST) / (1 - BREAK_BURST));
      g.save();
      g.globalCompositeOperation = 'lighter';
      // White flash, gone fast.
      glowAt(g, cp.x, cp.y, R * (1.4 + 2.2 * bk), '#ffffff', `rgb(${LEVIATHAN_PALETTE.glow})`, Math.max(0, 1 - bk * 3));
      // Violet shockwave.
      const ring = R * (1.1 + 4.5 * smooth(bk));
      g.strokeStyle = `rgba(${LEVIATHAN_PALETTE.glow}, ${(0.6 * (1 - bk)).toFixed(3)})`;
      g.lineWidth = Math.max(1.5, R * 0.12 * (1 - bk));
      g.beginPath(); g.arc(cp.x, cp.y, ring, 0, TWO_PI); g.stroke();
      g.restore();
      // Shards of the world, tumbling out, in its own colour.
      const sr = mulberry32(f.seed + 13);
      const shards = 28;
      g.save();
      for (let i = 0; i < shards; i++) {
        const a = sr() * TWO_PI, v = 0.8 + 2.6 * sr(), spin = (sr() - 0.5) * 8;
        const d = R * (0.3 + v * smooth(bk) * 1.6);
        const x = cp.x + Math.cos(a) * d, y = cp.y + Math.sin(a) * d;
        const s = R * (0.08 + 0.18 * sr()) * (1 - 0.5 * bk);
        g.save();
        g.translate(x, y); g.rotate(spin * bk + a);
        g.globalAlpha = 1 - smooth((bk - 0.55) / 0.45);
        g.fillStyle = body.color || '#8a7a6a';
        g.beginPath(); g.moveTo(s, 0); g.lineTo(-s * 0.6, s * 0.7); g.lineTo(-s * 0.4, -s * 0.8); g.closePath(); g.fill();
        g.fillStyle = `rgba(${LEVIATHAN_PALETTE.hot}, ${(0.5 * (1 - bk)).toFixed(3)})`;
        g.fillRect(-s * 0.15, -s * 0.15, s * 0.3, s * 0.3);
        g.restore();
      }
      g.restore();
    }
  } else if (k > 0.2 && k < 0.7) {
    // A violet pressure wave where the light goes in, ahead of the fire
    // the sterilisation layer lays on the surface.
    const wk = clamp01((k - 0.2) / 0.5);
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = `rgba(${LEVIATHAN_PALETTE.glow}, ${(0.45 * (1 - wk)).toFixed(3)})`;
    g.lineWidth = Math.max(1.5, R * 0.08);
    g.beginPath(); g.arc(cp.x, cp.y, R * (1.05 + 1.8 * wk), 0, TWO_PI); g.stroke();
    g.restore();
  }
}

/** The palette dying from violet light to dead grey. */
function dimmed(k: number): SquidPalette {
  const mix = (a: string, b: string) => {
    const pa = a.split(',').map(Number), pb = b.split(',').map(Number);
    return pa.map((v, i) => Math.round(lerp(v, pb[i], k))).join(', ');
  };
  const P = LEVIATHAN_PALETTE;
  return {
    ...P,
    glow: mix(P.glow, '70, 62, 82'),
    hot: mix(P.hot, '110, 104, 118'),
    eye: mix(P.eye ?? P.hot, '48, 20, 28'),
    fin: `rgba(84, 52, 140, ${(0.8 * (1 - 0.7 * k)).toFixed(3)})`,
  };
}

function drawDeath(rc: RenderContext, f: Fx, k: number, nowMs: number) {
  const g = rc.ctx;
  let x: number, y: number, heading: number, size: number;
  if (f.beast) {
    const c = worldToCanvas(f.beast.x, f.beast.y, rc);
    x = c.x; y = c.y; heading = f.beast.heading; size = f.beast.size;
  } else {
    // Loaded after it died: where it fell, beside that world.
    const body = bodyOf(rc, f.bodyId);
    if (!body) return;
    const wp = bodyPosition(body, rc.t, rc.bodies);
    const cp = worldToCanvas(wp.x, wp.y, rc);
    const R = Math.max(6, drawnRadiusOf(rc.presentation, body, rc.camera.scale));
    const a = (f.seed % 628) / 100;
    x = cp.x + Math.cos(a) * R * 2.4; y = cp.y + Math.sin(a) * R * 2.4;
    heading = a + Math.PI / 2; size = Math.max(60, R * 2.4);
  }
  const rng = mulberry32(f.seed + Math.floor(nowMs / 70));
  // Drift: it stops swimming and floats on.
  const drift = smooth(k) * size * 0.25;
  x += Math.cos(heading) * drift; y += Math.sin(heading) * drift;

  const thrash = 1 - smooth((k - 0.05) / 0.3);
  const dark = smooth((k - 0.25) / 0.4);
  const gone = smooth((k - 0.72) / 0.2);
  const h = heading + thrash * 0.45 * Math.sin(nowMs / 55) + dark * 0.35 * smooth(k);

  // Ichor: violet droplets bleeding out and drifting off.
  g.save();
  g.globalCompositeOperation = 'lighter';
  const ir = mulberry32(f.seed + 3);
  for (let i = 0; i < 44; i++) {
    const born = ir() * 0.65, life = 0.3 + ir() * 0.4;
    const t = (k - born) / life;
    if (t <= 0 || t >= 1) continue;
    const a = ir() * TWO_PI, v = size * (0.3 + 0.8 * ir());
    const px = x + Math.cos(a) * v * t, py = y + Math.sin(a) * v * t;
    glowAt(g, px, py, size * (0.05 + 0.06 * ir()) * (1 - 0.6 * t), `rgb(${LEVIATHAN_PALETTE.hot})`, `rgb(${LEVIATHAN_PALETTE.glow})`, 0.9 * (1 - t));
  }
  g.restore();

  // The animal, while there is still an animal.
  if (gone < 1) {
    g.save();
    g.globalAlpha = 1 - gone;
    drawSunSquid(g, x, y, {
      u: size / 6, ringR: 0, heading: h, morph: 0,
      thrust: thrash * (rng() < 0.5 ? 0.9 : 0.1), now: nowMs, palette: dimmed(dark),
    });
    g.restore();
  }

  g.save();
  g.globalCompositeOperation = 'lighter';
  // Hits landing as it convulses: red-white flashes across the body.
  if (thrash > 0.05 && rng() < 0.45) {
    glowAt(g, x + (rng() - 0.5) * size * 0.5, y + (rng() - 0.5) * size * 0.3, size * (0.15 + 0.2 * rng()), '#ffffff', '#ff5e5e', 0.7 * thrash);
  }
  // Its eyes flare once, then go out.
  const eyeFlare = Math.max(0, 1 - Math.abs(k - 0.12) / 0.12);
  if (eyeFlare > 0.01) {
    for (const s of [-1, 1]) {
      const u = size / 6;
      const ex = -0.24 * u, ey = s * 0.32 * u;
      glowAt(g, x + ex * Math.cos(h) - ey * Math.sin(h), y + ex * Math.sin(h) + ey * Math.cos(h), u * 1.2, '#ffffff', '#ff4664', eyeFlare);
    }
  }
  // The last pulse as it comes apart.
  if (k > 0.7) {
    const pk = clamp01((k - 0.7) / 0.3);
    g.strokeStyle = `rgba(${LEVIATHAN_PALETTE.glow}, ${(0.55 * (1 - pk)).toFixed(3)})`;
    g.lineWidth = Math.max(1.5, size * 0.03 * (1 - pk));
    g.beginPath(); g.arc(x, y, size * (0.4 + 1.4 * smooth(pk)), 0, TWO_PI); g.stroke();
    glowAt(g, x, y, size * (0.5 + 0.4 * pk), `rgb(${LEVIATHAN_PALETTE.hot})`, `rgb(${LEVIATHAN_PALETTE.glow})`, 0.5 * (1 - pk));
  }
  g.restore();

  // Pieces of hide drifting from where it was.
  if (k > 0.7) {
    const pk = clamp01((k - 0.7) / 0.3);
    const fr = mulberry32(f.seed + 11);
    g.save();
    for (let i = 0; i < 16; i++) {
      const a = fr() * TWO_PI, d = size * (0.1 + 0.9 * fr()) * smooth(pk);
      const s = size * (0.03 + 0.05 * fr());
      g.globalAlpha = 1 - pk;
      g.fillStyle = i % 3 === 0 ? LEVIATHAN_PALETTE.lit : LEVIATHAN_PALETTE.mid;
      g.save(); g.translate(x + Math.cos(a) * d, y + Math.sin(a) * d); g.rotate(a + pk * 3);
      g.fillRect(-s, -s * 0.5, s * 2, s);
      g.restore();
    }
    g.restore();
  }
}

/** Every live set piece, this frame. MapCanvas calls it with the other FX. */
export function drawKaijuFx(rc: RenderContext, nowMs: number): void {
  for (let i = live.length - 1; i >= 0; i--) {
    if (nowMs - live[i].startMs >= LIFE[live[i].kind]) live.splice(i, 1);
  }
  for (const f of live) {
    const k = (nowMs - f.startMs) / LIFE[f.kind];
    if (k < 0) continue;
    if (f.kind === 'death') drawDeath(rc, f, k, nowMs);
    else drawStrike(rc, f, k, nowMs);
  }
}

/** Test hook: forget everything played. */
export function resetKaijuFx(): void {
  live.length = 0; seen.clear(); deathPlayed = false; lastDrawn = null; lastDrawnShip = null;
}

/** Test hook: what was last noted. */
export function lastKaijuDrawn(): { shipId: string | null; at: Drawn | null } {
  return { shipId: lastDrawnShip, at: lastDrawn };
}
