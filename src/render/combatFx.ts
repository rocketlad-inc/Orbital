// ============================================================
// Combat & Event FX — tracers, detonations, debris, arrivals
// ============================================================
//
// All effects here are pure client-side cosmetics driven by diffs the
// client already computes (damage-flash machinery in MapCanvas) or by
// chronicle events the client already polls. Zero server work.
//
// Perf rules (DESIGN-graphics-pass.md):
//   - additive glow via save / globalCompositeOperation:'lighter' / restore
//   - wall-clock timing via performance.now() (pure cosmetic flicker)
//   - rolling fixed-cap arrays with slot reuse — no per-frame realloc
//   - seeded determinism via hashStr → mulberry32 keyed on stable ids

import { Ship } from '../types';
import { shipWorldPosition } from '../game/combat';
import { bodyPosition } from '../physics/orbitalMechanics';
import { withOpacity, lighten, COLORS } from './colors';
import { RenderContext, worldToCanvas } from './mapRenderer';

// ------------------------------------------------------------
// Seeded randomness — hashStr → mulberry32.
// NOTE for the integrator: Workstream C introduces the same pair in
// src/render/planetTexture.ts; these local copies exist so this
// workstream compiles standalone. Dedupe on merge if desired.
// ------------------------------------------------------------

export function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Faction primary for an owner id, with the same fallback rule the
 *  ship layer uses (player = cyan, anything else = red). */
function factionPrimary(rc: RenderContext, ownerId: string): string {
  if (rc.factions) {
    const f = rc.factions.find(fa => fa.id === ownerId);
    if (f?.color) return f.color;
  }
  return ownerId === 'player' ? COLORS.neutral : COLORS.danger;
}

/** Canvas position of a ship for FX endpoints. Transit ships prefer the
 *  exact polyline-lerped canvas position the renderer drew this frame
 *  (transitCanvasPos, populated by MapCanvas); everything else goes
 *  through the same orbit math the ship layer uses (shipWorldPosition
 *  = parent bodyPosition + localPositionAt). */
function shipCanvasPos(
  ship: Ship,
  rc: RenderContext,
  transitCanvasPos?: Map<string, { x: number; y: number }>,
): { x: number; y: number } | null {
  if (ship.transit && transitCanvasPos) {
    const cached = transitCanvasPos.get(ship.id);
    if (cached) return cached;
  }
  const wp = shipWorldPosition(ship, rc.t, rc.bodies);
  if (!wp) return null;
  return worldToCanvas(wp.x, wp.y, rc);
}

// ============================================================
// 1. TRACER FIRE
// ============================================================
//
// MapCanvas detects volleys the same way it detects damage flashes:
// a ship's lastDamagedTick advanced between state polls → some hostile
// armed ship at the same body fired. The attacker is chosen
// deterministically (lowest ship id among armed hostiles at the body)
// so every client renders the same tracer. Always visible at any zoom
// — combat readability trumps LOD.

const TRACER_CAP = 64;
const TRACER_LIFE_MS = 140;

interface Tracer {
  fromShipId: string;
  toId: string;
  startMs: number;
}

const tracers: Tracer[] = [];
let tracerWriteIdx = 0;

/** Record a volley. Rolling slot reuse — no realloc after warm-up. */
export function spawnTracer(fromShipId: string, toId: string, nowMs: number): void {
  if (tracers.length < TRACER_CAP) {
    tracers.push({ fromShipId, toId, startMs: nowMs });
  } else {
    const t = tracers[tracerWriteIdx];
    t.fromShipId = fromShipId;
    t.toId = toId;
    t.startMs = nowMs;
  }
  tracerWriteIdx = (tracerWriteIdx + 1) % TRACER_CAP;
}

/**
 * Draw all live tracers: a 2px additive line from the attacker's
 * current canvas position to the target's, in the ATTACKER's faction
 * primary, with a bright 2.5px head dot at the target end. Alpha
 * fades linearly over the 140ms life. NOT gated by LOD/zoom.
 */
