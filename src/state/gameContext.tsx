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
}

const GameContext = createContext<GameContextType | undefined>(undefined);

interface GameContextProviderProps {
  children: React.ReactNode;
  initialScenario?: ScenarioType;
}

export function GameContextProvider({
  children,
  initialScenario = 1,
}: GameContextProviderProps) {
  const [gameState, setGameStateInternal] = useState<GameState>(
    getScenario(initialScenario)
  );
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
    const settlementsResult = tickSettlements(
      prev.settlements, prev.bodies, updatedShips, newTime, factionPools,
    );
    let updatedSettlements = settlementsResult.settlements;

    // Auto-combat: every ship and combat-capable settlement fires once every
    // AUTO_COMBAT_INTERVAL ticks at every hostile combatant at the same body.
    const combatResult = autoCombatAtBodies(updatedShips, updatedSettlements, prev.bodies, newTime);
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

    const combatLog = combatNewLogs.length > 0
      ? [...prev.combatLog.slice(-20), ...combatNewLogs]
      : prev.combatLog;

    const allOrders = updatedShips.flatMap(s => s.orders);
    return {
      ...prev,
      ships: updatedShips,
      orders: allOrders,
      currentTick: newTime,
      buildOrders,
      resources: factionPools,
      settlements: updatedSettlements,
      fleets: updatedFleets,
      combatLog,
    };
  }, [checkNodeExecution]);

  // Tick-based game loop
  const lastTimeRef = useRef<number>(0);

  useEffect(() => {
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
  }, [simSpeed, advanceToTick]);

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

    // Check resources
    const res = gameState.resources['player'];
    if (!res || res.fuel < classDef.cost.fuel || res.ore < classDef.cost.ore || res.credits < classDef.cost.credits) return false;

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
            fuel: playerRes.fuel - classDef.cost.fuel,
            ore: playerRes.ore - classDef.cost.ore,
            credits: playerRes.credits - classDef.cost.credits,
          },
        },
      };
    });
    return true;
  }, [gameState.bodies, gameState.resources]);

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
