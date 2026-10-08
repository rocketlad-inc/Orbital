// ============================================================
// battleLayoutLive — the whole-orbit battle layout on the LIVE map.
//
// The prototype (orbitBattleLayout, /?battle) is the placement; this is
// how the map uses it, under the rule Lorne approved on the test page
// (2026-10-06): "fixing the scale of the ships to the planet, and
// shrinking them in position as you zoom out and replace with the icon".
//
// SOLVE ONCE, SCALE EVERYTHING. A battle is laid out once, in REFERENCE
// pixels: the world drawn at battleReferenceRadius(its true radius), every
// hull at its full map size (shipIconSize). At draw time the whole fight
// is multiplied by k = (the world's drawn radius now) / (reference): the
// places, the sprites, the escort blocks, the station. Zooming is then a
// camera on the battle: nothing re-spreads, so a layout with no overlaps
// has none at any zoom, and far out the hulls fold into the world's count
// badge on the usual hull-reveal rule. (The first no-overlap attempt,
// orbital lanes 2026-10-02, re-solved from zoom-dependent pixel sizes
// every frame and ships jumped while zooming. This never does.)
//
// STICKY. A layout is cached per world on a roster signature, so it is
// re-solved only when hulls arrive, leave or change fleets; and each
// unit GLIDES to a new place rather than jumping when that happens.
//
// Pure and free of the renderer (sizes come in from the caller), so the
// map, the tests and the test page share it without an import cycle.
// ============================================================

import { layoutOrbitBattle, CLEAR_FRAC, type OBLayout, type OBShip } from './orbitBattleLayout';
import {
  escortSpacingFor, escortStandoffFor, escortOffsets, escortGlyphFor,
} from './fleetGrouping';

/** One full turn of the whole battle around its world, ms. */
export const BATTLE_TURN_MS = 240000;
/** A station's drawn width at full size (88-unit art x STATION_STRUCTURE_SCALE). */
export const BATTLE_STATION_PX = 200;
/** How fast a unit glides to a new place, ms (time constant). */
const GLIDE_MS = 260;
/** Sprites grow with the world up to this many times full size, then
 *  hold. Places keep scaling (so the fight stays clear of the disc);
 *  only the hulls stop growing, which can only open space, never close
 *  it. Without it the world menu's close zoom drew hulls 3-5x full size. */
export const BATTLE_SPRITE_MAX_K = 2;

/** The sprite scale for a layout scale k. */
export function battleSpriteScale(k: number): number {
  return Math.min(k, BATTLE_SPRITE_MAX_K);
}
/** SHIP_MIN_HIT_RADIUS in mapRenderer: the floor under a hull's hit radius. */
const MIN_HIT_R = 12;

/**
 * The world's drawn radius, px, at which its battle is laid out with every
 * hull at full size. Grows with the square root of the world's TRUE radius
 * (world units), so a giant gives a fight more room than a moon without a
 * moon's battle becoming a speck: Mars (2.5) 150px, Jupiter (8) about 270,
 * a small moon about 65. The test page's worlds sit on the same curve.
 */
export function battleReferenceRadius(bodyRadius: number): number {
  return Math.max(60, Math.min(320, 95 * Math.sqrt(Math.max(0.05, bodyRadius || 0))));
}

/**
 * A fleet marker's block at full size, measured with the SAME calls and
 * constants MapCanvas's marker pass uses (spacing from the flagship's hit
 * radius, escorts astern, each escort its class's size relative to a
 * destroyer slot). `escortRel` is each escort's size as a fraction of the
 * slot (capped at 1, as drawEscortHull does).
 *
 * The layout places the block's CENTRE; the flagship sits `flagX, flagY`
 * from it in the fleet's frame (forward +x), and `clearR` covers it all.
 */
