// Polls GET /api/games/:gameId/state and feeds the result into the existing
// GameContextProvider via its externalState prop. The map canvas keeps
// reading from useGameContext() as before; in multiplayer mode the data
// just comes from the server instead of mockGameState.
//
// Polling cadence is intentionally generous (1s). Tick events broadcast on
// the room WebSocket also trigger an immediate refetch so transitions
// (build completes, ship arrives, etc.) feel snappy without spamming GET.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from './api';
import { logger, LogCategory, LogLevel } from '../game/logger';
import { isNodeCancelPending, reconcilePendingNodeCancels } from './pendingNodeCancels';
import { GameContextProvider } from '../state/gameContext';
import { MultiplayerActionsProvider } from './MultiplayerActionsContext';
import {
  Body, Ship, Faction, GameState, OrbitElements, FactionResources, FactionTechStateBase,
  Settlement, ManeuverNode, ChronicleFocus,
} from '../types';
import {
  planTorchTransfer, stepTorchShip, DEFAULT_ENGINE_G, fromG,
  TorchTransfer,
} from '../physics/torchTransfer';
import { orbitWorldPos, orbitWorldVelocity, bodyWorldVelocity } from '../physics/orbitalMechanics';
import { engineGModifier } from '../game/techs';
import {
  generateFlavor,
  type FlavorContext, type FlavorFaction, type FlavorBody,
} from '../game/flavorEngine';

// Shape of /api/games/:gid/state.
interface ServerState {
  game: {
    id: string;
    status: string;
    current_tick: number;
    tick_interval_ms: number;
    next_tick_at: number | null;
    started_at: number | null;
    completed_at?: number | null;
    map_seed: string;
    winner_faction_id?: string | null;
    victory_type?: string | null;
    /** Dyson Sphere snapshot. Null until a foundation has been laid.
     *  Server-side authoritative — populated/cleared in tickDysonSphere. */
    dyson_sphere?: {
      controllerFactionId: string;
      foundationSettlementId: string;
      startedAtTick: number;
      accumulated: { fuel: number; ore: number; credits: number; science: number };
      target:      { fuel: number; ore: number; credits: number; science: number };
      hp: number;
      maxHp: number;
    } | null;
  };
  me: {
    faction_id: string;
    slot: number;
    name: string;
    color: string;
    capital_body_id: string | null;
    resources: { metal: number; fuel: number; gold: number; science: number };
    tech_levels?: Record<string, number>;
    /** Faction ids the caller is allied with (active defense-pact /
     *  intel-share). Drives shared sensor vision. */
    ally_faction_ids?: string[];
  };
  factions: Array<{
    id: string; slot: number; name: string; color: string; status: string;
    capital_body_id: string | null;
  }>;
  bodies: Array<{
    id: string;
    template_id: string;
    name: string;
    type: string;
    parent_body_id: string | null;
    radius: number;
    soi: number | null;
    mu: number;
    orbit_radius: number | null;
    orbit_period: number | null;
    angle0: number | null;
    color: string;
    yield_metal: number;
    yield_fuel: number;
    yield_gold: number;
    yield_science: number;
    owner_faction_id: string | null;
    /** Body secret. Server only ships these fields after reveal —
     *  unrevealed secrets always come back as null/0 here. Migration 0021. */
    secret_kind?: string | null;
    secret_revealed?: number;
    secret_discovered_by_faction_id?: string | null;
    secret_discovered_at_tick?: number | null;
    /** Eccentric Kepler elements for Kuiper-class rogue asteroids.
     *  Migration 0024. All four nullable; when present the client
     *  bodyPosition uses Kepler propagation instead of the circular
     *  shortcut. */
    orbit_rp?: number | null;
    orbit_ra?: number | null;
    orbit_omega?: number | null;
    orbit_m0?: number | null;
    /** Active asteroid-weapon trajectory. Set when a faction has
     *  triggered RAM on this body via its Trajectory Control Thrusters.
     *  Migration 0024. */
    ram_target_body_id?: string | null;
    ram_start_tick?: number | null;
    ram_flip_tick?: number | null;
    ram_arrive_tick?: number | null;
    ram_acceleration?: number | null;
    ram_start_pos_x?: number | null;
    ram_start_pos_y?: number | null;
    ram_start_vel_x?: number | null;
    ram_start_vel_y?: number | null;
    ram_intercept_pos_x?: number | null;
    ram_intercept_pos_y?: number | null;
    ram_total_dv?: number | null;
    ram_owned_by_faction_id?: string | null;
  }>;
  ships: Array<{
    id: string;
    name: string;
    ship_class: string;
    owner_faction_id: string;
    parent_body_id: string;
    orbit_rp: number;
    orbit_ra: number;
    orbit_omega: number;
    orbit_m0: number;
    orbit_epoch: number;
    orbit_direction: 1 | -1;
    fuel: number;
    fuel_max: number;
    hp?: number;
    hp_max?: number;
    damage_per_tick?: number;
    /** Veterancy: confirmed kills earned by this hull. Migration 0020. */
    rank?: number;
    /** JSON blob — ShipKillRecord[] of recent kills (capped to 20). */
    combat_history?: string | null;
    /** Freighter-only: cumulative deliveries on active trade routes.
     *  Replaces the combat-record display on the ShipPanel for
     *  freighters. Migration 0025. */
    trades_completed?: number;
    status: string;
    /** Player's icon-variant pick from the build queue ('A'..'F').
     *  NULL means use the class default. Migration 0022. */
    icon_variant?: string | null;
  }>;
  settlements?: Array<{
    id: string;
    body_id: string;
    owner_faction_id: string;
    type: 'city' | 'station';
    name: string;
    hp: number;
    hp_max: number;
    population: number;
    surface_angle: number | null;
    orbit_rp: number | null;
    orbit_ra: number | null;
    orbit_omega: number | null;
    orbit_m0: number | null;
    orbit_epoch: number | null;
    stockpile_metal: number;
    stockpile_fuel: number;
    stockpile_gold: number;
    stockpile_science: number;
    created_at_tick: number;
    last_growth_tick: number | null;
    last_harvest_tick: number | null;
    /** Collector flag (0/1) — when 1 this settlement is a logistics
     *  endpoint and the empire's stockpile drain network can use it. */
    has_collector?: number;
    collector_built_tick?: number | null;
    /** JSON blob — per-kind building level counter,
     *  e.g. '{"forge":2,"mint":1}'. NULL/undefined means no buildings. */
    buildings_json?: string | null;
    /** JSON blob — single in-flight upgrade order or NULL.
     *  Shape: { id, settlement_id, kind, target_level, start_tick, complete_tick } */
    building_order_json?: string | null;
  }>;
  nodes?: Array<{
    id: string;
    ship_id: string;
    sequence: number;
    anchor_kind: string;
    anchor_body_id: string | null;
    target_body_id: string | null;
    scheduled_t: number;
    arrival_at_tick: number | null;
    dv_prograde: number;
    dv_normal: number;
    dv_radial: number;
    fuel_cost: number;
    status: 'planned' | 'committed' | 'in_transit' | 'executed';
    committed_at_tick: number | null;
    departure_body_id: string | null;
  }>;
  events?: Array<{
    id: string;
    tick_number: number;
    kind: string;
    actor_faction_id: string | null;
    target_faction_id: string | null;
    body_id: string | null;
    ship_id: string | null;
    payload: string;
    created_at_ms: number;
  }>;
  /** In-flight ship builds for the caller's faction. The tick alarm
   *  spawns the ship into `ships` when completes_at_tick is reached;
   *  this list shows the BuildPanel's "BUILDING" strip in the meantime. */
  build_queue?: Array<{
    id: string;
    body_id: string;
    ship_class: string;
    queued_at_tick: number;
    completes_at_tick: number;
    /** Player's icon pick at queue time, or null for class default. */
    icon_variant?: string | null;
  }>;
  /** Active trade routes for the caller's faction. Server names use
   *  metal/gold; the deserializer below maps to ore/credits to match
   *  the client TradeRoute shape. */
  trade_routes?: Array<{
    id: string;
    ship_id: string;
    origin_body_id: string;
    dest_body_id: string;
    status: 'outbound' | 'returning' | 'paused';
    cargo_fuel: number;
    cargo_metal: number;
    cargo_gold: number;
    cargo_science: number;
    created_at_tick: number;
  }>;
}

