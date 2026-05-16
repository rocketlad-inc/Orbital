import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { GameState, ManeuverNode, CameraState, MapUIState, Ship, Body, TransferArc, BuildOrder, SettlementType, FactionResources } from '../types';
import { getScenario, ScenarioType } from './mockGameState';
import { createCircularOrbit } from '../physics/orbitalMechanics';
import { getShipClass, ShipClassName, SHIP_CLASSES } from '../game/shipClasses';
import { formFleet, splitFromFleet } from '../game/fleet';
import { autoCombatAtBodies } from '../game/combat';
import {
  createCity, createStation, tickSettlements,
  canHostCity, canHostStation, SETTLEMENT_DEFS,
} from '../game/settlements';
import { tickMaintenance } from '../game/maintenance';
import { TechId, TECH_DEFS } from '../game/techs';
import { runFactionAI, shouldRunAI } from '../game/factionAI';
import { planBezierTransfer } from '../physics/bezierTransfer';
import { computeWinner } from './singlePlayerSetup';
import type { AIActivityEntry } from '../types';

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

export const TICKS_PER_GAME_DAY = 24;
const REAL_SECONDS_PER_GAME_DAY = 3600;
const BASE_TICK_RATE = TICKS_PER_GAME_DAY / REAL_SECONDS_PER_GAME_DAY;

interface GameContextType {
  gameState: GameState;
  camera: CameraState;
  uiState: MapUIState;
  simSpeed: number;

  setGameState: (state: GameState) => void;
  updateGameState: (partial: Partial<GameState>) => void;
  updateTick: (tick: number) => void;
  setSimSpeed: (speed: number) => void;
  loadScenario: (type: ScenarioType) => void;

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
}

const GameContext = createContext<GameContextType | undefined>(undefined);

