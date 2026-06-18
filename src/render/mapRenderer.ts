import { canHostCity } from '../game/settlements';
// ============================================================
// Map Canvas Rendering - Draw the orbital system
// ============================================================

import { Body, Ship, OrbitElements, TrajectoryArc, Settlement, Faction, TorchTransferPlan } from '../types';
import { bodyPosition, localPositionAt, semiMajor, eccentricity, velocityVectorsAt } from '../physics/orbitalMechanics';
import { sampleTorchTrajectory, torchPositionFromSamples } from '../physics/torchTransfer';
import { STRAIGHT_LINE_TRAJECTORIES } from '../game/featureFlags';
import { COLORS, withOpacity, lighten, darken } from './colors';
import { getShipIconImage } from './shipIconCache';
import { ShipIconClass } from '../components/ShipIcons';

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  camera: { x: number; y: number; scale: number; focusedBodyId?: string };
  t: number;
  bodies: Body[];
  /** Factions in this game, used by per-asset color lookups (drawShip,
   *  drawTransitShip, drawCity/Station). Optional — older render paths
   *  pass factions in explicitly; new code falls back to neutral when
   *  this isn't provided. */
  factions?: Faction[];
  simSpeed?: number;
  /** Wall-clock ms (performance.now()) captured at the moment the
   *  renderer first observed each entity's current lastDamagedTick.
   *  Keyed by ship/settlement id. Populated by MapCanvas pre-render
   *  pass; consumed by drawDamageFlash. */
  damageFlashStart?: Map<string, number>;
  /** Wall-clock ms for the current frame — passed to drawDamageFlash
   *  so all flashes age consistently within one frame. */
  nowMs?: number;
}

/**
 * Convert world coordinates to canvas coordinates
 */
export function worldToCanvas(
  worldX: number,
  worldY: number,
  ctx: RenderContext
): { x: number; y: number } {
  const canvasX = ctx.canvas.width / 2 + (worldX - ctx.camera.x) * ctx.camera.scale;
  const canvasY = ctx.canvas.height / 2 + (worldY - ctx.camera.y) * ctx.camera.scale;
  return { x: canvasX, y: canvasY };
}

/**
 * Convert canvas coordinates to world coordinates
 */
export function canvasToWorld(
  canvasX: number,
  canvasY: number,
  ctx: RenderContext
): { x: number; y: number } {
  const worldX = ctx.camera.x + (canvasX - ctx.canvas.width / 2) / ctx.camera.scale;
  const worldY = ctx.camera.y + (canvasY - ctx.canvas.height / 2) / ctx.camera.scale;
  return { x: worldX, y: worldY };
}

/**
 * Clear canvas and fill with background
 */
export function clearCanvas(ctx: RenderContext) {
  ctx.ctx.fillStyle = COLORS.bg;
  ctx.ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

// ============================================================
// Damage flash — shared overlay for ships + settlements.
// ============================================================

/** Real-world milliseconds the red damage halo remains visible after a
 *  hit. Tied to game ticks so the duration is "10 ticks" regardless
 *  of sim speed — at fast-forward you still see a flash, just faster.
 *  Per-frame interpolation comes from `t` (current tick, fractional). */
export const DAMAGE_FLASH_DURATION_TICKS = 10;
export const DESTRUCTION_FLASH_DURATION_TICKS = 10;

/** Where in its lifecycle the flash is. Damage = small red ring,
 *  Destruction = bigger orange-white explosion ring. Both share the
 *  same fade curve. */
export type FlashKind = 'damage' | 'destruction';

/**
 * Render a brief glow around a damaged or destroyed ship/settlement
 * marker. Two visual variants:
 *   damage      → small red ring, modest expansion as it fades
 *   destruction → larger orange/white explosion ring, bigger expansion
 *
 * `startTick` is the game tick when the event happened (tracked
 * outside the renderer in MapCanvas's flash refs). `nowTick` is the
 * current fractional tick from gameState.currentTick. Tick-based so
 * the flash duration is consistent across sim speeds (and a single
 * +10-tick skip resolves a flash that started mid-skip).
 *
 * Call BEFORE drawing the entity's icon so the icon sits on top.
 */
export function drawDamageFlash(
  canvasPos: { x: number; y: number },
  baseRadius: number,
  startTick: number | undefined,
  nowTick: number,
  ctx: RenderContext,
  kind: FlashKind = 'damage',
  durationTicks?: number,
) {
  if (startTick === undefined) return;
  const dur = durationTicks ?? (kind === 'destruction'
    ? DESTRUCTION_FLASH_DURATION_TICKS
    : DAMAGE_FLASH_DURATION_TICKS);
  const age = nowTick - startTick;
  if (age < 0 || age >= dur) return;

  // freshness: 1.0 at impact, 0.0 at end of fade. Curved so the
  // first half is bright and the second half lingers as a soft halo.
  const linear = 1 - age / dur;
  const freshness = Math.pow(linear, 0.6);

  if (kind === 'destruction') {
    // Bigger expanding shockwave + bright white-orange core. Reads
    // as "something exploded here" even at the dim out-of-coverage
    // wash applied later by the fog-of-war overlay.
    const haloR = baseRadius * (4.0 + (1 - linear) * 4.0);
    const grad = ctx.ctx.createRadialGradient(
      canvasPos.x, canvasPos.y, baseRadius * 0.3,
      canvasPos.x, canvasPos.y, haloR,
    );
    grad.addColorStop(0,    `rgba(255, 240, 200, ${0.85 * freshness})`);
    grad.addColorStop(0.25, `rgba(255, 165, 60,  ${0.65 * freshness})`);
    grad.addColorStop(0.6,  `rgba(255, 80, 40,   ${0.30 * freshness})`);
    grad.addColorStop(1,     'rgba(120, 30, 10, 0)');
    ctx.ctx.fillStyle = grad;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, haloR, 0, Math.PI * 2);
    ctx.ctx.fill();
    // Outer ring shockwave — the silhouette of the explosion as it
    // expands past the core glow. Thin, no fill, just an outline.
    ctx.ctx.strokeStyle = `rgba(255, 200, 120, ${0.6 * freshness})`;
    ctx.ctx.lineWidth = 1.5;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, haloR * 0.9, 0, Math.PI * 2);
    ctx.ctx.stroke();
    return;
  }

  // Damage: small red halo with subtle expansion. Punchy at impact,
  // lingers softly so a sequence of hits reads as continuous fire.
  const haloR = baseRadius * (2.5 + (1 - linear) * 1.5);
  const grad = ctx.ctx.createRadialGradient(
    canvasPos.x, canvasPos.y, baseRadius * 0.6,
    canvasPos.x, canvasPos.y, haloR,
  );
  grad.addColorStop(0, `rgba(255, 90, 90, ${0.55 * freshness})`);
  grad.addColorStop(0.6, `rgba(255, 60, 60, ${0.25 * freshness})`);
  grad.addColorStop(1, 'rgba(255, 60, 60, 0)');
  ctx.ctx.fillStyle = grad;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, haloR, 0, Math.PI * 2);
  ctx.ctx.fill();
}

/** Back-compat alias for callers that still pass wall-clock ms. The
 *  realtime damage flash was wall-clock; the tick-based one is the
 *  new shape. Kept exported so future refactors can find it. */
export const DAMAGE_FLASH_DURATION_MS = 500;

// ============================================================
// Starfield — procedural backdrop, cached to offscreen canvas
// ============================================================

export interface StarfieldCache {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/**
 * Generate a starfield onto an offscreen canvas. Includes:
 *  - Distant dim stars
 *  - Mid-brightness stars
 *  - Rare bright stars with subtle halos
 *  - A few faint nebula blobs for color
 */
export function generateStarfield(width: number, height: number): StarfieldCache {
  const off = document.createElement('canvas');
  off.width = width;
  off.height = height;
  const ctx = off.getContext('2d');
  if (!ctx) return { canvas: off, width, height };

  // Nebula tinting (3 large faint blobs)
  const nebulaHues = [
    'rgba(80, 60, 130, 0.05)',  // purple
    'rgba(60, 90, 150, 0.05)',  // blue
    'rgba(140, 80, 90, 0.04)',  // dust red
  ];
  for (let i = 0; i < nebulaHues.length; i++) {
    const cx = Math.random() * width;
    const cy = Math.random() * height;
    const r = 180 + Math.random() * 280;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, nebulaHues[i]);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  // Stars — density tuned to feel "deep space" without obscuring orbits
  const starCount = Math.floor((width * height) / 700);
  for (let i = 0; i < starCount; i++) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    const r = Math.random();

    if (r > 0.985) {
      // Rare bright star with halo
      const haloR = 4.5;
      const halo = ctx.createRadialGradient(x, y, 0, x, y, haloR);
      halo.addColorStop(0, 'rgba(255, 240, 200, 0.45)');
      halo.addColorStop(1, 'rgba(255, 240, 200, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(x - haloR, y - haloR, haloR * 2, haloR * 2);

      ctx.fillStyle = 'rgba(255, 248, 220, 0.95)';
      ctx.beginPath();
      ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      ctx.fill();
    } else if (r > 0.93) {
      ctx.fillStyle = `rgba(220, 230, 255, ${0.7 + Math.random() * 0.3})`;
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    } else if (r > 0.70) {
      ctx.fillStyle = `rgba(200, 210, 225, ${0.4 + Math.random() * 0.3})`;
      ctx.fillRect(x, y, 0.8, 0.8);
    } else {
      ctx.fillStyle = `rgba(170, 180, 200, ${0.18 + Math.random() * 0.22})`;
      ctx.fillRect(x, y, 0.6, 0.6);
    }
  }

  return { canvas: off, width, height };
}

/**
 * Draw cached starfield with a tiny camera parallax — distant stars shift
 * slowly when panning, giving a hint of depth without expensive recomputation.
 */
export function drawStarfield(cache: StarfieldCache | null, ctx: RenderContext) {
  if (!cache) return;
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;

  // Parallax offset — small fraction of camera position
  // Wrap so the field tiles seamlessly
  const PARALLAX = 0.04;
  let ox = (-ctx.camera.x * PARALLAX) % cache.width;
  let oy = (-ctx.camera.y * PARALLAX) % cache.height;
  if (ox > 0) ox -= cache.width;
  if (oy > 0) oy -= cache.height;

  // Tile to cover viewport
  for (let x = ox; x < cw; x += cache.width) {
    for (let y = oy; y < ch; y += cache.height) {
      ctx.ctx.drawImage(cache.canvas, x, y);
    }
  }
}

/**
 * Draw orbital path for a body
 */
export function drawOrbit(
  body: Body,
  ctx: RenderContext,
  color: string = COLORS.orbitTrajectory,
  width: number = 1
) {
  if (!body.parent) return; // Can't draw orbit for star

  const parentBody = ctx.bodies.find(b => b.id === body.parent);
  if (!parentBody) return;

  const parentPos = bodyPosition(parentBody, ctx.t, ctx.bodies);
  const canvasParentPos = worldToCanvas(parentPos.x, parentPos.y, ctx);

  ctx.ctx.strokeStyle = color;
  ctx.ctx.lineWidth = width;

  // Eccentric orbit (rogue asteroids on Kuiper trajectories). When
  // bodyPosition switches to Kepler propagation, drawOrbit must
  // switch too — drawing a circle at orbitRadius leaves the sprite
  // visibly off its own orbit ring near periapsis/apoapsis. The
  // ellipse focus is at the parent; semi-major a = (rp+ra)/2,
  // eccentricity e = (ra-rp)/(ra+rp), and the ellipse center sits
  // c = a*e back along the omega axis from the focus.
  if (
    body.orbit_rp !== undefined &&
    body.orbit_ra !== undefined &&
    body.orbit_omega !== undefined
  ) {
    const rp = body.orbit_rp;
    const ra = body.orbit_ra;
    const a = (rp + ra) / 2;
    const e = (ra - rp) / (ra + rp);
    const b = a * Math.sqrt(Math.max(0, 1 - e * e));
    const c = a * e;
    const omega = body.orbit_omega;
    // Ellipse center in world coords, offset from focus along -omega.
    const cx = parentPos.x - Math.cos(omega) * c;
    const cy = parentPos.y - Math.sin(omega) * c;
    const cp = worldToCanvas(cx, cy, ctx);
    ctx.ctx.beginPath();
    ctx.ctx.ellipse(
      cp.x, cp.y,
      a * ctx.camera.scale,
      b * ctx.camera.scale,
      omega,
      0,
      Math.PI * 2,
    );
    ctx.ctx.stroke();
    return;
  }

  // Circular shortcut for normal bodies.
  const radius = body.orbitRadius * ctx.camera.scale;
  ctx.ctx.beginPath();
  ctx.ctx.arc(
    canvasParentPos.x,
    canvasParentPos.y,
    radius,
    0,
    Math.PI * 2,
  );
  ctx.ctx.stroke();
}

/**
 * Draw orbital path for an orbit (ellipse)
 */
export function drawOrbitEllipse(
  orbit: OrbitElements,
  ctx: RenderContext,
  color: string = COLORS.orbitTrajectory,
  width: number = 1,
  isDashed: boolean = false
) {
  const parentBody = ctx.bodies.find(b => b.id === orbit.parentBodyId);
  if (!parentBody) return;

  const parentPos = bodyPosition(parentBody, ctx.t, ctx.bodies);

  const a = semiMajor(orbit);
  const e = eccentricity(orbit);
  const b = a * Math.sqrt(1 - e * e);
  const c = a * e;

  if (isDashed) {
    ctx.ctx.setLineDash([5, 5]);
  }

  ctx.ctx.strokeStyle = color;
  ctx.ctx.lineWidth = width;
  ctx.ctx.beginPath();

  const cosOmega = Math.cos(orbit.omega);
  const sinOmega = Math.sin(orbit.omega);

  const steps = 100;
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * Math.PI * 2;

    const localX = a * Math.cos(theta);
    const localY = b * Math.sin(theta);

    const rotX = localX * cosOmega - localY * sinOmega;
    const rotY = localX * sinOmega + localY * cosOmega;

    // Offset so parent body is at the focus, not ellipse center
    const worldX = parentPos.x + rotX - c * cosOmega;
    const worldY = parentPos.y + rotY - c * sinOmega;
    const canvasPos = worldToCanvas(worldX, worldY, ctx);

    if (i === 0) {
      ctx.ctx.moveTo(canvasPos.x, canvasPos.y);
    } else {
      ctx.ctx.lineTo(canvasPos.x, canvasPos.y);
    }
  }

