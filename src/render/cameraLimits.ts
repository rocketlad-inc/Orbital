// ============================================================
// How far the map camera can pull out. ONE number: the wheel, pinch,
// focus-to-fit, the inspector's zoom and the transit-hull size ramp
// (MapCanvas, matchMap) all clamp or scale against it, and it lived as
// six separate 0.0012 literals until the far systems moved.
//
//   0.005  — Sol-system-only era
//   0.002  — Centauri at 60K landed
//   0.0012 — Centauri at 265K east, Cygnus X at 340K west
//   0.0006 — both DOUBLED (2026-10-06): Centauri 530K, Cygnus 680K. On
//            a 1000px canvas centred on Sol that is ±833K, so both sit
//            inside it with room for their own outer worlds and gates.
// ============================================================

export const MIN_CAMERA_SCALE = 0.0006;

/** Camera scale at and above which a hull in flight draws full size. */
export const TRANSIT_FULL_CAM_SCALE = 0.5;
/** A hull in flight never draws smaller than this share of its size. */
export const TRANSIT_SHIP_MIN_SIZE = 0.5;

/**
 * Size multiplier for a hull in flight at camera scale `camScale`: full
 * size at the default zoom, easing to half at full zoom-out, in LOG space
 * because zoom is multiplicative. Shared by the ships (MapCanvas) and the
 * thing from the Sun (mapRenderer drawEmergingGate), so the squid shrinks
 * on the same curve as the fleets around it.
 */
export function transitHullScale(camScale: number): number {
  const s = Math.max(MIN_CAMERA_SCALE, camScale);
  const t = Math.max(0, Math.min(1,
    Math.log(s / MIN_CAMERA_SCALE) / Math.log(TRANSIT_FULL_CAM_SCALE / MIN_CAMERA_SCALE)));
  return TRANSIT_SHIP_MIN_SIZE + (1 - TRANSIT_SHIP_MIN_SIZE) * t;
}
