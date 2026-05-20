// ============================================================
// Map Canvas Rendering - Draw the orbital system
// ============================================================

import { Body, Ship, OrbitElements, TrajectoryArc, Settlement, Faction, TorchTransferPlan } from '../types';
import { bodyPosition, localPositionAt, semiMajor, eccentricity, velocityVectorsAt } from '../physics/orbitalMechanics';
import { sampleTorchTrajectory } from '../physics/torchTransfer';
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

  const radius = body.orbitRadius * ctx.camera.scale;

  ctx.ctx.strokeStyle = color;
  ctx.ctx.lineWidth = width;
  ctx.ctx.beginPath();
  ctx.ctx.arc(
    canvasParentPos.x,
    canvasParentPos.y,
    radius,
    0,
    Math.PI * 2
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
  } else if (body.type === 'gas_giant') {
    drawGasGiantBody(body, canvasPos, radius, ctx);
  } else {
    drawPlanetBody(body, canvasPos, radius, ctx);
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

  // Draw label: always for Sol and direct children of Sol, otherwise at scale > 0.4
  const alwaysShowLabel = body.type === 'star' || body.parent === 'sol';
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

  const icon = getShipIconImage(ship.class as ShipIconClass, shipColorValue);
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

  const labels = ['Fuel', 'Gold', 'Metal', 'Sci'];
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
export function drawTorchTrajectory(
  plan: TorchTransferPlan,
  bodies: Body[],
  ctx: RenderContext,
  color: string = COLORS.arcTransfer,
  isDashed: boolean = false,
  splitPhaseColors: boolean = false,
) {
  const samples = sampleTorchTrajectory(
    plan,
    { pos: { x: plan.startPos.x, y: plan.startPos.y },
      vel: { x: plan.startVel.x, y: plan.startVel.y } },
    bodies,
    80,
  );
  if (samples.length < 2) return;

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
}

export function drawTransitShip(
  ship: Ship,
  ctx: RenderContext,
  isSelected: boolean = false
) {
  // Torch transit: read state-vector path directly.
  if (ship.transit) {
    drawTorchTransitShip(ship, ctx, isSelected);
  }
}

/**
 * Torch-mode equivalent of drawTransitShip. Reads ship.transit.pos for
 * the world position (no need to interpolate — the executor keeps it
 * fresh each tick), ship.transit.vel for the heading. Falls back to a
 * dot+tick line when no ship icon is available.
 */
function drawTorchTransitShip(
  ship: Ship,
  ctx: RenderContext,
  isSelected: boolean,
) {
  if (!ship.transit) return;
  const { pos, vel, currentTransfer } = ship.transit;
  const canvasPos = worldToCanvas(pos.x, pos.y, ctx);
  const shipColorValue = shipColor(ship, ctx.factions);

  // Heading from velocity; canvas y inverts so we flip the y component.
  const vMag = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
  const dirX = vMag > 1e-9 ? vel.x / vMag : 1;
  const dirY = vMag > 1e-9 ? vel.y / vMag : 0;
  const heading = Math.atan2(-dirY, dirX);

  const iconSize = isSelected ? 22 : 18;

  const flashStartT = ctx.damageFlashStart?.get(ship.id);
  drawDamageFlash(canvasPos, iconSize / 2, flashStartT, ctx.t, ctx, 'damage');

  const icon = getShipIconImage(ship.class as ShipIconClass, shipColorValue);
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
    ctx.ctx.strokeStyle = shipColorValue;
    ctx.ctx.lineWidth = 1.5;
    ctx.ctx.beginPath();
    ctx.ctx.moveTo(canvasPos.x, canvasPos.y);
    ctx.ctx.lineTo(canvasPos.x + dirX * 10, canvasPos.y - dirY * 10);
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
  const size = 4;

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

/**
 * Draw a clean sensor-coverage circle around an asset. One per ship /
 * city / station — the boundary the fog-of-war overlay also cuts out.
 *
 * Color codes by sourceType so the player can read "this is a station's
 * sensor reach (big cyan)" vs "this is a freighter's tiny green eye."
 * Stroke is solid + moderate opacity so the edge is visible against
 * both the dimmed fog AND the in-coverage bright canvas.
 */
export function drawSensorRing(
  worldPos: { x: number; y: number },
  range: number,
  sourceType: 'ship' | 'city' | 'station',
  ctx: RenderContext,
) {
  const canvasPos = worldToCanvas(worldPos.x, worldPos.y, ctx);
  const radius = range * ctx.camera.scale;
  if (radius < 6) return; // too small to bother — the asset's icon is its own marker

  const color = sourceType === 'station'
    ? COLORS.info
    : sourceType === 'city'
      ? COLORS.warning
      : COLORS.success;

  // Solid outline against the fog wash. A subtle filled wedge inside
  // would dim what's already bright, so we only stroke. Two-pass:
  // wider faded ring underneath for a "glow," sharp 1px on top.
  ctx.ctx.save();
  ctx.ctx.strokeStyle = withOpacity(color, 0.18);
  ctx.ctx.lineWidth = 3;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
  ctx.ctx.stroke();

  ctx.ctx.strokeStyle = withOpacity(color, 0.55);
  ctx.ctx.lineWidth = 1;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
  ctx.ctx.stroke();
  ctx.ctx.restore();
}

/**
 * Draw a SINGLE faint outline at the outer boundary of the union of
 * all sensor circles. Concentric per-source rings turn into spaghetti
 * the moment you have more than one ship at a body — the player only
 * cares about the outer edge of "what can I see," not which ship or
 * station is providing each slice of that coverage.
 *
 * Technique: render to an offscreen canvas. Fill every circle solid,
 * then `destination-out`-fill each with a slightly smaller radius. The
 * overlapping interiors get erased completely; only the union boundary
 * survives as a 1-px stroke-thick ring. Single composite onto the
 * main canvas.
 */
export function drawSensorUnionOutline(
  rings: Array<{ pos: { x: number; y: number }; range: number }>,
  ctx: RenderContext,
) {
  if (rings.length === 0) return;

  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const oc = off.getContext('2d');
  if (!oc) return;

  const color = withOpacity(COLORS.success, 0.45);
  const lineWidth = 1;

  // Pre-compute canvas-space circles. Skip any whose visible radius is
  // smaller than the line width — they wouldn't contribute a visible
  // ring anyway.
  type CS = { x: number; y: number; r: number };
  const circles: CS[] = [];
  for (const r of rings) {
    const cp = worldToCanvas(r.pos.x, r.pos.y, ctx);
    const radius = r.range * ctx.camera.scale;
    if (radius <= lineWidth) continue;
    circles.push({ x: cp.x, y: cp.y, r: radius });
  }
  if (circles.length === 0) return;

  // Pass 1: solid-fill every circle in the outline color.
  oc.fillStyle = color;
  oc.globalCompositeOperation = 'source-over';
  for (const c of circles) {
    oc.beginPath();
    oc.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    oc.fill();
  }
  // Pass 2: erase the inside of every circle, shrunk by lineWidth.
  // Boundaries between two overlapping circles cancel out — only the
  // outermost edge of the union survives as a thin ring.
  oc.globalCompositeOperation = 'destination-out';
  for (const c of circles) {
    oc.beginPath();
    oc.arc(c.x, c.y, c.r - lineWidth, 0, Math.PI * 2);
    oc.fill();
  }

  ctx.ctx.save();
  ctx.ctx.drawImage(off, 0, 0);
  ctx.ctx.restore();
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
    ctx.ctx.shadowBlur = targetOwned ? 6 : 0;
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
  for (const f of flashes) {
    const cp = worldToCanvas(f.pos.x, f.pos.y, ctx);
    drawDamageFlash(
      cp,
      f.baseRadius ?? 10,
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
 * semi-transparent layer over the entire canvas, then uses the
 * even-odd fill rule to "cut out" the union of sensor coverage
 * circles — so in-range areas render normally and everything else
 * fades to a grey wash that still lets planet motion through.
 *
 * Drawn LAST in the render order so it dims absolutely everything
 * (bodies, ships, orbits, other layer overlays). The single
 * even-odd fill is one path → one stroke regardless of how many
 * ship/settlement sensors you have. Much cheaper than per-source
 * compositing.
 */
export function drawFogOfWarOverlay(
  rings: Array<{ pos: { x: number; y: number }; range: number }>,
  ctx: RenderContext,
) {
  const c = ctx.ctx;
  c.save();
  c.beginPath();
  // Outer rectangle covers the whole canvas.
  c.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // Inner subpaths are the sensor circles, traced in the opposite
  // winding direction so the even-odd rule treats them as holes.
  for (const r of rings) {
    const cp = worldToCanvas(r.pos.x, r.pos.y, ctx);
    const radius = r.range * ctx.camera.scale;
    if (radius < 0.5) continue; // too small to matter at this zoom
    c.moveTo(cp.x + radius, cp.y);
    c.arc(cp.x, cp.y, radius, 0, Math.PI * 2);
  }
  // Dark warm-grey wash — keeps the canvas readable but obviously
  // out-of-coverage. Opacity is tuned so planet motion + orbits stay
  // visible (the player needs to track the inner-system bodies even
  // when they're not in sensor range, otherwise the map feels broken).
  c.fillStyle = 'rgba(8, 12, 18, 0.62)';
  c.fill('evenodd');
  c.restore();
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

