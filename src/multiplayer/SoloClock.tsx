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

import React, { useState } from 'react';
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

export function SoloClock({ gameId }: { gameId: string }) {
  useI18n();
  const { gameState } = useGameContext();
  const isMobile = useIsMobile();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const solo = gameState.solo;
  if (!solo) return null;
  const paused = solo.paused;
  const speed = gameState.tickIntervalMs ?? 120_000;

  const send = async (what: string, path: string, init: RequestInit) => {
    if (busy) return;
    setBusy(what);
    setError(null);
    const res = await apiFetch(`/api/games/${encodeURIComponent(gameId)}/solo/${path}`, init);
    setBusy(null);
    if (!res.ok) { setError(apiErrorText(res.error, 'solo.failed')); return; }
    window.dispatchEvent(new CustomEvent('orbital:refresh-state'));
  };
  const setSpeed = (ms: number) => {
    if (ms === speed) return;
    send('speed', 'speed', { method: 'PATCH', body: JSON.stringify({ speed_ms: ms }) });
  };
  // A phone has room for one speed button: it steps through the three.
  const nextSpeed = SOLO_SPEEDS[(SOLO_SPEEDS.indexOf(speed as typeof SOLO_SPEEDS[number]) + 1) % SOLO_SPEEDS.length];

  return (
    <div className={`solo-clock${paused ? ' is-paused' : ''}`} data-testid="solo-clock">
      <button
        type="button"
        className={`solo-clock__btn solo-clock__main${paused ? ' is-go' : ''}`}
        onClick={() => send('pause', paused ? 'resume' : 'pause', { method: 'POST' })}
        disabled={!!busy}
        title={paused ? t('solo.resumeTitle') : t('solo.pauseTitle')}
        aria-pressed={paused}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
        <span className="solo-clock__txt">{paused ? t('solo.resume') : t('solo.pause')}</span>
      </button>
      {paused && (
        <button
          type="button"
          className="solo-clock__btn"
          onClick={() => send('step', 'step', { method: 'POST' })}
          disabled={!!busy}
          title={t('solo.stepTitle')}
        >
          <StepIcon />
          <span className="solo-clock__txt">{busy === 'step' ? t('solo.stepping') : t('solo.step')}</span>
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
