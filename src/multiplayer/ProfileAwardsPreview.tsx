// ============================================================================
// ProfileAwardsPreview — look at the profile's trophy case without finishing
// a game, signing in or waiting for the server.
//
//   /?profile-awards[&state=empty|pending|many|failed|loading][&lang=pt-BR]
//
// DEV ONLY. It mounts ProfileAwards inside the profile's own container with a
// SAMPLE payload built from the three real finished-game fixtures
// (profileAwardsSample.ts). App.tsx lazy-loads this file behind a NODE_ENV
// guard, so neither it nor the sample nor the fixtures reach a production
// build.
//
//   (no state)  three games' worth of awards, as if one player won them all
//   empty       finished games, no awards yet
//   pending     awards arrive in three steps (pending 2, 1, 0): the section's
//               "checking" line and its timed re-fetches
//   many        the server's full 60, to try "Show all"
//   failed      the request fails: the section is not there
//   loading     the request never answers: the skeleton
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiResult } from './api';
import { ProfileAwards } from './ProfileAwards';
import type { EndingPayload } from './endingTypes';
import { buildSample, loadSampleFixtures } from './profileAwardsSample';
import { isLang, setLang } from '../i18n/core';
import { useI18n } from '../i18n/react';

const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, status: 200, data });

export function ProfileAwardsPreview() {
  useI18n();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const state = params.get('state');
  const [fixtures, setFixtures] = useState<EndingPayload[] | null>(null);

  useEffect(() => {
    const lang = params.get('lang');
    if (isLang(lang)) setLang(lang, false);
  }, [params]);

  useEffect(() => {
    let live = true;
    loadSampleFixtures().then(f => { if (live) setFixtures(f); }).catch(() => { if (live) setFixtures([]); });
    return () => { live = false; };
  }, []);

  // `step` counts requests so "pending" can resolve itself over time.
  const step = useMemo(() => ({ n: 0 }), []);
  const load = useCallback(async (): Promise<ApiResult<unknown>> => {
    if (state === 'loading') return new Promise<ApiResult<unknown>>(() => { /* never answers */ });
    if (state === 'failed') return { ok: false, status: 500, error: null };
    const fx = fixtures ?? [];
    const n = step.n++;
    // Request times (ms since load), for checking the re-fetch spacing in a browser.
    const w = window as unknown as { __paCalls?: number[] };
    (w.__paCalls ??= []).push(Math.round(performance.now()));
    switch (state) {
      case 'empty':
        return ok({ gamesFinished: fx.length, gamesWithAwards: 0, totals: [], awards: [], pending: 0 });
      case 'pending': {
        // 1 game in, 2 to go; then 2 in, 1 to go; then everything.
        const games = Math.min(fx.length, n + 1);
        return ok(buildSample(fx, { games, pending: Math.max(0, fx.length - games) }));
      }
      case 'many':
        return ok(buildSample(fx, { many: true }));
      default:
        return ok(buildSample(fx));
    }
  }, [state, fixtures, step]);

  if (!fixtures) return <div style={{ position: 'fixed', inset: 0, background: '#0a0e14' }} />;

  return (
    <div style={{ minHeight: '100vh', background: '#0a0e14', color: '#d8e4ee', padding: '16px 14px 48px', boxSizing: 'border-box' }}>
      {/* The profile's own container, so the section inherits what it would there. */}
      <div className="pp">
        <ProfileAwards key={state ?? 'default'} load={load} />
      </div>
    </div>
  );
}

export default ProfileAwardsPreview;
