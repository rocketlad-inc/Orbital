// ============================================================
// useIsMobile — returns true when the app should serve its
// mobile-first UX (touch controls, bottom sheets, big buttons).
//
// The user direction is "when in doubt, go mobile", so the
// breakpoint is set generously: anything narrower than 1024px
// OR any touch-primary (coarse-pointer) device gets the mobile
// shell, at any width. iPad → mobile in both orientations. A
// Galaxy Fold's inner screen (~8", CSS width >1024) → mobile.
// A touchscreen laptop with a trackpad reports pointer:fine →
// stays desktop.
//
// LOCKSTEP: this must match the CSS shell query
//   @media (max-width: 1023px), (pointer: coarse)
// in ALL of these, or you get split-brain layouts:
//   src/styles/mobile.css            (×2)
//   src/components/Outliner.css
//   src/components/OverviewPanel.css
//   src/components/BodyInspector.css (the 768/769 cardinal pair)
// ============================================================

import { useEffect, useState } from 'react';

/** Width threshold below which we switch to mobile layout. */
export const MOBILE_BREAKPOINT_PX = 1024;

function evaluate(): boolean {
  if (typeof window === 'undefined') return false;
  // Narrow viewport OR a touch-primary device. Must match the CSS shell
  // query `@media (max-width: 1023px), (pointer: coarse)` EXACTLY (see the
  // list in the module header), or you get split-brain layouts where the JS
  // thinks "mobile" and renders a bottom-sheet wrapper while the CSS thinks
  // "desktop" and keeps the floating panel — two copies of the same UI plus
  // a scrim that blocks canvas clicks.
  //
  // The pointer clause exists for FOLDABLES: a Galaxy Fold's inner screen is
  // ~8" and nearly square, so it reports a CSS width ABOVE 1024 and used to
  // get the full desktop shell on a phone. `pointer: coarse` means the
  // PRIMARY input is touch, so a touchscreen laptop with a trackpad still
  // reports `fine` and correctly stays on desktop; a tablet or foldable with
  // no mouse gets the mobile UX at any width.
  return window.innerWidth < MOBILE_BREAKPOINT_PX || isCoarsePointer();
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
      mq = window.matchMedia('(pointer: coarse)');
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

/** Quick check for coarse pointer alone — useful for input-only adjustments
 *  (e.g. larger hit targets) where the viewport width doesn't matter. */
export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}
