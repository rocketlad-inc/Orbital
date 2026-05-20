import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { GameState, ManeuverNode, CameraState, MapUIState, Ship, Body, TransferArc, BuildOrder, SettlementType, FactionResources, BuildingKind, SettlementBuildOrder, TradeRoute } from '../types';
// Scenarios were removed when single-player switched to SinglePlayerSetup.
// GameContextProvider now requires either an initialState (single-player,
// seeded by setupSinglePlayer) or an externalState (multiplayer, server-
// driven). The fallback empty state below is only hit if neither prop is
// passed, which would be a programming error rather than a play state.
import { createCircularOrbit, bodyWorldVelocity, orbitWorldPos } from '../physics/orbitalMechanics';
import {
  planTorchTransfer, stepTorchShip,
  DEFAULT_ENGINE_ACCEL,
} from '../physics/torchTransfer';
import { getShipClass, ShipClassName, SHIP_CLASSES } from '../game/shipClasses';
import { formFleet, splitFromFleet } from '../game/fleet';
import { autoCombatAtBodies } from '../game/combat';
import { logger } from '../game/logger';
import {
  createCity, createStation, tickSettlements,
  canHostCity, canHostStation, SETTLEMENT_DEFS,
  COLLECTOR_COST,
  BUILDING_DEFS, buildingCostForNextLevel, buildingTimeForNextLevel,
  buildingLevel, shipyardSlotsAtBody,
} from '../game/settlements';
import { computeSecretReveal } from '../game/secrets';
import { tickMaintenance } from '../game/maintenance';
import { TechId, TECH_DEFS, MAX_SCIENCE_PER_TICK } from '../game/techs';
import { runFactionAI, shouldRunAI } from '../game/factionAI';
import { planBezierTransfer } from '../physics/bezierTransfer';
import type { AIActivityEntry } from '../types';
import { useTurnBasedSettings } from './turnBasedSettings';

// === AI intent application helpers ===========================
// These translate the AI brain's pure intents into concrete game-state
// mutations during a tick. Lives at module scope so the per-tick reducer
// stays focused on time advancement.

type AIIntentResult = {
  applied: boolean;
  ships?: Ship[];
  settlements?: import('../types').Settlement[];
  buildOrders?: BuildOrder[];
  factionPools?: Record<string, FactionResources>;
};

function applyAIIntent(
  intent: import('../game/factionAI').AIActionIntent,
  snapshot: GameState,
  factionId: string,
  tick: number,
): AIIntentResult {
  switch (intent.kind) {
    case 'build_ship': {
      const classDef = SHIP_CLASSES[intent.shipClass];
      if (!classDef) return { applied: false };
      const pool = snapshot.resources[factionId];
      if (!pool || pool.ore < classDef.cost.ore || pool.credits < classDef.cost.credits) {
        return { applied: false };
      }
      const newOrder: BuildOrder = {
        id: `build-ai-${tick}-${Math.random().toString(36).slice(2, 6)}`,
        bodyId: intent.bodyId,
        shipClass: intent.shipClass,
        ownedBy: factionId,
        startTick: tick,
        completeTick: tick + classDef.buildTime,
        shipName: intent.name,
      };
      const newPools = { ...snapshot.resources };
      newPools[factionId] = {
        ...pool,
        ore: pool.ore - classDef.cost.ore,
        credits: pool.credits - classDef.cost.credits,
      };
      return {
        applied: true,
        buildOrders: [...snapshot.buildOrders, newOrder],
        factionPools: newPools,
      };
    }

    case 'deploy_settlement': {
      const def = SETTLEMENT_DEFS[intent.settlementType];
      const pool = snapshot.resources[factionId];
      if (!pool || pool.ore < def.cost.ore || pool.credits < def.cost.credits) {
        return { applied: false };
      }
      const body = snapshot.bodies.find(b => b.id === intent.bodyId);
      if (!body) return { applied: false };
      const settlement = intent.settlementType === 'city'
        ? createCity(body, factionId, tick, intent.name)
        : createStation(body, factionId, tick, snapshot.bodies, intent.name);
      const newPools = { ...snapshot.resources };
      newPools[factionId] = {
        ...pool,
        ore: pool.ore - def.cost.ore,
        credits: pool.credits - def.cost.credits,
      };
      return {
        applied: true,
        settlements: [...snapshot.settlements, settlement],
        factionPools: newPools,
      };
    }

    case 'transfer': {
      const ship = snapshot.ships.find(s => s.id === intent.shipId);
      if (!ship) return { applied: false };
      // No double-launching: a ship already in transit (torch OR legacy
      // bezier) refuses a new transfer intent until it arrives.
      if (ship.transit || ship.transfer || ship.pendingTransfer) return { applied: false };

      const faction = snapshot.factions.find(f => f.id === ship.ownedBy);
      const engineAccel = faction?.engineG ?? DEFAULT_ENGINE_ACCEL;

      // Ship's launch state: world position from its current orbit, world
      // velocity from the parent body's motion. Phase 1 simplification —
      // ignores the ship's orbital velocity around its parent (small
      // compared to the torch burn). Phase 7 polish can add that back.
      const launchPos = orbitWorldPos(ship.orbit, tick, snapshot.bodies);
      const parent = snapshot.bodies.find(b => b.id === ship.orbit.parentBodyId);
      const launchVel = parent
        ? bodyWorldVelocity(parent, tick, snapshot.bodies)
        : { x: 0, y: 0 };

      const plan = planTorchTransfer(
        { pos: launchPos, vel: launchVel },
        intent.targetBodyId,
        engineAccel, engineAccel,         // symmetric for v1
        tick, snapshot.bodies,
      );
      if (!plan) return { applied: false };

      const updatedShips = snapshot.ships.map(s =>
        s.id === ship.id
          ? {
              ...s,
              transit: {
                pos: { x: launchPos.x, y: launchPos.y },
                vel: { x: launchVel.x, y: launchVel.y },
                currentTransfer: plan,
              },
              // Clear any legacy bezier state — torch takes over.
              transfer: undefined,
              pendingTransfer: undefined,
              queuedTransfers: undefined,
            }
          : s
      );
      return { applied: true, ships: updatedShips };
    }

    case 'research': {
      // Set researching field; the per-tick research drain (already in
      // advanceToTick) will pour science into it on subsequent ticks.
      // Mutating factionTech here would race with the drain — easier to
      // skip the application step and have the AI re-evaluate next cycle
      // once its science pool has built up. For now: no-op success.
      // Future: extend the result type to include a factionTech patch.
      return { applied: false };
    }

    default:
      return { applied: false };
  }
}

function classifyNote(intents: import('../game/factionAI').AIActionIntent[]): AIActivityEntry['kind'] {
  if (intents.length === 0) return 'idle';
  const first = intents[0];
  if (first.kind === 'build_ship') return 'build';
  if (first.kind === 'deploy_settlement') return 'deploy';
  if (first.kind === 'transfer') return 'transfer';
  if (first.kind === 'research') return 'research';
  return 'idle';
}

// ----------------------------------------------------------------
// Single-player tick pacing — see DESIGN.md "Time and pacing".
//
// At 1× sim speed, one tick passes every 7.5 real minutes — matching
// the multiplayer reference cadence (worker/lobby.js
// DEFAULT_TICK_INTERVAL_MS = 450_000). Earth→Jupiter Hohmann (~290
// ticks at our physics) is therefore ~1.5 real days at 1×, and a
// 4000-tick match is the design "3-week" length.
//
// Players spend most single-player time at 10× – 1000×; the 100_000×
// cap (see TopBar SIM_SPEEDS) lets a full game replay in a few real
// minutes on fast-forward.
// ----------------------------------------------------------------
export const MS_PER_TICK_AT_1X = 450_000;        // 7.5 real minutes per tick at 1×
export const TICKS_PER_GAME_DAY = (24 * 60 * 60 * 1000) / MS_PER_TICK_AT_1X; // = 192
const BASE_TICK_RATE = 1000 / MS_PER_TICK_AT_1X; // ticks per real second at 1×

interface GameContextType {
  gameState: GameState;
  camera: CameraState;
  uiState: MapUIState;
  simSpeed: number;

  setGameState: (state: GameState) => void;
  updateGameState: (partial: Partial<GameState>) => void;
  updateTick: (tick: number) => void;
  setSimSpeed: (speed: number) => void;

  updateCamera: (camera: Partial<CameraState>) => void;
  focusBody: (bodyId: string | undefined) => void;

  selectShip: (shipId: string) => void;
  deselectShip: () => void;
  selectBody: (bodyId: string) => void;
  deselectBody: () => void;
  hoverBody: (bodyId: string | null) => void;
  setTargetSelectionMode: (enabled: boolean) => void;

  addManeuverNode: (node: ManeuverNode) => void;
  commitManeuverNode: (nodeId: string) => void;
  deleteManeuverNode: (nodeId: string) => void;
  setPendingTransfer: (shipId: string, arc: TransferArc | undefined) => void;
  addQueuedTransfer: (shipId: string, arc: TransferArc) => void;

  /** Launch a torch transfer for the named ship. Used by player UI and
   *  the AI's 'transfer' intent. Returns true if the burn was created,
   *  false if the ship is already in transit, target is invalid, or
   *  the ship's faction's engine is broken (engineG <= 0). */
  launchTorchTransfer: (shipId: string, targetBodyId: string) => boolean;

  // Ship building
  buildShip: (bodyId: string, shipClass: ShipClassName, name: string) => boolean;
  cancelBuild: (buildOrderId: string) => void;

  // Fleet management
  createFleet: (name: string, shipIds: string[]) => void;
  disbandFleet: (fleetId: string) => void;
  removeFromFleet: (fleetId: string, shipId: string) => void;
  addToFleet: (fleetId: string, shipId: string) => void;

  // Settlements
  deploySettlement: (bodyId: string, type: SettlementType, name?: string) => boolean;
  damageSettlement: (settlementId: string, dmg: number) => void;
  /** Upgrade an existing settlement with a collector. Drains the
   *  player's ore/credits (COLLECTOR_COST). Returns true on success,
   *  false if the settlement isn't owned by the player, already has a
   *  collector, or the player can't afford it. */
  buildCollector: (settlementId: string) => boolean;
  /** Queue a building upgrade at a settlement (forge / mint / lab on
   *  cities; weapons / shipyard on stations). Debits the cost
   *  immediately, schedules completion at `completeTick`. Returns
   *  false if the settlement isn't player-owned, the building doesn't
   *  match the host type, another upgrade is already in flight, or
   *  resources are short. */
  queueBuilding: (settlementId: string, kind: BuildingKind) => boolean;
  /** Cancel an in-flight building upgrade. Refunds 50% of the spend. */
  cancelBuilding: (settlementId: string) => boolean;
  selectedSettlementId?: string;
  selectSettlement: (id: string | undefined) => void;