  ctx.ctx.stroke();
  ctx.ctx.setLineDash([]);
}

// ============================================================
// Body rendering — sphere shading, atmospheres, bands, sun corona
// ============================================================

/** Compute light direction from the Sun toward the body, in canvas space. */
function lightDirToBody(canvasPos: { x: number; y: number }, ctx: RenderContext): { x: number; y: number } {
  const sol = ctx.bodies.find(b => b.id === 'sol');
  if (!sol) return { x: -0.7, y: -0.7 }; // fallback: upper-left
  const solWorld = bodyPosition(sol, ctx.t, ctx.bodies);
  const solCanvas = worldToCanvas(solWorld.x, solWorld.y, ctx);
  const dx = canvasPos.x - solCanvas.x;
  const dy = canvasPos.y - solCanvas.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len }; // unit vector pointing AWAY from sun
}

/** Draw 3D sphere shading: highlight on Sun-facing side, shadow on far side. */
function drawSphereShading(
  canvasPos: { x: number; y: number },
  radius: number,
  ctx: RenderContext,
) {
  // Light comes FROM the sun, so highlight is on the side facing it (-lightDir)
  const ld = lightDirToBody(canvasPos, ctx);
  const hx = canvasPos.x - ld.x * radius * 0.4;
  const hy = canvasPos.y - ld.y * radius * 0.4;
  const sx = canvasPos.x + ld.x * radius * 0.4;
  const sy = canvasPos.y + ld.y * radius * 0.4;

  // Highlight (sun-facing)
  const highlight = ctx.ctx.createRadialGradient(hx, hy, 0, hx, hy, radius * 1.1);
  highlight.addColorStop(0, 'rgba(255, 255, 255, 0.25)');
  highlight.addColorStop(0.4, 'rgba(255, 255, 255, 0.06)');
  highlight.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.ctx.fillStyle = highlight;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
  ctx.ctx.fill();

  // Terminator/shadow (far-from-sun side)
  const shadow = ctx.ctx.createRadialGradient(sx, sy, 0, sx, sy, radius * 1.3);
  shadow.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
  shadow.addColorStop(0.5, 'rgba(0, 0, 0, 0.2)');
  shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.ctx.fillStyle = shadow;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
  ctx.ctx.fill();
}

/** Sun: multi-layer corona, hot core, gentle pulse from simSpeed. */
function drawStarBody(
  body: Body,
  canvasPos: { x: number; y: number },
  radius: number,
  ctx: RenderContext,
) {
  // Outer halo
  const outerR = radius * 6.5;
  const outer = ctx.ctx.createRadialGradient(
    canvasPos.x, canvasPos.y, radius * 0.6,
    canvasPos.x, canvasPos.y, outerR,
  );
  outer.addColorStop(0, 'rgba(255, 209, 128, 0.28)');
  outer.addColorStop(0.4, 'rgba(255, 154, 60, 0.08)');
  outer.addColorStop(1, 'rgba(255, 154, 60, 0)');
  ctx.ctx.fillStyle = outer;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, outerR, 0, Math.PI * 2);
  ctx.ctx.fill();

  // Mid corona
  const midR = radius * 2.6;
  const mid = ctx.ctx.createRadialGradient(
    canvasPos.x, canvasPos.y, radius * 0.9,
    canvasPos.x, canvasPos.y, midR,
  );
  mid.addColorStop(0, 'rgba(255, 220, 150, 0.55)');
  mid.addColorStop(0.7, 'rgba(255, 180, 80, 0.1)');
  mid.addColorStop(1, 'rgba(255, 154, 60, 0)');
  ctx.ctx.fillStyle = mid;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, midR, 0, Math.PI * 2);
  ctx.ctx.fill();

  // Hot core
  const core = ctx.ctx.createRadialGradient(canvasPos.x, canvasPos.y, 0, canvasPos.x, canvasPos.y, radius);
  core.addColorStop(0, '#fff8e0');
  core.addColorStop(0.55, '#ffd180');
  core.addColorStop(1, body.color || '#ffa940');
  ctx.ctx.fillStyle = core;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
  ctx.ctx.fill();
}

/** Black hole: dark event horizon + bright orange/red accretion disk.
 *
 *  Layered from outside in:
 *    - faint blue-violet halo (gravitational lensing suggestion)
 *    - hot accretion disk ring (orange→red→dark falloff)
 *    - black event horizon (filled disk, no gradient — true black)
 *
 *  No "core glow" like a star — the entire point is the central disk
 *  is invisible. Light comes from the swirling accretion disk, not
 *  the singularity itself. We don't bother drawing a Doppler-tilted
 *  disk (one half brighter than the other from rotation) — clean
 *  symmetry reads better at small sizes. */
function drawBlackHoleBody(
  body: Body,
  canvasPos: { x: number; y: number },
  radius: number,
  ctx: RenderContext,
) {
  // Faint outer halo — visual hint at the gravitational lensing
  // signature without actually doing the optics.
  const haloR = radius * 7;
  const halo = ctx.ctx.createRadialGradient(
    canvasPos.x, canvasPos.y, radius * 2.5,
    canvasPos.x, canvasPos.y, haloR,
  );
  halo.addColorStop(0, 'rgba(180, 120, 220, 0.18)');
  halo.addColorStop(0.5, 'rgba(120, 80, 180, 0.06)');
  halo.addColorStop(1, 'rgba(120, 80, 180, 0)');
  ctx.ctx.fillStyle = halo;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, haloR, 0, Math.PI * 2);
  ctx.ctx.fill();

  // Accretion disk — bright ring around the horizon. Bright hot
  // orange near the event horizon, falling off to deep red and then
  // black at the outer edge. radius * 3 gives a chunky ring that
  // reads as the dominant feature.
  const diskR = radius * 3;
  const disk = ctx.ctx.createRadialGradient(
    canvasPos.x, canvasPos.y, radius * 1.05,
    canvasPos.x, canvasPos.y, diskR,
  );
  disk.addColorStop(0,    '#fff0c0');   // innermost: white-hot inner edge
  disk.addColorStop(0.18, '#ffb050');   // hot orange
  disk.addColorStop(0.5,  '#d04020');   // red shade
  disk.addColorStop(0.85, '#401015');   // deep red, almost gone
  disk.addColorStop(1,    'rgba(40, 8, 12, 0)');
  ctx.ctx.fillStyle = disk;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, diskR, 0, Math.PI * 2);
  ctx.ctx.fill();

  // Event horizon — solid black. Drawn LAST so it sits on top of the
  // disk, cleanly blacking out the central region. No gradient — the
  // whole point is that no light escapes. Slightly larger than the
  // body's nominal radius so the disk's inner edge tucks under it.
  ctx.ctx.fillStyle = '#000000';
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius * 1.05, 0, Math.PI * 2);
  ctx.ctx.fill();
}

/** Terrestrial / moon / dwarf / asteroid: atmosphere glow + sphere shading. */
function drawPlanetBody(
  body: Body,
  canvasPos: { x: number; y: number },
  radius: number,
  ctx: RenderContext,
) {
  const color = body.color || COLORS.planetDefault;

  // Atmosphere glow for terrestrial / ice giant
  if ((body.type === 'terrestrial' || body.type === 'ice_giant') && radius > 3) {
    const atmR = radius * 1.35;
    const atm = ctx.ctx.createRadialGradient(
      canvasPos.x, canvasPos.y, radius * 0.95,
      canvasPos.x, canvasPos.y, atmR,
    );
    atm.addColorStop(0, withOpacity(lighten(color, 1.3), 0.35));
    atm.addColorStop(1, withOpacity(color, 0));
    ctx.ctx.fillStyle = atm;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, atmR, 0, Math.PI * 2);
    ctx.ctx.fill();
  }

  // Base disk
  ctx.ctx.fillStyle = color;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
  ctx.ctx.fill();

  // Sphere shading (only when big enough to see)
  if (radius > 3.5) {
    drawSphereShading(canvasPos, radius, ctx);
  }
}

