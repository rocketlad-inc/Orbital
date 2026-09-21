// Lorne: "Do not show these buttons on desktop. They are redundant and
// overlap with the side rail." Twice reported — first on a touchscreen
// laptop (coarse pointer AND a trackpad), then on a desktop browser
// merely narrowed under 1024px, which useIsMobile() calls "mobile".
// The answer is decided by the DEVICE, never the window width.

import { mapControlsWanted } from '../MobileMapControls';

type Env = { ua: string; coarse: boolean; hover: boolean; width: number; touchPoints?: number };

function withEnv(env: Env, fn: () => void) {
  const origMM = window.matchMedia;
  const uaDesc = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
  const tpDesc = Object.getOwnPropertyDescriptor(window.navigator, 'maxTouchPoints');
  const origW = window.innerWidth;
  window.matchMedia = ((q: string) => {
    // Evaluate the only two features these checks ask about.
    const coarse = /pointer:\s*coarse/.test(q) ? env.coarse : true;
    const noHover = /hover:\s*none/.test(q) ? !env.hover : true;
    return { matches: coarse && noHover, media: q } as MediaQueryList;
  }) as typeof window.matchMedia;
  Object.defineProperty(window.navigator, 'userAgent', { value: env.ua, configurable: true });
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: env.touchPoints ?? 0, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: env.width, configurable: true, writable: true });
  try { fn(); } finally {
    window.matchMedia = origMM;
    if (uaDesc) Object.defineProperty(window.navigator, 'userAgent', uaDesc);
    if (tpDesc) Object.defineProperty(window.navigator, 'maxTouchPoints', tpDesc);
    Object.defineProperty(window, 'innerWidth', { value: origW, configurable: true, writable: true });
  }
}

const WIN = 'Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';

describe('map touch controls: never on desktop', () => {
  it('a desktop browser narrowed under 1024px does NOT get them (the second report)', () => {
    withEnv({ ua: WIN, coarse: false, hover: true, width: 900 }, () => {
      expect(mapControlsWanted()).toBe(false);
    });
  });

  it('a touchscreen laptop with a trackpad does NOT get them (the first report)', () => {
    withEnv({ ua: WIN, coarse: true, hover: true, width: 1500, touchPoints: 10 }, () => {
      expect(mapControlsWanted()).toBe(false);
    });
  });

  it('...not even when that laptop window is narrow', () => {
    withEnv({ ua: WIN, coarse: true, hover: true, width: 800, touchPoints: 10 }, () => {
      expect(mapControlsWanted()).toBe(false);
    });
  });

  it('a phone gets them', () => {
    withEnv({ ua: ANDROID, coarse: true, hover: false, width: 412, touchPoints: 5 }, () => {
      expect(mapControlsWanted()).toBe(true);
    });
  });

  it('a touch-only device with a desktop-looking UA still gets them', () => {
    withEnv({ ua: WIN, coarse: true, hover: false, width: 1100, touchPoints: 10 }, () => {
      expect(mapControlsWanted()).toBe(true);
    });
  });
});
