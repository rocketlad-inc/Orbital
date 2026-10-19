// ============================================================
// InviteCard — "Invite friends", where a host wants it.
//
// Shown at the two moments a player has just chosen to gather people:
// the screen right after creating a room, and the room's lobby while
// seats are empty (Oct 19 insight report, Invites ideas 2, 3 and 6).
// Nothing here appears mid-play or on its own; it sits where the
// invite code always sat, only now it hands out a link that opens
// straight into the game, with no password to pass along.
//
// The gift line is the Commission's quietest surface: a friend you are
// pulling into a game is the natural person to give it to. The app sells
// nothing itself: there the button opens the phone's browser, which
// starts the gift checkout (commissionHandoff), as every storefront does.
// ============================================================

import React, { useEffect, useState } from 'react';
import { startCommissionCheckout } from './api';
import { useAuth } from './AuthContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { shareInvite, InviteWhere } from './invite';
import { canBuyHere, logCommission, openCommissionInBrowser, COMMISSION_NAME, COMMISSION_PRICE } from './commission';
import { t, tk } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './InviteCard.css';

export function InviteCard({ code, roomName, taken, max, where }: {
  code: string;
  roomName?: string | null;
  /** Seats taken and the room's size; the card says how many are free. */
  taken?: number;
  max?: number;
  where: Extract<InviteWhere, 'created' | 'lobby'>;
}) {
  useI18n();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [state, setState] = useState<'idle' | 'shared' | 'copied' | 'failed'>('idle');
  const [opening, setOpening] = useState(false);
  // A holder can still gift (that is the point), so there is no holder
  // check; in the app the button links out to the browser instead.
  const sellable = canBuyHere();
  useEffect(() => { logCommission('invite', 'view'); }, []);

  const share = async () => {
    const r = await shareInvite({
      code,
      byUserId: user?.id,
      roomName,
      text: t('invite.text', { room: roomName || 'Orbital' }),
      where,
      isMobile,
    });
    setState(r);
    if (r !== 'failed') setTimeout(() => setState('idle'), 2200);
  };

  const gift = async () => {
    if (!sellable) { openCommissionInBrowser('invite', { gift: true }); return; }
    setOpening(true);
    logCommission('invite', 'click');
    const url = await startCommissionCheckout('invite', { gift: true });
    if (url) { window.location.assign(url); return; }
    setOpening(false);
  };

  const free = taken != null && max != null ? Math.max(0, max - taken) : null;
  const pretty = code.match(/.{1,4}/g)?.join('-') ?? code;

  return (
    <section className="ic" aria-labelledby={`ic-title-${where}`}>
      <div className="ic-head">
        <h3 id={`ic-title-${where}`} className="ic-title">{t('invite.card.title')}</h3>
        {free != null && free > 0 && (
          <span className="ic-seats">{t('invite.card.seats', { free, max: max ?? 0 })}</span>
        )}
      </div>
      <p className="ic-body">{t('invite.card.body')}</p>
      <div className="ic-row">
        <button type="button" className="ic-btn ic-btn--go" onClick={() => void share()}>
          {state === 'shared' ? t('invite.card.shared')
            : state === 'copied' ? t('invite.card.copied')
            : state === 'failed' ? t('invite.card.failed')
            : t('invite.card.share')}
        </button>
        <span className="ic-code" title={t('invite.card.codeTip')}>
          {t('invite.card.code')} <b>{pretty}</b>
        </span>
      </div>
      <div className="ic-gift">
        <span>{t('invite.card.gift', { name: tk('mp.commission.name', COMMISSION_NAME) })}</span>
        <button type="button" className="ic-btn ic-btn--gift" disabled={opening} onClick={() => void gift()}>
          {opening ? t('invite.card.opening') : t('invite.card.giftBtn', { price: tk('mp.commission.price', COMMISSION_PRICE) })}
        </button>
      </div>
    </section>
  );
}
