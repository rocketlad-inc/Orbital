import fs from 'fs';
import path from 'path';

// ============================================================
// The Commission is sold on the website and nowhere else.
//
// Lorne: "Commissions can only be purchased on the online page, not in
// the app. Say so in the app." That is not a preference — Google Play
// requires digital goods sold inside a Play-distributed app to go
// through Play Billing, and Orbital's $10 Commission is Stripe. So the
// packaged build must never show a buy button, and must say where the
// button went.
//
// These tests pin the detection and both storefronts.
// ============================================================

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

describe('app shell detection', () => {
  const src = read('platform/appShell.ts');

  it('identifies the packaged app by the TWA referrer, not the user agent', () => {
    // A Trusted Web Activity IS Chrome, so the UA is useless here; the
    // android-app:// referrer is the documented signal.
    expect(src).toMatch(/android-app:\/\//);
    expect(src).not.toMatch(/userAgent/);
  });

  it('remembers the launch signal, because the referrer does not survive', () => {
    // The referrer is set on the launch navigation only. Without
    // persistence an in-app reload looks like a browser and the buy
    // button comes back — the exact failure this must not have.
    expect(src).toMatch(/localStorage/);
    expect(src).toMatch(/orbital\.shell\.androidApp/);
  });

  it('treats a browser-installed PWA as standalone but NOT as the app', () => {
    // Policy follows distribution, not chrome: a home-screen install
    // from the browser is still the open web and may sell normally.
    expect(src).toMatch(/export function isStandalone/);
    expect(src).toMatch(/display-mode: standalone/);
  });
});

describe('the Commission storefronts', () => {
  it('the profile panel swaps the buy button for where-to-buy', () => {
    const pp = read('multiplayer/ProfilePanel.tsx');
    expect(pp).toMatch(/isAndroidApp\(\) \? \(/);
    expect(pp).toMatch(/purchased on the Orbital website, not in the app/);
    // The entitlement is account-wide, so the copy must not imply the
    // player has to buy twice.
    expect(pp).toMatch(/unlocks here the next time you sign in/);
  });

  it('the lobby flag picker does the same', () => {
    const lv = read('multiplayer/LobbyView.tsx');
    expect(lv).toMatch(/isAndroidApp\(\) \? \(/);
    expect(lv).toMatch(/on the Orbital website/);
  });

  it('no checkout can be started from the packaged app', () => {
    // Both call sites must be behind the gate. If a third appears, this
    // fails until it is gated too.
    for (const rel of ['multiplayer/ProfilePanel.tsx', 'multiplayer/LobbyView.tsx']) {
      const s = read(rel);
      expect(s).toMatch(/isAndroidApp/);
    }
    const callers = ['multiplayer/ProfilePanel.tsx', 'multiplayer/LobbyView.tsx', 'multiplayer/api.ts'];
    const root = path.join(__dirname, '..', '..');
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const offenders = walk(root)
      .filter(f => /\.tsx?$/.test(f) && !f.includes('__tests__'))
      .filter(f => fs.readFileSync(f, 'utf8').includes('startCommissionCheckout'))
      .map(f => path.relative(root, f).replace(/\\/g, '/'))
      .filter(f => !callers.includes(f));
    expect(offenders).toEqual([]);
  });
});

describe('the Android back button', () => {
  const src = read('platform/AndroidBackHandler.tsx');

  it('closes layers innermost-first', () => {
    // Aiming a transfer is the most modal thing on screen, so it unwinds
    // first; a held selection is what the map is left with, so it goes
    // last. Back used to skip both and close the app mid-order.
    expect(src).toMatch(/const ORDER: Layer\[\] = \['select', 'panel', 'dock', 'worldmenu', 'target'\]/);
    expect(src).toMatch(/\[\.\.\.ORDER\]\.reverse\(\)\.find/);
  });

  it('closes through the same events the X buttons send', () => {
    expect(src).toMatch(/orbital:close-world-menu/);
    expect(src).toMatch(/dockrail:set/);
    expect(src).toMatch(/orbital:open-panel/);
  });

  it('leaves ordinary browser tabs alone', () => {
    expect(src).toMatch(/if \(!isStandalone\(\)\) return;/);
  });

  it('parks exactly one history entry at a time', () => {
    // Two guards for one layer means a player pressing back twice gets
    // nothing the first time.
    expect(src).toMatch(/if \(parked \|\| open\.size === 0\) return;/);
  });

  it('the world menu actually announces itself', () => {
    expect(read('game/worldMenu/store.ts')).toMatch(/orbital:worldmenu-state/);
  });

  // A layer back can close is only real if something announces it and
  // something answers the close. Checked at both ends, because either one
  // missing fails silently: back just skips the mode.
  it('target mode announces itself and can be cancelled', () => {
    const map = read('components/MapCanvas.tsx');
    expect(map).toMatch(/orbital:target-state/);
    expect(map).toMatch(/addEventListener\('orbital:cancel-target'/);
    expect(src).toMatch(/orbital:cancel-target/);
  });

  it('a touch selection announces itself and can be ended', () => {
    const bar = read('components/GroupActionBar.tsx');
    expect(bar).toMatch(/orbital:select-state/);
    expect(bar).toMatch(/addEventListener\('orbital:exit-select'/);
    expect(src).toMatch(/orbital:exit-select/);
  });
});

describe('the service worker cannot serve a stale game', () => {
  const sw = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'public', 'sw.js'), 'utf8');

  it('never caches the API', () => {
    expect(sw).toMatch(/if \(url\.pathname\.startsWith\('\/api\/'\)\) return;/);
  });

  it('fetches the shell from the network first', () => {
    expect(sw).toMatch(/req\.mode === 'navigate'/);
    const nav = sw.slice(sw.indexOf("req.mode === 'navigate'"));
    // The network call must come before any cache lookup in that branch.
    expect(nav.indexOf('await fetch(req)')).toBeLessThan(nav.indexOf('caches.match'));
  });

  it('only cache-firsts content-hashed build output', () => {
    expect(sw).toMatch(/url\.pathname\.startsWith\('\/static\/'\)/);
  });

  it('carries the push handlers, since only a worker can receive them', () => {
    expect(sw).toMatch(/addEventListener\('push'/);
    expect(sw).toMatch(/addEventListener\('notificationclick'/);
  });

  it('has a way out that does not involve browser settings', () => {
    expect(sw).toMatch(/orbital:sw-reset/);
    expect(read('platform/registerSW.ts')).toMatch(/params\.get\('sw'\) === 'off'/);
  });
});
