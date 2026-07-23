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
import { bodyPosition, localPositionAt } from '../physics/orbitalMechanics';
import { shipDisplayTick } from './tickPhase';
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

/** Canvas position of a ship for FX endpoints — the point the hull is
 *  ACTUALLY drawn at this frame, so tracers start/land on the moving
 *  sprite rather than a stale orbital point.
 *
 *  Transit ships use the polyline-lerped position the renderer cached
 *  (transitCanvasPos). Parked ships prefer the exact box drawShip
 *  recorded in rc.shipHitboxes — it already carries the cosmetic orbit
 *  spin, tick interpolation AND formation spread. Only when the ship
 *  wasn't individually drawn this frame (LOD-culled) do we recompute,
 *  and then with the SAME display-tick spin the ship layer uses — not
 *  plain rc.t, which lagged behind the spinning hull (the old bug). */
function shipCanvasPos(
  ship: Ship,
  rc: RenderContext,
  transitCanvasPos?: Map<string, { x: number; y: number }>,
): { x: number; y: number } | null {
  if (ship.transit) {
    const cached = transitCanvasPos?.get(ship.id);
    if (cached) return cached;
    const wp = shipWorldPosition(ship, rc.t, rc.bodies);
    return wp ? worldToCanvas(wp.x, wp.y, rc) : null;
  }
  const hb = rc.shipHitboxes?.get(ship.id);
  if (hb) return { x: hb.x, y: hb.y };
  const parent = rc.bodies.find(b => b.id === ship.orbit.parentBodyId);
  if (!parent) return null;
  const pp = bodyPosition(parent, rc.t, rc.bodies);
  const lp = localPositionAt(
    ship.orbit,
    shipDisplayTick(rc.t, ship.orbit.period, rc.nowMs ?? performance.now()),
  );
  return worldToCanvas(pp.x + lp.x, pp.y + lp.y, rc);
}

/** Canvas-space displacement of a parked ship's orbital point over the
 *  next `leadMs` of cosmetic-spin time. Used to LEAD the aim so a bolt
 *  is fired at where the target WILL be when it lands, not where it was.
 *  Parent drift over a few ms is negligible, so only the ship's angle
 *  around its parent matters here. Transit / degenerate → no lead. */
