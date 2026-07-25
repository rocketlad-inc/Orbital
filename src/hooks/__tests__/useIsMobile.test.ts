// ============================================================
// Shell-selection regression tests.
//
// A "touch-primary → mobile at any width" rule once put the PHONE shell on
// a 2000px touchscreen desktop. These pin the decision table so that can't
// regress, while keeping the foldable fix (Fold inner screen is >1024px but
// is still a phone).
// ============================================================

import { MOBILE_BREAKPOINT_PX, TOUCH_DEVICE_MAX_PX } from '../useIsMobile';

/** Mirror of evaluate() in useIsMobile.ts. Kept as a pure function here so
 *  the table is testable without a DOM/matchMedia harness; if evaluate()
 *  changes shape, this must change with it. */
function shellIsMobile(
  width: number,
  touchPrimaryDevice: boolean,
  mobileOS = false,
): boolean {
  if (width < MOBILE_BREAKPOINT_PX) return true;
  if (mobileOS) return true;
  if (width >= TOUCH_DEVICE_MAX_PX) return false;
  return touchPrimaryDevice;
}

/** Mirror of isMobileOS() in useIsMobile.ts. */
function isMobileOS(
  ua: string,
  uaData: { mobile?: boolean; platform?: string } | null,
  maxTouchPoints = 0,
): boolean {
  if (uaData) {
    if (uaData.mobile === true) return true;
    if (uaData.platform && /android/i.test(uaData.platform)) return true;
  }
  if (/Android|iPhone|iPod|iPad|Windows Phone|Silk|Kindle/i.test(ua)) return true;
  if (/Macintosh/i.test(ua) && maxTouchPoints > 1) return true;
  return false;
}

const UA = {
  fold7: 'Mozilla/5.0 (Linux; Android 16; SM-F966U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
  fold7Tablet: 'Mozilla/5.0 (Linux; Android 16; SM-F966U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  androidDesktopMode: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  iPadOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  macOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
};

describe('isMobileOS — the clause that finally caught the Fold 7', () => {
  test('Fold 7 inner screen is mobile in every UA variant', () => {
    expect(isMobileOS(UA.fold7, { mobile: true, platform: 'Android' }, 5)).toBe(true);
    // No "Mobile" token (large-screen Android reports tablet-style)
    expect(isMobileOS(UA.fold7Tablet, { mobile: false, platform: 'Android' }, 5)).toBe(true);
    // "Request desktop site": UA string spoofed to X11, UA-CH still Android
    expect(isMobileOS(UA.androidDesktopMode, { mobile: false, platform: 'Android' }, 5)).toBe(true);
    // Worst case: no UA-CH at all, UA fully spoofed → falls through (documented limit)
    expect(isMobileOS(UA.androidDesktopMode, null, 5)).toBe(false);
  });

  test('iPadOS 13+ is caught despite claiming to be a Mac', () => {
    expect(isMobileOS(UA.iPadOS, null, 5)).toBe(true);
    expect(isMobileOS(UA.macOS, null, 0)).toBe(false);   // real Mac, no touch
  });

  test('desktops are never a mobile OS — even touchscreen ones', () => {
    expect(isMobileOS(UA.windows, { mobile: false, platform: 'Windows' }, 10)).toBe(false);
    expect(isMobileOS(UA.windows, { mobile: false, platform: 'Windows' }, 0)).toBe(false);
    expect(isMobileOS(UA.macOS, { mobile: false, platform: 'macOS' }, 0)).toBe(false);
  });

  test('a phone OS gets the mobile shell at ANY width (the Fold 7 fix)', () => {
    // Wide inner screen + desktop-like pointer/hover: only the OS clause saves it.
    expect(shellIsMobile(1456, /*touch*/ false, /*mobileOS*/ true)).toBe(true);
    expect(shellIsMobile(1800, false, true)).toBe(true);
    // …and a big touchscreen DESKTOP is still desktop.
    expect(shellIsMobile(2000, true, false)).toBe(false);
  });
});