/** Gas giant: outer haze, horizontal cloud bands, sphere shading, refined ring. */
function drawGasGiantBody(
  body: Body,
  canvasPos: { x: number; y: number },
  radius: number,
  ctx: RenderContext,
) {
  const color = body.color || COLORS.gasGiant;

  // Outer atmospheric haze
  const hazeR = radius * 1.4;
  const haze = ctx.ctx.createRadialGradient(
    canvasPos.x, canvasPos.y, radius * 0.95,
    canvasPos.x, canvasPos.y, hazeR,
  );
  haze.addColorStop(0, withOpacity(lighten(color, 1.2), 0.3));
  haze.addColorStop(1, withOpacity(color, 0));
  ctx.ctx.fillStyle = haze;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, hazeR, 0, Math.PI * 2);
  ctx.ctx.fill();

  // Base disk
  ctx.ctx.fillStyle = color;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
  ctx.ctx.fill();

  // Cloud bands (clipped horizontal stripes)
  if (radius > 4) {
    ctx.ctx.save();
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
    ctx.ctx.clip();

    const bandCount = 6;
    const total = radius * 2;
    for (let i = 0; i < bandCount; i++) {
      const y0 = canvasPos.y - radius + (i / bandCount) * total;
      const h = (total / bandCount) * 0.85;
      const tint = i % 2 === 0 ? lighten(color, 1.18) : darken(color, 0.8);
      ctx.ctx.fillStyle = withOpacity(tint, 0.55);
      ctx.ctx.fillRect(canvasPos.x - radius, y0, radius * 2, h);
    }

    ctx.ctx.restore();
  }

  // Sphere shading
  if (radius > 4) {
    drawSphereShading(canvasPos, radius, ctx);
  }

  // Ring (existing ellipse, refined)
  ctx.ctx.strokeStyle = withOpacity(lighten(color, 1.1), 0.55);
  ctx.ctx.lineWidth = 1.5;
  ctx.ctx.beginPath();
  ctx.ctx.ellipse(canvasPos.x, canvasPos.y, radius * 1.95, radius * 0.42, 0, 0, Math.PI * 2);
  ctx.ctx.stroke();

  // Inner ring detail line
  ctx.ctx.strokeStyle = withOpacity(color, 0.3);
  ctx.ctx.lineWidth = 0.5;
  ctx.ctx.beginPath();
  ctx.ctx.ellipse(canvasPos.x, canvasPos.y, radius * 1.6, radius * 0.34, 0, 0, Math.PI * 2);
  ctx.ctx.stroke();
}

/**
 * Draw a celestial body (circle with label) — enhanced with shading, glow,
 * gas giant bands, and a multi-layer sun corona.
 */
export function drawBody(
  body: Body,
  ctx: RenderContext,
  isSelected: boolean = false,
  isHovered: boolean = false
) {
  const pos = bodyPosition(body, ctx.t, ctx.bodies);
  const canvasPos = worldToCanvas(pos.x, pos.y, ctx);
  const radius = Math.max(3, body.radius * ctx.camera.scale);

  if (body.type === 'star') {
    drawStarBody(body, canvasPos, radius, ctx);
  } else if (body.type === 'black_hole') {
    drawBlackHoleBody(body, canvasPos, radius, ctx);
  } else if (body.type === 'gas_giant') {
    drawGasGiantBody(body, canvasPos, radius, ctx);
  } else {
    drawPlanetBody(body, canvasPos, radius, ctx);
  }

  // City-eligibility hint ring. Subtle green band on unowned bodies
  // where the player CAN drop a settlement, so the "where do I go
  // next?" question reads at a glance. Owned bodies already get
  // their owner ring; gas giants / stars / ice giants / black holes
  // get nothing because cities don't fit on them anyway.
  if (!body.ownedBy && canHostCity(body)) {
    const ringR = radius + 4;
    ctx.ctx.save();
    ctx.ctx.strokeStyle = 'rgba(110, 231, 183, 0.45)';
    ctx.ctx.lineWidth = 1;
    ctx.ctx.setLineDash([2, 3]);
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, ringR, 0, Math.PI * 2);
    ctx.ctx.stroke();
    ctx.ctx.setLineDash([]);
    ctx.ctx.restore();
  }

  // Draw selection/hover ring
  if (isSelected) {
    ctx.ctx.strokeStyle = COLORS.warning;
    ctx.ctx.lineWidth = 1;
    ctx.ctx.setLineDash([4, 4]);
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, radius + 6, 0, Math.PI * 2);
    ctx.ctx.stroke();
    ctx.ctx.setLineDash([]);
  } else if (isHovered) {
    ctx.ctx.strokeStyle = COLORS.info;
    ctx.ctx.lineWidth = 1;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, radius + 3, 0, Math.PI * 2);
    ctx.ctx.stroke();
  }

  // Draw label: always for stars, black holes, and direct children of
  // Sol; otherwise only at zoomed-in scales. Black holes ride the same
  // always-on rule as stars so "CYGNUS X" stays readable when the
  // player is pulled all the way out hunting for the far systems.
  const alwaysShowLabel = body.type === 'star' || body.type === 'black_hole' || body.parent === 'sol';
  if (alwaysShowLabel || ctx.camera.scale > 0.4) {
    ctx.ctx.fillStyle = isSelected ? '#ffb84d' : '#8aa0b4';
    ctx.ctx.font = '10px monospace';
    ctx.ctx.textAlign = 'center';
    ctx.ctx.textBaseline = 'top';
    ctx.ctx.fillText(body.name.toUpperCase(), canvasPos.x, canvasPos.y + radius + 14);
  }
}

/**
 * Resolve the per-ship draw color. Mirrors settlementColor so a ship
 * and a settlement owned by the same faction render the same hue.
 * Falls back to cyan / red when factions aren't on the context (old
 * render paths or unit tests that build a bare RenderContext).
 */
function shipColor(ship: Ship, factions: Faction[] | undefined): string {
  if (factions && factions.length > 0) {
    const faction = factions.find(f => f.id === ship.ownedBy);
    if (faction?.color) return faction.color;
  }
  // Fallback: player is cyan, anything else is red. Previously this was
  // the only logic — kept as a safety net so a missing factions array
  // doesn't leave ships colorless.
  return ship.ownedBy === 'player' ? COLORS.neutral : COLORS.danger;
}

/**
 * Draw a ship on its orbit
 */
export function drawShip(
  ship: Ship,
  ctx: RenderContext,
  isSelected: boolean = false,
  formation?: { index: number; total: number }
) {
  const parentBody = ctx.bodies.find(b => b.id === ship.orbit.parentBodyId);
  if (!parentBody) return;

  const parentPos = bodyPosition(parentBody, ctx.t, ctx.bodies);
  const localPos = localPositionAt(ship.orbit, ctx.t);
  const worldX = parentPos.x + localPos.x;
  const worldY = parentPos.y + localPos.y;
  let canvasPos = worldToCanvas(worldX, worldY, ctx);

  // Faction-colored: cyan for player, red for enemy.
  const shipColorValue = shipColor(ship, ctx.factions);

  // Velocity vector — used both to rotate the icon and as a fallback tick.
  const vel = velocityVectorsAt(ship.orbit, ctx.t);
  const heading = Math.atan2(vel.prograde.y, vel.prograde.x);

  // When several ships share the same orbit they stack at exactly the
  // same canvas pixel — invisible to the player. Spread them perpendicular
  // to the orbit's velocity direction by a few canvas pixels each so a
  // cluster of N reads as a small formation rather than a single dot.
  if (formation && formation.total > 1) {
    const perpX = -Math.sin(heading);
    const perpY =  Math.cos(heading);
    const spacing = 12;
    const lane = formation.index - (formation.total - 1) / 2;
    canvasPos = {
      x: canvasPos.x + perpX * lane * spacing,
      y: canvasPos.y + perpY * lane * spacing,
    };
  }

  const iconSize = isSelected ? 22 : 18;

  // Damage flash sits beneath the icon so the icon stays at full opacity.
  const flashStart = ctx.damageFlashStart?.get(ship.id);
  drawDamageFlash(canvasPos, iconSize / 2, flashStart, ctx.t, ctx, 'damage');

  const icon = getShipIconImage(ship.class as ShipIconClass, shipColorValue, ship.iconVariant);
  if (icon) {
    // Draw the icon rotated to face the velocity direction.
    ctx.ctx.save();
    ctx.ctx.translate(canvasPos.x, canvasPos.y);
    ctx.ctx.rotate(heading);
    ctx.ctx.drawImage(icon, -iconSize / 2, -iconSize / 2, iconSize, iconSize);
    ctx.ctx.restore();
  } else {
    // Icon still rasterizing — fall back to the original dot + tick so the
    // map never appears empty.
    const shipSize = isSelected ? 5 : 4;
    ctx.ctx.fillStyle = shipColorValue;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, shipSize, 0, Math.PI * 2);
    ctx.ctx.fill();
    ctx.ctx.strokeStyle = shipColorValue;
    ctx.ctx.lineWidth = 1.5;
    ctx.ctx.beginPath();
    ctx.ctx.moveTo(canvasPos.x, canvasPos.y);
    ctx.ctx.lineTo(canvasPos.x + vel.prograde.x * 10, canvasPos.y + vel.prograde.y * 10);
    ctx.ctx.stroke();
  }

  // Draw selection indicator
  if (isSelected) {
    ctx.ctx.strokeStyle = COLORS.info;
    ctx.ctx.lineWidth = 2;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, iconSize / 2 + 4, 0, Math.PI * 2);
    ctx.ctx.stroke();
  }

  // Draw ship name label
  ctx.ctx.fillStyle = isSelected ? '#ffb84d' : shipColorValue;
  ctx.ctx.font = '9px monospace';
  ctx.ctx.textAlign = 'left';
  ctx.ctx.textBaseline = 'middle';
  ctx.ctx.fillText(ship.name.split(' ')[0], canvasPos.x + iconSize / 2 + 4, canvasPos.y - 6);
}

/**
 * Draw resource panel for a body
 */
export function drawResourcePanel(
  body: Body,
  canvasX: number,
  canvasY: number,
  ctx: RenderContext
) {
  if (!body.resources) return;

  const padding = 8;
  const lineHeight = 14;
  const textSize = 11;
  const panelWidth = 100;
  const panelHeight = lineHeight * 3 + padding * 2;

  // Draw panel background
  ctx.ctx.fillStyle = COLORS.panelBg;
  ctx.ctx.fillRect(canvasX, canvasY, panelWidth, panelHeight);

  ctx.ctx.strokeStyle = COLORS.panelBorder;
  ctx.ctx.lineWidth = 1;
  ctx.ctx.strokeRect(canvasX, canvasY, panelWidth, panelHeight);

  // Draw resources
  ctx.ctx.fillStyle = COLORS.fgDim;
  ctx.ctx.font = `${textSize}px monospace`;
  ctx.ctx.textAlign = 'left';
  ctx.ctx.textBaseline = 'top';

  const labels = ['Fuel', 'Credits', 'Metal', 'Sci'];
  const values = [
    body.resources.fuel,
    body.resources.gold,
    body.resources.metal,
    body.resources.science,
  ];

  for (let i = 0; i < labels.length; i++) {
    const y = canvasY + padding + i * lineHeight;
    const label = labels[i];
    const value = values[i];
    ctx.ctx.fillText(`${label}: ${value}`, canvasX + padding, y);
  }
}

/**
 * Draw text label on canvas
 */
