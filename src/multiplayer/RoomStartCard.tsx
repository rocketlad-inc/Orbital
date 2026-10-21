// ============================================================
// RoomStartCard — where we stand, and the ONE thing to do next.
//
// First on the screen, always. Phase and privacy chips, the seats as pips (a
// flag each, a tick when ready, a star on the host), one headline and one
// detail line (words from roomLobbyModel), the room's facts, a single primary
// action (host: Start match; player: I am ready) and the invite code with its
// copy action. Everything else on the screen is a step down from this.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { InviteGift } from './InviteCard';
import { shareInvite } from './invite';
import { IconCheck, IconLock, RoomFlag } from './RoomParts';
import type { LobbyPlayer, RuleFacts, StartCardModel } from './roomLobbyModel';
import { useIsMobile } from '../hooks/useIsMobile';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';

type ShareState = 'idle' | 'shared' | 'copied' | 'failed';

export function RoomStartCard({
  model, players, maxPlayers, facts, started, hasPassword,
  inviteCode, roomName, viewerId, onStart, onToggleReady,
}: {
  model: StartCardModel;
  players: LobbyPlayer[];
  maxPlayers: number;
  facts: RuleFacts;
  started: boolean;
  /** A password-protected room: shown as "Private game", and the code carries a lock. */
  hasPassword: boolean;
  inviteCode: string | null;
  roomName: string;
  viewerId?: string;
  onStart: () => void;
  onToggleReady: () => void;
}) {
  useI18n();
  const isMobile = useIsMobile();
  const [share, setShare] = useState<ShareState>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const doShare = async () => {
    if (!inviteCode) return;
    const r = await shareInvite({
      code: inviteCode,
      byUserId: viewerId,
      roomName,
      text: t('invite.text', { room: roomName || 'Orbital' }),
      where: 'lobby',
      isMobile,
    });
    setShare(r);
    window.clearTimeout(timer.current);
    if (r !== 'failed') timer.current = window.setTimeout(() => setShare('idle'), 2200);
  };

  const openSeats = Math.max(0, maxPlayers - players.length);
  const prettyCode = inviteCode ? (inviteCode.match(/.{1,4}/g)?.join('-') ?? inviteCode) : null;
  const reasonId = 'rl-start-reason';

  return (
    <section className="rl-panel rl-start" aria-label={t('roomlobby.start.region')}>
      <div className="rl-start__top">
        <span className="rl-chip rl-chip--gold"><span className="rl-chip__dot" />{model.phase}</span>
        {hasPassword && (
          <span className="rl-chip"><IconLock />{t('roomlobby.private')}</span>
        )}
      </div>

      <ul className="rl-pips" aria-label={t('roomlobby.seats.aria')}>
        {players.map((p) => (
          <li
            key={p.userId}
            className={`rl-pip ${p.ready ? '' : 'is-wait'}`}
            aria-label={p.isHost
              ? t('roomlobby.pip.host', { name: p.name })
              : t(p.ready ? 'roomlobby.pip.ready' : 'roomlobby.pip.notReady', { name: p.name })}
            title={p.name}
          >
            <RoomFlag color={p.color} color2={p.color2} emblem={p.emblem} fallbackKey={p.userId} size={42} className="rl-pip__fl" />
            {p.isHost && <span className="rl-pip__star" aria-hidden="true">&#9733;</span>}
            {p.ready && <span className="rl-pip__ck" aria-hidden="true"><IconCheck /></span>}
          </li>
        ))}
        {Array.from({ length: openSeats }, (_, i) => (
          <li key={`open-${i}`} className="rl-pip is-open" aria-label={t('roomlobby.pip.open')} title={t('roomlobby.pip.open')}>
            <span className="rl-flag rl-flag--none rl-pip__fl" style={{ width: 42, height: 42 }} aria-hidden="true" />
          </li>
        ))}
      </ul>

      <div>
        <h2 className="rl-verdict">{model.headline}</h2>
        <p className="rl-detail" aria-live="polite">{model.detail}</p>
      </div>

      <div className="rl-facts">
        <span className="rl-chip"><b>{facts.speed}</b></span>
        <span className="rl-chip"><b>{facts.map}</b></span>
        <span className="rl-chip"><b>{facts.seats}</b></span>
      </div>

      {model.viewer === 'host' && !started && (
        <>
          <button
            type="button"
            className="rl-btn rl-btn--gold rl-btn--block"
            disabled={!model.canStart}
            aria-describedby={model.startReason ? reasonId : undefined}
            title={model.startReason ?? undefined}
            onClick={onStart}
          >
            {t('roomlobby.host.start')}
          </button>
          {model.startReason && <p id={reasonId} className="rl-reason">{model.startReason}</p>}
        </>
      )}
      {model.viewer === 'player' && !started && (
        <>
          <button
            type="button"
            className={`rl-btn rl-btn--block ${model.iAmReady ? 'rl-btn--teal' : 'rl-btn--gold'}`}
            aria-pressed={model.iAmReady}
            onClick={onToggleReady}
          >
            {model.iAmReady && <IconCheck />}
            {model.iAmReady ? t('roomlobby.youReady') : t('roomlobby.imReady')}
          </button>
          {model.iAmReady && <p className="rl-reason">{t('roomlobby.readyUndo')}</p>}
        </>
      )}

      {prettyCode && !started && (
        <div className="rl-invite">
          <div className="rl-invite__row">
            <div className="rl-invite__code-wrap">
              <div className="rl-invite__lbl">
                {t('roomlobby.invite.label')}
                {hasPassword && (
                  <span className="rl-invite__lock" title={t('roomlobby.invite.locked')}>
                    <IconLock /><span className="rl-sr">{t('roomlobby.invite.locked')}</span>
                  </span>
                )}
              </div>
              <div className="rl-invite__code">{prettyCode}</div>
            </div>
            <button type="button" className="rl-btn rl-btn--sm rl-btn--quiet" onClick={() => void doShare()}>
              {share === 'shared' ? t('invite.card.shared')
                : share === 'copied' ? t('invite.card.copied')
                : share === 'failed' ? t('invite.card.failed')
                : isMobile ? t('roomlobby.invite.shareLink') : t('roomlobby.invite.copyLink')}
            </button>
          </div>
          <span className="rl-sr" role="status">
            {share === 'copied' ? t('invite.card.copied') : share === 'shared' ? t('invite.card.shared') : ''}
          </span>
          {openSeats > 0 && <InviteGift className="rl-invite__gift" />}
        </div>
      )}
    </section>
  );
}
