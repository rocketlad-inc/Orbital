// ============================================================
// Game State Context - React Context for global game state
// ============================================================

import React, { createContext, useContext, useState, useCallback } from 'react';
import { GameState, ManeuverNode, CameraState, MapUIState } from '../types';
import { getScenario, ScenarioType } from './mockGameState';

interface GameContextType {
  gameState: GameState;
  camera: CameraState;
  uiState: MapUIState;

  // Game state updates
  setGameState: (state: GameState) => void;
  updateGameState: (partial: Partial<GameState>) => void;
  updateTick: (tick: number) => void;
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
    setGameState,
    updateGameState,
    updateTick,
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
