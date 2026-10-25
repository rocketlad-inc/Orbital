// ============================================================
// SoloClock — the top bar's clock controls in a solo game
// (worker/solo.js): pause, one tick at a time while paused, and the
// three speeds Lorne picked (30 s / 2 min / 10 min a tick).
//
// The server owns the clock: each button is one request, and the next
// /state (refreshed at once) is what the bar then shows. Paused, the
// server sends next_tick_at null, so the countdown and the map's tick
// glide both stand still on their own.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api';
import { useGameContext } from '../state/gameContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { apiErrorText } from '../i18n/apiErrors';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './SoloClock.css';

/** worker/solo.js SOLO_SPEEDS. */
export const SOLO_SPEEDS = [30_000, 120_000, 600_000] as const;

const speedKey = (ms: number) => (ms === 30_000 ? 'solo.speed.fast' : ms === 600_000 ? 'solo.speed.relaxed' : 'solo.speed.steady');
/** A tick length as the clock names it ("30s"). */
export const soloSpeedLabel = (ms: number) => t(speedKey(ms));
/** The speed after this one, as the phone's single speed control cycles. */
export const nextSoloSpeed = (ms: number) =>
  SOLO_SPEEDS[(SOLO_SPEEDS.indexOf(ms as typeof SOLO_SPEEDS[number]) + 1) % SOLO_SPEEDS.length];

const PauseIcon = () => (
  <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
    <rect x="2" y="1.5" width="2.6" height="9" rx="0.6" fill="currentColor" />
    <rect x="7.4" y="1.5" width="2.6" height="9" rx="0.6" fill="currentColor" />
  </svg>
);
const PlayIcon = () => (
  <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
    <path d="M3 1.6 L10.4 6 L3 10.4 Z" fill="currentColor" />
  </svg>
);
const StepIcon = () => (
  <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
    <path d="M2 1.8 L7.6 6 L2 10.2 Z" fill="currentColor" />
    <rect x="8.4" y="1.8" width="1.8" height="8.4" rx="0.5" fill="currentColor" />
  </svg>
);

/** WHAT THE PLAYER JUST ASKED THE CLOCK FOR, SHOWN BEFORE THE SERVER SAYS SO.
 *  A press answered after the POST and the next /state (2-3 s on staging),
 *  so PAUSE looked dead and its label kept saying "Stop the clock" while
 *  paused (Leo, 2026-10-24). Each wish holds until /state agrees, the
 *  request fails, or a backstop runs out. TopBar owns it, so the tick
 *  readout's PAUSED and the button change together. */
export interface SoloPending {
  paused: boolean | undefined;
  speedMs: number | undefined;
  want: (w: { paused?: boolean; speedMs?: number }) => void;
  drop: () => void;
}
const SOLO_PENDING_TTL_MS = 15_000;
export function useSoloPending(serverPaused: boolean | undefined, serverSpeedMs: number | undefined): SoloPending {
  const [w, setW] = useState<{ paused?: boolean; speedMs?: number; at: number }>({ at: 0 });
  useEffect(() => {
    if (w.paused !== undefined && w.paused === serverPaused) setW(p => ({ ...p, paused: undefined }));
  }, [w.paused, serverPaused]);
  useEffect(() => {
    if (w.speedMs !== undefined && w.speedMs === serverSpeedMs) setW(p => ({ ...p, speedMs: undefined }));
  }, [w.speedMs, serverSpeedMs]);
  const live = w.paused !== undefined || w.speedMs !== undefined;
  useEffect(() => {
    if (!live) return undefined;
    const id = setTimeout(() => setW({ at: 0 }), SOLO_PENDING_TTL_MS);
    return () => clearTimeout(id);
  }, [live, w.at]);
  return {
    paused: w.paused ?? serverPaused,
    speedMs: w.speedMs ?? serverSpeedMs,
    want: (next) => setW(p => ({ ...p, ...next, at: Date.now() })),
    drop: () => setW({ at: 0 }),
  };
}

