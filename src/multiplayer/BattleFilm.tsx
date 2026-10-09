// ============================================================
// BattleFilm — one battle, on the game's own map.
//
// The recap used to be its own renderer, and every art update left it
// behind: old planet textures, every world the same size, capital ships
// as dots. This plays the battle through the match film's stage in focus
// mode (render/matchMap.ts), so it wears whatever the game wears.
//
// What a stranger needs, on top of the map:
//   a title card    where, who, when, before the first shot
//   the board       each side's hulls still flying, live
//   the kill feed   who destroyed whom, and the captain who did it
//   an end card     who won, what it cost, who flew best, watch again
// and a pace that spends the seconds on the shooting: quiet ticks pass
// quickly, and a whole battle lands in under a minute.
//
// The map data is a slice of the match record, filtered to this fight on
// the server (worker/recapMap.js). A battle with no map record (deep
// space, or older than the recorder) says so and the page falls back to
// the classic recap.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createMatchMap } from '../render/matchMap';
import type { MatchSummary, SnapshotRow, ReplayStage } from '../render/matchWorld';
import type { Detail } from './BattleReview';
import { pacing, filmSeconds, standingsAt, kills as allKills, ace as aceOf, phaseAt } from './battleFilmModel';
import { t, tn } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './BattleFilm.css';

type MapSummary = MatchSummary & { focus?: { bodyId: string; battleStart: number; battleEnd: number } };

const TITLE_SECONDS = 2.4;
const KILL_FEED_TICKS = 3;

