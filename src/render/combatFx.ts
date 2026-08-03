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

import { Ship, Settlement } from '../types';
import { shipWorldPosition } from '../game/combat';
import { getShipClass } from '../game/shipClasses';
import { damageProfile, countPart } from '../game/shipParts';
import { settlementWorldPosition } from '../game/settlements';
import { bodyPosition, localPositionAt } from '../physics/orbitalMechanics';
import { shipDisplayTick } from './tickPhase';
import { withOpacity, lighten, COLORS } from './colors';
import { RenderContext, worldToCanvas } from './mapRenderer';
import { hashStr, mulberry32 } from './planetTexture';

/** Armed = actually deals damage (server damagePerTick, else class
 *  default). Settlements only ever fire at armed hostiles — freighters
 *  and other non-combatants are left alone, mirroring the server. */
function shipIsArmed(s: Ship): boolean {
  return (s.damagePerTick ?? getShipClass(s.class).damagePerTick) > 0;
}

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

/** Canvas position of a settlement for FX endpoints. Stations resolve
 *  their orbital point via the same Kepler path the sprite uses
 *  (including the static-angle fallback on mu=0 primaries); cities sit
 *  on their body's surface at surfaceAngle. */
function settlementCanvasPos(
  stl: Settlement,
  rc: RenderContext,
): { x: number; y: number } | null {
  const wp = settlementWorldPosition(stl, rc.t, rc.bodies);
  return wp ? worldToCanvas(wp.x, wp.y, rc) : null;
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

/** Ticks after last_combat_tick that a combatant still counts as
 *  engaged — i.e. the server says it actually fired recently. Matches
 *  the server's AUTO_COMBAT_INTERVAL. Paired with the live-presence
 *  test below: "fired recently" alone would let a ceasefire (stance
 *  hold, a NAP signed mid-brawl) keep shooting. */
const ENGAGED_WINDOW_TICKS = 3;

// A 20s wall-clock cap used to sit here, so the firing visual ran for
// 20s after each observed volley and then went quiet. It existed to
// stop hour-long strobing on slow-tick games ("keeps shooting after
// ship is destroyed") — but it also meant a live battle animated for
// 20s out of every ~3 hours at 1h/tick, when what a fight should do is
// LOOP for as long as it lasts.
//
// It's gone, replaced by the real question: is there still an enemy
// here to shoot at? `hostilePresentFor` below answers that from live
// state, so the loop runs continuously while a fight is genuinely on
// and stops the instant the last hostile dies or leaves — strictly
// tighter than the timer it replaces, since the draw pass already
// refuses to emit a bolt with no target.
/** Bolt flight time — one shot crosses the gap in this long. */
const BOLT_MS = 600;
/** Reload beat after each shot lands, per ship. */
const BEAT_MS = 500;
/** One combatant's full fire cycle: bolt + reload. EVERY engaged
 *  combatant runs this cycle continuously on its own phase offset —
 *  ships in combat fire 100% of the time, staggered so a 12-ship brawl
 *  reads as crossfire, not a metronome or a single-file queue. The
 *  cadence is deliberately slow: this loop plays for HOURS between
 *  ticks, and it must be watchable at hour three exactly as at second
 *  one. */
const SLOT_MS = BOLT_MS + BEAT_MS;
/** Muzzle bloom duration at the start of each bolt. */
const MUZZLE_MS = 130;
/** Impact flash duration after each bolt lands (inside the beat). */
const IMPACT_MS = 220;

// ------------------------------------------------------------
// WEAPON-TYPE READS (player ask: energy and kinetic fire must LOOK
// different). The shooter's damage profile picks the shot:
//   KINETIC — the traveling slug: a faction-colored tracer with a hot
//     head, warm muzzle flash, and a ring+shards impact. (The original
//     bolt, unchanged — it already reads as ballistics.)
//   ENERGY — a charge-then-lance beam: a cyan glow builds at the
//     emitter for CHARGE_MS, then a bright-cored beam snaps across the
//     whole gap and fades, ending in a soft bloom instead of shrapnel.
// Mixed loadouts alternate per volley at their real kinetic/energy
// ratio (seeded on shooter id + volley index, so the mix is steady but
// not a metronome). Settlement guns are kinetic, mirroring the server.
// ------------------------------------------------------------
const ENERGY_COLOR = '#7fd4ff';
const ENERGY_CORE = '#e8fbff';
/** Charge-up portion of an energy shot's BOLT_MS window. */
const CHARGE_MS = 180;

/** Bounded cache of hashStr(id) so per-frame phase/target math never
 *  re-hashes strings in the hot loop. */
const idHashCache = new Map<string, number>();
function idHash(id: string): number {
  let h = idHashCache.get(id);
  if (h === undefined) {
    if (idHashCache.size > 4096) idHashCache.clear();
    h = hashStr(id);
    idHashCache.set(id, h);
  }
  return h;
}
/** One engaged combatant — a ship OR a settlement. Settlements return
 *  fire server-side (SETTLEMENT_DMG + weapons modules) and get their
 *  last_combat_tick stamped just like ships; the FX layer treating
 *  "shooter" as ship-only was why a station brawl looked like a staring
 *  contest. */
interface EngagedCombatant {
  id: string;
  bodyId: string;
  ownedBy: string;
  ship: Ship | null;
  stl: Settlement | null;
}
/** Scratch view + object pool reused across frames — refs are recycled,
 *  so steady-state combat allocates nothing per frame. */
const engagedScratch: EngagedCombatant[] = [];
const engagedPool: EngagedCombatant[] = [];
let engagedTaken = 0;

/** bodyId -> faction ids with a parked ship / a live settlement there.
 *  Rebuilt each frame and used to ask "is an enemy still here?" — the
 *  test that keeps the firing loop running for exactly as long as the
 *  battle does. Entries persist across frames and their Sets are
 *  emptied rather than dropped, so steady-state combat allocates
 *  nothing (module perf rule); the map is bounded by the body count. */
const bodyShipFactions = new Map<string, Set<string>>();
const bodyStlFactions = new Map<string, Set<string>>();

function clearFactionMap(m: Map<string, Set<string>>): void {
  for (const set of m.values()) set.clear();
}

function addFactionAt(m: Map<string, Set<string>>, bodyId: string, faction: string): void {
  let set = m.get(bodyId);
  if (!set) { set = new Set(); m.set(bodyId, set); }
  set.add(faction);
}

/** Is any faction OTHER than `owner` present at this body? */
function hasOtherFaction(m: Map<string, Set<string>>, bodyId: string, owner: string): boolean {
  const set = m.get(bodyId);
  if (!set) return false;
  for (const f of set) if (f !== owner) return true;
  return false;
}

function takeEngaged(
  id: string, bodyId: string, ownedBy: string,
  ship: Ship | null, stl: Settlement | null,
): void {
  let e = engagedPool[engagedTaken];
  if (!e) {
    e = { id, bodyId, ownedBy, ship, stl };
    engagedPool.push(e);
  } else {
    e.id = id; e.bodyId = bodyId; e.ownedBy = ownedBy; e.ship = ship; e.stl = stl;
  }
  engagedTaken++;
  engagedScratch.push(e);
}

/**
 * Planet occlusion for fire lines (endgame juice pass): a bolt whose
 * chord passes through the parent planet's disc used to draw straight
 * THROUGH the planet (playtest screenshot: tracers piercing Oberon).
 * Returns true when the segment fp→tp passes close to the body's CENTER
 * — callers skip that shot.
 *
 * OCCLUSION_CORE (0.55, was 0.92 of the disc) is deliberately permissive.
 * Park orbits are tight (body radius + 2), so from any ship the planet
 * fills a huge slice of sky: at 0.92 the test suppressed every pair more
 * than ~90° apart around the ring, which silenced whole battles (live
 * report: a ten-ship brawl at Uranus drawing a single bolt). Only shots
 * that would skewer the planet through the middle are dropped now;
 * anything grazing the limb draws, which reads fine and keeps the fight
 * legible. Paired with the battle-line sector in MapCanvas, which keeps
 * engaged fleets within line of sight of each other in the first place.
 */
const OCCLUSION_CORE = 0.55;
function occludedByBody(
  fp: { x: number; y: number },
  tp: { x: number; y: number },
  bodyId: string | undefined,
  rc: RenderContext,
): boolean {
  if (!bodyId) return false;
  const body = rc.bodies.find(b => b.id === bodyId);
  if (!body) return false;
  const bp = bodyPosition(body, rc.t, rc.bodies);
  const c = worldToCanvas(bp.x, bp.y, rc);
  const r = Math.max(3, body.radius * rc.camera.scale) * OCCLUSION_CORE;
  const dx = tp.x - fp.x;
  const dy = tp.y - fp.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return false;
  // Closest point on the SEGMENT to the disc center.
  let t = ((c.x - fp.x) * dx + (c.y - fp.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = fp.x + dx * t;
  const py = fp.y + dy * t;
  const d2 = (c.x - px) * (c.x - px) + (c.y - py) * (c.y - py);
  return d2 < r * r;
}

interface Tracer {
  /** Ship OR settlement id — stations return fire too. */
  fromId: string;
  toId: string;
  startMs: number;
}

const tracers: Tracer[] = [];
let tracerWriteIdx = 0;

/** Record a volley. Endpoints may be ship ids or settlement ids —
 *  stations shoot back and get bombarded. Rolling slot reuse — no
 *  realloc after warm-up. */
export function spawnTracer(fromId: string, toId: string, nowMs: number): void {
  if (tracers.length < TRACER_CAP) {
    tracers.push({ fromId, toId, startMs: nowMs });
  } else {
    const t = tracers[tracerWriteIdx];
    t.fromId = fromId;
    t.toId = toId;
    t.startMs = nowMs;
  }
  tracerWriteIdx = (tracerWriteIdx + 1) % TRACER_CAP;
}

/** Resolve a combat FX endpoint id against ships first, settlements
 *  second (ids come from different tables, so no collision in practice;
 *  ship-first keeps the historical behavior for any theoretical tie). */
function resolveCombatant(
  id: string,
  ships: Ship[],
  settlements: Settlement[],
): { ship: Ship | null; stl: Settlement | null; ownedBy: string } | null {
  const ship = ships.find(s => s.id === id);
  if (ship) return { ship, stl: null, ownedBy: ship.ownedBy };
  const stl = settlements.find(s => s.id === id);
  if (stl) return { ship: null, stl, ownedBy: stl.ownedBy };
  return null;
}

/**
 * Draw all live tracers: a 2px additive line from the attacker's
 * current canvas position to the target's, in the ATTACKER's faction
 * primary, with a bright 2.5px head dot at the target end. Alpha
 * fades linearly over the 140ms life. NOT gated by LOD/zoom.
 * Either endpoint may be a settlement — a station returning fire or a
 * city under bombardment reads exactly like ship-vs-ship.
 */
export function drawTracers(
  rc: RenderContext,
  ships: Ship[],
  settlements: Settlement[],
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
    const from = resolveCombatant(tr.fromId, ships, settlements);
    const to = resolveCombatant(tr.toId, ships, settlements);
    if (!from || !to) continue;
    const fp = from.ship
      ? shipCanvasPos(from.ship, rc, transitCanvasPos)
      : settlementCanvasPos(from.stl!, rc);
    const tpNow = to.ship
      ? shipCanvasPos(to.ship, rc, transitCanvasPos)
      : settlementCanvasPos(to.stl!, rc);
    if (!fp || !tpNow) continue;
    // Lead the aim by the target's motion over the shot's remaining life,
    // so the impact dot lands ON the moving hull instead of trailing it.
    // Settlements move slowly enough (surface point / station orbit)
    // that leading them isn't worth the extra Kepler solves.
    const lead = to.ship
      ? shipLeadCanvas(to.ship, rc, TRACER_LIFE_MS - age)
      : { dx: 0, dy: 0 };
    const tp = { x: tpNow.x + lead.dx, y: tpNow.y + lead.dy };
    // Never draw fire THROUGH the planet the fight is around.
    const occluderId = to.ship?.orbit.parentBodyId
      ?? from.ship?.orbit.parentBodyId;
    if (occludedByBody(fp, tp, occluderId, rc)) continue;

    if (!opened) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      opened = true;
    }
    const alpha = 1 - age / TRACER_LIFE_MS;
    const color = factionPrimary(rc, from.ownedBy);
    // Weapon-type read: an energy-majority loadout flashes a cyan lance
    // (wide glow + bright core) instead of the kinetic tracer line.
    const prof = from.ship ? damageProfile(from.ship.parts) : { kinetic: 1, energy: 0 };
    if (prof.energy >= 0.5) {
      c.strokeStyle = withOpacity(ENERGY_COLOR, 0.4 * alpha);
      c.lineWidth = 4;
      c.beginPath();
      c.moveTo(fp.x, fp.y);
      c.lineTo(tp.x, tp.y);
      c.stroke();
      c.strokeStyle = withOpacity(ENERGY_CORE, alpha);
      c.lineWidth = 1.4;
      c.beginPath();
      c.moveTo(fp.x, fp.y);
      c.lineTo(tp.x, tp.y);
      c.stroke();
      c.fillStyle = withOpacity(ENERGY_CORE, alpha);
      c.beginPath();
      c.arc(tp.x, tp.y, 2.5, 0, Math.PI * 2);
      c.fill();
    } else {
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
  settlements: Settlement[],
  nowMs: number,
  currentTick: number,
  transitCanvasPos?: Map<string, { x: number; y: number }>,
): void {
  // Who is actually PRESENT at each body this frame — the live answer to
  // "is this fight still on". Ships under burn have left; dead
  // settlements don't shoot. Built once per frame, then queried per
  // combatant.
  clearFactionMap(bodyShipFactions);
  clearFactionMap(bodyStlFactions);
  for (const s of ships) {
    if (s.transit) continue;
    addFactionAt(bodyShipFactions, s.orbit.parentBodyId, s.ownedBy);
  }
  for (const stl of settlements) {
    if (stl.hp <= 0) continue;
    addFactionAt(bodyStlFactions, stl.bodyId, stl.ownedBy);
  }

  // Collect engaged shooters into the reusable scratch list. Engaged =
  // the server says it fired recently (tick window) AND an enemy is
  // still here to shoot at. The second condition is what lets the
  // animation LOOP for the whole battle instead of timing out, while
  // still cutting the instant the last hostile dies or departs.
  // Settlements join under the same rules — the server stamps their
  // last_combat_tick when they return fire, so a defended world's
  // station visibly shoots back — except that stations only ever engage
  // SHIPS, mirroring the server (no station-vs-station duels).
  engagedScratch.length = 0;
  engagedTaken = 0;
  for (const s of ships) {
    const fired = s.lastCombatTick;
    if (fired === undefined) continue;
    if (currentTick - fired > ENGAGED_WINDOW_TICKS) continue;
    if (s.transit) continue;
    const at = s.orbit.parentBodyId;
    // A hull can trade fire with hostile ships OR bombard a hostile
    // settlement, so either presence keeps it engaged.
    if (!hasOtherFaction(bodyShipFactions, at, s.ownedBy)
        && !hasOtherFaction(bodyStlFactions, at, s.ownedBy)) continue;
    takeEngaged(s.id, at, s.ownedBy, s, null);
  }
  for (const stl of settlements) {
    const fired = stl.lastCombatTick;
    if (fired === undefined) continue;
    if (currentTick - fired > ENGAGED_WINDOW_TICKS) continue;
    if (stl.hp <= 0) continue;
    if (!hasOtherFaction(bodyShipFactions, stl.bodyId, stl.ownedBy)) continue;
    takeEngaged(stl.id, stl.bodyId, stl.ownedBy, null, stl);
  }
  if (engagedScratch.length === 0) return;

  // Battle ambience first (under the fire): contested ring + drifting
  // debris at every body with a live engagement.
  const contestedBodies = new Set<string>();
  for (const e of engagedScratch) contestedBodies.add(e.bodyId);
  drawContestedBodies(rc, contestedBodies, nowMs);

  const c = rc.ctx;
  let opened = false;

  // EVERY engaged combatant fires continuously on its own SLOT_MS cycle,
  // phase-offset by its id hash — the whole fleet shoots 100% of the time
  // it's in combat, staggered so it reads as crossfire (per-ship phases,
  // never a synchronized strobe). Replaces the old one-shooter-at-a-time
  // round robin, which left N-1 ships of a brawl visibly idle.
  for (const shooter of engagedScratch) {
    const within = (nowMs + (idHash(shooter.id) % SLOT_MS)) % SLOT_MS;
    const firing = within < BOLT_MS;
    const impacting = !firing && within < BOLT_MS + IMPACT_MS;
    if (!firing && !impacting) continue;         // mid-reload

    // Target: the SERVER'S stamped engagement (ship.lastTargetId — who
    // this combatant actually shot on its last volley, round-robin
    // single-target model), so the animation shows the real fight, not a
    // cosmetic guess. Falls back to a seeded pick that mirrors the
    // server's PRIORITY tiers (armed ships → civilian ships →
    // settlements) when the stamp is missing or its target is gone/out
    // of the viewer's fog.
    let tShip: Ship | null = null;
    let tStl: Settlement | null = null;
    const stampedId = shooter.ship?.lastTargetId ?? shooter.stl?.lastTargetId;
    if (stampedId) {
      const sHit = ships.find(s =>
        s.id === stampedId && !s.transit
        && s.orbit.parentBodyId === shooter.bodyId
        && s.ownedBy !== shooter.ownedBy);
      if (sHit) tShip = sHit;
      else if (shooter.ship) {
        const stlHit = settlements.find(st =>
          st.id === stampedId && st.hp > 0
          && st.bodyId === shooter.bodyId
          && st.ownedBy !== shooter.ownedBy);
        if (stlHit) tStl = stlHit;
      }
    }
    if (!tShip && !tStl) {
      // Fallback: seeded spread WITHIN the server's top priority tier.
      const sHash = idHash(shooter.id);
      let bestScore = -1;
      let bestArmed = false;
      for (const s of ships) {
        if (s.id === shooter.id || s.transit) continue;
        if (s.orbit.parentBodyId !== shooter.bodyId) continue;
        if (s.ownedBy === shooter.ownedBy) continue;
        // A settlement shooter never draws fire at a non-combatant
        // (freighter / unarmed hull) — mirrors the server's defensive
        // return-fire filter. Ship shooters prefer ARMED hostiles (the
        // server's tier 1) and only fall to civilians when no warship
        // remains.
        const armed = shipIsArmed(s);
        if (!shooter.ship && !armed) continue;
        if (armed !== bestArmed) {
          if (!armed) continue;              // never downgrade the tier
          bestScore = -1; bestArmed = true;  // first armed candidate resets
        }
        const score = (sHash ^ idHash(s.id)) >>> 0;
        if (score > bestScore) { tShip = s; tStl = null; bestScore = score; }
      }
      // Settlements only when NO hostile ship is left — the server never
      // bombards past a live orbit (target priority), so neither does
      // the visual.
      if (!tShip && shooter.ship) {
        for (const stl of settlements) {
          if (stl.bodyId !== shooter.bodyId || stl.hp <= 0) continue;
          if (stl.ownedBy === shooter.ownedBy) continue;
          const score = (sHash ^ idHash(stl.id)) >>> 0;
          if (score > bestScore) { tStl = stl; tShip = null; bestScore = score; }
        }
      }
    }
    if (!tShip && !tStl) continue;

    const fp = shooter.ship
      ? shipCanvasPos(shooter.ship, rc, transitCanvasPos)
      : settlementCanvasPos(shooter.stl!, rc);
    const tpNow = tShip
      ? shipCanvasPos(tShip, rc, transitCanvasPos)
      : settlementCanvasPos(tStl!, rc);
    if (!fp || !tpNow) continue;
    // Planet in the way → hold fire this pass (never shoot THROUGH it).
    if (occludedByBody(fp, tpNow, shooter.bodyId, rc)) continue;

    if (!opened) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      opened = true;
    }
    const color = factionPrimary(rc, shooter.ownedBy);

    // Which weapon fires THIS volley — kinetic slug or energy lance.
    // Settlements + bare/redacted hulls read as pure kinetic (matches
    // damageProfile's neutral default and the server's combat model).
    // Mixed loadouts alternate at their real ratio, seeded per volley so
    // a 50/50 gunboat interleaves rather than strobing.
    const prof = shooter.ship ? damageProfile(shooter.ship.parts) : { kinetic: 1, energy: 0 };
    const volleyIdx = Math.floor((nowMs + (idHash(shooter.id) % SLOT_MS)) / SLOT_MS);
    const energyShot = prof.energy > 0
      && (prof.kinetic === 0 || mulberry32(idHash(shooter.id) ^ volleyIdx)() < prof.energy);

    if (firing && energyShot) {
      // ENERGY LANCE — charge at the emitter, then a full-gap beam.
      // Endpoints recompute every frame, so the beam tracks the moving
      // hull live — no ballistic lead needed.
      const ang = Math.atan2(tpNow.y - fp.y, tpNow.x - fp.x);
      const mx = fp.x + Math.cos(ang) * 4;
      const my = fp.y + Math.sin(ang) * 4;
      if (within < CHARGE_MS) {
        // Charge-up: a cyan glow swelling at the emitter.
        const ck = within / CHARGE_MS;
        c.fillStyle = withOpacity(ENERGY_COLOR, 0.25 + 0.35 * ck);
        c.beginPath();
        c.arc(mx, my, 1.5 + 3.5 * ck, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = withOpacity(ENERGY_CORE, 0.5 * ck);
        c.beginPath();
        c.arc(mx, my, 0.8 + 1.4 * ck, 0, Math.PI * 2);
        c.fill();
      } else {
        // Lance: snaps on fast, holds, fades — wide soft glow under a
        // thin near-white core, unmistakably not a slug.
        const bk = (within - CHARGE_MS) / (BOLT_MS - CHARGE_MS);
        const beamA = bk < 0.2 ? bk / 0.2 : 1 - (bk - 0.2) / 0.8;
        c.strokeStyle = withOpacity(ENERGY_COLOR, 0.35 * beamA);
        c.lineWidth = 4.5;
        c.beginPath();
        c.moveTo(mx, my);
        c.lineTo(tpNow.x, tpNow.y);
        c.stroke();
        c.strokeStyle = withOpacity(ENERGY_CORE, 0.9 * beamA);
        c.lineWidth = 1.4;
        c.beginPath();
        c.moveTo(mx, my);
        c.lineTo(tpNow.x, tpNow.y);
        c.stroke();
        // Emitter stays lit while the beam is on.
        c.fillStyle = withOpacity(ENERGY_CORE, 0.8 * beamA);
        c.beginPath();
        c.arc(mx, my, 2, 0, Math.PI * 2);
        c.fill();
      }
    } else if (firing) {
      // KINETIC SLUG — the traveling bolt (original behavior).
      // Bolt travels shooter -> target over BOLT_MS; the eye reads
      // direction, then the beat gives it room to land.
      const k = within / BOLT_MS;
      // Lead the aim by the target's motion over the bolt's REMAINING
      // flight — as k→1 the lead fades to 0 so the head lands on the
      // hull. Settlement targets drift slowly; no lead needed.
      const lead = tShip
        ? shipLeadCanvas(tShip, rc, BOLT_MS * (1 - k))
        : { dx: 0, dy: 0 };
      const tp = { x: tpNow.x + lead.dx, y: tpNow.y + lead.dy };
      const alpha = 1 - k * 0.6;
      const headX = fp.x + (tp.x - fp.x) * k;
      const headY = fp.y + (tp.y - fp.y) * k;
      const tailK = Math.max(0, k - 0.3);
      const tailX = fp.x + (tp.x - fp.x) * tailK;
      const tailY = fp.y + (tp.y - fp.y) * tailK;

      // Muzzle bloom — a brief hot flash at the gun as the bolt leaves.
      if (within < MUZZLE_MS) {
        const ma = 1 - within / MUZZLE_MS;
        const ang = Math.atan2(tp.y - fp.y, tp.x - fp.x);
        const mx = fp.x + Math.cos(ang) * 4;
        const my = fp.y + Math.sin(ang) * 4;
        c.fillStyle = withOpacity('#ffdca8', 0.55 * ma);
        c.beginPath();
        c.arc(mx, my, 5, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = withOpacity('#fff0c8', 0.9 * ma);
        c.beginPath();
        c.arc(mx, my, 2.2, 0, Math.PI * 2);
        c.fill();
      }

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
    } else if (energyShot) {
      // ENERGY IMPACT. Armor is energy's counter — an armored target
      // SCATTERS the lance: short deflection streaks glancing off the
      // struck side and a dimmed bloom, so "my shots are bouncing"
      // reads on sight. Unarmored targets take the full heat bloom.
      const ik = (within - BOLT_MS) / IMPACT_MS;
      const ia = 1 - ik;
      const armor = tShip ? countPart(tShip.parts, 'armor') : 0;
      const hitAng = Math.atan2(fp.y - tpNow.y, fp.x - tpNow.x);
      if (armor > 0) {
        // Glancing streaks fan back toward the shooter's side.
        const rng = mulberry32(idHash(shooter.id) ^ idHash(tShip!.id) ^ 0x5ca7);
        c.strokeStyle = withOpacity('#fff2d0', 0.75 * ia);
        c.lineWidth = 1.2;
        for (let sp = 0; sp < 3; sp++) {
          const a = hitAng + (rng() - 0.5) * 1.6;
          const r0 = 3 + 5 * ik;
          const r1 = r0 + 5 + 5 * ik;
          c.beginPath();
          c.moveTo(tpNow.x + Math.cos(a) * r0, tpNow.y + Math.sin(a) * r0);
          c.lineTo(tpNow.x + Math.cos(a) * r1, tpNow.y + Math.sin(a) * r1);
          c.stroke();
        }
        c.fillStyle = withOpacity(ENERGY_COLOR, 0.15 * ia);
        c.beginPath();
        c.arc(tpNow.x, tpNow.y, 3 + 5 * ik, 0, Math.PI * 2);
        c.fill();
      } else {
        // Full heat bloom — the lance burning in unopposed.
        const r = 3 + 7 * ik;
        c.fillStyle = withOpacity(ENERGY_COLOR, 0.3 * ia);
        c.beginPath();
        c.arc(tpNow.x, tpNow.y, r, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = withOpacity(ENERGY_CORE, 0.55 * ia);
        c.beginPath();
        c.arc(tpNow.x, tpNow.y, r * 0.45, 0, Math.PI * 2);
        c.fill();
      }
    } else {
      // KINETIC IMPACT. Shields are kinetic's counter — a shielded
      // target flashes a teal ARC SEGMENT on the struck side (the
      // bubble taking the hit) over a muted ring; unshielded targets
      // take the full ring + shrapnel. Mitigation becomes visible.
      const ik = (within - BOLT_MS) / IMPACT_MS;
      const ia = 1 - ik;
      const r = 3 + 8 * ik;
      const shields = tShip ? countPart(tShip.parts, 'shield') : 0;
      if (shields > 0) {
        const hitAng = Math.atan2(fp.y - tpNow.y, fp.x - tpNow.x);
        const hb = rc.shipHitboxes?.get(tShip!.id);
        const bubbleR = Math.max(6, (hb?.r ?? 8) + 2);
        c.strokeStyle = withOpacity('#4ecdc4', 0.85 * ia);
        c.lineWidth = 2 + shields * 0.5;
        c.beginPath();
        c.arc(tpNow.x, tpNow.y, bubbleR, hitAng - 0.65, hitAng + 0.65);
        c.stroke();
        // Faint full bubble so the arc reads as part of a sphere.
        c.strokeStyle = withOpacity('#4ecdc4', 0.2 * ia);
        c.lineWidth = 1;
        c.beginPath();
        c.arc(tpNow.x, tpNow.y, bubbleR, 0, Math.PI * 2);
        c.stroke();
      } else {
        c.strokeStyle = withOpacity(color, 0.7 * ia);
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(tpNow.x, tpNow.y, r, 0, Math.PI * 2);
        c.stroke();
        const rng = mulberry32(idHash(shooter.id) ^ idHash(tShip ? tShip.id : tStl!.id));
        c.fillStyle = withOpacity('#ffdcaa', 0.8 * ia);
        for (let sp = 0; sp < 4; sp++) {
          const ang = rng() * Math.PI * 2;
          c.beginPath();
          c.arc(tpNow.x + Math.cos(ang) * r * 1.25, tpNow.y + Math.sin(ang) * r * 1.25, 1.2, 0, Math.PI * 2);
          c.fill();
        }
      }
    }
  }
  if (opened) c.restore();
}

// ============================================================
// 1.5 BATTLE DAMAGE — persistent "damage was TAKEN" state
// ============================================================
//
// The damage flash is a 900ms halo at the instant HP moves — one blink
// every ~3 hours at 1h/tick, which nobody catches. So damage is ALSO
// rendered as a STATE: any combatant whose last_damaged_tick (server
// stamp, applied as damage lands) is within DAMAGE_SHOW_TICKS keeps
// visible fire + drifting smoke on the hull for that whole window. A
// glance at any point in the hour after a volley reads "this ship WAS
// hit" — no need to witness the hit itself. Crippled hulls (<34% hp)
// stay lit regardless, at reduced severity: they need repair and look
// like it.
//
// Staggered ignition: when several ships take damage on the same tick,
// each hull catches fire on its own id-seeded delay (≤550ms) and ramps
// in over ~450ms — a damaged fleet ignites ship-by-ship, never all on
// one frame. Flicker/smoke phases are id-seeded too, so no two hulls
// burn in lockstep.

/** How long (in ticks, against the fractional display tick) the
 *  damaged state persists after a hit. */
const DAMAGE_SHOW_TICKS = 1;
/** Staggered-ignition timing: per-ship delay cap and ramp-in length. */
const IGNITE_DELAY_MS = 550;
const IGNITE_RAMP_MS = 450;
/** entityId -> { tick, sinceMs }: first wall-clock observation of each
 *  damage stamp, so ignition ramps from when THIS client saw the hit.
 *  Bounded like engagementSeen. */
const damageSeen = new Map<string, { tick: number; sinceMs: number }>();

function battleDamageRamp(id: string, dmgTick: number, nowMs: number): number {
  let seen = damageSeen.get(id);
  if (!seen || seen.tick !== dmgTick) {
    if (damageSeen.size > 600) damageSeen.clear();
    seen = { tick: dmgTick, sinceMs: nowMs };
    damageSeen.set(id, seen);
  }
  const phaseFrac = (idHash(id) % 1000) / 1000;
  return Math.min(1, Math.max(0, (nowMs - (seen.sinceMs + phaseFrac * IGNITE_DELAY_MS)) / IGNITE_RAMP_MS));
}

/** One burning hull/settlement: 1-3 flickering fires + smoke puffs
 *  drifting off the anchor. Cheap — arcs only, no gradients; additive
 *  fires over normal-blend smoke. Severity 0..1 scales everything. */
function drawBurn(
  c: CanvasRenderingContext2D,
  x: number, y: number, baseR: number,
  sev: number, nowMs: number, seed: number,
): void {
  const ph = ((seed % 1000) / 1000) * Math.PI * 2;
  // Smoke first (normal blend, under the fire) — puffs cycling outward.
  const puffs = 2 + Math.round(sev);
  for (let i = 0; i < puffs; i++) {
    const drift = ((nowMs / 1400) + i / puffs + ph) % 1;
    const sx = x + Math.cos(ph + i * 2.4) * baseR * 0.3 + drift * baseR * 0.5;
    const sy = y - drift * baseR * 1.1;
    c.fillStyle = `rgba(48, 54, 62, ${((1 - drift) * 0.25 * sev).toFixed(3)})`;
    c.beginPath();
    c.arc(sx, sy, baseR * (0.22 + drift * 0.3), 0, Math.PI * 2);
    c.fill();
  }
  // Fires (additive) — slow flicker, per-entity phase.
  c.save();
  c.globalCompositeOperation = 'lighter';
  const fires = 1 + Math.round(sev * 2);
  for (let i = 0; i < fires; i++) {
    const a = ph + i * 2.3;
    const fx = x + Math.cos(a) * baseR * 0.4;
    const fy = y + Math.sin(a) * baseR * 0.4;
    const f = 0.55 + 0.45 * Math.sin(nowMs / 130 + i * 2 + ph);
    const r = baseR * (0.28 + 0.18 * sev) * (0.7 + 0.5 * f);
    c.fillStyle = `rgba(255, 150, 50, ${(0.4 * f * sev).toFixed(3)})`;
    c.beginPath();
    c.arc(fx, fy - r * 0.25, r, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = `rgba(255, 240, 190, ${(0.75 * f * sev).toFixed(3)})`;
    c.beginPath();
    c.arc(fx, fy - r * 0.25, r * 0.4, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}

/**
 * Draw the persistent battle-damage state for every recently-hit or
 * crippled combatant. Called from MapCanvas after ships/settlements are
 * drawn, so the burn sits on top of the hull it belongs to. Stateless
 * per frame apart from the bounded first-observation map.
 */
export function drawBattleDamageStates(
  rc: RenderContext,
  ships: Ship[],
  settlements: Settlement[],
  nowMs: number,
  transitCanvasPos?: Map<string, { x: number; y: number }>,
): void {
  const c = rc.ctx;
  for (const s of ships) {
    const maxHp = s.hpMax ?? 0;
    if (maxHp <= 0 || s.hp === undefined) continue;
    const frac = s.hp / maxHp;
    const dmgTick = s.lastDamagedTick;
    const recent = dmgTick !== undefined && rc.t - dmgTick < DAMAGE_SHOW_TICKS;
    const crippled = frac < 0.34;
    if (!recent && !crippled) continue;
    const cp = shipCanvasPos(s, rc, transitCanvasPos);
    if (!cp) continue;
    const sev = Math.max(recent ? 0.5 : 0.25, 1 - frac);
    const ramp = recent ? battleDamageRamp(s.id, dmgTick!, nowMs) : 1;
    if (ramp <= 0.01) continue;
    const baseR = rc.shipHitboxes?.get(s.id)?.r ?? 8;
    drawBurn(c, cp.x, cp.y, Math.max(6, baseR * 0.8), sev * ramp, nowMs, idHash(s.id));
  }
  for (const stl of settlements) {
    if (stl.hp <= 0 || !stl.maxHp) continue;
    const frac = stl.hp / stl.maxHp;
    const dmgTick = stl.lastDamagedTick;
    const recent = dmgTick !== undefined && rc.t - dmgTick < DAMAGE_SHOW_TICKS;
    const crippled = frac < 0.34;
    if (!recent && !crippled) continue;
    const cp = settlementCanvasPos(stl, rc);
    if (!cp) continue;
    const sev = Math.max(recent ? 0.5 : 0.25, 1 - frac);
    const ramp = recent ? battleDamageRamp(stl.id, dmgTick!, nowMs) : 1;
    if (ramp <= 0.01) continue;
    drawBurn(c, cp.x, cp.y, 11, sev * ramp, nowMs, idHash(stl.id));
  }
}

// ============================================================
// 1.7 WRECKS + BATTLE AMBIENCE (endgame juice pass)
// ============================================================
//
// Deaths used to flash for 400ms and vanish — an endgame brawl left no
// trace. Now every chronicled kill leaves a WRECK: a tumbling cluster
// of charred shards drifting slowly off the kill site, fading over six
// minutes of wall clock. And any body with an active engagement gets a
// CONTESTED RING (slow red pulse just outside the traffic lanes — every
// front on the map reads at half a zoom level out) plus a thin field of
// drifting debris motes while the shooting lasts.

/** Wreck lifetime in GAME TICKS (per Lorne: a kill site persists for
 *  two full ticks — hours of wall clock on a live game, so the scar of
 *  a battle is still there when you check back in). Wall clock still
 *  drives the cosmetic tumble/drift; the tick clock owns expiry. */
const WRECK_LIFE_TICKS = 2;
const WRECK_CAP = 48;

interface Wreck {
  id: string;
  x: number;       // world coords at death
  y: number;
  driftAng: number;
  size: number;    // canvas px base
  startMs: number;   // wall clock — cosmetic tumble/drift phase
  startTick: number; // game clock — expiry
}

const wrecks: Wreck[] = [];
let wreckWriteIdx = 0;

/** Register a kill site. Called from MapCanvas right where the
 *  destruction flash spawns (already chronicle-gated, so fog-outs
 *  never leave ghost wrecks). */
export function spawnWreck(
  shipId: string,
  worldPos: { x: number; y: number },
  baseRadius: number,
  nowMs: number,
  nowTick: number,
): void {
  const w: Wreck = {
    id: shipId,
    x: worldPos.x,
    y: worldPos.y,
    driftAng: ((idHash(shipId) % 1000) / 1000) * Math.PI * 2,
    size: Math.max(4, baseRadius * 0.55),
    startMs: nowMs,
    startTick: nowTick,
  };
  if (wrecks.length < WRECK_CAP) wrecks.push(w);
  else wrecks[wreckWriteIdx] = w;
  wreckWriteIdx = (wreckWriteIdx + 1) % WRECK_CAP;
}

/** Charred tumbling shards at every recent kill site. Drawn before
 *  ships so live hulls pass over the debris. */
export function drawWrecks(rc: RenderContext, nowMs: number): void {
  if (wrecks.length === 0) return;
  const c = rc.ctx;
  for (const w of wrecks) {
    // Expiry on the GAME clock (rc.t is the fractional display tick).
    const tickAge = rc.t - w.startTick;
    if (tickAge < 0 || tickAge >= WRECK_LIFE_TICKS) continue;
    const k = Math.max(0, Math.min(1, tickAge / WRECK_LIFE_TICKS));
    const age = nowMs - w.startMs;
    // Slow world-space drift away from the kill point — capped so a
    // two-hour-old wreck hasn't wandered out of the battlefield.
    const drift = Math.min(6, (age / 1000) * 0.05);
    const wx = w.x + Math.cos(w.driftAng) * drift;
    const wy = w.y + Math.sin(w.driftAng) * drift;
    const cp = worldToCanvas(wx, wy, rc);
    // Fade the last third; hold readable before that.
    const alpha = k < 0.66 ? 0.55 : 0.55 * (1 - (k - 0.66) / 0.34);
    const tumble = nowMs / 4000 + w.driftAng;
    const rng = mulberry32(idHash(w.id));
    for (let s = 0; s < 3; s++) {
      const a = tumble + (s * Math.PI * 2) / 3 + rng() * 0.8;
      const d = w.size * (0.35 + rng() * 0.5);
      const sx = cp.x + Math.cos(a) * d;
      const sy = cp.y + Math.sin(a) * d;
      const shard = w.size * (0.3 + rng() * 0.25);
      c.save();
      c.translate(sx, sy);
      c.rotate(a * 1.7);
      c.fillStyle = `rgba(96, 84, 72, ${alpha.toFixed(3)})`;
      c.fillRect(-shard / 2, -shard / 4, shard, shard / 2);
      // Ember glint on one shard, cooling with age.
      if (s === 0 && k < 0.4) {
        c.fillStyle = `rgba(255, 140, 60, ${(alpha * (1 - k / 0.4) * 0.8).toFixed(3)})`;
        c.fillRect(-shard / 4, -shard / 8, shard / 2, shard / 4);
      }
      c.restore();
    }
  }
}

/** Contested ring + drifting battle debris around every body with a
 *  live engagement this frame. Called from drawEngagementFire once the
 *  engaged set is known. */
function drawContestedBodies(
  rc: RenderContext,
  bodyIds: Set<string>,
  nowMs: number,
): void {
  const c = rc.ctx;
  for (const bodyId of bodyIds) {
    const body = rc.bodies.find(b => b.id === bodyId);
    if (!body) continue;
    const bp = bodyPosition(body, rc.t, rc.bodies);
    const cp = worldToCanvas(bp.x, bp.y, rc);
    const planetR = Math.max(4, body.radius * rc.camera.scale);
    const ringR = planetR + Math.max(14, planetR * 0.9);
    // Slow red pulse — a front line you can spot from altitude.
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 700);
    c.save();
    c.strokeStyle = `rgba(255, 80, 80, ${(0.1 + 0.14 * pulse).toFixed(3)})`;
    c.lineWidth = 1.5;
    c.setLineDash([8, 6]);
    c.lineDashOffset = -(nowMs * 0.006) % 14;
    c.beginPath();
    c.arc(cp.x, cp.y, ringR, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    // Battle debris — faint motes drifting through the engagement band
    // while the shooting lasts. Seeded per body; wall-clock drift.
    const rng = mulberry32(idHash(bodyId));
    c.fillStyle = 'rgba(200, 190, 170, 0.22)';
    for (let m = 0; m < 8; m++) {
      const baseA = rng() * Math.PI * 2;
      const rad = planetR * (1.15 + rng() * 1.1);
      const a = baseA + (nowMs / 60000) * (0.4 + rng() * 0.6);
      c.beginPath();
      c.arc(cp.x + Math.cos(a) * rad, cp.y + Math.sin(a) * rad, 0.8 + rng() * 0.8, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }
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

/** Celebratory variant of the bloom — same animation machinery, warm
 *  gold, plus radiating sparks. Used by the recap for the GOOD beats
 *  (a hull delivered, a colony founded, a captain pulled from a wreck),
 *  which previously played no effect at all. */
const FIREWORK_COLOR = '#ffd27a';

interface DiscoveryBloom {
  entryId: string;
  bodyId: string;
  startMs: number;
  /** 'discovery' = purple ✦ find; 'firework' = gold celebration burst. */
  variant: 'discovery' | 'firework';
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
export function spawnDiscoveryBloom(
  entryId: string,
  bodyId: string,
  variant: 'discovery' | 'firework' = 'discovery',
): void {
  if (seenDiscoveryIds.has(entryId)) return;
  if (seenDiscoveryIds.size > 2000) seenDiscoveryIds.clear();
  seenDiscoveryIds.add(entryId);
  const bloom: DiscoveryBloom = { entryId, bodyId, startMs: performance.now(), variant };
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
    const isFirework = bloom.variant === 'firework';
    const color = isFirework ? FIREWORK_COLOR : DISCOVERY_COLOR;

    const haloR = 14 + 26 * easeOut;
    const halo = c.createRadialGradient(cp.x, cp.y, 0, cp.x, cp.y, haloR);
    halo.addColorStop(0, withOpacity(color, 0.35 * fade));
    halo.addColorStop(1, withOpacity(color, 0));
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
      c.strokeStyle = withOpacity(color, 0.8 * (1 - rk));
      c.lineWidth = 2;
      c.beginPath();
      c.arc(cp.x, cp.y, ringR, 0, Math.PI * 2);
      c.stroke();
    }

    // Firework only: radiating spark streaks that shoot out and fade —
    // the bit that reads as a CELEBRATION rather than a detection ping.
    // Angles are fixed (not random) so a replayed scene looks identical.
    if (isFirework) {
      const SPARKS = 10;
      c.lineCap = 'round';
      for (let s = 0; s < SPARKS; s++) {
        const a = (s / SPARKS) * Math.PI * 2 + 0.31;
        // Alternating lengths give the burst a ragged, non-mechanical edge.
        const reach = (s % 2 === 0 ? 1 : 0.66) * DISCOVERY_RING_PX * 0.95;
        const inner = 8 + reach * easeOut * 0.55;
        const outer = 8 + reach * easeOut;
        c.strokeStyle = withOpacity(color, 0.9 * fade * fade);
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(cp.x + Math.cos(a) * inner, cp.y + Math.sin(a) * inner);
        c.lineTo(cp.x + Math.cos(a) * outer, cp.y + Math.sin(a) * outer);
        c.stroke();
      }
      c.lineCap = 'butt';
    }

    // The ✦ glyph: rises a few px and scales up while fading — the
    // signature "something was found here" mark, same as the log icon.
    const gy = cp.y - 4 - 14 * easeOut;
    const scale = 0.8 + 0.9 * easeOut;
    // First third: hold near-full; then fade out.
    const glyphAlpha = k < 0.33 ? 1 : Math.max(0, 1 - (k - 0.33) / 0.67);
    c.save();
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = withOpacity(color, glyphAlpha);
    c.font = `${Math.round(16 * scale)}px sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(isFirework ? '✧' : '✦', cp.x, gy);
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
