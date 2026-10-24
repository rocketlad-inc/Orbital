// ============================================================
// RoomPlayers — one row per player, then a quiet placeholder per open seat.
//
// A row reads: flag, EMPIRE name (the thing you will meet in the game), then
// the player's own name with HOST / YOU tags and the Commission mark, where
// they start, a one-line note that opens when tapped, and whether they are
// ready. The host gets a small actions menu per row (remove from room, which
// still asks before it does anything) instead of a loud button on every line.
// ============================================================

import React from 'react';
import { HOLDER_MARK } from './commission';
import { RoomMenu } from './RoomMenu';
import { ClampText, IconCheck, IconDash, IconDotsV, RoomFlag, SrOnly } from './RoomParts';
import type { LobbyPlayer } from './roomLobbyModel';
import { t, tn } from '../i18n/core';
import { useI18n } from '../i18n/react';

export function RoomPlayers({ players, maxPlayers, canManage, onKick }: {
  players: LobbyPlayer[];
  maxPlayers: number;
  /** The viewer is the host and the match has not started. */
  canManage: boolean;
  onKick: (userId: string, name: string) => void;
}) {
  useI18n();
  const openSeats = Math.max(0, maxPlayers - players.length);
  return (
    <section className="rl-panel rl-sec" aria-labelledby="rl-players-h">
      <div className="rl-sec__head">
        <h2 className="rl-h2" id="rl-players-h">{t('roomlobby.players.title')}</h2>
        <span className="rl-meta">{tn('roomlobby.players.seats', maxPlayers, { count: players.length })}</span>
      </div>
      <ul className="rl-plist">
        {players.map((p) => (
          <li key={p.userId} className={`rl-prow ${p.ready ? '' : 'is-wait'}`}>
            <span className="rl-prow__flag">
              <RoomFlag color={p.color} color2={p.color2} emblem={p.emblem} fallbackKey={p.userId} size={42} />
              <span className={`rl-online ${p.online ? 'is-on' : ''}`} aria-hidden="true" />
            </span>
            <div className="rl-prow__main">
              <div className={`rl-emp ${p.empire ? '' : 'is-none'}`}>{p.empire ?? t('roomlobby.row.noEmpire')}</div>
              <div className="rl-who">
                <b>{p.name}</b>
                {p.isHost && <span className="rl-tag rl-tag--host">{t('roomlobby.hostTag')}</span>}
                {p.isMe && <span className="rl-tag">{t('roomlobby.row.you')}</span>}
                {p.commissioned && (
                  <span
                    className="rl-holder"
                    title={t('faction.holderTitle', { name: t('hangar.commissionName') })}
                    aria-label={t('faction.holderTitle', { name: t('hangar.commissionName') })}
                  >{HOLDER_MARK}</span>
                )}
                <span className="rl-world">{p.world ? t('roomlobby.row.starts', { world: p.world }) : t('roomlobby.row.noWorld')}</span>
                <SrOnly>{p.online ? t('roomlobby.row.online') : t('roomlobby.row.offline')}</SrOnly>
              </div>
              {p.bio && <ClampText text={p.bio} />}
            </div>
            <div className="rl-prow__side">
              <span
                className={`rl-rdy ${p.ready ? 'is-on' : ''}`}
                title={p.ready ? t('roomlobby.row.ready') : t('roomlobby.row.notReady')}
              >
                {p.ready ? <IconCheck /> : <IconDash />}
                <SrOnly>{p.ready ? t('roomlobby.row.ready') : t('roomlobby.row.notReady')}</SrOnly>
              </span>
              {canManage && !p.isHost && (
                <RoomMenu
                  label={t('roomlobby.row.actions', { name: p.name })}
                  icon={<IconDotsV />}
                  className="rl-menu--row"
                  items={[{
                    key: 'remove',
                    label: t('roomlobby.row.remove'),
                    danger: true,
                    onSelect: () => onKick(p.userId, p.name),
                  }]}
                />
              )}
            </div>
          </li>
        ))}
        {Array.from({ length: openSeats }, (_, i) => (
          <li key={`open-${i}`} className="rl-prow is-open">
            <span className="rl-prow__flag"><span className="rl-flag rl-flag--none" style={{ width: 42, height: 42 }} aria-hidden="true" /></span>
            <div className="rl-prow__main"><div className="rl-emp is-none">{t('roomlobby.pip.open')}</div></div>
            <div className="rl-prow__side" />
          </li>
        ))}
      </ul>
    </section>
  );
}