export function drawText(
  text: string,
  canvasX: number,
  canvasY: number,
  ctx: RenderContext,
  color: string = COLORS.fg,
  fontSize: number = 12,
  align: CanvasTextAlign = 'left'
) {
  ctx.ctx.fillStyle = color;
  ctx.ctx.font = `${fontSize}px monospace`;
  ctx.ctx.textAlign = align;
  ctx.ctx.textBaseline = 'top';
  ctx.ctx.fillText(text, canvasX, canvasY);
}

/**
 * Draw a complete trajectory (sequence of arcs through SOIs)
 * Shows projected path with color indicating status
 */
export function drawTrajectory(
  arcs: TrajectoryArc[],
  ctx: RenderContext,
  color: string = COLORS.maneuverPlanned,
  isDashed: boolean = false
) {
  if (arcs.length === 0) return;

  if (isDashed) {
    ctx.ctx.setLineDash([5, 5]);
  }

  ctx.ctx.strokeStyle = color;
  ctx.ctx.lineWidth = 1.5;

  for (const arc of arcs) {
    const parentBody = ctx.bodies.find(b => b.id === arc.orbit.parentBodyId);
    if (!parentBody) continue;

    const steps = 50;
    let isFirstPoint = true;

    for (let i = 0; i <= steps; i++) {
      const t = arc.tStart + (arc.tEnd - arc.tStart) * (i / steps);
      const parentPos = bodyPosition(parentBody, t, ctx.bodies);
      const localPos = localPositionAt(arc.orbit, t);
      const worldX = parentPos.x + localPos.x;
      const worldY = parentPos.y + localPos.y;
      const canvasPos = worldToCanvas(worldX, worldY, ctx);

      if (isFirstPoint) {
        ctx.ctx.beginPath();
        ctx.ctx.moveTo(canvasPos.x, canvasPos.y);
        isFirstPoint = false;
      } else {
        ctx.ctx.lineTo(canvasPos.x, canvasPos.y);
      }
    }

    ctx.ctx.stroke();
  }

  ctx.ctx.setLineDash([]);
}

/**
 * Draw maneuver node marker at a specific position on an arc
 */
export function drawManeuverNode(
  t: number,
  arc: TrajectoryArc,
  ctx: RenderContext,
  color: string = COLORS.info,
  size: number = 6
) {
  const parentBody = ctx.bodies.find(b => b.id === arc.orbit.parentBodyId);
  if (!parentBody || t < arc.tStart || t > arc.tEnd) return;

  const parentPos = bodyPosition(parentBody, t, ctx.bodies);
  const localPos = localPositionAt(arc.orbit, t);
  const worldX = parentPos.x + localPos.x;
  const worldY = parentPos.y + localPos.y;
  const canvasPos = worldToCanvas(worldX, worldY, ctx);

  // Draw diamond marker (rotated square) for maneuver node
  ctx.ctx.save();
  ctx.ctx.translate(canvasPos.x, canvasPos.y);
  ctx.ctx.rotate(Math.PI / 4);
  ctx.ctx.fillStyle = color;
  ctx.ctx.fillRect(-size / 2, -size / 2, size, size);
  ctx.ctx.strokeStyle = color;
  ctx.ctx.lineWidth = 1.5;
  ctx.ctx.strokeRect(-size / 2, -size / 2, size, size);
  ctx.ctx.restore();
}

/**
 * Get the color for a trajectory arc based on its context
 */
export function arcColor(arc: TrajectoryArc, parentIsRoot: boolean): string {
  if (arc.endReason === 'exit') return COLORS.arcEscape;
  if (arc.endReason === 'enter') return parentIsRoot ? COLORS.arcTransfer : COLORS.arcCapture;
  if (parentIsRoot) return COLORS.arcTransfer;
  return COLORS.arcCoast;
}

/**
 * Draw encounter/escape marker at an SOI transition point
 */
export function drawEncounterMarker(
  arc: TrajectoryArc,
  bodyName: string,
  currentTick: number,
  ctx: RenderContext
) {
  const parentBody = ctx.bodies.find(b => b.id === arc.orbit.parentBodyId);
  if (!parentBody) return;

  const t = arc.tEnd;
  const parentPos = bodyPosition(parentBody, t, ctx.bodies);
  const localPos = localPositionAt(arc.orbit, t);
  const worldX = parentPos.x + localPos.x;
  const worldY = parentPos.y + localPos.y;
  const canvasPos = worldToCanvas(worldX, worldY, ctx);

  const isEscape = arc.endReason === 'exit';
  const color = isEscape ? COLORS.escapeLabel : COLORS.captureLabel;
  const label = isEscape ? `${bodyName} Escape` : `${bodyName} Encounter`;

  const ticksUntil = t - currentTick;
  const countdown = ticksUntil > 0 ? ` T-${ticksUntil.toFixed(0)}` : '';

  // Draw small diamond marker
  const sz = 4;
  ctx.ctx.fillStyle = color;
  ctx.ctx.beginPath();
  ctx.ctx.moveTo(canvasPos.x, canvasPos.y - sz);
  ctx.ctx.lineTo(canvasPos.x + sz, canvasPos.y);
  ctx.ctx.lineTo(canvasPos.x, canvasPos.y + sz);
  ctx.ctx.lineTo(canvasPos.x - sz, canvasPos.y);
  ctx.ctx.closePath();
  ctx.ctx.fill();

  // Draw label
  ctx.ctx.fillStyle = color;
  ctx.ctx.font = '10px monospace';
  ctx.ctx.textAlign = 'left';
  ctx.ctx.textBaseline = 'middle';
  ctx.ctx.fillText(`${label}${countdown}`, canvasPos.x + 8, canvasPos.y);
}

/**
 * Draw delta-v and countdown info near a maneuver node
 */
export function drawManeuverNodeLabel(
  t: number,
  arc: TrajectoryArc,
  deltav: number,
  currentTick: number,
  ctx: RenderContext,
  color: string = COLORS.info
) {
  const parentBody = ctx.bodies.find(b => b.id === arc.orbit.parentBodyId);
  if (!parentBody || t < arc.tStart || t > arc.tEnd) return;

  const parentPos = bodyPosition(parentBody, t, ctx.bodies);
  const localPos = localPositionAt(arc.orbit, t);
  const worldX = parentPos.x + localPos.x;
  const worldY = parentPos.y + localPos.y;
  const canvasPos = worldToCanvas(worldX, worldY, ctx);

  const ticksUntil = t - currentTick;
  const countdown = ticksUntil > 0 ? `T-${ticksUntil.toFixed(0)}` : 'NOW';

  ctx.ctx.fillStyle = color;
  ctx.ctx.font = '10px monospace';
  ctx.ctx.textAlign = 'left';
  ctx.ctx.textBaseline = 'bottom';
  ctx.ctx.fillText(`Δv ${Math.abs(deltav).toFixed(2)} km/s`, canvasPos.x + 10, canvasPos.y - 4);
  ctx.ctx.fillText(countdown, canvasPos.x + 10, canvasPos.y + 10);
}

/**
 * Draw periapsis and apoapsis markers on a ship's current orbit
 */
export function drawApsisMarkers(
  ship: Ship,
  ctx: RenderContext
) {
  const parentBody = ctx.bodies.find(b => b.id === ship.orbit.parentBodyId);
  if (!parentBody) return;

  const parentPos = bodyPosition(parentBody, ctx.t, ctx.bodies);

  const orbit = ship.orbit;
  const cosOmega = Math.cos(orbit.omega);
  const sinOmega = Math.sin(orbit.omega);

  // Periapsis position: along omega direction at distance rp from parent
  const periWorldX = parentPos.x + cosOmega * orbit.rp;
  const periWorldY = parentPos.y + sinOmega * orbit.rp;
  const periCanvas = worldToCanvas(periWorldX, periWorldY, ctx);

  // Apoapsis position: opposite omega direction at distance ra from parent
  const apoWorldX = parentPos.x - cosOmega * orbit.ra;
  const apoWorldY = parentPos.y - sinOmega * orbit.ra;
  const apoCanvas = worldToCanvas(apoWorldX, apoWorldY, ctx);

  const orbitColor = COLORS.orbitCurrent;

  // Draw periapsis dot and label
  ctx.ctx.fillStyle = orbitColor;
  ctx.ctx.beginPath();
  ctx.ctx.arc(periCanvas.x, periCanvas.y, 2.5, 0, Math.PI * 2);
  ctx.ctx.fill();
  ctx.ctx.font = '8px monospace';
  ctx.ctx.textAlign = 'center';
  ctx.ctx.textBaseline = 'bottom';
  ctx.ctx.fillText(`Pe ${orbit.rp.toFixed(0)}`, periCanvas.x, periCanvas.y - 6);

  // Draw apoapsis dot and label
  ctx.ctx.fillStyle = orbitColor;
  ctx.ctx.beginPath();
  ctx.ctx.arc(apoCanvas.x, apoCanvas.y, 2.5, 0, Math.PI * 2);
  ctx.ctx.fill();
  ctx.ctx.font = '8px monospace';
  ctx.ctx.textAlign = 'center';
  ctx.ctx.textBaseline = 'bottom';
  ctx.ctx.fillText(`Ap ${orbit.ra.toFixed(0)}`, apoCanvas.x, apoCanvas.y - 6);

}

/**
 * Draw SOI boundary circle around a body
 */
export function drawSOIBoundary(
  body: Body,
  ctx: RenderContext,
  color: string = COLORS.soiBoundary
) {
  if (!body.soi || body.soi <= 0) return;

  const pos = bodyPosition(body, ctx.t, ctx.bodies);
  const canvasPos = worldToCanvas(pos.x, pos.y, ctx);
  const soiRadius = body.soi * ctx.camera.scale;

  if (soiRadius < 5) return;

  ctx.ctx.strokeStyle = withOpacity(color, 0.15);
  ctx.ctx.lineWidth = 1;
  ctx.ctx.setLineDash([3, 6]);
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, soiRadius, 0, Math.PI * 2);
  ctx.ctx.stroke();
  ctx.ctx.setLineDash([]);
}

/**
 * Draw an integrated torch trajectory: samples the actual curved path
 * the ship will fly (including bend from inherited orbital velocity),
 * then connects the samples with two polylines — one for the boost
 * phase (prograde green) and one for the brake phase (retrograde
 * pink), with the flip marker in between. Falls back to the single
 * `color` argument for both phases if needed (used by the all-ships
 * and enemy overlays where faction color matters more than thrust
 * phase).
 */
/** Returns the sample array so callers (drawTransitShip) can position the
 *  ship via lerp on the exact same polyline — guarantees ship sits ON the
 *  line, not next to it. */
