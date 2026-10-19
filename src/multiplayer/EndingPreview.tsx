// ============================================================================
// EndingPreview — look at the end-of-game page without finishing a game.
//
//   /?ending=<gameId>[&as=winner|<empire name>|none][&lang=pt-BR][&state=loading|failed]
//
// DEV ONLY. It renders EndingPage full-screen with a real finished game's
// report bundled as a fixture (src/multiplayer/__fixtures__/ending.<id>.json):
// no sign-in, no API. The fixtures are loaded with a dynamic import() inside a
// NODE_ENV guard, so a production build drops the branch — and with it the
// fixtures — entirely; App.tsx only mounts this component outside production.
//
//   as=winner         look at it as the winning empire (the default)
//   as=<name>         as that empire (case-insensitive), e.g. as=Tritalowda
//   as=none           as a spectator with no empire in the game
//   state=loading     the skeleton built from the verdict alone
//   state=failed      the fallback when the report cannot be fetched
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { EndingMeta, EndingPage, EndingPlug } from './EndingPage';
import { survivedTheGame, verdictKind, viewerOf, withViewer } from './endingModel';
import type { EndingPayload } from './endingTypes';
import { isLang, setLang, t } from '../i18n/core';
import { useI18n } from '../i18n/react';

/** Fixtures by game id. The guard is what keeps them out of production. */
async function loadFixture(id: string): Promise<EndingPayload | null> {
  if (process.env.NODE_ENV !== 'production') {
    switch (id) {
      case 'sMu08u1ySzRJ': return (await import('./__fixtures__/ending.sMu08u1ySzRJ.json')).default as unknown as EndingPayload;
      case 'ghhqbPbWz64Y': return (await import('./__fixtures__/ending.ghhqbPbWz64Y.json')).default as unknown as EndingPayload;
      case 'CAWEFbsSGyBI': return (await import('./__fixtures__/ending.CAWEFbsSGyBI.json')).default as unknown as EndingPayload;
      default: return null;
    }
  }
  return null;
}

export function EndingPreview() {
  useI18n();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const gameId = params.get('ending') ?? '';
  const as = params.get('as');
  const forced = params.get('state');
  const [raw, setRaw] = useState<EndingPayload | null | undefined>(undefined);

  useEffect(() => {
    const lang = params.get('lang');
    if (isLang(lang)) setLang(lang, false);
  }, [params]);

  useEffect(() => {
    let live = true;
    loadFixture(gameId).then(d => { if (live) setRaw(d); }).catch(() => { if (live) setRaw(null); });
    return () => { live = false; };
  }, [gameId]);

  const data = useMemo(() => (raw ? withViewer(raw, as ?? 'winner') : null), [raw, as]);
  const meta = useMemo<EndingMeta | null>(() => {
    if (!data) return null;
    const me = viewerOf(data.factions);
    const winner = data.factions.find(f => f.id === data.game.winnerFactionId);
    return {
      winnerFactionId: data.game.winnerFactionId,
      winnerName: winner?.name ?? null,
      victoryType: data.game.victoryType,
      myFactionId: me?.id ?? null,
      factions: data.factions.map(f => ({
        id: f.id, name: f.name, color: f.color, color2: f.color2, emblem: f.emblem, status: f.finalStatus,
      })),
    };
  }, [data]);

  if (raw === undefined) return <div style={{ position: 'fixed', inset: 0, background: '#060a10' }} />;
  if (!data || !meta) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#060a10', color: '#aebdcc', display: 'grid', placeItems: 'center', fontFamily: 'monospace' }}>
        {'?ending=sMu08u1ySzRJ | ghhqbPbWz64Y | CAWEFbsSGyBI'}
      </div>
    );
  }

  const me = viewerOf(data.factions);
  const survived = survivedTheGame(me, verdictKind(meta.winnerFactionId, meta.myFactionId) === 'victory');
  const plug: EndingPlug | null = survived && me ? { sellable: true, onView: () => undefined, onBuy: () => undefined } : null;

  return (
    <EndingPage
      gameId={gameId}
      meta={meta}
      status={forced === 'loading' ? 'loading' : forced === 'failed' ? 'failed' : 'ready'}
      data={forced === 'loading' || forced === 'failed' ? null : data}
      onReturn={() => { window.location.assign('/'); }}
      renderFilm={() => <div className="ep-sub" style={{ textAlign: 'center', padding: '32px 0' }}>{t('mp.provider.loadingRenderer')}</div>}
      plug={plug}
    />
  );
}

export default EndingPreview;
