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
import { RenderContext, worldToCanvas, sterilisedBlend } from './mapRenderer';
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

/** The world the beast was drawn over when mapRenderer drew it: parked
 *  there, or held there by a strike (kaijuFlightPose). `bx, by` is that
 *  world's position (world units), `R` its drawn radius (px). */
export interface KaijuAnchor { bodyId: string; parked: boolean; bx: number; by: number; R: number; scale: number }
/** A pose relative to a world: offset in its DRAWN radii, size as a
 *  multiple of its drawn radius. Rebuilt every frame from where the world
 *  is now and how big it is drawn, so whatever is anchored this way rides
 *  the world's orbit and the zoom (a world-coordinate point stayed behind
 *  as Europa moved on, 40+ px a frame at a close-up). */
interface Rel { bodyId: string; rx: number; ry: number; heading: number; sizeR: number }
interface Drawn {
  x: number; y: number; heading: number; size: number; ms: number;
  /** Drawn PARKED over this world (drawShip), this frame. */
  parkedAt?: string | null;
  rel?: Rel | null;
}
/** A pose in canvas px. */
export interface KaijuPose { x: number; y: number; heading: number; size: number }

let lastDrawn: Drawn | null = null;
let lastDrawnShip: string | null = null;
/** The last time it was drawn parked over a world, relative to it. */
let lastParked: (Rel & { ms: number }) | null = null;
/** When a strike hold last drew the hull (kaijuFlightPose), wall ms. */
let heldDrawnMs = -Infinity;

function relOf(x: number, y: number, heading: number, size: number, a: KaijuAnchor): Rel {
  const Rw = Math.max(1e-9, a.R / Math.max(1e-9, a.scale));
  return { bodyId: a.bodyId, rx: (x - a.bx) / Rw, ry: (y - a.by) / Rw, heading, sizeR: size / Math.max(1e-9, a.R) };
}

/** mapRenderer calls this every frame it draws the beast (world coords),
 *  with the world it is drawn over, if any. */
export function noteKaijuDrawn(
  shipId: string, x: number, y: number, heading: number, size: number, anchor: KaijuAnchor | null = null,
): void {
  lastDrawnShip = shipId;
  const ms = performance.now();
  const rel = anchor ? relOf(x, y, heading, size, anchor) : null;
  lastDrawn = { x, y, heading, size, ms, parkedAt: anchor?.parked ? anchor.bodyId : null, rel };
  if (anchor?.parked && rel) lastParked = { ...rel, ms };
}

// ---- the queue ----------------------------------------------------------

type Kind = 'scorch' | 'break' | 'death';
interface Fx { id: string; kind: Kind; bodyId: string; startMs: number; seed: number;
  /** For the death: the animal as last drawn, frozen at the start. */
  beast?: Drawn | null }
const live: Fx[] = [];
const seen = new Set<string>();
let deathPlayed = false;
/** The death, kept after it has played: the carcass settles from it. */
let lastDeath: Fx | null = null;

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
  const f: Fx = { id: entryId, kind: 'death', bodyId, startMs: performance.now(), seed: hashStr(entryId), beast: fresh };
  live.push(f);
  lastDeath = f;
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

/** A world's place and drawn radius this frame. */
function frameOf(rc: RenderContext, bodyId: string): { wp: P; cp: P; R: number } | null {
  const body = bodyOf(rc, bodyId);
  if (!body) return null;
  const wp = bodyPosition(body, rc.t, rc.bodies);
  return { wp, cp: worldToCanvas(wp.x, wp.y, rc), R: Math.max(1e-6, drawnRadiusOf(rc.presentation, body, rc.camera.scale)) };
}

/** A relative pose, put back on its world as it is drawn now. */
function relPose(rc: RenderContext, rel: Rel): KaijuPose | null {
  const fr = frameOf(rc, rel.bodyId);
  if (!fr) return null;
  const Rw = fr.R / Math.max(1e-9, rc.camera.scale);
  const c = worldToCanvas(fr.wp.x + rel.rx * Rw, fr.wp.y + rel.ry * Rw, rc);
  return { x: c.x, y: c.y, heading: rel.heading, size: rel.sizeR * fr.R };
}

/** How wide the beast is drawn over a world (mapRenderer kaijuParkedSize). */
const WORLD_SPAN = 4.4;

/**
 * Where a strike's beast is: where it was last drawn PARKED over this
 * world, kept on the world as it moves. Never seen there by this client:
 * out on its parking ring on the side away from the Sun, the size it is
 * drawn over a world.
 */