export function drawTracers(
  rc: RenderContext,
  ships: Ship[],
  nowMs: number,
  transitCanvasPos?: Map<string, { x: number; y: number }>,
): void {
  if (tracers.length === 0) return;
  const c = rc.ctx;
  let opened = false;
  for (let i = 0; i < tracers.length; i++) {
    const tr = tracers[i];
    const age = nowMs - tr.startMs;
    if (age < 0 || age >= TRACER_LIFE_MS) continue;
    const from = ships.find(s => s.id === tr.fromShipId);
    const to = ships.find(s => s.id === tr.toId);
    if (!from || !to) continue;
    const fp = shipCanvasPos(from, rc, transitCanvasPos);
    const tp = shipCanvasPos(to, rc, transitCanvasPos);
    if (!fp || !tp) continue;

    if (!opened) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      opened = true;
    }
    const alpha = 1 - age / TRACER_LIFE_MS;
    const color = factionPrimary(rc, from.ownedBy);
    c.strokeStyle = withOpacity(color, alpha);
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(fp.x, fp.y);
    c.lineTo(tp.x, tp.y);
    c.stroke();
    // Bright head dot at the impact end — reads as the shell landing.
    c.fillStyle = withOpacity(lighten(color, 1.5), alpha);
    c.beginPath();
    c.arc(tp.x, tp.y, 2.5, 0, Math.PI * 2);
    c.fill();
  }
  if (opened) c.restore();
}

// ============================================================
// 2. DETONATOR BLAST
// ============================================================
//
// Triggered from the chronicle: when a ship_detonated event with an
// unseen entry id shows up in the /state poll, the provider calls
// enqueueDetonation. The renderer drains the rolling array each frame.
// Position resolves to the event's body each frame so the blast rides
// the body as it orbits.

const DETONATION_CAP = 16;
const DETONATION_LIFE_MS = 500;
const DETONATION_CORE_MS = 60;
const DETONATION_RING_PX = 48;
const DETONATION_SPARKS = 6;
const DETONATION_SPARK_DIST = 30;

interface Detonation {
  entryId: string;
  bodyId: string | null;
  shipId: string | null;
  startMs: number;
}

const detonations: Detonation[] = [];
let detonationWriteIdx = 0;
/** Chronicle entry ids already turned into a blast — the /state poll
 *  returns a rolling window, so the same entry reappears many times. */
const seenDetonationIds = new Set<string>();

/**
 * Module-level FX queue entry point — called from the provider where
 * chronicle events are deserialized (MultiplayerGameProvider). Safe to
 * call repeatedly with the same entry; deduped by entry id.
 */
export function enqueueDetonation(
  entryId: string,
  bodyId: string | null,
  shipId: string | null,
): void {
  if (seenDetonationIds.has(entryId)) return;
  if (seenDetonationIds.size > 4000) seenDetonationIds.clear();
  seenDetonationIds.add(entryId);
  const det: Detonation = { entryId, bodyId, shipId, startMs: performance.now() };
  if (detonations.length < DETONATION_CAP) {
    detonations.push(det);
  } else {
    detonations[detonationWriteIdx] = det;
  }
  detonationWriteIdx = (detonationWriteIdx + 1) % DETONATION_CAP;
}

/**
 * Draw live detonator blasts: 60ms white core flash, an expanding
 * additive shockwave ring out to ~48px over 500ms, and 6 debris sparks
 * on deterministic angles (seeded from the detonated ship's id) flying
 * outward 30px while fading.
 */
export function drawDetonations(rc: RenderContext, nowMs: number): void {
  if (detonations.length === 0) return;
  const c = rc.ctx;
  let opened = false;
  for (let i = 0; i < detonations.length; i++) {
    const det = detonations[i];
    const age = nowMs - det.startMs;
    if (age < 0 || age >= DETONATION_LIFE_MS) continue;
    if (!det.bodyId) continue;
    const body = rc.bodies.find(b => b.id === det.bodyId);
    if (!body) continue;
    const wp = bodyPosition(body, rc.t, rc.bodies);
    const cp = worldToCanvas(wp.x, wp.y, rc);

    if (!opened) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      opened = true;
    }

    const k = age / DETONATION_LIFE_MS;
    const easeOut = 1 - (1 - k) * (1 - k);

    // White core flash — first 60ms only.
    if (age < DETONATION_CORE_MS) {
      const coreAlpha = 1 - age / DETONATION_CORE_MS;
      c.fillStyle = `rgba(255, 255, 255, ${coreAlpha})`;
      c.beginPath();
      c.arc(cp.x, cp.y, 10, 0, Math.PI * 2);
      c.fill();
    }

    // Expanding shockwave ring.
    const ringR = 4 + (DETONATION_RING_PX - 4) * easeOut;
    c.strokeStyle = `rgba(255, 230, 190, ${0.9 * (1 - k)})`;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(cp.x, cp.y, ringR, 0, Math.PI * 2);
    c.stroke();

    // Debris sparks — deterministic angles seeded from the ship id so
    // every client renders the same scatter.
    const rng = mulberry32(hashStr(det.shipId ?? det.entryId));
    const sparkDist = DETONATION_SPARK_DIST * easeOut;
    c.fillStyle = `rgba(255, 200, 140, ${1 - k})`;
    for (let s = 0; s < DETONATION_SPARKS; s++) {
      const ang = rng() * Math.PI * 2;
      const sx = cp.x + Math.cos(ang) * sparkDist;
      const sy = cp.y + Math.sin(ang) * sparkDist;
      c.beginPath();
      c.arc(sx, sy, 1.5, 0, Math.PI * 2);
      c.fill();
    }
  }
  if (opened) c.restore();
}