  // Trade routes (SP). Assign a freighter to ferry cargo between an
  // origin settlement and a destination collector. The freighter
  // auto-pilots in advanceToTick: fill at origin → transfer → dump at
  // dest → transfer back → loop until cancelled. Cargo is captured by
  // the killer's pool if the freighter dies en route.
  createTradeRoute: (
    shipId: string,
    originBodyId: string,
    destBodyId: string,
  ) => boolean;
  cancelTradeRoute: (routeId: string) => void;

  // Research / tech tree
  startResearch: (techId: TechId) => void;
  cancelResearch: () => void;
  enqueueResearch: (techId: TechId) => void;     // add to end of queue
  dequeueResearch: (techId: TechId) => void;     // remove from queue
  moveResearchUp: (techId: TechId) => void;      // shift toward front of queue

  // Debug / admin: bump a faction's pools by `delta` (positive grants,
  // negative drains). Pass factionId='all' to apply the same delta to
  // every faction. Mutates local state immediately; in MP the caller is
  // responsible for also posting to the server-side grant endpoint.
  adjustResources: (
    factionId: string | 'all',
    delta: Partial<{ fuel: number; ore: number; credits: number; science: number }>,
  ) => void;

  // Turn-Based Mode (experimental). `turnBasedActive` is true only when
  // the player has opted into TBM AND the game isn't externally controlled
  // (multiplayer is server-driven, so the toggle is a no-op there for now).
  // `commitTurn` jumps the sim forward by the configured ticksPerTurn and
  // is the only way time advances while TBM is active.
  turnBasedActive: boolean;
  commitTurn: () => void;
}

const GameContext = createContext<GameContextType | undefined>(undefined);

interface GameContextProviderProps {
  children: React.ReactNode;
  /**
   * Seeded single-player state from SinglePlayerSetup. One of `initialState`
   * or `externalState` should always be provided; if neither is, the
   * provider falls back to an empty world (programming-error path).
   */
  initialState?: GameState;
  /**
   * If set, the provider treats this as the authoritative source of game
   * state — it replaces local state whenever the prop reference changes
   * and skips the local sim interval. Used by MultiplayerGameProvider
   * to drive the canvas from server snapshots.
   */
  externalState?: GameState | null;
  /**
   * When true, suppress the local 60Hz sim loop. Required in multiplayer
   * where the server's tick scheduler is authoritative.
   */
  externallyControlled?: boolean;
  /**
   * If set, focus the camera on this body once the body exists in
   * gameState. Used by MultiplayerGameProvider to drop the player at
   * their capital instead of staring at Sol on first load.
   */
  initialFocusBodyId?: string | null;
}

/** Empty fallback GameState — only hit if a GameContextProvider is mounted
 *  without either initialState or externalState (programming error). */
function emptyGameState(): GameState {
  return {
    currentTick: 0,
    bodies: [],
    ships: [],
    fleets: [],
    factions: [],
    settlements: [],
    orders: [],
    buildOrders: [],
    resources: {},
    factionTech: {},
    combatLog: [],
    lastHarvestTick: 0,
    aiActivityLog: [],
    status: 'lobby',
  };
}

