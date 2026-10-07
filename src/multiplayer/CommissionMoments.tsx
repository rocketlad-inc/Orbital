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
  COMMISSION_DISCORD, COMMISSION_NO_GAMEPLAY, COMMISSION_EMBLEMS, COMMISSION_CITY_SKINS, COMMISSION_STATION_SKINS,
  COMMISSION_STRUCTURE_LOOKS,
  answerCommissionAsk, canBuyHere, logCommission,
} from './commission';
import { t, tk } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './CommissionMoments.css';

const FLEET: Array<[ShipIconClass, ShipIconVariant]> = [
  ['frigate', 'S'], ['destroyer', 'Y'], ['corvette', 'W'], ['freighter', 'V'],
];

/** The Commission's fixed phrases in the player's language. The constants in
 *  commission.ts are the English source (and what the English catalog must
 *  equal); tk() falls back to them when a catalog has no entry. */
function commissionPhrases() {
  return {
    lines: COMMISSION_LINES,
    name: tk('mp.commission.name', COMMISSION_NAME),
    discord: tk('mp.commission.discord', COMMISSION_DISCORD),
    noGameplay: tk('mp.commission.noGameplay', COMMISSION_NO_GAMEPLAY),
    price: tk('mp.commission.price', COMMISSION_PRICE),
  };
}

function commissionFacts(): string {
  return tk('mp.commission.facts', COMMISSION_FACTS, {
    ...commissionPhrases(),
    emblems: COMMISSION_EMBLEMS,
    city: COMMISSION_CITY_SKINS,
    station: COMMISSION_STATION_SKINS,
    looks: COMMISSION_STRUCTURE_LOOKS,
  });
}

const endgameKey = (gameId: string) => `orbital.commission.endgame.${gameId}`;

/**
 * Under the GAME OVER / VICTORY title. Only for a player whose empire
 * made it to the end (a loss after elimination is a setback, and a
 * setback is no moment to sell anything).
 */
export function EndgameCommission({ gameId, survived }: { gameId: string; survived: boolean }) {
  useI18n();
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
        <div className="cm-title">{t('mp.endgame.title')}</div>
        <div className="cm-body">
          {t('mp.endgame.body', commissionPhrases())}
        </div>
      </div>
      <div className="cm-actions">
        <button
          className="cm-btn cm-btn--go"
          onClick={() => {
            logCommission('endgame', 'click');
            void startCommissionCheckout('endgame').then(url => { if (url) window.location.assign(url); });
          }}
        >{t('mp.endgame.look')}</button>
        <button
          className="cm-btn"
          onClick={() => { logCommission('endgame', 'dismiss'); setGone(true); }}
        >{t('mp.endgame.notNow')}</button>
      </div>
    </div>
  );
}

/** The one-time thank-you card, at the top of the lobby. */
export function ThanksCard({ onSeeHangar }: { onSeeHangar: () => void }) {
  useI18n();
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
      <button className="cm-x" aria-label={t('mp.thanks.closeForGood')} onClick={close}>×</button>
      <div className="cm-fleet" aria-hidden>
        {FLEET.map(([cls, v]) => <ShipIcon key={cls} shipClass={cls} variant={v} size={34} />)}
      </div>
      <div className="cm-thanks__text">
        <h3 id="cm-thanks-title" className="cm-title">{t('mp.thanks.title')}</h3>
        <p className="cm-body">
          {t('mp.thanks.body', { ...commissionPhrases(), facts: commissionFacts() })}
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
        >{t('mp.commission.get', { price: tk('mp.commission.price', COMMISSION_PRICE) })}</button>
        <button
          className="cm-btn"
          onClick={() => {
            // Interest, not a no: recorded as a click, and still never shown again.
            answerCommissionAsk('clicked');
            logCommission('thanks-card', 'click');
            setGone(true);
            onSeeHangar();
          }}
        >{t('mp.thanks.hangar')}</button>
        <button className="cm-btn cm-btn--quiet" onClick={close}>{t('mp.thanks.noThanks')}</button>
      </div>
    </aside>
  );
}
