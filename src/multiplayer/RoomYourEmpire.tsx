// ============================================================
// RoomYourEmpire — one calm row about the viewer's own empire.
//
// Flag, name, starting world and an Edit button. It only gets loud when
// something is missing: the card turns gold, the button says "Set up", and a
// checklist names what is left (name / flag / starting world; captains are
// optional). Edit / Set up opens the editor IN PLACE under the row, the same
// controls the lobby always had (RoomEmpireEditor, passed as children), not a
// new page.
// ============================================================

import React, { useId } from 'react';
import { IconAlert, IconCheck, IconDash, RoomFlag, SrOnly } from './RoomParts';
import type { EmpireModel, LobbyPlayer } from './roomLobbyModel';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';

export function RoomYourEmpire({ me, model, open, onToggle, wide, onPickOnMap, children }: {
  me: LobbyPlayer;
  model: EmpireModel;
  open: boolean;
  onToggle: () => void;
  /** Desktop: the map is on screen beside the panel, so the world line is a
   *  hint. Phone: it offers a button that switches to the Map tab. */
  wide: boolean;
  onPickOnMap: () => void;
  /** The editor. Stays mounted while closed so unsaved typing survives. */
  children: React.ReactNode;
}) {
  useI18n();
  const editorId = useId();
  return (
    <section className={`rl-panel rl-you ${model.unfinished ? 'is-todo' : ''}`} aria-label={t('roomlobby.empire')}>
      <div className="rl-eyebrow">{t('roomlobby.empire')}</div>
      <div className="rl-you__row">
        <RoomFlag color={me.color} color2={me.color2} emblem={me.emblem} fallbackKey={me.userId} size={48} className="rl-you__fl" />
        <div className="rl-you__who">
          <div className={`rl-you__nm ${model.hasName ? '' : 'is-need'}`}>{model.title}</div>
          <div className="rl-you__sub">{model.sub}</div>
        </div>
        <button
          type="button"
          className={`rl-btn rl-btn--sm ${model.unfinished ? 'rl-btn--gold' : 'rl-btn--quiet'}`}
          aria-expanded={open}
          aria-controls={editorId}
          onClick={onToggle}
        >
          {open ? t('roomlobby.close') : model.unfinished ? t('roomlobby.you.setup') : t('roomlobby.edit')}
        </button>
      </div>
      {model.unfinished && (
        <ul className="rl-check">
          {model.checks.map((c) => (
            <li key={c.key} className={c.state === 'todo' ? 'is-no' : ''}>
              {c.state === 'done' ? <IconCheck /> : c.state === 'todo' ? <IconAlert /> : <IconDash />}
              {c.label}
              {c.state !== 'optional' && <SrOnly>{c.state === 'done' ? t('roomlobby.check.done') : t('roomlobby.check.todo')}</SrOnly>}
            </li>
          ))}
        </ul>
      )}
      <div className="rl-you__world">
        <span>
          {model.world
            ? t(wide ? 'roomlobby.you.worldSet' : 'roomlobby.you.worldSetShort', { world: model.world })
            : t(wide ? 'roomlobby.you.worldNone' : 'roomlobby.you.worldNoneShort')}
        </span>
        {!wide && (
          <button type="button" className="rl-btn rl-btn--sm rl-btn--quiet" onClick={onPickOnMap}>
            {t('roomlobby.you.pickOnMap')}
          </button>
        )}
      </div>
      <div id={editorId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