function heldPose(rc: RenderContext, bodyId: string): KaijuPose | null {
  if (lastParked && lastParked.bodyId === bodyId) {
    const p = relPose(rc, lastParked);
    if (p) return p;
  }
  const fr = frameOf(rc, bodyId);
  if (!fr) return null;
  const awayA = Math.atan2(fr.wp.y, fr.wp.x);
  return {
    x: fr.cp.x + Math.cos(awayA) * fr.R * 2.4, y: fr.cp.y + Math.sin(awayA) * fr.R * 2.4,
    heading: awayA + Math.PI, size: fr.R * WORLD_SPAN,
  };
}

/** The strike's beast this frame, and whether it is the live parked hull. */
function strikeBeast(rc: RenderContext, f: Fx, nowMs: number): { pose: KaijuPose; live: boolean } | null {
  if (lastDrawn && nowMs - lastDrawn.ms < 4000 && lastDrawn.parkedAt === f.bodyId) {
    const c = worldToCanvas(lastDrawn.x, lastDrawn.y, rc);
    return { pose: { x: c.x, y: c.y, heading: lastDrawn.heading, size: lastDrawn.size }, live: true };
  }
  const p = heldPose(rc, f.bodyId);
  return p ? { pose: p, live: false } : null;
}

/** Where in each strike the arms have let go (fraction of its life). */
const ARMS_END: Record<'scorch' | 'break', number> = { scorch: 0.85, break: BREAK_BURST + 0.04 };
/** How long the beast takes to ease from the world into its flight. */
export const KAIJU_RELEASE_MS = 1200;

function holdWindow(f: Fx): { end: number; release: number } | null {
  if (f.kind === 'death') return null;
  const life = LIFE[f.kind];
  const end = f.startMs + ARMS_END[f.kind] * life;
  // Within the set piece's own life, which is when it leaves the queue.
  return { end, release: Math.max(1, Math.min(KAIJU_RELEASE_MS, f.startMs + life - end)) };
}

/** Is a strike holding the beast at its world (or easing it out) now? */
export function kaijuStrikeHolds(nowMs: number): boolean {
  return live.some(f => {
    const w = holdWindow(f);
    return !!w && nowMs >= f.startMs && nowMs < w.end + w.release;
  });
}

/**
 * THE BEAST STILL ON ITS PREY, for the guns (combatFx drawEngagementFire).
 * It leaves for its next meal on the tick it breaks a world, so the
 * server's fight at that world ends with that tick: the outliner says
 * ORBITING, and the guards' fire stopped while the beast was still drawn
 * wrapped round the world, crushing it (judges, the Leviathan clip,
 * 2026-10-23, 10.0-11.6 s: "the fleet giving up"). The strike it is
 * drawn finishing is the tick the guards fought it, so they keep firing at
 * it where it is drawn until its arms let go; from then on it is visibly
 * leaving, and they stop. Null unless a strike holds it over a world and
 * it was drawn there this frame (`maxAgeMs`). `x, y` world units (where it
 * was drawn), `size` px.
 */
export function kaijuHeldAt(
  nowMs: number, maxAgeMs = 250,
): { shipId: string | null; bodyId: string; x: number; y: number; size: number } | null {
  if (!lastDrawn || Math.abs(nowMs - lastDrawn.ms) > maxAgeMs) return null;
  for (const f of live) {
    const w = holdWindow(f);
    if (!w || nowMs < f.startMs || nowMs >= w.end) continue;
    if (lastDrawn.rel?.bodyId !== f.bodyId) continue;
    return { shipId: lastDrawnShip, bodyId: f.bodyId, x: lastDrawn.x, y: lastDrawn.y, size: lastDrawn.size };
  }
  return null;
}

const smoother = (v: number) => { const x = clamp01(v); return x * x * x * (x * (x * 6 - 15) + 10); };
const lerpAngle = (a: number, b: number, t: number) => {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return a + d * t;
};

/**
 * THE BEAST IN FLIGHT, while one of its strikes still plays. It leaves
 * for its next meal on the tick it breaks a world, so its flight began
 * with its arms still round that world: it halved, slid off the bottom of
 * the frame, and the arms crushed the world from off screen (Studio clip
 * "The Leviathan", 2026-10-23). Now it stays where it held the world
 * until its arms let go, then eases into its flight over
 * KAIJU_RELEASE_MS. `flight` is where its flight would draw it. Null when
 * no strike holds it. `bodyId` is set while it is still over the world.
 */
