// ============================================================
// useIsMobile — returns true when the app should serve its
// mobile-first UX (touch controls, bottom sheets, big buttons).
//
// The user direction is "when in doubt, go mobile", so the
// breakpoint is set generously: anything narrower than 1024px
// OR any coarse-pointer device gets the mobile shell. iPad in
// portrait (834w) → mobile. iPad in landscape (1194w) → desktop.
// ============================================================

import { useEffect, useState } from 'react';

/** Width threshold below which we switch to mobile layout. */
export const MOBILE_BREAKPOINT_PX = 1024;

function evaluate(): boolean {
  if (typeof window === 'undefined') return false;
  // Coarse pointer = primary input is touch or stylus → always mobile.
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  // Narrow viewport → mobile even on a desktop browser shrunk down.
  const narrow = window.innerWidth < MOBILE_BREAKPOINT_PX;
  return coarse || narrow;
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
