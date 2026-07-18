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
import { hashStr, mulberry32 } from './planetTexture';

// Seeded randomness — one shared implementation lives in planetTexture
// (FNV-1a → mulberry32). This module used to carry private copies
// because its branch predated that file; deduped at integration so all
// seeded FX draw from the same stream.

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

// ------------------------------------------------------------
// SUSTAINED ENGAGEMENT FIRE
//
// One-shot tracers on a damage event are effectively invisible in a
// real match: MP tick intervals run 30s–1h, ships only volley every
// AUTO_COMBAT_INTERVAL (3) ticks, and a tracer lives 140ms. On an
// hour-per-tick game that's a seventh of a second of muzzle flash
// every three hours — nobody will ever catch it.
//
// So combat is rendered as a CONTINUOUS STATE, not an event. The
// server stamps `last_combat_tick` on any ship that actually fired
// (worker/room.js firedShipIds), which already accounts for peace
// pacts, stance, cadence and armament — we don't have to re-derive
// hostility client-side. While that stamp is fresh, the shooter
// pulses tracers at its target on a wall-clock duty cycle, so an
// engagement reads as a firefight for as long as it lasts.
// ------------------------------------------------------------

/** Ticks after last_combat_tick that a ship still counts as engaged.
 *  Matches the server's AUTO_COMBAT_INTERVAL so the visual stops when
 *  the shooting does. */
const ENGAGED_WINDOW_TICKS = 3;
/** Wall-clock cap on the firing visual after each OBSERVED volley. The
 *  tick window alone is a trap on slow games: at 1h/tick, "within 3
 *  ticks" kept survivors strobing bolts for HOURS after the last real
 *  exchange (player report: "keeps shooting after ship is destroyed").
 *  Each time we see a ship's lastCombatTick ADVANCE we stamp the
 *  moment; the firing visual runs this long past that stamp, then goes
 *  quiet until the next real volley refreshes it. Fast SP games are
 *  unaffected (volleys re-stamp every few seconds anyway). */
const ENGAGED_VISUAL_MS = 20_000;
/** shipId -> { tick, sinceMs } — the last lastCombatTick we observed
 *  and when we first observed it. Cleared wholesale past 600 entries. */
const engagementSeen = new Map<string, { tick: number; sinceMs: number }>();
/** Bolt flight time — one shot crosses the gap in this long. */
const BOLT_MS = 600;
/** Silence between one ship's shot landing and the next ship's turn. */
const BEAT_MS = 500;
/** One shooter's full turn in the round-robin. */
const SLOT_MS = BOLT_MS + BEAT_MS;
/** Scratch list reused across frames — no per-frame allocation. */
const engagedScratch: Ship[] = [];

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

/**
 * Sustained engagement fire — the visual that actually reads in a live
 * match (see the SUSTAINED ENGAGEMENT FIRE note above).
 *
 * For every ship the server says fired recently, pulse a bolt at a
 * hostile it shares an orbit with. Target choice is deterministic
 * (lowest id among co-located ships of a different owner) so all
 * clients draw the same exchange. Phase is seeded per shooter so a
 * six-ship brawl looks like crossfire instead of a metronome.
 *
 * Stateless: no arrays, no allocation, nothing to prune — it's derived
 * purely from ship state each frame.
 */
export function drawEngagementFire(
  rc: RenderContext,
  ships: Ship[],
  nowMs: number,
  currentTick: number,
  transitCanvasPos?: Map<string, { x: number; y: number }>,
): void {
  // Collect engaged shooters into the reusable scratch list. Engaged =
  // the server says it fired recently (tick window) AND we observed
  // that volley recently on the viewer's clock (ms window) — the
  // second condition is what stops hour-long strobing on slow-tick
  // games; see ENGAGED_VISUAL_MS.
  if (engagementSeen.size > 600) engagementSeen.clear();
  engagedScratch.length = 0;
  for (const s of ships) {
    const fired = s.lastCombatTick;
    if (fired === undefined) continue;
    if (currentTick - fired > ENGAGED_WINDOW_TICKS) continue;
    if (s.transit) continue;
    let seen = engagementSeen.get(s.id);
    if (!seen || seen.tick !== fired) {
      seen = { tick: fired, sinceMs: nowMs };
      engagementSeen.set(s.id, seen);
    }
    if (nowMs - seen.sinceMs > ENGAGED_VISUAL_MS) continue;
    engagedScratch.push(s);
  }
  if (engagedScratch.length === 0) return;

  // Deterministic round-robin order: group by body, then ship id, so
  // every client sees the same firing sequence.
  engagedScratch.sort((a, b) => {
    const ab = a.orbit.parentBodyId, bb = b.orbit.parentBodyId;
    if (ab !== bb) return ab < bb ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });

  const c = rc.ctx;
  let opened = false;

  // Walk each body's run of engaged shooters. Exactly ONE ship per
  // battle fires at a time: the cycle is n slots of (bolt + beat), and
  // the current wall-clock position in the cycle picks whose turn it
  // is — one ship fires, beat, the next fires, repeat. Cycle phase is
  // seeded per body so separate battles aren't in lockstep.
  let i = 0;
  while (i < engagedScratch.length) {
    const bodyId = engagedScratch[i].orbit.parentBodyId;
    let j = i;
    while (j < engagedScratch.length && engagedScratch[j].orbit.parentBodyId === bodyId) j++;
    const n = j - i;

    const cycle = n * SLOT_MS;
    const phase = (nowMs + (hashStr(bodyId) % 10000)) % cycle;
    const slot = Math.floor(phase / SLOT_MS);
    const within = phase - slot * SLOT_MS;

    if (within < BOLT_MS) {
      const shooter = engagedScratch[i + slot];
      // Deterministic target: lowest-id co-located hostile.
      let target: Ship | null = null;
      for (const s of ships) {
        if (s.id === shooter.id || s.transit) continue;
        if (s.orbit.parentBodyId !== bodyId) continue;
        if (s.ownedBy === shooter.ownedBy) continue;
        if (target === null || s.id < target.id) target = s;
      }
      if (target) {
        const fp = shipCanvasPos(shooter, rc, transitCanvasPos);
        const tp = shipCanvasPos(target, rc, transitCanvasPos);
        if (fp && tp) {
          if (!opened) {
            c.save();
            c.globalCompositeOperation = 'lighter';
            opened = true;
          }
          // Bolt travels shooter -> target over BOLT_MS; the eye reads
          // direction, then the beat gives it room to land.
          const k = within / BOLT_MS;
          const alpha = 1 - k * 0.6;
          const color = factionPrimary(rc, shooter.ownedBy);
          const headX = fp.x + (tp.x - fp.x) * k;
          const headY = fp.y + (tp.y - fp.y) * k;
          const tailK = Math.max(0, k - 0.3);
          const tailX = fp.x + (tp.x - fp.x) * tailK;
          const tailY = fp.y + (tp.y - fp.y) * tailK;

          c.strokeStyle = withOpacity(color, alpha);
          c.lineWidth = 2;
          c.beginPath();
          c.moveTo(tailX, tailY);
          c.lineTo(headX, headY);
          c.stroke();

          c.fillStyle = withOpacity(lighten(color, 1.5), alpha);
          c.beginPath();
          c.arc(headX, headY, 2, 0, Math.PI * 2);
          c.fill();
        }
      }
    }
    i = j;
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
