// ============================================================
// EliminationBanner — tells a player their empire has fallen, and
// whether (and how) it can come back.
//
// The QA battle test's player was eliminated at T32 while commanding a
// 70-hull fleet and saw NOTHING: no overlay, no toast, a normal map.
// Elimination is "your last settlement fell"; the way back (Lorne,
// 2026-09-22) is a new settlement, which revives the empire on the next
// tick. So the banner says which of the two situations the player is in:
//   - a colony ship survives → here is the way back
//   - none does              → the fleet fights on, the empire cannot return
// Persistent (not a toast) because it stays true until it isn't; slim
// and dismissible so a player who has read it keeps their map.
// ============================================================

import React, { useEffect, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import './EliminationBanner.css';

export const EliminationBanner: React.FC = () => {
  const { gameState } = useGameContext();
  const [hidden, setHidden] = useState(false);
  const me = gameState.factions.find(f => f.id === 'player');
  if (!me?.eliminated || gameState.status === 'completed' || hidden) return null;

  const colony = gameState.ships.find(s => s.ownedBy === 'player' && s.class === 'colony' && (s.hp ?? 1) > 0);
  const hulls = gameState.ships.filter(s => s.ownedBy === 'player' && (s.hp ?? 1) > 0).length;

  return (
    <div className="elim-banner" role="alert">
      <div className="elim-banner__title">Your empire has fallen</div>
      <div className="elim-banner__body">
        {colony
          ? <>You hold no settlements. Found a city or station with <b>{colony.name}</b> and
              your empire returns to the war next tick.</>
          : hulls > 0
            ? <>You hold no settlements and have no colony ship left. Your {hulls} {hulls === 1 ? 'ship fights' : 'ships fight'} on,
                but the empire cannot return.</>
            : <>You hold no settlements and no ships. Your part in this war is over.</>}
      </div>
      <button type="button" className="elim-banner__close" onClick={() => setHidden(true)} aria-label="Dismiss">✕</button>
    </div>
  );
};

/** One-shot alert when the caller's capital falls (gameState.capitalLoss).
 *  The Situation Report carries the lasting NOW row; this is the moment
 *  itself, so it fires once per loss per browser, and only for a loss
 *  from the last couple of ticks — a returning player learns about an
 *  old one from the report, not from a toast about the past. */
export const CapitalLossAlert: React.FC = () => {
  const { gameState } = useGameContext();
  const cap = gameState.capitalLoss;
  const fresh = !!cap && gameState.currentTick - cap.tick <= 2;
  const eventId = cap?.eventId;
  useEffect(() => {
    if (!fresh || !cap || !eventId) return;
    const key = `orbital_capital_alert:${eventId}`;
    try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch { /* private mode: alert anyway */ }
    window.dispatchEvent(new CustomEvent('orbital:toast', {
      detail: {
        kind: 'error',
        text: `Your capital on ${cap.bodyName} has fallen${cap.killerName ? ` to ${cap.killerName}` : ''}.`,
      },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, fresh]);
  return null;
};
