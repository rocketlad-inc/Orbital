import { canHostCity, buildingLevel } from '../game/settlements';
import { shipDisplayTick } from './tickPhase';
// ============================================================
// Map Canvas Rendering - Draw the orbital system
// ============================================================

import { Body, Ship, OrbitElements, TrajectoryArc, Settlement, Faction, TorchTransferPlan, BuildOrder, BuildingKind } from '../types';
import { getPlanetTexture, getCloudTexture, hashStr, mulberry32 } from './planetTexture';
import { drawCityCluster, drawStationStructure } from './isoStructures';
import type { SystemRegion } from './systemRegions';
import { bodyPosition, localPositionAt, semiMajor, eccentricity, velocityVectorsAt } from '../physics/orbitalMechanics';
import { sampleTorchTrajectory, torchPositionFromSamples } from '../physics/torchTransfer';
import { STRAIGHT_LINE_TRAJECTORIES } from '../game/featureFlags';
import { COLORS, withOpacity, lighten, darken } from './colors';
import { getShipIconImage } from './shipIconCache';
import { ShipIconClass } from '../components/ShipIcons';
import { deriveSecondary } from '../game/colorUtils';
import { getShipClass } from '../game/shipClasses';
// hashStr/mulberry32 come from planetTexture (above) — combatFx defined
// its own copies only because its branch predated planetTexture; the
// duplicates are removed there and it re-exports nothing seeded.
import { drawDeathDebris } from './combatFx';

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  camera: { x: number; y: number; scale: number; focusedBodyId?: string };
  /** Currently-selected body (uiState.selectedBodyId), threaded so the
   *  orbit-ring layer can fade rings unrelated to the selection.
   *  Falls back to camera.focusedBodyId when absent. */
  selectedBodyId?: string;
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
  /** Wall-clock ms (performance.now()) when each settlement's population
   *  was last observed increasing. Keyed by settlement id. Drives the
   *  soft green 'growth' pulse (§E4) — ms-based (600ms) because it's a
   *  pure-cosmetic celebration, not combat feedback. */
  growthFlashStart?: Map<string, number>;
  /** Wall-clock ms for the current frame — passed to drawDamageFlash
   *  so all flashes age consistently within one frame. */
  nowMs?: number;
  /** Ship the cursor is currently over, if any. Ship name labels are
   *  drawn ONLY for this ship or the selected one — a full fleet's
   *  worth of always-on labels buried the map in text (playtest:
   *  thirteen overlapping "Donnager-NN" tags around Saturn). Set from
   *  the MapCanvas mousemove hit-test; undefined on touch/lobby
   *  previews, where selection alone drives labels. */
  hoveredShipId?: string | null;
  /** Settlements in this game — the textured-planet path uses them for
   *  night-side city lights; the focus-zoom structure painters read
   *  building levels from them. Optional: only the main MapCanvas
   *  passes it, other callers (lobby preview) skip the extras. */
  settlements?: Settlement[];
  /** In-flight ship builds — lets the station shipyard scaffold show
   *  a hull under construction at focus zoom. Optional. */
  buildOrders?: BuildOrder[];
  /** Wall-clock ms when a settlement's building last leveled up,
   *  keyed `${settlementId}:${buildingKind}`. Drives the "just built"
   *  pop on that specific station module (isoStructures.drawBuildPop)
   *  — distinct from growthFlashStart, which is population-only and
   *  fires at the whole-settlement marker, not a specific module. */
  buildFlashStart?: Map<string, number>;
  /** WHERE each parked ship's sprite actually landed this frame, keyed
   *  by ship id — canvas centre + a hit radius that covers the sprite.
   *  drawShip writes it AFTER every offset (cosmetic orbit spin, tick
   *  interpolation, formation spread) so the click/hover hit-test can
   *  read the true drawn box instead of re-deriving it and drifting off
   *  the visible hull. Cleared each frame by MapCanvas. */
  shipHitboxes?: Map<string, { x: number; y: number; r: number }>;
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

/** Flash lifetimes — WALL-CLOCK ms across the board. These were
 *  tick-based ("10 ticks"), which reads fine in SP where ticks fly by
 *  but is catastrophic in MP: live games run 30s–1h per tick, so a
 *  "brief" destruction glow parked a giant red blob on the map for TEN
 *  HOURS (player report, 2026-07-18). A flash is pure cosmetics for the
 *  viewer — it should live on the viewer's clock, stamped the moment
 *  the client first observes the event. */
export const DAMAGE_FLASH_DURATION_MS = 900;
export const DESTRUCTION_FLASH_DURATION_MS = 1600;

/** Where in its lifecycle the flash is. Damage = small red ring,
 *  Destruction = bigger orange-white explosion ring. Both share the
 *  same fade curve. Growth = soft green expanding ring on a settlement
 *  population increase. All wall-clock. */
export type FlashKind = 'damage' | 'destruction' | 'growth';

/** Growth pulse lifetime — wall-clock, pure cosmetic (§E4). */
export const GROWTH_FLASH_DURATION_MS = 600;

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
  startMs: number | undefined,
  nowMs: number,
  ctx: RenderContext,
  kind: FlashKind = 'damage',
  durationMs?: number,
) {
  if (startMs === undefined) return;
  const dur = durationMs ?? (kind === 'destruction'
    ? DESTRUCTION_FLASH_DURATION_MS
    : kind === 'growth'
      ? GROWTH_FLASH_DURATION_MS
      : DAMAGE_FLASH_DURATION_MS);
  const age = nowMs - startMs;
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

  if (kind === 'growth') {
    // Population growth (§E4): a soft green ring expanding outward,
    // additive so it glows over the settlement without muddying it.
    const ringR = baseRadius * (1.2 + (1 - linear) * 2.4);
    ctx.ctx.save();
    ctx.ctx.globalCompositeOperation = 'lighter';
    const grad = ctx.ctx.createRadialGradient(
      canvasPos.x, canvasPos.y, baseRadius * 0.3,
      canvasPos.x, canvasPos.y, ringR,
    );
    grad.addColorStop(0, `rgba(110, 231, 183, ${0.20 * freshness})`);
    grad.addColorStop(1, 'rgba(110, 231, 183, 0)');
    ctx.ctx.fillStyle = grad;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, ringR, 0, Math.PI * 2);
    ctx.ctx.fill();
    ctx.ctx.strokeStyle = `rgba(110, 231, 183, ${0.65 * freshness})`;
    ctx.ctx.lineWidth = 1.5;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, ringR, 0, Math.PI * 2);
    ctx.ctx.stroke();
    ctx.ctx.restore();
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

// (Former back-compat wall-clock alias removed — the flash system is
// now wall-clock across the board; the canonical DAMAGE_FLASH_DURATION_MS
// lives with the other flash lifetimes at the top of the file.)

/**
 * Corner-bracket selection indicator (§E6) — replaces the dashed
 * selection circles on bodies, ships, and settlements. Four L-shaped
 * brackets sit at the corners of a square circumscribing a circle of
 * radius `r`, and the whole set rotates slowly (0.15 rad/s, wall-clock
 * — pure cosmetic). Arm length ~r*0.45. One path, one stroke.
 */
export function drawSelectionBrackets(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  nowMs?: number,
) {
  const t = nowMs ?? (typeof performance !== 'undefined' ? performance.now() : 0);
  const rot = (t / 1000) * 0.15;
  // Square whose corners sit ON the circle of radius r, so the bracket
  // footprint matches the old dashed circle's radius exactly.
  const h = r * Math.SQRT1_2;
  const arm = Math.min(r * 0.45, h * 0.9);
  c.save();
  c.translate(x, y);
  c.rotate(rot);
  c.strokeStyle = color;
  c.lineWidth = 1.5;
  c.beginPath();
  // Each bracket is an L hugging one corner of the square [-h, h]^2.
  // sx/sy pick the corner; arms run back along both edges.
  for (let i = 0; i < 4; i++) {
    const sx = i & 1 ? -1 : 1;
    const sy = i & 2 ? -1 : 1;
    c.moveTo(sx * (h - arm), sy * h);
    c.lineTo(sx * h, sy * h);
    c.lineTo(sx * h, sy * (h - arm));
  }
  c.stroke();
  c.restore();
}

// ============================================================
// Starfield — procedural backdrop, cached to offscreen canvas
// ============================================================

export interface StarfieldCache {
  /** Distant layer — dim stars + nebula blobs, slowest parallax. */
  far: HTMLCanvasElement;
  /** Close layer — slightly larger/brighter stars, faster parallax. */
  near: HTMLCanvasElement;
  width: number;
  height: number;
}

/**
 * Generate a two-layer parallax starfield onto offscreen canvases.
 * FAR gets ~60% of the stars (plus the faint nebula tint blobs) and
 * translates at 0.2× camera; NEAR gets ~40%, drawn slightly larger
 * and brighter, at 0.5× camera. Both are painted exactly once.
 */
export function generateStarfield(width: number, height: number): StarfieldCache {
  const far = document.createElement('canvas');
  far.width = width;
  far.height = height;
  const near = document.createElement('canvas');
  near.width = width;
  near.height = height;
  const fc = far.getContext('2d');
  const nc = near.getContext('2d');
  if (!fc || !nc) return { far, near, width, height };

  // Nebula tinting (3 large faint blobs) — far layer only, they read
  // as the most distant thing in the scene.
  const nebulaHues = [
    'rgba(80, 60, 130, 0.05)',  // purple
    'rgba(60, 90, 150, 0.05)',  // blue
    'rgba(140, 80, 90, 0.04)',  // dust red
  ];
  for (let i = 0; i < nebulaHues.length; i++) {
    const cx = Math.random() * width;
    const cy = Math.random() * height;
    const r = 180 + Math.random() * 280;
    const g = fc.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, nebulaHues[i]);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    fc.fillStyle = g;
    fc.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  // Stars — same overall density as the old single layer, split 60/40.
  const starCount = Math.floor((width * height) / 700);
  const farCount = Math.floor(starCount * 0.6);

  /** boost > 1 = near layer: bigger dots, higher floor alpha. */
  const paintStars = (ctx: CanvasRenderingContext2D, count: number, boost: number) => {
    for (let i = 0; i < count; i++) {
      const x = Math.random() * width;
      const y = Math.random() * height;
      const r = Math.random();

      if (r > 0.985) {
        // Rare bright star with halo
        const haloR = 4.5 * boost;
        const halo = ctx.createRadialGradient(x, y, 0, x, y, haloR);
        halo.addColorStop(0, 'rgba(255, 240, 200, 0.45)');
        halo.addColorStop(1, 'rgba(255, 240, 200, 0)');
        ctx.fillStyle = halo;
        ctx.fillRect(x - haloR, y - haloR, haloR * 2, haloR * 2);

        ctx.fillStyle = 'rgba(255, 248, 220, 0.95)';
        ctx.beginPath();
        ctx.arc(x, y, 1.4 * boost, 0, Math.PI * 2);
        ctx.fill();
      } else if (r > 0.93) {
        ctx.fillStyle = `rgba(220, 230, 255, ${Math.min(1, (0.7 + Math.random() * 0.3) * boost)})`;
        ctx.beginPath();
        ctx.arc(x, y, boost, 0, Math.PI * 2);
        ctx.fill();
      } else if (r > 0.70) {
        ctx.fillStyle = `rgba(200, 210, 225, ${Math.min(1, (0.4 + Math.random() * 0.3) * boost)})`;
        ctx.fillRect(x, y, 0.8 * boost, 0.8 * boost);
      } else {
        ctx.fillStyle = `rgba(170, 180, 200, ${Math.min(1, (0.18 + Math.random() * 0.22) * boost)})`;
        ctx.fillRect(x, y, 0.6 * boost, 0.6 * boost);
      }
    }
  };

  paintStars(fc, farCount, 1);
  paintStars(nc, starCount - farCount, 1.35);

  return { far, near, width, height };
}

// ------------------------------------------------------------
// System nebulae — one big soft radial wash anchored on each far
// system so Centauri reads warm-amber and Cygnus X reads violet
// from across the map (Sol gets none). The GRADIENT is painted
// once into a small cached canvas; each frame only re-projects
// its world-space rect through worldToCanvas.
// ------------------------------------------------------------

const NEBULA_TEX_SIZE = 256;
/** World-space radius of the wash. */
const NEBULA_WORLD_R = 30000;
const NEBULA_ALPHA = 0.08;

interface NebulaSpec {
  /** Template id of the system's anchor body (barycenter). */
  anchorId: string;
  color: string;
}

const NEBULA_SPECS: NebulaSpec[] = [
  { anchorId: 'binary_barycenter', color: '#ffb36b' }, // Centauri — warm amber
  { anchorId: 'bh_barycenter', color: '#b287ff' },     // Cygnus X — violet
];

const nebulaTexCache = new Map<string, HTMLCanvasElement | null>();

function getNebulaTexture(color: string): HTMLCanvasElement | null {
  const hit = nebulaTexCache.get(color);
  if (hit !== undefined) return hit;
  if (typeof document === 'undefined') {
    nebulaTexCache.set(color, null);
    return null;
  }
  const off = document.createElement('canvas');
  off.width = NEBULA_TEX_SIZE;
  off.height = NEBULA_TEX_SIZE;
  const c = off.getContext('2d');
  if (!c) {
    nebulaTexCache.set(color, null);
    return null;
  }
  const half = NEBULA_TEX_SIZE / 2;
  const g = c.createRadialGradient(half, half, 0, half, half, half);
  g.addColorStop(0, withOpacity(color, 1));
  g.addColorStop(0.45, withOpacity(color, 0.45));
  g.addColorStop(1, withOpacity(color, 0));
  c.fillStyle = g;
  c.fillRect(0, 0, NEBULA_TEX_SIZE, NEBULA_TEX_SIZE);
  nebulaTexCache.set(color, off);
  return off;
}

/** Does this body id match a template id, tolerating MP gameId prefixes
 *  (`<gameId>:saturn` style)? */
function idMatchesTemplate(id: string, template: string): boolean {
  return id === template || id.endsWith(':' + template);
}

function drawSystemNebulae(ctx: RenderContext) {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  for (const spec of NEBULA_SPECS) {
    const anchor = ctx.bodies.find(b => idMatchesTemplate(b.id, spec.anchorId));
    if (!anchor) continue;
    const tex = getNebulaTexture(spec.color);
    if (!tex) continue;
    const wp = bodyPosition(anchor, ctx.t, ctx.bodies);
    const cp = worldToCanvas(wp.x, wp.y, ctx);
    const R = NEBULA_WORLD_R * ctx.camera.scale;
    // Clip the destination rect to the viewport and map the visible
    // slice back into texture space (9-arg drawImage) — avoids asking
    // the canvas to rasterize a multi-hundred-thousand-px dest rect
    // when zoomed all the way in near a far system.
    const dx0 = Math.max(0, cp.x - R);
    const dy0 = Math.max(0, cp.y - R);
    const dx1 = Math.min(cw, cp.x + R);
    const dy1 = Math.min(ch, cp.y + R);
    if (dx1 <= dx0 || dy1 <= dy0) continue; // fully off-screen
    const scale = NEBULA_TEX_SIZE / (R * 2);
    const sx = (dx0 - (cp.x - R)) * scale;
    const sy = (dy0 - (cp.y - R)) * scale;
    ctx.ctx.save();
    ctx.ctx.globalAlpha = NEBULA_ALPHA;
    ctx.ctx.drawImage(
      tex,
      sx, sy, (dx1 - dx0) * scale, (dy1 - dy0) * scale,
      dx0, dy0, dx1 - dx0, dy1 - dy0,
    );
    ctx.ctx.restore();
  }
}

/**
 * Draw the cached starfield in two parallax layers — far stars shift
 * at 0.2× camera translation, near stars at 0.5×, giving real depth
 * when panning without recomputation. System nebula washes go first
 * (they're "behind" everything).
 */
export function drawStarfield(cache: StarfieldCache | null, ctx: RenderContext) {
  if (!cache) return;

  drawSystemNebulae(ctx);

  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;

  const tile = (layer: HTMLCanvasElement, parallax: number) => {
    // Parallax offset — fraction of camera position, wrapped so the
    // field tiles seamlessly.
    let ox = (-ctx.camera.x * parallax) % cache.width;
    let oy = (-ctx.camera.y * parallax) % cache.height;
    if (ox > 0) ox -= cache.width;
    if (oy > 0) oy -= cache.height;
    for (let x = ox; x < cw; x += cache.width) {
      for (let y = oy; y < ch; y += cache.height) {
        ctx.ctx.drawImage(layer, x, y);
      }
    }
  };

  tile(cache.far, 0.2);
  tile(cache.near, 0.5);
}

