// ============================================================
// MobileSimControls — bottom-left sim speed dock for mobile.
// Mounted as a sibling of TopBar (NOT inside it) so its fixed
// positioning is viewport-relative; the TopBar's backdrop-filter
// would otherwise containment-trap any descendant fixed element.
// Hidden on desktop via CSS.
// ============================================================

import React from 'react';
import { useGameContext } from '../state/gameContext';
import { useIsMobile } from '../hooks/useIsMobile';
import './MobileSimControls.css';

/** Mobile-only sim speeds. Keep this short so the dock fits at 375px wide. */
const MOBILE_SPEEDS = [1, 100, 10000];

interface Props {
  /** Hide when the multiplayer host controls tick rate from the lobby. */
  hideSimControls?: boolean;
}

export const MobileSimControls: React.FC<Props> = ({ hideSimControls = false }) => {
  const isMobile = useIsMobile();
  const { gameState, simSpeed, setSimSpeed, updateTick } = useGameContext();

  if (!isMobile || hideSimControls) return null;

  return (
    <div className="mobile-sim-controls" role="group" aria-label="Simulation controls">
      <button
        className={`mobile-sim-btn ${simSpeed === 0 ? 'active' : ''}`}
        onClick={() => setSimSpeed(0)}
        title="Pause"
        aria-label="Pause"
      >⏸</button>
      {MOBILE_SPEEDS.map(s => (
        <button
          key={s}
          className={`mobile-sim-btn ${simSpeed === s ? 'active' : ''}`}
          onClick={() => setSimSpeed(s)}
          title={`${s}× speed`}
          aria-label={`${s} times speed`}
        >{s >= 1000 ? `${s / 1000}K×` : `${s}×`}</button>
      ))}
      <button
        className="mobile-sim-btn"
        onClick={() => updateTick(gameState.currentTick + 10)}
        title="Skip +10 ticks"
        aria-label="Skip 10 ticks forward"
      >+10</button>
    </div>
  );
};