export function SoloClock({ gameId, pending: given }: { gameId: string; pending?: SoloPending }) {
  useI18n();
  const { gameState } = useGameContext();
  const own = useSoloPending(gameState.solo?.paused, gameState.tickIntervalMs);
  const pending = given ?? own;
  const isMobile = useIsMobile();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // NEXT TICK, CLICKED AGAIN WHILE ONE RUNS. Those clicks used to be
  // swallowed by the disabled button, so five quick clicks advanced one
  // tick and nothing said so (playtest, 2026-10-24). Each click now
  // counts: extra ones wait their turn (at most MAX_QUEUED), the button
  // says how many are left, and each landed step names its tick.
  const queuedRef = useRef(0);
  const [queued, setQueued] = useState(0);
  const [landed, setLanded] = useState<number | null>(null);
  useEffect(() => {
    if (landed == null) return;
    const id = setTimeout(() => setLanded(null), 1800);
    return () => clearTimeout(id);
  }, [landed]);
  const solo = gameState.solo;
  // Others ask the clock here, one code path: the tutorial's last step has
  // its own START (a phone's top bar had none on screen), and a narrow
  // phone keeps speed and the single tick in the menu (TopBar SideMenu).
  const resumeRef = useRef<(action: string) => void>(() => undefined);
  useEffect(() => {
    const onAsk = (e: Event) => {
      const action = (e as CustomEvent).detail?.action;
      if (typeof action === 'string') resumeRef.current(action);
    };
    window.addEventListener('orbital:solo-clock', onAsk);
    return () => window.removeEventListener('orbital:solo-clock', onAsk);
  }, []);
  if (!solo) return null;
  const paused = pending.paused ?? solo.paused;
  const speed = pending.speedMs ?? gameState.tickIntervalMs ?? 120_000;

  const send = async (what: string, path: string, init: RequestInit) => {
    if (busy) return;
    setBusy(what);
    setError(null);
    if (what === 'pause') pending.want({ paused: path === 'pause' });
    const res = await apiFetch(`/api/games/${encodeURIComponent(gameId)}/solo/${path}`, init);
    setBusy(null);
    if (!res.ok) { pending.drop(); setError(apiErrorText(res.error, 'solo.failed')); return; }
    window.dispatchEvent(new CustomEvent('orbital:refresh-state'));
  };
  const MAX_QUEUED = 9;
  const step = async () => {
    if (busy === 'step') {
      queuedRef.current = Math.min(MAX_QUEUED, queuedRef.current + 1);
      setQueued(queuedRef.current);
      return;
    }
    if (busy) return;
    setBusy('step');
    setError(null);
    setLanded(null);
    for (;;) {
      const res = await apiFetch<{ tick?: number | null }>(
        `/api/games/${encodeURIComponent(gameId)}/solo/step`, { method: 'POST' });
      if (!res.ok) {
        setError(apiErrorText(res.error, 'solo.failed'));
        queuedRef.current = 0;
        setQueued(0);
        break;
      }
      window.dispatchEvent(new CustomEvent('orbital:refresh-state'));
      if (res.data?.tick != null) setLanded(res.data.tick);
      if (queuedRef.current <= 0) break;
      queuedRef.current -= 1;
      setQueued(queuedRef.current);
    }
    setBusy(null);
  };
  const setSpeed = (ms: number) => {
    if (ms === speed) return;
    pending.want({ speedMs: ms });
    send('speed', 'speed', { method: 'PATCH', body: JSON.stringify({ speed_ms: ms }) });
  };
  // A phone has room for one speed button: it steps through the three.
  const nextSpeed = nextSoloSpeed(speed);
  resumeRef.current = (action) => {
    if (action === 'resume' && paused) send('pause', 'resume', { method: 'POST' });
    else if (action === 'step' && paused) void step();
    else if (action === 'speed') setSpeed(nextSpeed);
  };

  const mainWord = paused ? (gameState.currentTick === 0 ? t('solo.start') : t('solo.resume')) : t('solo.pause');

  return (
    <div className={`solo-clock${paused ? ' is-paused' : ''}`} data-testid="solo-clock">
      <button
        type="button"
        className={`solo-clock__btn solo-clock__main${paused ? ' is-go' : ''}${paused && gameState.currentTick === 0 ? ' is-start' : ''}`}
        data-tutorial-id="solo-start"
        onClick={() => send('pause', paused ? 'resume' : 'pause', { method: 'POST' })}
        disabled={!!busy}
        title={paused ? t('solo.resumeTitle') : t('solo.pauseTitle')}
        // Named for what a press does, so a phone's icon-only button reads
        // right too (it said "Stop the clock" while paused).
        aria-label={mainWord}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
        <span className="solo-clock__txt">{mainWord}</span>
      </button>
      {paused && (
        <button
          type="button"
          className="solo-clock__btn solo-clock__step"
          onClick={step}
          disabled={!!busy && busy !== 'step'}
          title={t('solo.stepTitle')}
          aria-live="polite"
        >
          <StepIcon />
          <span className="solo-clock__txt">
            {busy === 'step'
              ? (queued > 0 ? t('solo.steppingMore', { n: queued }) : t('solo.stepping'))
              : landed != null ? t('solo.steppedTo', { n: landed }) : t('solo.step')}
          </span>
        </button>
      )}
      {isMobile ? (
        <button
          type="button"
          className="solo-clock__btn solo-clock__speed"
          onClick={() => setSpeed(nextSpeed)}
          disabled={!!busy}
          title={t('solo.speedTitle')}
        >
          {t(speedKey(speed))}
        </button>
      ) : (
        <div className="solo-clock__seg" role="radiogroup" aria-label={t('solo.speedTitle')}>
          {SOLO_SPEEDS.map(ms => (
            <button
              key={ms}
              type="button"
              role="radio"
              aria-checked={ms === speed}
              className={`solo-clock__opt${ms === speed ? ' is-on' : ''}`}
              onClick={() => setSpeed(ms)}
              disabled={!!busy}
              title={t('solo.speedTitle')}
            >
              {t(speedKey(ms))}
            </button>
          ))}
        </div>
      )}
      {error && <span className="solo-clock__err" role="alert" title={error}>{error}</span>}
    </div>
  );
}
