// ============================================================
// useSituationItems
//
// Derives the Situation Report's attention items from the current
// gameState. Each item has an entity id so a click can focus the
// relevant ship/body/UI. Until-acted-on expiration: an item
// disappears the moment its underlying condition becomes false, with
// a 10-tick max-life fallback for the time-bounded categories
// (arrived/created) so a forgotten ship eventually drops off.
//
// TIER MODEL — the readability pass. Categories collapse into three
// urgency tiers, which is what the panel renders and what the rail
// badge counts:
//
//   now         happening TO you on a clock you don't control:
//               in combat, hostiles inbound. Red. Never collapsed.
//   decision    time-bounded, waiting on YOU: vote closing, trade
//               offer, ship arrived/built with no orders, and an
//               idle yard at a body with hostiles present/inbound
//               (promoted from opportunity with defense phrasing).
//   opportunity no clock at all: idle yards, idle freighters,
//               stranded stockpiles, affordable research. Dimmer,
//               collapsed aggressively (research is ONE row, 3+
//               idle freighters are ONE row).
//
// Cross-item rules the tiers enable:
//   - One row per entity: a NOW row suppresses lower-tier rows for
//     the same ship/body, so a freighter dying at 10% HP is never
//     ALSO listed as "idle — assign a trade route" (a real render
//     we caught live).
//   - Within a tier, rows sort by their clock: combat by HP%
//     ascending (most hurt first), threats by ETA, votes by close.
//
// MP-only categories (open vote, incoming trade) accept optional
// data so the same hook works in SP without crashing.
// ============================================================

import { useEffect, useMemo, useRef } from 'react';
import type {
  GameState,
  Ship,
  TradeRoute,
  BuildingKind,
} from '../types';
import {
  computeIncomingThreats,
  type IncomingThreat,
} from '../game/threats';
import { computeVisibility } from '../game/visibility';
import { AUTO_COMBAT_INTERVAL, effectiveShipMaxHp } from '../game/combat';
import {
  TECH_DEFS,
  TECH_MAX_LEVEL,
  type TechId,
} from '../game/techs';
import { unlocksAt } from '../game/researchUnlocks';
import {
  computeIncomePerTick,
  BUILDING_DEFS,
  buildingLevel,
} from '../game/settlements';
import { SHIP_CLASSES } from '../game/shipClasses';
import { SECRET_DEFS } from '../game/secrets';
import { isDiscoveryAcked } from '../game/discoveryAck';

// Building kinds each settlement type can host (mirrors BuildPanel /
// the map's world-overlay chips). Used to ask "is there anything here I
// could afford to build?" before listing an idle settlement.
const CITY_BUILDINGS: BuildingKind[] = ['forge', 'mint', 'lab'];
const STATION_BUILDINGS: BuildingKind[] = ['weapons', 'lab', 'shipyard'];

/** Cheapest hull anyone can lay down — the floor for "can I build a
 *  ship at all". Computed once from the class table. */
const CHEAPEST_SHIP_COST = (() => {
  let best = { fuel: Infinity, ore: Infinity, credits: Infinity };
  let bestTotal = Infinity;
  for (const def of Object.values(SHIP_CLASSES)) {
    const t = (def.cost.fuel ?? 0) + (def.cost.ore ?? 0) + (def.cost.credits ?? 0);
    if (t < bestTotal) { bestTotal = t; best = def.cost; }
  }
  return best;
})();

interface ResBundle { fuel: number; ore: number; credits: number }
/** Next-level cost of a building = base × scaling^currentLevel. */
function nextBuildingCost(kind: BuildingKind, level: number): ResBundle {
  const def = BUILDING_DEFS[kind];
  const s = Math.pow(def.costScaling, level);
  return {
    fuel: (def.baseCost.fuel ?? 0) * s,
    ore: (def.baseCost.ore ?? 0) * s,
    credits: (def.baseCost.credits ?? 0) * s,
  };
}
function canPay(have: ResBundle, cost: ResBundle): boolean {
  return have.ore >= cost.ore && have.credits >= cost.credits && have.fuel >= cost.fuel;
}

/** Trim the "DISCOVERY: " / "DISCOVERY — " lead-in from a secret's flavor
 *  so the situation-report subtitle is just the payoff clause. */
function stripDiscoveryPrefix(msg: string): string {
  return msg.replace(/^\s*DISCOVERY\s*[:—-]\s*/i, '');
}

// ------------------------------------------------------------
// Item types
// ------------------------------------------------------------

export type SituationCategory =
  | 'arrived'        // Sean #1 — recently finished a transit
  | 'created'        // Sean #2 — recently built, idle at origin
  | 'idle_shipyard'  // Sean #3 — owned body with no active build
  | 'idle_freighter' // freighter with no transit + no route
  | 'stranded'       // settlement stockpile piling up, no collector
  | 'vote_open'      // MP — senate proposal in voting, not voted on
  | 'incoming_trade' // MP — open trade where caller is responder
  | 'in_combat'      // shooting RIGHT NOW — your hulls/settlements engaged
  | 'threat'         // body of yours under incoming enemy
  | 'tech_available' // research idle — no project committed
  // --- construction: buildings were unwatched while ships were not ---
  | 'building_idle'  // settlement with an empty building queue
  | 'building_done'  // a building just finished — the slot is free again
  // --- research beyond "no project" ---
  | 'research_done'  // a level completed (and what it unlocked)
  | 'research_stall' // committed to a track with zero science income
  // --- the quiet-but-bleeding cases ---
  | 'damaged'        // hurt and NOT currently fighting, so in_combat is silent
  | 'idle_colony'    // colony hull parked — expansion stalled
  | 'broken_route'   // trade route whose ship or endpoint is gone
  | 'vote_closed'    // MP — a vote you were watching has resolved
  | 'discovery'      // one of YOUR ships uncovered a body secret
  | 'fleet_leaderless'; // a fleet lost its flagship — promote a captain

export type SituationTier = 'now' | 'decision' | 'opportunity';

export const TIER_LABEL: Record<SituationTier, string> = {
  now:         'Now',
  decision:    'Needs a decision',
  opportunity: 'Opportunities',
};

const TIER_ORDER: SituationTier[] = ['now', 'decision', 'opportunity'];

/** Default tier per category. Individual items may promote themselves
 *  (e.g. an idle yard at a body with hostiles inbound is a DECISION —
 *  "build defenses" — not a someday-opportunity). */