/**
 * Draw orbital path for a body
 */
// ------------------------------------------------------------
// Orbit trail gradient (reference: Terra-Invicta-style comet tail).
// The ring is brightest AT the body and fades around the circumference
// behind it — a conic gradient anchored on the parent, rotated to the
// body's current orbital angle. Bodies advance in +θ (angle0 + t·2π/T),
// so conic-parameter u ∈ [0,1] sits u ahead of the body ≡ (1−u) behind;
// alpha therefore ramps min→max across the sweep, wrapping to a crisp
// leading edge exactly at the planet.
// Gated to rings ≥ 30px screen radius: below that the tail is unreadable
// and the per-frame gradient object is pure waste. Feature-detected —
// browsers without createConicGradient keep the flat stroke.
// ------------------------------------------------------------

const ORBIT_TRAIL_MIN_ALPHA = 0.05;
const ORBIT_TRAIL_MAX_ALPHA = 0.95;
const ORBIT_TRAIL_MIN_PX = 30;

function orbitTrailGradient(
  ctx: RenderContext,
  body: Body,
  parentWorldPos: { x: number; y: number },
  canvasParentPos: { x: number; y: number },
  color: string,
): CanvasGradient | null {
  const c2d = ctx.ctx as CanvasRenderingContext2D & {
    createConicGradient?: (startAngle: number, x: number, y: number) => CanvasGradient;
  };
  if (typeof c2d.createConicGradient !== 'function') return null;
  const bp = bodyPosition(body, ctx.t, ctx.bodies);
  const theta = Math.atan2(bp.y - parentWorldPos.y, bp.x - parentWorldPos.x);
  // Defense in depth: addColorStop THROWS on any invalid color string,
  // and an exception here aborts the whole render frame (this is what
  // blanked the map on 2026-07-18 — MapCanvas passes rgba() orbit
  // colors, and the pre-idempotent withOpacity NaN'd them). withOpacity
  // is fixed, but a cosmetic gradient must NEVER be able to kill the
  // scene, whatever a future caller feeds it.
  try {
    const g = c2d.createConicGradient(theta, canvasParentPos.x, canvasParentPos.y);
    g.addColorStop(0, withOpacity(color, ORBIT_TRAIL_MIN_ALPHA));
    g.addColorStop(1, withOpacity(color, ORBIT_TRAIL_MAX_ALPHA));
    return g;
  } catch {
    return null; // fall back to the flat stroke
  }
}

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

  // === Orbit relevance fading =================================
  // Moon orbits (parent is itself an orbiting body, not the star)
  // vanish entirely once the parent planet is too small on screen
  // to read as a system of its own — a sub-12px planet with moon
  // rings around it is just scribble.
  if (parentBody.type !== 'star' && parentBody.radius * ctx.camera.scale < 12) {
    return;
  }
  // The selected (or camera-focused) body's orbit and its siblings
  // (same parent) stay at full strength; every other ring drops to
  // 30% so the player's attention neighborhood pops. No selection →
  // no fading. Multiplies into the caller's globalAlpha so this
  // works whatever color/alpha convention the callsite uses.
  let relevanceAlpha = 1;
  const refId = ctx.selectedBodyId ?? ctx.camera.focusedBodyId;
  if (refId && refId !== body.id) {
    const refBody = ctx.bodies.find(b => b.id === refId);
    if (refBody && refBody.parent !== body.parent) {
      relevanceAlpha = 0.3;
    }
  }
  const prevOrbitAlpha = ctx.ctx.globalAlpha;
  ctx.ctx.globalAlpha = prevOrbitAlpha * relevanceAlpha;

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
    // Comet-tail gradient — anchored on the FOCUS (parent), not the
    // ellipse center; the angular fade tracks the body correctly there.
    if (a * ctx.camera.scale >= ORBIT_TRAIL_MIN_PX) {
      const g = orbitTrailGradient(ctx, body, parentPos, canvasParentPos, color);
      if (g) ctx.ctx.strokeStyle = g;
    }
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
    ctx.ctx.globalAlpha = prevOrbitAlpha;
    return;
  }

  // Circular shortcut for normal bodies.
  const radius = body.orbitRadius * ctx.camera.scale;
  if (radius >= ORBIT_TRAIL_MIN_PX) {
    const g = orbitTrailGradient(ctx, body, parentPos, canvasParentPos, color);
    if (g) ctx.ctx.strokeStyle = g;
  }
  ctx.ctx.beginPath();
  ctx.ctx.arc(
    canvasParentPos.x,
    canvasParentPos.y,
    radius,
    0,
    Math.PI * 2,
  );
  ctx.ctx.stroke();
  ctx.ctx.globalAlpha = prevOrbitAlpha;
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

// ------------------------------------------------------------
// Corona shimmer — two cached gradient layers with slight angular
// lobing, counter-rotated at different slow rates and composited
// additively so the sun's glow visibly breathes. Painted once per
// radius bucket (power-of-two canvas size), then every frame is
// two rotated drawImages.
// ------------------------------------------------------------

const coronaCache = new Map<number, [HTMLCanvasElement, HTMLCanvasElement] | null>();
const CORONA_CACHE_CAP = 6;

function paintCoronaLayer(
  size: number,
  lobes: number,
  baseAlpha: number,
  lobeColor: string,
): HTMLCanvasElement {
  const off = document.createElement('canvas');
  off.width = size;
  off.height = size;
  const c = off.getContext('2d');
  if (!c) return off;
  const half = size / 2;
  // Radial base — replaces the old static outer/mid glow (each layer
  // carries ~half the old alpha; the two sum additively).
  const base = c.createRadialGradient(half, half, half * 0.28, half, half, half * 0.85);
  base.addColorStop(0, `rgba(255, 209, 128, ${baseAlpha})`);
  base.addColorStop(0.45, `rgba(255, 170, 70, ${baseAlpha * 0.3})`);
  base.addColorStop(1, 'rgba(255, 154, 60, 0)');
  c.fillStyle = base;
  c.beginPath();
  c.arc(half, half, half * 0.85, 0, Math.PI * 2);
  c.fill();
  // Angular lobes — soft blobs ringing the core so rotation is
  // actually visible (a pure radial gradient is rotation-invariant).
  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2;
    const lx = half + Math.cos(a) * half * 0.42;
    const ly = half + Math.sin(a) * half * 0.42;
    const lr = half * 0.3;
    const g = c.createRadialGradient(lx, ly, 0, lx, ly, lr);
    g.addColorStop(0, lobeColor);
    g.addColorStop(1, 'rgba(255, 180, 90, 0)');
    c.fillStyle = g;
    c.fillRect(lx - lr, ly - lr, lr * 2, lr * 2);
  }
  return off;
}

function getCoronaLayers(coreR: number): [HTMLCanvasElement, HTMLCanvasElement] | null {
  // Bucket to power-of-two canvas sizes (~4× core radius) so zoom
  // changes only repaint on bucket crossings, not every frame.
  let size = 64;
  while (size < coreR * 4 && size < 2048) size *= 2;
  const hit = coronaCache.get(size);
  if (hit !== undefined) {
    coronaCache.delete(size);
    coronaCache.set(size, hit);
    return hit;
  }
  if (typeof document === 'undefined') return null;
  const layers: [HTMLCanvasElement, HTMLCanvasElement] = [
    paintCoronaLayer(size, 6, 0.13, 'rgba(255, 200, 110, 0.10)'),
    paintCoronaLayer(size, 5, 0.11, 'rgba(255, 165, 75, 0.09)'),
  ];
  coronaCache.set(size, layers);
  if (coronaCache.size > CORONA_CACHE_CAP) {
    const oldest = coronaCache.keys().next().value;
    if (oldest !== undefined) coronaCache.delete(oldest);
  }
  return layers;
}

/** Sun: shimmering two-layer corona, hot core. */
function drawStarBody(
  body: Body,
  canvasPos: { x: number; y: number },
  radius: number,
  ctx: RenderContext,
) {
  // Sol's physical radius (10) is huge vs planets (2-3), and things
  // orbit it tightly: ships at body.radius + 4 = 14, stations at
  // body.radius + 3 = 13. At full size the sun's disk + corona swallowed
  // them. The fix draws the ENTIRE sun (core + all corona) at coreR =
  // 0.55× its physical radius, so the whole footprint ends at
  // ~0.55×1.7 = 0.94× the physical radius (≈ 9.4 for Sol) — comfortably
  // INSIDE the 13-unit station orbit. That gives an orbiting station the
  // same clear black-space gap it has around a small planet, instead of
  // sitting embedded in the glow. Zoom-invariant.
  const coreR = radius * 0.55;

  // Shimmering corona — two cached gradient layers counter-rotating
  // at slightly different slow rates, composited additively. The
  // layers' painted extent (0.85 × half-size ≈ 1.7 × coreR) matches
  // the old static glow's outer edge, so stations orbiting at
  // body.radius + 3 keep their clear black-space gap.
  const layers = getCoronaLayers(coreR);
  if (layers) {
    const s = coreR * 4;
    const c = ctx.ctx;
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.translate(canvasPos.x, canvasPos.y);
    c.rotate(ctx.t * 0.001);
    c.drawImage(layers[0], -s / 2, -s / 2, s, s);
    c.rotate(-ctx.t * 0.001 + ctx.t * -0.0016);
    c.drawImage(layers[1], -s / 2, -s / 2, s, s);
    c.restore();
  }

  // Hot core
  const core = ctx.ctx.createRadialGradient(canvasPos.x, canvasPos.y, 0, canvasPos.x, canvasPos.y, coreR);
  core.addColorStop(0, '#fff8e0');
  core.addColorStop(0.55, '#ffd180');
  core.addColorStop(1, body.color || '#ffa940');
  ctx.ctx.fillStyle = core;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, coreR, 0, Math.PI * 2);
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

// ------------------------------------------------------------
// Atmosphere rim-light — thin additive arc hugging the sun-facing
// limb of textured bodies. Sign note: lightDirToBody returns the
// unit vector pointing AWAY from the sun (drawDayNightShading puts
// its dark stops at +ld), so the LIT limb sits at −ld.
// ------------------------------------------------------------

function rimLightFor(body: Body): { color: string; alpha: number } {
  if (idMatchesTemplate(body.id, 'mars')) return { color: '#ffb08a', alpha: 0.8 };
  if (body.type === 'terrestrial') return { color: '#9fd4ff', alpha: 0.8 };
  if (body.type === 'gas_giant') return { color: '#ffe9c4', alpha: 0.8 };
  if (body.type === 'ice_giant') return { color: '#bfe6ff', alpha: 0.8 };
  // dwarf / moon / asteroid — airless grey glint, dimmer
  return { color: '#cfd8e0', alpha: 0.45 };
}

function drawAtmosphereRimLight(
  body: Body,
  canvasPos: { x: number; y: number },
  radius: number,
  ctx: RenderContext,
) {
  const ld = lightDirToBody(canvasPos, ctx);
  const litAngle = Math.atan2(-ld.y, -ld.x); // opposite ld = sun-facing limb
  const a0 = litAngle - Math.PI / 4;         // 90° sweep centered on lit limb
  const a1 = litAngle + Math.PI / 4;
  const { color, alpha } = rimLightFor(body);
  // Linear gradient along the chord between the arc endpoints —
  // bright at the sweep center, fading to nothing at both ends.
  const g = ctx.ctx.createLinearGradient(
    canvasPos.x + Math.cos(a0) * radius, canvasPos.y + Math.sin(a0) * radius,
    canvasPos.x + Math.cos(a1) * radius, canvasPos.y + Math.sin(a1) * radius,
  );
  g.addColorStop(0, withOpacity(color, 0));
  g.addColorStop(0.5, withOpacity(color, alpha));
  g.addColorStop(1, withOpacity(color, 0));
  ctx.ctx.save();
  ctx.ctx.globalCompositeOperation = 'lighter';
  ctx.ctx.strokeStyle = g;
  ctx.ctx.lineWidth = 2;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, a0, a1);
  ctx.ctx.stroke();
  ctx.ctx.restore();
}

// ------------------------------------------------------------
// Occluded planetary rings (Saturn / Uranus templates). The ring
// ellipse is split at the planet's horizon: the top half (ellipse
// param π..2π, screen-up) draws BEHIND the disk, then the planet,
// then the bottom half in FRONT. A soft dark segment marks where
// the ring crosses the night side.
// ------------------------------------------------------------

const RING_TILT = 0.35;      // ~20°
const RING_RX = 1.9;         // × body radius
const RING_RY = 0.55;

function bodyHasRings(body: Body): boolean {
  return idMatchesTemplate(body.id, 'saturn') || idMatchesTemplate(body.id, 'uranus');
}

function drawRingArcs(
  body: Body,
  canvasPos: { x: number; y: number },
  radius: number,
  ctx: RenderContext,
  half: 'back' | 'front',
) {
  const c = ctx.ctx;
  const color = body.color || COLORS.gasGiant;
  const start = half === 'back' ? Math.PI : 0;
  const end = half === 'back' ? Math.PI * 2 : Math.PI;

  c.save();
  // Main band
  c.strokeStyle = withOpacity(lighten(color, 1.15), half === 'back' ? 0.45 : 0.6);
  c.lineWidth = Math.max(1.5, radius * 0.1);
  c.beginPath();
  c.ellipse(canvasPos.x, canvasPos.y, radius * RING_RX, radius * RING_RY, RING_TILT, start, end);
  c.stroke();
  // Inner detail line
  c.strokeStyle = withOpacity(color, 0.32);
  c.lineWidth = Math.max(0.5, radius * 0.04);
  c.beginPath();
  c.ellipse(canvasPos.x, canvasPos.y, radius * 1.55, radius * 0.45, RING_TILT, start, end);
  c.stroke();

  if (half === 'front') {
    // Night-side shadow — darken the ring segment nearest the night
    // limb. Find the ellipse parameter that points along the away-
    // from-sun direction, then stroke a soft dark arc around it. The
    // planet disk is clipped OUT so the shadow never dirties the
    // planet face (the front ring crossing the disk sits over the
    // near-black night side anyway).
    const ld = lightDirToBody(canvasPos, ctx);
    const thetaN = Math.atan2(ld.y, ld.x) - RING_TILT; // night dir, ring frame
    const phi = Math.atan2(RING_RX * Math.sin(thetaN), RING_RY * Math.cos(thetaN));
    c.beginPath();
    c.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
    c.arc(canvasPos.x, canvasPos.y, radius * 1.02, 0, Math.PI * 2);
    c.clip('evenodd');
    c.strokeStyle = 'rgba(2, 6, 12, 0.28)';
    c.lineWidth = Math.max(3, radius * 0.16);
    c.beginPath();
    c.ellipse(canvasPos.x, canvasPos.y, radius * RING_RX, radius * RING_RY, RING_TILT, phi - 0.8, phi + 0.8);
    c.stroke();
    c.strokeStyle = 'rgba(2, 6, 12, 0.4)';
    c.lineWidth = Math.max(1.5, radius * 0.1);
    c.beginPath();
    c.ellipse(canvasPos.x, canvasPos.y, radius * RING_RX, radius * RING_RY, RING_TILT, phi - 0.5, phi + 0.5);
    c.stroke();
  }
  c.restore();
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

  // Textured-sphere path — big enough for surface detail to read.
  // One cached drawImage + a crisp sun-relative terminator, then warm
  // city lights on the night side of settled worlds. Falls through to
  // the legacy flat-disk path when small or texture unavailable.
  if (radius > 8) {
    const tex = getPlanetTexture(body);
    if (tex) {
      const ringed = bodyHasRings(body); // uranus routes through here (ice giant)
      if (ringed) drawRingArcs(body, canvasPos, radius, ctx, 'back');
      drawTexturedDisk(ctx.ctx, tex, canvasPos.x, canvasPos.y, radius, 0);
      // Drifting cloud deck on terrestrials — separate cached layer,
      // scrolled slowly (0.3× the gas-giant band rate), drawn BEFORE
      // the terminator so the night side darkens clouds too.
      if (body.type === 'terrestrial') {
        const clouds = getCloudTexture(body);
        if (clouds) {
          const drift = ctx.t * radius * 0.0006;
          ctx.ctx.save();
          ctx.ctx.globalAlpha = 0.45;
          drawTexturedDisk(ctx.ctx, clouds, canvasPos.x, canvasPos.y, radius, drift);
          ctx.ctx.restore();
        }
      }
      drawDayNightShading(canvasPos, radius, ctx);
      drawNightLights(body, canvasPos, radius, ctx);
      drawAtmosphereRimLight(body, canvasPos, radius, ctx);
      if (ringed) drawRingArcs(body, canvasPos, radius, ctx, 'front');
      return;
    }
  }

  // Base disk
  ctx.ctx.fillStyle = color;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
  ctx.ctx.fill();

  // Per-body surface features (continents, ice caps). Drawn before
  // sphere shading so the shading's edge-darkening + highlight unify
  // the features into the sphere instead of sitting flat on top.
  // Only worth rendering when the disk is large enough to read.
  if (radius > 5) {
    drawSurfaceFeatures(body, canvasPos, radius, ctx);
  }

  // Sphere shading (only when big enough to see)
  if (radius > 3.5) {
    drawSphereShading(canvasPos, radius, ctx);
  }
}

