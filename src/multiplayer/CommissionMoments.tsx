// ============================================================
// CommissionMoments — the only two places Orbital ASKS.
//
// Everything else about the Commission shows the goods and waits. These
// two ask, and each obeys the guardrails from the Oct 5 insight report:
//
//   EndgameCommission  on the game-over screen, at a high point (you won,
//                      or your empire survived to the end), once per game,
//                      never over the map while play is on.
//   ThanksCard         in the lobby, once ever, for a non-holder with 20+
//                      hours played (worker/index.js noteVisit decides),
//                      never on the visit the Discord invite shows.
//
// Both dismiss for good with one click, carry no countdown or discount,
// and never appear in the Android app, where nothing is sold.
// ============================================================

import React, { useEffect, useState } from 'react';
import { startCommissionCheckout } from './api';
import { useAuth } from './AuthContext';
import { ShipIcon, ShipIconClass, ShipIconVariant } from '../components/ShipIcons';
import {
  COMMISSION_FACTS, COMMISSION_LINES, COMMISSION_NAME, COMMISSION_PRICE,
  answerCommissionAsk, canBuyHere, logCommission,
} from './commission';
import './CommissionMoments.css';

const FLEET: Array<[ShipIconClass, ShipIconVariant]> = [
  ['frigate', 'S'], ['destroyer', 'Y'], ['corvette', 'W'], ['freighter', 'V'],
];

const endgameKey = (gameId: string) => `orbital.commission.endgame.${gameId}`;

/**
 * Under the GAME OVER / VICTORY title. Only for a player whose empire
 * made it to the end (a loss after elimination is a setback, and a
 * setback is no moment to sell anything).
 */
export function EndgameCommission({ gameId, survived }: { gameId: string; survived: boolean }) {
  const { user } = useAuth();
  const [gone, setGone] = useState(() => {
    try { return !!localStorage.getItem(endgameKey(gameId)); } catch { return false; }
  });
  const eligible = !gone && survived && !!user && !user.is_premium && canBuyHere();

  useEffect(() => {
    if (!eligible) return;
    logCommission('endgame', 'view');
    // Seen counts as shown: it will not come back for this game, even if
    // the player simply closes the screen.
    try { localStorage.setItem(endgameKey(gameId), String(Date.now())); } catch { /* fine */ }
  }, [eligible, gameId]);

  if (!eligible) return null;
  return (
    <div className="cm-end" role="note">
      <div className="cm-fleet" aria-hidden>
        {FLEET.map(([cls, v]) => <ShipIcon key={cls} shipClass={cls} variant={v} size={36} />)}
      </div>
      <div className="cm-end__text">
        <div className="cm-title">Fly your next fleet in a new line</div>
        <div className="cm-body">
          {COMMISSION_LINES} ship lines and new flags with the {COMMISSION_NAME}. Cosmetic only, {COMMISSION_PRICE} once.
        </div>
      </div>
      <div className="cm-actions">
        <button
          className="cm-btn cm-btn--go"
          onClick={() => {
            logCommission('endgame', 'click');
            void startCommissionCheckout('endgame').then(url => { if (url) window.location.assign(url); });
          }}
        >Take a look</button>
        <button
          className="cm-btn"
          onClick={() => { logCommission('endgame', 'dismiss'); setGone(true); }}
        >Not now</button>
      </div>
    </div>
  );
}

/** The one-time thank-you card, at the top of the lobby. */
export function ThanksCard({ onSeeHangar }: { onSeeHangar: () => void }) {
  const { user } = useAuth();
  const [gone, setGone] = useState(false);
  const show = !gone && !!user?.commission_ask && !user.is_premium && canBuyHere();
  useEffect(() => { if (show) logCommission('thanks-card', 'view'); }, [show]);
  if (!show) return null;

  const close = () => {
    answerCommissionAsk('dismissed');
    logCommission('thanks-card', 'dismiss');
    setGone(true);
  };
  return (
    <aside className="cm-thanks" aria-labelledby="cm-thanks-title">
      <button className="cm-x" aria-label="Close for good" onClick={close}>×</button>
      <div className="cm-fleet" aria-hidden>
        {FLEET.map(([cls, v]) => <ShipIcon key={cls} shipClass={cls} variant={v} size={34} />)}
      </div>
      <div className="cm-thanks__text">
        <h3 id="cm-thanks-title" className="cm-title">Twenty hours in. Thank you for playing.</h3>
        <p className="cm-body">
          Orbital is free and stays free. If you would like to support it, the {COMMISSION_NAME} is how:
          {' '}{COMMISSION_FACTS} This is the only time we will ask.
        </p>
      </div>
      <div className="cm-actions">
        <button
          className="cm-btn cm-btn--go"
          onClick={() => {
            answerCommissionAsk('clicked');
            logCommission('thanks-card', 'click');
            void startCommissionCheckout('thanks-card').then(url => {
              if (url) window.location.assign(url);
              else { setGone(true); onSeeHangar(); }
            });
          }}
        >Get the Commission · {COMMISSION_PRICE}</button>
        <button
          className="cm-btn"
          onClick={() => {
            // Interest, not a no: recorded as a click, and still never shown again.
            answerCommissionAsk('clicked');
            logCommission('thanks-card', 'click');
            setGone(true);
            onSeeHangar();
          }}
        >See it in the Hangar</button>
        <button className="cm-btn cm-btn--quiet" onClick={close}>No thanks</button>
      </div>
    </aside>
  );
}