function shipLeadCanvas(
  ship: Ship,
  rc: RenderContext,
  leadMs: number,
): { dx: number; dy: number } {
  if (ship.transit || leadMs <= 0 || !ship.orbit.period) return { dx: 0, dy: 0 };
  const now = rc.nowMs ?? performance.now();
  const p0 = localPositionAt(ship.orbit, shipDisplayTick(rc.t, ship.orbit.period, now));
  const p1 = localPositionAt(ship.orbit, shipDisplayTick(rc.t, ship.orbit.period, now + leadMs));
  // world delta → canvas delta is a pure scale (worldToCanvas translation cancels)
  return { dx: (p1.x - p0.x) * rc.camera.scale, dy: (p1.y - p0.y) * rc.camera.scale };
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
    const tpNow = shipCanvasPos(to, rc, transitCanvasPos);
    if (!fp || !tpNow) continue;
    // Lead the aim by the target's motion over the shot's remaining life,
    // so the impact dot lands ON the moving hull instead of trailing it.
    const lead = shipLeadCanvas(to, rc, TRACER_LIFE_MS - age);
    const tp = { x: tpNow.x + lead.dx, y: tpNow.y + lead.dy };

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
        const tpNow = shipCanvasPos(target, rc, transitCanvasPos);
        if (fp && tpNow) {
          if (!opened) {
            c.save();
            c.globalCompositeOperation = 'lighter';
            opened = true;
          }
          // Bolt travels shooter -> target over BOLT_MS; the eye reads
          // direction, then the beat gives it room to land.
          const k = within / BOLT_MS;
          // Lead the aim by the target's motion over the bolt's REMAINING
          // flight — as k→1 the lead fades to 0 so the head lands on the hull.
          const lead = shipLeadCanvas(target, rc, BOLT_MS * (1 - k));
          const tp = { x: tpNow.x + lead.dx, y: tpNow.y + lead.dy };
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

// ---- authoritative death registry ------------------------------------
// A ship/settlement vanishing from /state is NOT proof it died: under
// real-physics moving orbits it constantly slips in and out of the
// player's (also moving) sensor coverage, and the server omits anything
// out of range. So MapCanvas must only spawn its "destroyed" flash for
// an entity the SERVER chronicled as destroyed. The chronicle drives this
// registry (ship_destroyed → ship id; settlement_destroyed → 'body:<id>')
// and the map's list-diff heuristic checks it before flashing. Without
// this, a ship merely leaving your sensor range read as a kill — an
// explosion at a body where nothing actually died.
const chronicleDeaths = new Map<string, number>();

/** Record that the server chronicled this entity's destruction. */
export function markChronicleDeath(key: string | null | undefined): void {
  if (!key) return;
  if (chronicleDeaths.size > 4000) chronicleDeaths.clear();
  chronicleDeaths.set(key, performance.now());
}

/** Did the server chronicle this entity dead within the recent window?
 *  The death event and the entity's disappearance from /state land in
 *  the same poll, so a few seconds comfortably covers any clock skew. */
export function diedByChronicle(key: string, nowMs: number, windowMs = 6000): boolean {
  const t = chronicleDeaths.get(key);
  return t !== undefined && nowMs - t <= windowMs;
}

// ============================================================
// DISCOVERY BLOOM
// ============================================================
//
// The celebratory beat when a body's secret is revealed. Unlike a blast
// (violent, fast, 500ms), this is a slow, luminous flourish (~1.8s):
// two expanding rings, a soft halo, and a ✦ glyph that rises and fades
// in discovery-purple. Fired through the pendingFx queue so it plays
// only when the player is actually looking at the body — the whole
// point being that discoveries stop going unnoticed.

const DISCOVERY_LIFE_MS = 1800;
const DISCOVERY_RING_PX = 70;
const DISCOVERY_COLOR = '#e879f9';   // matches the EventLog "Discovery" icon
const DISCOVERY_CAP = 12;

interface DiscoveryBloom {
  entryId: string;
  bodyId: string;
  startMs: number;
}

const discoveryBlooms: DiscoveryBloom[] = [];
let discoveryWriteIdx = 0;
const seenDiscoveryIds = new Set<string>();

/**
 * Spawn a discovery bloom at a body. Called from MapCanvas's pending-FX
 * fire callback (so it only fires when on-screen and zoomed in). Deduped
 * by chronicle entry id — the played-set in pendingFx already guarantees
 * once-ever, this is a cheap second guard.
 */
export function spawnDiscoveryBloom(entryId: string, bodyId: string): void {
  if (seenDiscoveryIds.has(entryId)) return;
  if (seenDiscoveryIds.size > 2000) seenDiscoveryIds.clear();
  seenDiscoveryIds.add(entryId);
  const bloom: DiscoveryBloom = { entryId, bodyId, startMs: performance.now() };
  if (discoveryBlooms.length < DISCOVERY_CAP) discoveryBlooms.push(bloom);
  else discoveryBlooms[discoveryWriteIdx] = bloom;
  discoveryWriteIdx = (discoveryWriteIdx + 1) % DISCOVERY_CAP;
}

/** True while any bloom is still animating — lets MapCanvas keep the
 *  render loop alive for the flourish even when nothing else changes. */
export function hasActiveDiscoveryBlooms(nowMs: number): boolean {
  return discoveryBlooms.some(b => nowMs - b.startMs < DISCOVERY_LIFE_MS);
}

export function drawDiscoveryBlooms(rc: RenderContext, nowMs: number): void {
  if (discoveryBlooms.length === 0) return;
  const c = rc.ctx;
  let opened = false;
  for (const bloom of discoveryBlooms) {
    const age = nowMs - bloom.startMs;
    if (age < 0 || age >= DISCOVERY_LIFE_MS) continue;
    const body = rc.bodies.find(b => b.id === bloom.bodyId);
    if (!body) continue;
    const wp = bodyPosition(body, rc.t, rc.bodies);
    const cp = worldToCanvas(wp.x, wp.y, rc);

    if (!opened) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      opened = true;
    }

    const k = age / DISCOVERY_LIFE_MS;         // 0..1
    const easeOut = 1 - (1 - k) * (1 - k);
    const fade = 1 - k;

    // Soft halo — a filled disc that swells then fades, giving the body
    // a moment of glow rather than a hard flash.
    const haloR = 14 + 26 * easeOut;
    const halo = c.createRadialGradient(cp.x, cp.y, 0, cp.x, cp.y, haloR);
    halo.addColorStop(0, withOpacity(DISCOVERY_COLOR, 0.35 * fade));
    halo.addColorStop(1, withOpacity(DISCOVERY_COLOR, 0));
    c.fillStyle = halo;
    c.beginPath();
    c.arc(cp.x, cp.y, haloR, 0, Math.PI * 2);
    c.fill();

    // Two expanding rings, the second lagging, so it reads as a pulse.
    for (let r = 0; r < 2; r++) {
      const rk = Math.max(0, Math.min(1, k * 1.25 - r * 0.22));
      if (rk <= 0 || rk >= 1) continue;
      const rEase = 1 - (1 - rk) * (1 - rk);
      const ringR = 6 + (DISCOVERY_RING_PX - 6) * rEase;
      c.strokeStyle = withOpacity(DISCOVERY_COLOR, 0.8 * (1 - rk));
      c.lineWidth = 2;
      c.beginPath();
      c.arc(cp.x, cp.y, ringR, 0, Math.PI * 2);
      c.stroke();
    }

    // The ✦ glyph: rises a few px and scales up while fading — the
    // signature "something was found here" mark, same as the log icon.
    const gy = cp.y - 4 - 14 * easeOut;
    const scale = 0.8 + 0.9 * easeOut;
    // First third: hold near-full; then fade out.
    const glyphAlpha = k < 0.33 ? 1 : Math.max(0, 1 - (k - 0.33) / 0.67);
    c.save();
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = withOpacity(DISCOVERY_COLOR, glyphAlpha);
    c.font = `${Math.round(16 * scale)}px sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('✦', cp.x, gy);
    c.restore();
  }
  if (opened) c.restore();
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
