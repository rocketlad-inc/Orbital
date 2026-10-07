// ============================================================
// SharedRecap — one battle, on a page anyone can open.
//
// A recap is the most watchable thing the game produces and it lived
// behind an admin session, so the only way to show somebody a fight was
// to describe it. This is the page behind a share link: no account, no
// lobby, no game running underneath. Just the engagement.
//
// It renders the SAME BattleRecap the analytics browser does, off the
// same payload, because a share that quietly diverged from the real
// thing is worse than no share — the whole value of sending someone a
// link is that they see what you saw.
// ============================================================

import React, { useEffect, useState } from 'react';
import { BattleRecap, type Detail as BattleDetailPayload } from './BattleReview';
import { TheatreCanvas, type TheatreDetail } from './TheatreRecap';
import type { CinemaDetail } from './BattleCinema';
import { lazyChunk } from '../util/lazyChunk';
import { t, tn, type Key } from '../i18n/core';
import { useI18n } from '../i18n/react';

// Lazy: this is what pulls three.js in, and a reader who only wants the
// flat recap should not download a renderer to get it.
const BattleCinema = lazyChunk('cinema', () =>
  import('./BattleCinema').then(m => ({ default: m.BattleCinema })));

const NEUTRAL = '#8a9fb3';

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

/** t() whose catalog string marks bold with **; values are defused so a name containing ** cannot flip it. */
function richT(key: Key, vars: Record<string, string | number>): React.ReactNode[] {
  const safe: Record<string, string | number> = {};
  for (const k of Object.keys(vars)) safe[k] = String(vars[k]).replace(/\*\*/g, '*\u200b*');
  return t(key, safe).split('**').map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part));
}

export function SharedRecap({ token }: { token: string }) {
  useI18n();
  const [d, setD] = useState<BattleDetailPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The campaign this battle was part of, fetched only if the reader asks
  // for it — most shares are one engagement and the system payload is
  // every frame of every battle in the neighbourhood.
  const [system, setSystem] = useState<TheatreDetail | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  // The film. Same battle as the flat recap, richer payload, fetched
  // only when asked for -- it carries every tick's roster and shot log.
  const [film, setFilm] = useState<CinemaDetail | null>(null);
  const [showFilm, setShowFilm] = useState(false);
  const [filmErr, setFilmErr] = useState<string | null>(null);
  const [sysErr, setSysErr] = useState<string | null>(null);

  useEffect(() => {
    if (!showFilm || film) return;
    let dead = false;
    (async () => {
      try {
        const res = await fetch(`/api/recap/${encodeURIComponent(token)}/cinema`);
        if (dead) return;
        if (!res.ok) { setFilmErr(t('review.shared.filmErr')); return; }
        setFilm(await res.json());
      } catch {
        if (!dead) setFilmErr(t('review.shared.noServer'));
      }
    })();
    return () => { dead = true; };
  }, [showFilm, film, token]);

  useEffect(() => {
    if (!showSystem || system) return;
    let dead = false;
    (async () => {
      try {
        const res = await fetch(`/api/recap/${encodeURIComponent(token)}/system`);
        if (dead) return;
        if (!res.ok) { setSysErr(t('review.shared.sysErr')); return; }
        setSystem(await res.json());
      } catch {
        if (!dead) setSysErr(t('review.shared.noServer'));
      }
    })();
    return () => { dead = true; };
  }, [showSystem, system, token]);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        // Deliberately a bare fetch rather than apiFetch: there is no
        // session here and nothing to attach to the request.
        const res = await fetch(`/api/recap/${encodeURIComponent(token)}`);
        if (dead) return;
        if (!res.ok) {
          setErr(res.status === 404
            ? t('review.shared.badLink')
            : t('review.shared.loadFail', { status: res.status }));
          return;
        }
        setD(await res.json());
      } catch {
        if (!dead) setErr(t('review.shared.noServer'));
      }
    })();
    return () => { dead = true; };
  }, [token]);

  const b = d?.battle;
  const span = b ? (b.ended_tick ?? b.last_fire_tick) - b.started_tick + 1 : 0;
  // Only worth offering when the campaign was bigger than this fight. A
  // theatre of one is the recap already on the page.
  const wider = !!d?.theatre && d.theatre.battle_count > 1;

  useEffect(() => {
    if (b) document.title = t('review.shared.docTitle', { name: b.body_name ?? t('review.deepSpace') });
  }, [b]);

  return (
    <div className="shared-recap">
      <div className="shared-recap__inner">
        <a className="shared-recap__brand" href="/">ORBITAL</a>

        {err && <div className="shared-recap__err">{err}</div>}
        {!d && !err && <div className="shared-recap__loading">{t('review.shared.loading')}</div>}

        {d && b && (
          <>
            <h1 className="shared-recap__title">
              {b.body_name ?? t('review.deepSpace')}
              <span className="shared-recap__tick">T+{b.started_tick}–{b.ended_tick ?? b.last_fire_tick}</span>
            </h1>

            <div className="shared-recap__sides">
              {d.sides.map(s => (
                <span key={s.faction_id} className="shared-recap__side"
                  style={{ borderColor: s.color ?? NEUTRAL, color: s.color ?? NEUTRAL }}>
                  {s.name}
                  <b style={{ color: '#cfe0ee' }}>
                    {' '}{s.committed - s.lost}/{s.committed}
                  </b>
                </span>
              ))}
            </div>

            <div className="shared-recap__campaign">
              <span>
                {t('review.shared.filmPitch')}
              </span>
              <button onClick={() => setShowFilm(v => !v)}>
                {showFilm ? t('review.shared.closeFilm') : t('review.shared.watchFilm')}
              </button>
            </div>

            {showFilm && (filmErr
              ? <div className="shared-recap__err">{filmErr}</div>
              : film
                ? (
                  <React.Suspense fallback={
                    <div className="shared-recap__loading">{t('review.shared.loadingRenderer')}</div>
                  }>
                    <BattleCinema detail={film} />
                  </React.Suspense>
                )
                : <div className="shared-recap__loading">{t('review.shared.assembling')}</div>)}

            {wider && (
              <div className="shared-recap__campaign">
                <span>
                  {richT('review.shared.campaign', {
                    name: d.theatre!.anchor_name ?? t('review.shared.thisSystem'),
                    n: d.theatre!.battle_count,
                    a: d.theatre!.started_tick,
                    b: d.theatre!.last_fire_tick,
                  })}
                </span>
                <button onClick={() => setShowSystem(v => !v)}>
                  {showSystem ? t('review.shared.showEngagement') : t('review.shared.watchSystem')}
                </button>
              </div>
            )}

            {showSystem
              ? (sysErr
                ? <div className="shared-recap__err">{sysErr}</div>
                : system
                  ? <TheatreCanvas d={system} />
                  : <div className="shared-recap__loading">{t('review.shared.loadingCampaign')}</div>)
              : <BattleRecap d={d} />}

            <div className="shared-recap__stats">
              {tn('review.ticks', span, { n: span })} · {tn('review.shots', b.shots, { n: b.shots })} · {t('review.shared.hitPct', { pct: pct(b.hits, b.shots) })}
              {b.ships_lost > 0 && <> · <b style={{ color: '#ff8a80' }}>{t('review.shared.lost', { n: b.ships_lost })}</b></>}
              {b.victor && <> · {richT('review.shared.victor', { name: b.victor.name ?? '' })}</>}
            </div>

            <div className="shared-recap__foot">
              {t('review.shared.foot')}{' '}
              <a href="/">{t('review.shared.play')}</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
