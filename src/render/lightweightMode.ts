// ============================================================
// Lightweight mode — the "my phone cannot draw this" escape hatch
// ============================================================
//
// StealthyMoose's iPhone 15 could not hold a frame rate on a busy map,
// worst of all zoomed out where nothing is culled. Rather than guess at
// which effect is guilty, this turns off ALL of the decorative work at
// once — textures, animation, particles, CSS compositing — and drops the
// frame cap. If the phone recovers, the cost is in here somewhere and we
// can bisect from a known-good baseline. If it does not, the cost is in
// the geometry itself and no amount of prettiness-trimming will save it.
//
// Deliberately a CLIENT setting, not a game rule: it changes only what
// this browser draws. Two players in the same match can disagree about it
// and the simulation is identical, so nothing here touches the worker.
//
// Read via a module-level boolean rather than threaded through
// RenderContext. The draw path reads it thousands of times a frame and it
// is one user setting, not per-body state; a property lookup is free and
// it keeps the change out of every call signature.

const KEY = 'orbital:lightweight';

let enabled = false;
try {
  // ?lightweight=1 flips it on and sticks, so a tester on a phone with no
  // console can turn it on from a link and reload freely.
  const q = new URLSearchParams(window.location.search).get('lightweight');
  if (q === '1') localStorage.setItem(KEY, '1');
  if (q === '0') localStorage.removeItem(KEY);
  enabled = localStorage.getItem(KEY) === '1';
} catch { /* private mode — stay off */ }

const listeners = new Set<(on: boolean) => void>();

/** Hot path. Called per body and per effect, so it stays a bare read. */
export function isLightweight(): boolean {
  return enabled;
}

export function setLightweight(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch { /* private mode — session-only is fine */ }
  applyBodyClass();
  for (const fn of listeners) fn(on);
}

export function subscribeLightweight(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Frame budget. Phones already cap at 30fps; lightweight halves that
 * again.
 *
 * NOT zero — the map cannot stop redrawing. Bodies orbit continuously and
 * ships interpolate between ticks, so a fully on-demand renderer would
 * freeze the system between polls. 15fps is choppy and completely
 * playable, and it is half the total frame cost before a single effect is
 * removed.
 */
export const LIGHTWEIGHT_MIN_FRAME_MS = 1000 / 15;

/**
 * The CSS half, and on iOS possibly the bigger half. `backdrop-filter` on
 * a fixed full-width bar (.top-bar has one) makes the compositor re-blur
 * a strip of the page every time anything beneath it moves — which, on a
 * map that animates, is every frame. Shadows, filters and transitions are
 * cheaper but not free. None of it is load-bearing for reading the game.
 */
function applyBodyClass(): void {
  try {
    document.body.classList.toggle('lightweight', enabled);
  } catch { /* SSR/tests — no document */ }
}

// Stamp it before first paint so a reload in lightweight mode never
// flashes the expensive treatment.
applyBodyClass();