export interface BlockGeometry {
  hr: number;
  spacing: number;
  standoff: number;
  glyph: number;
  flagX: number;
  flagY: number;
  clearR: number;
}
/** Fleet escorts are drawn half again bigger than the slot rule gave
 *  (Lorne, 2026-10-06: "increase the size of ships in a fleet by 50%.
 *  They're just too damn small"). The SPACING grows with them, so an
 *  escort is still drawn smaller than its slot and never touches the next. */
export const FLEET_ESCORT_SCALE = 1.5;

/**
 * The gap between a fleet's escorts, for `n` escorts behind a flagship of
 * hit radius `hr` (px): the map's slot rule (fleetGrouping.escortSpacingFor)
 * times FLEET_ESCORT_SCALE. THE one place it is decided: MapCanvas's
 * marker pass, the battle layout and the test page all call this, so a
 * block is laid out exactly as big as it is drawn.
 */
export function escortBlockSpacing(n: number, hr: number): number {
  const base = Math.max(9, Math.min(24, hr * 0.9));
  return escortSpacingFor(n, base, hr) * FLEET_ESCORT_SCALE;
}

export function fleetBlockGeometry(flagPx: number, escortRel: readonly number[]): BlockGeometry {
  const hr = Math.max(flagPx / 2 + 3, MIN_HIT_R);
  const n = escortRel.length;
  const spacing = escortBlockSpacing(n, hr);
  const standoff = escortStandoffFor(hr, spacing);
  const offs = escortOffsets(n, spacing, 0, standoff);
  const glyph = escortGlyphFor(spacing);
  const pts = [{ x: 0, y: 0, r: (flagPx / 2) * (CLEAR_FRAC * 2) }];
  offs.forEach((o, i) => {
    const size = Math.max(3, glyph * Math.min(1, escortRel[i] ?? 1));
    pts.push({ x: o.dx, y: o.dy, r: (size / 2) * (CLEAR_FRAC * 2) });
  });
  const minX = Math.min(...pts.map(p => p.x - p.r)), maxX = Math.max(...pts.map(p => p.x + p.r));
  const minY = Math.min(...pts.map(p => p.y - p.r)), maxY = Math.max(...pts.map(p => p.y + p.r));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const clearR = Math.max(...pts.map(p => Math.hypot(p.x - cx, p.y - cy) + p.r));
  return { hr, spacing, standoff, glyph, flagX: -cx, flagY: -cy, clearR };
}

/** One thing the layout places: a lone hull, or a fleet marker's lead. */
export interface BattleUnit {
  /** The ship drawn for this unit (a fleet's lead). */
  id: string;
  owner: string;
  /** Hulls that clump together (same fleet); null = on its own. */
  group: string | null;
  /** Full-size sprite px (shipIconSize, unselected). */
  sizePx: number;
  armed: boolean;
  /** A fleet marker: each escort's size as a fraction of its slot. */
  escortRel?: number[];
  /** A fleet marker: the escort hulls riding in its block. */
  escortIds?: string[];
}

export interface LiveBattle {
  bodyId: string;
  /** Roster signature the layout was solved for. */
  key: string;
  refR: number;
  /** Which way the battle wheels (+1 toward +theta). */
  dir: number;
  layout: OBLayout;
  /** Fleet leads: the block geometry, at full size. */
  blocks: Map<string, BlockGeometry>;
  /** The world's station settlement id, when it has one in the layout. */
  stationId?: string;
  /** Escort hull -> the fleet lead whose block it rides in. */
  leadOf: Map<string, string>;
}

const cache = new Map<string, LiveBattle>();

/** The signature a battle is re-solved on: who is here, in what fleets. */
export function battleKey(
  refR: number, dir: number, units: readonly BattleUnit[], order: readonly string[], stationId?: string,
): string {
  const u = [...units].sort((a, b) => (a.id < b.id ? -1 : 1))
    .map(x => `${x.id}:${x.owner}:${x.group ?? ''}:${Math.round(x.sizePx)}:${(x.escortIds ?? []).join(',')}:${x.escortRel?.length ?? 0}`);
  return `${Math.round(refR)}|${dir}|${order.join(',')}|${stationId ?? ''}|${u.join(';')}`;
}

