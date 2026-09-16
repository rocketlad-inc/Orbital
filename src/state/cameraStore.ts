// ============================================================
// cameraStore — the map camera in its OWN React context.
//
// Why it is not in the game context: the camera used to be state inside
// GameContextProvider, in the same context value as the whole game
// state, and that value is a fresh object every render. Every wheel
// notch and every pan mousemove re-rendered the provider and all ~75
// consumers with it — the fleet panel with 694 hulls, the ship panel,
// the outliner — sixty times a second while you dragged. Telemetry
// from the Mercury battle (2026-09-15): canvas draw 6 ms, React
// commits 150–300 ms, inputs waiting 1.8 s.
//
// Why it is not an external store: the first cut used
// useSyncExternalStore, and within hours two players were hitting
// React #185 ("Maximum update depth exceeded") on exactly the actions
// that move the camera — scrolling the map, clicking Mercury in the
// outliner, hopping between planet views, opening the fleet menu. A
// store notifies synchronously and forces sync re-renders; with a 2 s
// commit in a 700-ship game that is a loop React refuses to run. Plain
// batched React state cannot do that.
//
// So: a CameraProvider holding useState, rendered by GameContextProvider
// AROUND its own Provider. When the camera changes, CameraProvider
// re-renders; the GameContext.Provider element it wraps is the same
// element it was handed last time, so React bails out of that whole
// subtree and only useCamera() subscribers render. When the GAME state
// changes, the camera value is the same object, so camera readers are
// not told anything new either.
//
// The imperative surface (setCamera / getCamera) exists so the game
// context's updateCamera / focusBody can stay the stable callbacks
// they were, and so telemetry can read the zoom without a hook.
// ============================================================
import React, { createContext, useContext, useLayoutEffect, useState } from 'react';
import type { CameraState } from '../types';

/** The default view scale. Transit hulls draw full size at and above
 *  it (MapCanvas TRANSIT_FULL_CAM_SCALE) and pending FX play from 0.45,
 *  both keyed to this number. */
export const DEFAULT_CAMERA_SCALE = 0.5;

const initial = (): CameraState => ({ x: 0, y: 0, scale: DEFAULT_CAMERA_SCALE, zoomLevel: 1 });

type Updater = CameraState | ((prev: CameraState) => CameraState);

// The mounted provider's setState, and a mirror of its latest value for
// non-hook readers. Null until a provider mounts; writes before then
// are applied to the initial value the next provider starts from.
let setter: ((u: Updater) => void) | null = null;
let latest: CameraState = initial();
let pendingBeforeMount: Updater[] = [];

const CameraContext = createContext<CameraState>(latest);

/** The camera as of the last render — for draw loops and telemetry. */
export function getCamera(): CameraState { return latest; }

export function setCamera(next: Updater): void {
  if (setter) { setter(next); return; }
  pendingBeforeMount.push(next);
}

/** React binding. Re-renders the caller when the camera changes — and
 *  only the caller. */
export function useCamera(): CameraState {
  return useContext(CameraContext);
}

/** Wrap the game provider's children in this. A fresh mount is a fresh
 *  viewport, the same way the old useState initialiser behaved. */
export function CameraProvider({ children }: { children: React.ReactNode }) {
  const [camera, setState] = useState<CameraState>(() => {
    // Anything written before mount (an early focusBody) folds into the
    // starting value rather than being lost.
    let c = initial();
    for (const u of pendingBeforeMount) c = typeof u === 'function' ? u(c) : u;
    pendingBeforeMount = [];
    return c;
  });
  latest = camera;
  useLayoutEffect(() => {
    setter = setState;
    return () => { if (setter === setState) setter = null; };
  }, []);
  return React.createElement(CameraContext.Provider, { value: camera }, children);
}
