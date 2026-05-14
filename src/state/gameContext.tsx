// ============================================================
// Game State Context - React Context for global game state
// ============================================================

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { GameState, ManeuverNode, CameraState, MapUIState, Ship, Body } from '../types';
import { getScenario, ScenarioType } from './mockGameState';
import {
  orbitWorldPos,
  orbitWorldVelocity,
  bodyPosition,
  orbitFromWorldState,
  applyNodeToOrbit,
  semiMajor,
  muOf,
  localPositionAt,
} from '../physics/orbitalMechanics';

// Time system: 1 tick = 1 game hour, 24 ticks = 1 game day
// Default mapping: 1 real hour = 1 game day (configurable via REAL_SECONDS_PER_GAME_DAY)
export const TICKS_PER_GAME_DAY = 24;
const REAL_SECONDS_PER_GAME_DAY = 3600;
const BASE_TICK_RATE = TICKS_PER_GAME_DAY / REAL_SECONDS_PER_GAME_DAY; // ~0.00667 ticks/sec
const MAX_TICKS_PER_FRAME = 100;

interface GameContextType {
  gameState: GameState;
  camera: CameraState;
  uiState: MapUIState;
  simSpeed: number;

  // Game state updates
  setGameState: (state: GameState) => void;
  updateGameState: (partial: Partial<GameState>) => void;
  updateTick: (tick: number) => void;
  setSimSpeed: (speed: number) => void;
  loadScenario: (type: ScenarioType) => void;

  // Camera updates
  updateCamera: (camera: Partial<CameraState>) => void;
  setZoomLevel: (level: 1 | 2 | 3) => void;
  focusBody: (bodyId: string | undefined) => void;

  // UI updates
  selectShip: (shipId: string) => void;
  deselectShip: () => void;
  selectBody: (bodyId: string) => void;
  deselectBody: () => void;
  hoverBody: (bodyId: string | null) => void;
  setManeuverMode: (mode: 'transfer' | 'orbital_change' | null) => void;
  setTransferTarget: (bodyId: string | null) => void;

