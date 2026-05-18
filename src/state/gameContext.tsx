import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { GameState, ManeuverNode, CameraState, MapUIState, Ship, Body, TransferArc, BuildOrder, SettlementType, FactionResources } from '../types';
// Scenarios were removed when single-player switched to SinglePlayerSetup.
// GameContextProvider now requires either an initialState (single-player,
// seeded by setupSinglePlayer) or an externalState (multiplayer, server-
// driven). The fallback empty state below is only hit if neither prop is
// passed, which would be a programming error rather than a play state.
import { createCircularOrbit } from '../physics/orbitalMechanics';
import { getShipClass, ShipClassName, SHIP_CLASSES } from '../game/shipClasses';
import { formFleet, splitFromFleet } from '../game/fleet';
import { autoCombatAtBodies } from '../game/combat';
import { logger } from '../game/logger';
import {
  createCity, createStation, tickSettlements,
  canHostCity, canHostStation, SETTLEMENT_DEFS,
} from '../game/settlements';
import { tickMaintenance } from '../game/maintenance';
import { TechId, TECH_DEFS } from '../game/techs';
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
      if (!ship || ship.transfer || ship.pendingTransfer) return { applied: false };
      const arc = planBezierTransfer(ship.orbit, intent.targetBodyId, tick, snapshot.bodies);
      if (!arc) return { applied: false };
      // AI ships skip the player's pending/committed-node workflow — they go
      // straight to transfer at planning time. This mirrors how the human
      // would commit instantly via the COMMIT button.
      const updatedShips = snapshot.ships.map(s =>
        s.id === ship.id
          ? { ...s, transfer: arc, pendingTransfer: undefined, lastBurnTick: tick }
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
  selectedSettlementId?: string;
  selectSettlement: (id: string | undefined) => void;

  // Research / tech tree
  startResearch: (techId: TechId) => void;
  cancelResearch: () => void;

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

  // Ship state machine for Bezier transfers:
  //   orbiting (no transfer) → committed node fires → in_transit (transfer set)
  //   in_transit → arrivalTime reached → orbiting at destination
  const checkNodeExecution = useCallback((ships: Ship[], bodies: Body[], tick: number): Ship[] => {
    let mutated = false;
    const updatedShips = ships.map(ship => {
      let orbit = ship.orbit;
      let fuel = ship.fuel;
      let orders = ship.orders;
      let transfer = ship.transfer;
      let pendingTransfer = ship.pendingTransfer;
      let queuedTransfers = ship.queuedTransfers ? [...ship.queuedTransfers] : [];
      let changed = false;

      if (transfer) {
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
        return { ...ship, orbit, fuel, orders, transfer, pendingTransfer, queuedTransfers: nextQueued };
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
    const updatedShips0 = checkNodeExecution(prev.ships, prev.bodies, newTime);
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
      prev.settlements, prev.bodies, updatedShips, newTime, factionPools, yieldMul,
    );
    let updatedSettlements = settlementsResult.settlements;

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
    // science into the research bar; level up when full. Excess rolls into the
    // next level so a stockpile can finish multiple cheap levels in one tick.
    const updatedTech: typeof prev.factionTech = {};
    for (const [fid, ts0] of Object.entries(prev.factionTech)) {
      let ts = ts0;
      if (!ts.researching) { updatedTech[fid] = ts; continue; }
      const techId = ts.researching as TechId;
      const def = TECH_DEFS[techId];
      if (!def) { updatedTech[fid] = ts; continue; }
      const pool = factionPools[fid];
      let available = pool ? pool.science : 0;
      if (available <= 0) { updatedTech[fid] = ts; continue; }

      let progress = ts.progress;
      let levels = { ...ts.levels };
      let iters = 0;
      while (available > 0 && iters++ < 100) {
        const curLevel = levels[techId] ?? 0;
        const cost = Math.ceil(def.baseCost * Math.pow(curLevel + 1, def.costScaling));
        const need = cost - progress;
        const spend = Math.min(available, need);
        progress += spend;
        available -= spend;
        if (progress >= cost) {
          levels[techId] = curLevel + 1;
          progress = 0;
        } else {
          break;
        }
      }
      if (pool) pool.science = available;
      updatedTech[fid] = { ...ts, levels, progress, researching: ts.researching };
    }

    const combatLog = combatNewLogs.length > 0
      ? [...prev.combatLog.slice(-20), ...combatNewLogs]
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
  }, [gameState.bodies, gameState.resources, gameState.factionTech]);

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

  const startResearch = useCallback((techId: TechId) => {
    setGameStateInternal(prev => {
      const cur = prev.factionTech.player ?? { levels: {}, researching: null, progress: 0 };
      return {
        ...prev,
        factionTech: {
          ...prev.factionTech,
          player: { ...cur, researching: techId, progress: 0 },
        },
      };
    });
  }, []);

  const cancelResearch = useCallback(() => {
    setGameStateInternal(prev => {
      const cur = prev.factionTech.player ?? { levels: {}, researching: null, progress: 0 };
      return {
        ...prev,
        factionTech: {
          ...prev.factionTech,
          player: { ...cur, researching: null, progress: 0 },
        },
      };
    });
  }, []);

  const value: GameContextType = {
    gameState, camera, uiState, simSpeed,
    setGameState, updateGameState, updateTick, setSimSpeed,
    updateCamera, focusBody,
    selectShip, deselectShip, selectBody, deselectBody, hoverBody,
    setTargetSelectionMode,
    addManeuverNode, commitManeuverNode, deleteManeuverNode, setPendingTransfer, addQueuedTransfer,
    buildShip, cancelBuild,
    createFleet, disbandFleet, removeFromFleet, addToFleet,
    deploySettlement, damageSettlement,
    selectedSettlementId, selectSettlement,
    startResearch, cancelResearch,
    turnBasedActive, commitTurn,
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
