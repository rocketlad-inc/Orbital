// ============================================================
// SharedFilm — the page behind /film/<token>.
//
// No account, no session: the token in the URL is the whole permission,
// and the server resolves it to exactly one game. This renders the SAME
// MatchReplay the signed-in analytics view renders, pointed at the
// public endpoints — a shared page built from a second, simpler copy of
// the player is a page that drifts from the real one the first time
// either is touched.
// ============================================================

import React, { useCallback, useState } from 'react';
import { MatchReplay } from './MatchReplay';
import { RecapJoinCta, RecapShareBar, filmUrl } from './RecapShare';
import type { MatchSummary } from '../render/matchWorld';
import { t } from '../i18n/core';
import { useI18n } from '../i18n/react';

export function SharedFilm({ token }: { token: string }) {
  useI18n();
  // Passed on as fight clips are (RecapShare): the share bar, and the way
  // into the game, tagged ?from=film for the "where players came from" panel.
  const [name, setName] = useState('');
  const onSummary = useCallback((s: MatchSummary) => {
    const n = s.game?.name || '';
    setName(n);
    if (n) document.title = t('replay.share.docTitle', { name: n });
  }, []);
  return (
    <div style={{
      minHeight: '100vh',
      background: '#03060d',
      padding: '20px 16px 40px',
      boxSizing: 'border-box',
    }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 12,
          marginBottom: 12, flexWrap: 'wrap',
        }}>
          <div style={{
            fontFamily: 'var(--font-body, system-ui), system-ui',
            fontSize: 20, letterSpacing: '0.18em', color: '#cfe0ee',
          }}>{t('mp.film.title')}</div>
          <a
            href="/"
            style={{ fontSize: 12, color: '#6fb4ee', textDecoration: 'none' }}
          >orbital-empire.com</a>
        </div>
        <MatchReplay token={token} onSummary={onSummary} />
        <div style={{ marginTop: 18, display: 'grid', gap: 14 }}>
          <RecapShareBar token={token} url={filmUrl(token)}
            text={t('replay.share.text', { name: name || 'Orbital' })} />
          <RecapJoinCta from="film" />
        </div>
      </div>
    </div>
  );
}
