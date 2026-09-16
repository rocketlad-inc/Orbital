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
// TWO PROVIDERS CAN BE MOUNTED AT ONCE — App.tsx and
// MultiplayerGameProvider each render a GameContextProvider. Writes go
// to whichever CameraProvider mounted LAST (the live game's, in
// practice), and the mirror that getCamera() reads is maintained only
// by that owner: the first cut let every provider's render overwrite
// it, so an idle provider re-rendering on a state poll reset the
// recorded zoom to 0.5 on every heartbeat (Noah's 15 rows on 1cb880e2
// all read 0.5 while he was visibly zoomed into Styx).
// ============================================================
import React, { createContext, useContext, useLayoutEffect, useState } from 'react';
import type { CameraState } from '../types';

/** The default view scale. Transit hulls draw full size at and above
 *  it (MapCanvas TRANSIT_FULL_CAM_SCALE) and pending FX play from 0.45,
 *  both keyed to this number. */
export const DEFAULT_CAMERA_SCALE = 0.5;

const initial = (): CameraState => ({ x: 0, y: 0, scale: DEFAULT_CAMERA_SCALE, zoomLevel: 1 });

type Updater = CameraState | ((prev: CameraState) => CameraState);
type Setter = (u: Updater) => void;

// Owner stack: last mounted provider owns writes and the mirror; when
// it unmounts, ownership falls back to the one beneath it.
const owners: Setter[] = [];
let latest: CameraState = initial();
let pendingBeforeMount: Updater[] = [];

const CameraContext = createContext<CameraState>(latest);

/** The camera as of the owning provider's last commit — for telemetry
 *  and anything else outside React. */
export function getCamera(): CameraState { return latest; }

export function setCamera(next: Updater): void {
  const owner = owners[owners.length - 1];
  if (owner) { owner(next); return; }
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
    // Anything written before a provider existed (an early focusBody)
    // folds into the starting value rather than being lost.
    let c = initial();
    for (const u of pendingBeforeMount) c = typeof u === 'function' ? u(c) : u;
    pendingBeforeMount = [];
    return c;
  });
  useLayoutEffect(() => {
    owners.push(setState);
    latest = camera;
    return () => {
      const i = owners.lastIndexOf(setState);
      if (i >= 0) owners.splice(i, 1);
    };
    // Mount/unmount only; the mirror is kept current by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => {
    // Only the OWNER maintains the mirror. A second, idle provider
    // re-rendering must not overwrite the live camera with its default.
    if (owners[owners.length - 1] === setState) latest = camera;
  }, [camera]);
  return React.createElement(CameraContext.Provider, { value: camera }, children);
}
