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
import { apiFetch, startCommissionCheckout } from './api';
import { useAuth } from './AuthContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { shareInvite, InviteWhere } from './invite';
import { canBuyHere, logCommission, openCommissionInBrowser, COMMISSION_NAME, COMMISSION_PRICE } from './commission';
import { t, tk } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './InviteCard.css';

/**
 * The gift line: "Bring a friend in style: give them the Commission", with
 * its button. One component so the new-room card and the room lobby's start
 * card sell it the same way (and log the same view/click for the funnel).
 */
export function InviteGift({ className }: { className?: string }) {
  useI18n();
  const [opening, setOpening] = useState(false);
  // A holder can still gift (that is the point), so there is no holder
  // check; in the app the button links out to the browser instead.
  const sellable = canBuyHere();
  useEffect(() => { logCommission('invite', 'view'); }, []);

  const gift = async () => {
    if (!sellable) { openCommissionInBrowser('invite', { gift: true }); return; }
    setOpening(true);
    logCommission('invite', 'click');
    const url = await startCommissionCheckout('invite', { gift: true });
    if (url) { window.location.assign(url); return; }
    setOpening(false);
  };

  return (
    <div className={`ic-gift ${className ?? ''}`}>
      <span>{t('invite.card.gift', { name: tk('mp.commission.name', COMMISSION_NAME) })}</span>
      <button type="button" className="ic-btn ic-btn--gift" disabled={opening} onClick={() => void gift()}>
        {opening ? t('invite.card.opening') : t('invite.card.giftBtn', { price: tk('mp.commission.price', COMMISSION_PRICE) })}
      </button>
    </div>
  );
}

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
      <InviteGift />
    </section>
  );
}

/** How long a private lobby sits with only its host before we offer to
 *  open it. Long enough that friends had their chance. */
export const LONELY_LOBBY_MS = 3 * 3600 * 1000;

/**
 * A host alone in a private lobby for hours: offer to open the seats to
 * everyone (Oct 19 insight report, Invites idea 4). One tap removes the
 * password, so Browse lists the room and Quick Join can fill it. Shown
 * only to the host, only then; nothing happens without the tap.
 */
export function LonelyLobbyCard({ roomId, onOpened }: { roomId: string; onOpened: () => void }) {
  useI18n();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const open = async () => {
    setBusy(true);
    const res = await apiFetch(`/api/lobby/rooms/${roomId}/open-seats`, { method: 'POST' });
    setBusy(false);
    if (res.ok) { setDone(true); onOpened(); }
  };
  return (
    <section className="ic ic--lonely" aria-labelledby="ic-lonely-title">
      <h3 id="ic-lonely-title" className="ic-title">{t('roomlobby.lonely.title')}</h3>
      <p className="ic-body">{done ? t('roomlobby.lonely.done') : t('roomlobby.lonely.body')}</p>
      {!done && (
        <div className="ic-row">
          <button type="button" className="ic-btn ic-btn--go" disabled={busy} onClick={() => void open()}>
            {busy ? t('roomlobby.lonely.opening') : t('roomlobby.lonely.open')}
          </button>
        </div>
      )}
    </section>
  );
}