/**
 * Draw a cached texture into the planet disk, optionally scrolled
 * horizontally with wraparound (gas-giant band drift). `drift` is in
 * canvas px; 0 = static.
 */
function drawTexturedDisk(
  c: CanvasRenderingContext2D,
  tex: HTMLCanvasElement,
  x: number, y: number, r: number,
  drift: number,
) {
  c.save();
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.clip();
  const d = r * 2;
  if (drift > 0.5) {
    const off = drift % d;
    c.drawImage(tex, x - r + off - d, y - r, d, d);
    c.drawImage(tex, x - r + off, y - r, d, d);
  } else {
    c.drawImage(tex, x - r, y - r, d, d);
  }
  c.restore();
}

/**
 * Crisp day/night terminator + a soft sun-side highlight. Replaces the
 * blobby drawSphereShading at textured sizes. The gradient runs along
 * the light direction, so the night side visibly swings around the
 * planet as it orbits the sun.
 */
function drawDayNightShading(
  canvasPos: { x: number; y: number },
  radius: number,
  ctx: RenderContext,
) {
  const ld = lightDirToBody(canvasPos, ctx); // unit vector away from sun
  const g = ctx.ctx.createLinearGradient(
    canvasPos.x - ld.x * radius, canvasPos.y - ld.y * radius,
    canvasPos.x + ld.x * radius, canvasPos.y + ld.y * radius,
  );
  g.addColorStop(0, 'rgba(2, 6, 12, 0)');
  g.addColorStop(0.5, 'rgba(2, 6, 12, 0)');
  g.addColorStop(0.62, 'rgba(2, 6, 12, 0.55)');
  g.addColorStop(0.8, 'rgba(2, 6, 12, 0.9)');
  g.addColorStop(1, 'rgba(2, 6, 12, 0.94)');
  ctx.ctx.fillStyle = g;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
  ctx.ctx.fill();

  // Sun-side specular kiss so the day side still reads spherical.
  const hx = canvasPos.x - ld.x * radius * 0.45;
  const hy = canvasPos.y - ld.y * radius * 0.45;
  const hl = ctx.ctx.createRadialGradient(hx, hy, 0, hx, hy, radius * 0.9);
  hl.addColorStop(0, 'rgba(255, 255, 255, 0.18)');
  hl.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.ctx.fillStyle = hl;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
  ctx.ctx.fill();
}

/**
 * Warm window-light scatter on the night side of settled worlds.
 * Drawn AFTER the terminator so the lights punch through the dark.
 * Seeded per settlement id — the same city always twinkles in the
 * same spots. Pure flavor; nothing sells "inhabited" harder.
 */
function drawNightLights(
  body: Body,
  canvasPos: { x: number; y: number },
  radius: number,
  ctx: RenderContext,
) {
  const settlements = ctx.settlements;
  if (!settlements || settlements.length === 0) return;
  const ld = lightDirToBody(canvasPos, ctx);
  let clipped = false;
  for (const s of settlements) {
    if (s.bodyId !== body.id || s.type !== 'city') continue;
    const a = s.surfaceAngle ?? 0;
    // Only glow when the city sits on the night side (dir · ld > 0
    // means the surface point faces away from the sun).
    if (Math.cos(a) * ld.x + Math.sin(a) * ld.y < 0.15) continue;
    if (!clipped) {
      ctx.ctx.save();
      ctx.ctx.beginPath();
      ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
      ctx.ctx.clip();
      clipped = true;
    }
    const rand = mulberry32(hashStr(s.id));
    const n = 4 + Math.min(6, s.population);
    const nowM = ctx.nowMs ?? performance.now();
    for (let i = 0; i < n; i++) {
      const rr = radius * (0.68 + rand() * 0.26);
      const ja = a + (rand() - 0.5) * 0.55;
      ctx.ctx.fillStyle = i % 3 === 0 ? '#ffb84d' : '#ffd27a';
      let alpha = 0.5 + rand() * 0.5;
      // ~10% of windows flicker (§E3): a slow independent sine per dot.
      // The same rand() draw is both the pick AND the phase seed, so the
      // deterministic stream stays one-draw-per-dot for this feature.
      const flick = rand();
      if (flick < 0.1) {
        alpha *= 0.5 + 0.5 * Math.sin(nowM / 1400 + i * 1.7 + flick * 60);
      }
      ctx.ctx.globalAlpha = alpha;
      ctx.ctx.beginPath();
      ctx.ctx.arc(
        canvasPos.x + Math.cos(ja) * rr,
        canvasPos.y + Math.sin(ja) * rr,
        0.9 + rand() * 0.8, 0, Math.PI * 2,
      );
      ctx.ctx.fill();
    }
  }
  if (clipped) {
    ctx.ctx.globalAlpha = 1;
    ctx.ctx.restore();
  }
}

/**
 * Decorative surface detail keyed by body id. Everything is clipped to
 * the planet disk and uses fixed (deterministic) positions in units of
 * `radius`, so the features stay put frame-to-frame instead of
 * shimmering. Only a few hand-placed bodies have art; the rest fall
 * through and render as a plain shaded disk.
 */