const TIER_OF: Record<SituationCategory, SituationTier> = {
  in_combat:      'now',
  threat:         'now',
  arrived:        'decision',
  created:        'decision',
  incoming_trade: 'decision',
  vote_open:      'decision',
  idle_shipyard:  'opportunity',
  idle_freighter: 'opportunity',
  stranded:       'opportunity',
  tech_available: 'opportunity',
  // A building slot standing empty wastes the same tick an idle yard
  // does, so it sits in the same tier as one.
  building_idle:  'opportunity',
  building_done:  'decision',
  research_done:  'decision',
  // Stalled research burns the whole science economy every tick, same
  // argument as "no research project" — a decision, not a someday.
  research_stall: 'decision',
  damaged:        'decision',
  idle_colony:    'decision',
  broken_route:   'decision',
  // A resolved vote is news to read, not a choice to make — there is
  // nothing left to decide once it's closed. Keeping it in the decision
  // tier made "Needs a decision" cry wolf (playtest, 2026-07-27).
  vote_closed:    'opportunity',
  // A find is a reward to notice and act on (a free city to garrison, a
  // salvaged warship to crew), not a chore — a decision-tier prompt.
  discovery:      'decision',
  // A beheaded fleet refuses new common orders until you promote —
  // a decision by construction (DESIGN-fleets.md).
  fleet_leaderless: 'decision',
};

export interface SituationItem {
  id: string;                     // unique within the list (category + entity)
  category: SituationCategory;
  /** Urgency tier — what the panel groups by and the badge counts. */
  tier: SituationTier;
  title: string;                  // primary line
  subtitle?: string;              // secondary line (one short clause)
  /** Where a click should focus. */
  focus?:
    | { kind: 'ship'; shipId: string }
    | { kind: 'body'; bodyId: string }
    | { kind: 'panel'; panel: 'research' | 'senate' | 'trades' };
  /** Severity colour. danger = red (dying hull, settlement at risk),
   *  warn = amber (engaged / time-bounded), normal = neutral. */
  severity: 'normal' | 'warn' | 'danger';
  /** Lower = more urgent within the tier (HP% for combat, ETA for
   *  threats, close-tick for votes). Undefined sorts last, stable. */
  sortKey?: number;
  /** Suppression key ("ship:<id>" / "body:<id>"). A NOW row's entity
   *  suppresses lower-tier rows with the same key — one row per
   *  entity, the most urgent wins. Undefined = never suppressed
   *  (used by contextual rows that ARE the answer to a NOW row). */
  entity?: string;
}

export const CATEGORY_LABEL: Record<SituationCategory, string> = {
  in_combat:       'In combat now',
  threat:          'Incoming threats',
  arrived:         'Recently arrived',
  created:         'Newly created',
  incoming_trade:  'Incoming trade offers',
  vote_open:       'Senate vote open',
  idle_shipyard:   'Planets awaiting construction',
  idle_freighter:  'Idle freighters',
  stranded:        'Stranded stockpiles',
  tech_available:  'Research idle',
  building_idle:   'Building slots empty',
  building_done:   'Construction complete',
  research_done:   'Research complete',
  research_stall:  'Research stalled',
  damaged:         'Damaged and quiet',
  idle_colony:     'Idle colony ships',
  broken_route:    'Broken trade routes',
  vote_closed:     'Votes resolved',
  discovery:       'Discoveries',
  fleet_leaderless: 'Fleets without a flag',
};

// ------------------------------------------------------------
// MP data passed in (SP gets empty arrays)
// ------------------------------------------------------------

export interface SituationMpData {
  /** Open trades where the caller is the responder. */
  incomingTrades?: Array<{
    id: string;
    proposer_faction_id: string;
    proposer_faction_name?: string | null;
  }>;
  /** Senate proposals in 'voting' status that the caller hasn't voted on. */
  openVotes?: Array<{
    id: string;
    title: string;
    vote_closes_at_tick: number;
  }>;
}

// ------------------------------------------------------------
// Combat recency — MUST match FleetPanel's "In Combat" badge, or the
// Situation Report and the fleet list disagree about the same hull.
// Auto-combat resolves a volley every AUTO_COMBAT_INTERVAL ticks, so
// 2x gives one volley of grace: the entry stays lit between salvoes
// and clears a couple of ticks after the last shot.
// ------------------------------------------------------------
const COMBAT_RECENT_TICKS = AUTO_COMBAT_INTERVAL * 2;

/** How long a completion (building, research level, closed vote) stays
 *  in the report. Matches the 10-tick window arrivals already use. */
const COMPLETION_TTL_TICKS = 10;

/** A discovery lingers a bit longer than a routine completion — it's a
 *  bigger deal, and the reward (a free city to garrison, a warship to
 *  crew) is worth keeping in front of the player for a while. */
const DISCOVERY_TTL_TICKS = 25;

/** At/below this HP fraction a quiet entity is worth reporting. Above
 *  it, scratches would drown the list. */
const DAMAGED_HP_RATIO = 0.5;

/** Inside this many ticks of closing, a vote is a NOW — after it closes
 *  there is nothing the player can do about it. */
const VOTE_URGENT_TICKS = 3;

/** Display name for a faction id, falling back to the id so an
 *  unrecognised owner still reads as something in the UI. */
function factionName(gameState: GameState, id: string): string {
  return gameState.factions?.find(f => f.id === id)?.name ?? id;
}

/** Ticks since this entity last fired OR took a hit. Infinity = never. */
function ticksSinceCombat(
  e: { lastCombatTick?: number; lastDamagedTick?: number },
  tick: number,
): number {
  const last = Math.max(e.lastCombatTick ?? -Infinity, e.lastDamagedTick ?? -Infinity);
  return last === -Infinity ? Infinity : tick - last;
}

function shipHasPendingOrders(s: Ship): boolean {
  if (s.transit) return true;
  if (s.plannedTransit) return true;
  if (s.queuedTransits && s.queuedTransits.length > 0) return true;
  if (s.orders && s.orders.some(o => o.status === 'planned' || o.status === 'committed')) return true;
  return false;
}

// ------------------------------------------------------------
// The hook
// ------------------------------------------------------------

/**
 * Returns a flat, ordered list of situation items grouped by tier.
 *
 * @param gameState   live GameState
 * @param factionId   caller's faction id (PLAYER_TOKEN in MP, 'player' in SP)
 * @param mpData      optional MP-only category data (votes, incoming trades)
 */