export function drawTorchTrajectory(
  plan: TorchTransferPlan,
  bodies: Body[],
  ctx: RenderContext,
  color: string = COLORS.arcTransfer,
  isDashed: boolean = false,
  splitPhaseColors: boolean = false,
): Array<{ t: number; x: number; y: number }> {
  // Playtester said the curved torch arcs were unreadable —
  // straight-line mode draws a single segment from start to end.
  // We still return a 2-sample polyline so drawTransitShip lerps
  // the ship along the same line we drew.
  let samples: Array<{ t: number; x: number; y: number }>;
  if (STRAIGHT_LINE_TRAJECTORIES) {
    samples = [
      { t: plan.startTick,  x: plan.startPos.x,     y: plan.startPos.y },
      { t: plan.arriveTick, x: plan.interceptPos.x, y: plan.interceptPos.y },
    ];
  } else {
    samples = sampleTorchTrajectory(
      plan,
      { pos: { x: plan.startPos.x, y: plan.startPos.y },
        vel: { x: plan.startVel.x, y: plan.startVel.y } },
      bodies,
      80,
    );
  }
  if (samples.length < 2) return samples;

  if (isDashed) ctx.ctx.setLineDash([5, 5]);
  ctx.ctx.lineWidth = 1.5;

  if (splitPhaseColors) {
    // Two passes: boost (samples.t < flipTick) in green, brake in pink.
    // The flip sample stitches them so there's no gap. Adds visual
    // weight to the maneuver — players can see at a glance which half
    // of the trip the ship is currently in.
    const flipIdx = samples.findIndex(s => s.t >= plan.flipTick);
    const splitAt = flipIdx < 0 ? samples.length - 1 : flipIdx;
    ctx.ctx.strokeStyle = '#6ee7b7';  // green = boost / prograde
    ctx.ctx.beginPath();
    for (let i = 0; i <= splitAt; i++) {
      const cp = worldToCanvas(samples[i].x, samples[i].y, ctx);
      if (i === 0) ctx.ctx.moveTo(cp.x, cp.y);
      else ctx.ctx.lineTo(cp.x, cp.y);
    }
    ctx.ctx.stroke();
    ctx.ctx.strokeStyle = '#fda4af';  // pink = brake / retrograde
    ctx.ctx.beginPath();
    for (let i = splitAt; i < samples.length; i++) {
      const cp = worldToCanvas(samples[i].x, samples[i].y, ctx);
      if (i === splitAt) ctx.ctx.moveTo(cp.x, cp.y);
      else ctx.ctx.lineTo(cp.x, cp.y);
    }
    ctx.ctx.stroke();
  } else {
    ctx.ctx.strokeStyle = color;
    ctx.ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const cp = worldToCanvas(samples[i].x, samples[i].y, ctx);
      if (i === 0) ctx.ctx.moveTo(cp.x, cp.y);
      else ctx.ctx.lineTo(cp.x, cp.y);
    }
    ctx.ctx.stroke();
  }
  ctx.ctx.setLineDash([]);
  return samples;
}

export function drawTransitShip(
  ship: Ship,
  ctx: RenderContext,
  isSelected: boolean = false,
  // Samples from drawTorchTrajectory. When provided, the ship is
  // positioned via lerp on the same polyline so it sits exactly ON the
  // line at every t — not on the underlying analytic curve, which
  // diverges from the visible chord between sample points.
  trajectorySamples?: Array<{ t: number; x: number; y: number }>,
) {
  // Torch transit: read state-vector path directly.
  if (ship.transit) {
    drawTorchTransitShip(ship, ctx, isSelected, trajectorySamples);
  }
}

/**
 * Render the special overlay for a body that's on an active ram
 * trajectory: a flame trail trailing the rock, the projected impact
 * path, and a pulsing red ring at the predicted impact location.
 *
 * Called per-frame for any body whose ramPlan is set. The body's
 * normal icon is still drawn by drawBody (bodyPosition honors the
 * torch plan), so this overlay just layers the threat indicators
 * on top.
 */
export function drawRammingBody(
  body: Body,
  ctx: RenderContext,
) {
  if (!body.ramPlan) return;
  const plan = body.ramPlan;
  const t = ctx.t;
  if (t < plan.startTick || t >= plan.arriveTick) return;

  // Sample positions along the ram trajectory for the rendered line.
  const samples = 40;
  const dt = (plan.arriveTick - plan.startTick) / samples;
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= samples; i++) {
    const sampleTick = plan.startTick + i * dt;
    const sb: Body = { ...body, ramPlan: { ...plan, arriveTick: plan.arriveTick + 1 } };
    // Tiny hack: bodyPosition checks `t >= arriveTick` and returns
    // interceptPos. We want the integration value at sampleTick, so
    // bump arriveTick out of the way for the sample.
    points.push(bodyPosition(sb, sampleTick, ctx.bodies));
  }

  // Trajectory line — dashed orange-red, pulsing alpha by closeness
  // to arrival to convey urgency.
  const eta = plan.arriveTick - t;
  const urgency = Math.max(0, Math.min(1, 1 - eta / 200));
  const alpha = 0.35 + 0.45 * urgency;
  ctx.ctx.save();
  ctx.ctx.strokeStyle = `rgba(255, 90, 60, ${alpha})`;
  ctx.ctx.lineWidth = 1.5;
  ctx.ctx.setLineDash([4, 3]);
  ctx.ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const cp = worldToCanvas(points[i].x, points[i].y, ctx);
    if (i === 0) ctx.ctx.moveTo(cp.x, cp.y);
    else ctx.ctx.lineTo(cp.x, cp.y);
  }
  ctx.ctx.stroke();
  ctx.ctx.setLineDash([]);
  ctx.ctx.restore();

  // Engine flame at the asteroid's current position, pointing along
  // its current motion direction. Body has been moving along the
  // trajectory; tangent at current tick = derivative via finite diff.
  const here = bodyPosition(body, t, ctx.bodies);
  const ahead = bodyPosition(body, t + 0.05, ctx.bodies);
  const dx = ahead.x - here.x;
  const dy = ahead.y - here.y;
  const d = Math.hypot(dx, dy);
  if (d > 1e-6) {
    const dirX = dx / d;
    const dirY = dy / d;
    const canvasHere = worldToCanvas(here.x, here.y, ctx);
    // Engine is on the "back" of the rock — opposite the direction
    // of motion (during boost; ram thrust during boost = toward
    // intercept, which is where the rock is heading).
    const enginePos = {
      x: canvasHere.x - dirX * body.radius * ctx.camera.scale,
      y: canvasHere.y + dirY * body.radius * ctx.camera.scale * (-1),
      // (canvas y inverts; flame canvas dir = (dirX, -dirY))
    };
    void enginePos; // kept for symmetry with the ship exhaust; use canvasHere directly
    drawThrustExhaust(
      ctx.ctx,
      { x: canvasHere.x - dirX * body.radius * ctx.camera.scale,
        y: canvasHere.y - (-dirY) * body.radius * ctx.camera.scale },
      { x: dirX, y: -dirY },
      Math.max(10, body.radius * ctx.camera.scale * 1.5),
      1,
    );
  }

  // Impact ghost-marker at the predicted target body position at
  // arriveTick. Pulsing red ring + crosshair so the player can see
  // exactly where + when the strike lands.
  const targetBody = ctx.bodies.find(b => b.id === plan.targetBodyId);
  if (targetBody) {
    const impactPos = bodyPosition(targetBody, plan.arriveTick, ctx.bodies);
    const impactCanvas = worldToCanvas(impactPos.x, impactPos.y, ctx);
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 240);
    const r = Math.max(10, targetBody.radius * ctx.camera.scale + 6);
    ctx.ctx.save();
    ctx.ctx.strokeStyle = `rgba(255, 60, 60, ${0.5 + 0.4 * pulse})`;
    ctx.ctx.lineWidth = 1.5;
    ctx.ctx.setLineDash([3, 3]);
    ctx.ctx.beginPath();
    ctx.ctx.arc(impactCanvas.x, impactCanvas.y, r, 0, Math.PI * 2);
    ctx.ctx.stroke();
    ctx.ctx.setLineDash([]);
    // Crosshair — arm length proportional to the ring `r` so the tics
    // scale with the impact ring at any zoom (instead of a fixed
    // canvas-pixel offset that looks tiny on a large ring and bloated
    // relative to a small one).
    const armOuter = Math.max(3, r * 0.3);
    const armInner = Math.max(1.5, r * 0.15);
    ctx.ctx.beginPath();
    ctx.ctx.moveTo(impactCanvas.x - r - armOuter, impactCanvas.y);
    ctx.ctx.lineTo(impactCanvas.x - r + armInner, impactCanvas.y);
    ctx.ctx.moveTo(impactCanvas.x + r - armInner, impactCanvas.y);
    ctx.ctx.lineTo(impactCanvas.x + r + armOuter, impactCanvas.y);
    ctx.ctx.moveTo(impactCanvas.x, impactCanvas.y - r - armOuter);
    ctx.ctx.lineTo(impactCanvas.x, impactCanvas.y - r + armInner);
    ctx.ctx.moveTo(impactCanvas.x, impactCanvas.y + r - armInner);
    ctx.ctx.lineTo(impactCanvas.x, impactCanvas.y + r + armOuter);
    ctx.ctx.stroke();
    // Countdown label
    ctx.ctx.fillStyle = `rgba(255, 100, 80, ${0.7 + 0.3 * pulse})`;
    ctx.ctx.font = 'bold 10px monospace';
    ctx.ctx.textAlign = 'center';
    ctx.ctx.textBaseline = 'bottom';
    ctx.ctx.fillText(`⚠ IMPACT T-${eta.toFixed(0)}`, impactCanvas.x, impactCanvas.y - r - 6);
    ctx.ctx.restore();
  }
}

/**
 * Tapered cone of exhaust trailing from a thrusting ship's engine.
 *
 * `enginePos` is the canvas-space point where the engine bell sits
 * (the back edge of the ship icon). `thrustDir` is a UNIT vector in
 * canvas space pointing in the direction the engine is firing — i.e.
 * the direction the ship is *trying to go*. The flame extends in the
 * OPPOSITE direction (exhaust comes out the back of the engine).
 *
 * Cheap visuals: a single filled triangle with a linear gradient from
 * bright yellow-white at the nozzle to transparent at the tail, plus
 * a small per-frame jitter on the tail point so the flame looks
 * alive. Total cost: one beginPath + one fill per thrusting ship.
 */