function drawSurfaceFeatures(
  body: Body,
  canvasPos: { x: number; y: number },
  radius: number,
  ctx: RenderContext,
) {
  const c = ctx.ctx;
  const { x, y } = canvasPos;

  // Clip everything to the planet disk so features never spill past
  // the limb.
  c.save();
  c.beginPath();
  c.arc(x, y, radius, 0, Math.PI * 2);
  c.clip();

  if (body.id === 'earth') {
    // Continents — overlapping green blobs. Each entry is a cluster of
    // circles (dx, dy, r in radius-units) filled as one landmass so the
    // outline reads organic rather than a single perfect circle.
    const land = '#3f8a4f';
    const landDark = '#356b3f';
    const continents: Array<Array<[number, number, number]>> = [
      // Americas-ish vertical strip, left
      [[-0.45, -0.35, 0.30], [-0.55, 0.05, 0.28], [-0.40, 0.40, 0.26], [-0.30, 0.10, 0.22]],
      // Africa/Eurasia-ish mass, right of center
      [[0.30, -0.25, 0.34], [0.50, 0.05, 0.26], [0.25, 0.20, 0.30], [0.55, -0.35, 0.20]],
      // small southern landmass
      [[0.05, 0.62, 0.20], [-0.12, 0.66, 0.16]],
    ];
    for (let ci = 0; ci < continents.length; ci++) {
      c.fillStyle = ci % 2 === 0 ? land : landDark;
      for (const [dx, dy, r] of continents[ci]) {
        c.beginPath();
        c.arc(x + dx * radius, y + dy * radius, r * radius, 0, Math.PI * 2);
        c.fill();
      }
    }
  } else if (body.id === 'mars') {
    // North polar ice cap — a bright cap pinned to the top of the disk,
    // wider than it is tall so it reads as a pole seen at an angle.
    // A smaller south cap balances it at the bottom.
    c.fillStyle = '#eaf2f7';
    c.beginPath();
    c.ellipse(x, y - radius * 0.78, radius * 0.62, radius * 0.34, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = 'rgba(234, 242, 247, 0.8)';
    c.beginPath();
    c.ellipse(x, y + radius * 0.86, radius * 0.40, radius * 0.22, 0, 0, Math.PI * 2);
    c.fill();
  }

  c.restore();
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

  // Occluded-ring worlds (Saturn template): the BACK half of the ring
  // goes down before the disk so the planet occludes it at the horizon.
  const ringed = bodyHasRings(body) && radius > 8;
  if (ringed) drawRingArcs(body, canvasPos, radius, ctx, 'back');

  // Base disk
  ctx.ctx.fillStyle = color;
  ctx.ctx.beginPath();
  ctx.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
  ctx.ctx.fill();

  // Textured path — seeded bands + storm from the texture cache, with
  // a slow horizontal drift at focus sizes so the cloud deck visibly
  // crawls (speed scales with sim tick; ~static at 1×, alive at 100×).
  let textured = false;
  if (radius > 8) {
    const tex = getPlanetTexture(body);
    if (tex) {
      const drift = radius > 20 ? ctx.t * radius * 0.002 : 0;
      drawTexturedDisk(ctx.ctx, tex, canvasPos.x, canvasPos.y, radius, drift);
      drawDayNightShading(canvasPos, radius, ctx);
      drawAtmosphereRimLight(body, canvasPos, radius, ctx);
      textured = true;
    }
  }

  // Legacy per-frame bands for small disks (or texture failure).
  if (!textured && radius > 4) {
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
    drawSphereShading(canvasPos, radius, ctx);
  }

  if (ringed) {
    // FRONT half of the occluded ring goes over the disk.
    drawRingArcs(body, canvasPos, radius, ctx, 'front');
  } else {
    // Legacy flat ring ellipse for non-ring giants / small disks —
    // unchanged look below the textured threshold.
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
}

/**
 * Label fade-in bookkeeping (§E7): wall-clock ms when each zoom-gated
 * body label first qualified to draw. Entries are deleted the frame the
 * label disqualifies (drawBody runs for every body every frame, so the
 * else-branch is a reliable janitor); the size cap is a belt-and-braces
 * guard against pathological body counts.
 */
const labelAppearMs = new Map<string, number>();

/**
 * Whether a body's name label ignores the zoom gate and shows at any
 * scale. Stars, black holes, and anything orbiting directly under a
 * star (the "always visible" tier of the system) never disappear when
 * zoomed out; everything else only shows once `scale > 0.4`. Shared
 * between drawBody's own gate and the label-collision planner in
 * MapCanvas so the two can't drift apart.
 */
export function bodyLabelAlwaysOn(body: Body): boolean {
  return body.type === 'star' || body.type === 'black_hole' || body.parent === 'sol';
}

/** Vertical step between staggered body-label rows (see planBodyLabels). */
export const BODY_LABEL_ROW_HEIGHT = 26;

/**
 * How far a label may stagger from its own body, in rows either
 * direction. Bounded deliberately: an earlier, downward-only version let
 * a crowded label (Phobos, boxed in by Mars/Deimos/a ship's transit
 * label) walk all the way down to row 7+ — 180+ screen px away, past
 * Earth into a different part of the system — while the SAME body had
 * open space directly above it the whole time. A label that far from its
 * dot doesn't read as belonging to it. ±4 rows (~100px either way) keeps
 * a label legible and near its target even when it has to move at all.
 */
const BODY_LABEL_MAX_ROWS = 4;

/**
 * Y (canvas, top-of-box) for a signed row. Row 0 and positive rows stack
 * DOWN from `belowAnchor` (a body's normal position, just under its dot);
 * negative rows stack UP from `aboveAnchor` (the mirror-image gap just
 * above the dot). Letting a crowded label go either way — rather than
 * only ever retreating downward — is what keeps it near its body instead
 * of marching off toward whatever's below it.
 */
function bodyLabelRowTop(belowAnchor: number, aboveAnchor: number, row: number): number {
  return row >= 0
    ? belowAnchor + row * BODY_LABEL_ROW_HEIGHT
    : aboveAnchor + (row + 1) * BODY_LABEL_ROW_HEIGHT;
}

/**
 * Assign each candidate body label a signed row (0 = default position
 * just below the body; negative = above; positive = further below) so
 * that dense clusters — Mercury/Venus at low zoom, five co-orbital Belt
 * rocks, a knot of moons — stagger apart instead of printing on top of
 * each other. Tries the body's own default spot first, then alternates
 * out from it (-1, +1, -2, +2, …) up to BODY_LABEL_MAX_ROWS in EITHER
 * direction, so a label only ever moves as far as it has to and takes
 * whichever side actually has room. A label never moves horizontally
 * and never hides. Rows are a fixed height regardless of whether a
 * body's own content (name only vs. name + yield tokens) fills it, so
 * two labels on different rows can never collide no matter their content.
 *
 * Priority decides who gets the default spot when several bodies
 * contend for it: selected > hovered > owned-by-player > owned-by-anyone
 * > always-on (star/black hole/direct sol child) > everything else. Ties
 * break on id so placement is stable frame to frame.
 *
 * If a body still collides with something at every row within the
 * bound (a pathological cluster), it takes the row with the LEAST
 * overlap rather than piling everything onto row 0 — same "least-bad"
 * fallback chooseRegionLabelPos uses. That fallback is itself bounded to
 * the same ±BODY_LABEL_MAX_ROWS window, so even a crowded label never
 * drifts further than a screenful of the body it names.
 *
 * Pure and exported so placement can be tested without a canvas.
 */
export function planBodyLabels(
  candidates: Array<{
    id: string; x: number; belowAnchor: number; aboveAnchor: number;
    width: number; priority: number;
  }>,
): Map<string, number> {
  const placed: LabelRect[] = [];
  const order = candidates
    .slice()
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const result = new Map<string, number>();
  // 0, -1, +1, -2, +2, … — nearest-to-the-body first, both directions.
  const rowSequence: number[] = [0];
  for (let k = 1; k <= BODY_LABEL_MAX_ROWS; k++) rowSequence.push(-k, k);
  for (const c of order) {
    let bestRow = 0;
    let bestCost = Infinity;
    for (const row of rowSequence) {
      const rect: LabelRect = {
        x: c.x - c.width / 2,
        y: bodyLabelRowTop(c.belowAnchor, c.aboveAnchor, row),
        w: c.width,
        h: BODY_LABEL_ROW_HEIGHT,
      };
      let cost = 0;
      for (const o of placed) {
        const ox = Math.min(rect.x + rect.w, o.x + o.w) - Math.max(rect.x, o.x);
        const oy = Math.min(rect.y + rect.h, o.y + o.h) - Math.max(rect.y, o.y);
        if (ox > 0 && oy > 0) cost += ox * oy;
      }
      if (cost < bestCost) { bestRow = row; bestCost = cost; }
      if (cost === 0) break;
    }
    placed.push({
      x: c.x - c.width / 2,
      y: bodyLabelRowTop(c.belowAnchor, c.aboveAnchor, bestRow),
      w: c.width,
      h: BODY_LABEL_ROW_HEIGHT,
    });
    result.set(c.id, bestRow);
  }
  return result;
}

/**
 * Draw a celestial body (circle with label) — enhanced with shading, glow,
 * gas giant bands, and a multi-layer sun corona.
 */
export function drawBody(
  body: Body,
  ctx: RenderContext,
  isSelected: boolean = false,
  isHovered: boolean = false,
  /** Show the yield readout under the label. Gated on sensor coverage
   *  by the caller — a body's resources are intel, only revealed when
   *  it's actually in range. Defaults true so non-fog callers (e.g. the
   *  lobby preview) keep showing it. */
  showYields: boolean = true,
  /** Vertical stagger row from planBodyLabels — 0 (default) draws at the
   *  body's normal fixed offset, matching every caller that doesn't plan
   *  labels (LobbyMapPreview, tests). MapCanvas computes this once per
   *  frame over all visible bodies and passes it in. */
  labelRow: number = 0,
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

  // Draw selection brackets / hover ring
  if (isSelected) {
    drawSelectionBrackets(ctx.ctx, canvasPos.x, canvasPos.y, radius + 6, COLORS.warning, ctx.nowMs);
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
  const alwaysShowLabel = bodyLabelAlwaysOn(body);
  // Rows stagger up OR down from the body's own two anchors (never
  // sideways, never onto a neighbour's territory) — see
  // bodyLabelRowTop. Mirrors exactly what MapCanvas's planBodyLabels
  // pre-pass computed these same two anchors as, so the reserved
  // collision box and the actually-painted text always agree.
  const belowAnchor = canvasPos.y + radius + 14;
  const aboveAnchor = canvasPos.y - radius - 14 - BODY_LABEL_ROW_HEIGHT;
  const rowTop = bodyLabelRowTop(belowAnchor, aboveAnchor, labelRow);
  if (alwaysShowLabel || ctx.camera.scale > 0.4) {
    // Zoom-gated labels fade in over 150ms (§E7) instead of popping at
    // the 0.4-scale threshold. Always-on labels skip the bookkeeping.
    let labelAlpha = 1;
    if (!alwaysShowLabel) {
      const nowM = ctx.nowMs ?? performance.now();
      let appear = labelAppearMs.get(body.id);
      if (appear === undefined) {
        if (labelAppearMs.size > 300) labelAppearMs.clear();
        appear = nowM;
        labelAppearMs.set(body.id, appear);
      }
      labelAlpha = Math.min(1, (nowM - appear) / 150);
    }
    ctx.ctx.save();
    ctx.ctx.globalAlpha *= labelAlpha;
    ctx.ctx.fillStyle = isSelected ? '#ffb84d' : '#8aa0b4';
    ctx.ctx.font = '10px "Audiowide", monospace';
    ctx.ctx.textAlign = 'center';
    ctx.ctx.textBaseline = 'top';
    ctx.ctx.fillText(body.name.toUpperCase(), canvasPos.x, rowTop);

    // Neptune's-Pride-style yield readout under the name. Each token
    // is color-coded to the resource pill (ore silver, credits gold,
    // science sky-cyan). Zero yields are skipped so a barren rock
    // doesn't pad three "0" tokens. Stars / black holes / gas giants
    // without body.resources fall through here.
    //
    // Fuel is deliberately NOT shown: the game is METAL / CREDITS /
    // SCIENCE (DESIGN-identity-economy.md §1.1 removed fuel from body
    // yields). The live MP catalog seeds fuel: 0 everywhere, but the
    // frozen single-player seed still carries nonzero fuel on 18 bodies,
    // so a token here would advertise a resource nothing can spend.
    if (body.resources && showYields) {
      const tokens: Array<{ text: string; color: string }> = [];
      if (body.resources.metal > 0)   tokens.push({ text: `${body.resources.metal}M`,   color: '#a0a0a0' });
      if (body.resources.gold > 0)    tokens.push({ text: `${body.resources.gold}C`,    color: '#ffd700' });
      if (body.resources.science > 0) tokens.push({ text: `${body.resources.science}S`, color: '#67e8f9' });
      if (tokens.length > 0) {
        ctx.ctx.font = '9px "Audiowide", monospace';
        ctx.ctx.textBaseline = 'top';
        const baseY = rowTop + 12; // name sits at rowTop in a 10px font; this lines up just below it
        const gap = 4;
        // Measure total width to center the row.
        let totalW = 0;
        const widths: number[] = [];
        for (const t of tokens) {
          const w = ctx.ctx.measureText(t.text).width;
          widths.push(w);
          totalW += w;
        }
        totalW += gap * (tokens.length - 1);
        let cursorX = canvasPos.x - totalW / 2;
        for (let i = 0; i < tokens.length; i++) {
          ctx.ctx.fillStyle = tokens[i].color;
          ctx.ctx.textAlign = 'left';
          ctx.ctx.fillText(tokens[i].text, cursorX, baseY);
          cursorX += widths[i] + gap;
        }
      }
    }
    ctx.ctx.restore();
  } else {
    // Label no longer qualifies — forget its appear time so the next
    // qualification fades in again from zero.
    labelAppearMs.delete(body.id);
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
 * Two-tone (§5): resolve the owning faction's secondary trim color for a
 * ship icon. Decoration only — meaning must stay in the primary, so a
 * missing factions array simply yields no trim (undefined).
 */
function shipTrimColor(ship: Ship, factions: Faction[] | undefined): string | undefined {
  if (!factions || factions.length === 0) return undefined;
  const faction = factions.find(f => f.id === ship.ownedBy);
  if (!faction?.color) return undefined;
  return faction.color2 || deriveSecondary(faction.color);
}

// ---- Ship icon size hierarchy (graphics pass, Workstream A §3) ----
// Rest sizes per class; +4 when selected. Bigger hull = bigger icon so
// a mixed fleet reads at a glance.
const SHIP_ICON_REST_SIZE: Record<string, number> = {
  corvette: 14,
  frigate: 17,
  freighter: 16,
  colony: 16,
  destroyer: 22,
};

function shipIconSize(shipClass: string, isSelected: boolean): number {
  return (SHIP_ICON_REST_SIZE[shipClass] ?? 18) + (isSelected ? 4 : 0);
}

/** Floor for a parked ship's click/hover radius. At far zoom the sprite
 *  shrinks toward a dot; this keeps it an easy target without needing a
 *  pixel-perfect tap. Touch padding stacks on top at the call site. */
export const SHIP_MIN_HIT_RADIUS = 12;

// ---- Banking on heading change (Workstream A §4) ----
// Module-level state, reused across frames — no per-frame allocation.
// Each frame: bank += clamp(Δheading × 3, ±0.14), then bank ×= 0.85
// (15%/frame decay), rendered rotation = heading + bank. Entries are
// pruned lazily: past 500 ships the whole map is cleared and rebuilt
// (a one-frame bank reset nobody will notice).
const shipBankState = new Map<string, { lastHeading: number; bank: number }>();

function shipBank(shipId: string, heading: number): number {
  if (shipBankState.size > 500) shipBankState.clear();
  let s = shipBankState.get(shipId);
  if (!s) {
    s = { lastHeading: heading, bank: 0 };
    shipBankState.set(shipId, s);
    return 0;
  }
  // Wrap Δheading to [-π, π] so crossing the atan2 seam doesn't spike.
  let dh = heading - s.lastHeading;
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  s.lastHeading = heading;
  s.bank += Math.max(-0.14, Math.min(0.14, dh * 3));
  s.bank *= 0.85;
  return s.bank;
}

// ---- State dressing (Workstream A §5) ----
// All three (retreat wake, hold alpha, rank chevron) are gated behind
// this camera scale so far zoom stays clean.
const SHIP_DRESSING_MIN_SCALE = 1.2;
const RANK_CHEVRON_COLOR = '#ffd166';

/** True when the ship has an auto-retreat threshold set AND its HP is
 *  at or below it — i.e. the server is (or is about to be) pulling it
 *  out of the fight. */
function shipIsRetreating(ship: Ship): boolean {
  if (ship.retreatHpPct == null) return false;
  const maxHp = ship.hpMax ?? getShipClass(ship.class).hp;
  if (!(maxHp > 0)) return false;
  const hp = ship.hp ?? maxHp;
  return hp / maxHp <= ship.retreatHpPct / 100;
}

/** Thin 12px wake line astern of a retreating ship, in the faction
 *  secondary at 35% alpha. Drawn before the icon so it sits under it. */
function drawRetreatWake(
  c2d: CanvasRenderingContext2D,
  canvasPos: { x: number; y: number },
  heading: number,
  iconSize: number,
  secondary: string,
) {
  const cosH = Math.cos(heading);
  const sinH = Math.sin(heading);
  const x0 = canvasPos.x - cosH * iconSize / 2;
  const y0 = canvasPos.y - sinH * iconSize / 2;
  c2d.save();
  c2d.strokeStyle = withOpacity(secondary, 0.35);
  c2d.lineWidth = 1;
  c2d.beginPath();
  c2d.moveTo(x0, y0);
  c2d.lineTo(x0 - cosH * 12, y0 - sinH * 12);
  c2d.stroke();
  c2d.restore();
}

/** 2px gold chevron floating ~4px above the icon for veteran ships
 *  (rank ≥ 5). Screen-aligned, not rotated with the hull. */
function drawRankChevron(
  c2d: CanvasRenderingContext2D,
  canvasPos: { x: number; y: number },
  iconSize: number,
) {
  const y = canvasPos.y - iconSize / 2 - 4;
  c2d.save();
  c2d.strokeStyle = RANK_CHEVRON_COLOR;
  c2d.lineWidth = 2;
  c2d.lineJoin = 'miter';
  c2d.beginPath();
  c2d.moveTo(canvasPos.x - 4, y);
  c2d.lineTo(canvasPos.x, y - 3.5);
  c2d.lineTo(canvasPos.x + 4, y);
  c2d.stroke();
  c2d.restore();
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

  // The PLANET keeps true time — its position along its own orbit is
  // load-bearing. Only the ship's angle AROUND the planet gets the
  // cosmetic spin, so hulls visibly circle instead of creeping a pixel a
  // minute. See render/tickPhase.
  const shipT = shipDisplayTick(ctx.t, ship.orbit.period, Date.now());
  const parentPos = bodyPosition(parentBody, ctx.t, ctx.bodies);
  const localPos = localPositionAt(ship.orbit, shipT);
  const worldX = parentPos.x + localPos.x;
  const worldY = parentPos.y + localPos.y;
  let canvasPos = worldToCanvas(worldX, worldY, ctx);

  // Faction-colored: cyan for player, red for enemy.
  const shipColorValue = shipColor(ship, ctx.factions);

  // Velocity vector — used both to rotate the icon and as a fallback tick.
  // Same spun time as the position, or the hull would point one way and
  // travel another.
  const vel = velocityVectorsAt(ship.orbit, shipT);
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

  const iconSize = shipIconSize(ship.class, isSelected);

  // Record the true drawn box for hit-testing: canvasPos already carries
  // the orbit spin, tick interpolation AND the formation spread, so a
  // click reads exactly where the hull is — including stacked ships that
  // were fanned apart. Radius covers the sprite (half its size) with a
  // small floor so a tiny far-zoom icon is still an easy target.
  ctx.shipHitboxes?.set(ship.id, {
    x: canvasPos.x,
    y: canvasPos.y,
    r: Math.max(iconSize / 2 + 3, SHIP_MIN_HIT_RADIUS),
  });

  // Damage flash sits beneath the icon so the icon stays at full opacity.
  const flashStart = ctx.damageFlashStart?.get(ship.id);
  drawDamageFlash(canvasPos, iconSize / 2, flashStart, ctx.nowMs ?? performance.now(), ctx, 'damage');

  const trimColor = shipTrimColor(ship, ctx.factions);
  const dressed = ctx.camera.scale >= SHIP_DRESSING_MIN_SCALE;

  const icon = getShipIconImage(
    ship.class as ShipIconClass, shipColorValue, ship.iconVariant,
    trimColor,
  );
  if (icon) {
    // Retreat wake sits UNDER the icon.
    if (dressed && shipIsRetreating(ship)) {
      drawRetreatWake(ctx.ctx, canvasPos, heading, iconSize, trimColor ?? shipColorValue);
    }
    // Draw the icon rotated to face the velocity direction, plus a
    // transient bank lean while the heading is changing.
    ctx.ctx.save();
    ctx.ctx.translate(canvasPos.x, canvasPos.y);
    ctx.ctx.rotate(heading + shipBank(ship.id, heading));
    if (dressed && ship.stance === 'hold') ctx.ctx.globalAlpha = 0.8;
    ctx.ctx.drawImage(icon, -iconSize / 2, -iconSize / 2, iconSize, iconSize);
    ctx.ctx.restore();
    if (dressed && (ship.rank ?? 0) >= 5) {
      drawRankChevron(ctx.ctx, canvasPos, iconSize);
    }
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
    drawSelectionBrackets(ctx.ctx, canvasPos.x, canvasPos.y, iconSize / 2 + 4, COLORS.info, ctx.nowMs);
  }

  // Ship name label — hover/selection only (see RenderContext.hoveredShipId).
  if (isSelected || ctx.hoveredShipId === ship.id) {
    ctx.ctx.fillStyle = isSelected ? '#ffb84d' : shipColorValue;
    ctx.ctx.font = '9px "Audiowide", monospace';
    ctx.ctx.textAlign = 'left';
    ctx.ctx.textBaseline = 'middle';
    ctx.ctx.fillText(ship.name.split(' ')[0], canvasPos.x + iconSize / 2 + 4, canvasPos.y - 6);
  }
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
  ctx.ctx.font = `${textSize}px "Audiowide", monospace`;
  ctx.ctx.textAlign = 'left';
  ctx.ctx.textBaseline = 'top';

  // Three resources — fuel is dead (DESIGN-identity-economy.md §1.1).
  // Dropping it also makes the row count match panelHeight, which is
  // sized for 3 lines; the old 4th row overflowed the panel background.
  const labels = ['Credits', 'Metal', 'Sci'];
  const values = [
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
  ctx.ctx.font = `${fontSize}px "Audiowide", monospace`;
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
  ctx.ctx.font = '10px "Audiowide", monospace';
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
  ctx.ctx.font = '10px "Audiowide", monospace';
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
  ctx.ctx.font = '8px "Audiowide", monospace';
  ctx.ctx.textAlign = 'center';
  ctx.ctx.textBaseline = 'bottom';
  ctx.ctx.fillText(`Pe ${orbit.rp.toFixed(0)}`, periCanvas.x, periCanvas.y - 6);

  // Draw apoapsis dot and label
  ctx.ctx.fillStyle = orbitColor;
  ctx.ctx.beginPath();
  ctx.ctx.arc(apoCanvas.x, apoCanvas.y, 2.5, 0, Math.PI * 2);
  ctx.ctx.fill();
  ctx.ctx.font = '8px "Audiowide", monospace';
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
  /**
   * When set, the segment of the trajectory BEHIND the ship (between
   * startTick and currentTick) fades from near-invisible at the launch
   * point to full alpha at the ship's position. Reduces visual clutter
   * for fleets in flight — the player sees where the ship is going, with
   * just a soft trail of where it's been. Pass plan.startTick (or older)
   * to disable; pass current sim tick to enable. Honors the caller's
   * existing globalAlpha (it multiplies into the fade).
   */
  currentTick?: number,
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

  // Trail fade: the trajectory behind the ship dims along its length so
  // the launch point is barely visible while the path ahead reads clear.
  // Only active when caller passes a sim tick within the burn window
  // (and we're not in split-phase debug mode). In STRAIGHT_LINE mode the
  // two-sample polyline doesn't have enough granularity to read as a
  // gradient, so we sub-sample the chord on the fly.
  const fadeActive = currentTick != null
    && currentTick > plan.startTick
    && currentTick < plan.arriveTick
    && !splitPhaseColors;
  if (fadeActive && samples.length === 2) {
    const N = 24;
    const a = samples[0];
    const b = samples[1];
    samples = [];
    for (let i = 0; i <= N; i++) {
      const k = i / N;
      samples.push({
        t: a.t + (b.t - a.t) * k,
        x: a.x + (b.x - a.x) * k,
        y: a.y + (b.y - a.y) * k,
      });
    }
  }

  // === Own-trajectory dash crawl ==============================
  // The player's own transfer lines (mine role — the color is the
  // contract, computed by trajectoryRole at every callsite) carry a
  // long-dash pattern whose lineDashOffset marches toward the
  // destination at ~24 px/s wall-clock, so "my ship is going THERE"
  // reads as motion. Enemy/neutral lines stay static. One offset
  // assignment per stroke — no allocation, no extra passes.
  const crawl = color === TRAJECTORY_COLORS.mine && !splitPhaseColors;
  let crawlOffset = 0;
  if (crawl) {
    const nowMs = ctx.nowMs ?? performance.now();
    const dashPeriod = isDashed ? 10 : 16;   // [5,5] vs [10,6]
    // Negative, growing more negative → dashes advance along the
    // stroke direction (start → destination).
    crawlOffset = -((nowMs * 0.024) % dashPeriod);
    ctx.ctx.setLineDash(isDashed ? [5, 5] : [10, 6]);
    ctx.ctx.lineDashOffset = crawlOffset;
  } else if (isDashed) {
    ctx.ctx.setLineDash([5, 5]);
  }
  ctx.ctx.lineWidth = 1.5;

  // === Gradient trajectories ==================================
  // Transfer lines fade 85% alpha at the ship → 15% at the
  // destination. Gradient allocation is per-line (lines are few) but
  // only at readable zoom; below scale 0.5 we use flat 40% alpha so
  // far zoom never allocates gradients. Hue (mine/neutral/hostile/
  // preview) is preserved — only alpha ramps.
  const useGradient = ctx.camera.scale >= 0.5 && color.startsWith('#');
  const destCP = worldToCanvas(
    samples[samples.length - 1].x, samples[samples.length - 1].y, ctx);

  if (splitPhaseColors) {
    // Two passes: boost (samples.t < flipTick) in green, brake in pink.
    // The flip sample stitches them so there's no gap. Adds visual
    // weight to the maneuver — players can see at a glance which half
    // of the trip the ship is currently in.
    //
    // Behind the ship is consumed here too: once under way the strokes
    // begin at the hull, not the launch point, so the travelled boost
    // leg vanishes and only the remaining path shows. When the ship has
    // already flipped, the whole boost leg is behind it and drops out,
    // leaving just the pink brake run from the hull to the target.
    const flipIdx = samples.findIndex(s => s.t >= plan.flipTick);
    const splitAt = flipIdx < 0 ? samples.length - 1 : flipIdx;
    const flying = currentTick != null
      && currentTick > plan.startTick && currentTick < plan.arriveTick;
    const cur = flying ? (currentTick as number) : -Infinity;
    const shipWorld = flying ? torchPositionFromSamples(samples, cur) : samples[0];
    const shipCP = worldToCanvas(shipWorld.x, shipWorld.y, ctx);
    let nextIdx = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].t > cur) { nextIdx = i; break; }
    }

    // Boost leg (green), only the part still ahead of the ship.
    if (nextIdx <= splitAt) {
      ctx.ctx.strokeStyle = '#6ee7b7';
      ctx.ctx.beginPath();
      ctx.ctx.moveTo(shipCP.x, shipCP.y);
      for (let i = nextIdx; i <= splitAt; i++) {
        const cp = worldToCanvas(samples[i].x, samples[i].y, ctx);
        ctx.ctx.lineTo(cp.x, cp.y);
      }
      ctx.ctx.stroke();
    }
    // Brake leg (pink).
    ctx.ctx.strokeStyle = '#fda4af';
    ctx.ctx.beginPath();
    if (nextIdx > splitAt) {
      // Ship already flipped — brake run starts at the hull.
      ctx.ctx.moveTo(shipCP.x, shipCP.y);
      for (let i = nextIdx; i < samples.length; i++) {
        const cp = worldToCanvas(samples[i].x, samples[i].y, ctx);
        ctx.ctx.lineTo(cp.x, cp.y);
      }
    } else {
      // Ship still boosting — brake leg stitches to the green at the flip.
      for (let i = splitAt; i < samples.length; i++) {
        const cp = worldToCanvas(samples[i].x, samples[i].y, ctx);
        if (i === splitAt) ctx.ctx.moveTo(cp.x, cp.y);
        else ctx.ctx.lineTo(cp.x, cp.y);
      }
    }
    ctx.ctx.stroke();
  } else if (fadeActive) {
    // The line is CONSUMED as the ship flies it: nothing is drawn behind
    // the ship's current position. Only the path ahead — ship →
    // destination — renders, so the trajectory reads as "where I'm still
    // going", not a growing contrail of where I've been. (Previously the
    // travelled segment was drawn with a rising trail fade; the request
    // was to have it disappear entirely.)
    //
    // The interpolated ship position sits BETWEEN two samples, so the
    // ahead-stroke starts at that exact point (not the next whole sample)
    // — otherwise a stub of already-flown line would poke out behind the
    // hull between sample steps.
    const baseAlpha = ctx.ctx.globalAlpha;
    const cur = currentTick as number;
    const shipWorld = torchPositionFromSamples(samples, cur);
    const shipCP = worldToCanvas(shipWorld.x, shipWorld.y, ctx);
    let nextIdx = samples.length - 1;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].t > cur) { nextIdx = i; break; }
    }

    ctx.ctx.globalAlpha = baseAlpha;
    if (useGradient) {
      const grad = ctx.ctx.createLinearGradient(shipCP.x, shipCP.y, destCP.x, destCP.y);
      grad.addColorStop(0, withOpacity(color, 0.85));
      grad.addColorStop(1, withOpacity(color, 0.15));
      ctx.ctx.strokeStyle = grad;
    } else {
      ctx.ctx.strokeStyle = color.startsWith('#') ? withOpacity(color, 0.4) : color;
    }
    if (crawl) ctx.ctx.lineDashOffset = crawlOffset;
    ctx.ctx.beginPath();
    ctx.ctx.moveTo(shipCP.x, shipCP.y);
    for (let i = nextIdx; i < samples.length; i++) {
      const cp = worldToCanvas(samples[i].x, samples[i].y, ctx);
      ctx.ctx.lineTo(cp.x, cp.y);
    }
    ctx.ctx.stroke();
    ctx.ctx.globalAlpha = baseAlpha;
  } else {
    // Static line (planned previews, queued legs, out-of-window):
    // same gradient treatment, anchored at the line start since the
    // ship hasn't departed yet.
    if (useGradient) {
      const startCP = worldToCanvas(samples[0].x, samples[0].y, ctx);
      const grad = ctx.ctx.createLinearGradient(startCP.x, startCP.y, destCP.x, destCP.y);
      grad.addColorStop(0, withOpacity(color, 0.85));
      grad.addColorStop(1, withOpacity(color, 0.15));
      ctx.ctx.strokeStyle = grad;
    } else {
      ctx.ctx.strokeStyle = color.startsWith('#') ? withOpacity(color, 0.4) : color;
    }
    ctx.ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const cp = worldToCanvas(samples[i].x, samples[i].y, ctx);
      if (i === 0) ctx.ctx.moveTo(cp.x, cp.y);
      else ctx.ctx.lineTo(cp.x, cp.y);
    }
    ctx.ctx.stroke();
  }
  ctx.ctx.setLineDash([]);
  ctx.ctx.lineDashOffset = 0;

  // === Arrival tick-marks (selected ship only) ================
  // splitPhaseColors is only ever passed for the player's selected,
  // non-trade ship, so it doubles as the "selected" signal without
  // widening the signature. Small perpendicular notches every 10
  // flight-ticks give the trajectory a ruler the player can read
  // ETA against; the flip point gets a bigger, brighter notch.
  if (splitPhaseColors && samples.length >= 2) {
    // Only mark the road AHEAD: notches behind the hull would hang in
    // space now that the travelled line is gone. The flip notch shows
    // only if the ship hasn't reached it yet.
    drawTrajectoryTickMarks(plan, samples, ctx, currentTick);
  }
  return samples;
}