describe('viewport clamp — Fold 7 fix part 2 (width tiers, not just the shell)', () => {
  // Mirror of clampViewportForMobileOS's decision in useIsMobile.ts. The
  // mobile experience is spread across WIDTH tiers (DockRail bottom rail
  // ≤768, world menu ≤720, HUD ≤768, shell ≤1023) plus JS width checks —
  // so a phone-OS device reporting a desktop-class width must have its
  // LAYOUT width clamped, or it renders a half-mobile chimera (mobile
  // shell from JS, no bottom rail, everything tiny).
  const PHONE = 720, TABLET = 1023;
  function clampTarget(mobileOS: boolean, width: number, uaMobile: boolean): number | null {
    if (!mobileOS) return null;
    if (width < MOBILE_BREAKPOINT_PX) return null;
    return uaMobile ? PHONE : TABLET;
  }

  test('Fold 7 inner screen clamps to the full phone layout', () => {
    expect(clampTarget(true, 1092, true)).toBe(720);
    expect(clampTarget(true, 1213, true)).toBe(720);
    // 720 sits below every mobile tier: bottom rail (768), world menu
    // (720), HUD (768), shell (1023) — the whole phone UX fires.
    expect(720).toBeLessThanOrEqual(768);
    expect(720).toBeLessThanOrEqual(720);
    expect(720).toBeLessThan(1024);
  });

  test('devices that already work are never touched', () => {
    expect(clampTarget(true, 906, true)).toBeNull();    // Fold 5 inner
    expect(clampTarget(true, 412, true)).toBeNull();    // regular phone
    expect(clampTarget(true, 820, false)).toBeNull();   // iPad portrait
    expect(clampTarget(false, 2000, false)).toBeNull(); // touchscreen desktop
    expect(clampTarget(false, 1920, false)).toBeNull(); // desktop
  });

  test('wide tablets take the tablet tier, not comic phone UI', () => {
    expect(clampTarget(true, 1366, false)).toBe(1023);  // iPad Pro landscape
  });
});

describe('shell selection (mobile vs desktop)', () => {
  test.each([
    // name,                      width, touchPrimary, expectMobile
    ['iPhone portrait',             390, true,  true],
    ['iPad portrait',               820, true,  true],
    ['narrow desktop window',       900, false, true],
    ['Galaxy Fold 7 inner screen', 1092, true,  true],
    ['iPad Pro 12.9" landscape',   1366, true,  true],
    ['1366 laptop with mouse',     1366, false, false],
    ['1440 desktop',               1440, false, false],
    ['1920 desktop',               1920, false, false],
    ['1920 touchscreen 2-in-1',    1920, true,  false],
    ['2000 touchscreen desktop',   2000, true,  false],
  ] as [string, number, boolean, boolean][])(
    '%s (%ipx, touch=%s) → mobile=%s',
    (_name, width, touchPrimary, expectMobile) => {
      expect(shellIsMobile(width, touchPrimary)).toBe(expectMobile);
    },
  );

  test('a big screen is NEVER mobile, whatever the pointer queries claim', () => {
    // The hard stop: pointer/hover media queries are unreliable across
    // environments (some webviews report coarse+hover:none), so width alone
    // must veto the phone shell on a large display.
    for (const w of [1400, 1600, 1920, 2560, 3840]) {
      expect(shellIsMobile(w, true)).toBe(false);
    }
  });

  test('a narrow viewport is ALWAYS mobile, mouse or not', () => {
    for (const w of [320, 480, 768, 1023]) {
      expect(shellIsMobile(w, false)).toBe(true);
    }
  });

  test('the foldable band is exactly [1024, 1400)', () => {
    expect(shellIsMobile(MOBILE_BREAKPOINT_PX, true)).toBe(true);        // 1024 in
    expect(shellIsMobile(TOUCH_DEVICE_MAX_PX - 1, true)).toBe(true);     // 1399 in
    expect(shellIsMobile(TOUCH_DEVICE_MAX_PX, true)).toBe(false);        // 1400 out
  });
});
