// ============================================================
// Which shell is Orbital running in?
//
// Three answers matter, and they are not the same question:
//
//   BROWSER      — a normal tab. Everything is allowed.
//   INSTALLED    — added to the home screen from the browser itself.
//                  Still the open web; still the player's own browser.
//   ANDROID APP  — the packaged build distributed through Google Play
//                  (a Trusted Web Activity). Google's payments policy
//                  governs what may be SOLD here, which is why this
//                  distinction exists at all rather than being trivia.
//
// The Commander's Commission is sold on the website and nowhere else.
// In the packaged app every buy button opens the website in the phone's
// own browser instead (openCommissionInBrowser), and checkout starts there.
// ============================================================

/** A Trusted Web Activity hands us this referrer on the launch
 *  navigation. It is the documented signal and the only reliable one —
 *  the user agent is plain Chrome, because a TWA IS Chrome. */
const TWA_REFERRER = 'android-app://';

/** Remembered because the referrer is only present on the navigation
 *  that launched the app: a later in-app reload or a pushState would
 *  otherwise look like an ordinary browser and put the buy button back.
 *
 *  Kept TWICE, because a TWA shares Chrome's storage. The tab's own
 *  sessionStorage is the app's alone. The localStorage copy is also seen
 *  by every ordinary Chrome tab on the phone, so it only counts while the
 *  page is displayed as an app (a TWA reports display-mode: standalone,
 *  1000 of 1290 app reports on prod; a Chrome tab never does). Before
 *  2026-10-08 it counted everywhere, and 290 reports from what were plain
 *  Chrome tabs called themselves the app and refused to sell. */
const STORE_KEY = 'orbital.shell.androidApp';

/** The Commission's link out of the app (openCommissionInBrowser) lands
 *  on the site with this parameter, in the phone's browser, with the app
 *  as its android-app:// referrer. That tab is the browser, by
 *  construction, and is marked so for its whole life (the parameter is
 *  stripped once read; the referrer survives a reload). */
export const BROWSER_HANDOFF_PARAM = 'commission';
const HANDOFF_KEY = 'orbital.shell.browserTab';

function read(store: 'local' | 'session', key: string): boolean {
  try { return window[store === 'local' ? 'localStorage' : 'sessionStorage'].getItem(key) === '1'; } catch { return false; }
}

function write(store: 'local' | 'session', key: string): void {
  try { window[store === 'local' ? 'localStorage' : 'sessionStorage'].setItem(key, '1'); } catch { /* private mode: detect per-launch */ }
}

/** Displayed as an installed app rather than a browser tab. */
function displayedAsApp(): boolean {
  try {
    return !!window.matchMedia?.('(display-mode: standalone)').matches
      || !!window.matchMedia?.('(display-mode: fullscreen)').matches;
  } catch { return false; }
}

/** Running inside the packaged Android app. */
export function isAndroidApp(): boolean {
  if (typeof window === 'undefined') return false;
  if (read('session', HANDOFF_KEY)) return false;
  const fromApp = typeof document !== 'undefined' && document.referrer.startsWith(TWA_REFERRER);
  if (fromApp && !displayedAsApp()
      && new URLSearchParams(window.location.search).get(BROWSER_HANDOFF_PARAM) === 'buy') {
    write('session', HANDOFF_KEY);
    return false;
  }
  if (fromApp) {
    write('session', STORE_KEY);
    write('local', STORE_KEY);
    return true;
  }
  if (read('session', STORE_KEY)) return true;
  return read('local', STORE_KEY) && displayedAsApp();
}

/** Running without browser chrome: the packaged app, or a PWA the player
 *  installed themselves. Used for UI that should fill the screen and for
 *  taking over the hardware back button. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    if (window.matchMedia?.('(display-mode: fullscreen)').matches) return true;
  } catch { /* fall through */ }
  // iOS Safari's own flag, for a home-screen install there.
  return (window.navigator as { standalone?: boolean }).standalone === true
    || isAndroidApp();
}

/** Where to send someone who wants to buy the Commission. Absolute, so
 *  it opens the real site in a browser rather than a route inside the
 *  app shell. */
export const WEBSITE_ORIGIN = 'https://orbital-empire.com';