/** Perpendicular notch across the trajectory polyline at sim tick
 *  `tick`. Interpolates position + direction from the sample array in
 *  canvas space. Returns false when the tick is outside the polyline. */
function strokeTrajectoryNotch(
  samples: Array<{ t: number; x: number; y: number }>,
  tick: number,
  halfLen: number,
  ctx: RenderContext,
): boolean {
  if (tick < samples[0].t || tick > samples[samples.length - 1].t) return false;
  let i = 0;
  while (i < samples.length - 2 && samples[i + 1].t < tick) i++;
  const A = worldToCanvas(samples[i].x, samples[i].y, ctx);
  const B = worldToCanvas(samples[i + 1].x, samples[i + 1].y, ctx);
  const span = samples[i + 1].t - samples[i].t;
  const k = span > 0 ? Math.max(0, Math.min(1, (tick - samples[i].t) / span)) : 0;
  const px = A.x + (B.x - A.x) * k;
  const py = A.y + (B.y - A.y) * k;
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return false;
  const nx = -dy / len;
  const ny = dx / len;
  ctx.ctx.moveTo(px - nx * halfLen, py - ny * halfLen);
  ctx.ctx.lineTo(px + nx * halfLen, py + ny * halfLen);
  return true;
}

/** Flight-time ruler on the selected ship's trajectory: a notch every
 *  10 ticks (step widened on very long flights so we never draw more
 *  than ~40), plus a larger notch at the flip (boost→brake) tick. */
function drawTrajectoryTickMarks(
  plan: TorchTransferPlan,
  samples: Array<{ t: number; x: number; y: number }>,
  ctx: RenderContext,
  /** Ship's current tick; notches at or before it are skipped so the
   *  ruler only marks the path still ahead. Undefined = mark all. */
  currentTick?: number,
) {
  const flight = plan.arriveTick - plan.startTick;
  if (flight <= 0) return;
  const minTick = currentTick ?? -Infinity;
  let step = 10;
  const MAX_NOTCHES = 40;
  if (flight / step > MAX_NOTCHES) {
    step = Math.ceil(flight / MAX_NOTCHES / 10) * 10;
  }
  ctx.ctx.save();
  ctx.ctx.strokeStyle = 'rgba(216, 228, 238, 0.55)';
  ctx.ctx.lineWidth = 1;
  ctx.ctx.beginPath();
  for (let tick = plan.startTick + step; tick < plan.arriveTick; tick += step) {
    if (tick <= minTick) continue;
    strokeTrajectoryNotch(samples, tick, 2.5, ctx);
  }
  ctx.ctx.stroke();
  // Flip point — the boost/brake handover — gets a longer, brighter
  // notch so the maneuver midpoint reads at a glance. Gone once passed.
  if (plan.flipTick > minTick) {
    ctx.ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.ctx.lineWidth = 1.5;
    ctx.ctx.beginPath();
    strokeTrajectoryNotch(samples, plan.flipTick, 5, ctx);
    ctx.ctx.stroke();
  }
  ctx.ctx.restore();
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

    // Heat-shimmer (Workstream B §5): while the ram burn is live, draw
    // the rock a second time at a ±0.5px seeded jitter, 30% alpha —
    // reads as the rock's silhouette wavering in its own exhaust. The
    // jitter reseeds every ~45ms so it flickers, but within a frame it
    // is deterministic per body id.
    const shimmerRng = mulberry32(hashStr(body.id) ^ Math.floor((ctx.nowMs ?? performance.now()) / 45));
    const jx = shimmerRng() - 0.5;
    const jy = shimmerRng() - 0.5;
    const rockR = Math.max(1.5, body.radius * ctx.camera.scale);
    ctx.ctx.save();
    ctx.ctx.globalAlpha = 0.3;
    ctx.ctx.fillStyle = body.color;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasHere.x + jx, canvasHere.y + jy, rockR, 0, Math.PI * 2);
    ctx.ctx.fill();
    ctx.ctx.restore();
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
    ctx.ctx.font = 'bold 10px "Audiowide", monospace';
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
// Ship thrust flames only read at closer zooms — at system-wide zoom a
// dozen simultaneous transfers each drag a flame across the map and it
// turns to clutter. Fade in across this camera-scale band instead of
// popping. Calibration: the default inner-system view sits at scale
// ≈ 1 (Earth orbit r=186 spans ~200px), and body focus-zoom clamps to
// scale 2–60 — so flames are gone at system view and ~60% in at the
// widest focus zoom. Asteroid-impact flames are exempt: they're a
// threat indicator, not decoration.
const THRUST_FADE_LO = 1.2;
const THRUST_FADE_HI = 2.5;