// Map server body.type strings to client Body.type union.
function mapBodyType(t: string): Body['type'] {
  if (t === 'gas-giant') return 'gas_giant';
  if (t === 'ice-giant') return 'ice_giant';
  return (t as Body['type']);
}

/**
 * Server-side body IDs are namespaced per game as "<gameId>:<localId>"
 * (e.g. "Reemucleoytj:sol", "Reemucleoytj:jupiter"). The rest of the
 * client codebase compares body IDs against the unprefixed literals
 * 'sol', 'jupiter', etc. — most notably in physics/torchTransfer.ts
 * where the planner reads body coordinates by local id.
 *
 * Strip the prefix once at the deserialization boundary so every
 * downstream consumer sees the same simple IDs as in single-player.
 */
function stripGameId(id: string | null | undefined): string | undefined {
  if (id == null) return undefined;
  const colon = id.indexOf(':');
  return colon === -1 ? id : id.slice(colon + 1);
}

function bodyToClient(b: ServerState['bodies'][number]): Body {
  const localId = stripGameId(b.id) ?? b.id;
  // Secret: only present if revealed. Server strips secret_kind from
  // unrevealed bodies in state.js so we don't have to second-guess it.
  // The client renderer keys off `secret.revealed` for the discovery
  // toast / "stargate active" indicator.
  const secret: Body['secret'] = (b.secret_kind && b.secret_revealed === 1)
    ? {
        kind: b.secret_kind as Body['secret'] extends infer T ? T extends { kind: infer K } ? K : never : never,
        revealed: true,
        discoveredByFactionId: b.secret_discovered_by_faction_id ?? undefined,
        discoveredAtTick: b.secret_discovered_at_tick ?? undefined,
      }
    : undefined;
  // Active ram plan — present when this body has been diverted as an
  // asteroid weapon. Server only ships these fields when a plan is set.
  const ramPlan: Body['ramPlan'] = (
    b.ram_target_body_id != null
    && b.ram_start_tick != null
    && b.ram_arrive_tick != null
    && b.ram_acceleration != null
    && b.ram_start_pos_x != null && b.ram_start_pos_y != null
    && b.ram_start_vel_x != null && b.ram_start_vel_y != null
    && b.ram_intercept_pos_x != null && b.ram_intercept_pos_y != null
    && b.ram_total_dv != null
    && b.ram_owned_by_faction_id != null
  ) ? {
    targetBodyId: stripGameId(b.ram_target_body_id) ?? b.ram_target_body_id,
    startTick: b.ram_start_tick,
    flipTick: b.ram_flip_tick ?? (b.ram_start_tick + b.ram_arrive_tick) / 2,
    arriveTick: b.ram_arrive_tick,
    acceleration: b.ram_acceleration,
    startPos: { x: b.ram_start_pos_x, y: b.ram_start_pos_y },
    startVel: { x: b.ram_start_vel_x, y: b.ram_start_vel_y },
    interceptPos: { x: b.ram_intercept_pos_x, y: b.ram_intercept_pos_y },
    totalDv: b.ram_total_dv,
    ownedBy: b.ram_owned_by_faction_id,
  } : undefined;
  return {
    id: localId,
    name: b.name,
    type: mapBodyType(b.type),
    mu: b.mu || undefined,
    parent: stripGameId(b.parent_body_id),
    orbitRadius: b.orbit_radius ?? 0,
    orbitPeriod: b.orbit_period ?? 0,
    angle0: b.angle0 ?? 0,
    radius: b.radius,
    soi: b.soi ?? Infinity,
    color: b.color,
    resources: {
      metal: b.yield_metal,
      fuel: b.yield_fuel,
      gold: b.yield_gold,
      science: b.yield_science,
    },
    ownedBy: b.owner_faction_id ?? undefined,
    secret,
    // Eccentric Kepler fields. Pass through nullable — bodyPosition
    // checks "all four present" before switching from the circular
    // shortcut to Kepler propagation.
    orbit_rp: b.orbit_rp ?? undefined,
    orbit_ra: b.orbit_ra ?? undefined,
    orbit_omega: b.orbit_omega ?? undefined,
    orbit_m0: b.orbit_m0 ?? undefined,
    ramPlan,
  };
}

