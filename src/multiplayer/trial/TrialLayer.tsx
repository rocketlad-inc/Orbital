// ============================================================
// The Play for Free trial, in the game (Lorne, 2026-10-24).
//
// Mounted by GameUI only in a trial game (gameState.solo.trial):
//   - starts the trial tutorial track by itself, once per browser;
//   - asks the player to save, each at most once per account:
//       LEAVING  the first try at leaving the page: the mouse heading
//                for the tabs (our own sheet), or a close/navigate (the
//                browser's own "Leave site?", the only thing it allows);
//       TIME     after ten minutes of play: time the tab is visible AND
//                the clock is running, outside the tour (it fired at
//                T+1 after a long paused tutorial: playtest 2026-10-24);
//   - the moment the Warlord declares war, a card says what that means;
//   - closing the page pauses the trial (it wakes when they come back).
// The menu entry (TopBar) opens the same sheet whenever they like.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../AuthContext';
import { useGameContext } from '../../state/gameContext';
import { useTutorial } from '../../state/tutorial';
import { openSaveEmpire } from './SaveEmpire';
import { logTrial, setTrialGame } from './trialTelemetry';
import { useMultiplayerActions } from '../MultiplayerActionsContext';
import { TRIAL_TUTORIAL_STEPS } from '../../game/tutorialSteps';
import { t } from '../../i18n/core';
import { useI18n } from '../../i18n/react';
import './trial.css';

/** Play time before the save prompt, ms (his pick: ten minutes). */
export const SAVE_PROMPT_AFTER_MS = 10 * 60_000;

type Asked = { leave?: boolean; time?: boolean; war?: boolean; playedMs?: number; clock?: boolean };
const keyFor = (uid: string) => `orbital.trial.${uid}`;
function readAsked(uid: string): Asked {
  try { return JSON.parse(localStorage.getItem(keyFor(uid)) ?? '{}') as Asked; } catch { return {}; }
}
function writeAsked(uid: string, a: Asked) {
  try { localStorage.setItem(keyFor(uid), JSON.stringify(a)); } catch { /* private mode */ }
}
/** The one play-time counter in this tab: a second mounted layer must not
 *  count the same minutes again (the prompt came at about five). */
let playClockOwner: symbol | null = null;

export function TrialLayer() {
  useI18n();
  const { user } = useAuth();
  const { gameState } = useGameContext();
  const { active, trialDone, startTrial, track, index } = useTutorial();
  const mpActions = useMultiplayerActions();
  useEffect(() => { setTrialGame(mpActions?.gameId); }, [mpActions?.gameId]);
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
  // Marked started only when it actually starts: a re-render (or React's
  // dev double-mount) inside the delay cancels the timer, and marking it
  // first meant the tour never began.
  useEffect(() => {
    if (startedRef.current || trialDone || active) return;
    const timer = setTimeout(() => { startedRef.current = true; startTrial(); }, 1200);
    return () => clearTimeout(timer);
  }, [trialDone, active, startTrial]);

  // The dashboard follows the tour step by step (trialTelemetry.ts): the
  // furthest step shown, then whether it ended on the last one.
  const lastStepRef = useRef(-1);
  useEffect(() => {
    if (!active || track !== 'trial' || index < 0) return;
    lastStepRef.current = index;
    logTrial(`tour-step-${index + 1}`);
  }, [active, track, index]);
  useEffect(() => {
    if (active || !trialDone || lastStepRef.current < 0) return;
    logTrial(lastStepRef.current >= TRIAL_TUTORIAL_STEPS.length - 1 ? 'tour-done' : 'tour-skip');
    lastStepRef.current = -1;
  }, [active, trialDone]);

  // THE CLOCK. A trial starts paused for its tutorial, whose last step is
  // Start the clock. Skipping the tour starts it instead. Once only: a
  // pause the player chooses afterwards is theirs to keep.
  const paused = !!gameState.solo?.paused;
  useEffect(() => {
    if (!paused) { logTrial('clock'); if (!askedRef.current.clock) mark({ clock: true }); return; }
    if (!trialDone || active || askedRef.current.clock) return;
    mark({ clock: true });
    const gid = gameState.solo ? sessionStorage.getItem('orbital.tab_room') : null;
    if (gid) {
      fetch(`/api/games/${encodeURIComponent(gid)}/solo/resume`, { method: 'POST', credentials: 'include' })
        .then(() => window.dispatchEvent(new CustomEvent('orbital:refresh-state')))
        .catch(() => { /* the clock button is right there */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, trialDone, active]);

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

  // GONE: the page is closing, so the trial's clock stops now instead of
  // running ~30 ticks for nobody until the idle sweep (worker/trial.js
  // leaveTrial). A reload or a return wakes it on the next /state.
  const gameId = mpActions?.gameId;
  useEffect(() => {
    if (!shadow || !gameId) return;
    const onPageHide = () => {
      try {
        void fetch(`/api/games/${encodeURIComponent(gameId)}/trial-leave`, {
          method: 'POST', credentials: 'same-origin', keepalive: true,
        }).catch(() => { /* the idle sweep is the fallback */ });
      } catch { /* the idle sweep is the fallback */ }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [shadow, gameId]);

  // TIME: ten minutes of PLAY, kept across reloads: the tab in view, the
  // clock running, and no tour on screen. Counted from the real time
  // between beats, so a throttled timer neither loses nor invents minutes.
  const activeRef = useRef(active);
  activeRef.current = active;
  const pausedRef = useRef(true);
  pausedRef.current = !!gameState.solo?.paused;
  useEffect(() => {
    if (!shadow) return;
    const me = Symbol('play-clock');
    if (playClockOwner) return;
    playClockOwner = me;
    const STEP = 5_000;
    let last = Date.now();
    const iv = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(now - last, STEP * 2);
      last = now;
      if (document.visibilityState !== 'visible' || askedRef.current.time) return;
      if (pausedRef.current || activeRef.current) return;
      const played = (askedRef.current.playedMs ?? 0) + dt;
      mark({ playedMs: played });
      if (played >= SAVE_PROMPT_AFTER_MS) {
        mark({ time: true });
        openSaveEmpire('time');
      }
    }, STEP);
    return () => { clearInterval(iv); if (playClockOwner === me) playClockOwner = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shadow, uid]);

  // WAR: the first declaration on the player, once.
  useEffect(() => {
    if (askedRef.current.war) return;
    const pair = (gameState.warPairs ?? []).find(p => p.split('|').includes('player'));
    if (!pair) return;
    const other = pair.split('|').find(x => x !== 'player') ?? null;
    mark({ war: true });
    logTrial('war');
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
