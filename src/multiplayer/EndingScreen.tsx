// ============================================================================
// EndingScreen — the end-of-game page, wired to the live game.
//
// Mounted by MultiplayerGameProvider (lazily) once the game is over. It owns
// the three things the presentational EndingPage should not know about:
//
//   * the report:      GET /api/games/:id/ending, fetched once when shown.
//                      Any failure (404, 403, 409, a dropped connection) is
//                      handled the same quiet way: the page falls back to what
//                      the provider already knows — the verdict, the actions
//                      and the Commission — with no error shouting at a player
//                      who has just finished a game.
//   * the film:        the existing MatchReplay, loaded only if asked for.
//   * the Commission:  who may be shown it (an empire that survived to the end,
//                      not a holder, signed in), once per game, and what its
//                      button does (checkout on the web, the phone's browser in
//                      the Android app). Funnel events go through logCommission.
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, startCommissionCheckout } from './api';
import { useAuth } from './AuthContext';
import { canBuyHere, logCommission, openCommissionInBrowser } from './commission';
import { endgameKey } from './CommissionMoments';
import { EndingMeta, EndingPage, EndingPlug } from './EndingPage';
import { survivedTheGame, verdictKind, viewerOf } from './endingModel';
import type { EndingPayload } from './endingTypes';
import { lazyChunk } from '../util/lazyChunk';
import { filmUrl } from './RecapShare';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';

// The whole-match recap. Split out of the main bundle: it pulls in the map
// renderer and the replay machinery, and nobody needs any of that until the
// player asks for the film. lazyChunk so a deploy landing mid-session retries
// the chunk instead of leaving a dead panel.
const MatchReplay = lazyChunk('match-replay', () =>
  import('./MatchReplay').then(m => ({ default: m.MatchReplay })));

export interface EndingScreenProps {
  gameId: string;
  meta: EndingMeta;
  onReturn: () => void;
}

export function EndingScreen({ gameId, meta, onReturn }: EndingScreenProps) {
  useI18n();
  const { user } = useAuth();
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [data, setData] = useState<EndingPayload | null>(null);

  // The report, once.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    apiFetch<EndingPayload>(`/api/games/${encodeURIComponent(gameId)}/ending`)
      .then(res => {
        if (cancelled) return;
        if (res.ok && res.data && Array.isArray(res.data.factions)) {
          setData(res.data);
          setStatus('ready');
        } else {
          setStatus('failed');
        }
      })
      .catch(() => { if (!cancelled) setStatus('failed'); });
    return () => { cancelled = true; };
  }, [gameId]);

  // Did this empire make it to the end? The report knows best; until it
  // arrives (or if it never does) the provider's own faction list says.
  const survived = useMemo(() => {
    if (status === 'ready' && data) {
      const me = viewerOf(data.factions);
      return survivedTheGame(me, verdictKind(data.game.winnerFactionId, me?.id ?? null) === 'victory');
    }
    const mine = meta.factions.find(f => f.id === meta.myFactionId);
    return survivedTheGame(mine ?? null, verdictKind(meta.winnerFactionId, meta.myFactionId) === 'victory');
  }, [status, data, meta]);

  // Shown once per game: decided when the page opens, so the plug does not
  // vanish under the player while they read (the key is written on view).
  const [shownBefore] = useState(() => {
    try { return !!localStorage.getItem(endgameKey(gameId)); } catch { return false; }
  });
  const sellable = canBuyHere();
  // Never on a game the idle cull ended: no sales pitch on a dead game.
  const abandoned = (status === 'ready' && data ? data.game.victoryType : meta.victoryType) === 'abandoned';
  const eligible = !shownBefore && survived && !abandoned && !!user && !user.is_premium;

  const onView = useCallback(() => {
    logCommission('endgame', 'view');
    try { localStorage.setItem(endgameKey(gameId), String(Date.now())); } catch { /* fine */ }
  }, [gameId]);
  const onBuy = useCallback(() => {
    if (!sellable) { openCommissionInBrowser('endgame'); return; }
    logCommission('endgame', 'click');
    void startCommissionCheckout('endgame').then(url => { if (url) window.location.assign(url); });
  }, [sellable]);
  const plug: EndingPlug | null = eligible ? { sellable, onView, onBuy } : null;

  const renderFilm = useCallback((id: string) => (
    <React.Suspense fallback={<div className="ep-sub" style={{ textAlign: 'center', padding: '32px 0' }}>{t('mp.provider.loadingRenderer')}</div>}>
      <MatchReplay gameId={id} />
    </React.Suspense>
  ), []);

  // The film's public link, made (or handed back) on first ask.
  const shareFilm = useCallback(async () => {
    const r = await apiFetch<{ token: string; path: string }>(
      `/api/admin/games/${encodeURIComponent(gameId)}/match/share`, { method: 'POST' });
    if (r.ok) return { url: filmUrl(r.data.token) };
    return { error: r.status === 409 ? 'not_ready' as const : 'failed' as const };
  }, [gameId]);

  return (
    <EndingPage
      gameId={gameId}
      shareFilm={shareFilm}
      meta={meta}
      status={status}
      data={data}
      onReturn={onReturn}
      renderFilm={renderFilm}
      plug={plug}
    />
  );
}

export default EndingScreen;
