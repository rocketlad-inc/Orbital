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
import { makePeaceCheck, PeaceCheck } from '../game/peace';
import { shipWorldPosition } from '../game/combat';
import { getShipClass } from '../game/shipClasses';
import { damageProfile, countPart } from '../game/shipParts';
import { settlementWorldPosition } from '../game/settlements';
import { bodyPosition, localPositionAt } from '../physics/orbitalMechanics';
import { shipDisplayTick, spinNowMs } from './tickPhase';
import { withOpacity, lighten, COLORS } from './colors';
import { RenderContext, worldToCanvas } from './mapRenderer';
import { hashStr, mulberry32 } from './planetTexture';
import { isLightweight } from './lightweightMode';
// The pixels themselves live in fxPrimitives so the battle recap can draw
// the identical bolt, blast, spark and wreck on a canvas that has no map.
import {
  drawBolt, drawBlast, drawDebris, drawWreckShards, drawBurn,
  TRACER_LIFE_MS, DETONATION_LIFE_MS, DEBRIS_LIFE_MS, ENERGY_COLOR, ENERGY_CORE,
} from './fxPrimitives';

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

/**
 * MUST match the off-screen cull in mapRenderer's drawShip (`const m =
 * 100`). That cull skips the icon AND deletes the hitbox for any hull
 * more than this far outside the viewport; this module has to agree
 * about what "off screen" means, or it draws fire for hulls the ship
 * layer declined to render.
 */
const FX_OFFSCREEN_MARGIN = 100;

/**
 * A PARKED hull with no recorded hitbox was not drawn this frame. When
 * other hulls at the same body WERE drawn, that is a per-ship skip (cull,
 * death, future LOD rules) — such a hull must neither fire nor be fired
 * at, or bolts anchor to empty space. When NO hull at the body has a
 * hitbox the whole stack is in cluster-badge mode, and recomputing ring
 * positions around the badge is the long-standing intended fallback.
 */
function undrawnParked(ship: Ship, rc: RenderContext, ships: Ship[]): boolean {
  if (ship.transit) return false;
  if (rc.shipHitboxes?.has(ship.id)) return false;
  for (const o of ships) {
    if (o.id === ship.id || o.transit) continue;
    if (o.orbit.parentBodyId !== ship.orbit.parentBodyId) continue;
    if (rc.shipHitboxes?.has(o.id)) return true;   // neighbours drawn, this one skipped
  }
  return false;                                     // badge mode: recompute allowed
}

