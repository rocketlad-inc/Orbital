// ============================================================
// MobileMapControls — on-screen buttons for what the map otherwise
// only offers as a gesture or a key.
//
//   SELECT  enters touch selection mode, same as long-pressing a ship
//   ‹ / ›   previous / next world, the keyboard's Q and E
//
// WHY THESE EXIST. A long press is invisible until someone tells you it
// is there, and every mobile strategy game studied puts its selection
// behind a visible control as well as a gesture; and Q and E simply do
// not exist on a phone.
//
// NO ZOOM BUTTONS. There were + / − here, as the single-finger
// alternative to pinch that WCAG 2.5.1 asks for. Lorne took them out
// (2026-09-26): pinch is what everyone reaches for on a map, and the two
// buttons cost toolbar room for nobody. MapCanvas still answers the
// 'orbital:zoom-step' event (the megastructure card uses it), so they
// can come back as one line each if that call changes.
//
// It holds no game logic. Selection mode is shared UI state and
// world-stepping is an event MapCanvas already answers, so the buttons
// and the keys can never behave differently.
// ============================================================

import React, { useEffect, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useIsMobile, isMobileShell } from '../hooks/useIsMobile';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './MobileMapControls.css';


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
  useI18n();
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

  const step = (dir: -1 | 1) =>
    window.dispatchEvent(new CustomEvent('orbital:world-step', { detail: { dir } }));

  return (
    <div className="map-controls" role="toolbar" aria-label={t('site.map.controls')}>
      <button
        className={`map-controls__btn map-controls__btn--select${selecting ? ' is-on' : ''}`}
        onClick={toggleSelect}
        disabled={aiming}
        aria-pressed={selecting}
        aria-label={selecting ? t('site.map.stopAria') : t('site.map.selectAria')}
        title={selecting ? t('site.map.stopTitle') : t('site.map.selectTitle')}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
          <rect x="3.5" y="3.5" width="17" height="17" rx="2"
            fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3.5 2.5" />
          {selecting && <path d="M8 12.5l3 3 5-6" fill="none" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      </button>
      <div className="map-controls__gap" />
      <button className="map-controls__btn" onClick={() => step(-1)} aria-label={t('site.map.prev')}>‹</button>
      <button className="map-controls__btn" onClick={() => step(1)} aria-label={t('site.map.next')}>›</button>
    </div>
  );
};
