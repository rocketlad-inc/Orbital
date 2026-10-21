// ============================================================
// RoomMapPane — the phone's Map tab: the starting-system map in a pane, and a
// card under it saying which world is yours.
//
// On a wide screen the map is the stage behind the whole lobby; on a phone
// there is no room for both, so it is a tab of its own. It is the same
// LobbyMapPreview (drag to pan, pinch to zoom, tap a free world to claim it),
// drawn in place instead of as the backdrop. The card-grid picker in "Your
// empire" is still there as the other way to pick.
// ============================================================

import React from 'react';
import type { RoomSnapshot } from './api';
import { LobbyMapPreview } from './LobbyMapPreview';
import { RoomFlag } from './RoomParts';
import type { LobbyPlayer } from './roomLobbyModel';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';

export function RoomMapPane({ snap, viewerId, myChoice, me, onPickBody }: {
  snap: RoomSnapshot;
  viewerId?: string;
  myChoice: string | null;
  /** The viewer's row; null for someone watching, who gets the map only. */
  me: LobbyPlayer | null;
  onPickBody?: (bodyId: string) => void;
}) {
  useI18n();
  return (
    <div className="rl-mappane">
      <div className="rl-mapview" role="region" aria-label={t('roomlobby.map.aria')}>
        <LobbyMapPreview
          snap={snap} myUserId={viewerId} focusBodyId={myChoice} inline
          hint={t('roomlobby.map.hintTouch')} onPickBody={onPickBody}
        />
      </div>
      {me && (
        <section className="rl-panel rl-you rl-mapcard" aria-label={t('roomlobby.map.title')}>
          <div className="rl-eyebrow">{t('roomlobby.map.title')}</div>
          <div className="rl-you__row">
            <RoomFlag color={me.color} color2={me.color2} emblem={me.emblem} fallbackKey={me.userId} size={44} className="rl-you__fl" />
            <div className="rl-you__who">
              <div className="rl-you__nm">{me.world ?? t('roomlobby.map.pick')}</div>
              <div className="rl-you__sub" aria-live="polite">
                {me.world
                  ? t('roomlobby.map.subSet', { name: me.empire ?? me.name })
                  : t('roomlobby.map.subNone')}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
