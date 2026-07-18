// ============================================================
// useSituationItems
//
// Derives the Situation Log's nine attention categories from the
// current gameState. Each item has an entity id so a click can focus
// the relevant ship/body/UI. Until-acted-on expiration: an item
// disappears the moment its underlying condition becomes false, with
// a 10-tick max-life fallback for the time-bounded categories
// (arrived/created) so a forgotten ship eventually drops off.
//
// MP-only categories (open vote, incoming trade) accept optional
// data so the same hook works in SP without crashing.
// ============================================================

import { useEffect, useMemo, useRef } from 'react';
import type {
  GameState,
  Ship,
  TradeRoute,
} from '../types';
import {
  computeIncomingThreats,
} from '../game/threats';
import { AUTO_COMBAT_INTERVAL } from '../game/combat';
import {
  nextLevelCost,
  TECH_DEFS,
  TECH_MAX_LEVEL,
  type TechId,
} from '../game/techs';

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
  | 'tech_available';// research you can afford

export interface SituationItem {
  id: string;                     // unique within the list (category + entity)
  category: SituationCategory;
  title: string;                  // primary line
  subtitle?: string;              // secondary line (one short clause)
  /** Where a click should focus. */
  focus?:
    | { kind: 'ship'; shipId: string }
    | { kind: 'body'; bodyId: string }
    | { kind: 'panel'; panel: 'research' | 'senate' | 'trades' };
  /** Severity colour. v1 only uses 'normal' and 'warn'. */
  severity: 'normal' | 'warn';
}

const CATEGORY_ORDER: SituationCategory[] = [
  // Shooting now outranks shooting soon — an engaged hull may be dead
  // in a few ticks, an inbound burn still leaves time to react.
  'in_combat',
  'threat',
  'arrived',
  'created',
  'incoming_trade',
  'vote_open',
  'idle_shipyard',
  'idle_freighter',
  'stranded',
  'tech_available',
];

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
  tech_available:  'Research available',
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
// Helper: "no pending orders" — the v1 idleness gate.
// ------------------------------------------------------------

