// ============================================================
// MobileMapControls — on-screen buttons for what the map otherwise
// only offers as a gesture or a key.
//
//   SELECT  enters touch selection mode, same as long-pressing a ship
//   + / −   zoom, the single-finger alternative to pinch
//   ‹ / ›   previous / next world, the keyboard's Q and E
//
// WHY THESE EXIST. A long press is invisible until someone tells you it
// is there, and every mobile strategy game studied puts its selection
// behind a visible control as well as a gesture. The accessibility rules
// say the same thing more bluntly: anything done with a multi-finger
// gesture must also be doable with one pointer (WCAG 2.5.1 -- the W3C's
// own example is a map's pinch-zoom needing +/- buttons), and Q and E
// simply do not exist on a phone.
//
// It holds no game logic. Selection mode is shared UI state; zoom and
// world-stepping are events MapCanvas already answers, so the buttons
// and the keys can never behave differently.
// ============================================================

import React, { useEffect, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useIsMobile, isMobileShell } from '../hooks/useIsMobile';
import './MobileMapControls.css';

const ZOOM_STEP = 1.6;

/**
 * SHOWN EXACTLY WHEN THE GAME IS IN ITS MOBILE LAYOUT — the same
 * decision the shell makes (useIsMobile / isMobileShell), nothing of
 * its own. Lorne: "We already detect if it's a layout or not. JUST
 * MATCH THAT SYSTEM."
 *
 * Two home-made device tests put these on his full-size desktop in one
 * afternoon, because his machine's Chromium reports pointer:coarse,
 * hover:none and NO fine pointer at all. The layout rule already knew
 * pointer media lies (its hard stop: >=1400px is always desktop); a
 * second rule here only had a second chance to be wrong.
 */
export function mapControlsWanted(): boolean {
  return isMobileShell();
}

export const MobileMapControls: React.FC = () => {
  const { uiState, setSelectMode, clearShipSelection } = useGameContext();
  // The layout's hook, so the buttons re-evaluate on resize exactly when
  // the layout does.
  const isMobile = useIsMobile();
  const [openPanel, setOpenPanel] = useState<string | null>(null);

  useEffect(() => {
    const onPanel = (e: Event) => setOpenPanel((e as CustomEvent).detail?.panel ?? null);
    window.addEventListener('orbital:panel-state', onPanel as EventListener);
    return () => window.removeEventListener('orbital:panel-state', onPanel as EventListener);
  }, []);

  if (!isMobile) return null;
  // A full-screen panel covers the map; controls for the map would only
  // sit on top of the panel's own.
  if (openPanel) return null;

  const selecting = !!uiState.selectMode;
  const aiming = !!uiState.targetSelectionMode;

  const toggleSelect = () => {
    if (selecting) {
      // Leaving by the same button that entered: the same as Done.
      clearShipSelection();
      setSelectMode(false);
    } else {
      setSelectMode(true);
    }
  };

  const zoom = (factor: number) =>
    window.dispatchEvent(new CustomEvent('orbital:zoom-step', { detail: { factor } }));
  const step = (dir: -1 | 1) =>
    window.dispatchEvent(new CustomEvent('orbital:world-step', { detail: { dir } }));

  return (
    <div className="map-controls" role="toolbar" aria-label="Map controls">
      <button
        className={`map-controls__btn map-controls__btn--select${selecting ? ' is-on' : ''}`}
        onClick={toggleSelect}
        disabled={aiming}
        aria-pressed={selecting}
        aria-label={selecting ? 'Stop selecting ships' : 'Select several ships'}
        title={selecting ? 'Stop selecting' : 'Select several ships (or hold one)'}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
          <rect x="3.5" y="3.5" width="17" height="17" rx="2"
            fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3.5 2.5" />
          {selecting && <path d="M8 12.5l3 3 5-6" fill="none" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      </button>
      <div className="map-controls__gap" />
      <button className="map-controls__btn" onClick={() => zoom(ZOOM_STEP)} aria-label="Zoom in">+</button>
      <button className="map-controls__btn" onClick={() => zoom(1 / ZOOM_STEP)} aria-label="Zoom out">−</button>
      <div className="map-controls__gap" />
      <button className="map-controls__btn" onClick={() => step(-1)} aria-label="Previous world">‹</button>
      <button className="map-controls__btn" onClick={() => step(1)} aria-label="Next world">›</button>
    </div>
  );
};