function drawThrustExhaust(
  ctx2d: CanvasRenderingContext2D,
  enginePos: { x: number; y: number },
  thrustDir: { x: number; y: number },
  shipSize: number,
  intensity: number = 1,
) {
  // Flame length scales with ship icon size. Trail length stays
  // recognizable even when zoomed out.
  const flameLen = shipSize * 2.4;
  const flameWidth = shipSize * 0.42;
  // Exhaust extends OPPOSITE to thrust.
  const tailX = enginePos.x - thrustDir.x * flameLen;
  const tailY = enginePos.y - thrustDir.y * flameLen;
  // Perpendicular for the flame's flared base near the engine bell.
  const perpX = -thrustDir.y;
  const perpY = thrustDir.x;
  // Per-frame jitter for a "live" flicker. Random is fine — the
  // unpredictability is the point. Cheap enough to do every frame.
  const jitterMag = shipSize * 0.18;
  const jitterT = (Math.random() - 0.5) * 2 * jitterMag;       // tail wag
  const jitterP = (Math.random() - 0.5) * jitterMag * 0.3;     // base wiggle
  const lenJitter = (Math.random() - 0.5) * shipSize * 0.4;    // length pulse

  // Gradient: hot core at the engine bell, cooling out to the tail.
  const grad = ctx2d.createLinearGradient(
    enginePos.x, enginePos.y,
    tailX, tailY,
  );
  grad.addColorStop(0,    `rgba(255, 245, 200, ${0.95 * intensity})`);
  grad.addColorStop(0.25, `rgba(255, 180, 90,  ${0.70 * intensity})`);
  grad.addColorStop(0.7,  `rgba(255, 90, 50,   ${0.25 * intensity})`);
  grad.addColorStop(1,     'rgba(255, 60, 30, 0)');

  ctx2d.save();
  ctx2d.fillStyle = grad;
  ctx2d.beginPath();
  // Flared base near the engine nozzle.
  ctx2d.moveTo(
    enginePos.x + perpX * (flameWidth + jitterP),
    enginePos.y + perpY * (flameWidth + jitterP),
  );
  ctx2d.lineTo(
    enginePos.x - perpX * (flameWidth - jitterP),
    enginePos.y - perpY * (flameWidth - jitterP),
  );
  // Tapered tail with side-to-side wag.
  ctx2d.lineTo(
    tailX - thrustDir.x * lenJitter + perpX * jitterT,
    tailY - thrustDir.y * lenJitter + perpY * jitterT,
  );
  ctx2d.closePath();
  ctx2d.fill();

  // Hot inner core — a smaller, brighter triangle layered over the
  // outer flame so the engine bell reads as the brightest point.
  const coreLen = flameLen * 0.45;
  const coreW = flameWidth * 0.55;
  const coreTailX = enginePos.x - thrustDir.x * coreLen;
  const coreTailY = enginePos.y - thrustDir.y * coreLen;
  const coreGrad = ctx2d.createLinearGradient(
    enginePos.x, enginePos.y,
    coreTailX, coreTailY,
  );
  coreGrad.addColorStop(0, `rgba(255, 255, 235, ${0.95 * intensity})`);
  coreGrad.addColorStop(1, `rgba(255, 200, 100, 0)`);
  ctx2d.fillStyle = coreGrad;
  ctx2d.beginPath();
  ctx2d.moveTo(enginePos.x + perpX * coreW, enginePos.y + perpY * coreW);
  ctx2d.lineTo(enginePos.x - perpX * coreW, enginePos.y - perpY * coreW);
  ctx2d.lineTo(coreTailX, coreTailY);
  ctx2d.closePath();
  ctx2d.fill();
  ctx2d.restore();
}

/**
 * Torch-mode equivalent of drawTransitShip. Reads ship.transit.pos for
 * the world position (no need to interpolate — the executor keeps it
 * fresh each tick), ship.transit.vel for the heading. Falls back to a
 * dot+tick line when no ship icon is available.
 *
 * Flip-and-burn orientation: during BOOST the ship points along its
 * velocity vector (engine at the trailing edge, exhaust streams behind).
 * At flipTick the ship rotates 180° to BRAKE — engine now points along
 * the velocity vector, exhaust streams AHEAD of motion as the ship
 * decelerates. That's the moment everyone in space-sim land waits for.
 */
function drawTorchTransitShip(
  ship: Ship,
  ctx: RenderContext,
  isSelected: boolean,
  trajectorySamples?: Array<{ t: number; x: number; y: number }>,
) {
  if (!ship.transit) return;
  const { vel, currentTransfer } = ship.transit;
  // Position the ship by lerping into the same sample array the line is
  // drawn from. Without this the ship reads ship.transit.pos — an
  // independent fresh integration that agrees with the line only at
  // sample times, leaving the ship visibly off the polyline mid-segment.
  // Falls back to the stored pos when no samples were provided (e.g. an
  // old caller hasn't been threaded yet).
  const lerpedPos = trajectorySamples && trajectorySamples.length > 0
    ? torchPositionFromSamples(trajectorySamples, ctx.t)
    : { x: ship.transit.pos.x, y: ship.transit.pos.y };
  const canvasPos = worldToCanvas(lerpedPos.x, lerpedPos.y, ctx);
  const shipColorValue = shipColor(ship, ctx.factions);

  // Phase detection: BOOST (engine fires prograde toward intercept) vs
  // BRAKE (engine fires retrograde to kill velocity relative to target).
  // Outside [startTick, arriveTick] the ship is coasting.
  const isBoost = ctx.t >= currentTransfer.startTick && ctx.t < currentTransfer.flipTick;
  const isBrake = ctx.t >= currentTransfer.flipTick && ctx.t < currentTransfer.arriveTick;
  const thrusting = isBoost || isBrake;

  // Ship's nose ALWAYS points in the thrust direction — that's where
  // the engine is firing. NOT velocity direction. Big difference early
  // in boost when the ship still has substantial inherited orbital
  // velocity perpendicular to the thrust axis: the rocket points where
  // it's pushing, not where it's currently drifting.
  //
  //   BOOST  → thrust toward intercept point (the moving-target aim)
  //   BRAKE  → thrust opposite the ship's velocity (so the engine
  //            naturally ends up pointed "ahead" of motion — the
  //            classic flip-and-burn silhouette)
  //   COAST  → no thrust; fall back to velocity direction so the icon
  //            isn't lurching to face an arbitrary reference
  let thrustX: number, thrustY: number;
  if (isBoost) {
    const dx = currentTransfer.interceptPos.x - lerpedPos.x;
    const dy = currentTransfer.interceptPos.y - lerpedPos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    thrustX = d > 1e-9 ? dx / d : 1;
    thrustY = d > 1e-9 ? dy / d : 0;
  } else if (isBrake) {
    const vMag = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
    thrustX = vMag > 1e-9 ? -vel.x / vMag : 1;
    thrustY = vMag > 1e-9 ? -vel.y / vMag : 0;
  } else {
    const vMag = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
    thrustX = vMag > 1e-9 ? vel.x / vMag : 1;
    thrustY = vMag > 1e-9 ? vel.y / vMag : 0;
  }
  // Canvas y axis inverts.
  const heading = Math.atan2(-thrustY, thrustX);

  const iconSize = isSelected ? 22 : 18;

  const flashStartT = ctx.damageFlashStart?.get(ship.id);
  drawDamageFlash(canvasPos, iconSize / 2, flashStartT, ctx.t, ctx, 'damage');

  // Thrust exhaust — drawn BEFORE the ship icon so the icon sits on top
  // of the engine. Engine is at the "back" of the local ship icon
  // (negative x in local space, since icons face +x at heading=0).
  // After rotating by `heading`, the engine in canvas coords is:
  //   enginePos = canvasPos - heading_unit * iconSize/2
  // The exhaust then extends further in -heading_unit (further behind
  // the engine). This is correct in BOTH phases: in BRAKE the ship has
  // flipped, so "behind the engine" in world space is now AHEAD of
  // motion — exactly what you'd see when the torch decelerates.
  if (thrusting) {
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);
    drawThrustExhaust(
      ctx.ctx,
      { x: canvasPos.x - cosH * iconSize / 2, y: canvasPos.y - sinH * iconSize / 2 },
      { x: cosH, y: sinH },
      iconSize,
      isSelected ? 1.0 : 0.85,
    );
  }

  const icon = getShipIconImage(ship.class as ShipIconClass, shipColorValue, ship.iconVariant);
  if (icon) {
    ctx.ctx.save();
    ctx.ctx.translate(canvasPos.x, canvasPos.y);
    ctx.ctx.rotate(heading);
    ctx.ctx.drawImage(icon, -iconSize / 2, -iconSize / 2, iconSize, iconSize);
    ctx.ctx.restore();
  } else {
    const shipSize = isSelected ? 5 : 4;
    ctx.ctx.fillStyle = shipColorValue;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, shipSize, 0, Math.PI * 2);
    ctx.ctx.fill();
    // Nose tick — points the way the ship is FACING (engine at the
    // other end), so during BRAKE this tick visibly flips around.
    const noseX = Math.cos(heading);
    const noseY = Math.sin(heading);
    ctx.ctx.strokeStyle = shipColorValue;
    ctx.ctx.lineWidth = 1.5;
    ctx.ctx.beginPath();
    ctx.ctx.moveTo(canvasPos.x, canvasPos.y);
    ctx.ctx.lineTo(canvasPos.x + noseX * 10, canvasPos.y + noseY * 10);
    ctx.ctx.stroke();
  }

  if (isSelected) {
    ctx.ctx.strokeStyle = COLORS.info;
    ctx.ctx.lineWidth = 2;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, iconSize / 2 + 4, 0, Math.PI * 2);
    ctx.ctx.stroke();
  }

  // Ship name
  ctx.ctx.fillStyle = isSelected ? '#ffb84d' : shipColorValue;
  ctx.ctx.font = '9px monospace';
  ctx.ctx.textAlign = 'left';
  ctx.ctx.textBaseline = 'middle';
  ctx.ctx.fillText(ship.name.split(' ')[0], canvasPos.x + iconSize / 2 + 4, canvasPos.y - 6);

  // ETA + phase label when selected
  if (isSelected) {
    const eta = currentTransfer.arriveTick - ctx.t;
    const phase = ctx.t < currentTransfer.flipTick ? 'BOOST' : 'BRAKE';
    if (eta > 0) {
      ctx.ctx.fillStyle = COLORS.fgDim;
      ctx.ctx.font = '8px monospace';
      ctx.ctx.textAlign = 'left';
      ctx.ctx.fillText(`${phase} · ETA T-${eta.toFixed(0)}`, canvasPos.x + 8, canvasPos.y + 6);
    }
  }
}

export function drawTargetHighlight(
  body: Body,
  ctx: RenderContext,
  isHovered: boolean
) {
  const pos = bodyPosition(body, ctx.t, ctx.bodies);
  const canvasPos = worldToCanvas(pos.x, pos.y, ctx);
  const radius = Math.max(3, body.radius * ctx.camera.scale);

  const ringRadius = radius + (isHovered ? 10 : 6);
  const color = isHovered ? COLORS.warning : COLORS.info;

  ctx.ctx.strokeStyle = withOpacity(color, isHovered ? 0.9 : 0.4);
  ctx.ctx.lineWidth = isHovered ? 2.5 : 1.5;
  ctx.ctx.setLineDash(isHovered ? [] : [4, 4]);
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, ringRadius, 0, Math.PI * 2);
  ctx.ctx.stroke();
  ctx.ctx.setLineDash([]);

  if (isHovered) {
    // Pulsing outer ring
    ctx.ctx.strokeStyle = withOpacity(color, 0.3);
    ctx.ctx.lineWidth = 1;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, ringRadius + 4, 0, Math.PI * 2);
    ctx.ctx.stroke();
  }
}

export function drawGhostPlanet(
  body: Body,
  futureTime: number,
  currentTick: number,
  ctx: RenderContext
) {
  const pos = bodyPosition(body, futureTime, ctx.bodies);
  const canvasPos = worldToCanvas(pos.x, pos.y, ctx);
  const radius = Math.max(3, body.radius * ctx.camera.scale);

  const opacity = 0.3;
  ctx.ctx.fillStyle = withOpacity(body.color || COLORS.planetDefault, opacity);
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
  ctx.ctx.fill();

  // Dashed circle outline
  ctx.ctx.strokeStyle = withOpacity(body.color || COLORS.planetDefault, opacity * 0.7);
  ctx.ctx.lineWidth = 1;
  ctx.ctx.setLineDash([3, 3]);
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius + 2, 0, Math.PI * 2);
  ctx.ctx.stroke();
  ctx.ctx.setLineDash([]);

  // Label
  ctx.ctx.fillStyle = withOpacity('#8aa0b4', opacity);
  ctx.ctx.font = '9px monospace';
  ctx.ctx.textAlign = 'center';
  ctx.ctx.textBaseline = 'top';
  const eta = futureTime - currentTick;
  const etaLabel = eta > 0 ? ` T-${eta.toFixed(0)}` : '';
  ctx.ctx.fillText(`${body.name}${etaLabel}`, canvasPos.x, canvasPos.y + radius + 6);
}