export function kaijuFlightPose(
  rc: RenderContext, flight: KaijuPose, nowMs: number,
): (KaijuPose & { bodyId: string | null }) | null {
  for (const f of live) {
    const w = holdWindow(f);
    if (!w || nowMs < f.startMs || nowMs >= w.end + w.release) continue;
    const held = heldPose(rc, f.bodyId);
    if (!held) continue;
    heldDrawnMs = nowMs;
    if (nowMs < w.end) return { ...held, bodyId: f.bodyId };
    const e = smoother((nowMs - w.end) / w.release);
    return {
      x: lerp(held.x, flight.x, e), y: lerp(held.y, flight.y, e),
      heading: lerpAngle(held.heading, flight.heading, e), size: lerp(held.size, flight.size, e),
      bodyId: null,
    };
  }
  return null;
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
function armRoots(beast: KaijuPose, count: number): P[] {
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
  // The beast: the hull on screen while it is parked over this world, and
  // otherwise where it held it (strikeBeast). Never a hull flying away.
  const at = strikeBeast(rc, f, nowMs);
  if (!at) return;
  const beast = at.pose;
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
  // Arms need an animal. When no hull was drawn there this frame (fogged
  // out, or not in this client's state at all), it is drawn here.
  if (showArms && !at.live && heldDrawnMs < nowMs) {
    drawSunSquid(g, beast.x, beast.y, {
      u: beast.size / 6, ringR: 0, heading: beast.heading, morph: 0, thrust: 0.1, now: nowMs,
      palette: LEVIATHAN_PALETTE,
    });
  }
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
      // The shards themselves are drawn UNDER the hulls (drawKaijuShards).
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

// ---- the shards of a broken world ---------------------------------------

/** The rubble the debris field draws (mapRenderer drawDebrisField): what
 *  the shards fly out to become. */
const RUBBLE = { r: 0x6f, g: 0x68, b: 0x60 };

function rgbOf(hex: string | undefined): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * WHAT A BROKEN WORLD'S SHARDS ARE MADE OF: its crust as drawn, not its
 * map dot. They were filled with `body.color`, Io's flat label yellow, so
 * the break burst into 28 saturated yellow triangles over grey rubble and
 * over the fleet ("UI confetti", judges, the Leviathan clip, 2026-10-23).
 * Rock: the debris field's own grey, keeping only a trace of the world's
 * hue, and none of it once the world is ash (`ash` 0..1, sterilisedBlend).
 * `lit` faces the Sun, `dark` turns away; a tumbling shard swings between.
 */
export function kaijuShardTones(color: string | undefined, ash: number): { lit: string; dark: string } {
  const c = rgbOf(color) ?? RUBBLE;
  const keep = 0.22 * (1 - Math.max(0, Math.min(1, ash)));
  const mix = (a: number, b: number) => a + (b - a) * keep;
  const base = { r: mix(RUBBLE.r, c.r), g: mix(RUBBLE.g, c.g), b: mix(RUBBLE.b, c.b) };
  const tone = (k: number) => `rgb(${[base.r, base.g, base.b].map(v => Math.round(Math.min(255, v * k))).join(', ')})`;
  return { lit: tone(1.35), dark: tone(0.48) };
}

/**
 * THE BREAK'S SHARDS, drawn with the wrecks UNDER the hulls (MapCanvas):
 * a burst of rock tumbling out of the world and settling into the debris
 * field, never painted over the fleet guarding it. Rock-coloured
 * (kaijuShardTones) and lit from the Sun as they tumble.
 */
export function drawKaijuShards(rc: RenderContext, nowMs: number): void {
  for (const f of live) {
    if (f.kind !== 'break') continue;
    const k = (nowMs - f.startMs) / KAIJU_BREAK_MS;
    if (k < BREAK_BURST || k >= 1) continue;
    const body = bodyOf(rc, f.bodyId);
    if (!body) continue;
    const g = rc.ctx;
    const wp = bodyPosition(body, rc.t, rc.bodies);
    const cp = worldToCanvas(wp.x, wp.y, rc);
    const R = Math.max(6, drawnRadiusOf(rc.presentation, body, rc.camera.scale));
    const bk = clamp01((k - BREAK_BURST) / (1 - BREAK_BURST));
    const tones = kaijuShardTones(body.color, sterilisedBlend(body, rc));
    const sun = worldToCanvas(0, 0, rc);
    const sunA = Math.atan2(sun.y - cp.y, sun.x - cp.x);
    const sr = mulberry32(f.seed + 13);
    const shards = 28;
    g.save();
    for (let i = 0; i < shards; i++) {
      const a = sr() * TWO_PI, v = 0.8 + 2.6 * sr(), spin = (sr() - 0.5) * 8;
      const d = R * (0.3 + v * smooth(bk) * 1.6);
      const x = cp.x + Math.cos(a) * d, y = cp.y + Math.sin(a) * d;
      const s = R * (0.08 + 0.18 * sr()) * (1 - 0.5 * bk);
      const rot = spin * bk + a;
      g.save();
      g.translate(x, y); g.rotate(rot);
      g.globalAlpha = 1 - smooth((bk - 0.55) / 0.45);
      // The whole shard in shadow, then its sunward facet lit: which facet
      // that is turns as it tumbles, so the burst reads as solid rock.
      g.fillStyle = tones.dark;
      g.beginPath(); g.moveTo(s, 0); g.lineTo(-s * 0.6, s * 0.7); g.lineTo(-s * 0.4, -s * 0.8); g.closePath(); g.fill();
      const facing = Math.cos(sunA - rot);
      g.fillStyle = tones.lit;
      g.beginPath();
      if (facing >= 0) { g.moveTo(s, 0); g.lineTo(-s * 0.4, -s * 0.8); g.lineTo(-s * 0.1, 0); }
      else { g.moveTo(s, 0); g.lineTo(-s * 0.6, s * 0.7); g.lineTo(-s * 0.1, 0); }
      g.closePath(); g.fill();
      // Still hot inside for the first moments of the burst.
      if (bk < 0.5) {
        g.fillStyle = `rgba(${LEVIATHAN_PALETTE.hot}, ${(0.35 * (1 - bk * 2)).toFixed(3)})`;
        g.fillRect(-s * 0.12, -s * 0.12, s * 0.24, s * 0.24);
      }
      g.restore();
    }
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

/**
 * Where the dying beast is, k through its death: where it was last DRAWN,
 * at the size it was drawn (riding the world it was over, if any), and
 * then floating on a little. The thrash is left out (drawDeath adds it).
 */
function deathPose(rc: RenderContext, f: Fx, k: number): KaijuPose | null {
  let base: KaijuPose | null = null;
  if (f.beast?.rel) base = relPose(rc, f.beast.rel);
  if (!base && f.beast) {
    const c = worldToCanvas(f.beast.x, f.beast.y, rc);
    base = { x: c.x, y: c.y, heading: f.beast.heading, size: f.beast.size };
  }
  if (!base) {
    // Loaded after it died: where it fell, beside that world.
    const fr = f.bodyId ? frameOf(rc, f.bodyId) : null;
    if (!fr) return null;
    const R = Math.max(6, fr.R);
    const a = (f.seed % 628) / 100;
    base = {
      x: fr.cp.x + Math.cos(a) * R * 2.4, y: fr.cp.y + Math.sin(a) * R * 2.4,
      heading: a + Math.PI / 2, size: Math.max(60, R * 2.4),
    };
  }
  // Drift: it stops swimming and floats on; it rolls a little as it goes.
  const drift = smooth(k) * base.size * 0.25;
  const dark = smooth((k - 0.25) / 0.4);
  return {
    x: base.x + Math.cos(base.heading) * drift, y: base.y + Math.sin(base.heading) * drift,
    heading: base.heading + dark * 0.35 * smooth(k), size: base.size,
  };
}

/** When in the death the carcass shows through the fading animal. */
const CARCASS_FROM = 0.72;
/** How long the carcass then takes to settle onto its own orbit. */
export const KAIJU_CARCASS_SETTLE_MS = 2400;

/**
 * WHERE TO DRAW THE CARCASS (mapRenderer, the leviathan_carcass body).
 * The salvage body is a separate thing on its own orbit, at its own size,
 * and it arrives in the same /state the beast leaves: it popped up beside
 * the world while the beast was still dying somewhere else. It now shows
 * through as the animal's lights go out, where the animal is and at its
 * size, then settles onto its own orbit. `own` is where it would be drawn.
 */
export function kaijuCarcassPose(
  rc: RenderContext, own: KaijuPose, nowMs: number,
): KaijuPose & { alpha: number } {
  const f = lastDeath;
  if (!f) return { ...own, alpha: 1 };
  const k = (nowMs - f.startMs) / KAIJU_DEATH_MS;
  if (k < 0) return { ...own, alpha: 1 };
  const at = deathPose(rc, f, Math.min(1, k));
  if (!at) return { ...own, alpha: 1 };
  if (k < 1) return { ...at, alpha: smooth((k - CARCASS_FROM) / 0.2) };
  const s = (nowMs - f.startMs - KAIJU_DEATH_MS) / KAIJU_CARCASS_SETTLE_MS;
  if (s >= 1) return { ...own, alpha: 1 };
  const e = smoother(s);
  return {
    x: lerp(at.x, own.x, e), y: lerp(at.y, own.y, e), size: lerp(at.size, own.size, e),
    heading: lerpAngle(at.heading, own.heading, e), alpha: 1,
  };
}

function drawDeath(rc: RenderContext, f: Fx, k: number, nowMs: number) {
  const g = rc.ctx;
  const pose = deathPose(rc, f, k);
  if (!pose) return;
  const { x, y, size } = pose;
  const rng = mulberry32(f.seed + Math.floor(nowMs / 70));

  const thrash = 1 - smooth((k - 0.05) / 0.3);
  const dark = smooth((k - 0.25) / 0.4);
  const gone = smooth((k - CARCASS_FROM) / 0.2);
  const h = pose.heading + thrash * 0.45 * Math.sin(nowMs / 55);

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
  lastParked = null; lastDeath = null; heldDrawnMs = -Infinity;
}

/** Test hook: what was last noted. */
export function lastKaijuDrawn(): { shipId: string | null; at: Drawn | null } {
  return { shipId: lastDrawnShip, at: lastDrawn };
}

// ---- the carcass ------------------------------------------------------------

/** What is left of it: the same body, every light out. A ghost of violet
 *  still in the hide, so it reads as the Leviathan and not a rock. */
export const CARCASS_PALETTE: SquidPalette = {
  glow: '96, 82, 112', hot: '128, 118, 138', eye: '58, 34, 42',
  dark: '#0c0a10', mid: '#29222f', lit: '#463c50',
  fin: 'rgba(72, 60, 86, 0.55)',
};

/**
 * THE CARCASS (Lorne, 2026-10-08: "make the carcass look like a squid
 * carcass"). The salvage body it leaves (worker/kaiju.js die(), template
 * leviathan_carcass) draws as the animal itself: dead grey, lights out,
 * arms hanging, tumbling slowly in orbit of the world it fell at. As the
 * mining rigs strip it (`left`, 1 -> 0) it shrinks and darkens, and a
 * few loose chunks of hide drift around it.
 */
/** The carcass's own slow tumble. */
export function carcassHeading(seed: number, nowMs: number): number {
  return ((seed % 628) / 100) + nowMs / 52000;
}

export function drawKaijuCarcass(
  g: G, x: number, y: number, size: number, nowMs: number, left: number, seed: number,
  heading: number = carcassHeading(seed, nowMs),
): void {
  const f = clamp01(left);
  const s = size * (0.62 + 0.38 * f);
  g.save();
  g.globalAlpha *= 0.55 + 0.45 * f;
  drawSunSquid(g, x, y, {
    u: s / 6, ringR: 0, heading, morph: 0, thrust: 0, now: nowMs + seed, palette: CARCASS_PALETTE, motion: 0.05,
  });
  g.restore();
  // Loose pieces of it, and a little of what the rigs are after.
  const r = mulberry32(seed + 5);
  g.save();
  for (let i = 0; i < 7; i++) {
    const a = r() * TWO_PI + nowMs / (30000 + 9000 * r());
    const d = s * (0.45 + 0.35 * r());
    const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d * 0.7;
    const w = s * (0.02 + 0.03 * r());
    g.fillStyle = i % 3 === 0 ? CARCASS_PALETTE.lit : CARCASS_PALETTE.mid;
    g.save(); g.translate(px, py); g.rotate(a * 2); g.fillRect(-w, -w * 0.5, w * 2, w); g.restore();
    if (i % 2 === 0) {
      g.fillStyle = `rgba(200, 190, 210, ${(0.25 + 0.35 * f).toFixed(3)})`;
      g.fillRect(px + w, py, 1.2, 1.2);
    }
  }
  g.restore();
}
