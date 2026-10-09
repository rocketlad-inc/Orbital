/**
 * Which tab is the app, played out on a phone that has both the app and
 * Chrome (2026-10-08).
 *
 * A Trusted Web Activity IS Chrome, so the two share localStorage. Before
 * this, the app's "I am the app" flag lived only there, so every plain
 * Chrome tab on that phone also called itself the app and refused to sell
 * (290 prod shell reports: flagged as the app, not displayed as one). That
 * mattered little while the app only said "buy it on the website"; it
 * matters now that the app's button OPENS the website in Chrome, which has
 * to be able to sell.
 */
import { isAndroidApp } from '../appShell';

let referrer = '';
let standalone = false;
Object.defineProperty(document, 'referrer', { configurable: true, get: () => referrer });
window.matchMedia = ((q: string) => ({
  matches: standalone && /display-mode: (standalone|fullscreen)/.test(q),
})) as unknown as typeof window.matchMedia;

/** A fresh tab: its own sessionStorage, the phone's shared localStorage. */
function newTab(url: string, opts: { referrer?: string; standalone: boolean }) {
  sessionStorage.clear();
  referrer = opts.referrer ?? '';
  standalone = opts.standalone;
  window.history.replaceState({}, '', url);
}
/** The same tab, reloaded: sessionStorage and referrer survive. */
function reload(url: string) {
  window.history.replaceState({}, '', url);
}

const APP = 'android-app://com.orbitalempire.game/';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

test('the app is the app: at launch and after a reload', () => {
  newTab('/', { referrer: APP, standalone: true });
  expect(isAndroidApp()).toBe(true);
  referrer = '';
  reload('/?room=abc');
  expect(isAndroidApp()).toBe(true);
});

test('a Chrome tab on the same phone is NOT the app, though it shares the storage', () => {
  newTab('/', { referrer: APP, standalone: true });
  expect(isAndroidApp()).toBe(true);
  newTab('/', { standalone: false });
  expect(localStorage.getItem('orbital.shell.androidApp')).toBe('1');
  expect(isAndroidApp()).toBe(false);
});

test('the app opened again later, from recents, is still the app', () => {
  newTab('/', { referrer: APP, standalone: true });
  isAndroidApp();
  newTab('/', { standalone: true });
  expect(isAndroidApp()).toBe(true);
});

test('the browser the app links out to can sell, and keeps selling after a reload', () => {
  // The app hands Chrome the page; Chrome reports the app as its referrer.
  newTab('/?commission=buy&from=designer', { referrer: APP, standalone: false });
  expect(isAndroidApp()).toBe(false);
  // The handoff strips its parameter; a reload keeps the referrer.
  reload('/');
  expect(isAndroidApp()).toBe(false);
});

test('the parameter alone does not make the app a browser', () => {
  newTab('/?commission=buy&from=designer', { referrer: APP, standalone: true });
  expect(isAndroidApp()).toBe(true);
});