interface GameContextProviderProps {
  children: React.ReactNode;
  initialScenario?: ScenarioType;
  /**
   * Seeded single-player state from SinglePlayerSetup. Takes precedence
   * over initialScenario but yields to externalState when present.
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

export function GameContextProvider({
  children,
  initialScenario = 1,
  initialState,
  externalState,
  externallyControlled = false,
  initialFocusBodyId = null,
}: GameContextProviderProps) {
  const [gameState, setGameStateInternal] = useState<GameState>(
    () => externalState ?? initialState ?? getScenario(initialScenario)
  );

  // Replace gameState whenever the external snapshot changes reference.
  useEffect(() => {
    if (externalState) setGameStateInternal(externalState);
  }, [externalState]);

  // One-shot: focus the camera on the requested body the first time
  // that body shows up in gameState. Used by MultiplayerGameProvider
  // to land the player at their capital instead of at Sol.
  const initialFocusAppliedRef = useRef(false);
  useEffect(() => {
    if (initialFocusAppliedRef.current) return;
    if (!initialFocusBodyId) return;
    const exists = gameState.bodies.some(b => b.id === initialFocusBodyId);
    if (!exists) return;
    initialFocusAppliedRef.current = true;
    setCameraInternal(prev => ({
      ...prev, focusedBodyId: initialFocusBodyId, x: 0, y: 0, scale: 2, zoomLevel: 2,
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
        const expiredPlannedIds: string[] = [];
        let discardedTransferPlan = false;
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
          } else if (node.status === 'planned' && node.burnTime < tick) {
            // Planned (uncommitted) node whose burn window already
            // passed. The player never committed it, so the plan is
            // stale — drop it so it stops cluttering the order list
            // and so its dashed Bezier preview disappears from the
            // map. Pending transfer state attached to it is cleared
            // alongside.
            expiredPlannedIds.push(node.id);
            if (node.type === 'transfer') discardedTransferPlan = true;
            changed = true;
          }
        }
        const removeIds = new Set([...executedIds, ...expiredPlannedIds]);
        if (removeIds.size > 0) {
          orders = orders.filter(o => !removeIds.has(o.id));
        }
        if (discardedTransferPlan) {
          pendingTransfer = undefined;
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
    let updatedShips = checkNodeExecution(prev.ships, prev.bodies, newTime);

    // Process build orders
    let buildOrders = prev.buildOrders;
    const completedBuilds = buildOrders.filter(bo => newTime >= bo.completeTick);
    if (completedBuilds.length > 0) {
      const newShips: Ship[] = completedBuilds.map(bo => {
        const classDef = getShipClass(bo.shipClass as ShipClassName);
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
    let nextStatus: GameState['status'] = prev.status;
    let winnerFactionId = prev.winnerFactionId;
    let victoryType = prev.victoryType;
    if (prev.totalTickTarget && newTime >= prev.totalTickTarget) {
      const post: GameState = {
        ...prev,
        ships: updatedShips,
        settlements: updatedSettlements,
        resources: factionPools,
        factions: updatedFactions,
      };
      const win = computeWinner(post);
      if (win) {
        nextStatus = 'completed';
        winnerFactionId = win.factionId;
        victoryType = win.victoryType;
      }
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

  useEffect(() => {
    // In multiplayer the server's Room-DO alarm advances time. The local
    // sim loop is suppressed so the canvas can't drift away from the
    // server's authoritative tick.
    if (externallyControlled) return;
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
  }, [simSpeed, advanceToTick, externallyControlled]);

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

  const loadScenario = useCallback((type: ScenarioType) => {
    setGameStateInternal(getScenario(type));
    setSimSpeedInternal(0);
    setCameraInternal({ x: 0, y: 0, scale: 1, zoomLevel: 1 });
    setUIStateInternal({
      selectedShipId: undefined,
      selectedBodyId: undefined,
      hoveredBodyId: undefined,
      targetSelectionMode: false,
    });
    setSelectedSettlementId(undefined);
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
    setGameStateInternal(prev => ({
      ...prev,
      orders: [...prev.orders, node],
      ships: prev.ships.map(ship =>
        ship.id === node.shipId
          ? { ...ship, orders: [...ship.orders, node] }
          : ship
      ),
    }));
  }, []);

  const commitManeuverNode = useCallback((nodeId: string) => {
    setGameStateInternal(prev => ({
      ...prev,
      orders: prev.orders.map(order =>
        order.id === nodeId ? { ...order, status: 'committed' as const } : order
      ),
      ships: prev.ships.map(ship => ({
        ...ship,
        orders: ship.orders.map(order =>
          order.id === nodeId ? { ...order, status: 'committed' as const } : order
        ),
      })),
    }));
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
    if (!classDef) return false;

    // Check if body is owned by the player
    const body = gameState.bodies.find(b => b.id === bodyId);
    if (!body || body.ownedBy !== 'player') return false;

    // Apply Construction-tech cost discount (capped at 75% off).
    const constructionLvl = gameState.factionTech.player?.levels['construction'] ?? 0;
    const costMul = Math.max(0.25, 1 - TECH_DEFS.construction.perLevel * constructionLvl);
    const fuelCost = Math.ceil(classDef.cost.fuel * costMul);
    const oreCost = Math.ceil(classDef.cost.ore * costMul);
    const creditCost = Math.ceil(classDef.cost.credits * costMul);

    // Check resources
    const res = gameState.resources['player'];
    if (!res || res.fuel < fuelCost || res.ore < oreCost || res.credits < creditCost) return false;

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
    if (!body) return false;

    // Body type gate
    if (type === 'city' && !canHostCity(body)) return false;
    if (type === 'station' && !canHostStation(body)) return false;

    // Require a player FREIGHTER in orbit at this body — only freighters
    // can deploy settlements (combat ships carry no construction materials).
    const playerFreighterHere = gameState.ships.find(s =>
      s.ownedBy === 'player' &&
      !s.transfer &&
      s.orbit.parentBodyId === bodyId &&
      s.class === 'freighter'
    );
    if (!playerFreighterHere) return false;

    // Resource cost
    const def = SETTLEMENT_DEFS[type];
    const res = gameState.resources['player'];
    if (!res || res.fuel < def.cost.fuel || res.ore < def.cost.ore || res.credits < def.cost.credits) {
      return false;
    }

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
    setGameState, updateGameState, updateTick, setSimSpeed, loadScenario,
    updateCamera, focusBody,
    selectShip, deselectShip, selectBody, deselectBody, hoverBody,
    setTargetSelectionMode,
    addManeuverNode, commitManeuverNode, deleteManeuverNode, setPendingTransfer, addQueuedTransfer,
    buildShip, cancelBuild,
    createFleet, disbandFleet, removeFromFleet, addToFleet,
    deploySettlement, damageSettlement,
    selectedSettlementId, selectSettlement,
    startResearch, cancelResearch,
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
