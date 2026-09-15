// ============================================================
// cameraStore — the map camera as an external store.
//
// The camera used to be React state inside GameContextProvider, in the
// same context value as the whole game state. Every wheel notch and
// every pan mousemove called setState there, the provider re-rendered,
// the value object was rebuilt, and all ~75 consumers of the game
// context re-rendered with it — the fleet panel with 694 hulls, the
// ship panel, the outliner, all of it, sixty times a second while you
// dragged. Telemetry from the Mercury battle (2026-09-15, 130 hulls in
// one orbit): canvas draw 6 ms, React commits 150–300 ms, 36 of them
// in a minute, inputs waiting 1.8 s. "The game does NOT like it when
// you zoom in on that action."
//
// Here the camera lives outside React. Writers call setCamera; the
// three components that read it (MapCanvas, BodyInspector, the world
// menu) subscribe with useCamera and are the only things that render
// when it moves. The game context keeps updateCamera / focusBody as
// the same stable callbacks, so nothing else changes shape.
// ============================================================
import { useSyncExternalStore } from 'react';
import type { CameraState } from '../types';

/** The default view scale. Transit hulls draw full size at and above
 *  it (MapCanvas TRANSIT_FULL_CAM_SCALE) and pending FX play from 0.45,
 *  both keyed to this number. */
export const DEFAULT_CAMERA_SCALE = 0.5;

const initial = (): CameraState => ({ x: 0, y: 0, scale: DEFAULT_CAMERA_SCALE, zoomLevel: 1 });

let camera: CameraState = initial();
const listeners = new Set<() => void>();

/** The camera right now, for code outside React (draw loops, telemetry). */
export function getCamera(): CameraState { return camera; }

export function setCamera(next: CameraState | ((prev: CameraState) => CameraState)): void {
  const v = typeof next === 'function' ? next(camera) : next;
  if (v === camera) return;
  camera = v;
  for (const l of listeners) l();
}

export function subscribeCamera(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** React binding. Re-renders the caller when the camera moves — and
 *  only the caller. */
export function useCamera(): CameraState {
  return useSyncExternalStore(subscribeCamera, getCamera, getCamera);
}

/** A fresh game must not inherit the last one's viewport. The store
 *  outlives React, so the provider resets it on mount — the same moment
 *  the old useState initialiser used to run. */
export function resetCamera(): void {
  setCamera(initial());
}
