// ============================================================
// useIsMobile — returns true when the app should serve its
// mobile-first UX (touch controls, bottom sheets, big buttons).
//
// Mobile when EITHER:
//   (a) the viewport is narrower than 1024px, or
//   (b) it's a no-mouse touch device AND narrower than 1400px
//       — the "foldable/tablet band".
//
// Why (b) is written that way, twice-guarded:
//
//  * `(pointer: coarse)` ALONE was the bug that put the phone shell on a
//    2000px desktop. It matches any machine whose primary pointer is
//    touch, and plenty of desktop environments (Windows touchscreens,
//    2-in-1s, some embedded webviews) report coarse even with a mouse
//    attached. Adding `(hover: none)` narrows it to devices with no
//    hover-capable pointer at all — a real phone/tablet/foldable.
//
//  * The 1400px CEILING is the belt to that suspenders: pointer/hover
//    media queries are demonstrably unreliable across environments, so a
//    genuinely large screen must NEVER get the phone shell no matter what
//    those queries claim. Nothing at/above 1400px is mobile, period.
//
// Coverage: Galaxy Fold inner screen (~1092px, no mouse) → mobile ✓.
// iPad Pro 12.9" landscape (1366px) → mobile ✓. 1440p/1080p/4K desktop
// monitors and touchscreen laptops → desktop ✓.
//
// LOCKSTEP: this must match the CSS shell query
//   @media (max-width: 1023px),
//          (pointer: coarse) and (hover: none) and (max-width: 1399px)
// in ALL of these, or you get split-brain layouts:
//   src/styles/mobile.css            (×2)
//   src/components/Outliner.css
//   src/components/OverviewPanel.css
//   src/components/BodyInspector.css (the 768/769 cardinal pair)
// ============================================================

import { useEffect, useState } from 'react';

/** Width threshold below which we switch to mobile layout, regardless of
 *  input device. */
export const MOBILE_BREAKPOINT_PX = 1024;
/** Upper bound for the foldable/tablet band: a no-mouse touch device wider
 *  than 1024 but NARROWER than this still gets the mobile shell (Fold inner
 *  screen ≈1092, iPad Pro landscape 1366). At/above it we always serve
 *  desktop — a hard stop so unreliable pointer media queries can never put
 *  the phone shell on a big monitor. */
export const TOUCH_DEVICE_MAX_PX = 1400;

function evaluate(): boolean {
  if (typeof window === 'undefined') return false;
  // Narrow viewport OR a touch-primary device. Must match the CSS shell
  // query (see the module header) EXACTLY, or you get split-brain layouts
  // where the JS thinks "mobile" and renders a bottom-sheet wrapper while
  // the CSS thinks "desktop" and keeps the floating panel — two copies of
  // the same UI plus a scrim that blocks canvas clicks.
  const w = window.innerWidth;
  if (w < MOBILE_BREAKPOINT_PX) return true;                 // narrow: always mobile
  if (w >= TOUCH_DEVICE_MAX_PX) return false;                // big screen: always desktop
  return isTouchPrimaryDevice();                             // foldable/tablet band
}

/**
 * Hook returning whether the current device/viewport should use the
 * mobile UX. Updates on window resize and on pointer-media changes.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(evaluate);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const recompute = () => setIsMobile(evaluate());

    window.addEventListener('resize', recompute);
    window.addEventListener('orientationchange', recompute);

    // Listen for pointer media changes too — e.g. plugging in a mouse on
    // a tablet should flip the experience.
    let mq: MediaQueryList | null = null;
    let mqHandler: ((e: MediaQueryListEvent) => void) | null = null;
    if (window.matchMedia) {
      mq = window.matchMedia('(pointer: coarse) and (hover: none)');
      mqHandler = () => recompute();
      // Older Safari uses addListener; modern browsers use addEventListener.
      if (mq.addEventListener) mq.addEventListener('change', mqHandler);
      else if ((mq as MediaQueryList & { addListener?: typeof mq.addEventListener }).addListener) {
        (mq as MediaQueryList & { addListener: (cb: () => void) => void }).addListener(mqHandler);
      }
    }

    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('orientationchange', recompute);
      if (mq && mqHandler) {
        if (mq.removeEventListener) mq.removeEventListener('change', mqHandler);
        else if ((mq as MediaQueryList & { removeListener?: typeof mq.removeEventListener }).removeListener) {
          (mq as MediaQueryList & { removeListener: (cb: () => void) => void }).removeListener(mqHandler);
        }
      }
    };
  }, []);

  return isMobile;
}

/** Coarse pointer alone — "touch is available" — for input-only
 *  affordances (larger canvas hit targets, tap hints) where the viewport
 *  width doesn't matter and a touchscreen DESKTOP should still benefit.
 *  NOT used for the shell decision — that's isTouchPrimaryDevice(). */
export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}

/** A real no-mouse touch device (phone / tablet / foldable): coarse
 *  primary pointer AND no hover-capable pointer. This — not
 *  isCoarsePointer — drives the mobile SHELL, so a touchscreen desktop
 *  or 2-in-1 that also has a mouse/trackpad (hover:hover) stays on the
 *  desktop layout. Must match the CSS shell query
 *  `(pointer: coarse) and (hover: none)` exactly. */
export function isTouchPrimaryDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse) and (hover: none)').matches ?? false;
}
