// ============================================================
// useAutosave — write the live GameState to the rolling AUTOSAVE
// slot every N ticks of game time. SP only.
//
// Why tick-based rather than wall-clock-based? Realtime tick rates
// vary wildly with simSpeed (1× → 100,000×), and wall-clock would
// either fire too often at high speed (autosaving every few sim-hours)
// or too rarely at low (one autosave per session). Anchoring to
// game-time means autosave cadence is invariant to how fast the
// player is fast-forwarding — every N game-ticks regardless.
//
// The save fires on the LEADING edge of crossing a multiple of N
// (e.g. tick 100, 200, 300 if N=100), so a player who skips by +1000
// gets one autosave for the leap rather than 10.
// ============================================================

import { useEffect, useRef } from 'react';
import { GameState } from '../types';
import { writeSave, AUTOSAVE_ID } from './saveGame';

/** How many in-game ticks between autosaves. 100 ticks ≈ ~12.5 game-hours
 *  at the default tick cadence; long enough to be a meaningful recovery
 *  point, short enough that a crash doesn't lose a whole session. */
const AUTOSAVE_INTERVAL_TICKS = 100;

/**
 * Subscribe an autosave loop to the live game state. Pass `enabled=false`
 * (or omit the gameState) to disable — typically the MP path sets enabled
 * to false since the server is authoritative there.
 *
 * @param gameState  the live GameState from useGameContext
 * @param enabled    when false, the hook is a no-op (still safe to call)
 */
export function useAutosave(gameState: GameState | null | undefined, enabled = true): void {
  // Track the last tick we wrote at so a +1000 fast-forward doesn't fire
  // multiple autosaves for the same window. Initialized lazily on the
  // first render where gameState is known.
  const lastSavedTickRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !gameState) return;
    const tick = Math.floor(gameState.currentTick);

    if (lastSavedTickRef.current === null) {
      // First observation — anchor without writing so a freshly-mounted
      // game doesn't immediately autosave a 0-tick snapshot.
      lastSavedTickRef.current = tick;
      return;
    }

    // Cross a multiple of AUTOSAVE_INTERVAL_TICKS since the last write?
    const lastWindow = Math.floor(lastSavedTickRef.current / AUTOSAVE_INTERVAL_TICKS);
    const thisWindow = Math.floor(tick / AUTOSAVE_INTERVAL_TICKS);
    if (thisWindow <= lastWindow) return;

    // Write the autosave. writeSave returns null on quota failure; we
    // intentionally don't surface that here — the worst case is one
    // missed autosave, and the player can still save manually.
    const meta = writeSave(gameState, `Autosave (T+${tick})`, AUTOSAVE_ID, true);
    if (meta) {
      lastSavedTickRef.current = tick;
    }
  }, [enabled, gameState]);
}
