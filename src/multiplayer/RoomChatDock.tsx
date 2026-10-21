// ============================================================
// RoomChatDock — desktop chat, always on the map.
//
// The owner's review: "the chat is really buried now". So on a wide screen the
// chat is not a fold in the panel; it is a dock at the bottom-left of the map
// stage, open by default, with the input always visible. It can be minimised
// to a small pill (with an unread badge) when the map needs the room; that
// choice is remembered for the tab (sessionStorage). The chat's lines, history
// and sending are RoomDetail's, exactly as before; this only frames them.
// ============================================================

import React from 'react';
import { RoomChat } from './RoomChat';
import { IconChat } from './RoomParts';
import { badgeText } from './roomLobbyModel';
import type { ChatLine } from './roomLobbyModel';
import { t, tn } from '../i18n/core';
import { useI18n } from '../i18n/react';

const MIN_KEY = 'orbital.roomChatMin';

/** The remembered minimised state (this tab only). */
export function readChatMin(): boolean {
  try { return sessionStorage.getItem(MIN_KEY) === '1'; } catch { return false; }
}
export function writeChatMin(min: boolean): void {
  try { sessionStorage.setItem(MIN_KEY, min ? '1' : '0'); } catch { /* private window */ }
}

export function RoomChatDock({ log, viewerId, draft, onDraft, onSend, inRoom, minimised, onToggle, unread }: {
  log: ChatLine[];
  viewerId?: string;
  draft: string;
  onDraft: (v: string) => void;
  onSend: (e: React.FormEvent) => void;
  /** Players in the room, for "8 in the room". */
  inRoom: number;
  minimised: boolean;
  onToggle: () => void;
  unread: number;
}) {
  useI18n();
  return (
    <>
      {minimised && (
        <button
          type="button"
          className="rl-chatpill"
          aria-expanded={false}
          aria-label={unread > 0 ? `${t('roomlobby.chat.open')}: ${tn('roomlobby.chat.unread', unread)}` : t('roomlobby.chat.open')}
          onClick={onToggle}
        >
          <IconChat />
          <span>{t('roomlobby.tab.chat')}</span>
          {unread > 0 && <span className="rl-badge">{badgeText(unread)}</span>}
        </button>
      )}
      {/* Stays mounted while minimised so a half-typed line survives. */}
      <section className="rl-chatdock" aria-label={t('roomlobby.chat')} hidden={minimised}>
        <div className="rl-chatdock__hd">
          <b>{t('roomlobby.tab.chat')}</b>
          <span>{t('roomlobby.chat.inRoom', { n: inRoom })}</span>
          <button
            type="button"
            className="rl-ibtn rl-ibtn--sm"
            aria-label={t('roomlobby.chat.minimise')}
            aria-expanded={!minimised}
            onClick={onToggle}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 15l6-6 6 6" /></svg>
          </button>
        </div>
        <RoomChat log={log} viewerId={viewerId} draft={draft} onDraft={onDraft} onSend={onSend} active={!minimised} />
      </section>
    </>
  );
}