function shipToClient(s: ServerState['ships'][number], muOfParent: number): Ship {
  // Period from Kepler's 3rd law: T = 2π √(a³ / μ)
  const a = (s.orbit_rp + s.orbit_ra) / 2;
  const period = muOfParent > 0
    ? 2 * Math.PI * Math.sqrt((a * a * a) / muOfParent)
    : 0;
  const orbit: OrbitElements = {
    rp: s.orbit_rp,
    ra: s.orbit_ra,
    omega: s.orbit_omega,
    M0: s.orbit_m0,
    epoch: s.orbit_epoch,
    direction: s.orbit_direction,
    period,
    parentBodyId: stripGameId(s.parent_body_id) ?? s.parent_body_id,
  };
  // Veterancy. combat_history is a JSON blob; defensive-parse so a
  // malformed blob falls back to [] rather than tanking the whole
  // /state deserialization for the rest of the ships.
  let combatHistory: Ship['combatHistory'] = undefined;
  if (s.combat_history) {
    try {
      const parsed = JSON.parse(s.combat_history);
      if (Array.isArray(parsed)) combatHistory = parsed;
    } catch { /* ignore malformed */ }
  }
  // Icon variant: server stores 'A'..'F' or null. Defensive narrow so
  // a malformed row (e.g. lowercase or garbage) falls back to undefined
  // (= class default at render time) instead of poisoning the type.
  let iconVariant: Ship['iconVariant'] = undefined;
  if (s.icon_variant && /^[A-F]$/.test(s.icon_variant)) {
    iconVariant = s.icon_variant as Ship['iconVariant'];
  }
  return {
    id: s.id,
    name: s.name,
    class: translateShipClass(s.ship_class),
    ownedBy: s.owner_faction_id,
    fuel: s.fuel,
    hp: s.hp,
    orbit,
    orders: [],
    rank: s.rank ?? 0,
    combatHistory,
    tradesCompleted: s.trades_completed ?? 0,
    iconVariant,
  };
}

// Server-to-client ship-class translation. The worker uses an older
// naming scheme ('cargo' for haulers, etc.); the client's class system
// only knows corvette / frigate / destroyer / freighter. Map unknown
// or legacy names onto the closest client class so renderers and panels
// (which all call getShipClass) don't crash the React tree.
function translateShipClass(serverClass: string): Ship['class'] {
  switch (serverClass) {
    case 'corvette':
    case 'frigate':
    case 'destroyer':
    case 'freighter':
      return serverClass;
    case 'cargo':
    case 'hauler':
      return 'freighter';
    default:
      return 'frigate';
  }
}

function settlementToClient(
  s: NonNullable<ServerState['settlements']>[number],
  parentBodyMu: number,
): Settlement {
  // Station: rebuild a circular orbit Kepler element set so the renderer
  // can draw it. City: keep surfaceAngle. Stockpile renames metal→ore,
  // gold→credits to match client conventions.
  const isStation = s.type === 'station';
  const localBodyId = stripGameId(s.body_id) ?? s.body_id;
  let orbit: OrbitElements | undefined;
  if (isStation && s.orbit_rp != null) {
    const rp = s.orbit_rp;
    const ra = s.orbit_ra ?? rp;
    const a = (rp + ra) / 2;
    const period = parentBodyMu > 0
      ? 2 * Math.PI * Math.sqrt((a * a * a) / parentBodyMu)
      : 0;
    orbit = {
      rp, ra,
      omega: s.orbit_omega ?? 0,
      M0: s.orbit_m0 ?? 0,
      epoch: s.orbit_epoch ?? 0,
      direction: 1,
      period,
      parentBodyId: localBodyId,
    };
  }
  return {
    id: s.id,
    type: s.type,
    name: s.name,
    bodyId: localBodyId,
    ownedBy: s.owner_faction_id,
    hp: s.hp,
    maxHp: s.hp_max,
    population: s.population,
    lastGrowthTick: s.last_growth_tick ?? s.created_at_tick,
    surfaceAngle: s.surface_angle ?? undefined,
    orbit,
    stockpile: {
      fuel: s.stockpile_fuel,
      ore: s.stockpile_metal,        // server 'metal' -> client 'ore'
      credits: s.stockpile_gold,     // server 'gold'  -> client 'credits'
      science: s.stockpile_science,
    },
    lastHarvestTick: s.last_harvest_tick ?? s.created_at_tick,
    // Collector flag — server stores 0/1, client uses boolean. Without
    // this the next /state poll would wipe any locally-flipped
    // hasCollector and refund the resources the player just spent.
    hasCollector: s.has_collector === 1,
    collectorBuiltTick: s.collector_built_tick ?? undefined,
    // Settlement upgrade buildings + the single in-flight upgrade.
    // Both arrive as JSON blobs on the server side; defensive parse
    // so a malformed/legacy row degrades to "no buildings" instead of
    // tanking the deserialization for the whole settlement list.
    buildings: (() => {
      if (!s.buildings_json) return undefined;
      try { return JSON.parse(s.buildings_json) ?? {}; }
      catch { return {}; }
    })(),
    buildingQueue: (() => {
      if (!s.building_order_json) return undefined;
      try {
        const o = JSON.parse(s.building_order_json);
        if (!o || !o.kind) return undefined;
        return {
          id: o.id,
          settlementId: o.settlement_id,
          kind: o.kind,
          targetLevel: o.target_level ?? 1,
          startTick: o.start_tick ?? 0,
          completeTick: o.complete_tick ?? 0,
        };
      } catch { return undefined; }
    })(),
  };
}

function nodeToClient(
  n: NonNullable<ServerState['nodes']>[number],
): ManeuverNode {
  // Server stores dv components separately; client's primary `deltav` is
  // the magnitude, with prograde/normal/radial mirroring server columns.
  const dv = Math.sqrt(n.dv_prograde * n.dv_prograde
                     + n.dv_normal   * n.dv_normal
                     + n.dv_radial   * n.dv_radial);
  // The client's ManeuverNode.status enum doesn't have 'in_transit' —
  // that's a server-internal state. From the client's POV the burn has
  // happened (the ship has a transfer arc); we keep the node marked
  // 'committed' so the existing UI continues to render it.
  const clientStatus: ManeuverNode['status'] =
    n.status === 'in_transit' ? 'committed' : n.status;
  // Strip the gameId namespace from the target body id so the client's
  // capturedAtBody matches the client-side body ids ('luna', 'mars').
  // Without this, deploy-button gates that compare against bodyId would
  // never match because the server sends '<gameId>:luna'.
  const targetLocal = n.target_body_id
    ? (stripGameId(n.target_body_id) ?? n.target_body_id)
    : undefined;
  return {
    id: n.id,
    shipId: n.ship_id,
    type: 'transfer',
    burnTime: n.scheduled_t,
    deltav: dv,
    prograde: n.dv_prograde,
    radial: n.dv_radial,
    normal: n.dv_normal,
    status: clientStatus,
    label: targetLocal ? `→ ${targetLocal}` : undefined,
    // Expose target body as a structured field so UI gates ("freighter
    // en route to here?", trade route filters) don't have to parse the
    // label string.
    capturedAtBody: targetLocal,
  };
}

// Audit-log mirroring of server chronicle events. The /state poll returns
// a rolling window of recent events (newest-first); we log each one exactly
// once, keyed by its stable id. The set is session-scoped — cleared if it
// ever grows unreasonably so a marathon game can't leak memory (the only
// cost is that a long-since-scrolled-out event could re-log, which never
// happens in practice because the server window is small and recent).
const loggedEventIds = new Set<string>();