// ============================================================
// Settlement rendering
// ============================================================

function settlementColor(settlement: Settlement, factions: Faction[]): string {
  const faction = factions.find(f => f.id === settlement.ownedBy);
  return faction?.color || COLORS.neutral;
}

/**
 * Draw a city: a small filled square mounted on the body's surface at
 * `surfaceAngle`. Population indicated by stacked notches above marker.
 */
export function drawCity(
  settlement: Settlement,
  body: Body,
  factions: Faction[],
  ctx: RenderContext,
  isSelected: boolean = false,
) {
  if (settlement.bodyId !== body.id) return;
  const bodyPos = bodyPosition(body, ctx.t, ctx.bodies);
  const angle = settlement.surfaceAngle ?? 0;
  const surfaceR = body.radius;
  const worldX = bodyPos.x + surfaceR * Math.cos(angle);
  const worldY = bodyPos.y + surfaceR * Math.sin(angle);
  const canvasPos = worldToCanvas(worldX, worldY, ctx);

  const color = settlementColor(settlement, factions);
  const size = Math.max(3, 4 * Math.min(1.5, Math.sqrt(ctx.camera.scale)));

  // Outward orientation
  const outwardX = Math.cos(angle);
  const outwardY = Math.sin(angle);
  const tipX = canvasPos.x + outwardX * size * 0.5;
  const tipY = canvasPos.y + outwardY * size * 0.5;

  // Damage flash underneath the marker
  const flashStartC = ctx.damageFlashStart?.get(settlement.id);
  drawDamageFlash({ x: tipX, y: tipY }, size, flashStartC, ctx.t, ctx, 'damage');

  ctx.ctx.fillStyle = color;
  ctx.ctx.strokeStyle = '#0a0e14';
  ctx.ctx.lineWidth = 1;
  ctx.ctx.beginPath();
  ctx.ctx.rect(tipX - size / 2, tipY - size / 2, size, size);
  ctx.ctx.fill();
  ctx.ctx.stroke();

  // HP bar if damaged
  if (settlement.hp < settlement.maxHp) {
    const barW = size * 1.5;
    const barH = 2;
    const barX = tipX - barW / 2;
    const barY = tipY - size - 5;
    const hpFrac = Math.max(0, settlement.hp / settlement.maxHp);
    ctx.ctx.fillStyle = '#2a3d50';
    ctx.ctx.fillRect(barX, barY, barW, barH);
    ctx.ctx.fillStyle = hpFrac > 0.5 ? COLORS.success : hpFrac > 0.25 ? COLORS.warning : COLORS.danger;
    ctx.ctx.fillRect(barX, barY, barW * hpFrac, barH);
  }

  // Population pips
  if (settlement.population > 1 && ctx.camera.scale > 0.7) {
    const pipCount = Math.min(settlement.population, 5);
    const pipSize = 1;
    const pipSpacing = 3;
    const pipsW = (pipCount - 1) * pipSpacing;
    const pipY = tipY - size - 9;
    ctx.ctx.fillStyle = color;
    for (let i = 0; i < pipCount; i++) {
      const px = tipX - pipsW / 2 + i * pipSpacing;
      ctx.ctx.beginPath();
      ctx.ctx.arc(px, pipY, pipSize, 0, Math.PI * 2);
      ctx.ctx.fill();
    }
  }

  if (isSelected) {
    ctx.ctx.strokeStyle = COLORS.warning;
    ctx.ctx.lineWidth = 1;
    ctx.ctx.setLineDash([3, 3]);
    ctx.ctx.beginPath();
    ctx.ctx.arc(tipX, tipY, size + 4, 0, Math.PI * 2);
    ctx.ctx.stroke();
    ctx.ctx.setLineDash([]);
  }
}

/**
 * Draw a station: a diamond marker on a thin orbital ring around the body.
 */
export function drawStation(
  settlement: Settlement,
  body: Body,
  factions: Faction[],
  ctx: RenderContext,
  isSelected: boolean = false,
) {
  if (settlement.bodyId !== body.id || !settlement.orbit) return;
  const bodyPos = bodyPosition(body, ctx.t, ctx.bodies);

  const orbit = settlement.orbit;
  const radius = (orbit.rp + orbit.ra) / 2;
  const M = orbit.M0 + (2 * Math.PI * (ctx.t - orbit.epoch) / orbit.period) * orbit.direction;
  const theta = M;
  const localX = radius * Math.cos(theta);
  const localY = radius * Math.sin(theta);
  const worldX = bodyPos.x + localX;
  const worldY = bodyPos.y + localY;
  const canvasPos = worldToCanvas(worldX, worldY, ctx);

  const color = settlementColor(settlement, factions);
  const size = Math.max(3, 4 * Math.min(1.5, Math.sqrt(ctx.camera.scale)));

  // Orbit ring at station altitude
  const canvasBodyPos = worldToCanvas(bodyPos.x, bodyPos.y, ctx);
  const orbitRpx = radius * ctx.camera.scale;
  if (orbitRpx > 4) {
    ctx.ctx.strokeStyle = withOpacity(color, 0.25);
    ctx.ctx.lineWidth = 0.5;
    ctx.ctx.setLineDash([2, 3]);
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasBodyPos.x, canvasBodyPos.y, orbitRpx, 0, Math.PI * 2);
    ctx.ctx.stroke();
    ctx.ctx.setLineDash([]);
  }

  // Damage flash underneath the diamond
  const flashStartS = ctx.damageFlashStart?.get(settlement.id);
  drawDamageFlash(canvasPos, size, flashStartS, ctx.t, ctx, 'damage');

  // Diamond
  ctx.ctx.fillStyle = color;
  ctx.ctx.strokeStyle = '#0a0e14';
  ctx.ctx.lineWidth = 1;
  ctx.ctx.beginPath();
  ctx.ctx.moveTo(canvasPos.x, canvasPos.y - size);
  ctx.ctx.lineTo(canvasPos.x + size, canvasPos.y);
  ctx.ctx.lineTo(canvasPos.x, canvasPos.y + size);
  ctx.ctx.lineTo(canvasPos.x - size, canvasPos.y);
  ctx.ctx.closePath();
  ctx.ctx.fill();
  ctx.ctx.stroke();

  // HP bar
  if (settlement.hp < settlement.maxHp) {
    const barW = size * 1.8;
    const barH = 2;
    const barX = canvasPos.x - barW / 2;
    const barY = canvasPos.y - size - 5;
    const hpFrac = Math.max(0, settlement.hp / settlement.maxHp);
    ctx.ctx.fillStyle = '#2a3d50';
    ctx.ctx.fillRect(barX, barY, barW, barH);
    ctx.ctx.fillStyle = hpFrac > 0.5 ? COLORS.success : hpFrac > 0.25 ? COLORS.warning : COLORS.danger;
    ctx.ctx.fillRect(barX, barY, barW * hpFrac, barH);
  }

  // Population pips
  if (settlement.population > 1 && ctx.camera.scale > 0.7) {
    const pipCount = Math.min(settlement.population, 5);
    const pipSize = 1;
    const pipSpacing = 3;
    const pipsW = (pipCount - 1) * pipSpacing;
    const pipY = canvasPos.y - size - 9;
    ctx.ctx.fillStyle = color;
    for (let i = 0; i < pipCount; i++) {
      const px = canvasPos.x - pipsW / 2 + i * pipSpacing;
      ctx.ctx.beginPath();
      ctx.ctx.arc(px, pipY, pipSize, 0, Math.PI * 2);
      ctx.ctx.fill();
    }
  }

  if (isSelected) {
    ctx.ctx.strokeStyle = COLORS.warning;
    ctx.ctx.lineWidth = 1;
    ctx.ctx.setLineDash([3, 3]);
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, size + 4, 0, Math.PI * 2);
    ctx.ctx.stroke();
    ctx.ctx.setLineDash([]);
  }
}

/**
 * Dispatch by settlement type
 */
export function drawSettlement(
  settlement: Settlement,
  body: Body,
  factions: Faction[],
  ctx: RenderContext,
  isSelected: boolean = false,
) {
  if (settlement.type === 'city') {
    drawCity(settlement, body, factions, ctx, isSelected);
  } else {
    drawStation(settlement, body, factions, ctx, isSelected);
  }
}

// ============================================================
// Fog of war rendering
// ============================================================

export interface GhostIntel {
  x: number;
  y: number;
  tick: number;
  shipClass: string;
  ownedBy: string;
}

/**
 * Draw a "last-known" ghost marker for a ship that's no longer in sensor
 * range. The marker fades as the intel ages.
 *
 *   currentTick - intel.tick  →  age in ticks
 *
 * Opacity ramps from 60% (fresh) to ~0% at GHOST_LIFETIME.
 */
export function drawShipGhost(
  intel: GhostIntel,
  currentTick: number,
  ghostLifetime: number,
  factions: Faction[],
  ctx: RenderContext,
) {
  const age = currentTick - intel.tick;
  if (age >= ghostLifetime) return;

  const freshness = 1 - age / ghostLifetime;
  const opacity = 0.55 * freshness;

  const faction = factions.find(f => f.id === intel.ownedBy);
  const color = faction?.color || COLORS.fgDim;

  const canvasPos = worldToCanvas(intel.x, intel.y, ctx);
  // Match drawShip's sqrt-mitigated scaling so the ghost reads as
  // "ship-shaped" at any zoom — fixed 4px bloats relative to actual
  // ships when the player pulls way out.
  const size = Math.max(2.5, 4 * Math.min(1.5, Math.sqrt(ctx.camera.scale)));

  // Dashed outline circle
  ctx.ctx.strokeStyle = withOpacity(color, opacity);
  ctx.ctx.lineWidth = 1;
  ctx.ctx.setLineDash([3, 3]);
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, size, 0, Math.PI * 2);
  ctx.ctx.stroke();
  ctx.ctx.setLineDash([]);

  // Inner dot
  ctx.ctx.fillStyle = withOpacity(color, opacity * 0.5);
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, size * 0.45, 0, Math.PI * 2);
  ctx.ctx.fill();

  // T-N timestamp label (only when fresh-ish to reduce clutter)
  if (freshness > 0.4) {
    ctx.ctx.fillStyle = withOpacity(color, opacity * 0.9);
    ctx.ctx.font = '8px monospace';
    ctx.ctx.textAlign = 'center';
    ctx.ctx.textBaseline = 'top';
    ctx.ctx.fillText(`T-${age.toFixed(0)}`, canvasPos.x, canvasPos.y + size + 4);
  }
}


// ============================================================
// Toggleable map layers (see src/state/mapLayers.tsx)
//
// Each function draws one overlay across the whole map. They're
// cheap on top of the existing per-frame draw so we can leave them
// uncached. Players toggle layers via LayersPanel; MapCanvas calls
// these conditionally on `useMapLayers().isOn(...)`.
// ============================================================

/**
 * Faint Bezier arc for every ship currently in transit, colored by
 * the owning faction. Already-selected ships keep their own (brighter)
 * arc drawn elsewhere — this is the "at-a-glance everyone-is-going-
 * somewhere" overview that lets players plan around traffic.
 */
