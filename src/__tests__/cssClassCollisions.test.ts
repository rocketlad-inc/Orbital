// EVERY STYLESHEET IS GLOBAL.
//
// Lorne, 2026-10-25, a screenshot of the Trade dock: "WTF happened here?"
// Every private deal card was laid out as a five-column table, squeezed
// into the dock and shoved off its left edge. The Play for Free admin
// panel (AdminTrialPanel.css) had declared its funnel rows as `.tp-row`
// with a grid, and the Trade panel's deal cards are `.tp-row` too. The
// admin screens are imported by the top bar, so that sheet ships in the
// main bundle to every player and the grid landed on their deal cards.
//
// A class styled from two files is either a deliberate override (the
// phone sheet, mobile.css, restyles desktop classes) or a collision like
// that one. The overrides that exist today are listed; anything new has
// to be added here on purpose, or given its own prefix.

import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..');

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...cssFiles(p));
    else if (e.name.endsWith('.css')) out.push(p);
  }
  return out;
}

/** Class names a sheet styles, by the class that LEADS each selector. */
function leadingClasses(css: string): Set<string> {
  const out = new Set<string>();
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const sel of body.match(/[^{}]+(?=\{)/g) ?? []) {
    if (sel.trim().startsWith('@')) continue;
    for (const part of sel.split(',')) {
      const m = /^\s*\.([A-Za-z][\w-]*)/.exec(part);
      if (m) out.add(m[1]);
    }
  }
  return out;
}

// Deliberate: class -> the files allowed to style it.
const SHARED: Record<string, string[]> = {
  'ai-feed': ['components/AIActivityFeed.css', 'styles/mobile.css'],
  'body-info': ['components/BodyInspector.css', 'styles/mobile.css'],
  'bottom-sheet': ['components/BottomSheet.css', 'components/DockRail.css'],
  'bottom-sheet__body': ['components/BottomSheet.css', 'components/DockRail.css', 'components/ShipPanel.css', 'styles/mobile.css'],
  'bottom-sheet__close': ['components/BottomSheet.css', 'styles/mobile.css'],
  'build-btn': ['components/BuildPanel.css', 'styles/mobile.css'],
  'commit-all-btn': ['components/ShipPanel.css', 'styles/mobile.css'],
  'commit-btn': ['components/ShipPanel.css', 'styles/mobile.css'],
  'delete-btn': ['components/ShipPanel.css', 'styles/mobile.css'],
  'deploy-btn': ['components/BodyInspector.css', 'styles/mobile.css'],
  'dock-panel': ['components/DockRail.css', 'multiplayer/TradeDock.css'],
  'filter-chip': ['components/OverviewPanel.css', 'styles/mobile.css'],
  'info-row': ['components/BodyInspector.css', 'styles/mobile.css'],
  'landing': ['components/HowToPlay.css', 'components/Landing.css'],
  'landing-nav': ['components/HowToPlay.css', 'components/Landing.css'],
  'landing-starfield': ['components/HowToPlay.css', 'components/Landing.css'],
  'lobby-map-preview': ['multiplayer/RoomLobby.css', 'multiplayer/multiplayer.css'],
  'maneuver-btn': ['components/ShipPanel.css', 'styles/mobile.css'],
  'modal-close': ['components/ShipPanel.css', 'styles/mobile.css'],
  'nav-button': ['components/TopBar.css', 'styles/mobile.css'],
  'order-details': ['components/ShipPanel.css', 'styles/mobile.css'],
  'order-item': ['components/ShipPanel.css', 'styles/mobile.css'],
  'order-type': ['components/ShipPanel.css', 'styles/mobile.css'],
  'panel-close': ['components/ShipPanel.css', 'styles/mobile.css'],
  'resource-pill__label': ['components/TopBar.css', 'styles/mobile.css'],
  'resource-pill__value': ['components/TopBar.css', 'styles/mobile.css'],
  'section-title': ['components/ShipPanel.css', 'styles/mobile.css'],
  'ship-panel': ['components/ShipPanel.css', 'styles/mobile.css'],
  'side-menu__close': ['components/TopBar.css', 'styles/mobile.css'],
  'sim-btn': ['components/TopBar.css', 'styles/mobile.css'],
  'sim-controls': ['components/TopBar.css', 'styles/mobile.css'],
  'time-display__countdown': ['components/TopBar.css', 'multiplayer/SoloClock.css'],
  'top-bar': ['components/TopBar.css', 'styles/mobile.css'],
  'top-bar__alerts': ['components/TopBar.css', 'styles/mobile.css'],
  'top-bar__nav': ['components/TopBar.css', 'styles/mobile.css'],
  'top-bar__resources': ['components/TopBar.css', 'styles/mobile.css'],
  'top-bar__time': ['components/TopBar.css', 'styles/mobile.css'],
  'top-bar__title': ['components/TopBar.css', 'multiplayer/trial/trial.css', 'styles/mobile.css'],
  'top-bar__title-main': ['components/TopBar.css', 'styles/mobile.css'],
  'top-bar__title-sub': ['components/TopBar.css', 'styles/mobile.css'],
  'wm-fleet': ['multiplayer/WmSilo.css', 'multiplayer/WorldMenuOverlay.css'],
  'wm-mobile': ['multiplayer/WmSilo.css', 'multiplayer/WorldMenuOverlay.css'],
  'wm-root': ['multiplayer/WmPhone.css', 'multiplayer/WorldMenuOverlay.css'],
};

test('no class is styled from two stylesheets unless it is a listed override', () => {
  const byClass = new Map<string, Set<string>>();
  for (const f of cssFiles(SRC)) {
    const rel = path.relative(SRC, f).split(path.sep).join('/');
    for (const c of leadingClasses(fs.readFileSync(f, 'utf8'))) {
      if (!byClass.has(c)) byClass.set(c, new Set());
      byClass.get(c)!.add(rel);
    }
  }
  const unexpected: string[] = [];
  for (const [c, files] of byClass) {
    if (files.size < 2) continue;
    const allowed = new Set(SHARED[c] ?? []);
    const extra = [...files].filter(f => !allowed.has(f));
    if (extra.length > 0 && !(allowed.size > 0 && [...files].every(f => allowed.has(f)))) {
      unexpected.push(`.${c}: ${[...files].sort().join(', ')}`);
    }
  }
  expect(unexpected).toEqual([]);
});
