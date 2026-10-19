// ============================================================
// DiscoveryOfferCard — a found ship waits for a yes (MP only).
//
// Lorne, 2026-10-18: "We need to add an option to refuse a structure/craft
// a player discovers. Sometimes they can't afford it." A derelict
// destroyer or an ancient capital ship no longer joins the fleet the
// moment a ship parks: it waits here, with what it would add to the
// fleet's bill each tick, until the player claims or refuses it
// (worker/discoveryOffers.js). Unanswered, it is claimed for them when
// the deadline passes, as finds always were.
//
// "Later" tucks the card away; the situation log keeps a row that brings
// it back (event 'orbital:discovery-offer').
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import type { DiscoveryOffer } from '../types';
import { t, type Key } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './DiscoveryBanner.css';
import './DiscoveryOfferCard.css';

/** "1 metal + 1 credit", "6 metal + 6 credits", in the player's words. */
export function upkeepText(u: { credits: number; ore: number }): string {
  const parts: string[] = [];
  const fmt = (n: number) => (Math.round(n * 100) / 100).toString();
  if (u.ore > 0) parts.push(t('discovery.offer.metal', { n: fmt(u.ore) }));
  if (u.credits > 0) parts.push(t(u.credits === 1 ? 'discovery.offer.credit' : 'discovery.offer.credits', { n: fmt(u.credits) }));
  return parts.length ? parts.join(' + ') : t('discovery.offer.nothing');
}

export function offerTitle(o: DiscoveryOffer): string {
  return t(`discovery.offer.ship.${o.shipClass}` as Key);
}

export const DiscoveryOfferCard: React.FC = () => {
  useI18n();
  const { gameState, selectBody, focusBody } = useGameContext();
  const actions = useMultiplayerActions();
  const offers = useMemo(() => gameState.discoveryOffers ?? [], [gameState.discoveryOffers]);
  /** Offers tucked away with "Later", by body id. */
  const [later, setLater] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<'claim' | 'refuse' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The situation log's row brings a tucked-away offer back.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ bodyId?: string }>).detail?.bodyId;
      setLater(s => {
        if (!s.size) return s;
        const next = new Set(s);
        if (id) next.delete(id); else next.clear();
        return next;
      });
    };
    window.addEventListener('orbital:discovery-offer', onOpen);
    return () => window.removeEventListener('orbital:discovery-offer', onOpen);
  }, []);

  const shown = offers.filter(o => !later.has(o.bodyId));
  const current = shown[0];
  // A new offer (or a settled one) clears any stale error.
  useEffect(() => { setError(null); }, [current?.bodyId]);
  if (!actions || !current) return null;

  const tick = gameState.currentTick ?? 0;
  const left = Math.max(0, current.expiresTick - tick);
  const fleet = gameState.fleetUpkeep;
  const answer = async (verb: 'claim' | 'refuse') => {
    setBusy(verb);
    setError(null);
    const res = verb === 'claim'
      ? await actions.claimDiscovery(current.bodyId)
      : await actions.refuseDiscovery(current.bodyId);
    setBusy(null);
    if (!res.ok) setError(res.error ?? t('discovery.offer.failed'));
  };
  const goThere = () => { selectBody(current.bodyId); focusBody(current.bodyId); };

  return (
    <div className="discovery-banner-layer discovery-offer-layer" aria-live="polite">
      <div className="discovery-banner discovery-banner--mine discovery-offer" role="dialog"
        aria-label={t('discovery.offer.aria', { ship: offerTitle(current), body: current.bodyName })}>
        <span className="discovery-banner__glyph" aria-hidden>✦</span>
        <div className="discovery-banner__body">
          <div className="discovery-banner__head">
            {t('discovery.offer.head')}
            <button type="button" className="discovery-offer__where" onClick={goThere}> · {current.bodyName}</button>
            {shown.length > 1 && <span className="discovery-offer__count"> · {t('discovery.offer.count', { i: 1, n: shown.length })}</span>}
          </div>
          <div className="discovery-banner__title">{offerTitle(current)}</div>
          <p className="discovery-offer__text">
            {t('discovery.offer.claimLine', { cost: upkeepText(current.upkeep) })}
            {fleet && (fleet.credits > 0 || fleet.ore > 0) && (
              <> {t('discovery.offer.fleetNow', { cost: upkeepText(fleet) })}</>
            )}
          </p>
          <p className="discovery-offer__text">{t('discovery.offer.refuseLine')}</p>
          <p className="discovery-offer__due">{t('discovery.offer.due', { tick: current.expiresTick, n: left })}</p>
          {error && <p className="discovery-offer__error" role="alert">{error}</p>}
          <div className="discovery-offer__actions">
            <button type="button" className="discovery-offer__btn is-claim" disabled={busy !== null} onClick={() => answer('claim')}>
              {busy === 'claim' ? '…' : t('discovery.offer.claim')}
            </button>
            <button type="button" className="discovery-offer__btn is-refuse" disabled={busy !== null} onClick={() => answer('refuse')}>
              {busy === 'refuse' ? '…' : t('discovery.offer.refuse')}
            </button>
            <button type="button" className="discovery-offer__btn is-later" disabled={busy !== null}
              onClick={() => setLater(s => new Set(s).add(current.bodyId))}>
              {t('discovery.offer.later')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DiscoveryOfferCard;
