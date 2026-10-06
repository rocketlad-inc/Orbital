// ============================================================
// Page zoom lock (iOS Safari).
//
// Playtester, phone + Android app: a pinch on any panel zoomed the WHOLE
// app, and it stayed zoomed. Chrome (and so the Android app) is held by
// user-scalable=no in public/index.html plus `touch-action: pan-x pan-y`
// on html/body (App.css). iOS Safari ignores user-scalable=no and turns a
// two-finger pinch into its non-standard gesture* events, so those are
// cancelled here -- on the mobile layout only, so a Mac's trackpad pinch
// in desktop Safari keeps its page zoom.
//
// The map canvas blocks gesture* on itself already (useCanvasTouchInput)
// and runs its own pinch from PointerEvents; this only reaches the rest
// of the page.
// ============================================================

import { isMobileShell } from '../hooks/useIsMobile';

let installed = false;

export function installPageZoomLock(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const block = (e: Event) => {
    if (isMobileShell() && e.cancelable) e.preventDefault();
  };
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, block, { passive: false });
  }
}
