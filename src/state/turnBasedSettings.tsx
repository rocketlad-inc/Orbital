// ============================================================
// Turn-Based Mode settings (experimental)
//
// An opt-in alternate flow where the realtime sim loop is suppressed and
// time only advances when the player explicitly clicks "COMMIT TURN".
// Each commit jumps the simulation forward `ticksPerTurn` ticks in one
// reducer call (no per-frame interpolation), then pauses again.
//
// Scope: single-player only for this prototype. Multiplayer would need
// server-side turn collection (alarm waits until every faction has
// submitted, see worker/room.js) which isn't built. When the active
// game is externally controlled (MP) the setting is read-only and the
// realtime suppression is a no-op — the server is still authoritative.
//
// Persistence: stored in localStorage under TBM_STORAGE_KEY so the
// player's preference survives a refresh, but the per-game effect only
// kicks in once GameContext checks the flag at sim-loop time.
// ============================================================

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

const TBM_STORAGE_KEY = 'orbital.turnBased.v1';

/** All knobs that make up a turn-based-mode config. New knobs should be
 *  added here, defaulted in DEFAULT_SETTINGS, and surfaced on TunablesPage. */
export interface TurnBasedSettings {
  /** Master switch. When false the game runs in normal realtime mode and
   *  every other setting in this object is ignored. */
  enabled: boolean;
  /** How many ticks each "Commit Turn" press advances. The current
   *  realtime cadence puts ~7.5 real minutes per tick at 1×, so 20
   *  ticks ≈ 2.5 game-hours per turn — long enough for transfers to
   *  start firing but short enough that the player still gets the
   *  per-turn pulse feel. */
  ticksPerTurn: number;
}

export const DEFAULT_TURN_BASED_SETTINGS: TurnBasedSettings = {
  enabled: false,
  ticksPerTurn: 20,
};

interface TurnBasedSettingsContext extends TurnBasedSettings {
  setEnabled: (enabled: boolean) => void;
  setTicksPerTurn: (n: number) => void;
}

const Ctx = createContext<TurnBasedSettingsContext | null>(null);

function loadSettings(): TurnBasedSettings {
  try {
    const raw = localStorage.getItem(TBM_STORAGE_KEY);
    if (!raw) return DEFAULT_TURN_BASED_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<TurnBasedSettings>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_TURN_BASED_SETTINGS.enabled,
      ticksPerTurn: typeof parsed.ticksPerTurn === 'number' && parsed.ticksPerTurn > 0
        ? Math.min(500, Math.max(1, Math.floor(parsed.ticksPerTurn)))
        : DEFAULT_TURN_BASED_SETTINGS.ticksPerTurn,
    };
  } catch {
    return DEFAULT_TURN_BASED_SETTINGS;
  }
}

function persist(settings: TurnBasedSettings) {
  try {
    localStorage.setItem(TBM_STORAGE_KEY, JSON.stringify(settings));
  } catch { /* ignore — quota or private mode */ }
}

export function TurnBasedSettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<TurnBasedSettings>(loadSettings);

  // Persist on every change so a refresh keeps the player in turn-based
  // mode (or out of it) without re-toggling.
  useEffect(() => {
    persist(settings);
  }, [settings]);

  // Cross-tab sync: if the player toggles in another tab (or the
  // Tunables page in a side window), pick that up here so the in-game
  // sim loop reacts immediately.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== TBM_STORAGE_KEY) return;
      setSettings(loadSettings());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setEnabled = useCallback((enabled: boolean) => {
    setSettings(prev => ({ ...prev, enabled }));
  }, []);

  const setTicksPerTurn = useCallback((n: number) => {
    const clamped = Math.min(500, Math.max(1, Math.floor(n)));
    setSettings(prev => ({ ...prev, ticksPerTurn: clamped }));
  }, []);

  return (
    <Ctx.Provider value={{ ...settings, setEnabled, setTicksPerTurn }}>
      {children}
    </Ctx.Provider>
  );
}

/** Returns the live turn-based settings. Safe to call outside the
 *  provider — returns the defaults + no-op setters so callers don't
 *  have to guard. (We still warn in dev because using it without the
 *  provider means changes won't persist.) */
export function useTurnBasedSettings(): TurnBasedSettingsContext {
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.warn('[TurnBasedSettings] useTurnBasedSettings called outside provider — returning defaults.');
  }
  return {
    ...DEFAULT_TURN_BASED_SETTINGS,
    setEnabled: () => undefined,
    setTicksPerTurn: () => undefined,
  };
}

/** Imperative read for code paths that can't use a hook (e.g. one-shot
 *  reads inside a callback that doesn't re-render). Always falls back
 *  to localStorage so it stays in sync with the provider. */
export function readTurnBasedSettings(): TurnBasedSettings {
  return loadSettings();
}