  // Maneuver updates
  addManeuverNode: (node: ManeuverNode) => void;
  commitManeuverNode: (nodeId: string) => void;
  deleteManeuverNode: (nodeId: string) => void;
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
    x: 0,
    y: 0,
    scale: 1,
    zoomLevel: 1,
  });

  const [uiState, setUIStateInternal] = useState<MapUIState>({
    selectedShipId: undefined,
    selectedBodyId: undefined,
    hoveredBodyId: undefined,
    maneuverMode: null,
    transferTargetId: undefined,
  });

  const [simSpeed, setSimSpeedInternal] = useState<number>(0);

  const setSimSpeed = useCallback((speed: number) => {
    setSimSpeedInternal(speed);
  }, []);

  // ---- checkNodeExecution: the heartbeat ----
  // Ported from the HTML prototype. For each ship, each frame:
  //   1. SOI exit detection (ship left parent's SOI -> re-anchor to grandparent)
  //      Sets soiGrace to prevent oscillation at SOI boundary
  //   2. SOI entry detection (ship entered a child body's SOI -> re-anchor to child)
  //      Respects soiGrace to skip recently-exited bodies
  //      Handles capture nodes: creates stable circular orbit on SOI entry
  //   3. Committed node execution (node.burnTime <= currentTick -> apply burn, deduct fuel)
  //      Uses exact burnTime for position/velocity computation, not integer tick
  const checkNodeExecution = useCallback((ships: Ship[], bodies: Body[], tick: number): Ship[] => {
    const TWO_PI = Math.PI * 2;
    let mutated = false;
    const updatedShips = ships.map(ship => {
      let orbit = ship.orbit;
      let fuel = ship.fuel;
      let orders = ship.orders;
      let soiGrace = ship.soiGrace;
      let soiGraceBody = ship.soiGraceBody;
      let changed = false;

      // 1) SOI exit: is the ship still inside its parent's SOI?
      const parent = bodies.find(b => b.id === orbit.parentBodyId);
      if (parent && parent.id !== 'sol') {
        const shipPos = orbitWorldPos(orbit, tick, bodies);
        const pp = bodyPosition(parent, tick, bodies);
        const dx = shipPos.x - pp.x;
        const dy = shipPos.y - pp.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > parent.soi && parent.parent) {
          const wv = orbitWorldVelocity(orbit, tick, bodies);
          const newOrbit = orbitFromWorldState(
            shipPos.x, shipPos.y, wv.x, wv.y,
            parent.parent, tick, bodies
          );
          if (newOrbit) {
            orbit = newOrbit;
            // SOI grace: ignore re-entry into this body for 10 ticks
            soiGrace = tick + 10;
            soiGraceBody = parent.id;
            changed = true;
          }
        }
      }

      // 2) SOI entry: check entering any child body's SOI
      // Use a generous detection radius when the ship has a committed capture node
      // for that body — compensates for small trajectory deviations from the planner
      const captureTargets = new Set(
        orders.filter(n => n.status === 'committed' && n.capturedAtBody).map(n => n.capturedAtBody!)
      );
      const shipPos = orbitWorldPos(orbit, tick, bodies);
      for (const body of bodies) {
        if (body.id === 'sol' || body.id === orbit.parentBodyId) continue;
        if (body.parent !== orbit.parentBodyId) continue;
        // SOI grace: skip bodies we just exited to prevent oscillation
        if (soiGrace && tick < soiGrace && body.id === soiGraceBody) continue;
        // During transfers, skip SOI entry for non-target bodies to prevent
        // flyby encounters from corrupting the transfer trajectory
        if (captureTargets.size > 0 && !captureTargets.has(body.id)) continue;
        const bp = bodyPosition(body, tick, bodies);
        const bdx = shipPos.x - bp.x;
        const bdy = shipPos.y - bp.y;
        const bdist = Math.sqrt(bdx * bdx + bdy * bdy);
        const effectiveSOI = captureTargets.has(body.id) ? body.soi * 1.3 : body.soi;
        if (bdist < effectiveSOI) {
          const wv = orbitWorldVelocity(orbit, tick, bodies);
          const newOrbit = orbitFromWorldState(
            shipPos.x, shipPos.y, wv.x, wv.y,
            body.id, tick, bodies
          );
          if (newOrbit) {
            orbit = newOrbit;
            // Clear grace on entry (we've committed to a new SOI)
            soiGrace = undefined;
            soiGraceBody = undefined;
            changed = true;

            // Capture node handling: if ship has a committed capture node for
            // this body, place it in a stable circular orbit instead of the
            // raw hyperbolic/elliptical trajectory
            const capNode = orders.find(
              n => n.status === 'committed' && n.capturedAtBody === body.id
            );
            if (capNode) {
              const mu_cap = muOf(body.id, bodies);
              const local_cap = localPositionAt(newOrbit, tick);
              const r_cap = Math.sqrt(local_cap.x * local_cap.x + local_cap.y * local_cap.y);
              // Clamp capture radius to 80% of SOI (rule of cool: stable orbit)
              const capR = Math.min(r_cap, body.soi * 0.8);
              const omega_cap = Math.atan2(local_cap.y, local_cap.x);
              orbit = {
                rp: capR,
                ra: capR,
                omega: omega_cap,
                M0: 0,
                epoch: tick,
                direction: newOrbit.direction,
                period: TWO_PI * Math.sqrt(capR * capR * capR / mu_cap),
                parentBodyId: body.id,
              };
              // Deduct fuel for capture burn
              const cost = Math.round(Math.abs(capNode.deltav) * 10);
              fuel = Math.max(0, fuel - cost);
              // Remove the capture node from orders
              orders = orders.filter(n => n.id !== capNode.id);
            }
          }
          break;
        }
      }

      // 3) Fire committed nodes whose burnTime has come
      //    Sort by burnTime and process in order so each burn chains correctly
      //    Skip capture nodes (handled during SOI entry above)
      const sortedOrders = [...orders].sort((a, b) => a.burnTime - b.burnTime);
      const executedIds: string[] = [];
      for (const node of sortedOrders) {
        if (node.status === 'committed' && node.burnTime <= tick) {
          // Capture nodes are handled during SOI entry, not here
          if (node.capturedAtBody) continue;
          // Fuel cost: magnitude of deltav * 10 (matching prototype formula)
          const cost = Math.round(Math.abs(node.deltav) * 10);
          if (fuel >= cost) {
            // Use new applyNodeToOrbit signature: (preOrbit, node, bodies)
            // The function reads node.burnTime, node.prograde, node.radial internally
            orbit = applyNodeToOrbit(orbit, node, bodies);
            fuel -= cost;
          }
          executedIds.push(node.id);
          changed = true;
        }
      }

      if (executedIds.length > 0) {
        orders = orders.filter(o => !executedIds.includes(o.id));
      }

      if (changed) {
        mutated = true;
        return { ...ship, orbit, fuel, orders, soiGrace, soiGraceBody };
      }
      return ship;
    });

    return mutated ? updatedShips : ships;
  }, []);

  // ---- Tick-based game loop ----
  // Time advances continuously; checkNodeExecution runs every frame with the
  // real fractional tick value.  This ensures burns fire at their exact burnTime
  // (not rounded to the next integer tick) and SOI transitions are detected at
  // sub-tick resolution.  Matches the HTML prototype's requestAnimationFrame loop
  // which calls checkNodeExecution on every frame with a continuous `tick`.
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

        // Run checkNodeExecution every frame with the real fractional tick.
        // For large time jumps (e.g. high sim speed), run intermediate checks
        // at integer boundaries to avoid missing SOI transitions.
        const prevFloor = Math.floor(prev.currentTick);
        const newFloor = Math.floor(newTime);
        let state = prev;

        if (newFloor > prevFloor) {
          // Process any integer tick boundaries we skipped over
          const ticksToProcess = Math.min(newFloor - prevFloor, MAX_TICKS_PER_FRAME);
          const startTick = prevFloor + 1;
          for (let t = startTick; t < startTick + ticksToProcess; t++) {
            const updatedShips = checkNodeExecution(state.ships, state.bodies, t);
            const allOrders = updatedShips.flatMap(s => s.orders);
            state = { ...state, ships: updatedShips, orders: allOrders };
          }
        }

        // Always run a final check at the exact fractional tick for precise
        // burn timing and SOI detection
        const updatedShips = checkNodeExecution(state.ships, state.bodies, newTime);
        const allOrders = updatedShips.flatMap(s => s.orders);
        return { ...state, ships: updatedShips, orders: allOrders, currentTick: newTime };
      });
    }, 50);

    return () => clearInterval(interval);
  }, [simSpeed, checkNodeExecution]);

  const setGameState = useCallback((state: GameState) => {
    setGameStateInternal(state);
  }, []);

  const updateGameState = useCallback((partial: Partial<GameState>) => {
    setGameStateInternal(prev => ({
      ...prev,
      ...partial,
    }));
  }, []);

  const updateTick = useCallback((tick: number) => {
    setGameStateInternal(prev => ({
      ...prev,
      currentTick: tick,
    }));
  }, []);

  const loadScenario = useCallback((type: ScenarioType) => {
    setGameStateInternal(getScenario(type));
    setSimSpeedInternal(0); // Pause on scenario load
    // Reset camera and UI state
    setCameraInternal({ x: 0, y: 0, scale: 1, zoomLevel: 1 });
    setUIStateInternal({
      selectedShipId: undefined,
      selectedBodyId: undefined,
      hoveredBodyId: undefined,
      maneuverMode: null,
      transferTargetId: undefined,
    });
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
          ...prev,
          focusedBodyId: bodyId,
          x: 0,
          y: 0,
          scale: 2,
          zoomLevel: 2,
        }));
      }
    } else {
      setCameraInternal(prev => ({
        ...prev,
        focusedBodyId: undefined,
        x: 0,
        y: 0,
        scale: 1,
        zoomLevel: 1,
      }));
    }
  }, [gameState.bodies]);

  const selectShip = useCallback((shipId: string) => {
    setUIStateInternal(prev => ({
      ...prev,
      selectedShipId: shipId,
      selectedBodyId: undefined,
    }));
  }, []);

  const deselectShip = useCallback(() => {
    setUIStateInternal(prev => ({
      ...prev,
      selectedShipId: undefined,
    }));
  }, []);

  const selectBody = useCallback((bodyId: string) => {
    setUIStateInternal(prev => ({
      ...prev,
      selectedBodyId: bodyId,
      selectedShipId: undefined,
    }));
  }, []);

  const deselectBody = useCallback(() => {
    setUIStateInternal(prev => ({
      ...prev,
      selectedBodyId: undefined,
    }));
  }, []);

  const hoverBody = useCallback((bodyId: string | null) => {
    setUIStateInternal(prev => ({
      ...prev,
      hoveredBodyId: bodyId || undefined,
    }));
  }, []);

  const setManeuverMode = useCallback(
    (mode: 'transfer' | 'orbital_change' | null) => {
      setUIStateInternal(prev => ({
        ...prev,
        maneuverMode: mode,
        transferTargetId: mode ? prev.transferTargetId : undefined,
      }));
    },
    []
  );

  const setTransferTarget = useCallback((bodyId: string | null) => {
    setUIStateInternal(prev => ({
      ...prev,
      transferTargetId: bodyId || undefined,
    }));
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
        order.id === nodeId ? { ...order, status: 'committed' } : order
      ),
      ships: prev.ships.map(ship => ({
        ...ship,
        orders: ship.orders.map(order =>
          order.id === nodeId ? { ...order, status: 'committed' } : order
        ),
      })),
    }));
  }, []);

  const deleteManeuverNode = useCallback((nodeId: string) => {
    setGameStateInternal(prev => ({
      ...prev,
      orders: prev.orders.filter(order => order.id !== nodeId),
      ships: prev.ships.map(ship => ({
        ...ship,
        orders: ship.orders.filter(order => order.id !== nodeId),
      })),
    }));
  }, []);

  const value: GameContextType = {
    gameState,
    camera,
    uiState,
    simSpeed,
    setGameState,
    updateGameState,
    updateTick,
    setSimSpeed,
    loadScenario,
    updateCamera,
    setZoomLevel,
    focusBody,
    selectShip,
    deselectShip,
    selectBody,
    deselectBody,
    hoverBody,
    setManeuverMode,
    setTransferTarget,
    addManeuverNode,
    commitManeuverNode,
    deleteManeuverNode,
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
