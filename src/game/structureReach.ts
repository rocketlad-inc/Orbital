// ============================================================
// How far a structure reaches, in the numbers the map is drawn in.
//
// Noah, 2026-09-24: "can we get an indicator for how far '700 units'
// is? both the null field and the weapons station reference it, but
// there's no way to tell the actual range that covers". The card says
// 700; on his map (system_scale 4) the server applies 2800, and no
// player can measure either by eye. The ring on the map is the answer,
// so it gets a name, a way to summon it from the card, and a preview
// while the site is being placed.
//
// TWO SCALES, NOT ONE. Vision (Deep Space Array, Null Field) rides the
// full sensor multiplier, system_scale x sensor_scale, as the fog does
// (worker/state.js). Weapon reach (Weapons Station, Gravity Sink) rides
// system_scale only (room.js megaRangeScale). Drawing a gun's ring with
// the sensor product would promise a reach the gun does not have.
// ============================================================

import { MEGASTRUCTURES } from './megastructures';
import type { MegastructureKind } from './megastructures';

export interface ReachScales {
  /** system_scale x sensor_scale (GameState.sensorScale). */
  sensorScale?: number;
  /** system_scale alone (GameState.systemScale). */
  systemScale?: number;
}

/** Catalogue (pre-scale) reach, and whether it is vision or a weapon. */
export function reachSpec(kind: MegastructureKind): { raw: number; vision: boolean } | null {
  const e = (MEGASTRUCTURES[kind]?.effect ?? {}) as Record<string, number | undefined>;
  if ((e.sensorRange ?? 0) > 0) return { raw: e.sensorRange!, vision: true };
  if ((e.blindRange ?? 0) > 0) return { raw: e.blindRange!, vision: true };
  if ((e.range ?? 0) > 0) return { raw: e.range!, vision: false };
  return null;
}

/** World-unit radius the server actually applies, or 0 for none. */
export function reachWorldRadius(kind: MegastructureKind, scales: ReachScales): number {
  const spec = reachSpec(kind);
  if (!spec) return 0;
  const k = spec.vision ? (scales.sensorScale || 1) : (scales.systemScale || 1);
  return spec.raw * k;
}

/** The words on the ring. Says what happens INSIDE it, and repeats the
 *  card's number so the two can be matched up. */
export function reachLabel(kind: MegastructureKind): string {
  const spec = reachSpec(kind);
  if (!spec) return '';
  switch (kind) {
    case 'null_field': return `BLIND ZONE · ${spec.raw}`;
    case 'weapons_station': return `GUN RANGE · ${spec.raw}`;
    case 'gravity_sink': return `HOLD RANGE · ${spec.raw}`;
    case 'deep_array': return `SENSOR RANGE · ${spec.raw}`;
    default: return `REACH · ${spec.raw}`;
  }
}

// ---- pinned rings ------------------------------------------------------
//
// Selection alone shows the ring, but the card that holds the selection
// is usually opened zoomed IN on the structure, where a 2800-unit ring is
// entirely off-screen. SHOW REACH pins it, so it survives the zoom-out
// (and any deselect) until the player turns it off.

const pinned = new Set<string>();
const listeners = new Set<() => void>();

export function isReachPinned(bodyId: string): boolean {
  return pinned.has(bodyId);
}

export function setReachPinned(bodyId: string, on: boolean): void {
  if (on === pinned.has(bodyId)) return;
  if (on) pinned.add(bodyId); else pinned.delete(bodyId);
  for (const fn of listeners) fn();
}

export function subscribeReachPins(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Snapshot for useSyncExternalStore: changes identity when pins change. */
let version = 0;
listeners.add(() => { version += 1; });
export function reachPinsVersion(): number {
  return version;
}