export function GameContextProvider({
  children,
  initialState,
  externalState,
  externallyControlled = false,
  initialFocusBodyId = null,
}: GameContextProviderProps) {
  const [gameState, setGameStateInternal] = useState<GameState>(
    () => externalState ?? initialState ?? emptyGameState()
  );

  // Replace gameState whenever the external snapshot changes reference.
  //
  // Important: in multiplayer the /state poll arrives every ~1.5s. A naive
  // wholesale replacement (`setGameStateInternal(externalState)`) clobbered
  // any locally-planned transfers + pendingTransfer that the player had
  // drawn but not yet COMMITted — so the COMMIT button vanished mid-plan
  // every time the next poll landed. We post to the server only on commit
  // (see ShipPanel + commitTransferLocal), so the server legitimately
  // doesn't know about the local plan yet.
  //
  // Fix: merge the local plan back onto the server snapshot. For each ship
  // in externalState, preserve:
  //   - any local order with status === 'planned' that isn't already on
  //     the server (matched by id)
  //   - the local pendingTransfer if the server hasn't already started a
  //     transfer for that ship (which would mean the player already
  //     committed and the server is executing it)
  useEffect(() => {
    if (!externalState) return;
    setGameStateInternal(prev => {
      const mergedShips = externalState.ships.map(serverShip => {
        const localShip = prev.ships.find(s => s.id === serverShip.id);
        if (!localShip) return serverShip;

        // Local planned orders the server doesn't have yet
        const serverOrderIds = new Set(serverShip.orders.map(o => o.id));
        const localPlanned = localShip.orders.filter(
          o => o.status === 'planned' && !serverOrderIds.has(o.id),
        );

        // pendingTransfer: only keep local if the server isn't already
        // executing a transfer (which would imply the player has committed)
        const pendingTransfer = serverShip.transfer
          ? undefined
          : (localShip.pendingTransfer ?? serverShip.pendingTransfer);

        if (localPlanned.length === 0 && pendingTransfer === serverShip.pendingTransfer) {
          return serverShip;
        }
        return {
          ...serverShip,
          orders: localPlanned.length > 0
            ? [...serverShip.orders, ...localPlanned]
            : serverShip.orders,
          pendingTransfer,
        };
      });

      // Re-derive top-level orders list from the merged per-ship orders so
      // the global GameState.orders stays in sync.
      const allOrders = mergedShips.flatMap(s => s.orders);
      return { ...externalState, ships: mergedShips, orders: allOrders };
    });
  }, [externalState]);

  // One-shot: focus the camera on the requested body the first time
  // that body shows up in gameState. Used by MultiplayerGameProvider
  // to land the player at their capital instead of staring at Sol,
  // and by SinglePlayerView for the same reason.
  //
  // Scale picked so the body itself shows as ~80px on a typical
  // viewport, regardless of body radius — Pluto (r=1.5) zooms way
  // more than Jupiter (r=8). This is the "drop me at home" view,
  // not the "see the whole system" view.
  const initialFocusAppliedRef = useRef(false);
  useEffect(() => {
    if (initialFocusAppliedRef.current) return;
    if (!initialFocusBodyId) return;
    const body = gameState.bodies.find(b => b.id === initialFocusBodyId);
    if (!body) return;
    initialFocusAppliedRef.current = true;
    const targetPx = 80;
    const radius = Math.max(0.5, body.radius ?? 3);
    const scale = Math.max(2, Math.min(60, targetPx / (2 * radius)));
    // zoomLevel is a 1|2|3 UI mode (discrete), not the actual render
    // scale — bucket the computed scale into the nearest slot.
    const zoomLevel: CameraState['zoomLevel'] =
      scale >= 10 ? 3 : scale >= 4 ? 2 : 1;
    setCameraInternal(prev => ({
      ...prev, focusedBodyId: initialFocusBodyId, x: 0, y: 0, scale, zoomLevel,
    }));
  }, [initialFocusBodyId, gameState.bodies]);
  const [camera, setCameraInternal] = useState<CameraState>({
    x: 0, y: 0, scale: 1, zoomLevel: 1,
  });
  const [uiState, setUIStateInternal] = useState<MapUIState>({
    selectedShipId: undefined,
    selectedBodyId: undefined,
    hoveredBodyId: undefined,
  });
  const [simSpeed, setSimSpeedInternal] = useState<number>(0);
  const [selectedSettlementId, setSelectedSettlementId] = useState<string | undefined>(undefined);

  // Ship state machine — handles both the new torch model and the
  // legacy Bezier model during the migration. Per tick:
  //
  //   • If ship.transit is set: TORCH — integrate (pos, vel) for the
  //     elapsed dt via stepTorchShip. On arrival, snap the ship into
  //     a circular parking orbit around the target body and clear
  //     transit. Drain fuel proportional to the Δv expended this tick.
  //
  //   • Else if ship.transfer is set: LEGACY BEZIER — original flow.
  //     Kept until Phase 6 cleanup so in-flight Bezier transfers in
  //     old saves can complete cleanly.
  //
  //   • Else: parked — check committed maneuver nodes (legacy path).
  //
  // The tick delta we step is (tick - prevTick) where prevTick is the
  // last tick we observed. We don't have prevTick directly, so derive
  // it: ship.transit.currentTransfer.startTick is the launch instant;
  // we integrate from that into the future. To handle multi-tick
  // advances cleanly we always integrate from "now" relative to the
  // ship's stored state — the stepTorchShip integrator is dt-based.
  const checkNodeExecution = useCallback((ships: Ship[], bodies: Body[], tick: number, prevTick?: number): Ship[] => {
    let mutated = false;
    const updatedShips = ships.map(ship => {
      let orbit = ship.orbit;
      let fuel = ship.fuel;
      let orders = ship.orders;
      let transfer = ship.transfer;
      let pendingTransfer = ship.pendingTransfer;
      let queuedTransfers = ship.queuedTransfers ? [...ship.queuedTransfers] : [];
      let transit = ship.transit;
      let changed = false;

      if (transit) {
        // Torch transit: integrate (pos, vel) forward to `tick`.
        const plan = transit.currentTransfer;
        const fromTick = prevTick ?? plan.startTick;
        const dt = tick - fromTick;
        if (dt > 0) {
          const stepped = {
            pos: { x: transit.pos.x, y: transit.pos.y },
            vel: { x: transit.vel.x, y: transit.vel.y },
          };
          stepTorchShip(stepped, plan, fromTick, dt, bodies);
          transit = { ...transit, pos: stepped.pos, vel: stepped.vel };
          // Fuel drain: Δv expended this tick = a · dt during the burn
          // (zero outside [startTick, arriveTick]). Phase 1 uses a
          // simple "10× Δv" cost matching the legacy bezier fuel
          // formula so building/economy balance carries over.
          const burnStart = Math.max(plan.startTick, fromTick);
          const burnEnd   = Math.min(plan.arriveTick, tick);
          if (burnEnd > burnStart) {
            const accelPhase = Math.max(0, Math.min(plan.flipTick, burnEnd) - burnStart);
            const brakePhase = Math.max(0, burnEnd - Math.max(plan.flipTick, burnStart));
            const dvThisStep = plan.acceleration * accelPhase + plan.brakeAcceleration * brakePhase;
            fuel = Math.max(0, fuel - Math.round(dvThisStep * 10));
          }
          changed = true;

          // Arrival: snap into a circular parking orbit around the
          // target body. The orbit's parent becomes the target; Pe is
          // set to body.radius * 1.5 for a comfortable safe altitude.
          if (tick >= plan.arriveTick - 1e-9) {
            const target = bodies.find(b => b.id === plan.targetBodyId);
            const parkRadius = target ? Math.max(target.radius * 1.5, 6) : 10;
            orbit = createCircularOrbit(plan.targetBodyId, parkRadius, tick, bodies);
            transit = undefined;
          }
        }
      } else if (transfer) {
        // Loop arrival processing so a single large tickDelta can chain
        // through multiple queued legs (e.g. fast-forward through a patrol).
        while (transfer && tick >= transfer.arrivalTime) {
          const cost = Math.round(Math.abs(transfer.arrivalDv) * 10);
          fuel = Math.max(0, fuel - cost);

          if (queuedTransfers.length > 0) {
            const nextArc = queuedTransfers.shift()!;
            const depCost = Math.round(Math.abs(nextArc.departureDv) * 10);
            fuel = Math.max(0, fuel - depCost);
            transfer = nextArc;
            const chainBody = bodies.find(b => b.id === nextArc.departureBodyId);
            const chainRadius = chainBody ? chainBody.radius + 4 : 10;
            orbit = createCircularOrbit(nextArc.departureBodyId, chainRadius, tick, bodies);
          } else {
            const arrBodyId = transfer.arrivalBodyId;
            const arrBody = bodies.find(b => b.id === arrBodyId);
            const arrRadius = arrBody ? arrBody.radius + 4 : 10;
            orbit = createCircularOrbit(arrBodyId, arrRadius, tick, bodies);
            transfer = undefined;
          }
          changed = true;
        }
      } else {
        // Ship is orbiting — check for departure burns
        const sortedOrders = [...orders].sort((a, b) => a.burnTime - b.burnTime);
        const executedIds: string[] = [];
        for (const node of sortedOrders) {
          if (node.status === 'committed' && node.burnTime <= tick) {
            if (pendingTransfer && node.type === 'transfer') {
              // Departure: switch to transit
              const cost = Math.round(Math.abs(node.deltav) * 10);
              fuel = Math.max(0, fuel - cost);
              transfer = pendingTransfer;
              pendingTransfer = undefined;
            }
            executedIds.push(node.id);
            changed = true;
          }
          // NOTE: previously we also auto-expired planned nodes whose burn
          // window had passed. That made the COMMIT button disappear at
          // higher sim speeds — the 5-tick launch buffer flies by in
          // seconds at 10×+ and the player loses the ability to commit
          // the plan they just drew. Planned nodes now persist until the
          // player explicitly commits or deletes them. If a planned
          // transfer is committed after its original departure window,
          // commitManeuverNode refreshes the arc to depart at currentTick+5
          // before flipping status. See the "stale arc refresh" block in
          // commitManeuverNode.
        }
        if (executedIds.length > 0) {
          orders = orders.filter(o => !executedIds.includes(o.id));
        }
      }

      if (changed) {
        mutated = true;
        // Don't store an empty queuedTransfers array — keep undefined so
        // ships without any queued legs stay clean.
        const nextQueued = queuedTransfers.length > 0 ? queuedTransfers : undefined;
        return { ...ship, orbit, fuel, orders, transfer, pendingTransfer, queuedTransfers: nextQueued, transit };
      }
      return ship;
    });
    return mutated ? updatedShips : ships;
  }, []);

  // Single source of truth for advancing the game state to a target tick.
  // Used by both the realtime setInterval loop and the +10 skip button.
  const advanceToTick = useCallback((prev: GameState, newTime: number): GameState => {
    // If the match is already complete, freeze time. The VictoryOverlay
    // is showing and the player can either start a new campaign or back
    // out — we shouldn't keep advancing ticks behind the modal.
    if (prev.status === 'completed') return prev;

    const tickDelta = Math.max(0, newTime - prev.currentTick);
    // Keep logger's tick context fresh so every entry below has the right T+
    logger.setCurrentTick(newTime);

    // Detect transfer arrivals (ships that had a transfer last frame but
    // not this frame) BEFORE checkNodeExecution mutates them, so we can
    // log meaningful arrival events.
    const updatedShips0 = checkNodeExecution(prev.ships, prev.bodies, newTime, prev.currentTick);
    if (updatedShips0 !== prev.ships) {
      const prevById = new Map(prev.ships.map(s => [s.id, s]));
      for (const s of updatedShips0) {
        const before = prevById.get(s.id);
        if (!before) continue;
        if (before.transfer && !s.transfer) {
          // Just arrived (or chained to next leg). transfer was cleared.
          logger.info('SIM', `Transfer arrived: ${s.name} → ${s.orbit.parentBodyId}`);
        } else if (before.pendingTransfer && !s.pendingTransfer && s.transfer) {
          // Departure burn fired
          logger.info('SIM', `Transfer departed: ${s.name} → ${s.transfer.arrivalBodyId}`, {
            arrival: Math.round(s.transfer.arrivalTime),
          });
        }
      }
    }
    let updatedShips = updatedShips0;

    // Process build orders
    let buildOrders = prev.buildOrders;
    const completedBuilds = buildOrders.filter(bo => newTime >= bo.completeTick);
    if (completedBuilds.length > 0) {
      const newShips: Ship[] = completedBuilds.map(bo => {
        const classDef = getShipClass(bo.shipClass as ShipClassName);
        logger.info('SIM', `Build complete: ${bo.shipName} (${bo.shipClass}) at ${bo.bodyId}`, {
          ownedBy: bo.ownedBy,
        });
        return {
          id: `ship-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: bo.shipName,
          class: bo.shipClass,
          ownedBy: bo.ownedBy,
          fuel: classDef.fuelCapacity,
          hp: classDef.hp,
          orbit: createCircularOrbit(bo.bodyId, 8, newTime, prev.bodies),
          orders: [],
        };
      });
      updatedShips = [...updatedShips, ...newShips];
      buildOrders = buildOrders.filter(bo => newTime < bo.completeTick);
    }

    // Settlement building completions — when a settlement's
    // buildingQueue.completeTick is reached, bump the level and clear
    // the queue so a new upgrade can be started. Cost was debited at
    // queue time so this loop is pure level-flipping.
    let settlementBuildingsDirty = false;
    const preSettlements = prev.settlements.map(s => {
      const q = s.buildingQueue;
      if (!q || newTime < q.completeTick) return s;
      settlementBuildingsDirty = true;
      const cur = s.buildings ?? {};
      logger.info('SIM', `Building complete: ${BUILDING_DEFS[q.kind].displayName} L${q.targetLevel} at ${s.name}`, {
        settlementId: s.id, kind: q.kind, level: q.targetLevel,
      });
      return {
        ...s,
        buildings: { ...cur, [q.kind]: q.targetLevel },
        buildingQueue: undefined,
      };
    });

    // Settlement extraction + freighter offload
    const factionPools: Record<string, FactionResources> = {};
    for (const [fid, fr] of Object.entries(prev.resources)) {
      factionPools[fid] = { ...fr };
    }
    // Per-faction Industry-tech yield multiplier.
    const yieldMul: Record<string, number> = {};
    for (const [fid, ts] of Object.entries(prev.factionTech)) {
      const lvl = ts.levels['industry'] ?? 0;
      yieldMul[fid] = 1 + TECH_DEFS.industry.perLevel * lvl;
    }
    const settlementsResult = tickSettlements(
      preSettlements, prev.bodies, updatedShips, newTime, factionPools, yieldMul,
    );
    if (settlementBuildingsDirty) settlementsResult.changed = true;
    let updatedSettlements = settlementsResult.settlements;

    // === Trade routes ============================================
    // For each active route, auto-pilot the freighter:
    //   - mid-transit → skip (transfer is already in flight)
    //   - at origin with empty cargo → fill from settlement stockpile,
    //     plan transfer to dest
    //   - at dest with non-empty cargo → dump cargo to faction pool,
    //     plan transfer back to origin
    //   - "off course" (in orbit somewhere else) → plan transfer to
    //     whichever endpoint matches the current status
    //
    // Cargo capacity is fixed at 50 of each resource (matches the
    // freighter shipClass cargoCapacity). Routes whose freighter is
    // missing (dead) are dropped — piracy code in combat hands the
    // cargo to the killer separately.
    let updatedRoutes = (prev.tradeRoutes ?? []).filter(
      r => updatedShips.some(s => s.id === r.shipId),
    );
    if (updatedRoutes.length > 0) {
      // Per-faction flight-speed multiplier (Flight Dynamics tech).
      // Larger multiplier = faster transit; we feed this into the
      // existing planBezierTransfer travelTimeMul argument.
      const flightMul: Record<string, number> = {};
      for (const [fid, ts] of Object.entries(prev.factionTech)) {
        const lvl = ts.levels['flight'] ?? 0;
        flightMul[fid] = Math.max(0.2, 1 - TECH_DEFS.flight.perLevel * lvl);
      }
      const CARGO_CAP = 50;
      const nextShips = [...updatedShips];
      const nextSettlements = [...updatedSettlements];
      updatedRoutes = updatedRoutes.map(route => {
        const shipIdx = nextShips.findIndex(s => s.id === route.shipId);
        if (shipIdx < 0) return route;
        const ship = nextShips[shipIdx];
        if (ship.transfer) return route;            // mid-transit
        if (route.status === 'paused') return route;

        const here = ship.orbit.parentBodyId;
        const cargo = { ...route.cargo };
        const cargoTotal = cargo.fuel + cargo.ore + cargo.credits + cargo.science;

        // PICKUP — at origin body with empty hold. Vacuum up to
        // CARGO_CAP of each resource from any of the player's
        // settlements at the origin body, scaled by what's available.
        if (here === route.originBodyId && cargoTotal < 1) {
          let pickedUp = false;
          for (let i = 0; i < nextSettlements.length; i++) {
            const s = nextSettlements[i];
            if (s.bodyId !== route.originBodyId) continue;
            if (s.ownedBy !== route.ownedBy) continue;
            const take = {
              fuel:    Math.min(CARGO_CAP - cargo.fuel,    s.stockpile.fuel),
              ore:     Math.min(CARGO_CAP - cargo.ore,     s.stockpile.ore),
              credits: Math.min(CARGO_CAP - cargo.credits, s.stockpile.credits),
              science: Math.min(CARGO_CAP - cargo.science, s.stockpile.science),
            };
            if (take.fuel + take.ore + take.credits + take.science <= 0) continue;
            cargo.fuel    += take.fuel;
            cargo.ore     += take.ore;
            cargo.credits += take.credits;
            cargo.science += take.science;
            nextSettlements[i] = {
              ...s,
              stockpile: {
                fuel:    s.stockpile.fuel    - take.fuel,
                ore:     s.stockpile.ore     - take.ore,
                credits: s.stockpile.credits - take.credits,
                science: s.stockpile.science - take.science,
              },
            };
            pickedUp = true;
          }
          // Plan the outbound leg regardless — even an empty
          // origin gets the freighter cycling, so the next tick
          // it can try again. Without this an empty stockpile
          // would strand the freighter forever.
          const arc = planBezierTransfer(
            ship.orbit, route.destBodyId, newTime, prev.bodies, flightMul[ship.ownedBy] ?? 1,
          );
          if (arc) {
            nextShips[shipIdx] = { ...ship, transfer: arc };
            if (pickedUp) {
              logger.info('SIM', `Trade route: ${ship.name} loaded ${Math.round(cargo.fuel + cargo.ore + cargo.credits + cargo.science)}u, → ${route.destBodyId}`);
            }
            return { ...route, cargo, status: 'outbound' as const };
          }
          return { ...route, cargo };
        }

        // DELIVERY — at dest body with cargo in the hold. Dump
        // everything into the faction pool and head home.
        if (here === route.destBodyId && cargoTotal > 0) {
          if (!factionPools[ship.ownedBy]) {
            factionPools[ship.ownedBy] = { fuel: 0, ore: 0, credits: 0, science: 0 };
          }
          const pool = factionPools[ship.ownedBy];
          pool.fuel    += cargo.fuel;
          pool.ore     += cargo.ore;
          pool.credits += cargo.credits;
          pool.science += cargo.science;
          logger.info('SIM', `Trade route: ${ship.name} delivered ${Math.round(cargoTotal)}u to ${route.destBodyId}`);
          const arc = planBezierTransfer(
            ship.orbit, route.originBodyId, newTime, prev.bodies, flightMul[ship.ownedBy] ?? 1,
          );
          if (arc) {
            nextShips[shipIdx] = { ...ship, transfer: arc };
            return { ...route, cargo: { fuel: 0, ore: 0, credits: 0, science: 0 }, status: 'returning' as const };
          }
          return { ...route, cargo: { fuel: 0, ore: 0, credits: 0, science: 0 } };
        }

        // OFF-COURSE recovery — ship is in orbit somewhere other
        // than origin or dest (e.g. player manually transferred
        // it). Send it back to whichever endpoint matches the
        // current status so the route resumes.
        const target = route.status === 'outbound' ? route.destBodyId : route.originBodyId;
        if (here !== target) {
          const arc = planBezierTransfer(
            ship.orbit, target, newTime, prev.bodies, flightMul[ship.ownedBy] ?? 1,
          );
          if (arc) {
            nextShips[shipIdx] = { ...ship, transfer: arc };
          }
        }
        return route;
      });
      updatedShips = nextShips;
      updatedSettlements = nextSettlements;
    }

    // Auto-combat: every ship and combat-capable settlement fires once every
    // AUTO_COMBAT_INTERVAL ticks at every hostile combatant at the same body.
    // Apply per-faction Weapons-tech damage multiplier.
    const damageMul: Record<string, number> = {};
    for (const [fid, ts] of Object.entries(prev.factionTech)) {
      const lvl = ts.levels['weapons'] ?? 0;
      damageMul[fid] = 1 + TECH_DEFS.weapons.perLevel * lvl;
    }
    const combatResult = autoCombatAtBodies(updatedShips, updatedSettlements, prev.bodies, newTime, damageMul);
    updatedShips = combatResult.ships;
    updatedSettlements = combatResult.settlements;
    const combatNewLogs = combatResult.log;
    // Mirror each combat line into the categorized logger so it shows up in
    // the exported .txt with the right tick + category.
    for (const line of combatNewLogs) {
      const isKill = /destroyed!/.test(line);
      if (isKill) logger.error('COMBAT', line);
      else logger.info('COMBAT', line);
    }

    // === Piracy ============================================
    // Any destroyed freighter with cargo loaded on a trade route
    // hands the cargo to whoever landed the killing volley. The
    // route itself is removed (the freighter no longer exists).
    if (combatResult.killedShips.length > 0 && updatedRoutes.length > 0) {
      const aliveRoutes: typeof updatedRoutes = [];
      for (const r of updatedRoutes) {
        const kill = combatResult.killedShips.find(k => k.shipId === r.shipId);
        if (!kill) { aliveRoutes.push(r); continue; }
        const cargo = r.cargo;
        const cargoTotal = cargo.fuel + cargo.ore + cargo.credits + cargo.science;
        const killer = kill.killerFactionId;
        if (killer && cargoTotal > 0) {
          if (!factionPools[killer]) {
            factionPools[killer] = { fuel: 0, ore: 0, credits: 0, science: 0 };
          }
          const pool = factionPools[killer];
          pool.fuel    += cargo.fuel;
          pool.ore     += cargo.ore;
          pool.credits += cargo.credits;
          pool.science += cargo.science;
          combatNewLogs.push(
            `${killer} captured ${Math.round(cargoTotal)}u from a freighter's hold`,
          );
          logger.warn('COMBAT', `Piracy: ${killer} captured ${Math.round(cargoTotal)}u of cargo`, {
            shipId: r.shipId, killer,
          });
        }
        // Route ends regardless — the freighter is gone.
      }
      updatedRoutes = aliveRoutes;
    }

    // Prune destroyed ships from fleet membership. A fleet with <2 surviving
    // ships dissolves; lead ship that died gets reassigned.
    let updatedFleets = prev.fleets;
    if (combatNewLogs.length > 0) {
      const aliveIds = new Set(updatedShips.map(s => s.id));
      updatedFleets = prev.fleets
        .map(f => {
          const survivors = f.shipIds.filter(id => aliveIds.has(id));
          if (survivors.length === f.shipIds.length) return f;
          const newLead = aliveIds.has(f.leadShipId) ? f.leadShipId : survivors[0];
          return { ...f, shipIds: survivors, leadShipId: newLead };
        })
        .filter(f => f.shipIds.length >= 2);

      // Detach fleetId from any ship whose fleet was dissolved
      const survivingFleetIds = new Set(updatedFleets.map(f => f.id));
      updatedShips = updatedShips.map(s =>
        s.fleetId && !survivingFleetIds.has(s.fleetId) ? { ...s, fleetId: undefined } : s
      );
    }

    // Repair and refuel ships at owned bodies (after combat so dead ships are gone)
    updatedShips = tickMaintenance(updatedShips, updatedSettlements, prev.bodies, tickDelta);

    // Research drain — for each faction with a queued tech, pour available
    // science into the research bar; level up when full. The drain is
    // capped at MAX_SCIENCE_PER_TICK so a player with a fat science
    // stockpile can't insta-complete the moment they pick a tech —
    // research now visibly accrues across many ticks. When a level
    // finishes and the faction has a queued tech, the next one
    // auto-promotes to `researching` and progress resets.
    const updatedTech: typeof prev.factionTech = {};
    const tickDeltaScale = Math.max(0.01, tickDelta); // sub-tick advances get a fractional drain too
    for (const [fid, ts0] of Object.entries(prev.factionTech)) {
      let ts = ts0;
      if (!ts.researching) { updatedTech[fid] = ts; continue; }
      const pool = factionPools[fid];
      const haveScience = pool ? pool.science : 0;
      if (haveScience <= 0) { updatedTech[fid] = ts; continue; }

      let researching: TechId | null = ts.researching as TechId;
      let progress = ts.progress;
      let levels = { ...ts.levels };
      let queue = ts.queue ? [...ts.queue] : [];

      // Per-tick spend budget: cap × tickDelta. Sub-tick advances still
      // bleed a proportional amount so the loop's behavior is the same
      // whether the realtime loop calls advanceToTick 20× at 0.1 each
      // or once at 2.0.
      const spendBudget = Math.min(haveScience, MAX_SCIENCE_PER_TICK * tickDeltaScale);
      let available = spendBudget;
      let science = haveScience;
      let iters = 0;

      while (available > 0 && researching && iters++ < 16) {
        const def = TECH_DEFS[researching];
        if (!def) break;
        const curLevel = levels[researching] ?? 0;
        const cost = Math.ceil(def.baseCost * Math.pow(curLevel + 1, def.costScaling));
        const need = cost - progress;
        const spend = Math.min(available, need);
        progress += spend;
        available -= spend;
        science -= spend;
        if (progress >= cost) {
          levels[researching] = curLevel + 1;
          progress = 0;
          // Auto-advance: pull the next tech off the queue. If empty,
          // researching becomes null and the player gets a free tick
          // until they queue something new.
          researching = queue.length > 0 ? (queue.shift() as TechId) : null;
        } else {
          // Hit the per-tick budget cap, but tech isn't done yet.
          break;
        }
      }
      if (pool) pool.science = Math.max(0, science);
      updatedTech[fid] = { ...ts, levels, progress, researching, queue };
    }

    // === Exploration secrets ================================
    // For each non-revealed body secret, check whether any non-transit
    // ship is in orbit and trigger the reveal. Persistent secrets
    // (portal_to_sun) also re-apply their effect every tick to any
    // ship at the body, not just the first to arrive.
    const secretLogs: string[] = [];
    let updatedBodies = prev.bodies;
    {
      const settlementSpawns: typeof updatedSettlements = [];
      const shipSpawns: typeof updatedShips = [];

      // Pre-compute ships-by-body so we can do a single scan.
      const shipsByBody = new Map<string, typeof updatedShips>();
      for (const sh of updatedShips) {
        if (sh.transfer) continue;
        const bid = sh.orbit.parentBodyId;
        let arr = shipsByBody.get(bid);
        if (!arr) { arr = []; shipsByBody.set(bid, arr); }
        arr.push(sh);
      }

      const newBodies = updatedBodies.map(body => {
        const s = body.secret;
        if (!s) return body;
        const localShips = shipsByBody.get(body.id) ?? [];

        // Portal: persistent effect — every ship here gets warped to Sol.
        // First arrival also flips revealed and emits the discovery log.
        if (s.kind === 'portal_to_sun' && localShips.length > 0) {
          let revealedNow: typeof s = s;
          if (!s.revealed) {
            const discoverer = localShips[0].ownedBy;
            revealedNow = { ...s, revealed: true, discoveredByFactionId: discoverer, discoveredAtTick: newTime };
            secretLogs.push(`${body.name}: DISCOVERY — an ancient stargate. Every ship arriving here will now be warped to Sol.`);
            logger.info('SIM', `Stargate at ${body.name}`, { discoverer });
          }
          // Warp every ship at the body to a low Sol orbit.
          const warpedIds = new Set(localShips.map(ls => ls.id));
          updatedShips = updatedShips.map(sh => {
            if (!warpedIds.has(sh.id)) return sh;
            return {
              ...sh,
              orbit: createCircularOrbit('sol', 18, newTime, prev.bodies),
              pendingTransfer: undefined,
              queuedTransfers: undefined,
            };
          });
          return { ...body, secret: revealedNow };
        }

        // One-shot reveals — fire once, then leave the secret as
        // revealed (so the UI knows there's something here) but
        // inert.
        if (!s.revealed && localShips.length > 0) {
          const discoverer = localShips[0].ownedBy;
          const patch = computeSecretReveal(body, discoverer, newTime);
          if (!patch) return body;
          secretLogs.push(patch.message);
          logger.info('SIM', `${s.kind} at ${body.name}`, { discoverer });

          // Apply the patch's side effects.
          if (patch.spawnSettlement) settlementSpawns.push(patch.spawnSettlement);

          if (patch.spawnShipClass) {
            const cls = getShipClass(patch.spawnShipClass as ShipClassName);
            shipSpawns.push({
              id: `ship-derelict-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              name: `${body.name} Salvage`,
              class: patch.spawnShipClass,
              ownedBy: discoverer,
              fuel: cls.fuelCapacity,
              hp: cls.hp,
              orbit: createCircularOrbit(body.id, body.radius + 6, newTime, prev.bodies),
              orders: [],
            });
          }

          if (patch.resourceGain) {
            const pool = factionPools[discoverer];
            if (pool) {
              pool.fuel    += patch.resourceGain.fuel;
              pool.ore     += patch.resourceGain.ore;
              pool.credits += patch.resourceGain.credits;
              pool.science += patch.resourceGain.science;
            }
          }

          if (patch.techBump) {
            const ts = updatedTech[discoverer] ?? { levels: {}, researching: null, progress: 0, queue: [] };
            // Pick a random tech track. Use prev.currentTick + body.id
            // as deterministic-ish seed so the same game state doesn't
            // produce different outcomes if this runs twice.
            const tracks: TechId[] = ['weapons', 'armor', 'propulsion', 'construction', 'industry', 'sensors'];
            const pick = tracks[Math.floor(Math.random() * tracks.length)];
            const cur = ts.levels[pick] ?? 0;
            updatedTech[discoverer] = {
              ...ts,
              levels: { ...ts.levels, [pick]: cur + patch.techBump.count },
            };
            secretLogs.push(`${body.name}: tech databank advanced ${pick} to L${cur + patch.techBump.count}.`);
          }

          return { ...body, secret: patch.secret };
        }

        return body;
      });

      if (settlementSpawns.length > 0) {
        updatedSettlements = [...updatedSettlements, ...settlementSpawns];
      }
      if (shipSpawns.length > 0) {
        updatedShips = [...updatedShips, ...shipSpawns];
      }
      updatedBodies = newBodies;
    }

    const combatLog = (combatNewLogs.length > 0 || secretLogs.length > 0)
      ? [...prev.combatLog.slice(-20), ...combatNewLogs, ...secretLogs]
      : prev.combatLog;

    // === Faction AI =========================================
    // Run each AI faction's decision cycle if it's due, then apply the
    // resulting intents to the in-flight tick state. Output is captured in
    // an activity log for the corner feed.
    let updatedFactions = prev.factions;
    let aiActivityLog: AIActivityEntry[] = prev.aiActivityLog ?? [];
    const aiFactions = prev.factions.filter(f => f.isAI && f.id !== 'player');
    if (aiFactions.length > 0) {
      // Snapshot reflecting all the per-tick mutations above. The AI
      // makes decisions on the world the player would see this tick.
      const aiSnapshot: GameState = {
        ...prev,
        ships: updatedShips,
        settlements: updatedSettlements,
        resources: factionPools,
        factionTech: updatedTech,
        buildOrders,
        currentTick: newTime,
      };

      for (const aiFaction of aiFactions) {
        if (!shouldRunAI(aiFaction.lastAIDecisionTick, newTime)) continue;
        const decision = runFactionAI(aiSnapshot, aiFaction.id, newTime);

        // Apply each intent. Each apply* returns whether the intent was
        // executed (cost satisfied, no race with another intent).
        for (const intent of decision.intents) {
          const result = applyAIIntent(intent, aiSnapshot, aiFaction.id, newTime);
          if (result.applied) {
            // Commit mutations back to the working state
            if (result.ships) updatedShips = result.ships;
            if (result.settlements) updatedSettlements = result.settlements;
            if (result.buildOrders) buildOrders = result.buildOrders;
            if (result.factionPools) {
              for (const [fid, fr] of Object.entries(result.factionPools)) {
                factionPools[fid] = fr;
              }
            }
            // Update the snapshot the next intent sees
            aiSnapshot.ships = updatedShips;
            aiSnapshot.settlements = updatedSettlements;
            aiSnapshot.buildOrders = buildOrders;
            aiSnapshot.resources = factionPools;
          }
        }

        // Log even when no intents fired so the player can see the AI is alive
        const notes = decision.notes.length > 0 ? decision.notes : [`${aiFaction.name}: standing by`];
        for (const note of notes) {
          aiActivityLog = [
            ...aiActivityLog.slice(-49),
            {
              id: `ai-${newTime}-${Math.random().toString(36).slice(2, 6)}`,
              tick: Math.floor(newTime),
              factionId: aiFaction.id,
              message: note,
              kind: classifyNote(decision.intents),
            },
          ];
        }

        // Bump per-faction decision tick
        updatedFactions = updatedFactions.map(f =>
          f.id === aiFaction.id ? { ...f, lastAIDecisionTick: newTime } : f,
        );
      }
    }

    const allOrders = updatedShips.flatMap(s => s.orders);

    // === Victory check ===
    // If a match-length goal is set and we've reached or passed it, compute
    // the winner and flip status to 'completed'. The next render shows the
    // VictoryOverlay; advanceToTick early-exits while completed so time
    // stops advancing. (The 'completed' early-exit above guarantees prev.status
    // is not yet 'completed' here, but we re-check to satisfy TS narrowing.)
    // Tick-countdown victory was removed — games run indefinitely. Status
    // only flips to 'completed' if some other path sets it (none today;
    // host-abandon is the only out). Leaving the placeholders so the
    // existing VictoryOverlay wiring keeps compiling.
    const nextStatus: GameState['status'] = prev.status;
    const winnerFactionId = prev.winnerFactionId;
    const victoryType = prev.victoryType;

    // Sample a tick snapshot every ~25 simulated ticks so the log has
    // periodic economy/fleet checkpoints to read between events.
    const SNAPSHOT_INTERVAL = 25;
    if (Math.floor(newTime / SNAPSHOT_INTERVAL) > Math.floor(prev.currentTick / SNAPSHOT_INTERVAL)) {
      const player = factionPools['player'];
      const playerShips = updatedShips.filter(s => s.ownedBy === 'player').length;
      const playerSettlements = updatedSettlements.filter(s => s.ownedBy === 'player').length;
      logger.info('TICK', `snapshot`, {
        ships: playerShips,
        settlements: playerSettlements,
        fuel: player ? Math.round(player.fuel) : null,
        ore: player ? Math.round(player.ore) : null,
        cr: player ? Math.round(player.credits) : null,
        sci: player ? Math.round(player.science) : null,
        builds: buildOrders.length,
      });
    }

    return {
      ...prev,
      bodies: updatedBodies,
      ships: updatedShips,
      orders: allOrders,
      currentTick: newTime,
      buildOrders,
      resources: factionPools,
      factionTech: updatedTech,
      settlements: updatedSettlements,
      fleets: updatedFleets,
      factions: updatedFactions,
      combatLog,
      aiActivityLog,
      status: nextStatus,
      winnerFactionId,
      victoryType,
      tradeRoutes: updatedRoutes,
    };
  }, [checkNodeExecution]);

  // Tick-based game loop
  const lastTimeRef = useRef<number>(0);

  // Turn-Based Mode opt-in. When enabled (and not externally controlled
  // by an MP server), the realtime sim loop below is suppressed and time
  // only advances when the player clicks COMMIT TURN. See turnBasedSettings.tsx.
  const turnBased = useTurnBasedSettings();
  const turnBasedActive = turnBased.enabled && !externallyControlled;

  useEffect(() => {
    // In multiplayer the server's Room-DO alarm advances time. The local
    // sim loop is suppressed so the canvas can't drift away from the
    // server's authoritative tick.
    if (externallyControlled) return;
    // Turn-based mode: realtime advancement is gated behind COMMIT TURN.
    // The loop below stays silent until the player exits TBM. simSpeed
    // and the +10 button still work for muscle-memory but the more
    // common path is the new commitTurn action.
    if (turnBasedActive) return;
    if (simSpeed === 0) return;
    lastTimeRef.current = performance.now();

    const interval = setInterval(() => {
      const now = performance.now();
      const realDeltaSec = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;

      const cappedDelta = Math.min(realDeltaSec, 1.0);
      const tickDelta = cappedDelta * BASE_TICK_RATE * simSpeed;

      setGameStateInternal(prev => advanceToTick(prev, prev.currentTick + tickDelta));
    }, 50);

    return () => clearInterval(interval);
  }, [simSpeed, advanceToTick, externallyControlled, turnBasedActive]);

  // Advance the sim by exactly `ticksPerTurn` ticks in one shot. Routes
  // through the same advanceToTick reducer the realtime loop uses, so
  // build orders, combat, settlement yields, AI decisions, etc. all
  // resolve as if a long fast-forward had finished. No-op if TBM is off
  // (callers still get a sensible function — easier than null-guarding
  // every UI binding).
  const commitTurn = useCallback(() => {
    if (externallyControlled) return; // Server is authoritative in MP
    const ticks = Math.max(1, Math.floor(turnBased.ticksPerTurn));
    setGameStateInternal(prev => {
      logger.info('ACTION', `Turn committed: +${ticks} ticks (now T+${Math.round(prev.currentTick + ticks)})`);

      // === Phase AI factions explicitly per turn =================
      // In realtime, AI ticks every AI_DECISION_INTERVAL (=50) ticks.
      // In TBM, the player might commit 20 ticks at a time, which means
      // an AI could go several turns without acting. That feels wrong —
      // a turn-based game should give every faction equal play.
      //
      // Fix: zero out lastAIDecisionTick for every AI faction so each
      // one is eligible at the first tick of the jump. The existing
      // AI loop inside advanceToTick will then run them once, and the
      // resulting intents apply to the world the player just submitted
      // (rather than to some intermediate state inside the jump).
      const aiReadyFactions = prev.factions.map(f =>
        f.isAI && f.id !== 'player'
          ? { ...f, lastAIDecisionTick: undefined }
          : f
      );
      const primed = { ...prev, factions: aiReadyFactions };

      return advanceToTick(primed, prev.currentTick + ticks);
    });
  }, [advanceToTick, externallyControlled, turnBased.ticksPerTurn]);

  const setGameState = useCallback((state: GameState) => {
    setGameStateInternal(state);
  }, []);

  const updateGameState = useCallback((partial: Partial<GameState>) => {
    setGameStateInternal(prev => ({ ...prev, ...partial }));
  }, []);

  const updateTick = useCallback((tick: number) => {
    setGameStateInternal(prev => advanceToTick(prev, tick));
  }, [advanceToTick]);

  const setSimSpeed = useCallback((speed: number) => {
    setSimSpeedInternal(speed);
  }, []);

  const updateCamera = useCallback((partial: Partial<CameraState>) => {
    setCameraInternal(prev => ({ ...prev, ...partial }));
  }, []);

  const focusBody = useCallback((bodyId: string | undefined) => {
    if (bodyId) {
      const body = gameState.bodies.find(b => b.id === bodyId);
      if (body) {
        setCameraInternal(prev => ({
          ...prev, focusedBodyId: bodyId, x: 0, y: 0, scale: 2, zoomLevel: 2,
        }));
      }
    } else {
      setCameraInternal(prev => ({
        ...prev, focusedBodyId: undefined, x: 0, y: 0, scale: 1, zoomLevel: 1,
      }));
    }
  }, [gameState.bodies]);

  const selectShip = useCallback((shipId: string) => {
    setUIStateInternal(prev => ({ ...prev, selectedShipId: shipId, selectedBodyId: undefined }));
  }, []);

  const deselectShip = useCallback(() => {
    setUIStateInternal(prev => ({ ...prev, selectedShipId: undefined }));
  }, []);

  const selectBody = useCallback((bodyId: string) => {
    setUIStateInternal(prev => ({ ...prev, selectedBodyId: bodyId, selectedShipId: undefined }));
  }, []);

  const deselectBody = useCallback(() => {
    setUIStateInternal(prev => ({ ...prev, selectedBodyId: undefined }));
  }, []);

  const hoverBody = useCallback((bodyId: string | null) => {
    setUIStateInternal(prev => ({ ...prev, hoveredBodyId: bodyId || undefined }));
  }, []);

  const addManeuverNode = useCallback((node: ManeuverNode) => {
    setGameStateInternal(prev => {
      const ship = prev.ships.find(s => s.id === node.shipId);
      logger.info('ACTION', `Planned ${node.type}: ${ship?.name ?? node.shipId} ${node.label ? `(${node.label})` : ''}`, {
        burnTime: Math.round(node.burnTime), deltav: +node.deltav.toFixed(2),
      });
      return {
        ...prev,
        orders: [...prev.orders, node],
        ships: prev.ships.map(ship =>
          ship.id === node.shipId
            ? { ...ship, orders: [...ship.orders, node] }
            : ship
        ),
      };
    });
  }, []);

  const commitManeuverNode = useCallback((nodeId: string) => {
    setGameStateInternal(prev => {
      const order = prev.orders.find(o => o.id === nodeId);
      if (!order) return prev;
      const ship = prev.ships.find(s => s.id === order.shipId);
      logger.info('ACTION', `Committed ${order.type}: ${ship?.name ?? order.shipId}`, {
        burnTime: Math.round(order.burnTime),
      });

      // Stale-arc refresh: a planned transfer that's been sitting around
      // can have a burn time in the past (the player drew the arc, then
      // ran the sim forward at 100× before clicking COMMIT). In that
      // case, recompute the bezier arc from the ship's current orbit so
      // the transfer launches in the near future instead of being
      // "already supposed to have happened". Without this refresh the
      // commit path triggers an immediate departure with a stale arc
      // pointing at where the target body USED to be.
      const tick = prev.currentTick;
      let refreshedArc: TransferArc | undefined;
      let refreshedNode = { ...order, status: 'committed' as const };
      if (
        order.type === 'transfer' &&
        order.burnTime < tick + 1 &&
        ship?.pendingTransfer
      ) {
        const playerTech = prev.factionTech?.[ship.ownedBy];
        const mul = playerTech ? Math.max(0.2, 1 - (TECH_DEFS.propulsion.perLevel * (playerTech.levels.propulsion ?? 0))) : 1;
        const fresh = planBezierTransfer(
          ship.orbit,
          ship.pendingTransfer.arrivalBodyId,
          tick,
          prev.bodies,
          mul,
        );
        if (fresh) {
          refreshedArc = fresh;
          refreshedNode = {
            ...refreshedNode,
            burnTime: fresh.departureTime,
            deltav: fresh.departureDv,
            prograde: fresh.departureDv,
            label: fresh.label,
          };
        }
      }

      return {
        ...prev,
        orders: prev.orders.map(o =>
          o.id === nodeId ? refreshedNode : o
        ),
        ships: prev.ships.map(s => {
          if (s.id !== order.shipId) return s;
          return {
            ...s,
            orders: s.orders.map(o =>
              o.id === nodeId ? refreshedNode : o
            ),
            pendingTransfer: refreshedArc ?? s.pendingTransfer,
          };
        }),
      };
    });
  }, []);

  const deleteManeuverNode = useCallback((nodeId: string) => {
    setGameStateInternal(prev => ({
      ...prev,
      orders: prev.orders.filter(order => order.id !== nodeId),
      ships: prev.ships.map(ship => {
        const deletedOrder = ship.orders.find(o => o.id === nodeId);
        const newOrders = ship.orders.filter(order => order.id !== nodeId);
        const hasTransferOrders = newOrders.some(o => o.type === 'transfer');
        return {
          ...ship,
          orders: newOrders,
          pendingTransfer: (deletedOrder?.type === 'transfer' && !hasTransferOrders)
            ? undefined
            : ship.pendingTransfer,
          queuedTransfers: (deletedOrder?.type === 'transfer' && !hasTransferOrders)
            ? undefined
            : ship.queuedTransfers,
        };
      }),
    }));
  }, []);

  const setTargetSelectionMode = useCallback((enabled: boolean) => {
    setUIStateInternal(prev => ({ ...prev, targetSelectionMode: enabled }));
  }, []);

  // ---- Fleet Management ----
  const createFleet = useCallback((name: string, shipIds: string[]) => {
    setGameStateInternal(prev => {
      const fleet = formFleet(name, shipIds, prev.ships);
      if (!fleet) return prev;
      return {
        ...prev,
        fleets: [...prev.fleets, fleet],
        ships: prev.ships.map(s =>
          shipIds.includes(s.id) ? { ...s, fleetId: fleet.id } : s
        ),
      };
    });
  }, []);

  const disbandFleet = useCallback((fleetId: string) => {
    setGameStateInternal(prev => ({
      ...prev,
      fleets: prev.fleets.filter(f => f.id !== fleetId),
      ships: prev.ships.map(s =>
        s.fleetId === fleetId ? { ...s, fleetId: undefined } : s
      ),
    }));
  }, []);

  const removeFromFleet = useCallback((fleetId: string, shipId: string) => {
    setGameStateInternal(prev => {
      const fleet = prev.fleets.find(f => f.id === fleetId);
      if (!fleet) return prev;
      const updated = splitFromFleet(fleet, shipId);
      return {
        ...prev,
        fleets: updated
          ? prev.fleets.map(f => f.id === fleetId ? updated : f)
          : prev.fleets.filter(f => f.id !== fleetId),
        ships: prev.ships.map(s => {
          if (s.id === shipId) return { ...s, fleetId: undefined };
          if (!updated && s.fleetId === fleetId) return { ...s, fleetId: undefined };
          return s;
        }),
      };
    });
  }, []);

  const addToFleet = useCallback((fleetId: string, shipId: string) => {
    setGameStateInternal(prev => {
      const fleet = prev.fleets.find(f => f.id === fleetId);
      if (!fleet) return prev;
      const ship = prev.ships.find(s => s.id === shipId);
      if (!ship || ship.transfer || ship.ownedBy !== fleet.ownedBy) return prev;
      const leadShip = prev.ships.find(s => s.id === fleet.leadShipId);
      if (!leadShip || ship.orbit.parentBodyId !== leadShip.orbit.parentBodyId) return prev;
      return {
        ...prev,
        fleets: prev.fleets.map(f =>
          f.id === fleetId ? { ...f, shipIds: [...f.shipIds, shipId] } : f
        ),
        ships: prev.ships.map(s =>
          s.id === shipId ? { ...s, fleetId: fleetId } : s
        ),
      };
    });
  }, []);

  const setPendingTransfer = useCallback((shipId: string, arc: TransferArc | undefined) => {
    setGameStateInternal(prev => ({
      ...prev,
      ships: prev.ships.map(ship =>
        ship.id === shipId ? { ...ship, pendingTransfer: arc } : ship
      ),
    }));
  }, []);

  const addQueuedTransfer = useCallback((shipId: string, arc: TransferArc) => {
    setGameStateInternal(prev => ({
      ...prev,
      ships: prev.ships.map(ship => {
        if (ship.id !== shipId) return ship;
        const queue = ship.queuedTransfers ? [...ship.queuedTransfers, arc] : [arc];
        return { ...ship, queuedTransfers: queue };
      }),
    }));
  }, []);

  /** Launch a torch transfer for the named ship. Mirrors the AI's
   *  'transfer' intent path in applyIntent but invoked directly by
   *  the player UI. Returns true on success. */
  const launchTorchTransfer = useCallback((shipId: string, targetBodyId: string): boolean => {
    let success = false;
    setGameStateInternal(prev => {
      const ship = prev.ships.find(s => s.id === shipId);
      if (!ship) return prev;
      if (ship.transit || ship.transfer || ship.pendingTransfer) return prev;

      const faction = prev.factions.find(f => f.id === ship.ownedBy);
      const engineAccel = faction?.engineG ?? DEFAULT_ENGINE_ACCEL;
      const tick = prev.currentTick;

      const launchPos = orbitWorldPos(ship.orbit, tick, prev.bodies);
      const parent = prev.bodies.find(b => b.id === ship.orbit.parentBodyId);
      const launchVel = parent
        ? bodyWorldVelocity(parent, tick, prev.bodies)
        : { x: 0, y: 0 };

      const plan = planTorchTransfer(
        { pos: launchPos, vel: launchVel },
        targetBodyId,
        engineAccel, engineAccel,
        tick, prev.bodies,
      );
      if (!plan) return prev;

      success = true;
      return {
        ...prev,
        ships: prev.ships.map(s =>
          s.id === shipId
            ? {
                ...s,
                transit: {
                  pos: { x: launchPos.x, y: launchPos.y },
                  vel: { x: launchVel.x, y: launchVel.y },
                  currentTransfer: plan,
                },
                // Any legacy bezier or planned-but-not-launched state
                // is superseded by the torch burn.
                transfer: undefined,
                pendingTransfer: undefined,
                queuedTransfers: undefined,
                // Strip any committed/planned 'transfer' maneuver nodes
                // so they don't try to fire after the torch has launched.
                orders: s.orders.filter(o => o.type !== 'transfer'),
              }
            : s,
        ),
      };
    });
    return success;
  }, []);

  // ---- Ship Building ----
  const buildShip = useCallback((bodyId: string, shipClass: ShipClassName, name: string): boolean => {
    const classDef = SHIP_CLASSES[shipClass];
    if (!classDef) {
      logger.warn('ACTION', `buildShip: unknown class`, { shipClass });
      return false;
    }

    // Check if body is owned by the player
    const body = gameState.bodies.find(b => b.id === bodyId);
    if (!body || body.ownedBy !== 'player') {
      logger.warn('ACTION', `buildShip: body not player-owned`, { bodyId, ownedBy: body?.ownedBy });
      return false;
    }

    // Shipyard slot gate — every body has 1 base slot; station Shipyard
    // building levels add more. In-flight ship builds at this body count
    // toward the cap.
    const slots = shipyardSlotsAtBody(bodyId, 'player', gameState.settlements);
    const inFlightAtBody = gameState.buildOrders.filter(
      bo => bo.bodyId === bodyId && bo.ownedBy === 'player'
    ).length;
    if (inFlightAtBody >= slots) {
      logger.warn('ACTION', `buildShip: shipyard capacity reached`, {
        bodyId, slots, inFlightAtBody,
      });
      return false;
    }

    // Apply Construction-tech cost discount (capped at 75% off).
    const constructionLvl = gameState.factionTech.player?.levels['construction'] ?? 0;
    const costMul = Math.max(0.25, 1 - TECH_DEFS.construction.perLevel * constructionLvl);
    const fuelCost = Math.ceil(classDef.cost.fuel * costMul);
    const oreCost = Math.ceil(classDef.cost.ore * costMul);
    const creditCost = Math.ceil(classDef.cost.credits * costMul);

    // Check resources
    const res = gameState.resources['player'];
    if (!res || res.fuel < fuelCost || res.ore < oreCost || res.credits < creditCost) {
      logger.warn('ACTION', `buildShip: insufficient resources`, {
        shipClass, bodyId, name,
        need: { fuel: fuelCost, ore: oreCost, credits: creditCost },
        have: res ? { fuel: res.fuel, ore: res.ore, credits: res.credits } : null,
      });
      return false;
    }
    logger.info('ACTION', `Built ${name} (${shipClass}) at ${body.name}`, {
      cost: { fuel: -fuelCost, ore: -oreCost, credits: -creditCost },
      buildTime: classDef.buildTime,
    });

    setGameStateInternal(prev => {
      const playerRes = prev.resources['player'];
      if (!playerRes) return prev;

      const buildOrder: BuildOrder = {
        id: `build-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        bodyId,
        shipClass,
        ownedBy: 'player',
        startTick: prev.currentTick,
        completeTick: prev.currentTick + classDef.buildTime,
        shipName: name,
      };

      return {
        ...prev,
        buildOrders: [...prev.buildOrders, buildOrder],
        resources: {
          ...prev.resources,
          player: {
            ...playerRes,
            fuel: playerRes.fuel - fuelCost,
            ore: playerRes.ore - oreCost,
            credits: playerRes.credits - creditCost,
          },
        },
      };
    });
    return true;
  }, [gameState.bodies, gameState.resources, gameState.factionTech, gameState.buildOrders, gameState.settlements]);

  const cancelBuild = useCallback((buildOrderId: string) => {
    setGameStateInternal(prev => {
      const bo = prev.buildOrders.find(b => b.id === buildOrderId);
      if (!bo) return prev;
      logger.info('ACTION', `Cancelled build: ${bo.shipName} (${bo.shipClass}) at ${bo.bodyId}`);

      // Refund resources
      const classDef = SHIP_CLASSES[bo.shipClass as ShipClassName];
      const factionRes = prev.resources[bo.ownedBy];
      const updatedResources = factionRes ? {
        ...prev.resources,
        [bo.ownedBy]: {
          ...factionRes,
          fuel: factionRes.fuel + classDef.cost.fuel,
          ore: factionRes.ore + classDef.cost.ore,
          credits: factionRes.credits + classDef.cost.credits,
        },
      } : prev.resources;

      return {
        ...prev,
        buildOrders: prev.buildOrders.filter(b => b.id !== buildOrderId),
        resources: updatedResources,
      };
    });
  }, []);

  // ---- Settlements ----
  const selectSettlement = useCallback((id: string | undefined) => {
    setSelectedSettlementId(id);
  }, []);

  const deploySettlement = useCallback((bodyId: string, type: SettlementType, name?: string): boolean => {
    const body = gameState.bodies.find(b => b.id === bodyId);
    if (!body) { logger.warn('ACTION', `deploySettlement: unknown body`, { bodyId }); return false; }

    // Body type gate
    if (type === 'city' && !canHostCity(body)) {
      logger.warn('ACTION', `deploySettlement: ${body.name} can't host a city`, { bodyType: body.type });
      return false;
    }
    if (type === 'station' && !canHostStation(body)) {
      logger.warn('ACTION', `deploySettlement: ${body.name} can't host a station`, { bodyType: body.type });
      return false;
    }

    // Require a player FREIGHTER in orbit at this body — only freighters
    // can deploy settlements (combat ships carry no construction materials).
    const playerFreighterHere = gameState.ships.find(s =>
      s.ownedBy === 'player' &&
      !s.transfer &&
      s.orbit.parentBodyId === bodyId &&
      s.class === 'freighter'
    );
    if (!playerFreighterHere) {
      logger.warn('ACTION', `deploySettlement: no freighter at ${body.name}`);
      return false;
    }

    // Resource cost
    const def = SETTLEMENT_DEFS[type];
    const res = gameState.resources['player'];
    if (!res || res.fuel < def.cost.fuel || res.ore < def.cost.ore || res.credits < def.cost.credits) {
      logger.warn('ACTION', `deploySettlement: insufficient resources`, {
        type, body: body.name,
        need: def.cost,
        have: res ? { fuel: res.fuel, ore: res.ore, credits: res.credits } : null,
      });
      return false;
    }
    logger.info('ACTION', `Deployed ${type} at ${body.name}${name ? ` (${name})` : ''}`, {
      cost: { fuel: -def.cost.fuel, ore: -def.cost.ore, credits: -def.cost.credits },
    });

    setGameStateInternal(prev => {
      const playerRes = prev.resources['player'];
      if (!playerRes) return prev;

      const settlement = type === 'city'
        ? createCity(body, 'player', prev.currentTick, name)
        : createStation(body, 'player', prev.currentTick, prev.bodies, name);

      return {
        ...prev,
        settlements: [...prev.settlements, settlement],
        resources: {
          ...prev.resources,
          player: {
            ...playerRes,
            fuel: playerRes.fuel - def.cost.fuel,
            ore: playerRes.ore - def.cost.ore,
            credits: playerRes.credits - def.cost.credits,
          },
        },
      };
    });
    return true;
  }, [gameState.bodies, gameState.ships, gameState.resources]);

  const damageSettlement = useCallback((settlementId: string, dmg: number) => {
    setGameStateInternal(prev => {
      const target = prev.settlements.find(s => s.id === settlementId);
      if (!target) return prev;
      const newHp = target.hp - dmg;
      if (newHp <= 0) {
        return {
          ...prev,
          settlements: prev.settlements.filter(s => s.id !== settlementId),
          combatLog: [...prev.combatLog.slice(-20), `${target.name} destroyed!`],
        };
      }
      return {
        ...prev,
        settlements: prev.settlements.map(s =>
          s.id === settlementId ? { ...s, hp: newHp } : s
        ),
      };
    });
  }, []);

  const createTradeRoute = useCallback((
    shipId: string,
    originBodyId: string,
    destBodyId: string,
  ): boolean => {
    let ok = false;
    setGameStateInternal(prev => {
      const ship = prev.ships.find(s => s.id === shipId);
      if (!ship) {
        logger.warn('ACTION', 'createTradeRoute: ship not found', { shipId });
        return prev;
      }
      if (ship.ownedBy !== 'player') {
        logger.warn('ACTION', 'createTradeRoute: not your ship', { shipId, owner: ship.ownedBy });
        return prev;
      }
      if (ship.class !== 'freighter') {
        logger.warn('ACTION', 'createTradeRoute: not a freighter', { shipId, class: ship.class });
        return prev;
      }
      const origin = prev.bodies.find(b => b.id === originBodyId);
      const dest = prev.bodies.find(b => b.id === destBodyId);
      if (!origin || !dest) {
        logger.warn('ACTION', 'createTradeRoute: body lookup failed', { originBodyId, destBodyId });
        return prev;
      }
      // Validate origin has at least one player settlement to harvest from,
      // and dest has a player collector to deliver to. Without these
      // guardrails the freighter would loop forever doing nothing.
      const originSettlement = prev.settlements.find(
        s => s.bodyId === originBodyId && s.ownedBy === 'player',
      );
      const destCollector = prev.settlements.find(
        s => s.bodyId === destBodyId && s.ownedBy === 'player' && s.hasCollector,
      );
      if (!originSettlement) {
        logger.warn('ACTION', 'createTradeRoute: origin has no player settlement', { originBodyId });
        return prev;
      }
      if (!destCollector) {
        logger.warn('ACTION', 'createTradeRoute: dest has no player collector', { destBodyId });
        return prev;
      }
      // Replace any existing route on this freighter — a player who
      // changes their mind shouldn't have to cancel-then-create.
      const filtered = (prev.tradeRoutes ?? []).filter(r => r.shipId !== shipId);
      const route: TradeRoute = {
        id: `tr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ownedBy: 'player',
        shipId,
        originBodyId,
        destBodyId,
        status: ship.orbit.parentBodyId === originBodyId ? 'returning' : 'outbound',
        // Status semantics:
        //   'outbound'  = heading toward dest (cargo full)
        //   'returning' = heading toward origin (cargo empty)
        //   'paused'    = player paused; execution loop skips
        // Set the initial status so the execution loop's first pass
        // picks the right phase: if we're already at origin, treat as
        // "returning" (we'll fill + flip to outbound on the same tick).
        cargo: { fuel: 0, ore: 0, credits: 0, science: 0 },
        createdAtTick: prev.currentTick,
      };
      logger.info('ACTION', `Trade route opened: ${ship.name} ${origin.name} ↔ ${dest.name}`);
      ok = true;
      return {
        ...prev,
        tradeRoutes: [...filtered, route],
      };
    });
    return ok;
  }, []);

  const cancelTradeRoute = useCallback((routeId: string) => {
    setGameStateInternal(prev => {
      const route = (prev.tradeRoutes ?? []).find(r => r.id === routeId);
      if (!route) return prev;
      const ship = prev.ships.find(s => s.id === route.shipId);
      // If there's cargo in the hold and the freighter is still alive,
      // dump it into the player's pool as a "you cancelled, here's
      // what was already loaded." Otherwise it would just disappear.
      const cargo = route.cargo;
      const hasCargo = cargo.fuel > 0 || cargo.ore > 0 || cargo.credits > 0 || cargo.science > 0;
      const nextResources = { ...prev.resources };
      if (hasCargo && ship) {
        const pool = nextResources[ship.ownedBy] ?? { fuel: 0, ore: 0, credits: 0, science: 0 };
        nextResources[ship.ownedBy] = {
          fuel: pool.fuel + cargo.fuel,
          ore: pool.ore + cargo.ore,
          credits: pool.credits + cargo.credits,
          science: pool.science + cargo.science,
        };
      }
      logger.info('ACTION', `Trade route cancelled: ${ship?.name ?? route.shipId}`);
      return {
        ...prev,
        tradeRoutes: (prev.tradeRoutes ?? []).filter(r => r.id !== routeId),
        resources: nextResources,
      };
    });
  }, []);

  const buildCollector = useCallback((settlementId: string): boolean => {
    let ok = false;
    setGameStateInternal(prev => {
      const target = prev.settlements.find(s => s.id === settlementId);
      if (!target) {
        logger.warn('ACTION', 'buildCollector: settlement not found', { settlementId });
        return prev;
      }
      if (target.ownedBy !== 'player') {
        logger.warn('ACTION', 'buildCollector: not your settlement', {
          settlementId, owner: target.ownedBy,
        });
        return prev;
      }
      if (target.hasCollector) {
        logger.warn('ACTION', 'buildCollector: already has a collector', { settlementId });
        return prev;
      }
      const pool = prev.resources['player'];
      if (!pool || pool.ore < COLLECTOR_COST.ore || pool.credits < COLLECTOR_COST.credits) {
        logger.warn('ACTION', 'buildCollector: insufficient resources', {
          settlementId,
          need: COLLECTOR_COST,
          have: pool ? { ore: pool.ore, credits: pool.credits } : null,
        });
        return prev;
      }
      logger.info('ACTION', `Built collector at ${target.name}`, {
        cost: { ore: -COLLECTOR_COST.ore, credits: -COLLECTOR_COST.credits },
      });
      ok = true;
      return {
        ...prev,
        settlements: prev.settlements.map(s =>
          s.id === settlementId
            ? { ...s, hasCollector: true, collectorBuiltTick: prev.currentTick }
            : s,
        ),
        resources: {
          ...prev.resources,
          player: {
            ...pool,
            fuel: pool.fuel - COLLECTOR_COST.fuel,
            ore: pool.ore - COLLECTOR_COST.ore,
            credits: pool.credits - COLLECTOR_COST.credits,
          },
        },
      };
    });
    return ok;
  }, []);

  const queueBuilding = useCallback((settlementId: string, kind: BuildingKind): boolean => {
    let ok = false;
    setGameStateInternal(prev => {
      const target = prev.settlements.find(s => s.id === settlementId);
      if (!target) {
        logger.warn('ACTION', 'queueBuilding: settlement not found', { settlementId, kind });
        return prev;
      }
      if (target.ownedBy !== 'player') {
        logger.warn('ACTION', 'queueBuilding: not your settlement', { settlementId, kind });
        return prev;
      }
      const def = BUILDING_DEFS[kind];
      if (!def) {
        logger.warn('ACTION', 'queueBuilding: unknown kind', { kind });
        return prev;
      }
      if (def.hostType !== target.type) {
        logger.warn('ACTION', 'queueBuilding: host type mismatch', {
          kind, requires: def.hostType, settlementType: target.type,
        });
        return prev;
      }
      if (target.buildingQueue) {
        logger.warn('ACTION', 'queueBuilding: another upgrade already in flight', {
          settlementId, kind, inFlight: target.buildingQueue.kind,
        });
        return prev;
      }

      const currentLevel = buildingLevel(target, kind);
      const cost = buildingCostForNextLevel(kind, currentLevel);
      const pool = prev.resources['player'];
      if (!pool || pool.fuel < cost.fuel || pool.ore < cost.ore || pool.credits < cost.credits) {
        logger.warn('ACTION', 'queueBuilding: insufficient resources', {
          settlementId, kind, currentLevel, need: cost,
          have: pool ? { fuel: pool.fuel, ore: pool.ore, credits: pool.credits } : null,
        });
        return prev;
      }

      const ticks = buildingTimeForNextLevel(kind, currentLevel);
      const order: SettlementBuildOrder = {
        id: `bldorder-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        settlementId,
        kind,
        targetLevel: currentLevel + 1,
        startTick: prev.currentTick,
        completeTick: prev.currentTick + ticks,
      };
      logger.info('ACTION', `Queued ${def.displayName} L${currentLevel + 1} at ${target.name}`, {
        cost, ticks,
      });
      ok = true;
      return {
        ...prev,
        settlements: prev.settlements.map(s =>
          s.id === settlementId ? { ...s, buildingQueue: order } : s,
        ),
        resources: {
          ...prev.resources,
          player: {
            ...pool,
            fuel:    pool.fuel    - cost.fuel,
            ore:     pool.ore     - cost.ore,
            credits: pool.credits - cost.credits,
          },
        },
      };
    });
    return ok;
  }, []);

  const cancelBuilding = useCallback((settlementId: string): boolean => {
    let ok = false;
    setGameStateInternal(prev => {
      const target = prev.settlements.find(s => s.id === settlementId);
      if (!target || target.ownedBy !== 'player' || !target.buildingQueue) return prev;
      const q = target.buildingQueue;
      const cost = buildingCostForNextLevel(q.kind, q.targetLevel - 1);
      // 50% refund — losing the other half encourages players to think
      // before queueing rather than treating queue as free.
      const refund = {
        fuel:    Math.floor(cost.fuel    / 2),
        ore:     Math.floor(cost.ore     / 2),
        credits: Math.floor(cost.credits / 2),
      };
      const pool = prev.resources['player'];
      logger.info('ACTION', `Cancelled ${BUILDING_DEFS[q.kind].displayName} L${q.targetLevel} at ${target.name}`, {
        refund,
      });
      ok = true;
      return {
        ...prev,
        settlements: prev.settlements.map(s =>
          s.id === settlementId ? { ...s, buildingQueue: undefined } : s,
        ),
        resources: pool ? {
          ...prev.resources,
          player: {
            ...pool,
            fuel:    pool.fuel    + refund.fuel,
            ore:     pool.ore     + refund.ore,
            credits: pool.credits + refund.credits,
          },
        } : prev.resources,
      };
    });
    return ok;
  }, []);

  const startResearch = useCallback((techId: TechId) => {
    setGameStateInternal(prev => {
      const cur = prev.factionTech.player ?? { levels: {}, researching: null, progress: 0, queue: [] };
      // Starting a tech that's already queued should promote it out of
      // the queue rather than appearing in both "researching" and "next
      // up" at once.
      const queue = (cur.queue ?? []).filter(t => t !== techId);
      // Switching away from a current research abandons its progress —
      // matches the prior behavior. Players who want to preserve it
      // should use the queue instead of switching directly.
      return {
        ...prev,
        factionTech: {
          ...prev.factionTech,
          player: { ...cur, researching: techId, progress: 0, queue },
        },
      };
    });
  }, []);

  const cancelResearch = useCallback(() => {
    setGameStateInternal(prev => {
      const cur = prev.factionTech.player ?? { levels: {}, researching: null, progress: 0, queue: [] };
      // Cancel just nukes the current research; the queue survives. If
      // the queue has anything, the next tick's reducer will pull the
      // head off and start it. Players who want to wipe everything can
      // dequeue each entry separately.
      return {
        ...prev,
        factionTech: {
          ...prev.factionTech,
          player: { ...cur, researching: null, progress: 0 },
        },
      };
    });
  }, []);

  const enqueueResearch = useCallback((techId: TechId) => {
    setGameStateInternal(prev => {
      const cur = prev.factionTech.player ?? { levels: {}, researching: null, progress: 0, queue: [] };
      const queue = cur.queue ?? [];
      // De-dupe: if it's already queued or actively researching, no-op.
      // Players who want to research the same line repeatedly should
      // wait for the level to finish before re-queueing.
      if (cur.researching === techId) return prev;
      if (queue.includes(techId)) return prev;
      // If there's no current research, start it directly instead of
      // queueing — saves the player from having to click Start after
      // adding the first item.
      if (!cur.researching) {
        return {
          ...prev,
          factionTech: {
            ...prev.factionTech,
            player: { ...cur, researching: techId, progress: 0, queue },
          },
        };
      }
      return {
        ...prev,
        factionTech: {
          ...prev.factionTech,
          player: { ...cur, queue: [...queue, techId] },
        },
      };
    });
  }, []);

  const dequeueResearch = useCallback((techId: TechId) => {
    setGameStateInternal(prev => {
      const cur = prev.factionTech.player ?? { levels: {}, researching: null, progress: 0, queue: [] };
      const queue = (cur.queue ?? []).filter(t => t !== techId);
      return {
        ...prev,
        factionTech: {
          ...prev.factionTech,
          player: { ...cur, queue },
        },
      };
    });
  }, []);

  const moveResearchUp = useCallback((techId: TechId) => {
    setGameStateInternal(prev => {
      const cur = prev.factionTech.player ?? { levels: {}, researching: null, progress: 0, queue: [] };
      const queue = [...(cur.queue ?? [])];
      const idx = queue.indexOf(techId);
      if (idx <= 0) return prev; // not in queue, or already at front
      // Swap with the previous entry. At idx=0 the next swap would
      // promote it to `researching` — handled separately via Start.
      [queue[idx - 1], queue[idx]] = [queue[idx], queue[idx - 1]];
      return {
        ...prev,
        factionTech: {
          ...prev.factionTech,
          player: { ...cur, queue },
        },
      };
    });
  }, []);

  // Debug/admin grant. Bumps one faction's pools (or every faction when
  // factionId='all') by the supplied delta. Used by the AdminGrantModal
  // when a player needs to recover from a busted MP build that ate
  // resources without producing a ship, or when a host is tweaking the
  // economy mid-playtest. In MP the caller must also post to the server
  // endpoint — this only mutates client state.
  const adjustResources = useCallback((
    factionId: string | 'all',
    delta: Partial<{ fuel: number; ore: number; credits: number; science: number }>,
  ) => {
    setGameStateInternal(prev => {
      const targets = factionId === 'all'
        ? Object.keys(prev.resources)
        : [factionId];
      const nextResources = { ...prev.resources };
      for (const fid of targets) {
        const cur = nextResources[fid] ?? { fuel: 0, ore: 0, credits: 0, science: 0 };
        nextResources[fid] = {
          fuel: Math.max(0, cur.fuel + (delta.fuel ?? 0)),
          ore: Math.max(0, cur.ore + (delta.ore ?? 0)),
          credits: Math.max(0, cur.credits + (delta.credits ?? 0)),
          science: Math.max(0, cur.science + (delta.science ?? 0)),
        };
      }
      logger.warn('RESOURCE', `Admin grant applied to ${factionId}`, delta);
      return { ...prev, resources: nextResources };
    });
  }, []);

  const value: GameContextType = {
    gameState, camera, uiState, simSpeed,
    setGameState, updateGameState, updateTick, setSimSpeed,
    updateCamera, focusBody,
    selectShip, deselectShip, selectBody, deselectBody, hoverBody,
    setTargetSelectionMode,
    addManeuverNode, commitManeuverNode, deleteManeuverNode, setPendingTransfer, addQueuedTransfer,
    launchTorchTransfer,
    buildShip, cancelBuild,
    createFleet, disbandFleet, removeFromFleet, addToFleet,
    deploySettlement, damageSettlement, buildCollector,
    queueBuilding, cancelBuilding,
    createTradeRoute, cancelTradeRoute,
    selectedSettlementId, selectSettlement,
    startResearch, cancelResearch,
    enqueueResearch, dequeueResearch, moveResearchUp,
    turnBasedActive, commitTurn,
    adjustResources,
  };

  return (
    <GameContext.Provider value={value}>{children}</GameContext.Provider>
  );
}

export function useGameContext(): GameContextType {
  const context = useContext(GameContext);
  if (!context) {
    throw new Error('useGameContext must be used within GameContextProvider');
  }
  return context;
}