function thrustVisibility(scale: number): number {
  return Math.max(0, Math.min(1, (scale - THRUST_FADE_LO) / (THRUST_FADE_HI - THRUST_FADE_LO)));
}

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
 * Orientation: the nose always points AT THE DESTINATION for the whole
 * flight. The earlier implementation modelled a flip-and-burn (boost
 * facing intercept, brake flipped 180° to face backward) — physically
 * correct for a real torch ship, but playtester read the half-flight
 * "backwards ship" as a bug. Now we keep the icon oriented toward the
 * intercept point for both phases; coast (outside the burn window)
 * falls back to velocity direction so a ship that's already arrived
 * or hasn't started yet isn't lurching to face an arbitrary point.
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

  // Ship's nose points at the TARGET BODY's CURRENT position for the
  // whole transfer — boost, brake, and coast all use the same rule.
  //
  // Previous iterations split this two ways:
  //   1) thrust → point at currentTransfer.interceptPos (a frozen lead-
  //      point computed at transfer start). As the ship approached
  //      that point the dx/dy vector shrank to ~0 and the rotation
  //      swung wildly, then in the brief coast tail the icon snapped
  //      to a velocity that was already braking toward zero.
  //   2) coast → point along velocity. On multi-leg trade routes the
  //      transition from leg-1 brake (vel decreasing) to leg-2 start
  //      had a window where vel still pointed back at the origin
  //      while the next intercept was the other way — the icon
  //      visibly reversed.
  //
  // Using the live body position is robust against both. Falls back
  // to velocity only when the target body has been destroyed or
  // somehow can't be looked up.
  let facingX: number, facingY: number;
  const targetBody = ctx.bodies.find(b => b.id === currentTransfer.targetBodyId);
  const targetPos = targetBody ? bodyPosition(targetBody, ctx.t, ctx.bodies) : null;
  if (targetPos) {
    const dx = targetPos.x - lerpedPos.x;
    const dy = targetPos.y - lerpedPos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1e-3) {
      facingX = dx / d;
      facingY = dy / d;
    } else {
      // On top of the target — keep last-known velocity rather than
      // snapping to +x.
      const vMag = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
      facingX = vMag > 1e-9 ? vel.x / vMag : 1;
      facingY = vMag > 1e-9 ? vel.y / vMag : 0;
    }
  } else {
    const vMag = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
    facingX = vMag > 1e-9 ? vel.x / vMag : 1;
    facingY = vMag > 1e-9 ? vel.y / vMag : 0;
  }
  // Canvas y axis inverts.
  const heading = Math.atan2(-facingY, facingX);

  const iconSize = shipIconSize(ship.class, isSelected);

  const flashStartT = ctx.damageFlashStart?.get(ship.id);
  drawDamageFlash(canvasPos, iconSize / 2, flashStartT, ctx.nowMs ?? performance.now(), ctx, 'damage');

  // Thrust exhaust — drawn BEFORE the ship icon so the icon sits on top
  // of the engine. Engine is at the "back" of the local ship icon
  // (negative x in local space, since icons face +x at heading=0).
  // After rotating by `heading`, the engine in canvas coords is:
  //   enginePos = canvasPos - heading_unit * iconSize/2
  // The exhaust then extends further in -heading_unit (further behind
  // the engine). This is correct in BOTH phases: in BRAKE the ship has
  // flipped, so "behind the engine" in world space is now AHEAD of
  // motion — exactly what you'd see when the torch decelerates.
  const thrustVis = thrustVisibility(ctx.camera.scale);
  if (thrusting && thrustVis > 0) {
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);
    drawThrustExhaust(
      ctx.ctx,
      { x: canvasPos.x - cosH * iconSize / 2, y: canvasPos.y - sinH * iconSize / 2 },
      { x: cosH, y: sinH },
      iconSize,
      (isSelected ? 1.0 : 0.85) * thrustVis,
    );
  }

  const trimColor = shipTrimColor(ship, ctx.factions);
  const dressed = ctx.camera.scale >= SHIP_DRESSING_MIN_SCALE;

  const icon = getShipIconImage(
    ship.class as ShipIconClass, shipColorValue, ship.iconVariant,
    trimColor,
  );
  if (icon) {
    // Retreat wake sits UNDER the icon.
    if (dressed && shipIsRetreating(ship)) {
      drawRetreatWake(ctx.ctx, canvasPos, heading, iconSize, trimColor ?? shipColorValue);
    }
    ctx.ctx.save();
    ctx.ctx.translate(canvasPos.x, canvasPos.y);
    ctx.ctx.rotate(heading + shipBank(ship.id, heading));
    if (dressed && ship.stance === 'hold') ctx.ctx.globalAlpha = 0.8;
    ctx.ctx.drawImage(icon, -iconSize / 2, -iconSize / 2, iconSize, iconSize);
    ctx.ctx.restore();
    if (dressed && (ship.rank ?? 0) >= 5) {
      drawRankChevron(ctx.ctx, canvasPos, iconSize);
    }
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
    drawSelectionBrackets(ctx.ctx, canvasPos.x, canvasPos.y, iconSize / 2 + 4, COLORS.info, ctx.nowMs);
  }

  // Ship name — hover/selection only (see RenderContext.hoveredShipId).
  if (isSelected || ctx.hoveredShipId === ship.id) {
    ctx.ctx.fillStyle = isSelected ? '#ffb84d' : shipColorValue;
    ctx.ctx.font = '9px "Audiowide", monospace';
    ctx.ctx.textAlign = 'left';
    ctx.ctx.textBaseline = 'middle';
    ctx.ctx.fillText(ship.name.split(' ')[0], canvasPos.x + iconSize / 2 + 4, canvasPos.y - 6);
  }

  // ETA + phase label when selected
  if (isSelected) {
    const eta = currentTransfer.arriveTick - ctx.t;
    const phase = ctx.t < currentTransfer.flipTick ? 'BOOST' : 'BRAKE';
    if (eta > 0) {
      ctx.ctx.fillStyle = COLORS.fgDim;
      ctx.ctx.font = '8px "Audiowide", monospace';
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
  ctx.ctx.font = '9px "Audiowide", monospace';
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
 * Two-tone (§5): the owning faction's secondary trim for settlements.
 * Decoration only — meaning must stay in the primary.
 */
function settlementColor2(settlement: Settlement, factions: Faction[]): string | undefined {
  const faction = factions.find(f => f.id === settlement.ownedBy);
  if (!faction?.color) return undefined;
  return faction.color2 || deriveSecondary(faction.color);
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

  // Focus zoom — the flat square grows into a full isometric cluster
  // standing on the surface: faction-edged pad, habitat blocks scaled
  // by population, and a distinct silhouette per building (forge /
  // mint / lab / thrusters) that grows with its level. Canvas is
  // rotated so the cluster's "up" is the outward surface normal.
  //
  // Gated on bodyScreenR OR the body being the selected/inspected one.
  // BodyInspector frames the ORBIT ENVELOPE, not the body itself (a
  // dwarf planet's disc can stay under 40px even after the inspector's
  // zoom-on-open finishes, since the envelope is sized to the widest
  // orbiting ship/station, not the body's own radius). Without the
  // selectedBodyId check, the panel showed full building detail while
  // the map still drew a bare dot for the exact same settlement.
  const bodyScreenR = body.radius * ctx.camera.scale;
  if (bodyScreenR >= 40 || ctx.selectedBodyId === body.id) {
    const flashIso = ctx.damageFlashStart?.get(settlement.id);
    drawDamageFlash(canvasPos, 12, flashIso, ctx.nowMs ?? performance.now(), ctx, 'damage');
    const growthIso = ctx.growthFlashStart?.get(settlement.id);
    drawDamageFlash(canvasPos, 12, growthIso, ctx.nowMs ?? performance.now(), ctx, 'growth');
    ctx.ctx.save();
    ctx.ctx.translate(canvasPos.x, canvasPos.y);
    ctx.ctx.rotate(angle + Math.PI / 2);
    drawCityCluster(ctx.ctx, settlement, color);
    ctx.ctx.restore();

    // HP bar + selection ring stay in screen space, floated outward
    // past the skyline so they never collide with the buildings.
    const tipIsoX = canvasPos.x + Math.cos(angle) * 40;
    const tipIsoY = canvasPos.y + Math.sin(angle) * 40;
    if (settlement.hp < settlement.maxHp) {
      const barW = 30;
      const barH = 3;
      const hpFrac = Math.max(0, settlement.hp / settlement.maxHp);
      ctx.ctx.fillStyle = '#2a3d50';
      ctx.ctx.fillRect(tipIsoX - barW / 2, tipIsoY - barH / 2, barW, barH);
      ctx.ctx.fillStyle = hpFrac > 0.5 ? COLORS.success : hpFrac > 0.25 ? COLORS.warning : COLORS.danger;
      ctx.ctx.fillRect(tipIsoX - barW / 2, tipIsoY - barH / 2, barW * hpFrac, barH);
    }
    if (isSelected) {
      drawSelectionBrackets(ctx.ctx, canvasPos.x, canvasPos.y, 28, COLORS.warning, ctx.nowMs);
    }
    return;
  }

  // Outward orientation
  const outwardX = Math.cos(angle);
  const outwardY = Math.sin(angle);
  const tipX = canvasPos.x + outwardX * size * 0.5;
  const tipY = canvasPos.y + outwardY * size * 0.5;

  // Damage flash underneath the marker
  const flashStartC = ctx.damageFlashStart?.get(settlement.id);
  drawDamageFlash({ x: tipX, y: tipY }, size, flashStartC, ctx.nowMs ?? performance.now(), ctx, 'damage');
  const growthStartC = ctx.growthFlashStart?.get(settlement.id);
  drawDamageFlash({ x: tipX, y: tipY }, size, growthStartC, ctx.nowMs ?? performance.now(), ctx, 'growth');

  ctx.ctx.fillStyle = color;
  ctx.ctx.strokeStyle = '#0a0e14';
  ctx.ctx.lineWidth = 1;
  ctx.ctx.beginPath();
  ctx.ctx.rect(tipX - size / 2, tipY - size / 2, size, size);
  ctx.ctx.fill();
  ctx.ctx.stroke();

  // Two-tone (§5): a secondary outline hugging the primary square, so a
  // city reads in both faction colors. decoration only — meaning stays in
  // the primary fill. Only when the marker is big enough to resolve.
  const color2 = settlementColor2(settlement, factions);
  if (color2 && size >= 3.5) {
    ctx.ctx.strokeStyle = color2;
    ctx.ctx.lineWidth = 1.2;
    ctx.ctx.beginPath();
    ctx.ctx.rect(tipX - size / 2 - 1.2, tipY - size / 2 - 1.2, size + 2.4, size + 2.4);
    ctx.ctx.stroke();
  }

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
    drawSelectionBrackets(ctx.ctx, tipX, tipY, size + 4, COLORS.warning, ctx.nowMs);
  }
}

/**
 * Draw a station: a diamond marker on a thin orbital ring around the body.
 */
/** How much the zoomed-in station structure is enlarged over its native
 *  drawing units. 1.6 makes the ring-hub silhouette read as a place the
 *  overlay chips can plausibly hang off, without dwarfing small moons. */
const STATION_STRUCTURE_SCALE = 1.6;

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
  // THE actual "no station on the orbit" bug: Sol (the system primary)
  // has mu = 0, so the orbit builder yields period = 0. That made
  // M = M0 + 2π·(t−epoch)/0 = ±Infinity → cos/sin = NaN → the marker
  // drew at (NaN, NaN) and vanished, even though the orbit ring (which
  // uses `radius` only) still rendered — hence "I see an orbit but no
  // station." With no gravity there's no orbital motion, so pin the
  // station at its fixed angle M0. (finite guard also covers any other
  // malformed orbit.)
  const M = (Number.isFinite(orbit.period) && orbit.period > 0)
    ? orbit.M0 + (2 * Math.PI * (ctx.t - orbit.epoch) / orbit.period) * orbit.direction
    : orbit.M0 + orbit.epoch;   // static: offset by epoch so multiple stations don't stack
  const theta = Number.isFinite(M) ? M : 0;
  const localX = radius * Math.cos(theta);
  const localY = radius * Math.sin(theta);
  const worldX = bodyPos.x + localX;
  const worldY = bodyPos.y + localY;
  const canvasPos = worldToCanvas(worldX, worldY, ctx);

  const color = settlementColor(settlement, factions);
  const size = Math.max(3, 4 * Math.min(1.5, Math.sqrt(ctx.camera.scale)));

  // Damage flash underneath the diamond
  const flashStartS = ctx.damageFlashStart?.get(settlement.id);
  drawDamageFlash(canvasPos, size, flashStartS, ctx.nowMs ?? performance.now(), ctx, 'damage');
  const growthStartS = ctx.growthFlashStart?.get(settlement.id);
  drawDamageFlash(canvasPos, size, growthStartS, ctx.nowMs ?? performance.now(), ctx, 'growth');

  // Focus zoom — the diamond grows into a station: hub + solar wings,
  // weapon barrels when a Weapons building exists, and an open
  // shipyard scaffold that shows a hull inside whenever a ship build
  // is in flight at this body. Levels widen the modules.
  //
  // Same selectedBodyId escape hatch as drawCity: the inspector zooms
  // to fit the ORBIT ENVELOPE (widest ship/station radius), which can
  // leave a small body's own screen radius under 40px even once the
  // panel is fully open — so gate on either.
  const bodyScreenR = body.radius * ctx.camera.scale;
  if (bodyScreenR >= 40 || ctx.selectedBodyId === body.id) {
    const weaponsLevel = buildingLevel(settlement, 'weapons' as BuildingKind);
    const shipyardLevel = buildingLevel(settlement, 'shipyard' as BuildingKind);
    const labLevel = buildingLevel(settlement, 'lab' as BuildingKind);
    const nowMForStation = ctx.nowMs ?? performance.now();
    // Earliest-queued first, so a station with two bays (shipyard L5+)
    // shows the ship closest to launch in the primary slot.
    const builds = (ctx.buildOrders ?? [])
      .filter(bo => bo.bodyId === body.id && bo.ownedBy === settlement.ownedBy)
      .sort((a, b) => a.startTick - b.startTick)
      .map(bo => ({
        shipClass: bo.shipClass,
        progress: bo.completeTick > bo.startTick
          ? (ctx.t - bo.startTick) / (bo.completeTick - bo.startTick)
          : 1,
      }));
    ctx.ctx.save();
    ctx.ctx.translate(canvasPos.x, canvasPos.y);
    // World-overlay pass made the station the co-star of the zoomed-in
    // view (callout chips hang off it), and at 1x it read as a trinket
    // next to the planet. Scale the whole structure up so the ring/hub
    // silhouette and its modules are legible as a place, not a marker.
    ctx.ctx.scale(STATION_STRUCTURE_SCALE, STATION_STRUCTURE_SCALE);
    drawStationStructure(ctx.ctx, {
      weaponsLevel, shipyardLevel, labLevel, builds,
      factionColor: color,
      nowMs: nowMForStation,
      buildFlash: {
        weapons: ctx.buildFlashStart?.get(`${settlement.id}:weapons`),
        shipyard: ctx.buildFlashStart?.get(`${settlement.id}:shipyard`),
        lab: ctx.buildFlashStart?.get(`${settlement.id}:lab`),
      },
    });
    ctx.ctx.restore();

    if (settlement.hp < settlement.maxHp) {
      // Bar rides above the scaled-up structure.
      const barW = 34 * STATION_STRUCTURE_SCALE;
      const barH = 3;
      const barY = canvasPos.y - 22 * STATION_STRUCTURE_SCALE;
      const hpFrac = Math.max(0, settlement.hp / settlement.maxHp);
      ctx.ctx.fillStyle = '#2a3d50';
      ctx.ctx.fillRect(canvasPos.x - barW / 2, barY, barW, barH);
      ctx.ctx.fillStyle = hpFrac > 0.5 ? COLORS.success : hpFrac > 0.25 ? COLORS.warning : COLORS.danger;
      ctx.ctx.fillRect(canvasPos.x - barW / 2, barY, barW * hpFrac, barH);
    }
    if (isSelected) {
      drawSelectionBrackets(ctx.ctx, canvasPos.x, canvasPos.y, 30 * STATION_STRUCTURE_SCALE, COLORS.warning, ctx.nowMs);
    }
    return;
  }

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

  // Two-tone (§5): station beacon gets a secondary ring around the
  // diamond. decoration only — meaning must stay in primary (the
  // selection ring below stays in its own warning color).
  const beacon2 = settlementColor2(settlement, factions);
  if (beacon2) {
    // Beacon blink (§E1): alpha 0.4→1.0 sine at 0.5Hz, wall-clock —
    // matches the iso hub dot's pulse in drawStationStructure.
    const nowMB = ctx.nowMs ?? performance.now();
    ctx.ctx.save();
    ctx.ctx.globalAlpha = 0.7 + 0.3 * Math.sin(Math.PI * nowMB / 1000);
    ctx.ctx.strokeStyle = beacon2;
    ctx.ctx.lineWidth = 1;
    ctx.ctx.beginPath();
    ctx.ctx.arc(canvasPos.x, canvasPos.y, size + 2, 0, Math.PI * 2);
    ctx.ctx.stroke();
    ctx.ctx.restore();
  }

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
    drawSelectionBrackets(ctx.ctx, canvasPos.x, canvasPos.y, size + 4, COLORS.warning, ctx.nowMs);
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
    ctx.ctx.font = '8px "Audiowide", monospace';
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

// ============================================================
// Trajectory-line palette — by relationship, not by owning-faction
// color.
//
// Playtester showed a screenshot with every transfer line in warm
// amber (because most factions in his game had warm-toned palettes)
// and called it "spaghetti." Fix: ignore the owner's faction color
// for transit lines and bucket into THREE roles instead, so the
// player can scan-classify by hue alone:
//
//   - MINE     (your ships):              cyan, prominent
//   - NEUTRAL  (allies / NAPs / peace):   muted sage, dimmed
//   - HOSTILE  (no pact = free-fire):     amber, prominent
//   - INCOMING (hostile, aimed at YOUR
//                body):                   red, pulsing glow,
//                                          drawn last so it
//                                          sits on top.
//
// Convention preserved: SOLID = currently burning. DASHED is set
// by callers for queued / planned legs (drawTorchTrajectory honors
// the isDashed flag).
// ============================================================

export const TRAJECTORY_COLORS = {
  mine:     '#4ecdc4', // cyan — matches the player's existing brand
  neutral:  '#8fb89a', // muted sage — "non-hostile, but not you"
  hostile:  '#ff8a40', // warm amber — "free-fire faction"
  incoming: '#ff3030', // bright red — "aimed at YOUR body"
} as const;

export type TrajectoryRole = 'mine' | 'neutral' | 'hostile';

/** Classify a ship's transit line by relationship to the viewer.
 *  Returns one of the three primary roles; the 'incoming' upgrade
 *  is decided per-target by drawEnemyTrajectoriesLayer. */
export function trajectoryRole(
  ship: Ship,
  playerFactionId: string,
  allies: ReadonlySet<string>,
): TrajectoryRole {
  if (ship.ownedBy === playerFactionId) return 'mine';
  if (allies.has(ship.ownedBy)) return 'neutral';
  return 'hostile';
}

/**
 * Background pass: every ship currently in transit, colored by
 * relationship to the viewer. Owns the "mine" and "neutral" lines;
 * skips hostile ships entirely so drawEnemyTrajectoriesLayer can
 * paint those on top with proper threat treatment (avoids the
 * dim-then-bright re-draw).
 */
export function drawAllTransfersLayer(
  ships: Ship[],
  ctx: RenderContext,
  playerFactionId: string,
  allies: ReadonlySet<string>,
) {
  for (const ship of ships) {
    if (!ship.transit) continue;
    const role = trajectoryRole(ship, playerFactionId, allies);
    if (role === 'hostile') continue; // owned by the next pass

    ctx.ctx.save();
    ctx.ctx.globalAlpha = role === 'mine' ? 0.55 : 0.3;
    ctx.ctx.lineWidth = role === 'mine' ? 1.5 : 1.2;
    drawTorchTrajectory(
      ship.transit.currentTransfer, ctx.bodies, ctx,
      TRAJECTORY_COLORS[role],
      false,
      false,
      ctx.t,           // enable trail fade behind the ship
    );
    ctx.ctx.restore();
  }
}

/**
 * Foreground pass: hostile transit lines (no-pact factions). Lines
 * aimed at a body the viewer owns escalate to bright-red + a soft
 * glow so the player can clock incoming threats at a glance. Honors
 * fog of war via visibleShipIds.
 */
export function drawEnemyTrajectoriesLayer(
  ships: Ship[],
  bodies: Body[],
  visibleShipIds: Set<string>,
  playerFactionId: string,
  allies: ReadonlySet<string>,
  ctx: RenderContext,
) {
  for (const ship of ships) {
    if (trajectoryRole(ship, playerFactionId, allies) !== 'hostile') continue;
    if (!visibleShipIds.has(ship.id)) continue;
    if (!ship.transit) continue;

    const targetBodyId = ship.transit.currentTransfer.targetBodyId;
    const target = bodies.find(b => b.id === targetBodyId);
    const targetOwned = target?.ownedBy === playerFactionId;
    const color = targetOwned ? TRAJECTORY_COLORS.incoming : TRAJECTORY_COLORS.hostile;

    ctx.ctx.save();
    ctx.ctx.globalAlpha = targetOwned ? 0.85 : 0.65;
    ctx.ctx.lineWidth = targetOwned ? 2 : 1.5;
    ctx.ctx.shadowColor = color;
    // shadowBlur is canvas-pixel-based; scale with sqrt(zoom) so it
    // doesn't paint a red smear across the whole inner system at
    // full zoom-out. Matches the destruction-flash treatment.
    const blurFactor = Math.min(1.2, Math.max(0.3, Math.sqrt(ctx.camera.scale)));
    ctx.ctx.shadowBlur = targetOwned ? 8 * blurFactor : 0;
    drawTorchTrajectory(
      ship.transit.currentTransfer, bodies, ctx, color,
      // Solid arc when aimed at me (max urgency); dashed when just
      // passing through hostile-but-not-targeting-me space.
      !targetOwned,
      false,
      ctx.t,           // enable trail fade behind the ship
    );
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
  /** Wall-clock ms when the client first observed the death. */
  startMs: number;
  baseRadius?: number;            // visual size; defaults to 10
  /** Entity id that died — seeds the deterministic death-debris sparks
   *  (combatFx.drawDeathDebris). Optional for back-compat; no id = no
   *  sparks, just the classic flash. */
  id?: string;
}

export function drawDestructionFlashes(
  flashes: DestructionFlash[],
  ctx: RenderContext,
  durationMs?: number,
) {
  // baseRadius is authored as a canvas-pixel reference at "normal" zoom
  // (~10-14 px), and drawDamageFlash blooms it 4-8x into the halo. Left
  // unscaled, that halo stays the same screen size regardless of camera
  // zoom — at full zoom-out, an 80-110 px explosion engulfs entire orbits
  // and dominates the map. Scale by sqrt(scale) with clamps so the flash
  // tracks how big the destroyed entity itself looks — the 0.3 floor
  // keeps a kill visible-but-proportionate at system zoom, matching the
  // fixed-size ship icons rather than swallowing them.
  const sizeFactor = Math.min(1.2, Math.max(0.3, Math.sqrt(ctx.camera.scale)));
  const nowMs = ctx.nowMs ?? performance.now();
  for (const f of flashes) {
    const cp = worldToCanvas(f.pos.x, f.pos.y, ctx);
    drawDamageFlash(
      cp,
      (f.baseRadius ?? 10) * sizeFactor,
      f.startMs,
      nowMs,
      ctx,
      'destruction',
      durationMs,
    );
    // Death debris — 4-6 seeded sparks flying out of the wreck
    // (Workstream B §3). Additive, 400ms wall-clock fade.
    if (f.id) {
      drawDeathDebris(f.id, cp, (f.baseRadius ?? 10) * sizeFactor, ctx);
    }
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

/**
 * @param strength 0..1 multiplier on the whole fog layer. The caller
 *   fades it out as the political wash fades in — at full-system zoom
 *   the fog's 62% dark fill covers nearly everything and was crushing
 *   the wash beneath it, and its main subject (enemy ships) is already
 *   hidden by the LOD out there.
 */
export function drawFogOfWarOverlay(
  rings: Array<{ pos: { x: number; y: number }; range: number }>,
  ctx: RenderContext,
  strength: number = 1,
) {
  if (strength <= 0) return;
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
  // One alpha on the composite scales the wash AND its punched holes
  // together, so a partially-faded fog stays internally consistent.
  ctx.ctx.globalAlpha = ctx.ctx.globalAlpha * Math.min(1, strength);
  ctx.ctx.drawImage(fogOffscreen, 0, 0);
  ctx.ctx.restore();
}

// === Territory halos (far-zoom ownership treatment) ============
// At far zoom the dashed "barber-pole" ownership rings shrink into
// noisy circles; a soft faction-colored radial halo under the body
// reads much better as "this region is theirs". The halo gradient is
// rasterized ONCE per faction color into a small offscreen sprite
// (Map capped at 16 — more colors than any game has factions) and
// scaled with drawImage, so far zoom never allocates gradients
// per-frame.
//
// Mode switching uses hysteresis: halo engages below scale 0.72 and
// disengages above 0.88 (nominal boundary 0.8 ±10%), tracked in a
// module flag so pinch-zooming across the boundary doesn't flicker
// between treatments frame-to-frame.
let territoryHaloMode = false;
const HALO_SPRITE_SIZE = 64;
const HALO_SPRITE_CAP = 16;
const territoryHaloSprites = new Map<string, HTMLCanvasElement>();

function territoryHaloSprite(color: string): HTMLCanvasElement {
  let sprite = territoryHaloSprites.get(color);
  if (sprite) return sprite;
  if (territoryHaloSprites.size >= HALO_SPRITE_CAP) {
    // Evict the oldest entry — insertion order is stable on Map.
    const oldest = territoryHaloSprites.keys().next().value;
    if (oldest !== undefined) territoryHaloSprites.delete(oldest);
  }
  sprite = document.createElement('canvas');
  sprite.width = HALO_SPRITE_SIZE;
  sprite.height = HALO_SPRITE_SIZE;
  const sctx = sprite.getContext('2d');
  if (sctx) {
    const half = HALO_SPRITE_SIZE / 2;
    const hex = color.startsWith('#') ? color : COLORS.neutral;
    const grad = sctx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, withOpacity(hex, 0.9));
    grad.addColorStop(0.55, withOpacity(hex, 0.4));
    grad.addColorStop(1, withOpacity(hex, 0));
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, HALO_SPRITE_SIZE, HALO_SPRITE_SIZE);
  }
  territoryHaloSprites.set(color, sprite);
  return sprite;
}

/**
 * Ownership indicator for each body. Close zoom: the classic dashed
 * "barber-pole" ring just outside the body's render radius. Far zoom
 * (hysteresis around scale 0.8): a soft faction-primary radial halo
 * under the body instead — territory reads as a colored glow region
 * rather than a mess of tiny dashed circles. Unowned bodies get
 * nothing.
 */
export function drawOwnershipLayer(
  bodies: Body[],
  ctx: RenderContext,
) {
  if (!ctx.factions || ctx.factions.length === 0) return;

  // The system-region wash owns territory at far zoom. Once it's fully
  // in, per-body halos would just double-shade the same ground with a
  // second, noisier colour — so fade them out as the wash fades in.
  const regionFade = systemRegionOpacity(systemSpans(ctx));
  if (regionFade >= 1) return;

  // Hysteresis: engage halo < 0.72, back to ring > 0.88; hold the
  // previous mode in between so the boundary never flickers.
  const scale = ctx.camera.scale;
  if (territoryHaloMode) {
    if (scale > 0.88) territoryHaloMode = false;
  } else if (scale < 0.72) {
    territoryHaloMode = true;
  }

  for (const body of bodies) {
    if (!body.ownedBy) continue;
    const faction = ctx.factions.find(f => f.id === body.ownedBy);
    const color = faction?.color || COLORS.neutral;
    // Two-tone (§5): the ownership halo is a barber-pole of the faction's
    // primary + secondary — primary dashes with the secondary filling the
    // gaps on the SAME ring, so a body reads as "theirs" in both colors at
    // a glance. Meaning still lives in the primary; the secondary is the
    // decorative interleave.
    const color2 = faction?.color2 || (faction?.color ? deriveSecondary(faction.color) : color);
    const wp = bodyPosition(body, ctx.t, ctx.bodies);
    const cp = worldToCanvas(wp.x, wp.y, ctx);

    if (territoryHaloMode) {
      const r = body.radius * scale + 10;
      const sprite = territoryHaloSprite(color);
      ctx.ctx.save();
      // Cross-fade against the region wash (see the early-out above).
      ctx.ctx.globalAlpha = ctx.ctx.globalAlpha * 0.18 * (1 - regionFade);
      ctx.ctx.drawImage(sprite, cp.x - r, cp.y - r, r * 2, r * 2);
      ctx.ctx.restore();
      continue;
    }

    const r = Math.max(10, body.radius * scale + 6);
    ctx.ctx.save();
    ctx.ctx.lineWidth = 1.5;
    // Primary dashes.
    ctx.ctx.strokeStyle = withOpacity(color, 0.8);
    ctx.ctx.setLineDash([4, 4]);
    ctx.ctx.lineDashOffset = 0;
    ctx.ctx.beginPath();
    ctx.ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
    ctx.ctx.stroke();
    // Secondary dashes, shifted one dash-length so they sit in the gaps.
    ctx.ctx.strokeStyle = withOpacity(color2, 0.8);
    ctx.ctx.lineDashOffset = 4;
    ctx.ctx.beginPath();
    ctx.ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
    ctx.ctx.stroke();
    ctx.ctx.setLineDash([]);
    ctx.ctx.lineDashOffset = 0;
    ctx.ctx.restore();
  }
}

// ============================================================
// System regions — the strategic shading layer at far zoom.
// ============================================================

// Thresholds are expressed in SPANS — how many screen-heights the whole
// star system covers — NOT raw camera.scale.
//
// camera.scale alone is not a stable measure of "how zoomed out am I":
// SYSTEM_SCALE doubled every heliocentric orbit, so the same framing now
// happens at half the scale. Worse, that only applies to NEW games —
// bodies are copied at seed time, so a game in progress keeps the size it
// was born at, and one hardcoded scale number cannot be right for both.
// Spans is invariant: 1.0 means the system exactly fills the viewport,
// whatever units the world is measured in.

// The band below used to be 0.7 / 1.7 / 2.8. That put the whole overlay
// out of reach of the inner system: framing Sol through Jupiter — the
// most common strategic view — measures ~6.8 spans, because `spans` is
// scaled by the OUTERMOST heliocentric orbit and Sedna sits 18.8x
// further out than Earth. So the political map only appeared once you
// had pulled back past the Kuiper belt, by which point Mercury, Venus
// and Earth are a few pixels of overlapping colour and the wash tells
// you nothing about them. Everything is scaled ~2.43x to start the
// fade-in at that inner-system framing, keeping the original ramp
// proportions (FULL at 0.61x HIDE, DARK at 0.25x) so the feel is
// unchanged — it just reaches the planets people actually fight over.

/** Overlay is fully present at/below this many spans... */
export const SYSTEM_REGION_FULL_SPANS = 4.1;
/** ...and fully faded out at/above this. Between the two it cross-fades,
 *  so there's no hard pop as you zoom. */
export const SYSTEM_REGION_HIDE_SPANS = 6.8;
/** At/below this the wash reaches full strength — a solid political map.
 *  Between here and HIDE the colour deepens continuously, so pulling
 *  further out keeps reading as "more strategic". */
export const SYSTEM_REGION_DARK_SPANS = 1.7;

/**
 * How many screen-heights the star system spans at the current camera.
 * Uses the outermost heliocentric orbit as the system's extent.
 */
export function systemSpans(ctx: RenderContext): number {
  let maxOrbit = 0;
  for (const b of ctx.bodies) {
    const parent = b.parent ? ctx.bodies.find(p => p.id === b.parent) : null;
    if (parent && (parent.type === 'star' || parent.type === 'black_hole')) {
      if (b.orbitRadius > maxOrbit) maxOrbit = b.orbitRadius;
    }
  }
  if (maxOrbit <= 0) return Infinity;
  const viewport = Math.min(ctx.canvas.width, ctx.canvas.height);
  if (viewport <= 0) return Infinity;
  return (maxOrbit * 2 * ctx.camera.scale) / viewport;
}

/** 0 = invisible, 1 = present. This is the FADE (does the layer exist
 *  at all), not its strength — see systemRegionIntensity. Also used to
 *  suppress the per-body ownership halos underneath, so territory
 *  never double-shades. */
export function systemRegionOpacity(spans: number): number {
  if (spans >= SYSTEM_REGION_HIDE_SPANS) return 0;
  if (spans <= SYSTEM_REGION_FULL_SPANS) return 1;
  return (SYSTEM_REGION_HIDE_SPANS - spans)
    / (SYSTEM_REGION_HIDE_SPANS - SYSTEM_REGION_FULL_SPANS);
}

/** 0 = just-appeared (faint tint), 1 = zoomed right out (solid
 *  territory). Drives alpha AND how far the disc holds its colour
 *  before feathering, so a maxed-out region reads as filled ground
 *  rather than a bigger, blurrier glow. */
export function systemRegionIntensity(spans: number): number {
  if (spans <= SYSTEM_REGION_DARK_SPANS) return 1;
  if (spans >= SYSTEM_REGION_HIDE_SPANS) return 0;
  // Ramps from where the layer first APPEARS, not from where it
  // finishes fading in — otherwise the wash sat at its faintest base
  // alpha across the whole fade band and only started gaining colour
  // after it was already fully present, which read as "not there".
  return (SYSTEM_REGION_HIDE_SPANS - spans)
    / (SYSTEM_REGION_HIDE_SPANS - SYSTEM_REGION_DARK_SPANS);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// --- Outer-system falloff --------------------------------------------
//
// A region's painted band scales with its orbit radius twice over: the
// lane is a fraction of the radius (wider) AND the ring's circumference
// grows with it (longer). So a single settlement on a lone Kuiper rock —
// Sedna at the very edge — paints the biggest, most saturated annulus on
// the map, dwarfing a whole held inner system. One rock reads as an
// empire. (Reported live: a faction's lone Sedna holding washing the
// outer map in vivid cyan.)
//
// Fade region alpha with distance from the star so the deep outer system
// is a hint, not a billboard. Keyed PER STAR to its own outermost giant,
// not a hardcoded radius, so it survives the 1x/2x scale split and the
// far Centauri / Cygnus systems (which have no giants and so never fade).

/** Steepen the ramp so the wash drops off FAST once past the giants,
 *  rather than a lazy linear taper that leaves the near-Kuiper half-lit.
 *  >1 = fades harder early. */
const OUTER_FADE_EXP = 1.6;

export interface FadeBand {
  /** At/inside this radius: full strength (the outermost giant). */
  start: number;
  /** At/outside this radius: gone (the star's outermost body). */
  end: number;
}

/**
 * 1.0 inside the giants, ramping to 0 by the star's OUTERMOST BODY.
 *
 * Anchoring the zero point to a real body — not a blind multiple of the
 * giant's radius — is the whole fix: the previous 3.2x multiple put zero
 * at 9600 while the farthest body (Sedna) sat at 7000, so the fade never
 * finished and Sedna's band stayed at ~0.42. Ending exactly at the edge
 * guarantees the deep outer system reaches zero regardless of how the
 * system is scaled or spread.
 *
 * Pure and exported for testing.
 */
export function regionRadialFalloff(midRadius: number, band: FadeBand | undefined): number {
  if (!band || !(band.end > band.start)) return 1;
  if (midRadius <= band.start) return 1;
  if (midRadius >= band.end) return 0;
  const t = (midRadius - band.start) / (band.end - band.start);
  return Math.pow(1 - t, OUTER_FADE_EXP);
}

/**
 * Per-star fade band: start at that star's outermost gas/ice giant, end
 * at its outermost body of any kind. A star with no giants gets an empty
 * band (start === end), which regionRadialFalloff treats as "never fade"
 * — so a giant-less far system is never touched.
 */
function buildFadeReference(bodies: Body[]): Map<string, FadeBand> {
  const giant = new Map<string, number>();
  const outermost = new Map<string, number>();
  for (const b of bodies) {
    if (!b.parent) continue;
    const r = b.orbitRadius ?? 0;
    if (r > (outermost.get(b.parent) ?? 0)) outermost.set(b.parent, r);
    if ((b.type === 'gas_giant' || b.type === 'ice_giant') && r > (giant.get(b.parent) ?? 0)) {
      giant.set(b.parent, r);
    }
  }
  const ref = new Map<string, FadeBand>();
  for (const [star, edge] of outermost) {
    const g = giant.get(star);
    ref.set(star, g != null ? { start: g, end: edge } : { start: edge, end: edge });
  }
  return ref;
}

/** Grey for unowned AND contested — see systemRegions.ts for why
 *  contested deliberately isn't a second faction colour.
 *
 *  Was #7c8f9e, which is a BLUE-grey: against a blue faction it was a
 *  coin flip whether a region was held or empty, which defeats the
 *  entire point of a political map. Pulled to a near-neutral grey so
 *  "nobody's" never reads as a faction colour — least of all blue. */
const REGION_NEUTRAL = '#8c8f92';

// Canvas2D's font parser does NOT resolve CSS var() — an invalid
// declaration is silently DROPPED and the context keeps whatever font
// the previous draw left set. These must stay literal font stacks.
//
// No font-weight: Audiowide ships a single 400 weight, so `bold` yields
// a synthesized faux-bold that smears an already-wide face (App.css
// .title documents the same rule). The heavier read comes from the face
// and the size step over the 8-10px "Audiowide", monospace body labels.
const REGION_FONT_STACK = "'Audiowide', monospace";
const REGION_TITLE_PX = 13;
const REGION_SUB_PX = 10;
/** Gap held between a region label's edge and the body it's anchored to
 *  — enough to clear the body's dot AND the body's own name under it. */
const REGION_LABEL_BODY_CLEARANCE = 38;
/** Title (13px) + owner line (10px) + the gap between them. */
const REGION_LABEL_HEIGHT = 32;

// --- Label sizing vs. available room -------------------------------
//
// Labels were a fixed 13px/10px no matter how much room their band had.
// Zoomed out, the inner system compresses into a couple hundred pixels
// while still hosting four regions (Core, Earth, Mars, Belt) plus a
// dozen body names — so full-size text there is guaranteed to collide,
// and no placement search can fix a label that simply doesn't fit.
//
// So a label is sized to the band it names: thickness on screen is what
// decides whether neighbouring rings' labels can clear each other
// vertically. Thin ring -> small text; zoom in, the ring fattens and the
// text grows back to full size. Driving it off measured thickness rather
// than a hardcoded "inner planets" list means it holds for any layout.
/** Band thickness (screen px) at or above which labels draw full size. */
const REGION_LABEL_FULL_AT = 88;
/** Thickness at or below which they're clamped to the floor scale. */
const REGION_LABEL_MIN_AT = 24;
/** Floor, as a fraction of full size. Below ~0.55 Audiowide stops being
 *  legible against the wash, at which point hiding beats shrinking. */
const REGION_LABEL_MIN_SCALE = 0.55;
/** Thickness below which the owner line is dropped and only the region
 *  name draws. The owner line is the widest thing on the map (~2x the
 *  title), so shedding it is the single biggest de-clutter available;
 *  ownership is still readable from the band's colour. */
const REGION_SUB_HIDE_BELOW = 44;

/** How much to shrink a region's label given its band's screen thickness. */
export function regionLabelScale(bandThicknessPx: number): number {
  if (bandThicknessPx >= REGION_LABEL_FULL_AT) return 1;
  if (bandThicknessPx <= REGION_LABEL_MIN_AT) return REGION_LABEL_MIN_SCALE;
  const t = (bandThicknessPx - REGION_LABEL_MIN_AT)
    / (REGION_LABEL_FULL_AT - REGION_LABEL_MIN_AT);
  return REGION_LABEL_MIN_SCALE + (1 - REGION_LABEL_MIN_SCALE) * t;
}

export interface LabelRect { x: number; y: number; w: number; h: number }

export function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w
      && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Pick a spot for a region's label: ON ITS OWN BAND, at an angle that
 * lands on neither a body nor another region's label.
 *
 * THE RULE THAT MATTERS: a label never leaves the annulus it names. The
 * previous search was allowed to retry at `mid + arc` and `rOuter + arc`
 * and floored the radius at `arc`, which let a crowded label step off its
 * own orbit onto a NEIGHBOUR'S ring. With honest two-line widths that
 * escape hatch became ~140px, and the map ended up with MARS SYSTEM
 * printed next to the sun and THE CORE printed out past Earth — every
 * label naming a ring it wasn't on. A label on the wrong ring is worse
 * than a crowded one: it's actively false.
 *
 * So radius is constrained to the band and the search runs ANGULARLY —
 * a full sweep, alternating either side of the anchor body's bearing, so
 * the label stays near what it names when there's room and walks around
 * the ring when there isn't. Concentric rings resolve crowding by sitting
 * at different clock positions rather than by drifting radially.
 *
 * A disc (rInner ≈ 0, i.e. The Core) has no ring to sit on, so it takes a
 * radius out near its rim — inside its own territory, clear of the star.
 *
 * Nothing clear anywhere: return the candidate with the SMALLEST total
 * overlap rather than the first one tried. A crowded name still beats a
 * missing one, but least-crowded beats arbitrary.
 *
 * Pure and exported so the placement can be tested without a canvas.
 */
export function chooseRegionLabelPos(opts: {
  cx: number; cy: number;
  mid: number; rInner: number; rOuter: number;
  baseAngle: number;
  labelWidth: number;
  /** Box height to reserve. Defaults to the full two-line height. */
  labelHeight?: number;
  clearance: number;
  obstacles: LabelRect[];
}): { x: number; y: number; rect: LabelRect; clear: boolean } {
  const { cx, cy, mid, rInner, rOuter, baseAngle, labelWidth, obstacles } = opts;
  // Shrunk labels reserve a shorter box too, so a small inner-ring name
  // isn't held apart from its neighbours as if it were full height.
  const labelHeight = opts.labelHeight ?? REGION_LABEL_HEIGHT;
  const rectAt = (x: number, y: number): LabelRect => ({
    x: x - labelWidth / 2,
    y: y - labelHeight * 0.47,
    w: labelWidth,
    h: labelHeight,
  });

  // Candidate radii, all inside the band. Inset by half the label so the
  // text sits within its own colour rather than straddling the seam.
  const half = labelHeight / 2;
  const radii: number[] = [];
  if (rInner <= 4) {
    // Disc (The Core): out near the rim so it never covers the star.
    radii.push(Math.max(rOuter * 0.62, 8));
  } else {
    const lo = rInner + half;
    const hi = rOuter - half;
    radii.push(mid);
    if (hi - lo > 6) { radii.push(hi, lo); }
  }

  // Full angular sweep, alternating out from the anchor bearing:
  // 0, -1, +1, -2, +2 … so the nearest clear slot to the anchor wins.
  const STEPS = 72;
  let best: { x: number; y: number; rect: LabelRect; cost: number } | null = null;
  for (const r of radii) {
    if (!(r > 4)) continue;
    for (let i = 0; i < STEPS; i++) {
      const k = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2);
      const a = baseAngle + (k * 2 * Math.PI) / STEPS;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const rect = rectAt(x, y);
      let cost = 0;
      for (const o of obstacles) {
        const ox = Math.min(rect.x + rect.w, o.x + o.w) - Math.max(rect.x, o.x);
        const oy = Math.min(rect.y + rect.h, o.y + o.h) - Math.max(rect.y, o.y);
        if (ox > 0 && oy > 0) cost += ox * oy;
      }
      if (cost === 0) return { x, y, rect, clear: true };
      if (!best || cost < best.cost) best = { x, y, rect, cost };
    }
  }
  const b = best as { x: number; y: number; rect: LabelRect };
  return { x: b.x, y: b.y, rect: b.rect, clear: false };
}

/**
 * Political shading for the zoomed-out map: one soft region per
 * planet system / belt, coloured by its owner.
 *
 * Drawn UNDER bodies and orbits (called early in the frame) so it
 * reads as a background wash rather than a veil over the map.
 */
export function drawSystemRegions(
  regions: SystemRegion[],
  ctx: RenderContext,
) {
  const spans = systemSpans(ctx);
  const fade = systemRegionOpacity(spans);
  if (fade <= 0) return;

  const c = ctx.ctx;
  const scale = ctx.camera.scale;
  // How hard the wash pushes. Ramps as you keep zooming out past the
  // point the layer first appears, so the map slides continuously from
  // "a hint of who's where" to a solid political map.
  const intensity = systemRegionIntensity(spans);

  // Per-star outermost-giant radius, for the outer-system alpha falloff.
  const fadeRef = buildFadeReference(ctx.bodies);

  // Everything a region label must not land on: each body's dot plus the
  // name drawn under it. Region labels are appended as they're placed,
  // so later rings also dodge earlier rings' labels.
  const obstacles: LabelRect[] = [];
  for (const b of ctx.bodies) {
    if (b.destroyedAtTick != null) continue;
    const wp = bodyPosition(b, ctx.t, ctx.bodies);
    const p = worldToCanvas(wp.x, wp.y, ctx);
    if (p.x < -200 || p.y < -200 || p.x > ctx.canvas.width + 200 || p.y > ctx.canvas.height + 200) continue;
    // Body labels are 9px "Audiowide", monospace drawn under the dot; ~5.6px/char is
    // that face's advance width. Approximate on purpose — measuring 58
    // bodies every frame to place a dozen labels isn't worth it, and
    // over-wide boxes only make the search more cautious.
    const w = Math.max(26, b.name.length * 5.6);
    obstacles.push({ x: p.x - w / 2, y: p.y - 12, w, h: 32 });
  }

  for (const region of regions) {
    const owned = region.ownership.kind === 'exclusive';
    const color = owned
      ? (region.ownership as { color: string }).color
      : REGION_NEUTRAL;
    // Owned territory earns more presence than empty space; unowned
    // rubble is barely a stain, just enough to group it. Each tier
    // scales up with intensity, keeping their relative weighting so
    // owned ground still dominates at full strength.
    let baseAlpha = owned
      ? lerp(0.22, 0.70, intensity)
      : region.ownership.kind === 'contested'
        ? lerp(0.16, 0.52, intensity)
        : lerp(0.09, 0.32, intensity);
    // Fade the deep outer system so a lone Kuiper holding stops shouting.
    baseAlpha *= regionRadialFalloff(
      (region.shape.rInner + region.shape.rOuter) / 2,
      fadeRef.get(region.shape.starBodyId),
    );

    c.save();
    c.globalAlpha = c.globalAlpha * fade;

    const shape = region.shape;
    {
      const star = ctx.bodies.find(b => b.id === shape.starBodyId);
      if (!star) { c.restore(); continue; }
      const wp = bodyPosition(star, ctx.t, ctx.bodies);
      const cp = worldToCanvas(wp.x, wp.y, ctx);
      const rIn = shape.rInner * scale;
      const rOut = shape.rOuter * scale;
      const mid = (rIn + rOut) / 2;
      const width = Math.max(rOut - rIn, 6);

      // An annulus as a fat stroked circle — cheaper than a two-arc
      // path fill and it anti-aliases better at thin widths.
      c.strokeStyle = withOpacity(color, baseAlpha);
      c.lineWidth = width;
      c.beginPath();
      c.arc(cp.x, cp.y, mid, 0, Math.PI * 2);
      c.stroke();

      if (region.label) {
        // Put the label on its own ring, NEXT TO the body it names —
        // never on top of it. Anchoring straight at the body's angle put
        // the region name and its owner line directly over the planet
        // and the planet's own label, which is what they collided with.
        // Sliding ALONG the ring keeps the name tied to its band (and
        // keeps a dozen concentric rings from stacking their labels in
        // one column) while leaving the body clear.
        const anchorId = shape.labelAnchorBodyId;
        const anchor = anchorId ? ctx.bodies.find(b => b.id === anchorId) : null;
        let baseAngle = -Math.PI / 2;
        if (anchor) {
          const ap = bodyPosition(anchor, ctx.t, ctx.bodies);
          const dx = ap.x - wp.x;
          const dy = ap.y - wp.y;
          if (Math.hypot(dx, dy) > 1e-6) baseAngle = Math.atan2(dy, dx);
        }
        // Measured, not guessed — "URANUS SYSTEM" needs far more room
        // than "THE CORE", and the search has to know the real box.
        //
        // BOTH lines, not just the title: the owner line ("CONFEDERACY
        // OF INDEPENDENT SYSTEMS") is routinely twice the title's width,
        // so reserving only the title left the wider line overhanging on
        // both sides — which is exactly what was colliding with the
        // neighbouring regions' labels and with body names.
        //
        // Sized to the room this band actually has: a thin inner ring
        // gets small text and drops its owner line, and both come back
        // as you zoom in and the ring fattens. `width` is already the
        // band's screen thickness.
        const labelScale = regionLabelScale(width);
        const showSub = width >= REGION_SUB_HIDE_BELOW;
        const titlePx = REGION_TITLE_PX * labelScale;
        const subPx = REGION_SUB_PX * labelScale;
        c.font = `${titlePx.toFixed(1)}px ${REGION_FONT_STACK}`;
        const titleWidth = c.measureText(region.label.toUpperCase()).width;
        let labelWidth = titleWidth;
        if (showSub) {
          c.font = `${subPx.toFixed(1)}px ${REGION_FONT_STACK}`;
          labelWidth = Math.max(labelWidth, c.measureText(regionSubText(region, owned)).width);
        }
        const labelHeight = showSub
          ? REGION_LABEL_HEIGHT * labelScale
          : titlePx * 1.5;
        const spot = chooseRegionLabelPos({
          cx: cp.x, cy: cp.y,
          mid, rInner: rIn, rOuter: rOut,
          baseAngle,
          labelWidth,
          labelHeight,
          clearance: REGION_LABEL_BODY_CLEARANCE * labelScale,
          obstacles,
        });
        obstacles.push(spot.rect);
        drawRegionLabel(
          region, spot.x, spot.y, color, owned, ctx, fade, intensity,
          labelScale, showSub,
        );
      }
    }
    c.restore();
  }
}

/**
 * Second line under a region's name. Shared by the collision measurement
 * and the draw so the reserved box and the painted text can never
 * disagree — measuring only the title was why "CONFEDERACY OF
 * INDEPENDENT SYSTEMS" (34 chars) overhung a box sized for "JUPITER
 * SYSTEM" (14) and collided with everything around it.
 */
function regionSubText(region: SystemRegion, owned: boolean): string {
  if (owned) return (region.ownership as { factionName: string }).factionName.toUpperCase();
  return region.ownership.kind === 'contested' ? 'CONTESTED' : 'UNCLAIMED';
}

/** Region name, plus the owner when a single faction holds it all. */
function drawRegionLabel(
  region: SystemRegion,
  x: number,
  y: number,
  color: string,
  owned: boolean,
  ctx: RenderContext,
  fade: number,
  intensity: number,
  /** Shrink factor from the band's screen thickness (regionLabelScale). */
  labelScale: number = 1,
  /** Whether there's room for the owner line under the name. */
  showSub: boolean = true,
) {
  const c = ctx.ctx;
  const text = region.label.toUpperCase();
  // Unowned used to print NOTHING, so an empty region and a held one
  // differed only by a hue you had to already know to read. Saying
  // UNCLAIMED outright means the absence of a faction is information
  // rather than something you squint at.
  const sub = regionSubText(region, owned);

  // Labels brighten alongside the fill — at full strength they sit on
  // near-solid colour, where the faint treatment would disappear. Text
  // is lightened rather than left at the fill hue so it separates from
  // the ground it's printed on.
  // NB: lighten() takes a channel MULTIPLIER, not a 0..1 blend — so this
  // ramps 1.0 (untouched) -> 1.5 (brighter), never below 1.
  const ink = owned ? lighten(color, lerp(1, 1.5, intensity)) : REGION_NEUTRAL;
  const titleAlpha = owned ? lerp(0.85, 1, intensity) : lerp(0.5, 0.8, intensity);
  const subAlpha = owned ? lerp(0.6, 0.9, intensity) : lerp(0.45, 0.75, intensity);

  c.save();
  c.globalAlpha = c.globalAlpha * fade;
  c.textAlign = 'center';
  c.textBaseline = 'bottom';
  const titlePx = REGION_TITLE_PX * labelScale;
  const subPx = REGION_SUB_PX * labelScale;
  c.font = `${titlePx.toFixed(1)}px ${REGION_FONT_STACK}`;
  c.fillStyle = withOpacity(ink, titleAlpha);
  c.fillText(text, x, y);
  if (sub && showSub) {
    c.font = `${subPx.toFixed(1)}px ${REGION_FONT_STACK}`;
    c.fillStyle = withOpacity(ink, subAlpha);
    // Rides just under the title, scaling with it.
    c.fillText(sub, x, y + titlePx * 1.08);
  }
  c.restore();
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
  seed: number;    // twinkle phase offset (radians)
}

const BELT_DUST_COUNT = 220;
// Follows SYSTEM_SCALE in worker/factions.js — the belt bodies moved out
// with the rest of the system, so the cosmetic dust annulus has to move
// with them or it would ring empty space where the belt used to be.
const BELT_CENTER_R = 620;
const BELT_HALF_WIDTH = 110;

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
      seed: rand() * Math.PI * 2,
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
  // Twinkle time base — pure-cosmetic flicker uses wall clock (same
  // convention as the damage-flash machinery).
  const nowMs = ctx.nowMs ?? performance.now();
  for (const p of BELT_DUST) {
    const a = p.angle + driftAngle * p.driftMul;
    const wx = Math.cos(a) * p.r;
    const wy = Math.sin(a) * p.r;
    const cp = worldToCanvas(wx, wy, ctx);
    // Clip cheaply: skip if off-canvas.
    if (cp.x < -4 || cp.y < -4 || cp.x > ctx.canvas.width + 4 || cp.y > ctx.canvas.height + 4) continue;
    const size = Math.max(0.6, p.size * Math.min(1.2, Math.sqrt(ctx.camera.scale) * 1.4));
    const twinkle = 0.75 + 0.25 * Math.sin(nowMs / 900 + p.seed);
    ctx.ctx.fillStyle = `rgba(168, 152, 136, ${0.18 * p.shade * twinkle})`;
    ctx.ctx.beginPath();
    ctx.ctx.arc(cp.x, cp.y, size, 0, Math.PI * 2);
    ctx.ctx.fill();
  }
}