function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100000;
}

/**
 * The battle at a world, solved once per roster (cached on its key).
 * `order` is the factions in share order; `stationId` asks for the
 * world's station to be placed opposite the fight.
 */
/** A changed roster must hold this long before it replaces a world's
 *  layout (see liveBattleFor's `dwell`). */
export const ROSTER_DWELL_MS = 1500;
/** Pending roster per world: the key first seen and when. */
const pending = new Map<string, { key: string; since: number }>();
/** Layout solves per world, for the world-menu probe. */
const solveCounts = new Map<string, number>();
export function battleSolves(bodyId: string): number {
  return solveCounts.get(bodyId) ?? 0;
}

export function liveBattleFor(
  bodyId: string,
  bodyRadius: number,
  dir: number,
  units: readonly BattleUnit[],
  order: readonly string[],
  stationId?: string,
  /** STICKY ROSTER. With a clock, a changed roster replaces the world's
   *  layout only once it has held for ROSTER_DWELL_MS. The roster leaves
   *  out rival hulls the viewer cannot see, and fog is recomputed every
   *  ~140ms: a hull on the edge of sensor cover flickered in and out,
   *  every flicker re-solved the whole world, and every ship (and the
   *  station) kept gliding between two layouts -- the world-menu
   *  "quiver" (Lorne, 2026-10-07). A genuine arrival just waits a beat
   *  (drawn on its orbit meanwhile) before gliding into its place. */
  dwell?: { nowMs: number; ms?: number },
): LiveBattle {
  const refR = battleReferenceRadius(bodyRadius);
  const key = battleKey(refR, dir, units, order, stationId);
  const hit = cache.get(bodyId);
  if (hit && hit.key === key) { pending.delete(bodyId); return hit; }
  if (hit && dwell) {
    const p = pending.get(bodyId);
    if (!p || p.key !== key) { pending.set(bodyId, { key, since: dwell.nowMs }); return hit; }
    if (dwell.nowMs - p.since < (dwell.ms ?? ROSTER_DWELL_MS)) return hit;
  }
  pending.delete(bodyId);
  solveCounts.set(bodyId, (solveCounts.get(bodyId) ?? 0) + 1);
  const blocks = new Map<string, BlockGeometry>();
  const leadOf = new Map<string, string>();
  for (const u of units) for (const e of u.escortIds ?? []) leadOf.set(e, u.id);
  const ships: OBShip[] = units.map(u => {
    let clearR: number | undefined;
    if (u.escortRel && u.escortRel.length > 0) {
      const b = fleetBlockGeometry(u.sizePx, u.escortRel);
      blocks.set(u.id, b);
      clearR = b.clearR;
    }
    return { id: u.id, faction: u.owner, fleet: u.group, size: u.sizePx, armed: u.armed, clearR };
  });
  const layout = layoutOrbitBattle(ships, refR, {
    seed: seedOf(bodyId) + 1,
    factionOrder: [...order],
    station: stationId ? { id: stationId, clearR: BATTLE_STATION_PX * CLEAR_FRAC } : undefined,
  });
  const lb: LiveBattle = { bodyId, key, refR, dir, layout, blocks, stationId, leadOf };
  cache.set(bodyId, lb);
  return lb;
}

/** Forget a world's battle (it ended). */
export function dropLiveBattle(bodyId: string): void {
  cache.delete(bodyId);
}

/** k: the camera scale over the reference layout. */
export function battleScale(battle: LiveBattle, drawnRadiusPx: number): number {
  return Math.max(0, drawnRadiusPx) / battle.refR;
}

// ---------------------------------------------------------------- glide

interface Glide { r: number; t: number; ms: number }
const glides = new Map<string, Glide>();
let lastSweep = 0;

