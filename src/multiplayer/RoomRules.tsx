// ============================================================
// RoomRules — the game's rules, folded to one line.
//
// Everyone sees the summary ("8 seats · 1-hour ticks · The Sol system") and
// can open the card to read the values. The HOST gets Edit instead of a
// chevron: it opens the fields the lobby always had (room name, max players,
// tick interval), Save changes, and Delete room as a quiet danger action at
// the bottom, where nobody hits it on the way to something else.
// ============================================================

import React, { useId } from 'react';
import { RoomFold } from './RoomFold';
import { IconSliders } from './RoomParts';
import {
  MAX_PLAYERS, MIN_PLAYERS, TICK_INTERVAL_OPTIONS, mapName, rulesSummary, tickLabel,
} from './roomLobbyModel';
import type { RuleFacts } from './roomLobbyModel';
import type { RoomSnapshot } from './api';
import { t, tk } from '../i18n/core';
import { useI18n } from '../i18n/react';

export interface RulesDraft {
  name: string;
  max: number;
  interval: number;
}

export function RoomRules({
  snap, facts, isHost, started, open, onToggle, draft, onDraft, onSave, onDelete, saved,
}: {
  snap: Pick<RoomSnapshot, 'settings' | 'custom_map'>;
  facts: RuleFacts;
  isHost: boolean;
  started: boolean;
  open: boolean;
  onToggle: () => void;
  draft: RulesDraft;
  onDraft: (next: RulesDraft) => void;
  onSave: () => void;
  onDelete: () => void;
  saved: boolean;
}) {
  useI18n();
  const nameId = useId();
  const maxId = useId();
  const speedId = useId();
  const editable = isHost && !started;
  return (
    <RoomFold
      icon={<IconSliders />}
      title={t('roomlobby.rules.title')}
      summary={rulesSummary(facts)}
      open={open}
      onToggle={onToggle}
      trailing={editable ? (open ? t('roomlobby.close') : t('roomlobby.edit')) : undefined}
    >
      <div className="rl-foldbody">
        {editable ? (
          <form className="rl-form" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
            <div className="rl-fld">
              <label htmlFor={nameId}>{t('roomlobby.roomName')}</label>
              <input
                id={nameId}
                className="rl-input"
                type="text"
                maxLength={60}
                value={draft.name}
                onChange={(e) => onDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="rl-kv">
              <div className="rl-fld">
                <label htmlFor={maxId}>{t('roomlobby.host.max')}</label>
                <input
                  id={maxId}
                  className="rl-input"
                  type="number"
                  inputMode="numeric"
                  min={MIN_PLAYERS}
                  max={MAX_PLAYERS}
                  value={draft.max}
                  onChange={(e) => onDraft({ ...draft, max: parseInt(e.target.value, 10) || MIN_PLAYERS })}
                />
              </div>
              <div className="rl-fld">
                <label htmlFor={speedId}>{t('roomlobby.host.interval')}</label>
                <select
                  id={speedId}
                  className="rl-input"
                  value={String(draft.interval)}
                  onChange={(e) => onDraft({ ...draft, interval: parseInt(e.target.value, 10) })}
                >
                  {TICK_INTERVAL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{tk(`roomlobby.tick.${o.value}`, o.label)}</option>
                  ))}
                </select>
              </div>
            </div>
            <p className="rl-hint">{t('roomlobby.rules.hint')}</p>
            <div className="rl-row">
              <button type="submit" className="rl-btn rl-btn--gold rl-btn--sm">{t('roomlobby.saveChanges')}</button>
              <span className="rl-saved" role="status">{saved ? t('roomlobby.saved') : ''}</span>
              <button type="button" className="rl-btn rl-btn--sm rl-btn--danger rl-row__end" onClick={onDelete}>
                {t('roomlobby.deleteRoom')}
              </button>
            </div>
          </form>
        ) : (
          <>
            <dl className="rl-kv rl-dl">
              <div><dt>{t('roomlobby.roomName')}</dt><dd>{snap.settings.name}</dd></div>
              <div><dt>{t('roomlobby.host.max')}</dt><dd>{snap.settings.max_players}</dd></div>
              <div><dt>{t('roomlobby.host.interval')}</dt><dd>{tickLabel(snap.settings.tick_interval_ms)}</dd></div>
              <div><dt>{t('roomlobby.map')}</dt><dd>{mapName(snap)}</dd></div>
            </dl>
            {!started && <p className="rl-hint">{t('roomlobby.rules.readonly')}</p>}
          </>
        )}
      </div>
    </RoomFold>
  );
}
