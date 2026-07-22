// ============================================================
// World-menu activation store — the SP-safety gate.
//
// The world menu is MULTIPLAYER ONLY. Rather than threading an
// isMultiplayer prop through MapCanvas/mapRenderer (shared files),
// the MP-only WorldMenuOverlay component flips this flag on mount
// and clears it on unmount. Single-player never mounts the overlay,
// so every world-menu branch in shared code is dead in SP — the
// render/interaction paths there execute exactly as before.
// ============================================================

let active = false;

export function setWorldMenuActive(v: boolean): void {
  active = v;
}

/** True only while the MP WorldMenuOverlay is mounted AND the user
 *  hasn't flipped the legacy-inspector toggle. */
export function isWorldMenuActive(): boolean {
  return active;
}

// Which body's world menu is currently OPEN (post-fly-in), or null when
// no menu is open. Distinct from `active` (the overlay is *mounted* for
// the whole MP session, so `active` is true even at zoomed-out map
// view). Renderers use this to hide the canvas city/station art on the
// focused body while the diegetic menu covers it — without killing the
// same art at map zoom.
let openBodyId: string | null = null;
export function setWorldMenuOpenBodyId(id: string | null): void {
  openBodyId = id;
}
export function getWorldMenuOpenBodyId(): string | null {
  return openBodyId;
}

// --- interactive zoom cap -------------------------------------------
// The map's wheel/pinch clamp is 50. Diving into a body's menu needs
// more (menuScaleFor), so MapCanvas publishes the currently-allowed cap
// here each render (it knows the focused body + viewport); the wheel
// handler and the touch hook both read it. Defaults to — and in SP
// permanently stays — the historical 50.
const MAP_MAX_INTERACTIVE_SCALE = 50;
let maxInteractiveScale = MAP_MAX_INTERACTIVE_SCALE;

export function setWorldMenuMaxScale(v: number | null): void {
  maxInteractiveScale = v ?? MAP_MAX_INTERACTIVE_SCALE;
}

export function getWorldMenuMaxScale(): number {
  return active ? maxInteractiveScale : MAP_MAX_INTERACTIVE_SCALE;
}
