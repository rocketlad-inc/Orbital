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
// In the packaged app the game says so instead of offering a button
// that would either break Play policy or dead-end in a browser tab.
// ============================================================

/** A Trusted Web Activity hands us this referrer on the launch
 *  navigation. It is the documented signal and the only reliable one —
 *  the user agent is plain Chrome, because a TWA IS Chrome. */
const TWA_REFERRER = 'android-app://';

/** Remembered because the referrer is only present on the navigation
 *  that launched the app: a later in-app reload or a pushState would
 *  otherwise look like an ordinary browser and put the buy button back. */
const STORE_KEY = 'orbital.shell.androidApp';

function readFlag(): boolean {
  try { return window.localStorage.getItem(STORE_KEY) === '1'; } catch { return false; }
}

function writeFlag(): void {
  try { window.localStorage.setItem(STORE_KEY, '1'); } catch { /* private mode: detect per-launch */ }
}

/** Running inside the packaged Android app. */
export function isAndroidApp(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof document !== 'undefined' && document.referrer.startsWith(TWA_REFERRER)) {
    writeFlag();
    return true;
  }
  return readFlag();
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
