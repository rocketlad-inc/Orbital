// ============================================================
// World-menu camera math — MULTIPLAYER ONLY.
//
// The diegetic world menu is not a modal: it is the deepest LOD of the
// one map camera. These pure functions define that continuum:
//
//   z = 0   → the body renders as its normal map dot
//   z = 1   → the body's upper limb fills the lower half of the screen
//             (its centre parked just below the frame), sky above for
//             the station/orbs, and the menu chrome is fully resolved
//
// Everything here is a pure function of (camera.scale, body, viewport)
// so the whole module unit-tests without a DOM. The interactive camera
// (MapCanvas pan/zoom/tween) stays authoritative — the overlay only
// *reads* z from it, and the fly-in only *writes* an ordinary camera
// target through the existing tween.
//
// Constants are the ones locked by the mockup's v2 test suite
// (qa/world-menu-proof: A1–A8). Tests assert against these exports —
// never against literals — so a tuning pass is a one-line change.
// ============================================================

import { Body } from '../../types';

/** Focused body's screen radius at z=1, as a fraction of viewport height.
 *  Spec A5 bounds the acceptable band to [0.42, 0.55]·H. */
export const Z1_FRAC = 0.42; // "a bit smaller" — low edge of the A5 band

/** Where the body's centre sits on screen at z=1 (fractions of W/H).
 *  y > 1 parks the centre below the frame → only the upper limb shows. */
export const S1X_FRAC = 0.5;
export const S1Y_FRAC = 1.02;

/** Menu chrome fade band: opacity ramps 0→1 across z ∈ [start, start+len].
 *  Below the band the menu is absent; above it, fully interactive. */
export const MENU_FADE_START = 0.72;
export const MENU_FADE_LEN = 0.28;

/** Map furniture (orbit rings, labels, halos) fades out on the inverse
 *  band so nothing map-flavored bleeds into the menu sky (spec G9). */
export const FURN_FADE_START = 0.06;
export const FURN_FADE_LEN = 0.28;

/** The scale the map camera considers "seeing the body as a dot".
 *  z is measured from here up to menuScale. Matches focusBody()'s
 *  post-focus scale in gameContext (scale: 2). */
export const FOCUS_BASE_SCALE = 2;

/** Interactive wheel-zoom cap on the main map is 50 (MapCanvas).
 *  Menu framing for small bodies needs more (Earth r=3 → ~130 at
 *  H=780), so MP raises the cap to menuScaleFor(body) while a body
 *  is focused. SP keeps its existing clamp untouched. */
export const MAP_MAX_SCALE = 50;

export const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Camera scale at which `body` reaches menu framing for viewport height H. */
export function menuScaleFor(body: Pick<Body, 'radius'>, viewportH: number): number {
  return (Z1_FRAC * viewportH) / Math.max(0.001, body.radius);
}

/** Continuum position for the current camera scale over a focused body.
 *  Geometric (log-space) interpolation between the focus base scale and
 *  the body's menu scale — matches the mockup's pow() camera (spec A4). */
export function zOf(scale: number, body: Pick<Body, 'radius'>, viewportH: number): number {
  const s1 = menuScaleFor(body, viewportH);
  const s0 = Math.min(FOCUS_BASE_SCALE, s1 * 0.5); // degenerate-safe for huge bodies
  if (scale <= s0) return 0;
  if (scale >= s1) return 1;
  return clamp01(Math.log(scale / s0) / Math.log(s1 / s0));
}

/** Inverse of zOf: the camera scale for a given continuum position. */
export function scaleAt(z: number, body: Pick<Body, 'radius'>, viewportH: number): number {
  const s1 = menuScaleFor(body, viewportH);
  const s0 = Math.min(FOCUS_BASE_SCALE, s1 * 0.5);
  return s0 * Math.pow(s1 / s0, clamp01(z));
}

/** Menu overlay opacity for a continuum position (spec: resolves only at
 *  the very end of the dive). */
export function menuOpacity(z: number): number {
  return clamp01((z - MENU_FADE_START) / MENU_FADE_LEN);
}

/** Map furniture opacity — the exact inverse ramp (spec G9/B8: labels are
 *  fully back before the planet shrinks into its dot; never both at 0). */
export function furnitureOpacity(z: number): number {
  return 1 - clamp01((z - FURN_FADE_START) / FURN_FADE_LEN);
}

/**
 * Camera position target for menu framing of a focused body.
 *
 * MapCanvas renders a focused camera as: screen = center + (world - bodyPos
 * - cam.xy) * scale — i.e. camera x/y are OFFSETS from the tracked body.
 * To park the body's centre at (S1X_FRAC·W, S1Y_FRAC·H) we need:
 *    offset = -(S1 - screenCenter) / scale
 */
export function menuCameraOffset(
  viewportW: number,
  viewportH: number,
  scale: number,
  /** Extra screen-space shift (px) applied to the planet's landing spot.
   *  Lets the desktop overlay push the planet right so it centers in the
   *  content area between the outliner and the dock rail. Defaults to 0
   *  so map/test math (spec A5) stays exact. */
  screenShiftX: number = 0,
): { x: number; y: number } {
  const dx = (S1X_FRAC - 0.5) * viewportW + screenShiftX;
  const dy = (S1Y_FRAC - 0.5) * viewportH;
  return { x: -dx / scale, y: -dy / scale };
}

/** Screen-space circle of the focused body under a focused camera
 *  (body-relative offsets). Used by the overlay to place orbs/lines and
 *  by tests to assert the A5 framing bounds. */
export function focusedBodyScreenCircle(
  body: Pick<Body, 'radius'>,
  camOffset: { x: number; y: number },
  scale: number,
  viewportW: number,
  viewportH: number,
): { x: number; y: number; r: number } {
  return {
    x: viewportW / 2 - camOffset.x * scale,
    y: viewportH / 2 - camOffset.y * scale,
    r: body.radius * scale,
  };
}
