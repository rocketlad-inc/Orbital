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
function shellIsMobile(width: number, touchPrimaryDevice: boolean): boolean {
  if (width < MOBILE_BREAKPOINT_PX) return true;
  if (width >= TOUCH_DEVICE_MAX_PX) return false;
  return touchPrimaryDevice;
}

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