/** Start a unit's glide from where it was last drawn (reference polar,
 *  wheel removed), so a hull arriving or re-slotted eases in. */
export function seedBattleGlide(id: string, r: number, t: number, nowMs: number): void {
  if (!glides.has(id)) glides.set(id, { r, t, ms: nowMs });
}
export function hasBattleGlide(id: string): boolean {
  return glides.has(id);
}

/** The wheel's angle at `nowMs`. */
export function battleDrift(battle: LiveBattle, nowMs: number): number {
  return ((nowMs % BATTLE_TURN_MS) / BATTLE_TURN_MS) * Math.PI * 2 * battle.dir;
}

/**
 * Where a unit (or the station) is drawn NOW, in REFERENCE px from the
 * world's centre: its glided polar place plus the wheel, and its heading
 * (forward along the orbit in the wheel's sense, with the layout's small
 * per-hull jitter). Multiply x/y by k for screen px. Null when the battle
 * did not place it.
 */
export function battlePlacement(
  battle: LiveBattle, id: string, nowMs: number,
): { x: number; y: number; theta: number; r: number; heading: number } | null {
  const p = battle.layout.placements.get(id)
    ?? (battle.layout.station && battle.layout.station.id === id ? battle.layout.station : undefined);
  if (!p) return null;
  let g = glides.get(id);
  if (!g) { g = { r: p.r, t: p.theta, ms: nowMs }; glides.set(id, g); }
  const dt = Math.max(0, Math.min(200, nowMs - g.ms));
  g.ms = nowMs;
  const k = 1 - Math.exp(-dt / GLIDE_MS);
  let dth = (p.theta - g.t) % (Math.PI * 2);
  if (dth > Math.PI) dth -= Math.PI * 2;
  if (dth < -Math.PI) dth += Math.PI * 2;
  g.t += dth * k;
  g.r += (p.r - g.r) * k;
  if (nowMs - lastSweep > 10000) {
    lastSweep = nowMs;
    for (const [gid, gl] of glides) if (nowMs - gl.ms > 10000) glides.delete(gid);
  }
  const theta = g.t + battleDrift(battle, nowMs);
  // The layout's noses point +theta's way; keep each hull's own jitter
  // and flip the forward sense when the battle wheels the other way.
  const jitter = p.heading - (Math.atan2(p.y, p.x) + Math.PI / 2);
  const heading = theta + (Math.PI / 2) * battle.dir + jitter;
  return { x: Math.cos(theta) * g.r, y: Math.sin(theta) * g.r, theta, r: g.r, heading };
}

/**
 * Where a ship sits in its world's layout NOW, in SCREEN px from the
 * world's centre at scale k: a lone hull or a lead at its own place, an
 * escort at its block's centre (close enough for an effect aimed at a
 * hull that was not drawn this frame). Null when the layout has no place
 * for it. Effects read this instead of the hull's raw orbit point, which
 * the layout no longer uses: a fire or a bolt drawn there floated in
 * empty space (Lorne: "rogue damage effects floating by").
 */
export function battleShipOffsetPx(
  battle: LiveBattle, shipId: string, nowMs: number, k: number,
): { x: number; y: number } | null {
  const unit = battle.leadOf.get(shipId) ?? shipId;
  const pl = battlePlacement(battle, unit, nowMs);
  if (!pl) return null;
  let x = pl.x * k, y = pl.y * k;
  const blk = unit === shipId ? battle.blocks.get(unit) : undefined;
  if (blk) {
    const c = Math.cos(pl.heading), s = Math.sin(pl.heading);
    x += (blk.flagX * c - blk.flagY * s) * k;
    y += (blk.flagX * s + blk.flagY * c) * k;
  }
  return { x, y };
}

/** Test hook: clear every cached battle and glide. */
export function resetLiveBattles(): void {
  cache.clear();
  pending.clear();
  solveCounts.clear();
  glides.clear();
  lastSweep = 0;
}