/** Map a chronicle event kind to a logger category + level so the exported
 *  audit reads with the right severity. Unknown kinds fall back to SIM. */
function classifyChronicleEvent(kind: string): { category: LogCategory; level: LogLevel } {
  switch (kind) {
    case 'ship_destroyed':
    case 'settlement_destroyed':
    case 'asteroid_impact':
      return { category: 'COMBAT', level: 'INFO' };
    case 'asteroid_launched':
    case 'treaty_broken':
      return { category: 'THREAT', level: 'WARN' };
    case 'settlement_built':
    case 'ship_built':
    case 'building_completed':
    case 'secret_discovered':
      return { category: 'SIM', level: 'INFO' };
    case 'trade_accepted':
    case 'treaty_signed':
      return { category: 'SYSTEM', level: 'INFO' };
    default:
      return { category: 'SIM', level: 'INFO' };
  }
}

function serverToGameState(srv: ServerState, callerFactionId: string): GameState {
  // Keep the audit log's tick column in sync with the server clock. Without
  // this, every MP log entry stamps "T+ -" (the logger's tick is otherwise
  // only set by the single-player engine, which never runs in MP).
  logger.setCurrentTick(srv.game.current_tick);

  const bodies = srv.bodies.map(bodyToClient);
  // muById is keyed on the stripped local body id (matching what
  // bodyToClient produces). Strip server-side references before lookup
  // so we don't pass mu=0 into Kepler's 3rd law and end up with NaN
  // periods.
  const muById = new Map(bodies.map(b => [b.id, b.mu ?? 0]));
  const muOf = (rawId: string | null | undefined) =>
    muById.get(stripGameId(rawId) ?? '') ?? 0;
  const ships = srv.ships.map(s => shipToClient(s, muOf(s.parent_body_id)));

  // Tag the caller's faction as the "player" so all the existing client
  // code that checks ownedBy === 'player' keeps working without rewrites.
  const PLAYER_TOKEN = 'player';
  for (const b of bodies) {
    if (b.ownedBy === callerFactionId) b.ownedBy = PLAYER_TOKEN;
  }
  for (const s of ships) {
    if (s.ownedBy === callerFactionId) s.ownedBy = PLAYER_TOKEN;
  }

  const factions: Faction[] = srv.factions.map(f => ({
    id: f.id === callerFactionId ? PLAYER_TOKEN : f.id,
    name: f.name,
    color: f.color,
    isPlayer: f.id === callerFactionId,
  }));

  const playerRes: FactionResources = {
    fuel: srv.me.resources.fuel,
    ore: srv.me.resources.metal,         // server's 'metal' is our 'ore'
    credits: srv.me.resources.gold,      // server's 'gold' is our 'credits'
    science: srv.me.resources.science,
  };

  // Carry the server's authoritative tech levels into the existing
  // client GameState shape so TechPanel keeps reading from the same
  // place in single-player and multiplayer.
  const playerTech: FactionTechStateBase = {
    levels: srv.me.tech_levels ?? {},
    researching: null,
    progress: 0,
  };

  const settlements: Settlement[] = (srv.settlements ?? []).map(s => {
    const settlement = settlementToClient(s, muOf(s.body_id));
    if (settlement.ownedBy === callerFactionId) settlement.ownedBy = PLAYER_TOKEN;
    return settlement;
  });

  const orders: ManeuverNode[] = (srv.nodes ?? []).map(nodeToClient);

  // Attach each caller's node to its ship.orders so per-ship UIs find them.
  if (orders.length > 0) {
    const byShip = new Map<string, ManeuverNode[]>();
    for (const o of orders) {
      if (!byShip.has(o.shipId)) byShip.set(o.shipId, []);
      byShip.get(o.shipId)!.push(o);
    }
    for (const s of ships) {
      const list = byShip.get(s.id);
      if (list) s.orders = list;
    }
  }

  // Reconstruct ship transit state from committed/in_transit nodes.
  //
  // Phase 5 of the Bezier→Torch migration: the SERVER still records
  // transfers as Bezier-shaped maneuver-node rows (target body +
  // scheduled tick + arrival tick + fuel cost) but the CLIENT
  // reconstructs them as torch trajectories for rendering and
  // gameplay. We pivot here so the server protocol doesn't have to
  // change yet — server validation, arrival authority, and tick
  // advancement all stay as-is, but the visualization and per-ship
  // (pos, vel) calc become torch.
  //
  // For each in_transit node we plan a torch trajectory from the
  // ship's known orbit at scheduled_t, then integrate forward to
  // currentTick to get the live (pos, vel). For committed-but-not-
  // yet-fired nodes we leave a planned-transit pending so the canvas
  // can draw a dashed preview.
  const shipById = new Map(ships.map(s => [s.id, s]));
  const currentTick = srv.game.current_tick;

  // A ship can have MULTIPLE live nodes when the player chains transfers:
  // the leg in flight now plus one or more future legs (each a 'committed'
  // row whose scheduled_t == the previous leg's arrival). Only the ACTIVE
  // leg becomes ship.transit (solid line); future legs become
  // ship.queuedTransits (dashed, chained from the prior leg's arrival).
  //
  // The old code set ship.transit for EVERY committed/in_transit node, so a
  // freshly-queued second leg (committed, future scheduled_t) overwrote the
  // active one and the ship appeared to teleport straight to the second
  // target — that was the "chaining replaces the node" bug. The server was
  // always right (it only fires a committed node once scheduled_t arrives);
  // only this client-side reconstruction was collapsing the chain.
  const liveNodesByShip = new Map<string, NonNullable<ServerState['nodes']>>();
  const liveNodeIds = new Set<string>();
  for (const n of (srv.nodes ?? [])) {
    if (!n.target_body_id) continue;
    if (n.status !== 'committed' && n.status !== 'in_transit') continue;
    // Arrived but not yet swept to 'executed' — don't resurrect it.
    if (n.arrival_at_tick != null && n.arrival_at_tick <= currentTick) continue;
    liveNodeIds.add(n.id);
    // The player just cancelled this leg; the server row is still
    // 'committed' until the POST lands. Suppress it so the queued leg
    // stays removed instead of flickering back on this poll.
    if (isNodeCancelPending(n.id)) continue;
    const arr = liveNodesByShip.get(n.ship_id);
    if (arr) arr.push(n);
    else liveNodesByShip.set(n.ship_id, [n]);
  }
  // Stop suppressing any pending cancel the server has now applied (the
  // node is no longer in the live set).
  reconcilePendingNodeCancels(liveNodeIds);

  for (const [shipId, nodes] of liveNodesByShip) {
    const ship = shipById.get(shipId);
    if (!ship) continue;
    // Earliest first so the active leg is processed before the chain.
    nodes.sort((a, b) => a.scheduled_t - b.scheduled_t);

    const faction = factions.find(f => f.id === ship.ownedBy);
    // Same engine-g formula as single-player: stored faction baseline
    // scaled by the local player's flight-tech tier (other factions' tech
    // is opaque over the protocol, so their ships get the baseline).
    // UNIT FIX: faction.engineG is in units of 1g (e.g. 0.05); fromG scales
    // it to in-game accel — see SP gameContext.tsx for the matching fix.
    const baseAccel = fromG(faction?.engineG ?? DEFAULT_ENGINE_G);
    const techScale = ship.ownedBy === srv.me.faction_id ? engineGModifier(playerTech) : 1;
    const engineAccel = baseAccel * techScale;

    const queued: TorchTransfer[] = [];
    let priorPlan: TorchTransfer | null = null;
    for (const n of nodes) {
      const targetLocalId = stripGameId(n.target_body_id!) ?? n.target_body_id!;

      // Launch (pos, vel): the active leg launches from the ship's parked
      // orbit at scheduled_t; a chained future leg launches from the prior
      // leg's predicted arrival point + that body's velocity, mirroring the
      // local enqueueTorchTransfer chain so the dashed arc lines up.
      let launchPos: { x: number; y: number };
      let launchVel: { x: number; y: number };
      if (priorPlan) {
        const pp = priorPlan;  // const capture — keeps the find() closure off the loop var
        const priorBody = bodies.find(b => b.id === pp.targetBodyId);
        launchPos = { x: pp.interceptPos.x, y: pp.interceptPos.y };
        launchVel = priorBody
          ? bodyWorldVelocity(priorBody, pp.arriveTick, bodies)
          : { x: 0, y: 0 };
      } else {
        launchPos = orbitWorldPos(ship.orbit, n.scheduled_t, bodies);
        launchVel = orbitWorldVelocity(ship.orbit, n.scheduled_t, bodies);
      }

      const plan = planTorchTransfer(
        { pos: launchPos, vel: launchVel },
        targetLocalId,
        engineAccel, engineAccel,
        n.scheduled_t, bodies,
      );
      if (!plan) continue;

      // Server is canonical for "when does the ship park" — snap to its
      // authoritative arrival tick and re-center the flip.
      if (n.arrival_at_tick != null && n.arrival_at_tick > n.scheduled_t) {
        plan.arriveTick = n.arrival_at_tick;
        plan.flipTick = (plan.startTick + plan.arriveTick) / 2;
      }

      // Active = the burn has started (in_transit) or its scheduled_t has
      // come up. There is at most one such leg; the rest are future.
      const isActive = n.status === 'in_transit' || n.scheduled_t <= currentTick;
      if (isActive && !ship.transit) {
        const state = {
          pos: { x: launchPos.x, y: launchPos.y },
          vel: { x: launchVel.x, y: launchVel.y },
        };
        const dt = Math.max(0, currentTick - n.scheduled_t);
        if (dt > 0) stepTorchShip(state, plan, n.scheduled_t, dt, bodies);
        plan.nodeId = n.id;
        ship.transit = { pos: state.pos, vel: state.vel, currentTransfer: plan };
      } else {
        // Carry the server node id so the UI can cancel this leg
        // server-side, not just locally.
        plan.nodeId = n.id;
        queued.push(plan);
      }
      priorPlan = plan;
    }

    if (queued.length > 0) ship.queuedTransits = queued;
  }

  // Server-side chronicle entries -> human-readable combat log.
  //
  // Payloads now carry pre-resolved faction names (owner_faction_name,
  // killer_faction_name) so we don't need to join against the factions
  // map for every render. The factionNameById fallback covers older
  // chronicle rows written before the server-side enrichment landed.
  const factionNameById = new Map(srv.factions.map(f => [f.id, f.name]));
  const nameOfFaction = (id: string | null | undefined, fallback?: string): string => {
    if (fallback) return fallback;
    if (!id) return 'Unknown';
    return factionNameById.get(id) ?? 'Unknown';
  };
  const formatEvent = (ev: NonNullable<ServerState['events']>[number]): string => {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(ev.payload || '{}'); } catch { /* ignore */ }
      const t = `T+${ev.tick_number}`;

      if (ev.kind === 'ship_destroyed') {
        const name = (parsed.ship_name as string) ?? 'Unknown';
        const cls = (parsed.ship_class as string) ?? 'ship';
        const where = (parsed.body_name as string) ?? 'space';
        const owner = nameOfFaction(ev.actor_faction_id, parsed.owner_faction_name as string | undefined);
        const killer = nameOfFaction(parsed.killer_faction_id as string | null, parsed.killer_faction_name as string | undefined);
        // "destroyed by Unknown" is uninformative — only attribute when
        // we actually have a killer id (the chronicle stored null for
        // pre-attribution rows).
        const tail = parsed.killer_faction_id ? ` by ${killer}` : '';
        return `${t}  ${owner}'s ${cls} ${name} destroyed at ${where}${tail}`;
      }

      if (ev.kind === 'settlement_destroyed') {
        const sName = (parsed.settlement_name as string) ?? null;
        const sType = (parsed.settlement_type as string) ?? 'settlement';
        const where = (parsed.body_name as string) ?? 'unknown body';
        const owner = nameOfFaction(ev.actor_faction_id, parsed.owner_faction_name as string | undefined);
        const killer = nameOfFaction(parsed.killer_faction_id as string | null, parsed.killer_faction_name as string | undefined);
        const tail = parsed.killer_faction_id ? ` by ${killer}` : '';
        const label = sName ? `${sType} ${sName}` : sType;
        return `${t}  ${owner}'s ${label} on ${where} destroyed${tail}`;
      }

      if (ev.kind === 'asteroid_launched') {
        const asteroid = (parsed.asteroid_name as string) ?? 'an asteroid';
        const target = (parsed.target_name as string) ?? 'a planet';
        const eta = (parsed.ticks_to_impact as number) ?? 0;
        const launcher = nameOfFaction(ev.actor_faction_id);
        return `${t}  ⚠ ${launcher} diverts ${asteroid} toward ${target} — impact in T-${eta} ticks`;
      }

      if (ev.kind === 'asteroid_impact') {
        const asteroid = (parsed.asteroid_name as string) ?? 'asteroid';
        const target = (parsed.target_name as string) ?? 'a body';
        const count = (parsed.settlements_destroyed as number) ?? 0;
        const sol = parsed.sol_special === true;
        const aggressor = nameOfFaction(ev.actor_faction_id);
        if (sol) return `${t}  ${asteroid} evaporated into Sol (no effect) — launched by ${aggressor}`;
        return `${t}  💥 IMPACT — ${asteroid} struck ${target}, ${count} settlement${count !== 1 ? 's' : ''} destroyed${ev.actor_faction_id ? ` (${aggressor})` : ''}`;
      }

      if (ev.kind === 'settlement_built') {
        const sType = (parsed.settlement_type as string) ?? 'settlement';
        const sName = (parsed.settlement_name as string) ?? null;
        const where = (parsed.body_name as string) ?? 'a body';
        const owner = nameOfFaction(ev.actor_faction_id, parsed.owner_faction_name as string | undefined);
        const label = sName ? `${sType} ${sName}` : sType;
        return `${t}  ${owner} founded ${label} on ${where}`;
      }

      if (ev.kind === 'ship_built') {
        const cls = (parsed.ship_class as string) ?? 'ship';
        const name = (parsed.ship_name as string) ?? null;
        const where = (parsed.body_name as string) ?? 'orbit';
        const owner = nameOfFaction(ev.actor_faction_id, parsed.owner_faction_name as string | undefined);
        const label = name ? `${cls} ${name}` : cls;
        return `${t}  ${owner}'s yard at ${where} launched a ${label}`;
      }

      if (ev.kind === 'building_completed') {
        const kind = (parsed.building_kind as string) ?? 'building';
        const lvl = (parsed.new_level as number) ?? 1;
        const sName = (parsed.settlement_name as string) ?? 'settlement';
        const where = (parsed.body_name as string) ?? 'a body';
        const owner = nameOfFaction(ev.actor_faction_id, parsed.owner_faction_name as string | undefined);
        return `${t}  ${owner}'s ${sName} on ${where} completed ${kind} L${lvl}`;
      }

      if (ev.kind === 'secret_discovered') {
        // The server already wrote a human-readable message into the
        // payload (e.g. "Ceres: DISCOVERY — a derelict destroyer is
        // salvageable. Claimed."). Just surface it with the timestamp.
        const owner = nameOfFaction(ev.actor_faction_id);
        const msg = (parsed.message as string) ?? `${parsed.kind ?? 'something'} at ${parsed.body_name ?? 'a body'}`;
        return `${t}  🔍 ${owner}: ${msg}`;
      }

      // --------- Diplomacy events ---------
      // Pact-kind labels — keep in sync with src/multiplayer/api.ts
      // PACT_LABELS but expanded so the log copy reads grammatically.
      const pactLabel = (k: string): string => {
        if (k === 'nap') return 'Non-Aggression Pact';
        if (k === 'defense_pact') return 'Defense Pact';
        if (k === 'intel_share') return 'Intel-Share Pact';
        return 'pact';
      };

      // Human-readable resource bundle. Drops zero entries so a
      // pure-pact trade doesn't say "0M 0F 0C 0S".
      const fmtBundle = (b: unknown): string => {
        if (!b || typeof b !== 'object') return 'nothing';
        const o = b as Record<string, number>;
        const parts: string[] = [];
        if ((o.metal ?? 0) > 0)   parts.push(`${o.metal} metal`);
        if ((o.fuel ?? 0) > 0)    parts.push(`${o.fuel} fuel`);
        if ((o.gold ?? 0) > 0)    parts.push(`${o.gold} credits`);
        if ((o.science ?? 0) > 0) parts.push(`${o.science} science`);
        return parts.length ? parts.join(', ') : 'nothing';
      };

      if (ev.kind === 'trade_accepted') {
        const proposer = nameOfFaction(ev.actor_faction_id);
        const responder = nameOfFaction(ev.target_faction_id);
        const offer = fmtBundle(parsed.offer);
        const request = fmtBundle(parsed.request);
        const pacts = Array.isArray(parsed.pacts) ? (parsed.pacts as string[]) : [];
        const pactTail = pacts.length
          ? ` + ${pacts.map(pactLabel).join(', ')}`
          : '';
        return `${t}  ⚖ ${proposer} traded ${offer} → ${responder} for ${request}${pactTail}`;
      }

      if (ev.kind === 'treaty_signed') {
        const a = nameOfFaction(ev.actor_faction_id);
        const b = nameOfFaction(ev.target_faction_id);
        const kind = pactLabel((parsed.kind as string) ?? 'pact');
        return `${t}  🕊 ${a} & ${b} signed ${kind}`;
      }

      if (ev.kind === 'treaty_broken') {
        const breaker = nameOfFaction(ev.actor_faction_id);
        const other = nameOfFaction(ev.target_faction_id);
        const kind = pactLabel((parsed.kind as string) ?? 'pact');
        return `${t}  ⚔ ${breaker} broke the ${kind} with ${other} — war resumes`;
      }

      if (ev.kind === 'senate_vote') {
        // Was falling through to the raw "senate_vote" kind. Build a
        // real headline: the bill title + outcome.
        const title = (parsed.title as string) ?? 'a motion';
        const outcome = (parsed.outcome as string) ?? 'resolved';
        return `${t}  ⚖ Senate: “${title}” ${outcome}`;
      }

      return `${t}  ${ev.kind}`;
    };

  // Server returns newest-first; we want chronological for both the UI log
  // and the audit mirror.
  const orderedEvents = (srv.events ?? []).slice().reverse();
  if (loggedEventIds.size > 4000) loggedEventIds.clear();
  const combatLog: string[] = orderedEvents.map(ev => {
    const msg = formatEvent(ev);
    // Mirror each chronicle event into the audit log exactly once. This is
    // the only path battles / discoveries / builds / diplomacy reach the
    // exported log in multiplayer — the sim runs server-side, so the
    // single-player engine's logger hooks never fire here.
    if (!loggedEventIds.has(ev.id)) {
      loggedEventIds.add(ev.id);
      const { category, level } = classifyChronicleEvent(ev.kind);
      logger.log(level, category, msg, {
        kind: ev.kind,
        ...(ev.actor_faction_id ? { actor: ev.actor_faction_id } : {}),
        ...(ev.target_faction_id ? { target: ev.target_faction_id } : {}),
        ...(ev.body_id ? { body: ev.body_id } : {}),
        ...(ev.ship_id ? { ship: ev.ship_id } : {}),
      });
    }
    return msg;
  });

  // Prose flavor for the event log — parallel-indexed with combatLog.
  // Resolved from the SAME structured chronicle events the headlines
  // came from (factions + bodies are in scope here), so the EventLog
  // can reveal a narrative body when a row is expanded. null where the
  // event kind has no flavor bank or its payload couldn't be enriched;
  // the panel falls back to echoing the headline in that case.
  const flavorFactions = new Map<string, FlavorFaction>(
    srv.factions.map(f => [f.id, { id: f.id, name: f.name, capitalBodyId: f.capital_body_id }]),
  );
  const flavorBodies = new Map<string, FlavorBody>(
    srv.bodies.map(b => [b.id, { id: b.id, name: b.name, type: b.type, orbitRadius: b.orbit_radius ?? undefined }]),
  );
  const flavorCtx: FlavorContext = { factions: flavorFactions, bodies: flavorBodies };
  const chronicleFlavor: (string | null)[] = orderedEvents.map(ev => {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(ev.payload || '{}'); } catch { /* ignore */ }
    return generateFlavor({
      id: ev.id,
      kind: ev.kind,
      tick: ev.tick_number,
      actorFactionId: ev.actor_faction_id,
      targetFactionId: ev.target_faction_id,
      payload,
    }, flavorCtx);
  });

  // Focus target for each event's "take me there" button. Prefer the
  // ship id (most specific), fall back to the body id. Destroyed-entity
  // events still carry the id; the EventLog re-validates existence at
  // click time so a button never sends the camera to a vanished ship.
  const chronicleFocus: (ChronicleFocus | null)[] = orderedEvents.map(ev => {
    if (ev.ship_id) return { kind: 'ship', shipId: ev.ship_id };
    if (ev.body_id) return { kind: 'body', bodyId: ev.body_id };
    return null;
  });

  // Server-side build queue → client BuildOrder[]. Drives the BuildPanel
  // "BUILDING" strip while the alarm grinds toward completes_at_tick.
  // Without this, optimistic local state survived ~1.5s until the next
  // /state poll wiped it, leaving players staring at deducted resources
  // and nothing in the queue.
  const buildOrders = (srv.build_queue ?? []).map(b => {
    // Narrow the icon variant defensively so a malformed/legacy row
    // becomes "use class default" instead of poisoning the type.
    let iv: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | undefined;
    if (b.icon_variant && /^[A-F]$/.test(b.icon_variant)) {
      iv = b.icon_variant as 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
    }
    return {
      id: b.id,
      bodyId: stripGameId(b.body_id) ?? b.body_id,
      shipClass: b.ship_class as 'corvette' | 'frigate' | 'destroyer' | 'freighter',
      ownedBy: PLAYER_TOKEN,
      startTick: b.queued_at_tick,
      completeTick: b.completes_at_tick,
      // The server doesn't currently track per-order names — fall back to
      // a ship-class display label so the UI has something to render.
      shipName: b.ship_class.charAt(0).toUpperCase() + b.ship_class.slice(1),
      iconVariant: iv,
    };
  });

  // Trade routes — server cargo columns (metal/gold) → client
  // ore/credits. Strips gameId namespace from body ids so they line up
  // with bodies[] (handled the same way as everywhere else).
  const tradeRoutes = (srv.trade_routes ?? []).map(r => ({
    id: r.id,
    ownedBy: PLAYER_TOKEN,
    shipId: r.ship_id,
    originBodyId: stripGameId(r.origin_body_id) ?? r.origin_body_id,
    destBodyId: stripGameId(r.dest_body_id) ?? r.dest_body_id,
    status: r.status,
    cargo: {
      fuel: r.cargo_fuel,
      ore: r.cargo_metal,       // server metal → client ore
      credits: r.cargo_gold,    // server gold  → client credits
      science: r.cargo_science,
    },
    createdAtTick: r.created_at_tick,
  }));

  // Dyson Sphere remap. Server returns the controller's faction id +
  // settlement id in namespaced form ("<gameId>:..."). The client
  // GameState stores ownership against PLAYER_TOKEN for the caller and
  // unprefixed body/settlement ids — match the rest of the remap.
  const dysonSphere = srv.game.dyson_sphere ? (() => {
    const d = srv.game.dyson_sphere!;
    return {
      controllerFactionId: d.controllerFactionId === callerFactionId
        ? PLAYER_TOKEN
        : d.controllerFactionId,
      foundationSettlementId: stripGameId(d.foundationSettlementId) ?? d.foundationSettlementId,
      accumulated: { ...d.accumulated },
      target: { ...d.target },
      hp: d.hp,
      maxHp: d.maxHp,
      startedAtTick: d.startedAtTick,
    };
  })() : undefined;

  return {
    currentTick: srv.game.current_tick,
    nextTickAt: srv.game.next_tick_at,
    tickIntervalMs: srv.game.tick_interval_ms,
    bodies,
    ships,
    fleets: [],
    factions,
    settlements,
    orders,
    buildOrders,
    resources: { [PLAYER_TOKEN]: playerRes },
    factionTech: { [PLAYER_TOKEN]: playerTech },
    combatLog,
    chronicleFlavor,
    chronicleFocus,
    lastHarvestTick: srv.game.current_tick,
    tradeRoutes,
    dysonSphere,
    // Allies keep their own (server) faction ids on the client — only
    // the caller is remapped to PLAYER_TOKEN — so ally-owned ships carry
    // these ids and the fog-of-war friendly check matches directly.
    alliedFactionIds: srv.me.ally_faction_ids ?? [],
  };
}

