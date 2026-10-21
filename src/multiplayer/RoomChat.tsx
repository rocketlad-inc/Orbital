// ============================================================
// RoomChat — the lobby chat: the desktop dock's body and the phone's Chat tab.
//
// The log and the composer are the same ones the lobby always had (lines
// arrive over the room WebSocket; RoomDetail owns the log and the send). This
// only draws them: a scrolling log that stays pinned to the newest line and a
// 16px composer (anything smaller makes iOS zoom the page on focus).
// ============================================================

import React, { useEffect, useRef } from 'react';
import type { ChatLine } from './roomLobbyModel';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';

export function RoomChat({ log, viewerId, draft, onDraft, onSend, active, className }: {
  log: ChatLine[];
  viewerId?: string;
  draft: string;
  onDraft: (v: string) => void;
  onSend: (e: React.FormEvent) => void;
  /** The chat is on screen: re-pin to the newest line (a hidden box cannot scroll). */
  active: boolean;
  className?: string;
}) {
  useI18n();
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el && active) el.scrollTop = el.scrollHeight;
  }, [log, active]);

  return (
    <div className={`rl-chat ${className ?? ''}`}>
      <div className="rl-chat__log" ref={scroller} role="log" aria-label={t('roomlobby.chat')}>
        {log.length === 0 ? (
          <div className="rl-empty">{t('roomlobby.chat.emptyHello')}</div>
        ) : (
          log.map((m) => {
            const mine = !!viewerId && m.from.userId === viewerId;
            return (
              <div key={m.key} className={`rl-chat__line ${mine ? 'is-mine' : ''}`}>
                <span className="rl-chat__who">{mine ? t('roomlobby.chat.you') : m.from.displayName}</span>
                <span className="rl-chat__text">{m.text}</span>
              </div>
            );
          })
        )}
      </div>
      <form className="rl-chat__composer" onSubmit={onSend}>
        <input
          className="rl-input"
          type="text"
          maxLength={500}
          aria-label={t('roomlobby.chat.placeholder')}
          placeholder={t('roomlobby.chat.placeholder')}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
        />
        <button type="submit" className="rl-btn rl-btn--gold rl-btn--sm" disabled={!draft.trim()}>
          {t('roomlobby.chat.send')}
        </button>
      </form>
    </div>
  );
}