function offScreen(p: { x: number; y: number }, rc: RenderContext): boolean {
  const m = FX_OFFSCREEN_MARGIN;
  return p.x < -m || p.y < -m
    || p.x > rc.canvas.width + m || p.y > rc.canvas.height + m;
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
  // SPIN_CLOCK, not rc.nowMs. drawShip drives the cosmetic spin from
  // Date.now() while rc.nowMs is performance.now() — two unrelated
  // epochs feeding the same `nowMs % 180_000` lap fraction, so this
  // fallback placed the hull at an arbitrary, permanently wrong point on
  // its orbit whenever no hitbox was available (a culled hull, or the
  // first frame after a state swap).
  const lp = localPositionAt(
    ship.orbit,
    shipDisplayTick(rc.t, ship.orbit.period, spinNowMs()),
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
  // The SPIN clock, not the animation clock. Leading the aim means
  // sampling the target's own drawn orbit a few ms ahead; sampling a
  // different clock's orbit gives a tangent from the wrong point and
  // aims the bolt in an unrelated direction.
  const now = spinNowMs();
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
// TRACER_LIFE_MS, ENERGY_*, and the blast/debris life spans now live in
// fxPrimitives (imported above) so the map and the recap age an effect
// over the same window and paint it in the same colours.

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
// Like hasOtherFaction, but a peace partner does not count as hostile -
// an ally parked in the same orbit must neither sustain the engagement
// loop nor be eligible to take a drawn bolt.
function hasHostileFaction(
  m: Map<string, Set<string>>, bodyId: string, owner: string,
  peace: PeaceCheck,
): boolean {
  const set = m.get(bodyId);
  if (!set) return false;
  for (const f of set) {
    if (f === owner) continue;
    if (peace(f, owner)) continue;
    return true;
  }
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
// Stars draw their disc at 0.85x physical radius (drawStarBody's size
// budget) — the shared 0.55 was tuned to the OLD sun face and would now
// let bolts cut visibly across the grown disc. 0.8 keeps shots grazing
// the limb while blocking anything through the face: park-ring chords
// between ships 90 degrees apart pass at 12 x cos45 = 8.49 units, just
// clear of 10 x 0.8 = 8.0, so Sol brawls stay lively (the failure mode
// that forced 0.55 for planets in the first place).
const OCCLUSION_CORE_STAR = 0.8;
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
  const r = Math.max(3, body.radius * rc.camera.scale)
    * (body.type === 'star' ? OCCLUSION_CORE_STAR : OCCLUSION_CORE);
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
    // Same rule as the sustained-fire pass: no shot without a visible
    // shooter. These one-shot tracers come from server damage events, so
    // they fire regardless of where the camera happens to be.
    if (offScreen(fp, rc)) continue;
    if (from.ship && undrawnParked(from.ship, rc, ships)) continue;
    if (to.ship && undrawnParked(to.ship, rc, ships)) continue;
    // Lead the aim by the target's motion over the shot's remaining life,
    // so the impact dot lands ON the moving hull instead of trailing it.
    // Settlements move slowly enough (surface point / station orbit)
    // that leading them isn't worth the extra Kepler solves.
    const lead = to.ship
      ? shipLeadCanvas(to.ship, rc, TRACER_LIFE_MS - age)
      : { dx: 0, dy: 0 };
    const tp = { x: tpNow.x + lead.dx, y: tpNow.y + lead.dy };
    // Never draw fire THROUGH the planet the fight is around.
    //
    // Only meaningful for a fight AT a body: `parent_body_id` on a hull
    // in flight names the body it departed, which is nowhere near the
    // line being drawn, so testing against it would occlude bolts at
    // random. The server's own line-of-sight check (R4) has already
    // refused any transit engagement that a body genuinely blocks, so
    // skipping here draws exactly the shots that were allowed to happen.
    const eitherFlying = !!to.ship?.transit || !!from.ship?.transit;
    if (!eitherFlying) {
      const occluderId = to.ship?.orbit.parentBodyId
        ?? from.ship?.orbit.parentBodyId;
      if (occludedByBody(fp, tp, occluderId, rc)) continue;
    }

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
    drawBolt(c, fp.x, fp.y, tp.x, tp.y, color, alpha, prof.energy >= 0.5);
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
// The local pactSetOf/atPeace pair lived here; makePeaceCheck is the
// same thing (identity-cached Set, same key ordering) in the one place
// that now owns the rule. Kept as a local alias so the per-frame call
// sites below read unchanged.
/** Weapon reach per hull, world units. MIRROR of SHIP_RANGE in
 *  worker/transitCombat.js — the renderer must not draw a shot the
 *  server would never let happen. */
const SHIP_TRANSIT_RANGE: Record<string, number> = {
  corvette: 12, frigate: 16, destroyer: 20, freighter: 0, colony: 0,
};

const pactSetOf = makePeaceCheck;
function atPeace(peace: PeaceCheck, a: string, b: string): boolean {
  return peace(a, b);
}

export function drawEngagementFire(
  rc: RenderContext,
  ships: Ship[],
  settlements: Settlement[],
  nowMs: number,
  currentTick: number,
  transitCanvasPos?: Map<string, { x: number; y: number }>,
  pactPairs?: string[],
  transitCombatEnabled?: boolean,
): void {
  // The server never fires between at-peace factions (room.js builds the
  // same nap/defense-pact set) - so neither may the animation. Without
  // this, a fleet legitimately fighting faction A would draw bolts at
  // allied faction B's freighters sharing the orbit (player report:
  // "Why are my ships in battle with my allied ships?").
  const peace = pactSetOf(pactPairs);
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
    // TRANSIT SHOOTERS (DESIGN-transit-combat.md). A hull in flight has
    // no body to be "present at", so none of the presence bookkeeping
    // below means anything for it. What it does have is the server's
    // stamped target — the true pairing, not a guess — so it engages on
    // that alone, or not at all.
    //
    // No fallback picker out here on purpose: the at-a-body fallback
    // spreads fire across "some nearby hostile", and in open space there
    // is no such thing. A missing stamp means draw nothing rather than
    // invent a bolt to a ship that was never shot at.
    if (s.transit) {
      // A flying hull only fires where the RULES let it fire. With
      // transit combat off the server never stamps a volley in flight,
      // so anything reaching here is a leftover: a ship that fired while
      // parked and then departed still carries a fresh last_combat_tick
      // and a last_target_id aimed at the body it fled. For the three
      // ticks of the engaged window it would draw a bolt from open space
      // back at a target it can no longer reach.
      if (!transitCombatEnabled) continue;
      if (!s.lastTargetId) continue;
      if ((s.hp ?? 0) <= 0) continue;
      const tgt = ships.find(t =>
        t.id === s.lastTargetId
        && (t.hp ?? 0) > 0
        && t.ownedBy !== s.ownedBy
        && !atPeace(peace, t.ownedBy, s.ownedBy));
      if (!tgt) continue;
      // NEVER DRAW A BOLT LONGER THAN THE GUN.
      //
      // The stamp says who this hull last shot at; it does not say the
      // shot happened THIS tick or from HERE. A ship that fired while
      // parked and then departed keeps a fresh stamp for the whole
      // engaged window, so without a reach test it draws a tracer from
      // open space back at the body it left — hundreds of units, across
      // half the system.
      //
      // I previously "fixed" this by gating the whole branch on the
      // feature flag, which only hid it until the flag went on. The
      // actual rule is the one the server engages by: a shot needs the
      // target inside the weapon's reach.
      const reach = SHIP_TRANSIT_RANGE[s.class] ?? 0;
      if (reach <= 0) continue;
      const a = shipCanvasPos(s, rc, transitCanvasPos);
      const b = shipCanvasPos(tgt, rc, transitCanvasPos);
      if (!a || !b) continue;
      // Range is a WORLD quantity; the positions here are canvas pixels,
      // so compare in the same space the camera is drawing at.
      if (Math.hypot(a.x - b.x, a.y - b.y) > reach * rc.camera.scale) continue;
      takeEngaged(s.id, s.orbit.parentBodyId, s.ownedBy, s, null);
      continue;
    }
    // DEAD hulls do not fire. A ship destroyed mid-tick lingers in the
    // client list until the next /state poll reconciles, and its
    // lastCombatTick is by definition current — without this check the
    // corpse keeps shooting from a sprite the renderer no longer draws.
    // (Settlements always had the hp gate; ships did not.)
    if ((s.hp ?? 0) <= 0) continue;
    const at = s.orbit.parentBodyId;
    // A hull can trade fire with hostile ships OR bombard a hostile
    // settlement, so either presence keeps it engaged.
    if (!hasHostileFaction(bodyShipFactions, at, s.ownedBy, peace)
        && !hasHostileFaction(bodyStlFactions, at, s.ownedBy, peace)) continue;
    takeEngaged(s.id, at, s.ownedBy, s, null);
  }
  for (const stl of settlements) {
    const fired = stl.lastCombatTick;
    if (fired === undefined) continue;
    if (currentTick - fired > ENGAGED_WINDOW_TICKS) continue;
    if (stl.hp <= 0) continue;
    if (!hasHostileFaction(bodyShipFactions, stl.bodyId, stl.ownedBy, peace)) continue;
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
      // (s.hp ?? 0) > 0: the round-robin concentrates fire, so the tick a
      // hull dies it is THE stamped target of most of the enemy fleet —
      // live case at Sol: 51 shooters stamped on one destroyed destroyer.
      // Until /state reconciles, every one of them aimed at a corpse the
      // renderer no longer draws: bolts converging on empty space.
      // The same-body test is what keeps a stale stamp from drawing a
      // bolt across the system, and it is only meaningful when both
      // parties are parked. Relax it ONLY for a shooter that is itself in
      // flight — it has no body to share, so the server's stamp is the
      // only authority available.
      //
      // Deliberately NOT relaxed for a parked shooter whose target has
      // departed: last_target_id outlives the engagement, so `|| s.transit`
      // would let a hull that stopped shooting draw a bolt across the
      // system at a ship now three planets away — and it would do that
      // with transit combat switched OFF, in every live game.
      const shooterFlying = !!shooter.ship?.transit;
      const sHit = ships.find(s =>
        s.id === stampedId
        && (s.hp ?? 0) > 0
        && (shooterFlying || (!s.transit && s.orbit.parentBodyId === shooter.bodyId))
        && s.ownedBy !== shooter.ownedBy
        && !atPeace(peace, s.ownedBy, shooter.ownedBy));
      if (sHit) tShip = sHit;
      else if (shooter.ship) {
        const stlHit = settlements.find(st =>
          st.id === stampedId && st.hp > 0
          && st.bodyId === shooter.bodyId
          && st.ownedBy !== shooter.ownedBy
          && !atPeace(peace, st.ownedBy, shooter.ownedBy));
        if (stlHit) tStl = stlHit;
      }
    }
    // A transit shooter gets the stamp or nothing — the fallback below
    // picks "some hostile at my body", which for a ship between bodies
    // would draw a bolt at whatever happens to be orbiting where it left.
    if (!tShip && !tStl && shooter.ship?.transit) continue;
    if (!tShip && !tStl) {
      // Fallback: seeded spread WITHIN the server's top priority tier.
      const sHash = idHash(shooter.id);
      let bestScore = -1;
      let bestArmed = false;
      for (const s of ships) {
        if (s.id === shooter.id || s.transit) continue;
        if ((s.hp ?? 0) <= 0) continue;      // dead: see stamp lookup above
        if (s.orbit.parentBodyId !== shooter.bodyId) continue;
        if (s.ownedBy === shooter.ownedBy) continue;
        if (atPeace(peace, s.ownedBy, shooter.ownedBy)) continue;
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
          if (atPeace(peace, stl.ownedBy, shooter.ownedBy)) continue;
          const score = (sHash ^ idHash(stl.id)) >>> 0;
          if (score > bestScore) { tStl = stl; tShip = null; bestScore = score; }
        }
      }
    }
    if (!tShip && !tStl) continue;

    const fp = shooter.ship
      ? shipCanvasPos(shooter.ship, rc, transitCanvasPos)
      : settlementCanvasPos(shooter.stl!, rc);
    // `let`: the occlusion pass below may re-aim at a target that is
    // actually in line of sight.
    let tpNow = tShip
      ? shipCanvasPos(tShip, rc, transitCanvasPos)
      : settlementCanvasPos(tStl!, rc);
    if (!fp || !tpNow) continue;
    // The SHOOTER must be on screen. drawShip culls any hull more than
    // FX_OFFSCREEN_MARGIN px outside the viewport and deletes its
    // hitbox, but shipCanvasPos falls back to recomputing the orbital
    // point — so a culled hull still fired, and the bolt streaked in
    // from past the edge with nothing at its origin. Zoomed onto Sol
    // that is most of the fleet at once: a screen full of fire from
    // ships you cannot see (live report).
    //
    // Only the shooter is gated. A visible ship firing at something
    // beyond the edge reads correctly — the beam leaves frame, which is
    // what shooting at range looks like. It is the ORIGIN that has to
    // exist for the shot to make sense.
    if (offScreen(fp, rc)) continue;
    // Undrawn shooter: the ship layer skipped this hull while drawing its
    // neighbours — nothing on screen for the bolt to leave from.
    if (shooter.ship && undrawnParked(shooter.ship, rc, ships)) continue;

    // Body in the way. Never shoot THROUGH it — but do not hold fire
    // either: pick another hostile that IS in line of sight.
    //
    // Holding fire was fine around a planet and disastrous around a
    // star. Sol has radius 10 and ships park at rp 12-20, so the
    // occlusion disc (radius x 0.55) blots out most of the ring: any
    // pair separated by more than ~125 degrees is blocked, which is
    // ~70% of random pairings at r=12 and ~82% at r=20. With 94 hulls
    // ringing Sol in the live game, most of the fleet simply never fired
    // — reported as "some real ships aren't firing at all".
    //
    // Re-targeting is also the more honest picture: a gunner with a star
    // between it and its assigned target shoots at something it can
    // actually see.
    if ((tShip && undrawnParked(tShip, rc, ships))
        || occludedByBody(fp, tpNow, shooter.bodyId, rc)) {
      let alt: Ship | null = null;
      let altPos: { x: number; y: number } | null = null;
      let altArmed = false;
      for (const s of ships) {
        if (s.id === shooter.id || s.transit) continue;
        if ((s.hp ?? 0) <= 0) continue;      // dead: see stamp lookup above
        if (s.orbit.parentBodyId !== shooter.bodyId) continue;
        if (s.ownedBy === shooter.ownedBy) continue;
        if (atPeace(peace, s.ownedBy, shooter.ownedBy)) continue;
        const armed = shipIsArmed(s);
        // Same tier rule as the primary pick: a settlement never fires
        // on a non-combatant, and an armed target outranks a civilian.
        if (!shooter.ship && !armed) continue;
        if (alt && altArmed && !armed) continue;
        if (undrawnParked(s, rc, ships)) continue;
        const p = shipCanvasPos(s, rc, transitCanvasPos);
        if (!p || occludedByBody(fp, p, shooter.bodyId, rc)) continue;
        alt = s; altPos = p; altArmed = armed;
        if (armed) break;                 // best tier found, stop looking
      }
      if (!alt || !altPos) continue;      // genuinely nothing in sight
      tShip = alt; tStl = null; tpNow = altPos;
    }

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

// drawBurn moved to fxPrimitives (imported above): the battle recap sets
// damaged hulls alight too, and a recap whose fires merely resemble the
// map's fires is a recap of a different game.

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
// Three ticks, per Lorne. On the 1h cadence every live game runs that is
// three hours of visible battlefield, which is the point: at an hour a
// tick, a wreck that lasted one tick was gone before most of the table
// next opened the map. drawWreckShards holds it readable for the first
// two thirds and fades the last, so the third tick is the goodbye rather
// than three ticks of full-strength clutter.
const WRECK_LIFE_TICKS = 3;
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
    // 0.55 made a wreck ~6.6px against a ~24px hull — present, and
    // small enough that Lorne never saw one ("I don't see that in the
    // game"). The 2D recap draws the SAME shards at iconSize * 0.5, so
    // this now matches the version that reads well rather than being a
    // quarter of it.
    size: Math.max(6, baseRadius),
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
    // Fade the last third; hold readable before that. Shards tumble on
    // the wall clock and one keeps an ember that cools with age.
    drawWreckShards(c, cp.x, cp.y, w.size, k, w.id, nowMs);
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
// Blast geometry (core flash, ring, sparks) lives in fxPrimitives; only
// the life span is needed here, to age and retire a queued detonation.


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

/**
 * Every discovery used to fire the SAME purple bloom, so a free
 * destroyer and a free tech level were visually identical. Each kind now
 * gets its own colour, glyph and flourish on top of the shared
 * halo-and-rings machinery.
 */
export type DiscoveryVariant =
  | 'discovery' | 'firework'
  | 'cache' | 'databank' | 'warship' | 'city' | 'stargate';

interface VariantSpec {
  color: string;
  glyph: string;
  /** Extra flourish drawn between the rings and the glyph. */
  flourish?: 'sparks' | 'coins' | 'data' | 'hull' | 'windows' | 'spinup';
}

const VARIANTS: Record<DiscoveryVariant, VariantSpec> = {
  discovery: { color: DISCOVERY_COLOR, glyph: '✦' },
  firework:  { color: FIREWORK_COLOR,  glyph: '✦', flourish: 'sparks' },
  // Gold spilling outward — the cache is pure treasure.
  cache:     { color: '#ffc94d', glyph: '◈', flourish: 'coins' },
  // Cyan characters streaming UP out of the moon: something was read.
  databank:  { color: '#67e8f9', glyph: '⌘', flourish: 'data' },
  // Cold steel and a hard ring — a hull, not a gift.
  warship:   { color: '#cbd5e1', glyph: '▰', flourish: 'hull' },
  // Warm windows igniting in sequence: the lights came back on.
  city:      { color: '#ffd9a0', glyph: '⌂', flourish: 'windows' },
  // The ring powering up, contracting inward to ignition.
  stargate:  { color: '#7fe3ff', glyph: '◎', flourish: 'spinup' },
};

/** Map a revealed secret kind to its bloom variant. Unknown kinds fall
 *  back to the original generic purple find. */
export function discoveryVariantForSecret(kind: string | undefined): DiscoveryVariant {
  switch (kind) {
    case 'resource_cache':    return 'cache';
    case 'ancient_databank':  return 'databank';
    case 'derelict_warship':  return 'warship';
    case 'ancient_city':
    case 'free_collector':    return 'city';
    case 'portal_to_sun':
    case 'warp_gate':         return 'stargate';
    default:                  return 'discovery';
  }
}

interface DiscoveryBloom {
  entryId: string;
  bodyId: string;
  startMs: number;
  variant: DiscoveryVariant;
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
  variant: DiscoveryVariant = 'discovery',
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
    const spec = VARIANTS[bloom.variant] ?? VARIANTS.discovery;
    const color = spec.color;
    const isFirework = spec.flourish === 'sparks';

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

    // ---- per-kind flourishes -------------------------------------
    // All are deterministic (fixed angles / indices, no RNG) so a
    // replayed scene draws identically.
    if (spec.flourish === 'coins') {
      // Treasure spilling: discs arc outward and settle, warm gold.
      const N = 9;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 + 0.4;
        const reach = 16 + 34 * easeOut;
        const drop = 10 * k * k;                       // they fall as they fly
        const r = 2.4 - 1.1 * k;
        c.fillStyle = withOpacity(color, 0.95 * fade);
        c.beginPath();
        c.arc(cp.x + Math.cos(a) * reach, cp.y + Math.sin(a) * reach + drop,
              Math.max(0.4, r), 0, Math.PI * 2);
        c.fill();
      }
    } else if (spec.flourish === 'data') {
      // Characters streaming upward — something was READ off this rock.
      const N = 7;
      c.font = '9px ui-monospace, monospace';
      c.textAlign = 'center';
      for (let i = 0; i < N; i++) {
        const lane = (i - (N - 1) / 2) * 7;
        const stagger = (i % 3) * 0.18;
        const kk = Math.max(0, Math.min(1, k * 1.3 - stagger));
        if (kk <= 0) continue;
        c.fillStyle = withOpacity(color, 0.9 * (1 - kk));
        c.fillText(i % 2 ? '1' : '0', cp.x + lane, cp.y + 10 - 46 * kk);
      }
    } else if (spec.flourish === 'hull') {
      // A hard, fast metallic ring — salvage, not celebration.
      const rk = Math.min(1, k * 1.8);
      c.strokeStyle = withOpacity(color, 0.85 * (1 - rk));
      c.lineWidth = 3 * (1 - rk) + 0.5;
      c.beginPath();
      c.arc(cp.x, cp.y, 8 + 46 * rk, 0, Math.PI * 2);
      c.stroke();
      // Hull silhouette: a blunt wedge that flashes then goes dark.
      const hk = Math.max(0, 1 - k * 2.4);
      if (hk > 0) {
        c.fillStyle = withOpacity(color, 0.55 * hk);
        c.beginPath();
        c.moveTo(cp.x + 15, cp.y);
        c.lineTo(cp.x - 9, cp.y + 7);
        c.lineTo(cp.x - 5, cp.y);
        c.lineTo(cp.x - 9, cp.y - 7);
        c.closePath();
        c.fill();
      }
    } else if (spec.flourish === 'windows') {
      // Lights coming on, one row at a time.
      const COLS = 7;
      for (let i = 0; i < COLS; i++) {
        const lit = k * 1.5 > (i / COLS);
        if (!lit) continue;
        const x = cp.x + (i - (COLS - 1) / 2) * 6;
        for (let row = 0; row < 2; row++) {
          const y = cp.y + 4 - row * 6;
          c.fillStyle = withOpacity(color, 0.9 * fade);
          c.fillRect(x - 1.6, y - 1.6, 3.2, 3.2);
        }
      }
    } else if (spec.flourish === 'spinup') {
      // The gate powering up: a ring contracting inward to ignition,
      // plus four pylon ticks spinning to speed.
      const rk = Math.min(1, k * 1.4);
      c.strokeStyle = withOpacity(color, 0.85 * (1 - rk));
      c.lineWidth = 2;
      c.beginPath();
      c.arc(cp.x, cp.y, 54 - 34 * rk, 0, Math.PI * 2);
      c.stroke();
      const spin = k * Math.PI * 4;
      c.lineCap = 'round';
      for (let i = 0; i < 4; i++) {
        const a = spin + (i * Math.PI) / 2;
        c.strokeStyle = withOpacity(color, 0.9 * fade);
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(cp.x + Math.cos(a) * 16, cp.y + Math.sin(a) * 16);
        c.lineTo(cp.x + Math.cos(a) * 26, cp.y + Math.sin(a) * 26);
        c.stroke();
      }
      c.lineCap = 'butt';
    }

    // The glyph: rises a few px and scales up while fading — the
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
    c.fillText(isFirework ? '✧' : spec.glyph, cp.x, gy);
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

    // Core flash, shockwave ring and seeded sparks — the ship id keys the
    // scatter so every client renders the same blast.
    drawBlast(c, cp.x, cp.y, age / DETONATION_LIFE_MS, det.shipId ?? det.entryId);
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
  // Called straight from mapRenderer's destruction-flash pass rather than
  // the FX block MapCanvas gates, so it needs its own guard.
  if (isLightweight()) return;

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
  const c = rc.ctx;
  c.save();
  c.globalCompositeOperation = 'lighter';
  drawDebris(c, canvasPos.x, canvasPos.y, baseRadius, age / DEBRIS_LIFE_MS, entityId);
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