export function BattleFilm({ token, d, onUnavailable }: {
  token: string; d: Detail; onUnavailable: () => void;
}) {
  useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [summary, setSummary] = useState<MapSummary | null>(null);
  const [rows, setRows] = useState<SnapshotRow[] | null>(null);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [titleLeft, setTitleLeft] = useState(TITLE_SECONDS);
  const posRef = useRef(0);
  const playRef = useRef(false);
  const speedRef = useRef(1);
  const titleRef = useRef(TITLE_SECONDS);
  playRef.current = playing; speedRef.current = speed;

  // ---- the record ----------------------------------------------------
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [s, r] = await Promise.all([
          fetch(`/api/recap/${encodeURIComponent(token)}/map`),
          fetch(`/api/recap/${encodeURIComponent(token)}/map/replay`),
        ]);
        if (dead) return;
        if (!s.ok || !r.ok) { onUnavailable(); return; }
        const sj: MapSummary = await s.json();
        const rj = await r.json();
        if (dead) return;
        if (!sj.focus || !Array.isArray(rj.rows) || rj.rows.length === 0) { onUnavailable(); return; }
        setSummary(sj);
        setRows(rj.rows);
      } catch {
        if (!dead) onUnavailable();
      }
    })();
    return () => { dead = true; };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const battle = useMemo(() => summary?.focus
    ? { start: summary.focus.battleStart, end: summary.focus.battleEnd }
    : { start: d.battle.started_tick, end: d.battle.ended_tick ?? d.battle.last_fire_tick }, [summary, d]);
  const range = useMemo(() => ({ lo: summary?.ticks.lo ?? battle.start, hi: summary?.ticks.hi ?? battle.end }),
    [summary, battle]);
  const rates = useMemo(() => pacing(d.frames, range, battle), [d, range, battle]);
  const totalSecs = useMemo(() => filmSeconds(rates), [rates]);
  const killList = useMemo(() => allKills(d), [d]);
  const ace = useMemo(() => aceOf(d), [d]);

  // ---- the stage ------------------------------------------------------
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !summary || !rows || !summary.focus) return;
    let stage: ReplayStage;
    try {
      stage = createMatchMap(summary, cv, {
        focus: { bodyId: summary.focus.bodyId, rateAt: tick => rates.get(tick) ?? 0.6 },
      });
    } catch {
      onUnavailable();
      return;
    }
    stage.applyRows(rows);
    posRef.current = range.lo;
    setPos(range.lo);

    const fit = () => {
      const r = cv.getBoundingClientRect();
      stage.resize(Math.max(320, r.width), Math.max(180, r.height));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(cv);

    // Start on its own unless the reader asked the world to hold still.
    let reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* old browser */ }
    if (!reduce) setPlaying(true);

    // Out of view or in a background tab, nothing is drawn: a recap
    // embedded below the fold should not cost anyone frames.
    let onScreen = true;
    const io = new IntersectionObserver(es => { onScreen = es.some(e => e.isIntersecting); });
    if (boxRef.current) io.observe(boxRef.current);

    let raf = 0;
    let last = performance.now();
    let frames = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(200, Math.max(0, now - last)) / 1000;
      last = now;
      if (!onScreen || document.hidden) return;
      if (playRef.current) {
        if (titleRef.current > 0) {
          titleRef.current = Math.max(0, titleRef.current - dt);
        } else {
          const rate = rates.get(Math.floor(posRef.current)) ?? 0.6;
          const next = posRef.current + (dt / rate) * speedRef.current;
          if (next >= range.hi) {
            posRef.current = range.hi;
            playRef.current = false;
            setPlaying(false);
          } else {
            posRef.current = next;
          }
        }
      }
      const tick = Math.floor(posRef.current);
      try {
        stage.setTick(tick, posRef.current - tick);
        stage.render();
      } catch (e) {
        // A frame that cannot draw is a recap nobody can watch: hand the
        // page back to the classic view rather than freeze on a canvas.
        console.error('[battle-film] frame failed at tick', tick, e);
        cancelAnimationFrame(raf);
        onUnavailable();
        return;
      }
      if ((frames++ % 5) === 0) { setPos(posRef.current); setTitleLeft(titleRef.current); }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
      stage.dispose();
    };
  }, [summary, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const seek = (p: number) => {
    posRef.current = Math.max(range.lo, Math.min(range.hi, p));
    titleRef.current = 0;
    setTitleLeft(0);
    setPos(posRef.current);
  };
  const replay = () => {
    posRef.current = range.lo;
    titleRef.current = TITLE_SECONDS;
    setPos(range.lo); setTitleLeft(TITLE_SECONDS); setPlaying(true);
  };

  const tick = Math.floor(pos);
  const ended = pos >= range.hi && !playing;
  const board = useMemo(() => standingsAt(d, tick), [d, tick]);
  const feed = killList.filter(k => k.tick <= tick && k.tick > tick - KILL_FEED_TICKS).slice(-4);
  const phase = phaseAt(tick, battle);
  const place = d.battle.body_name ?? t('review.deepSpace');
  const loading = !summary || !rows;
  const victor = d.battle.victor;
  const showTitle = !loading && titleLeft > 0 && pos <= range.lo + 0.01;

  return (
    <div className="bfilm" ref={boxRef}>
      <div className="bfilm__screen">
        <canvas ref={canvasRef} aria-label={t('review.film.canvasLabel', { name: place })} />
        {loading && <div className="bfilm__loading">{t('review.shared.assembling')}</div>}

        {!loading && (
          <>
            <div className="bfilm__where">
              <span className="bfilm__place">{t('review.film.battleOf', { name: place })}</span>
              <span className={`bfilm__phase bfilm__phase--${phase}`}>
                {t(`review.film.phase.${phase}` as 'review.film.phase.battle')} · T+{tick}
              </span>
            </div>

            <ol className="bfilm__board" aria-label={t('review.film.board')}>
              {board.slice(0, 6).map(s => (
                <li key={s.factionId} className={s.alive === 0 && s.total > 0 && tick >= battle.start ? 'is-out' : ''}>
                  <span className="bfilm__swatch" style={{ background: s.color }} />
                  <span className="bfilm__name">{s.name}</span>
                  <span className="bfilm__count">{s.alive}<small>/{s.total}</small></span>
                  <span className="bfilm__bar"><span style={{ width: `${s.total ? (100 * s.alive) / s.total : 0}%`, background: s.color }} /></span>
                </li>
              ))}
            </ol>

            <ul className="bfilm__feed" aria-live="polite">
              {feed.map((k, i) => (
                <li key={`${k.tick}-${i}`}>
                  <span className="bfilm__x" aria-hidden>✖</span>
                  <b style={{ color: k.victimColor }}>{k.victim}</b>
                  {k.killer
                    ? <> {t('review.film.by')} <b style={{ color: k.killerColor }}>{k.killer}</b>{k.captain ? <span className="bfilm__capt"> · {t('review.film.captain', { name: k.captain })}</span> : null}</>
                    : <> {t(k.structure ? 'review.film.fell' : 'review.film.destroyed')}</>}
                </li>
              ))}
            </ul>
          </>
        )}

        {showTitle && (
          <div className="bfilm__title" style={{ opacity: Math.min(1, titleLeft / 0.6) }}>
            <div className="bfilm__kicker">{t('review.film.kicker')}</div>
            <div className="bfilm__big">{place}</div>
            <div className="bfilm__sides">
              {board.slice(0, 4).map((s, i) => (
                <React.Fragment key={s.factionId}>
                  {i > 0 && <span className="bfilm__vs">·</span>}
                  <span style={{ color: s.color }}>{s.name}</span>
                </React.Fragment>
              ))}
              {board.length > 4 && <span className="bfilm__vs"> {t('review.film.more', { n: board.length - 4 })}</span>}
            </div>
            <div className="bfilm__meta">
              {t('review.film.turns', { a: battle.start, b: battle.end })}
              {summary?.game.name ? ` · ${summary.game.name}` : ''}
            </div>
          </div>
        )}

        {ended && (
          <div className="bfilm__end">
            <div className="bfilm__kicker">{t('review.film.over')}</div>
            <div className="bfilm__verdict" style={{ color: victor?.color ?? '#e6f0f8' }}>
              {victor ? t('review.film.wins', { name: victor.name ?? '' }) : t('review.film.noVictor')}
            </div>
            <div className="bfilm__toll">
              {tn('review.film.toll', d.battle.ships_lost, { n: d.battle.ships_lost, turns: battle.end - battle.start + 1 })}
            </div>
            <ol className="bfilm__final">
              {standingsAt(d, range.hi).map(s => (
                <li key={s.factionId}>
                  <span className="bfilm__swatch" style={{ background: s.color }} />
                  <span className="bfilm__name">{s.name}</span>
                  <span className="bfilm__count">{t('review.film.lostOf', { lost: s.total - s.alive, n: s.total })}</span>
                </li>
              ))}
            </ol>
            {ace && (
              <div className="bfilm__ace">
                {ace.captain
                  ? t('review.film.aceCaptain', { name: ace.captain, ship: ace.ship, n: ace.kills })
                  : t('review.film.aceShip', { ship: ace.ship, n: ace.kills })}
              </div>
            )}
            <button type="button" className="bfilm__again" onClick={replay}>{t('review.film.again')}</button>
          </div>
        )}
      </div>

      <div className="bfilm__transport">
        <button type="button" disabled={loading}
          onClick={() => (ended ? replay() : setPlaying(p => !p))}
          aria-label={ended ? t('review.cinema.replay') : playing ? t('review.cinema.pause') : t('review.cinema.play')}>
          {ended ? '↺' : playing ? '❚❚' : '▶'}
        </button>
        <input type="range" min={range.lo} max={Math.max(range.lo + 0.001, range.hi)} step={0.01} value={pos}
          disabled={loading}
          onChange={e => { setPlaying(false); seek(Number(e.target.value)); }}
          aria-label={t('review.cinema.scrub')} />
        <span className="bfilm__clock">{t('review.film.length', { s: Math.round(totalSecs / speed) })}</span>
        <select value={speed} onChange={e => setSpeed(Number(e.target.value))} aria-label={t('review.cinema.speed')}>
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
        </select>
      </div>
    </div>
  );
}
