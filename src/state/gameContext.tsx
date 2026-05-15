import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { GameState, ManeuverNode, CameraState, MapUIState, Ship, Body, TransferArc, BuildOrder, SettlementType, FactionResources } from '../types';
import { getScenario, ScenarioType } from './mockGameState';
import { createCircularOrbit } from '../physics/orbitalMechanics';
import { getShipClass, ShipClassName, SHIP_CLASSES } from '../game/shipClasses';
import { formFleet, splitFromFleet } from '../game/fleet';
import { checkCombatAtBodies, applyCombatResults, processEngagements } from '../game/combat';
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
  setZoomLevel: (level: 1 | 2 | 3) => void;
  focusBody: (bodyId: string | undefined) => void;

  selectShip: (shipId: string) => void;
  deselectShip: () => void;
  selectBody: (bodyId: string) => void;
  deselectBody: () => void;
  hoverBody: (bodyId: string | null) => void;
  setManeuverMode: (mode: 'transfer' | 'orbital_change' | null) => void;
  setTransferTarget: (bodyId: string | null) => void;
  setTargetSelectionMode: (enabled: boolean) => void;
  setEngagementTargetMode: (enabled: boolean) => void;

  // Combat engagement
  engageTarget: (shipId: string, targetShipId: string) => void;
  disengageTarget: (shipId: string) => void;

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
    maneuverMode: null,
    transferTargetId: undefined,
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
        if (tick >= transfer.arrivalTime) {
          const cost = Math.round(Math.abs(transfer.arrivalDv) * 10);
          fuel = Math.max(0, fuel - cost);

          if (queuedTransfers.length > 0) {
            // Chain into next queued transfer
            const nextArc = queuedTransfers.shift()!;
            const depCost = Math.round(Math.abs(nextArc.departureDv) * 10);
            fuel = Math.max(0, fuel - depCost);
            transfer = nextArc;
            orbit = createCircularOrbit(nextArc.departureBodyId, 10, tick, bodies);
          } else {
            const arrBody = bodies.find(b => b.id === transfer!.arrivalBodyId);
            const arrRadius = arrBody ? arrBody.radius + 4 : 10;
            orbit = createCircularOrbit(transfer.arrivalBodyId, arrRadius, tick, bodies);
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
        return { ...ship, orbit, fuel, orders, transfer, pendingTransfer, queuedTransfers };
      }
      return ship;
    });
    return mutated ? updatedShips : ships;
  }, []);

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

      setGameStateInternal(prev => {
        const newTime = prev.currentTick + tickDelta;
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
        const updatedResources = factionPools;

        // Process player-initiated engagements (range-based damage every N ticks)
        // Targets can be ships OR settlements; settlements auto-retaliate.
        const engagementResult = processEngagements(updatedShips, updatedSettlements, prev.bodies, newTime);
        updatedShips = engagementResult.ships;
        updatedSettlements = engagementResult.settlements;
        const engagementLogs = engagementResult.log;

        // Check combat at bodies
        const combatResults = checkCombatAtBodies(updatedShips, prev.bodies);
        const combatNewLogs = combatResults.flatMap(r => r.log);
        if (combatResults.length > 0) {
          updatedShips = applyCombatResults(updatedShips, combatResults);
        }

        // Repair and refuel ships at owned bodies (after combat so dead ships are gone)
        updatedShips = tickMaintenance(updatedShips, updatedSettlements, prev.bodies, tickDelta);

        const allLogs = [...engagementLogs, ...combatNewLogs];
        const allOrders = updatedShips.flatMap(s => s.orders);
        return {
          ...prev, ships: updatedShips, orders: allOrders,
          currentTick: newTime, buildOrders, resources: updatedResources,
          settlements: updatedSettlements,
          combatLog: allLogs.length > 0 ? [...prev.combatLog.slice(-20), ...allLogs] : prev.combatLog,
        };
      });
    }, 50);

    return () => clearInterval(interval);
  }, [simSpeed, checkNodeExecution]);

  const setGameState = useCallback((state: GameState) => {
    setGameStateInternal(state);
  }, []);

  const updateGameState = useCallback((partial: Partial<GameState>) => {
    setGameStateInternal(prev => ({ ...prev, ...partial }));
  }, []);

  const updateTick = useCallback((tick: number) => {
    setGameStateInternal(prev => {
      const tickDelta = Math.max(0, tick - prev.currentTick);
      let updatedShips = checkNodeExecution(prev.ships, prev.bodies, tick);

      // Process build orders
      let buildOrders = prev.buildOrders;
      const completedBuilds = buildOrders.filter(bo => tick >= bo.completeTick);
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
            orbit: createCircularOrbit(bo.bodyId, 8, tick, prev.bodies),
            orders: [],
          };
        });
        updatedShips = [...updatedShips, ...newShips];
        buildOrders = buildOrders.filter(bo => tick < bo.completeTick);
      }

      // Settlement extraction + freighter offload
      const factionPools: Record<string, FactionResources> = {};
      for (const [fid, fr] of Object.entries(prev.resources)) {
        factionPools[fid] = { ...fr };
      }
      const settlementsResult = tickSettlements(
        prev.settlements, prev.bodies, updatedShips, tick, factionPools,
      );
      let updatedSettlements = settlementsResult.settlements;
      const updatedResources = factionPools;

      // Process player-initiated engagements (range-based damage every N ticks)
      // Targets can be ships OR settlements; settlements auto-retaliate.
      const engagementResult = processEngagements(updatedShips, updatedSettlements, prev.bodies, tick);
      updatedShips = engagementResult.ships;
      updatedSettlements = engagementResult.settlements;
      const engagementLogs = engagementResult.log;

      // Check combat at bodies
      const combatResults = checkCombatAtBodies(updatedShips, prev.bodies);
      let combatLog = prev.combatLog;
      const combatNewLogs = combatResults.flatMap(r => r.log);
      if (combatResults.length > 0) {
        updatedShips = applyCombatResults(updatedShips, combatResults);
      }

      // Repair and refuel ships at owned bodies
      updatedShips = tickMaintenance(updatedShips, updatedSettlements, prev.bodies, tickDelta);
      const allNewLogs = [...engagementLogs, ...combatNewLogs];
      if (allNewLogs.length > 0) {
        combatLog = [...combatLog.slice(-20), ...allNewLogs];
      }

      const allOrders = updatedShips.flatMap(s => s.orders);
      return {
        ...prev, ships: updatedShips, orders: allOrders,
        currentTick: tick, buildOrders, resources: updatedResources,
        settlements: updatedSettlements,
        combatLog,
      };
    });
  }, [checkNodeExecution]);

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
      maneuverMode: null,
      transferTargetId: undefined,
    });
    setSelectedSettlementId(undefined);
  }, []);

  const updateCamera = useCallback((partial: Partial<CameraState>) => {
    setCameraInternal(prev => ({ ...prev, ...partial }));
  }, []);

  const setZoomLevel = useCallback((level: 1 | 2 | 3) => {
    setCameraInternal(prev => ({ ...prev, zoomLevel: level }));
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

  const setManeuverMode = useCallback((mode: 'transfer' | 'orbital_change' | null) => {
    setUIStateInternal(prev => ({
      ...prev, maneuverMode: mode, transferTargetId: mode ? prev.transferTargetId : undefined,
    }));
  }, []);

  const setTransferTarget = useCallback((bodyId: string | null) => {
    setUIStateInternal(prev => ({ ...prev, transferTargetId: bodyId || undefined }));
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

  const setEngagementTargetMode = useCallback((enabled: boolean) => {
    setUIStateInternal(prev => ({ ...prev, engagementTargetMode: enabled }));
  }, []);

  const engageTarget = useCallback((shipId: string, targetShipId: string) => {
    setGameStateInternal(prev => ({
      ...prev,
      ships: prev.ships.map(s => s.id === shipId ? { ...s, engagedTargetId: targetShipId } : s),
    }));
    setUIStateInternal(prev => ({ ...prev, engagementTargetMode: false }));
  }, []);

  const disengageTarget = useCallback((shipId: string) => {
    setGameStateInternal(prev => ({
      ...prev,
      ships: prev.ships.map(s => s.id === shipId ? { ...s, engagedTargetId: undefined } : s),
    }));
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

    // Require player ship in orbit at this body
    const playerShipHere = gameState.ships.find(s =>
      s.ownedBy === 'player' &&
      !s.transfer &&
      s.orbit.parentBodyId === bodyId
    );
    if (!playerShipHere) return false;

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

  // ---- Fleet Management ----
  const createFleet = useCallback((name: string, shipIds: string[]) => {
    setGameStateInternal(prev => {
      const fleet = formFleet(name, shipIds, prev.ships);
      if (!fleet) return prev;

      const updatedShips = prev.ships.map(s =>
        shipIds.includes(s.id) ? { ...s, fleetId: fleet.id } : s
      );

      return {
        ...prev,
        ships: updatedShips,
        fleets: [...prev.fleets, fleet],
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
          : prev.fleets.filter(f => f.id !== fleetId), // dissolve fleet if < 2
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

      // Check same location
      const leadShip = prev.ships.find(s => s.id === fleet.leadShipId);
      if (!leadShip || ship.orbit.parentBodyId !== leadShip.orbit.parentBodyId) return prev;

      return {
        ...prev,
        fleets: prev.fleets.map(f =>
          f.id === fleetId
            ? { ...f, shipIds: [...f.shipIds, shipId] }
            : f
        ),
        ships: prev.ships.map(s =>
          s.id === shipId ? { ...s, fleetId: fleetId } : s
        ),
      };
    });
  }, []);

  const value: GameContextType = {
    gameState, camera, uiState, simSpeed,
    setGameState, updateGameState, updateTick, setSimSpeed, loadScenario,
    updateCamera, setZoomLevel, focusBody,
    selectShip, deselectShip, selectBody, deselectBody, hoverBody,
    setManeuverMode, setTransferTarget, setTargetSelectionMode, setEngagementTargetMode,
    addManeuverNode, commitManeuverNode, deleteManeuverNode, setPendingTransfer, addQueuedTransfer,
    buildShip, cancelBuild,
    createFleet, disbandFleet, removeFromFleet, addToFleet,
    engageTarget, disengageTarget,
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
