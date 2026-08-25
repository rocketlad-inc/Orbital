// ============================================================
// Placement mode — the transient "click the map to put it there" state.
//
// A tiny external store rather than React state, for the same reason
// worldMenu/store.ts is one: the map canvas is not a React tree. It
// reads this synchronously inside a draw frame and inside a click
// handler, and threading a prop down to it would mean re-rendering the
// canvas host on every mouse move.
//
// Deliberately NOT persisted. Placement mode is a thing you are doing
// right now; surviving a reload would leave a player wondering why the
// map is refusing to select anything.
// ============================================================

import type { MegastructureKind } from './megastructures';

export interface PlacementState {
  /** The colony ship that will be spent. */
  shipId: string;
  kind: MegastructureKind;
  /** Which silhouette the player picked in the second step of the
   *  picker. Carried through placement so the click that sites the
   *  framework is the click that fixes its look. */
  variant?: 'A' | 'B' | 'C' | 'D' | 'E';
  /** SOI of the body the ship is parked at, in world units — the ring
   *  drawn to show where placement is legal. The server enforces this
   *  too; drawing it stops the player discovering the rule by being
   *  refused. */
  anchorBodyId: string;
  anchorSoi: number;
}

let state: PlacementState | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function beginPlacement(next: PlacementState): void {
  state = next;
  emit();
}

export function cancelPlacement(): void {
  if (!state) return;
  state = null;
  emit();
}

export function getPlacement(): PlacementState | null {
  return state;
}

export function isPlacing(): boolean {
  return state !== null;
}

/** Subscribe; returns an unsubscribe. Pairs with useSyncExternalStore. */
export function subscribePlacement(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
