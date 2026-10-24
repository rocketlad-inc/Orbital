// ============================================================
// The Play for Free trial, in the game (Lorne, 2026-10-24).
//
// Mounted by GameUI only in a trial game (gameState.solo.trial):
//   - starts the trial tutorial track by itself, once per browser;
//   - asks the player to save, each at most once per account:
//       LEAVING  the first try at leaving the page: the mouse heading
//                for the tabs (our own sheet), or a close/navigate (the
//                browser's own "Leave site?", the only thing it allows);
//       TIME     after ten minutes of play (time the tab is visible);
//   - the moment the Warlord declares war, a card says what that means.
// The menu entry (TopBar) opens the same sheet whenever they like.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../AuthContext';
import { useGameContext } from '../../state/gameContext';
import { useTutorial } from '../../state/tutorial';
import { openSaveEmpire } from './SaveEmpire';
import { t } from '../../i18n/core';
import { useI18n } from '../../i18n/react';
import './trial.css';

/** Play time before the save prompt, ms (his pick: ten minutes). */
export const SAVE_PROMPT_AFTER_MS = 10 * 60_000;

type Asked = { leave?: boolean; time?: boolean; war?: boolean; playedMs?: number };
const keyFor = (uid: string) => `orbital.trial.${uid}`;
function readAsked(uid: string): Asked {
  try { return JSON.parse(localStorage.getItem(keyFor(uid)) ?? '{}') as Asked; } catch { return {}; }
}
function writeAsked(uid: string, a: Asked) {
  try { localStorage.setItem(keyFor(uid), JSON.stringify(a)); } catch { /* private mode */ }
}

export function TrialLayer() {
  useI18n();
  const { user } = useAuth();
  const { gameState } = useGameContext();
  const { active, trialDone, startTrial } = useTutorial();
  const uid = user?.id ?? '';
  const shadow = !!user?.shadow;
  const askedRef = useRef<Asked>(uid ? readAsked(uid) : {});
  const [warWith, setWarWith] = useState<string | null>(null);

  useEffect(() => { askedRef.current = uid ? readAsked(uid) : {}; }, [uid]);
  const mark = (patch: Asked) => {
    askedRef.current = { ...askedRef.current, ...patch };
    if (uid) writeAsked(uid, askedRef.current);
  };

  // The trial tutorial: by itself, once the map has had a moment to land.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || trialDone || active) return;
    startedRef.current = true;
    const timer = setTimeout(() => startTrial(), 1200);
    return () => clearTimeout(timer);
  }, [trialDone, active, startTrial]);

  // LEAVING, first time only.
  useEffect(() => {
    if (!shadow) return;
    const onLeaveIntent = (e: MouseEvent) => {
      if (askedRef.current.leave || e.clientY > 0 || e.relatedTarget) return;
      mark({ leave: true });
      openSaveEmpire('leaving');
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (askedRef.current.leave) return;
      mark({ leave: true });
      e.preventDefault();
      e.returnValue = '';
    };
    document.addEventListener('mouseout', onLeaveIntent);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('mouseout', onLeaveIntent);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shadow, uid]);

  // TIME: ten minutes of the tab being in view, kept across reloads. Not
  // in the middle of a tutorial step: it waits for the tour to finish.
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (!shadow) return;
    const STEP = 5_000;
    const iv = setInterval(() => {
      if (document.visibilityState !== 'visible' || askedRef.current.time) return;
      const played = (askedRef.current.playedMs ?? 0) + STEP;
      mark({ playedMs: played });
      if (played >= SAVE_PROMPT_AFTER_MS && !activeRef.current) {
        mark({ time: true });
        openSaveEmpire('time');
      }
    }, STEP);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shadow, uid]);

  // WAR: the first declaration on the player, once.
  useEffect(() => {
    if (askedRef.current.war) return;
    const pair = (gameState.warPairs ?? []).find(p => p.split('|').includes('player'));
    if (!pair) return;
    const other = pair.split('|').find(x => x !== 'player') ?? null;
    mark({ war: true });
    setWarWith(other);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.warPairs]);

  if (!warWith) return null;
  const foe = gameState.factions.find(f => f.id === warWith);
  return createPortal(
    <div className="trial-war" role="dialog" aria-modal="true" aria-labelledby="trial-war-title">
      <div className="trial-war__card">
        <div className="trial-war__eyebrow">{t('trial.war.eyebrow')}</div>
        <h2 id="trial-war-title" className="trial-war__title">{t('trial.war.title', { name: foe?.name ?? t('trial.war.someone') })}</h2>
        <p className="trial-war__body">{t('trial.war.body')}</p>
        <ul className="trial-war__list">
          <li>{t('trial.war.tip1')}</li>
          <li>{t('trial.war.tip2')}</li>
          <li>{t('trial.war.tip3')}</li>
        </ul>
        <button className="trial-war__go" onClick={() => setWarWith(null)}>{t('trial.war.go')}</button>
      </div>
    </div>,
    document.body,
  );
}
