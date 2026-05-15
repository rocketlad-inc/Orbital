// ============================================================
// VisibilityContext — single source of truth for fog-of-war intel.
// Computed each tick from gameState, carries a rolling lastSeen map
// so both the canvas and the INTEL panel see the same intel.
// ============================================================

import React, { createContext, useContext, useMemo, useRef } from 'react';
import { useGameContext } from './gameContext';
import {
  computeVisibility,
  VisibilityResult,
  GHOST_LIFETIME_TICKS,
} from '../game/visibility';

type GhostIntel = { x: number; y: number; tick: number; shipClass: string; ownedBy: string };

const VisibilityContext = createContext<VisibilityResult | null>(null);

interface VisibilityProviderProps {
  children: React.ReactNode;
}

export const VisibilityProvider: React.FC<VisibilityProviderProps> = ({ children }) => {
  const { gameState } = useGameContext();
  const lastSeenRef = useRef<Map<string, GhostIntel>>(new Map());

  const visibility = useMemo<VisibilityResult>(() => {
    // Viewer = player + any allied factions (from pacts). Pact data lives
    // server-side so for now this is just {'player'}. When pact state is
    // exposed in gameState, swap in alliedFactions('player', pacts).
    const viewerFactions = new Set(['player']);
    const result = computeVisibility(
      viewerFactions,
      gameState.ships,
      gameState.settlements,
      gameState.bodies,
      gameState.currentTick,
      lastSeenRef.current,
    );
    lastSeenRef.current = result.lastSeen;
    return result;
  }, [gameState]);

  return (
    <VisibilityContext.Provider value={visibility}>
      {children}
    </VisibilityContext.Provider>
  );
};

/**
 * Read the current player's fog-of-war intel. Safe to call from any
 * descendant of VisibilityProvider. Returns null if the provider is
 * missing — callers should fall back to "everything visible" in that
 * case (e.g. server-driven multiplayer where fog is server-side).
 */
export function useVisibility(): VisibilityResult | null {
  return useContext(VisibilityContext);
}

export { GHOST_LIFETIME_TICKS };