export function useSituationItems(
  gameState: GameState,
  factionId: string,
  mpData?: SituationMpData,
): SituationItem[] {
  const tick = gameState.currentTick;

  // --- Stateful tracking for time-bounded categories ---
  //
  // `arrivedAt`  — shipId -> tick when it stopped being in transit.
  // `createdAt`  — shipId -> tick when it first appeared in our list.
  //
  // Refs because we need cross-render memory; the effect below updates
  // them per tick. Set lookups make the derive() pass fast.
  const arrivedAtRef = useRef<Map<string, number>>(new Map());
  const createdAtRef = useRef<Map<string, number>>(new Map());
  const prevTransitingRef = useRef<Set<string>>(new Set());
  const prevShipIdsRef = useRef<Set<string>>(new Set());

  // Completions can only be seen as TRANSITIONS — the server just stops
  // sending the queue/project once it's done, so "finished" exists
  // nowhere in a single snapshot. Same ref-diff idiom as arrivals.
  //
  // `buildingDoneRef`  — settlementId -> { tick, label } when its queue emptied.
  // `researchDoneRef`  — track -> { tick, level } when its level ticked up.
  // `voteClosedRef`    — voteId -> { tick, title } when it left the open list.
  const prevBuildingRef = useRef<Map<string, string>>(new Map());
  const buildingDoneRef = useRef<Map<string, { tick: number; label: string }>>(new Map());
  const prevTechLevelsRef = useRef<Map<string, number>>(new Map());
  const researchDoneRef = useRef<Map<string, { tick: number; level: number }>>(new Map());
  const prevVotesRef = useRef<Map<string, string>>(new Map());
  const voteClosedRef = useRef<Map<string, { tick: number; title: string }>>(new Map());
  /**
   * "Have we seen one frame yet?" — the guard against reporting the
   * whole world as freshly-completed on first load.
   *
   * An explicit flag, NOT `prevMap.size > 0`. Size is wrong whenever the
   * map legitimately starts empty: `factionTech.levels` is `{}` until
   * the first level lands, so the first completion of the game grew the
   * map from empty, the size check said "no history", and the very
   * milestone worth reporting was the one silently swallowed. Caught by
   * researching Weapons 1 in a live game and seeing no row.
   */
  const seenFirstFrameRef = useRef(false);

  // Update trackers on every render. This is cheap (gameState updates
  // at most once per /state poll); the heavy lifting is the derive
  // below, which runs once per gameState change via useMemo.
  useEffect(() => {
    const mine = gameState.ships.filter(s => s.ownedBy === factionId);
    const nowTransiting = new Set<string>();
    const nowIds = new Set<string>();

    for (const s of mine) {
      nowIds.add(s.id);
      if (s.transit) nowTransiting.add(s.id);
    }

    // Recently arrived: anyone who WAS transiting last frame and ISN'T
    // now (and we don't already have a stamp for them). The stamp
    // resets only after expiration or after the player gives orders.
    for (const id of prevTransitingRef.current) {
      if (!nowTransiting.has(id) && !arrivedAtRef.current.has(id)) {
        arrivedAtRef.current.set(id, tick);
      }
    }

    // Newly created: anyone in the ship list now that wasn't last
    // frame. Use the initial-mount guard so we don't flag every ship
    // as "new" on first load.
    if (prevShipIdsRef.current.size > 0) {
      for (const id of nowIds) {
        if (!prevShipIdsRef.current.has(id) && !createdAtRef.current.has(id)) {
          createdAtRef.current.set(id, tick);
        }
      }
    }

    // Drop stamps for ships that no longer exist (destroyed).
    for (const id of Array.from(arrivedAtRef.current.keys())) {
      if (!nowIds.has(id)) arrivedAtRef.current.delete(id);
    }
    for (const id of Array.from(createdAtRef.current.keys())) {
      if (!nowIds.has(id)) createdAtRef.current.delete(id);
    }

    prevTransitingRef.current = nowTransiting;
    prevShipIdsRef.current = nowIds;
  }, [gameState.ships, factionId, tick]);

  // --- Completion tracking: buildings, research levels, votes ---
  useEffect(() => {
    // Buildings: a queue that existed last frame and is gone now finished.
    const nowQueue = new Map<string, string>();
    for (const s of gameState.settlements) {
      if (s.ownedBy !== factionId || !s.buildingQueue) continue;
      nowQueue.set(s.id, `${s.buildingQueue.kind} L${s.buildingQueue.targetLevel}`);
    }
    if (seenFirstFrameRef.current) {
      for (const [id, label] of prevBuildingRef.current) {
        if (!nowQueue.has(id) && !buildingDoneRef.current.has(id)) {
          buildingDoneRef.current.set(id, { tick, label });
        }
      }
    }
    // A settlement that's building again has already had its decision
    // made — the slot isn't free, so drop the completion stamp. Without
    // this the "X complete · Building slot free" row kept demanding a
    // decision for the full 10-tick window even after the player queued
    // the next upgrade (Sean, playtest) — and at an hour per tick that's
    // ten hours of a prompt that's simply false.
    for (const id of nowQueue.keys()) buildingDoneRef.current.delete(id);
    prevBuildingRef.current = nowQueue;

    // Research: watch the LEVEL, not `researching`. Committing to a new
    // track clears the old project too, and reporting that as "complete"
    // would congratulate the player for cancelling.
    const levels = gameState.factionTech?.[factionId]?.levels ?? {};
    const nowLevels = new Map<string, number>(Object.entries(levels) as [string, number][]);
    if (seenFirstFrameRef.current) {
      for (const [track, lvl] of nowLevels) {
        // Absent means level 0, NOT "unknown". `levels` only carries
        // tracks you've researched, so the FIRST level of any track
        // appears as a key that didn't exist before — and a `!= null`
        // check treats that as "no prior reading" and skips it. That
        // silently swallowed every track's level 1, which is the most
        // interesting completion in the game (it's the one that unlocks
        // the hull/part). Verified live: Weapons 0 -> 1 reported nothing.
        const before = prevTechLevelsRef.current.get(track) ?? 0;
        if (lvl > before) {
          researchDoneRef.current.set(track, { tick, level: lvl });
        }
      }
    }
    prevTechLevelsRef.current = nowLevels;

    // Votes: one that was open and no longer is has resolved.
    const nowVotes = new Map<string, string>();
    for (const v of mpData?.openVotes ?? []) nowVotes.set(v.id, v.title);
    if (seenFirstFrameRef.current) {
      for (const [id, title] of prevVotesRef.current) {
        if (!nowVotes.has(id) && !voteClosedRef.current.has(id)) {
          voteClosedRef.current.set(id, { tick, title });
        }
      }
    }
    prevVotesRef.current = nowVotes;
    seenFirstFrameRef.current = true;

    // Expire stamps so a completion doesn't sit in the report forever.
    const expired = (t: number) => tick - t > COMPLETION_TTL_TICKS;
    for (const [k, v] of Array.from(buildingDoneRef.current)) {
      if (expired(v.tick)) buildingDoneRef.current.delete(k);
    }
    for (const [k, v] of Array.from(voteClosedRef.current)) {
      if (expired(v.tick)) voteClosedRef.current.delete(k);
    }
    for (const [k, v] of Array.from(researchDoneRef.current)) {
      if (expired(v.tick)) researchDoneRef.current.delete(k);
    }
  }, [gameState.settlements, gameState.factionTech, mpData, factionId, tick]);

  // --- Derive the item list ---
  return useMemo(() => {
    const items: SituationItem[] = [];
    const push = (it: Omit<SituationItem, 'tier'> & { tier?: SituationTier }) =>
      items.push({ ...it, tier: it.tier ?? TIER_OF[it.category] });

    const mine = gameState.ships.filter(s => s.ownedBy === factionId);
    const byId = new Map<string, Ship>(mine.map(s => [s.id, s]));
    const bodies = gameState.bodies;
    const bodyName = (id: string | undefined) =>
      (id && bodies.find(b => b.id === id)?.name) || '?';

    // Spendable at a body = the faction pool PLUS local stockpiles there
    // (both fund a local build). Drives the affordability gate on build
    // opportunities — listing "shipyard idle / building nothing" when the
    // player is flat broke is just nagging about something they can't do.
    const pool = gameState.resources?.[factionId];
    const spendableAt = (bodyId: string): ResBundle => {
      let ore = pool?.ore ?? 0, credits = pool?.credits ?? 0, fuel = pool?.fuel ?? 0;
      for (const s of gameState.settlements) {
        if (s.ownedBy === factionId && s.bodyId === bodyId && s.stockpile) {
          ore += s.stockpile.ore ?? 0;
          credits += s.stockpile.credits ?? 0;
          fuel += s.stockpile.fuel ?? 0;
        }
      }
      return { ore, credits, fuel };
    };

    // --- Shared combat context ---
    // Both the NOW-tier sections and the contextual promotion of idle
    // yards need to know where the shooting is (hostile parked at a
    // body) and where it's about to be (inbound burn targeting one).
    let threats: IncomingThreat[] = [];
    try {
      // Fog-gated: the situation feed must not report inbound hostiles
      // the player has no sensor on (same leak the ThreatsPanel had).
      const vis = computeVisibility(
        factionId, gameState.ships, gameState.settlements, gameState.bodies,
        gameState.currentTick, new Map(), new Set(gameState.alliedFactionIds ?? []),
      ).visibleShipIds;
      threats = computeIncomingThreats(gameState, factionId, vis);
    } catch { /* defensive */ }
    const threatBodyIds = new Set(threats.map(t => t.targetBodyId));

    // Bodies with a hostile ship parked on them. Peace partners are
    // not hostile (mirrors the threat filter), and ships in transit
    // aren't yet present to fight.
    const hostileBodies = new Set<string>();
    for (const s of gameState.ships) {
      if (s.ownedBy === factionId) continue;
      if (s.transit) continue;
      if (gameState.peaceFactionIds?.includes(s.ownedBy)) continue;
      if (s.orbit.parentBodyId) hostileBodies.add(s.orbit.parentBodyId);
    }

    // A ship assigned to an active trade route is "given orders" for our
    // purposes — it has a job, even when between legs and not currently
    // in transit. Without this, a routed freighter that just arrived at
    // its dest body would linger in "Recently Arrived → Awaiting orders"
    // until the 10-tick fallback expired, contradicting the panel's own
    // copy. Computed once here so categories 1, 2, and 4 all share it.
    const routedShipIds = new Set(
      (gameState.tradeRoutes || [])
        .filter((r: TradeRoute) => r.ownedBy === factionId && r.status !== 'paused')
        .map((r: TradeRoute) => r.shipId),
    );

    // ---- 1) Recently arrived ----
    // Conditions: stamp exists, ship still has no pending orders AND
    // isn't on an active trade route, age < 10 ticks. The "no pending
    // orders" check makes "until acted on" automatic — queueing a
    // transfer or assigning a route drops the item next render.
    for (const [shipId, arrivedAt] of arrivedAtRef.current) {
      const ship = byId.get(shipId);
      if (!ship) continue;
      if (shipHasPendingOrders(ship)) continue;
      if (routedShipIds.has(ship.id)) continue;
      if (tick - arrivedAt > 10) continue;
      const where = bodyName(ship.orbit.parentBodyId);
      push({
        id: `arrived:${ship.id}`,
        category: 'arrived',
        title: `${ship.name} arrived at ${where}`,
        subtitle: 'Awaiting orders',
        focus: { kind: 'ship', shipId: ship.id },
        severity: 'normal',
        entity: `ship:${ship.id}`,
      });
    }

    // ---- 2) Newly created ----
    // Same orders+route gate as section 1: a freshly built freighter that
    // immediately gets a trade route assigned has been "acted on" and
    // shouldn't sit in "Newly created → Awaiting orders."
    for (const [shipId, createdAt] of createdAtRef.current) {
      const ship = byId.get(shipId);
      if (!ship) continue;
      if (shipHasPendingOrders(ship)) continue;
      if (routedShipIds.has(ship.id)) continue;
      if (tick - createdAt > 10) continue;
      const where = bodyName(ship.orbit.parentBodyId);
      push({
        id: `created:${ship.id}`,
        category: 'created',
        title: `${ship.name} (${ship.class}) launched at ${where}`,
        subtitle: 'Awaiting orders',
        focus: { kind: 'ship', shipId: ship.id },
        severity: 'normal',
        entity: `ship:${ship.id}`,
      });
    }

    // ---- 3) Idle shipyards ----
    // For each owned body that can host a shipyard, list it if no
    // active build queue row points there. "Can host a shipyard" v1
    // rule: any owned terrestrial/moon/asteroid body. Stars and gas
    // giants are excluded since the BuildPanel rejects them too.
    //
    // CONTEXTUAL PROMOTION: an idle yard at a body with hostiles
    // present or inbound isn't a someday-opportunity, it's the action
    // the NOW row is begging for — "build a defender". Promote to the
    // decision tier with defense phrasing. No entity key: the NOW row
    // for the same body must not suppress it, because it IS the answer.
    const buildBusyBodies = new Set(
      (gameState.buildOrders || [])
        .filter(b => b.ownedBy === factionId)
        .map(b => b.bodyId),
    );
    for (const body of bodies) {
      if (body.ownedBy !== factionId) continue;
      if (body.type === 'star' || body.type === 'gas_giant' || body.type === 'ice_giant') continue;
      if (body.destroyedAtTick != null) continue;
      if (buildBusyBodies.has(body.id)) continue;
      const hostilesHere = hostileBodies.has(body.id);
      const hostilesComing = threatBodyIds.has(body.id);
      if (hostilesHere || hostilesComing) {
        push({
          id: `idle_shipyard:${body.id}`,
          category: 'idle_shipyard',
          tier: 'decision',
          title: `${body.name} yard idle — hostiles ${hostilesHere ? 'present' : 'inbound'}`,
          subtitle: 'Build defenses',
          focus: { kind: 'body', bodyId: body.id },
          severity: 'warn',
        });
      } else {
        // Only an opportunity if you could actually lay down a hull.
        // Broke → nothing to do here, don't nag. (Under threat, above,
        // we still surface it — that's a warning, not an opportunity.)
        if (!canPay(spendableAt(body.id), CHEAPEST_SHIP_COST)) continue;
        push({
          id: `idle_shipyard:${body.id}`,
          category: 'idle_shipyard',
          title: `${body.name} shipyard idle`,
          subtitle: 'No ship in production',
          focus: { kind: 'body', bodyId: body.id },
          severity: 'normal',
          entity: `body:${body.id}`,
        });
      }
    }

    // ---- 4) Idle freighters ----
    // `routedShipIds` is shared with sections 1 + 2 — declared above.
    // A freighter parked at a body with hostiles on it is busy
    // surviving, not idle — the in-combat row owns it (and "assign a
    // trade route" would be absurd advice mid-firefight). 3+ idle
    // freighters collapse to one row so a big merchant fleet doesn't
    // wallpaper the panel.
    const idleFreighters = mine.filter(ship =>
      ship.class === 'freighter'
      && !shipHasPendingOrders(ship)
      && !routedShipIds.has(ship.id)
      && !(ship.orbit.parentBodyId && hostileBodies.has(ship.orbit.parentBodyId)),
    );
    if (idleFreighters.length >= 3) {
      const names = idleFreighters.slice(0, 2).map(s => s.name).join(', ');
      push({
        id: 'idle_freighter:all',
        category: 'idle_freighter',
        title: `${idleFreighters.length} freighters idle`,
        subtitle: `${names} +${idleFreighters.length - 2} more · no trade routes`,
        focus: { kind: 'ship', shipId: idleFreighters[0].id },
        severity: 'normal',
      });
    } else {
      for (const ship of idleFreighters) {
        push({
          id: `idle_freighter:${ship.id}`,
          category: 'idle_freighter',
          title: `${ship.name} parked at ${bodyName(ship.orbit.parentBodyId)}`,
          subtitle: 'No trade route assigned',
          focus: { kind: 'ship', shipId: ship.id },
          severity: 'normal',
          entity: `ship:${ship.id}`,
        });
      }
    }

    // ---- 5) Stranded stockpiles (grouped per body) ----
    // The stockpile model is per-body in the UI (city + station on the
    // same body share one logical bucket). Group non-collector
    // settlement stockpiles by body and emit ONE item per body, so a
    // single planet with both a city + station banking ore doesn't
    // double-list. v1 rule: skip the "freighter inbound" check; just
    // gate on stockpile + at-least-one-uncollectered settlement.
    // Threshold = 1 to avoid spamming for tiny dust.
    const stockByBody = new Map<string, number>();
    for (const s of gameState.settlements) {
      if (s.ownedBy !== factionId) continue;
      if (s.hasCollector) continue;
      const stock = s.stockpile;
      const total = (stock?.fuel ?? 0) + (stock?.ore ?? 0) + (stock?.credits ?? 0) + (stock?.science ?? 0);
      if (total < 1) continue;
      stockByBody.set(s.bodyId, (stockByBody.get(s.bodyId) ?? 0) + total);
    }
    for (const [bodyId, total] of stockByBody) {
      const body = bodies.find(b => b.id === bodyId);
      push({
        id: `stranded:body:${bodyId}`,
        category: 'stranded',
        title: `${body?.name ?? '?'} stockpile growing`,
        subtitle: `${Math.round(total)} units banked — no collector or trade route`,
        focus: { kind: 'body', bodyId },
        severity: 'normal',
        // Biggest pile first among stockpiles, but behind any row with
        // a real urgency clock (HP ratios, completion ticks) — hence
        // the large base rather than a bare -total.
        sortKey: 1e9 - total,
        entity: `body:${bodyId}`,
      });
    }

    // ---- 6) Vote open (MP) ----
    if (mpData?.openVotes) {
      for (const v of mpData.openVotes) {
        const closesIn = Math.max(0, v.vote_closes_at_tick - tick);
        // A vote about to close and one with twenty ticks left read
        // identically before this — same tier, same colour — so the
        // deadline that actually matters was invisible. Inside the
        // window it's a NOW: after it closes there is nothing to do.
        const closing = closesIn <= VOTE_URGENT_TICKS;
        push({
          id: `vote_open:${v.id}`,
          category: 'vote_open',
          tier: closing ? 'now' : undefined,
          title: v.title,
          subtitle: closing
            ? `Closes in ${closesIn}t — vote now`
            : `Voting closes in ${closesIn}t`,
          focus: { kind: 'panel', panel: 'senate' },
          severity: closing ? 'danger' : 'warn',
          sortKey: closesIn,
        });
      }
    }

    // ---- 7) Incoming trade offers (MP) ----
    if (mpData?.incomingTrades) {
      for (const t of mpData.incomingTrades) {
        push({
          id: `incoming_trade:${t.id}`,
          category: 'incoming_trade',
          title: `Trade offer from ${t.proposer_faction_name ?? 'another faction'}`,
          subtitle: 'Open in Trades to respond',
          focus: { kind: 'panel', panel: 'trades' },
          severity: 'warn',
        });
      }
    }

    // ---- 8) Incoming threats ----
    // One row per TARGET BODY (not per attacker) so a six-ship strike
    // reads as one decision, not six. computeIncomingThreats already
    // filters own ships + peace treaties and sorts soonest-first; we
    // just group and phrase.
    try {
      const byBody = new Map<string, typeof threats>();
      for (const t of threats) {
        const arr = byBody.get(t.targetBodyId) ?? [];
        arr.push(t);
        byBody.set(t.targetBodyId, arr);
      }

      for (const [bodyId, group] of byBody) {
        const body = bodies.find(b => b.id === bodyId);
        if (!body) continue;

        // Soonest arrival drives the ETA — that's the clock the player
        // is actually racing.
        const eta = Math.min(...group.map(t => t.ticksUntilArrival));
        const n = group.length;

        // Who's coming. Resolve display names; fall back to the raw id
        // so an unknown faction still reads as *something*.
        const attackers = Array.from(new Set(group.map(t => t.attackerFaction)))
          .map(id => factionName(gameState, id));
        const who = attackers.length === 1
          ? attackers[0]
          : `${attackers[0]} +${attackers.length - 1}`;

        // Composition, most-dangerous first, so "destroyer" is the word
        // the player sees when a destroyer is in the wave.
        const classRank: Record<string, number> = {
          destroyer: 0, frigate: 1, corvette: 2, colony: 3, freighter: 4,
        };
        const classes = Array.from(new Set(group.map(t => t.attackerClass)))
          .sort((a, b) => (classRank[a] ?? 9) - (classRank[b] ?? 9));

        // What's at stake at the destination.
        const g0 = group[0];
        const stake: string[] = [];
        if (g0.threatenedSettlementCount > 0) {
          stake.push(g0.threatenedSettlementCount === 1 && g0.threatenedSettlementNames[0]
            ? g0.threatenedSettlementNames[0]
            : `${g0.threatenedSettlementCount} settlements`);
        }
        if (g0.threatenedShipCount > 0) {
          stake.push(`${g0.threatenedShipCount} ship${g0.threatenedShipCount === 1 ? '' : 's'}`);
        }
        // Owned-but-empty body: nothing stationed, but losing the claim
        // still matters — say so rather than showing a bare ETA.
        const hasStake = stake.length > 0;
        const stakeText = hasStake ? `${stake.join(' + ')} at risk` : 'undefended';

        push({
          id: `threat:${bodyId}`,
          category: 'threat',
          title: `${n} hostile${n === 1 ? '' : 's'} inbound → ${body.name}`,
          subtitle: `${who} ${classes.join('/')} · ETA ${eta}t · ${stakeText}`,
          focus: { kind: 'body', bodyId },
          // Settlements/ships in the crosshairs = red; a claim-jumper
          // heading for an empty rock = amber.
          severity: hasStake ? 'danger' : 'warn',
          sortKey: eta,
          entity: `body:${bodyId}`,
        });
      }
    } catch { /* defensive: threats compute failures shouldn't kill the list */ }

    // ---- 8b) In combat now ----
    // "In combat" is the OR of two signals, because neither alone is
    // complete:
    //
    //   1. HOSTILE PRESENT at the body. Auto-combat happens between
    //      entities sharing a body, so co-location IS the condition.
    //      This is the only signal that catches a hull being shot
    //      WITHOUT shooting back — a freighter, or anything on Hold
    //      Fire. Verified live: a freighter sat at 6/60 HP mid-battle
    //      with no combat stamp at all, because MP only records
    //      last_combat_tick (stamped when you FIRE); there is no
    //      last_damaged_tick server-side. Stamp-only would have hidden
    //      the single most endangered ship in the fight.
    //   2. RECENTLY FIRED. Keeps a hull listed for a volley or two
    //      after the last enemy dies, so a fight doesn't vanish the
    //      instant it's won.
    //
    // Ships in transit are excluded either way — they can't be in an
    // auto-combat exchange, so a stale stamp on one is a straggler
    // from a fight it already left.
    try {
      for (const s of gameState.ships) {
        if (s.ownedBy !== factionId) continue;
        if (s.transit) continue;
        const engaged = (s.orbit.parentBodyId != null && hostileBodies.has(s.orbit.parentBodyId))
          || ticksSinceCombat(s, tick) <= COMBAT_RECENT_TICKS;
        if (!engaged) continue;

        const where = bodies.find(b => b.id === s.orbit.parentBodyId)?.name ?? 'deep space';
        const hp = s.hp;
        // TRUE max (rank × armor tech × Bulwark), matching FleetPanel /
        // ShipPanel / Outliner — the stored hpMax is the build-time base,
        // and dividing by it read veteran hulls at 156% HP (playtest).
        const hpMax = effectiveShipMaxHp(s, gameState.factionTech?.[s.ownedBy]);
        const pct = hp != null && hpMax > 0
          ? Math.max(0, Math.round((hp / hpMax) * 100))
          : null;
        // Red only when the hull is actually losing — a winning
        // skirmish reads amber ("engaged"), not red ("dying").
        const hurt = pct != null && pct <= 50;

        push({
          id: `in_combat:ship:${s.id}`,
          category: 'in_combat',
          title: `${s.name} engaged at ${where}`,
          subtitle: `${s.class}${pct != null ? ` · ${pct}% HP` : ''}`,
          focus: { kind: 'ship', shipId: s.id },
          severity: hurt ? 'danger' : 'warn',
          sortKey: pct ?? 100,          // most hurt first
          entity: `ship:${s.id}`,
        });
      }

      // Settlements can be bombarded to nothing — a city under guns is
      // the most urgent fact on the board. Same OR as ships, and here
      // the hostile-present half matters even more: a settlement only
      // stamps last_combat_tick when it RETURNS fire, so an ungunned
      // city being shelled has no stamp at all.
      for (const st of gameState.settlements) {
        if (st.ownedBy !== factionId) continue;
        const engaged = hostileBodies.has(st.bodyId)
          || ticksSinceCombat(st, tick) <= COMBAT_RECENT_TICKS;
        if (!engaged) continue;

        // NB: settlements carry `maxHp`; ships carry `hpMax`. Not a typo.
        const where = bodies.find(b => b.id === st.bodyId)?.name ?? st.bodyId;
        const pct = st.maxHp > 0 ? Math.max(0, Math.round((st.hp / st.maxHp) * 100)) : null;
        const hurt = pct != null && pct <= 50;
        // "Under fire" only when there's evidence of fire — damage or a
        // recent combat stamp. A full-HP city listed purely because a
        // hostile is parked overhead read "under fire · 100% HP", which
        // contradicted itself (playtest). Same danger, honest words.
        const firedUpon = (pct != null && pct < 100)
          || ticksSinceCombat(st, tick) <= COMBAT_RECENT_TICKS;

        push({
          id: `in_combat:settlement:${st.id}`,
          category: 'in_combat',
          title: firedUpon ? `${st.name} under fire` : `${st.name} — hostiles overhead`,
          subtitle: `${st.type} on ${where}${pct != null ? ` · ${pct}% HP` : ''}`,
          focus: { kind: 'body', bodyId: st.bodyId },
          severity: hurt ? 'danger' : 'warn',
          sortKey: pct ?? 100,
          entity: `body:${st.bodyId}`,
        });
      }
    } catch { /* defensive */ }

    // ---- 9) No research project ----
    // Research is a committed project that fills from science income
    // each tick, so there is exactly ONE actionable research state: the
    // lab is idle. This used to list everything you could afford, which
    // with any science income was true for most tracks most of the game
    // — permanent wallpaper drowning the urgent tiers above.
    //
    // Idle science isn't lost (it banks in the pool), but it's earning
    // nothing, so this is a real nudge rather than noise.
    try {
      const techState = gameState.factionTech?.[factionId];
      if (techState && !techState.researching) {
        const levels = techState.levels || {};
        const anyLeft = (Object.keys(TECH_DEFS) as TechId[])
          .some(id => (levels[id] ?? 0) < TECH_MAX_LEVEL);
        // Everything maxed = Science Victory territory; nagging then
        // would be telling the player to do something impossible.
        if (anyLeft) {
          const pool = gameState.resources?.[factionId];
          const science = Math.floor(pool?.science ?? 0);
          push({
            id: 'tech_available:idle',
            category: 'tech_available',
            // DECISION, not opportunity: research advances at your
            // science income, so an idle lab wastes your ENTIRE science
            // economy every tick. Opportunities are excluded from the
            // rail badge, which meant this never actually surfaced —
            // the whole point of replacing the affordable-tech list.
            tier: 'decision',
            title: 'No research project',
            subtitle: science > 0
              ? `${science} science banked · pick a track`
              : 'pick a track to start accumulating',
            focus: { kind: 'panel', panel: 'research' },
            severity: 'warn',
          });
        }
      }
    } catch { /* defensive */ }

    // ---- Construction: buildings ----
    // Ship yards were watched and building slots were not, though an
    // empty building queue wastes exactly the same tick.
    try {
      for (const s of gameState.settlements) {
        if (s.ownedBy !== factionId) continue;
        const done = buildingDoneRef.current.get(s.id);
        if (done) {
          push({
            id: `building_done:${s.id}`,
            category: 'building_done',
            entity: `settlement:${s.id}`,
            title: `${done.label} complete at ${s.name}`,
            subtitle: 'Building slot free',
            focus: { kind: 'body', bodyId: s.bodyId },
            severity: 'normal',
            sortKey: done.tick,
          });
          continue;                      // done implies idle; don't say both
        }
        if (!s.buildingQueue) {
          // Only surface an idle slot if there's an upgrade here the
          // player can actually pay for. A screen full of "building
          // nothing" you can't afford is nagging, not opportunity.
          const have = spendableAt(s.bodyId);
          const kinds = s.type === 'city' ? CITY_BUILDINGS : STATION_BUILDINGS;
          const canBuildSomething = kinds.some(kind =>
            canPay(have, nextBuildingCost(kind, buildingLevel(s, kind))),
          );
          if (!canBuildSomething) continue;
          push({
            id: `building_idle:${s.id}`,
            category: 'building_idle',
            entity: `settlement:${s.id}`,
            title: `${s.name} building nothing`,
            subtitle: 'No upgrade under construction',
            focus: { kind: 'body', bodyId: s.bodyId },
            severity: 'normal',
          });
        }
      }
    } catch { /* defensive */ }

    // ---- Research: completions, unlocks, and stalls ----
    try {
      // Is a project already running? Decides whether a completion is a
      // DECISION ("pick what's next") or just news. Same bug Sean caught
      // on buildings: "Pick the next project" kept demanding a decision
      // the player had already made. Unlike buildings, we can't just drop
      // the stamp when a new project starts — the server auto-promotes
      // the next queued project on the same tick a level completes, so
      // clearing would hide EVERY completion from anyone using the
      // research queue, including what it unlocked.
      const researchingNow = !!gameState.factionTech?.[factionId]?.researching;
      for (const [track, done] of researchDoneRef.current) {
        const def = (TECH_DEFS as Record<string, { name?: string }>)[track];
        const name = def?.name ?? track;
        // Name what the level actually opened up — with gating on, that
        // is the whole reason the level mattered.
        const opened = unlocksAt(track as Parameters<typeof unlocksAt>[0], done.level)
          .map(u => u.label);
        // Already researching and nothing was unlocked: no decision to
        // make and nothing to report. Don't manufacture a row.
        if (researchingNow && opened.length === 0) continue;
        push({
          id: `research_done:${track}:${done.level}`,
          category: 'research_done',
          // News, not a decision, while the next project is under way.
          tier: researchingNow ? 'opportunity' : undefined,
          title: `${name} ${done.level} complete`,
          subtitle: opened.length
            ? `Unlocked: ${opened.slice(0, 3).join(', ')}${opened.length > 3 ? ` +${opened.length - 3}` : ''}`
            : 'Pick the next project',
          focus: { kind: 'panel', panel: 'research' },
          severity: 'normal',
          sortKey: done.tick,
        });
      }

      // Committed to a track with no science coming in. The project is
      // not slow — it is stopped, and nothing else says so.
      const tech = gameState.factionTech?.[factionId];
      if (tech?.researching) {
        const lvl = tech.levels?.industry ?? 0;
        const inc = computeIncomePerTick(
          factionId, gameState.settlements, gameState.bodies, gameState.ships,
          1 + (TECH_DEFS.industry?.perLevel ?? 0) * lvl,
        );
        const sci = (inc.delivered?.science ?? 0) + (inc.local?.science ?? 0);
        if (sci <= 0) {
          push({
            id: 'research_stall',
            category: 'research_stall',
            title: 'Research stalled — no science income',
            subtitle: 'Build a Lab, or route science to your pool',
            focus: { kind: 'panel', panel: 'research' },
            severity: 'warn',
          });
        }
      }
    } catch { /* defensive */ }

    // ---- Hurt, and no longer shooting ----
    // in_combat clears a few ticks after the last shot, so a settlement
    // left at 15% HP went silent exactly when it most needed help.
    try {
      for (const s of gameState.settlements) {
        if (s.ownedBy !== factionId || !s.maxHp) continue;
        if (ticksSinceCombat(s, tick) <= COMBAT_RECENT_TICKS) continue;
        const r = s.hp / s.maxHp;
        if (r > DAMAGED_HP_RATIO) continue;
        push({
          id: `damaged:settlement:${s.id}`,
          category: 'damaged',
          entity: `settlement:${s.id}`,
          title: `${s.name} at ${Math.round(r * 100)}% HP`,
          subtitle: 'Damaged and undefended',
          focus: { kind: 'body', bodyId: s.bodyId },
          severity: r <= 0.25 ? 'danger' : 'warn',
          sortKey: r,
        });
      }
      for (const ship of gameState.ships) {
        if (ship.ownedBy !== factionId) continue;
        // TRUE max, not stored base — with the raw hpMax a ranked/teched
        // hull at 50% real HP computed r ≈ 0.65 and never crossed the
        // DAMAGED_HP_RATIO gate, hiding exactly the hulls most worth
        // reporting (veterans). Same fix as the in_combat block.
        const max = effectiveShipMaxHp(ship, gameState.factionTech?.[ship.ownedBy]);
        if (!max || ship.hp == null) continue;
        if (ticksSinceCombat(ship, tick) <= COMBAT_RECENT_TICKS) continue;
        const r = ship.hp / max;
        if (r > DAMAGED_HP_RATIO) continue;
        push({
          id: `damaged:ship:${ship.id}`,
          category: 'damaged',
          // Mid-transit there is NO decision available — you can't
          // repair, dock, or reroute a burning hull mid-burn. It's a
          // heads-up until it arrives, at which point the transit
          // clears and this promotes itself back to the decision tier
          // (playtest: "what needs a decision about this?").
          tier: ship.transit ? 'opportunity' : undefined,
          entity: `ship:${ship.id}`,
          title: `${ship.name} at ${Math.round(r * 100)}% HP`,
          subtitle: ship.transit ? 'Damaged — in transit, act on arrival' : 'Damaged — pull it back or repair',
          focus: { kind: 'ship', shipId: ship.id },
          severity: r <= 0.25 ? 'danger' : 'warn',
          sortKey: r,
        });
      }
    } catch { /* defensive */ }

    // ---- Idle colony hulls ----
    // The idle check only ever matched class === 'freighter', so after
    // the freighter/colony split the most expensive hull in the game
    // could sit parked forever without a word.
    try {
      for (const ship of gameState.ships) {
        if (ship.ownedBy !== factionId || ship.class !== 'colony') continue;
        if (ship.transit || shipHasPendingOrders(ship)) continue;
        if (routedShipIds.has(ship.id)) continue;
        push({
          id: `idle_colony:${ship.id}`,
          category: 'idle_colony',
          entity: `ship:${ship.id}`,
          title: `${ship.name} idle at ${bodyName(ship.orbit.parentBodyId)}`,
          subtitle: 'Colony ship — expansion stalled',
          focus: { kind: 'ship', shipId: ship.id },
          severity: 'normal',
        });
      }
    } catch { /* defensive */ }

    // ---- Trade routes that can no longer run ----
    try {
      for (const r of (gameState.tradeRoutes ?? []) as TradeRoute[]) {
        if (r.ownedBy !== factionId) continue;
        const ship = r.shipId ? byId.get(r.shipId) : undefined;
        // A route needs its hauler, a settlement to load from, and a
        // collector to unload into. Losing any of the three leaves the
        // route on the books doing nothing.
        const hasEnd = (bodyId: string) =>
          gameState.settlements.some(s => s.ownedBy === factionId && s.bodyId === bodyId);
        const reason = !ship
          ? 'Hauler lost'
          : !hasEnd(r.originBodyId)
            ? `No holding at ${bodyName(r.originBodyId)}`
            : !hasEnd(r.destBodyId)
              ? `No holding at ${bodyName(r.destBodyId)}`
              : null;
        if (!reason) continue;
        push({
          id: `broken_route:${r.id}`,
          category: 'broken_route',
          title: `Trade route broken — ${reason}`,
          subtitle: 'Reassign or clear the route',
          focus: { kind: 'panel', panel: 'trades' },
          severity: 'warn',
        });
      }
    } catch { /* defensive */ }

    // ---- Votes that resolved ----
    try {
      for (const [id, v] of voteClosedRef.current) {
        push({
          id: `vote_closed:${id}`,
          category: 'vote_closed',
          title: `Vote closed — ${v.title}`,
          subtitle: 'Result in Senate',
          focus: { kind: 'panel', panel: 'senate' },
          severity: 'normal',
          sortKey: v.tick,
        });
      }
    } catch { /* defensive */ }

    // ---- Discoveries (YOUR finds, recent) ----
    // A backstop for the banner: a find lingers here for a while so it's
    // never lost to the event-log scroll if the banner was missed. Only
    // your own discoveries — a rival's is intel, handled elsewhere.
    try {
      for (const b of bodies) {
        const sec = b.secret;
        if (!sec?.revealed || sec.discoveredByFactionId !== factionId) continue;
        if (sec.discoveredAtTick == null) continue;
        // Close once the banner has shown it — that's "seen". The tick
        // window is only a fallback for finds that never bannered.
        if (isDiscoveryAcked(b.id, sec.discoveredAtTick)) continue;
        if (tick - sec.discoveredAtTick > DISCOVERY_TTL_TICKS) continue;
        const def = SECRET_DEFS[sec.kind];
        push({
          id: `discovery:${b.id}`,
          category: 'discovery',
          entity: `body:${b.id}`,
          title: `${def?.displayName ?? 'Discovery'} at ${b.name}`,
          subtitle: def ? stripDiscoveryPrefix(def.discoveryMessage) : 'A secret uncovered',
          focus: { kind: 'body', bodyId: b.id },
          severity: 'normal',
          sortKey: -sec.discoveredAtTick,   // newest first within the tier
        });
      }
    } catch { /* defensive */ }

    // ---- Fleets without a flag (DESIGN-fleets.md) ----
    // Condition-based, no stamp: the row exists exactly while the fleet
    // is leaderless and clears the instant a captain is promoted.
    try {
      for (const f of gameState.fleets ?? []) {
        if (f.ownedBy !== factionId || !f.leaderless) continue;
        const anchor = f.shipIds[0];
        push({
          id: `fleet_leaderless:${f.id}`,
          category: 'fleet_leaderless',
          title: `${f.name} is leaderless`,
          subtitle: 'Promote a member captain to restore command',
          focus: anchor ? { kind: 'ship', shipId: anchor } : undefined,
          severity: 'warn',
        });
      }
    } catch { /* defensive */ }

    // --- One row per entity: NOW suppresses the rest ---
    // A hull in combat must not also be listed as idle/arrived/new;
    // a body under fire must not also nag about stranded stockpiles.
    // Contextual rows (promoted idle yard) carry no entity key and
    // survive — they're the action the NOW row demands.
    const nowEntities = new Set(
      items.filter(i => i.tier === 'now' && i.entity).map(i => i.entity as string),
    );
    // A damaged row also owns its ship's "awaiting orders" row — one
    // ship, one ask, and repairing IS the order to give. Without this
    // the same hull sat twice in the decision tier ("Illustrious at
    // 36% HP" + "Illustrious arrived — awaiting orders", playtest).
    const damagedEntities = new Set(
      items.filter(i => i.category === 'damaged' && i.entity).map(i => i.entity as string),
    );
    const visible = items.filter(i => {
      if (i.tier !== 'now' && i.entity && nowEntities.has(i.entity)) return false;
      if ((i.category === 'arrived' || i.category === 'created')
        && i.entity && damagedEntities.has(i.entity)) return false;
      return true;
    });

    // --- Sort: tier, then each row's own clock, then insertion ---
    const tierRank = new Map(TIER_ORDER.map((t, i) => [t, i]));
    const MAXK = Number.MAX_SAFE_INTEGER;
    visible.sort((a, b) =>
      (tierRank.get(a.tier)! - tierRank.get(b.tier)!)
      || ((a.sortKey ?? MAXK) - (b.sortKey ?? MAXK)),
    );
    return visible;
  }, [gameState, factionId, tick, mpData]);
}

/** Render-friendly grouping by urgency tier (what the panel shows). */
export function groupByTier(items: SituationItem[]): Array<{
  tier: SituationTier;
  items: SituationItem[];
}> {
  const map = new Map<SituationTier, SituationItem[]>();
  for (const it of items) {
    const arr = map.get(it.tier) ?? [];
    arr.push(it);
    map.set(it.tier, arr);
  }
  const out: Array<{ tier: SituationTier; items: SituationItem[] }> = [];
  for (const tier of TIER_ORDER) {
    const arr = map.get(tier);
    if (arr && arr.length > 0) out.push({ tier, items: arr });
  }
  return out;
}
