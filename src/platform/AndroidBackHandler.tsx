// ============================================================
// The Android hardware back button.
//
// In a Trusted Web Activity the back button is browser-back, and
// browser-back at the first history entry CLOSES THE APP. Orbital opens
// its panels without touching history, so on a phone the first back
// press from anywhere in the game would drop the player out to their
// home screen with a fleet half-ordered. Play reviewers check this, and
// players hate it more than reviewers do.
//
// So: while any dismissible layer is open, keep one spare history entry
// parked. Back then spends that entry, we close the top layer instead of
// navigating, and re-park if anything is still open. Back from a clean
// map is a real back — which in a TWA correctly exits.
//
// It reads the events the UI ALREADY broadcasts rather than asking every
// panel to register itself:
//
//   dockrail:active          the right-hand dock (situation, trade, ...)
//   orbital:panel-state      App's own panels (empire, fleet, research)
//   orbital:worldmenu-state  a world's diegetic menu
//
// and closes them through the same events a click on the X sends, so
// there is exactly one close path per layer, not two.
//
// BROWSER TABS ARE LEFT ALONE. In a tab there is a visible back button
// and back means "leave the page"; hijacking it would be the surprise.
// Only a standalone/packaged launch opts in.
// ============================================================

import { useEffect } from 'react';
import { isStandalone } from './appShell';

/** Innermost last: the order a player expects to unwind them. */
type Layer = 'select' | 'panel' | 'dock' | 'worldmenu' | 'target';

const CLOSERS: Record<Layer, () => void> = {
  target: () => window.dispatchEvent(new CustomEvent('orbital:cancel-target')),
  worldmenu: () => window.dispatchEvent(new CustomEvent('orbital:close-world-menu')),
  dock: () => window.dispatchEvent(new CustomEvent('dockrail:set', { detail: { active: null } })),
  panel: () => window.dispatchEvent(new CustomEvent('orbital:open-panel', { detail: { panel: null } })),
  select: () => window.dispatchEvent(new CustomEvent('orbital:exit-select')),
};

// TARGET MODE AND SELECTION ARE MODES TOO. Back used to unwind only
// panels, so a player aiming a transfer or holding a selected group who
// pressed back skipped straight past it -- out of the app, with the order
// half made. Aiming is the most modal thing on screen, so it goes first;
// a selection is what the map is left holding, so it goes last.
const ORDER: Layer[] = ['select', 'panel', 'dock', 'worldmenu', 'target'];
const GUARD = 'orbital:back-guard';

export const AndroidBackHandler: React.FC = () => {
  useEffect(() => {
    if (!isStandalone()) return;

    const open = new Set<Layer>();
    // True while a history entry of ours is parked, so we never stack
    // two guards for three panels and leave the player pressing back
    // repeatedly against nothing.
    let parked = false;

    const park = () => {
      if (parked || open.size === 0) return;
      try {
        window.history.pushState({ [GUARD]: true }, '');
        parked = true;
      } catch { /* history unavailable: back falls through, as before */ }
    };

    const sync = (layer: Layer, isOpen: boolean) => {
      if (isOpen) { open.add(layer); park(); } else { open.delete(layer); }
    };

    const onDock = (e: Event) => sync('dock', !!(e as CustomEvent).detail?.active);
    const onPanel = (e: Event) => sync('panel', !!(e as CustomEvent).detail?.panel);
    const onWorld = (e: Event) => sync('worldmenu', !!(e as CustomEvent).detail?.bodyId);
    const onSelect = (e: Event) => sync('select', !!(e as CustomEvent).detail?.active);
    const onTarget = (e: Event) => sync('target', !!(e as CustomEvent).detail?.active);

    const onPop = () => {
      // Our parked entry is what just got spent.
      parked = false;
      if (open.size === 0) return;   // nothing to close: a real back
      const top = [...ORDER].reverse().find(l => open.has(l));
      if (!top) return;
      open.delete(top);
      CLOSERS[top]();
      // Something underneath is still open, so park again for the next
      // press. Re-entrancy is safe: park() no-ops on an empty set.
      park();
    };

    window.addEventListener('dockrail:active', onDock as EventListener);
    window.addEventListener('orbital:panel-state', onPanel as EventListener);
    window.addEventListener('orbital:worldmenu-state', onWorld as EventListener);
    window.addEventListener('orbital:select-state', onSelect as EventListener);
    window.addEventListener('orbital:target-state', onTarget as EventListener);
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('dockrail:active', onDock as EventListener);
      window.removeEventListener('orbital:panel-state', onPanel as EventListener);
      window.removeEventListener('orbital:worldmenu-state', onWorld as EventListener);
      window.removeEventListener('orbital:select-state', onSelect as EventListener);
      window.removeEventListener('orbital:target-state', onTarget as EventListener);
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  return null;
};
