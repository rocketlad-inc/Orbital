// ============================================================================
// ProfileAwards — the trophy case on the player's own profile.
//
// The superlatives (awards) the player has earned in games they played to the
// end: one medal per KIND, then the latest awards as a list. The same awards
// the end-of-game page shows, read back from GET /api/users/me/awards (see
// profileAwardsTypes.ts), drawn with the page's own glyphs, titles and units
// (awardMeta.ts), so the two never disagree.
//
// It fetches for itself and fails quietly: if the request fails, or there are
// no finished games, the whole section is simply not there and the rest of
// the profile is untouched. While the server is still working out past games
// (`pending`) it asks again a few times, then stops.
// ============================================================================

import React, { useEffect, useId, useMemo, useState } from 'react';
import { apiFetch } from './api';
import type { ApiResult } from './api';
import { AwardGlyph } from './AwardGlyph';
import { AWARD_KEYS, shipLabel } from './awardMeta';
import {
  formatAwardDate, normalizePayload, orderedTotals, recentSlice, refetchDelay, sectionView,
} from './profileAwardsModel';
import type { ProfileAward, ProfileAwardTotal, ProfileAwardsPayload } from './profileAwardsTypes';
import { fmtNumber, getLang, t, tn } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './ProfileAwards.css';

/** Where the payload comes from. The real one is the API; the dev preview
 *  hands in a sample. */
export type AwardsLoader = () => Promise<ApiResult<unknown>>;

const fromApi: AwardsLoader = () => apiFetch<ProfileAwardsPayload>('/api/users/me/awards');

type Load =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; data: ProfileAwardsPayload };

export function ProfileAwards({ load = fromApi }: { load?: AwardsLoader }) {
  useI18n();
  const [state, setState] = useState<Load>({ status: 'loading' });
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  // Fetch once; while past games are still being worked out, ask again a few
  // times (model: refetchDelay), then stop. Everything is cancelled on unmount.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = 0;
    let prevPending: number | null = null;

    const run = async () => {
      let data: ProfileAwardsPayload | null = null;
      try {
        const res = await load();
        data = res.ok ? normalizePayload(res.data) : null;
      } catch {
        data = null;
      }
      if (!alive) return;
      if (!data) {
        // First load failing hides the section; a later refresh failing keeps
        // what is already on screen.
        if (done === 0) setState({ status: 'failed' });
        return;
      }
      setState({ status: 'ready', data });
      const wait = refetchDelay(done, data.pending, prevPending);
      prevPending = data.pending;
      if (wait != null) timer = setTimeout(() => { done += 1; void run(); }, wait);
    };
    void run();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [load]);

  const data = state.status === 'ready' ? state.data : null;
  const view = state.status === 'loading' ? 'loading' : state.status === 'failed' ? 'hidden' : sectionView(data);
  const totals = useMemo(() => (data ? orderedTotals(data.totals) : []), [data]);
  const recent = useMemo(() => recentSlice(data?.awards ?? [], expanded), [data, expanded]);

  // Hidden by a failure or by having nothing to show: not even a heading.
  if (view === 'hidden') return null;

  const headId = `${listId}-h`;
  return (
    <section className="pp-section pa" aria-labelledby={headId} aria-busy={view === 'loading'}>
      <div className="pa-head">
        <h2 className="pa-title" id={headId}>{t('profile.awards.title')}</h2>
        <p className="pa-sub">{t('profile.awards.sub')}</p>
      </div>

      {view === 'loading' && (
        <>
          <div className="pa-tiles pa-tiles--skel" aria-hidden>
            {[0, 1, 2, 3].map(i => <div className="pa-skel" key={i} />)}
          </div>
          <div className="pa-sr" role="status">{t('profile.awards.loading')}</div>
        </>
      )}

      {data && data.pending > 0 && (
        <p className="pa-pending" role="status">{tn('profile.awards.pending', data.pending)}</p>
      )}

      {view === 'empty' && <p className="pa-empty">{t('profile.awards.empty')}</p>}

      {view === 'medals' && (
        <>
          {totals.length > 0 && (
            <ul className="pa-tiles" aria-label={t('profile.awards.tilesLabel')}>
              {totals.map(x => <Tile key={x.awardId} x={x} />)}
            </ul>
          )}

          {recent.rows.length > 0 && (
            <div className="pa-recent">
              <h3 className="pa-recent__h">{t('profile.awards.recent')}</h3>
              <ul className="pa-list" id={listId} aria-label={t('profile.awards.recentLabel')}>
                {recent.rows.map((a, i) => <Row key={`${a.gameId}:${a.awardId}:${i}`} a={a} />)}
              </ul>
              {recent.canExpand && (
                <button
                  type="button"
                  className="pa-more"
                  aria-expanded={expanded}
                  aria-controls={listId}
                  onClick={() => setExpanded(v => !v)}
                >
                  {expanded ? t('profile.awards.showFewer') : t('profile.awards.showAll', { n: fmtNumber(recent.total) })}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** One medal: an award kind the player has earned at least once. */
function Tile({ x }: { x: ProfileAwardTotal }) {
  const k = AWARD_KEYS[x.awardId];
  return (
    <li className="pa-tile">
      <span className="pa-tile__gl" aria-hidden><AwardGlyph id={x.awardId} /></span>
      {x.count > 1 && (
        <span className="pa-tile__count">
          <span aria-hidden>{`×${fmtNumber(x.count)}`}</span>
          <span className="pa-sr">{tn('profile.awards.times', x.count)}</span>
        </span>
      )}
      <h3 className="pa-tile__ttl">{t(k.title)}</h3>
      <div className="pa-tile__best">
        <span className="pa-tile__k">{t('profile.awards.best')}</span>
        <b className="pa-num pa-tile__v">{fmtNumber(x.best)}</b>
        <span className="pa-tile__unit">{tn(k.unit, x.best)}</span>
      </div>
      {x.bestGameName && <div className="pa-tile__game">{x.bestGameName}</div>}
    </li>
  );
}

/** One line of the recent list. */
function Row({ a }: { a: ProfileAward }) {
  const k = AWARD_KEYS[a.awardId];
  const date = formatAwardDate(a.completedAtMs, getLang());
  return (
    <li className="pa-row">
      <span className="pa-row__gl" aria-hidden><AwardGlyph id={a.awardId} /></span>
      <div className="pa-row__main">
        <div className="pa-row__ttl">
          <span>{t(k.title)}</span>
          {a.tied && <span className="pa-tag">{t('profile.awards.tied')}</span>}
          {a.wonGame && <span className="pa-tag pa-tag--win">{t('profile.awards.won')}</span>}
        </div>
        {a.ship && <div className="pa-row__ship">{shipLabel(a.ship)}</div>}
      </div>
      <div className="pa-row__val">
        <b className="pa-num">{fmtNumber(a.value)}</b>
        {' '}<span>{tn(k.unit, a.value)}</span>
      </div>
      <div className="pa-row__meta">
        {a.gameName && <span className="pa-row__game">{a.gameName}</span>}
        {a.empireName && <span className="pa-row__as">{t('profile.awards.as', { name: a.empireName })}</span>}
      </div>
      {date && a.completedAtMs != null && (
        <time className="pa-row__date" dateTime={new Date(a.completedAtMs).toISOString()}>{date}</time>
      )}
    </li>
  );
}