export function drawAllTransfersLayer(
  ships: Ship[],
  ctx: RenderContext,
) {
  for (const ship of ships) {
    const color = shipColor(ship, ctx.factions);
    ctx.ctx.save();
    ctx.ctx.globalAlpha = 0.45;
    if (ship.transit) {
      drawTorchTrajectory(ship.transit.currentTransfer, ctx.bodies, ctx, color, false);
    }
    ctx.ctx.restore();
  }
}

/**
 * Highlight enemy ships whose transfer ends at one of the player's
 * bodies. The base arc gets a red glow + the arrival body gets a
 * pulsing "INCOMING" ring. Filters by `visibleShipIds` so fog of
 * war stays honored — you only see threats your sensors can see.
 */
export function drawEnemyTrajectoriesLayer(
  ships: Ship[],
  bodies: Body[],
  visibleShipIds: Set<string>,
  playerFactionId: string,
  ctx: RenderContext,
) {
  for (const ship of ships) {
    if (ship.ownedBy === playerFactionId) continue;
    if (!visibleShipIds.has(ship.id)) continue;

    // Find the target body from the torch plan to drive the
    // "is this aimed at me?" intensity.
    let targetBodyId: string | undefined;
    if (ship.transit) targetBodyId = ship.transit.currentTransfer.targetBodyId;
    else continue;

    const target = bodies.find(b => b.id === targetBodyId);
    const targetOwned = target?.ownedBy === playerFactionId;
    const color = targetOwned ? '#ff3030' : '#ff8a40';
    ctx.ctx.save();
    ctx.ctx.globalAlpha = targetOwned ? 0.85 : 0.5;
    ctx.ctx.shadowColor = color;
    // shadowBlur is canvas-pixel based; a fixed 6 stays the same
    // on screen at every zoom. At full zoom-out the trajectory line
    // becomes a short stub and that 6px halo paints a red smear
    // around it. Scale with the destruction flash treatment.
    const blurFactor = Math.min(1.2, Math.max(0.3, Math.sqrt(ctx.camera.scale)));
    ctx.ctx.shadowBlur = targetOwned ? 6 * blurFactor : 0;
    if (ship.transit) {
      drawTorchTrajectory(ship.transit.currentTransfer, bodies, ctx, color, !targetOwned);
    }
    ctx.ctx.restore();
  }
}

/**
 * Render explosion flashes for entities that were destroyed recently.
 * MapCanvas tracks ship/settlement disappearances and accumulates
 * { worldPos, startTick } pairs; this pass walks them and draws the
 * big destruction variant of the flash at each remembered location.
 * Stale entries (older than DESTRUCTION_FLASH_DURATION_TICKS) are
 * filtered out client-side before we get here.
 */
export interface DestructionFlash {
  pos: { x: number; y: number };  // world coords
  startTick: number;
  baseRadius?: number;            // visual size; defaults to 10
}

export function drawDestructionFlashes(
  flashes: DestructionFlash[],
  ctx: RenderContext,
  durationTicks?: number,
) {
  // baseRadius is authored as a canvas-pixel reference at "normal" zoom
  // (~10-14 px), and drawDamageFlash blooms it 4-8x into the halo. Left
  // unscaled, that halo stays the same screen size regardless of camera
  // zoom — at full zoom-out, an 80-110 px explosion engulfs entire orbits
  // and dominates the map. Scale by sqrt(scale) with clamps so the flash
  // tracks how big the destroyed entity itself looks.
  const sizeFactor = Math.min(1.2, Math.max(0.3, Math.sqrt(ctx.camera.scale)));
  for (const f of flashes) {
    const cp = worldToCanvas(f.pos.x, f.pos.y, ctx);
    drawDamageFlash(
      cp,
      (f.baseRadius ?? 10) * sizeFactor,
      f.startTick,
      ctx.t,
      ctx,
      'destruction',
      durationTicks,
    );
  }
}

/**
 * Fog-of-war dimming overlay. Always-on (no toggle). Paints a dark
 * semi-transparent layer over the entire canvas, then punches out
 * the union of sensor coverage circles — so in-range areas render
 * normally and everything else fades to a grey wash that still lets
 * planet motion through.
 *
 * Drawn LAST in the render order so it dims absolutely everything
 * (bodies, ships, orbits, other layer overlays).
 *
 * The OLD approach used a single rect + circles path with even-odd
 * fill. That's broken when two sensor circles overlap: a point
 * covered by two circles has subpath count 3 (rect + circle + circle)
 * which is odd, so even-odd considers it INSIDE the fill region —
 * the dim wash gets re-applied right where the player has the most
 * coverage. Visible as a "dark blob" centered on busy bodies.
 *
 * New approach (offscreen canvas):
 *   1. Fill the whole offscreen with the dim wash.
 *   2. destination-out the union of sensor circles with opaque ink,
 *      which fully erases the wash inside the union regardless of
 *      how many circles stack.
 *   3. drawImage onto the main canvas.
 */
// Module-level cache for the fog offscreen canvas. Allocating a new
// fullscreen canvas every frame burned ~24MB/s of memory churn on
// mid-tier phones (430×932×4 bytes × 60fps), starving the GC and
// stuttering the map. Cache it across frames; only re-allocate when
// the viewport changes size.
let fogOffscreen: HTMLCanvasElement | null = null;
let fogOffscreenCtx: CanvasRenderingContext2D | null = null;

export function drawFogOfWarOverlay(
  rings: Array<{ pos: { x: number; y: number }; range: number }>,
  ctx: RenderContext,
) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  if (!fogOffscreen || fogOffscreen.width !== w || fogOffscreen.height !== h) {
    fogOffscreen = document.createElement('canvas');
    fogOffscreen.width = w;
    fogOffscreen.height = h;
    fogOffscreenCtx = fogOffscreen.getContext('2d');
  }
  const oc = fogOffscreenCtx;
  if (!oc) return;

  // Pass 0: reset to fully transparent so last frame's wash + holes
  // don't bleed through. clearRect is the cheapest way to wipe an
  // entire backing buffer.
  oc.globalCompositeOperation = 'source-over';
  oc.clearRect(0, 0, w, h);

  // Pass 1: wash the whole offscreen with the dim color. Opacity is
  // tuned so planet motion + orbits stay visible through the fog (the
  // player needs to track the inner-system bodies even when they're
  // not in sensor range, otherwise the map feels broken).
  oc.fillStyle = 'rgba(8, 12, 18, 0.62)';
  oc.fillRect(0, 0, w, h);

  // Pass 2: punch out every sensor circle. Opaque source so the wash
  // is fully erased — overlapping circles can't un-erase each other.
  oc.globalCompositeOperation = 'destination-out';
  oc.fillStyle = '#ffffff';
  for (const r of rings) {
    const cp = worldToCanvas(r.pos.x, r.pos.y, ctx);
    const radius = r.range * ctx.camera.scale;
    if (radius < 0.5) continue; // too small to matter at this zoom
    oc.beginPath();
    oc.arc(cp.x, cp.y, radius, 0, Math.PI * 2);
    oc.fill();
  }

  ctx.ctx.save();
  ctx.ctx.drawImage(fogOffscreen, 0, 0);
  ctx.ctx.restore();
}

/**
 * Colored ring around each body indicating the owning faction.
 * Unowned bodies get nothing. Sits just outside the body's render
 * radius so it reads as a halo without obscuring the planet itself.
 */
export function drawOwnershipLayer(
  bodies: Body[],
  ctx: RenderContext,
) {
  if (!ctx.factions || ctx.factions.length === 0) return;
  for (const body of bodies) {
    if (!body.ownedBy) continue;
    const faction = ctx.factions.find(f => f.id === body.ownedBy);
    const color = faction?.color || COLORS.neutral;
    const wp = bodyPosition(body, ctx.t, ctx.bodies);
    const cp = worldToCanvas(wp.x, wp.y, ctx);
    const r = Math.max(10, body.radius * ctx.camera.scale + 6);
    ctx.ctx.save();
    ctx.ctx.strokeStyle = withOpacity(color, 0.75);
    ctx.ctx.lineWidth = 1.5;
    ctx.ctx.setLineDash([4, 2]);
    ctx.ctx.beginPath();
    ctx.ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
    ctx.ctx.stroke();
    ctx.ctx.setLineDash([]);
    ctx.ctx.restore();
  }
}



// ============================================================
// Asteroid belt cosmetic dust — small grey specks scattered in
// the belt annulus around the player's home star, generated once
// at module load and rendered every frame as world-space points.
// Pure visual flair, no gameplay impact. The angle distribution
// is uniformly random; the radius is pulled toward 310 (the belt
// canon radius) by a Gaussian-ish bias so the dust thickens at
// the ring instead of forming a uniform donut.
// ============================================================

interface BeltDustParticle {
  r: number;       // orbital radius from Sol
  angle: number;   // radians at t=0
  shade: number;   // 0-1 brightness modulation
  size: number;    // canvas-px floor for the dust dot
  driftMul: number; // angular drift speed multiplier
}

const BELT_DUST_COUNT = 220;
const BELT_CENTER_R = 310;
const BELT_HALF_WIDTH = 55;

function generateBeltDust(): BeltDustParticle[] {
  // Deterministic LCG so the belt pattern is consistent run-to-run.
  let seed = 0x9e3779b1 >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xFFFFFFFF;
  };
  const out: BeltDustParticle[] = [];
  for (let i = 0; i < BELT_DUST_COUNT; i++) {
    // Sum of two uniforms approximates a triangular peak at 0,
    // pulling radius toward BELT_CENTER_R.
    const bias = (rand() + rand()) / 2 - 0.5;
    out.push({
      r: BELT_CENTER_R + bias * 2 * BELT_HALF_WIDTH,
      angle: rand() * Math.PI * 2,
      shade: 0.35 + rand() * 0.5,
      size: 0.8 + rand() * 0.9,
      driftMul: 0.85 + rand() * 0.3,
    });
  }
  return out;
}

const BELT_DUST: BeltDustParticle[] = generateBeltDust();

/**
 * Render the belt-dust pass. Sun is assumed at the world origin
 * (default for the Sol system); rendering the specks any further
 * out than the belt would be wasted draw calls in the hot path.
 *
 * Each speck drifts slowly along its orbit. The drift uses the
 * same period reference as the named belt dwarfs (443 ticks) so
 * the dust appears to move with the rest of the belt instead of
 * looking pinned to a backdrop.
 */
export function drawAsteroidBeltDust(ctx: RenderContext) {
  // Skip when zoomed so far out the belt would be sub-pixel
  // anyway — saves a few hundred draw calls per frame on the
  // wide overview.
  if (ctx.camera.scale < 0.0015) return;
  const driftAngle = (ctx.t / 443) * Math.PI * 2;
  for (const p of BELT_DUST) {
    const a = p.angle + driftAngle * p.driftMul;
    const wx = Math.cos(a) * p.r;
    const wy = Math.sin(a) * p.r;
    const cp = worldToCanvas(wx, wy, ctx);
    // Clip cheaply: skip if off-canvas.
    if (cp.x < -4 || cp.y < -4 || cp.x > ctx.canvas.width + 4 || cp.y > ctx.canvas.height + 4) continue;
    const size = Math.max(0.6, p.size * Math.min(1.2, Math.sqrt(ctx.camera.scale) * 1.4));
    ctx.ctx.fillStyle = `rgba(168, 152, 136, ${0.18 * p.shade})`;
    ctx.ctx.beginPath();
    ctx.ctx.arc(cp.x, cp.y, size, 0, Math.PI * 2);
    ctx.ctx.fill();
  }
}
