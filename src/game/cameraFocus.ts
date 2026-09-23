// ============================================================
// Where the camera goes when focus is RELEASED.
//
// Focus mode pins camera.x/y to (0, 0) and lets the renderer centre on
// the focused body instead. Those stored coordinates are therefore
// meaningless while focused — and world origin is the SUN, so anything
// that clears focusedBodyId without repairing x/y teleports the player
// to Sol from wherever they were looking.
//
// That was a live bug: double-clicking empty space calls
// focusBody(undefined) (MapCanvas handleFocusAt falls through when the
// click hits no body), so a stray double-click anywhere on the map threw
// the camera at the star.
//
// Lives in its own module so it can be tested without standing up the
// whole game context, and so the four call sites that used to hand-roll
// this compensation have one place to agree on.
// ============================================================

import { Body, CameraState } from '../types';
import { bodyPosition } from '../physics/orbitalMechanics';
import { isWorldMenuActive } from './worldMenu/store';

/**
 * Camera patch for dropping focus without moving the view.
 *
 * Returns the x/y the camera should hold once `focusedBodyId` is
 * cleared: the focused body's CURRENT world position, so the release is
 * visually a no-op and the player keeps looking at what they were
 * looking at.
 *
 * Falls back to the stored x/y when there is no focus to release or the
 * focused body has gone (destroyed, or not in this game's body list) —
 * in both cases the stored coordinates are already the truth.
 */
export function releaseFocusPosition(
  camera: Pick<CameraState, 'x' | 'y' | 'focusedBodyId'>,
  bodies: Body[],
  tick: number,
): { x: number; y: number } {
  if (!camera.focusedBodyId) return { x: camera.x, y: camera.y };
  const focused = bodies.find(b => b.id === camera.focusedBodyId);
  if (!focused) return { x: camera.x, y: camera.y };
  const pos = bodyPosition(focused, tick, bodies);
  // In multiplayer the renderer draws a focused camera at body + (x, y)
  // (the world menu frames a planet off-centre with that offset), so the
  // release has to land on the same point or the view jumps. In SP the
  // flag is never set and x/y are pinned to 0 while focused.
  if (isWorldMenuActive()) return { x: pos.x + camera.x, y: pos.y + camera.y };
  return { x: pos.x, y: pos.y };
}