// ------------------------------------------------------------
// Combat recency — MUST match FleetPanel's "In Combat" badge, or the
// Situation Report and the fleet list disagree about the same hull.
// Auto-combat resolves a volley every AUTO_COMBAT_INTERVAL ticks, so
// 2x gives one volley of grace: the entry stays lit between salvoes
// and clears a couple of ticks after the last shot.
// ------------------------------------------------------------
const COMBAT_RECENT_TICKS = AUTO_COMBAT_INTERVAL * 2;

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
 * Returns a flat, ordered list of situation items grouped by category.
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

  // --- Derive the item list ---
  return useMemo(() => {
    const items: SituationItem[] = [];
    const mine = gameState.ships.filter(s => s.ownedBy === factionId);
    const byId = new Map<string, Ship>(mine.map(s => [s.id, s]));
    const bodies = gameState.bodies;
    const bodyName = (id: string | undefined) =>
      (id && bodies.find(b => b.id === id)?.name) || '?';

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
      items.push({
        id: `arrived:${ship.id}`,
        category: 'arrived',
        title: `${ship.name} arrived at ${where}`,
        subtitle: 'Awaiting orders',
        focus: { kind: 'ship', shipId: ship.id },
        severity: 'normal',
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
      items.push({
        id: `created:${ship.id}`,
        category: 'created',
        title: `${ship.name} (${ship.class}) launched at ${where}`,
        subtitle: 'Awaiting orders',
        focus: { kind: 'ship', shipId: ship.id },
        severity: 'normal',
      });
    }

    // ---- 3) Idle shipyards ----
    // For each owned body that can host a shipyard, list it if no
    // active build queue row points there. "Can host a shipyard" v1
    // rule: any owned terrestrial/moon/asteroid body. Stars and gas
    // giants are excluded since the BuildPanel rejects them too.
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
      items.push({
        id: `idle_shipyard:${body.id}`,
        category: 'idle_shipyard',
        title: `${body.name} shipyard idle`,
        subtitle: 'No ship in production',
        focus: { kind: 'body', bodyId: body.id },
        severity: 'normal',
      });
    }

    // ---- 4) Idle freighters ----
    // `routedShipIds` is shared with sections 1 + 2 — declared above.
    for (const ship of mine) {
      if (ship.class !== 'freighter') continue;
      if (shipHasPendingOrders(ship)) continue;
      if (routedShipIds.has(ship.id)) continue;
      const where = bodyName(ship.orbit.parentBodyId);
      items.push({
        id: `idle_freighter:${ship.id}`,
        category: 'idle_freighter',
        title: `${ship.name} parked at ${where}`,
        subtitle: 'No trade route assigned',
        focus: { kind: 'ship', shipId: ship.id },
        severity: 'normal',
      });
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
      items.push({
        id: `stranded:body:${bodyId}`,
        category: 'stranded',
        title: `${body?.name ?? '?'} stockpile growing`,
        subtitle: `${Math.round(total)} units banked — no collector or trade route`,
        focus: { kind: 'body', bodyId },
        severity: 'normal',
      });
    }

    // ---- 6) Vote open (MP) ----
    if (mpData?.openVotes) {
      for (const v of mpData.openVotes) {
        const closesIn = Math.max(0, v.vote_closes_at_tick - tick);
        items.push({
          id: `vote_open:${v.id}`,
          category: 'vote_open',
          title: v.title,
          subtitle: `Voting closes in T+${closesIn}`,
          focus: { kind: 'panel', panel: 'senate' },
          severity: 'warn',
        });
      }
    }

    // ---- 7) Incoming trade offers (MP) ----
    if (mpData?.incomingTrades) {
      for (const t of mpData.incomingTrades) {
        items.push({
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
      const threats = computeIncomingThreats(gameState, factionId);
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
        const stakeText = stake.length > 0
          ? `${stake.join(' + ')} at risk`
          : 'undefended';

        items.push({
          id: `threat:${bodyId}`,
          category: 'threat',
          title: `${n} hostile${n === 1 ? '' : 's'} inbound → ${body.name}`,
          subtitle: `${who} ${classes.join('/')} · ETA ${eta}t · ${stakeText}`,
          focus: { kind: 'body', bodyId },
          severity: 'warn',
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

      for (const s of gameState.ships) {
        if (s.ownedBy !== factionId) continue;
        if (s.transit) continue;
        const engaged = (s.orbit.parentBodyId != null && hostileBodies.has(s.orbit.parentBodyId))
          || ticksSinceCombat(s, tick) <= COMBAT_RECENT_TICKS;
        if (!engaged) continue;

        const where = bodies.find(b => b.id === s.orbit.parentBodyId)?.name ?? 'deep space';
        const hp = s.hp;
        const hpMax = s.hpMax;
        const hpText = hp != null && hpMax != null && hpMax > 0
          ? ` · ${Math.max(0, Math.round((hp / hpMax) * 100))}% HP`
          : '';
        // Warn only when the hull is actually losing — a winning
        // skirmish shouldn't paint the whole list red.
        const hurt = hp != null && hpMax != null && hpMax > 0 && hp / hpMax <= 0.5;

        items.push({
          id: `in_combat:ship:${s.id}`,
          category: 'in_combat',
          title: `${s.name} engaged at ${where}`,
          subtitle: `${s.class}${hpText}`,
          focus: { kind: 'ship', shipId: s.id },
          severity: hurt ? 'warn' : 'normal',
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
        const hpText = st.maxHp > 0
          ? ` · ${Math.max(0, Math.round((st.hp / st.maxHp) * 100))}% HP`
          : '';
        const hurt = st.maxHp > 0 && st.hp / st.maxHp <= 0.5;

        items.push({
          id: `in_combat:settlement:${st.id}`,
          category: 'in_combat',
          title: `${st.name} under fire`,
          subtitle: `${st.type} on ${where}${hpText}`,
          focus: { kind: 'body', bodyId: st.bodyId },
          severity: hurt ? 'warn' : 'normal',
        });
      }
    } catch { /* defensive */ }

    // ---- 9) Tech available ----
    // Any tech where (current_level < MAX) AND (player can afford
    // nextLevelCost). Capped at one item per tech tree.
    try {
      const pool = gameState.resources?.[factionId];
      const science = pool?.science ?? 0;
      const techState = gameState.factionTech?.[factionId];
      if (techState) {
        const levels = techState.levels || {};
        for (const id of Object.keys(TECH_DEFS) as TechId[]) {
          const cur = levels[id] ?? 0;
          if (cur >= TECH_MAX_LEVEL) continue;
          const cost = nextLevelCost(cur, TECH_DEFS[id]);
          if (cost > science) continue;
          items.push({
            id: `tech_available:${id}`,
            category: 'tech_available',
            title: `${TECH_DEFS[id].name} L${cur + 1} affordable`,
            subtitle: `${cost} science`,
            focus: { kind: 'panel', panel: 'research' },
            severity: 'normal',
          });
        }
      }
    } catch { /* defensive */ }

    // Sort by category order, preserving insertion order within each.
    const rank = new Map(CATEGORY_ORDER.map((c, i) => [c, i]));
    items.sort((a, b) => (rank.get(a.category)! - rank.get(b.category)!));
    return items;
  }, [gameState, factionId, tick, mpData]);
}

/** Render-friendly grouping. */
export function groupByCategory(items: SituationItem[]): Array<{
  category: SituationCategory;
  items: SituationItem[];
}> {
  const map = new Map<SituationCategory, SituationItem[]>();
  for (const it of items) {
    const arr = map.get(it.category) ?? [];
    arr.push(it);
    map.set(it.category, arr);
  }
  const out: Array<{ category: SituationCategory; items: SituationItem[] }> = [];
  for (const cat of CATEGORY_ORDER) {
    const arr = map.get(cat);
    if (arr && arr.length > 0) out.push({ category: cat, items: arr });
  }
  return out;
}
