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

import React from 'react';
import { MatchReplay } from './MatchReplay';

export function SharedFilm({ token }: { token: string }) {
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
          }}>ORBITAL — MATCH FILM</div>
          <a
            href="/"
            style={{ fontSize: 12, color: '#6fb4ee', textDecoration: 'none' }}
          >orbital-empire.com</a>
        </div>
        <MatchReplay token={token} />
      </div>
    </div>
  );
}
