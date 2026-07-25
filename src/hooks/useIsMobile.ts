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
// Plus an OS clause (see isMobileOS): Android/iOS/iPadOS is a phone or
// tablet at ANY width. That's what finally fixed the Fold 7 — its inner
// screen is wider than the Fold 5's (<1024, already covered by width alone)
// AND its browser doesn't report `hover: none`, so no viewport+pointer
// combination could tell it apart from a big touchscreen desktop.
//
// LOCKSTEP: the CSS shell selector must match this decision exactly, or you
// get split-brain layouts (bottom-sheet wrapper AND floating panel = two
// copies of the UI plus a scrim that eats canvas clicks). Because the OS
// clause has NO media-query equivalent, the JS stamps its verdict onto
// <html data-mobile-shell> and every shell block ORs that in:
//
//   @media (max-width: 1023px),
//          (pointer: coarse) and (hover: none) and (max-width: 1399px) { … }
//   :root[data-mobile-shell] … { … }   /* same rules, JS-driven */
//
// Sites that must stay in lockstep:
//   src/styles/mobile.css            (×3)
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

/**
 * Is this a phone/tablet OPERATING SYSTEM? The decisive signal for
 * foldables.
 *
 * Field evidence: a Fold 5's inner screen reports <1024 CSS px, so the
 * plain width rule already caught it — but a Fold 7's inner screen reports
 * WIDER, and its browser did not satisfy `(pointer: coarse) and
 * (hover: none)` either (Chrome on some Android builds, and anything in
 * "Request desktop site" mode, advertises desktop-like pointer/hover). No
 * combination of viewport + pointer media queries can separate that device
 * from a large touchscreen desktop, because the two genuinely overlap.
 *
 * The OS does separate them, cleanly: Android/iOS/iPadOS is a phone or
 * tablet, full stop; Windows/macOS/Linux is not. This is the narrow case
 * where platform detection beats feature detection — we're asking "what
 * class of device is this", not "what can this browser do".
 *
 * Prefers UA-Client-Hints (`navigator.userAgentData`) and falls back to the
 * UA string. Also catches iPadOS 13+, which lies and claims "MacIntel".
 */
export function isMobileOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & {
    userAgentData?: { mobile?: boolean; platform?: string };
    maxTouchPoints?: number;
  };

  // UA-CH: authoritative when present (Chromium). `mobile` is the phone
  // form-factor bit; `platform` still reads "Android" on a tablet/foldable
  // where `mobile` can be false.
  const uaData = nav.userAgentData;
  if (uaData) {
    if (uaData.mobile === true) return true;
    if (uaData.platform && /android/i.test(uaData.platform)) return true;
  }

  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPod|iPad|Windows Phone|Silk|Kindle/i.test(ua)) return true;
  // iPadOS 13+ reports a desktop Safari UA ("Macintosh; Intel Mac OS X")
  // and is only distinguishable by having real touch points.
  if (/Macintosh/i.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return true;
  return false;
}

function evaluate(): boolean {
  if (typeof window === 'undefined') return false;
  // Must match the CSS shell query (see the module header), or you get
  // split-brain layouts where the JS thinks "mobile" and renders a
  // bottom-sheet wrapper while the CSS thinks "desktop" and keeps the
  // floating panel — two copies of the same UI plus a scrim that blocks
  // canvas clicks. The OS clause has no CSS equivalent, so it is mirrored
  // by a `data-mobile-shell` attribute on <html> that the CSS also keys on
  // (see applyShellAttribute below).
  const w = window.innerWidth;
  if (w < MOBILE_BREAKPOINT_PX) return true;   // narrow: always mobile
  if (isMobileOS()) return true;               // phone/tablet OS: mobile at ANY width
  if (w >= TOUCH_DEVICE_MAX_PX) return false;  // big desktop screen: always desktop
  return isTouchPrimaryDevice();               // other touch devices, 1024–1399
}

/**
 * Publish the shell decision to the DOM as `<html data-mobile-shell>`.
 *
 * The OS clause above can't be expressed as a media query, so the CSS can't
 * derive it independently — and JS/CSS disagreeing is exactly what produces
 * a doubled UI. So the JS decides, stamps the result here, and every shell
 * stylesheet ORs in `:root[data-mobile-shell] &`. Set as early as possible
 * (module load) so the first paint is already correct.
 */
export function applyShellAttribute(): void {
  if (typeof document === 'undefined') return;
  const mobile = evaluate();
  const root = document.documentElement;
  if (mobile) root.setAttribute('data-mobile-shell', '');
  else root.removeAttribute('data-mobile-shell');
}

// Stamp immediately on import, then keep it in sync on resize/rotate.
if (typeof window !== 'undefined') {
  applyShellAttribute();
  window.addEventListener('resize', applyShellAttribute);
  window.addEventListener('orientationchange', applyShellAttribute);
}

/** Diagnostic dump — readable on-device via `window.__orbitalShell` (or the
 *  ?shellinfo overlay) so a mis-detected device can be diagnosed from real
 *  numbers instead of guesswork. */
export function shellDiagnostics(): Record<string, unknown> {
  const nav = navigator as Navigator & {
    userAgentData?: { mobile?: boolean; platform?: string };
    maxTouchPoints?: number;
  };
  return {
    decision: evaluate() ? 'MOBILE' : 'DESKTOP',
    innerWidth: typeof window !== 'undefined' ? window.innerWidth : null,
    innerHeight: typeof window !== 'undefined' ? window.innerHeight : null,
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : null,
    screen: typeof window !== 'undefined' && window.screen
      ? `${window.screen.width}x${window.screen.height}` : null,
    pointerCoarse: isCoarsePointer(),
    hoverNone: window.matchMedia?.('(hover: none)').matches ?? null,
    touchPrimaryDevice: isTouchPrimaryDevice(),
    isMobileOS: isMobileOS(),
    maxTouchPoints: nav.maxTouchPoints ?? null,
    uaDataMobile: nav.userAgentData?.mobile ?? null,
    uaDataPlatform: nav.userAgentData?.platform ?? null,
    userAgent: navigator.userAgent,
    MOBILE_BREAKPOINT_PX,
    TOUCH_DEVICE_MAX_PX,
  };
}
if (typeof window !== 'undefined') {
  (window as unknown as { __orbitalShell: () => Record<string, unknown> }).__orbitalShell =
    shellDiagnostics;
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
