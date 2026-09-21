// Lorne: "We already detect if it's a layout or not. JUST MATCH THAT
// SYSTEM." The map touch buttons show exactly when the game is in its
// mobile layout, and never by a test of their own.
//
// Two home-made device tests put them on his full-size desktop in one
// afternoon. Measured on his machine (Claude desktop's Chromium, same
// hardware as his browser): pointer:coarse, hover:none, any-pointer:fine
// FALSE, any-hover FALSE, 10 touch points, Windows, not a mobile OS.
// By pointer media it is a phone. By the layout rule — which already
// distrusts pointer media above 1400px — it is a desktop.

import { mapControlsWanted } from '../MobileMapControls';
import { isMobileShell } from '../../hooks/useIsMobile';

type Env = { ua: string; coarse: boolean; hover: boolean; width: number; touchPoints?: number; uaMobile?: boolean; platform?: string };

function withEnv(env: Env, fn: () => void) {
  const origMM = window.matchMedia;
  const nav = window.navigator as Navigator & { userAgentData?: unknown };
  const uaDesc = Object.getOwnPropertyDescriptor(nav, 'userAgent');
  const tpDesc = Object.getOwnPropertyDescriptor(nav, 'maxTouchPoints');
  const udDesc = Object.getOwnPropertyDescriptor(nav, 'userAgentData');
  const origW = window.innerWidth;
  window.matchMedia = ((q: string) => {
    const coarse = /pointer:\s*coarse/.test(q) ? env.coarse : true;
    const noHover = /hover:\s*none/.test(q) ? !env.hover : true;
    return {
      matches: coarse && noHover, media: q,
      addEventListener() {}, removeEventListener() {},
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  Object.defineProperty(nav, 'userAgent', { value: env.ua, configurable: true });
  Object.defineProperty(nav, 'maxTouchPoints', { value: env.touchPoints ?? 0, configurable: true });
  Object.defineProperty(nav, 'userAgentData', {
    value: { mobile: env.uaMobile ?? false, platform: env.platform ?? 'Windows' }, configurable: true,
  });
  Object.defineProperty(window, 'innerWidth', { value: env.width, configurable: true, writable: true });
  try { fn(); } finally {
    window.matchMedia = origMM;
    if (uaDesc) Object.defineProperty(nav, 'userAgent', uaDesc);
    if (tpDesc) Object.defineProperty(nav, 'maxTouchPoints', tpDesc);
    if (udDesc) Object.defineProperty(nav, 'userAgentData', udDesc);
    else delete (nav as { userAgentData?: unknown }).userAgentData;
    Object.defineProperty(window, 'innerWidth', { value: origW, configurable: true, writable: true });
  }
}

const WIN = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';

/** Lorne's machine exactly as measured, at the width of his screenshot. */
const LORNE_DESKTOP: Env = { ua: WIN, coarse: true, hover: false, width: 1898, touchPoints: 10 };

describe('map touch buttons follow the mobile layout, and only the layout', () => {
  it("Lorne's desktop — which REPORTS as a touch-only device — gets no buttons", () => {
    withEnv(LORNE_DESKTOP, () => {
      expect(isMobileShell()).toBe(false);        // the layout says desktop...
      expect(mapControlsWanted()).toBe(false);    // ...so no buttons
    });
  });

  it('a phone gets them', () => {
    withEnv({ ua: ANDROID, coarse: true, hover: false, width: 412, touchPoints: 5, uaMobile: true, platform: 'Android' }, () => {
      expect(mapControlsWanted()).toBe(true);
    });
  });

  it('is the layout decision itself, in every case', () => {
    const cases: Env[] = [
      LORNE_DESKTOP,
      { ...LORNE_DESKTOP, width: 1200 },
      { ...LORNE_DESKTOP, width: 900 },
      { ua: WIN, coarse: false, hover: true, width: 1898 },
      { ua: WIN, coarse: false, hover: true, width: 900 },
      { ua: ANDROID, coarse: true, hover: false, width: 412, uaMobile: true, platform: 'Android' },
      { ua: ANDROID, coarse: true, hover: false, width: 1280, platform: 'Android' },
    ];
    for (const env of cases) {
      withEnv(env, () => expect(mapControlsWanted()).toBe(isMobileShell()));
    }
  });
});
