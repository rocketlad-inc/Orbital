// ============================================================
// Map layers — toggleable visual overlays.
//
// Players asked for a way to see at-a-glance: where everyone's ships
// are going, which enemy ships are heading their way, what their
// sensor coverage looks like, and who owns each body. Rather than
// piling more keyboard shortcuts on the canvas (the V-key sensor
// toggle existed but was invisible), this context centralizes a Set
// of enabled layer ids that the LayersPanel mutates and MapCanvas
// reads to decide which extra draws to dispatch.
//
// Preferences are persisted to localStorage so a player's loadout
// (e.g. "always show ownership and sensors") survives a refresh.
// Cross-tab sync via the storage event mirrors the TBM settings.
// ============================================================

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

// v2: bumped when the LayersPanel button was removed and all overlays
// default to ON. Old v1 entries (where players had turned layers off)
// would otherwise persist forever with no UI to flip them back on.
const STORAGE_KEY = 'orbital.mapLayers.v2';

export type LayerId =
  | 'transfers'        // all in-flight ship transfer arcs (player + visible enemy)
  | 'enemyTrajectories' // highlight known incoming hostile ships
  | 'ownership';       // faction-colored ring around each owned body
  // NOTE: 'sensors' was removed when sensor coverage became an
  // always-on fog-of-war dimming overlay (drawn unconditionally by
  // MapCanvas). The explicit ring overlay was redundant once the
  // boundary between dimmed and bright became visible everywhere.

/** Display-time metadata for the LayersPanel UI. Keeps the toggle
 *  labels + descriptions next to the IDs so adding a new layer is
 *  one edit, not three. */
export interface LayerMeta {
  id: LayerId;
  label: string;
  description: string;
  /** Optional default — layers default off unless overridden here. */
  defaultOn?: boolean;
}

export const LAYER_META: readonly LayerMeta[] = [
  {
    id: 'transfers',
    label: 'Ship transfers',
    description: 'Show the torch trajectory of every ship currently in transit.',
    defaultOn: true,
  },
  {
    id: 'enemyTrajectories',
    label: 'Incoming threats',
    description: 'Highlight visible enemy ships whose transfer ends at one of your bodies.',
    defaultOn: true,
  },
  {
    id: 'ownership',
    label: 'Body ownership',
    description: 'Colored ring around each body indicating which faction controls it.',
    defaultOn: true,
  },
];

// The LayersPanel button was removed in favor of "everything on by default."
// The toggle context still exists so the renderer keeps its conditional draw
// gates intact AND old localStorage entries (where players turned a layer off
// before the panel was removed) continue to be honored. If you want to bring
// the UI back later, restore App.tsx's <LayersPanel /> mount.

interface LayersContextValue {
  enabled: Set<LayerId>;
  isOn: (id: LayerId) => boolean;
  toggle: (id: LayerId) => void;
  setEnabled: (id: LayerId, on: boolean) => void;
}

const Ctx = createContext<LayersContextValue | null>(null);

function defaultEnabled(): Set<LayerId> {
  return new Set(LAYER_META.filter(m => m.defaultOn).map(m => m.id));
}

function load(): Set<LayerId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultEnabled();
    const parsed = JSON.parse(raw) as string[];
    const valid: LayerId[] = parsed.filter(
      (s): s is LayerId => LAYER_META.some(m => m.id === s),
    );
    return new Set(valid);
  } catch {
    return defaultEnabled();
  }
}

function persist(enabled: Set<LayerId>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(enabled)));
  } catch { /* quota / private mode — silently drop */ }
}

export function MapLayersProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabledState] = useState<Set<LayerId>>(load);

  useEffect(() => { persist(enabled); }, [enabled]);

  // Cross-tab sync — if the player toggles layers in another tab (or
  // a side window like the Tunables page), reflect it here.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setEnabledState(load());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const isOn = useCallback((id: LayerId) => enabled.has(id), [enabled]);

  const toggle = useCallback((id: LayerId) => {
    setEnabledState(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const setEnabled = useCallback((id: LayerId, on: boolean) => {
    setEnabledState(prev => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  return (
    <Ctx.Provider value={{ enabled, isOn, toggle, setEnabled }}>
      {children}
    </Ctx.Provider>
  );
}

export function useMapLayers(): LayersContextValue {
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.warn('[mapLayers] useMapLayers called outside provider — returning defaults');
  }
  const fallback = defaultEnabled();
  return {
    enabled: fallback,
    isOn: (id) => fallback.has(id),
    toggle: () => undefined,
    setEnabled: () => undefined,
  };
}
