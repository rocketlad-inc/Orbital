// ============================================================
// "If we are in the app, 100% of the time serve the mobile version of
// the UX. No exceptions." -- Lorne
//
// Real module, real DOM (jsdom), not a mirror of the logic: each test
// loads useIsMobile fresh, because it clamps and stamps at import.
// The app is simulated the way appShell detects it, by the TWA's
// android-app:// referrer; the rest of the environment is made as
// DESKTOP as possible (Windows UA, fine pointer, 1920px) so only the
// app rule can make these pass.
// ============================================================

type Mod = typeof import('../useIsMobile');

const VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content';

const UA_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
const UA_FOLD7 = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';

function setEnv(opts: { app: boolean; innerWidth: number; screenWidth: number; standalone?: boolean; ua?: string }) {
  window.localStorage.clear();
  Object.defineProperty(document, 'referrer', {
    configurable: true,
    get: () => (opts.app ? 'android-app://com.orbitalempire.game/' : ''),
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: opts.innerWidth });
  Object.defineProperty(window.screen, 'width', { configurable: true, get: () => opts.screenWidth });
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    get: () => opts.ua ?? UA_WINDOWS,
  });
  // Desktop pointer: coarse/hover:none never match.
  window.matchMedia = ((q: string) => ({
    matches: !!opts.standalone && /display-mode: standalone/.test(q), media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  document.head.innerHTML = `<meta name="viewport" content="${VIEWPORT}">`;
  document.documentElement.removeAttribute('data-mobile-shell');
}

function load(): Mod {
  let mod: Mod | undefined;
  jest.isolateModules(() => { mod = require('../useIsMobile'); });
  return mod!;
}

const viewport = () => document.querySelector('meta[name="viewport"]')!.getAttribute('content');

describe('in the Android app the UX is mobile, whatever the device claims', () => {
  test('a 1920px desktop-looking environment is still the mobile shell in the app', () => {
    setEnv({ app: true, innerWidth: 1920, screenWidth: 1920 });
    const m = load();
    expect(m.isMobileShell()).toBe(true);
    expect(m.isCoarsePointer()).toBe(true);
    expect(m.isTouchPrimaryDevice()).toBe(true);
    expect(document.documentElement.hasAttribute('data-mobile-shell')).toBe(true);
  });

  test('the same environment OUTSIDE the app stays desktop (the rule is app-only)', () => {
    setEnv({ app: false, innerWidth: 1920, screenWidth: 1920 });
    const m = load();
    expect(m.isMobileShell()).toBe(false);
    expect(m.isCoarsePointer()).toBe(false);
    expect(document.documentElement.hasAttribute('data-mobile-shell')).toBe(false);
    expect(viewport()).toBe(VIEWPORT);
  });

  test('landscape phone in the app is laid out at phone width, other directives kept', () => {
    setEnv({ app: true, innerWidth: 905, screenWidth: 905 });
    load();
    expect(viewport()).toBe('width=720, viewport-fit=cover, interactive-widget=resizes-content');
  });

  test('turning back upright UNDOES the clamp (the app rotates)', () => {
    setEnv({ app: true, innerWidth: 905, screenWidth: 905 });
    load();
    expect(viewport()).toMatch(/^width=720/);
    // Portrait: the physical screen is phone-width again. innerWidth
    // would still read the clamp, which is why the rule uses screen.width.
    Object.defineProperty(window.screen, 'width', { configurable: true, get: () => 412 });
    window.dispatchEvent(new Event('resize'));
    expect(viewport()).toBe(VIEWPORT);
  });

  test('no screen width (hidden view): clamps once and never flaps back', () => {
    setEnv({ app: true, innerWidth: 905, screenWidth: 0 });
    load();
    expect(viewport()).toMatch(/^width=720/);
    // The clamp took: innerWidth now reads the clamped width.
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 720 });
    window.dispatchEvent(new Event('resize'));
    expect(viewport()).toMatch(/^width=720/);
  });

  test('a portrait phone in the app is left exactly as the page declared it', () => {
    setEnv({ app: true, innerWidth: 412, screenWidth: 412 });
    load();
    expect(viewport()).toBe(VIEWPORT);
  });

  test('the app flag survives a later navigation without the referrer', () => {
    setEnv({ app: true, innerWidth: 412, screenWidth: 412 });
    load();
    // e.g. back from a sign-in redirect: the referrer is no longer the app
    Object.defineProperty(document, 'referrer', { configurable: true, get: () => 'https://accounts.google.com/' });
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1920 });
    const m = load();
    expect(m.isMobileShell()).toBe(true);
  });

  // THE FOLD 7 (screenshot, 4:39pm): pill and phone map buttons, but the
  // desktop dock rail and desktop density -- the page laid out ~1000px
  // wide, and the app clamp never ran. A home-screen install arrives
  // without the Play app's referrer; to the player it is the app.
  test('a home-screen install on an Android phone is the app: mobile and clamped', () => {
    setEnv({ app: false, standalone: true, ua: UA_FOLD7, innerWidth: 1000, screenWidth: 1000 });
    const m = load();
    expect(m.isInApp()).toBe(true);
    expect(m.isMobileShell()).toBe(true);
    expect(viewport()).toMatch(/^width=720/);
  });

  test('an installed app on a DESKTOP stays desktop', () => {
    setEnv({ app: false, standalone: true, ua: UA_WINDOWS, innerWidth: 1920, screenWidth: 1920 });
    const m = load();
    expect(m.isInApp()).toBe(false);
    expect(m.isMobileShell()).toBe(false);
    expect(viewport()).toBe(VIEWPORT);
  });
});