// ============================================================
// 3. SHIP DEATH DEBRIS
// ============================================================
//
// Extends the existing 'destruction' flash: 4-6 tiny sparks on angles
// seeded from the entity id, flying outward and fading over 400ms of
// wall clock (the flash itself is tick-based; sparks are pure cosmetic
// flicker, so they use the wall clock per the design doc's time-base
// rule). Called from drawDestructionFlashes per flash.

const DEBRIS_LIFE_MS = 400;
/** First wall-clock ms each destruction flash was drawn — the flash
 *  map itself only carries a startTick. Pruned by age; hard cap keeps
 *  a long bloody campaign from growing the map unboundedly. */
const debrisStartMs = new Map<string, number>();

export function drawDeathDebris(
  entityId: string,
  canvasPos: { x: number; y: number },
  baseRadius: number,
  rc: RenderContext,
): void {
  const nowMs = rc.nowMs ?? performance.now();
  let start = debrisStartMs.get(entityId);
  if (start === undefined) {
    if (debrisStartMs.size > 128) debrisStartMs.clear();
    debrisStartMs.set(entityId, nowMs);
    start = nowMs;
  }
  const age = nowMs - start;
  if (age >= DEBRIS_LIFE_MS) {
    debrisStartMs.delete(entityId);
    return;
  }
  const k = age / DEBRIS_LIFE_MS;
  const easeOut = 1 - (1 - k) * (1 - k);
  const rng = mulberry32(hashStr(entityId));
  const count = 4 + Math.floor(rng() * 3); // 4-6, seeded
  const dist = baseRadius * 0.6 + (baseRadius * 1.4 + 12) * easeOut;

  const c = rc.ctx;
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.fillStyle = `rgba(255, 210, 150, ${1 - k})`;
  for (let s = 0; s < count; s++) {
    const ang = rng() * Math.PI * 2;
    const size = 1 + rng(); // 1-2px
    const sx = canvasPos.x + Math.cos(ang) * dist;
    const sy = canvasPos.y + Math.sin(ang) * dist;
    c.beginPath();
    c.arc(sx, sy, size / 2 + 0.5, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}

// ============================================================
// 4. ARRIVAL FLASH
// ============================================================
//
// MapCanvas diffs transit presence between polls the same way it diffs
// hp: a ship that had .transit last frame and is orbiting this frame
// just arrived. One soft expanding ring in the OWNER's primary at 30%
// alpha over 350ms. Friendly, not alarming — no additive blend needed,
// it's a soft ring, not a glow.

const ARRIVAL_CAP = 32;
const ARRIVAL_LIFE_MS = 350;

interface ArrivalFlash {
  shipId: string;
  startMs: number;
}

const arrivals: ArrivalFlash[] = [];
let arrivalWriteIdx = 0;

export function spawnArrivalFlash(shipId: string, nowMs: number): void {
  if (arrivals.length < ARRIVAL_CAP) {
    arrivals.push({ shipId, startMs: nowMs });
  } else {
    const a = arrivals[arrivalWriteIdx];
    a.shipId = shipId;
    a.startMs = nowMs;
  }
  arrivalWriteIdx = (arrivalWriteIdx + 1) % ARRIVAL_CAP;
}

export function drawArrivalFlashes(
  rc: RenderContext,
  ships: Ship[],
  nowMs: number,
): void {
  if (arrivals.length === 0) return;
  const c = rc.ctx;
  for (let i = 0; i < arrivals.length; i++) {
    const a = arrivals[i];
    const age = nowMs - a.startMs;
    if (age < 0 || age >= ARRIVAL_LIFE_MS) continue;
    const ship = ships.find(s => s.id === a.shipId);
    if (!ship) continue;
    const cp = shipCanvasPos(ship, rc);
    if (!cp) continue;
    const k = age / ARRIVAL_LIFE_MS;
    const easeOut = 1 - (1 - k) * (1 - k);
    const r = 6 + 18 * easeOut;
    const color = factionPrimary(rc, ship.ownedBy);
    c.strokeStyle = withOpacity(color, 0.3 * (1 - k));
    c.lineWidth = 2;
    c.beginPath();
    c.arc(cp.x, cp.y, r, 0, Math.PI * 2);
    c.stroke();
  }
}