interface Props {
  gameId: string;
  children: React.ReactNode;
  /** Invoked when the server says the game no longer exists (404). The
   *  parent clears the stored room id and routes back to the lobby. */
  onGameMissing?: () => void;
}

const POLL_INTERVAL_MS = 1500;

interface GameMeta {
  status: string;
  winnerFactionId: string | null;
  winnerName: string | null;
  victoryType: string | null;
  myFactionId: string;
  /** Caller's capital body id (per-game id like "<gameId>:earth"). */
  capitalBodyId: string | null;
  factions: ServerState['factions'];
}

export function MultiplayerGameProvider({ gameId, children, onGameMissing }: Props) {
  const [state, setState] = useState<GameState | null>(null);
  const [meta, setMeta] = useState<GameMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set true when the server returns 404. Stops polling + offers an exit. */
  const [missing, setMissing] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const inflightRef = useRef(false);
  // Stable ref so the polling effect doesn't tear down each render.
  const onGameMissingRef = useRef(onGameMissing);
  useEffect(() => { onGameMissingRef.current = onGameMissing; }, [onGameMissing]);

  // Tag the audit log with this game's id + mode. This also drives the
  // logger's per-game reset: entering a new game id clears the previous
  // game's persisted entries, while refreshing the same game keeps them.
  useEffect(() => {
    logger.setSession({ mode: 'multiplayer', gameId });
  }, [gameId]);

  const fetchState = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const res = await apiFetch<ServerState>(`/api/games/${gameId}/state`);
      if (res.ok) {
        const next = serverToGameState(res.data, res.data.me.faction_id);
        setState(next);
        const winnerName = res.data.game.winner_faction_id
          ? (res.data.factions.find(f => f.id === res.data.game.winner_faction_id)?.name ?? null)
          : null;
        setMeta({
          status: res.data.game.status,
          winnerFactionId: res.data.game.winner_faction_id ?? null,
          winnerName,
          victoryType: res.data.game.victory_type ?? null,
          myFactionId: res.data.me.faction_id,
          capitalBodyId: stripGameId(res.data.me.capital_body_id) ?? null,
          factions: res.data.factions,
        });
        setError(null);
      } else if (res.status === 404 || res.error?.code === 'not_found') {
        // Game no longer exists on the server (deleted, expired, or stale
        // room id in localStorage). Stop polling and surface a bounce-out.
        setMissing(true);
      } else if (res.error?.code !== 'no_backend') {
        setError(res.error?.message ?? 'failed to load game state');
      }
    } finally {
      inflightRef.current = false;
    }
  }, [gameId]);

  // Polling loop — halts when the game is missing so we don't spam 404s.
  useEffect(() => {
    if (missing) return;
    fetchState();
    const id = setInterval(fetchState, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchState, missing]);

  // Auto-exit on missing after a brief pause so the user sees the message.
  useEffect(() => {
    if (!missing) return;
    const t = setTimeout(() => { onGameMissingRef.current?.(); }, 1200);
    return () => clearTimeout(t);
  }, [missing]);

  // Room WS: refetch on tick / completion events. Skipped if missing.
  //
  // Previously the WS opened once and was never re-opened on close —
  // a network blip would silently kill the real-time tick pings and
  // the player would be stuck on the 1.5s poll cadence (still works,
  // just feels stale) for the rest of the session. The reconnect
  // loop below schedules a fresh socket on close with exponential
  // backoff (max 30s) so a hotel-wifi flake recovers cleanly.
  useEffect(() => {
    if (missing) return;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1000;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${scheme}://${window.location.host}/api/rooms/${gameId}/ws`);
      wsRef.current = ws;
      ws.addEventListener('open', () => {
        backoffMs = 1000;        // reset backoff on a clean connect
      });
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg?.type === 'tick' || msg?.type === 'game_completed') fetchState();
        } catch { /* ignore non-json */ }
      });
      const reschedule = () => {
        if (cancelled) return;
        wsRef.current = null;
        reconnectTimer = setTimeout(() => {
          backoffMs = Math.min(backoffMs * 2, 30000);
          connect();
        }, backoffMs);
      };
      ws.addEventListener('close', reschedule);
      ws.addEventListener('error', () => {
        // 'error' is followed by 'close', so we just let close handle
        // the reschedule. Closing here would double-fire reconnect.
        try { ws?.close(); } catch { /* */ }
      });
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* */ }
      wsRef.current = null;
    };
  }, [gameId, fetchState, missing]);

  const status = useMemo(() => {
    if (missing) return 'missing';
    if (state) return 'ready';
    if (error) return 'error';
    return 'loading';
  }, [state, error, missing]);

  if (status !== 'ready' || !state) {
    return (
      <div className="mp-overlay">
        <div className="mp-card" style={{ textAlign: 'center' }}>
          {status === 'missing' ? (
            <>
              <div style={{ color: 'var(--mp-accent)', marginBottom: 8 }}>
                This game no longer exists
              </div>
              <div style={{ color: 'var(--mp-fg-dim)', fontSize: 11, marginBottom: 12 }}>
                The room may have been deleted or the game expired.
              </div>
              <button
                className="mp-submit"
                onClick={() => onGameMissingRef.current?.()}
                style={{ marginTop: 4 }}
              >
                Return to lobby
              </button>
            </>
          ) : status === 'error' ? (
            <>
              <div style={{ color: 'var(--mp-hostile)', marginBottom: 8 }}>Couldn't load game state</div>
              <div style={{ color: 'var(--mp-fg-dim)', fontSize: 11, marginBottom: 12 }}>{error}</div>
              {/* Safety net so the user is never permanently stuck. */}
              <button
                className="mp-submit"
                onClick={() => onGameMissingRef.current?.()}
                style={{ marginTop: 4 }}
              >
                Return to lobby
              </button>
            </>
          ) : (
            <div style={{ color: 'var(--mp-fg-dim)' }}>Loading game…</div>
          )}
        </div>
      </div>
    );
  }

  const gameOver = meta?.status === 'completed';
  const iWon = gameOver && meta?.winnerFactionId === meta?.myFactionId;

  // Pass caller's capital body id so the canvas auto-pans there on
  // first load instead of staring at Sol.
  return (
    <GameContextProvider
      externalState={state}
      externallyControlled
      initialFocusBodyId={meta?.capitalBodyId ?? null}
    >
      <MultiplayerActionsProvider gameId={gameId}>
        {children}
        {gameOver && (
          <div
            className="mp-overlay"
            style={{
              background: 'rgba(5, 8, 12, 0.86)',
              zIndex: 6000,
              flexDirection: 'column',
              gap: 16,
            }}
          >
            <div style={{
              fontFamily: 'Orbitron, system-ui, sans-serif',
              fontSize: 28,
              letterSpacing: '0.32em',
              color: iWon ? 'var(--mp-friendly)' : 'var(--mp-accent)',
              textShadow: iWon
                ? '0 0 24px rgba(78,205,196,0.4)'
                : '0 0 24px rgba(255,184,77,0.4)',
            }}>
              {iWon ? 'VICTORY' : 'GAME OVER'}
            </div>
            <div style={{
              fontFamily: 'var(--mp-mono)',
              fontSize: 13,
              color: 'var(--mp-fg)',
              letterSpacing: '0.12em',
              textAlign: 'center',
            }}>
              {meta?.winnerName ? (
                <>
                  <div style={{ color: 'var(--mp-accent)', marginBottom: 6 }}>
                    {meta.winnerName} {iWon ? '(you)' : ''} wins
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--mp-fg-dim)' }}>
                    Victory type: {meta.victoryType ?? 'hegemony'}
                  </div>
                </>
              ) : (
                <div style={{ color: 'var(--mp-fg-dim)' }}>No winner declared</div>
              )}
            </div>
            <button
              className="mp-submit"
              style={{ width: 'auto', padding: '10px 24px', marginTop: 12 }}
              onClick={() => onGameMissingRef.current?.()}
            >
              Return to lobby
            </button>
          </div>
        )}
      </MultiplayerActionsProvider>
    </GameContextProvider>
  );
}
