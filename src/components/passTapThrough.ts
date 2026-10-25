// ============================================================
// A TAP THAT CLOSES A DRAWER STILL PRESSES THE BUTTON UNDER IT.
//
// The menu drawer's backdrop covers the whole screen, the dock rail and
// the top bar included (z 4990 against 3200 and 1000). With the drawer
// open, a tap on Research or Trade only closed the drawer, and the panel
// took a second tap (Leo, Rafaela, Maya, 2026-10-24). The backdrop still
// closes the drawer; then, if the tap was on one of those buttons, the
// button gets it too.
// ============================================================

/** Buttons a dismissing tap is passed on to: the dock rail's and the top
 *  bar's, but never the menu button itself (it would reopen the drawer). */
export const PASS_THROUGH_SELECTOR = '.dock-rail button, .top-bar button:not(.top-bar__title)';

/** Find what lies under `backdrop` at the tap point, and press it on the
 *  next frame (after the drawer's own close has run). Returns the button,
 *  or null when the tap was on the open map. */
export function passTapThrough(
  backdrop: HTMLElement,
  x: number,
  y: number,
  selector: string = PASS_THROUGH_SELECTOR,
): HTMLElement | null {
  if (typeof document.elementFromPoint !== 'function') return null;
  const was = backdrop.style.pointerEvents;
  backdrop.style.pointerEvents = 'none';
  let under: Element | null = null;
  try { under = document.elementFromPoint(x, y); } finally { backdrop.style.pointerEvents = was; }
  const btn = under?.closest(selector) as HTMLElement | null;
  if (!btn || (btn as HTMLButtonElement).disabled) return null;
  setTimeout(() => btn.click(), 0);
  return btn;
}
