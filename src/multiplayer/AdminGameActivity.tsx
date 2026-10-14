// ============================================================
// AdminGameActivity — the Games tab's growth chart (admin).
//
// "Active" = a real player spent at least a minute in the game that UTC
// day (a heartbeat; robots and test accounts excluded). The same test
// as the Pulse tile, so the two can never disagree.
//
//   top      the headline figures: last 24h, the 7-day average and its
//            change, the peak, games started and ended, players per game
//   chart    active games per day, stacked by how many real players
//            were in each one, with a trailing 7-day average line
//   strip    games started (up) and ended (down) on the same days
//   detail   hover or click a day: every game active that day
//   table    the same numbers as rows, for reading exact values
//
// Data: GET /api/admin/games/activity (worker/adminDashboard.js).
// ============================================================

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { apiFetch } from './api';
import { playTime } from './adminFormat';
import './AdminGameActivity.css';

const DAY = 86_400_000;

type GameMeta = { name: string; status: string; started_at: number | null; completed_at: number | null };
type Activity = {
  now: number;
  since: number;
  rows: Array<[number, string, number, number, number]>; // day, game, players, minutes, actions
  games: Record<string, GameMeta>;
  live: string[];
};
type DayGame = { id: string; players: number; minutes: number; actions: number };
type Day = {
  day_ms: number;
  games: DayGame[];
  big: number; mid: number; solo: number; total: number;
  players: number; // summed over games (a player in two games counts twice)
  started: string[];
  ended: string[];
  avg7: number | null; // trailing 7 complete days, this one included
  today: boolean;
};

const nf = new Intl.NumberFormat();
const n = (v: number) => nf.format(v);
const one = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const dayLabel = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayLong = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const hours = (min: number) => (min >= 600 ? `${n(Math.round(min / 60))}h` : playTime(min));
const STATUS: Record<string, string> = { active: 'running', completed: 'finished', abandoned: 'abandoned' };

// Game size, largest first: the stack is anchored on the 4+ games, the
// ones that are most clearly a real match, so their growth reads off
// the baseline.
const SIZES = [
  { key: 'big', label: '4+ players', cls: 'ga-c-big' },
  { key: 'mid', label: '2–3 players', cls: 'ga-c-mid' },
  { key: 'solo', label: '1 player', cls: 'ga-c-solo' },
] as const;

/** 1, 2, 5 x 10^n: a top gridline a person can read at a glance. */
function niceMax(v: number): number {
  if (v <= 4) return Math.max(1, Math.ceil(v));
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** A callback ref + its width: the plot mounts only once data is in, so
 *  a mount-time effect would never see it. */
function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w];
}

function buildDays(a: Activity): Day[] {
  const today = Math.floor(a.now / DAY) * DAY;
  const byDay = new Map<number, DayGame[]>();
  for (const [d, id, players, minutes, actions] of a.rows) {
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push({ id, players, minutes, actions });
  }
  const startedOn = new Map<number, string[]>();
  const endedOn = new Map<number, string[]>();
  const push = (m: Map<number, string[]>, ms: number | null, id: string) => {
    if (ms == null) return;
    const d = Math.floor(ms / DAY) * DAY;
    if (!m.has(d)) m.set(d, []);
    m.get(d)!.push(id);
  };
  for (const [id, g] of Object.entries(a.games)) {
    if (g.started_at != null && g.started_at >= a.since) push(startedOn, g.started_at, id);
    if (g.completed_at != null && g.completed_at >= a.since) push(endedOn, g.completed_at, id);
  }
  // From the first day anything happened, so "All" has no empty lead-in.
  const firsts = [...byDay.keys(), ...startedOn.keys(), ...endedOn.keys()];
  const start = firsts.length ? Math.min(...firsts) : today;
  const days: Day[] = [];
  for (let d = start; d <= today; d += DAY) {
    const games = (byDay.get(d) ?? []).slice().sort((x, y) => y.players - x.players || y.minutes - x.minutes);
    const big = games.filter(g => g.players >= 4).length;
    const mid = games.filter(g => g.players >= 2 && g.players <= 3).length;
    days.push({
      day_ms: d, games, big, mid, solo: games.length - big - mid, total: games.length,
      players: games.reduce((s, g) => s + g.players, 0),
      started: startedOn.get(d) ?? [], ended: endedOn.get(d) ?? [],
      avg7: null, today: d === today,
    });
  }
  // Trailing average over complete days only: today is still filling in.
  for (let i = 6; i < days.length; i++) {
    if (days[i].today) break;
    let s = 0;
    for (let k = i - 6; k <= i; k++) s += days[k].total;
    days[i].avg7 = s / 7;
  }
  return days;
}

function Change({ cur, prev, label = 'vs prior 7 days' }: { cur: number; prev: number; label?: string }) {
  if (!prev && !cur) return <span className="ao-delta">no change</span>;
  if (!prev) return <span className="ao-delta ao-delta--up">new this week</span>;
  const p = Math.round(((cur - prev) / prev) * 100);
  if (p === 0) return <span className="ao-delta">flat {label}</span>;
  return (
    <span className={`ao-delta ${p > 0 ? 'ao-delta--up' : 'ao-delta--down'}`}>
      {p > 0 ? '▲' : '▼'} {Math.abs(p)}% {label}
    </span>
  );
}

function Stat({ label, value, foot }: { label: string; value: React.ReactNode; foot?: React.ReactNode }) {
  return (
    <div className="ga-stat">
      <span className="ga-stat__label">{label}</span>
      <span className="ga-stat__value">{value}</span>
      {foot && <span className="ga-stat__foot">{foot}</span>}
    </div>
  );
}

type Range = 30 | 90 | 0;

export function GameActivity({ refreshKey, onOpen }: { refreshKey: number; onOpen: (id: string) => void }) {
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>(() => (typeof window !== 'undefined' && window.innerWidth < 640 ? 30 : 90));
  const [hover, setHover] = useState<number | null>(null);
  const [pin, setPin] = useState<number | null>(null); // a day_ms, so it survives a range change
  const [table, setTable] = useState(false);
  const [wrapRef, width] = useWidth<HTMLDivElement>();

  useEffect(() => {
    let live = true;
    void apiFetch<Activity>('/api/admin/games/activity').then(res => {
      if (!live) return;
      if (res.ok) { setData(res.data); setError(null); } else setError(res.error?.message ?? 'Could not load game activity');
    });
    return () => { live = false; };
  }, [refreshKey]);

  const all = useMemo(() => (data ? buildDays(data) : []), [data]);
  const view = useMemo(() => (range ? all.slice(-range) : all), [all, range]);

  // ---- headline figures (always the latest week, whatever the range) ----
  const stats = useMemo(() => {
    if (!data || !all.length) return null;
    const complete = all.filter(d => !d.today);
    const wk = complete.slice(-7), prev = complete.slice(-14, -7);
    const sum = (ds: Day[], f: (d: Day) => number) => ds.reduce((s, d) => s + f(d), 0);
    const since = (from: number, to: number, key: 'started_at' | 'completed_at') =>
      Object.values(data.games).filter(g => g[key] != null && g[key]! >= from && g[key]! < to).length;
    const peak = view.reduce<Day | null>((b, d) => (!b || d.total > b.total ? d : b), null);
    return {
      live: data.live.length,
      avg: sum(wk, d => d.total) / Math.max(1, wk.length),
      avgPrev: sum(prev, d => d.total) / Math.max(1, prev.length),
      ppg: sum(wk, d => d.players) / Math.max(1, sum(wk, d => d.total)),
      ppgPrev: sum(prev, d => d.players) / Math.max(1, sum(prev, d => d.total)),
      started: since(data.now - 7 * DAY, data.now + 1, 'started_at'),
      startedPrev: since(data.now - 14 * DAY, data.now - 7 * DAY, 'started_at'),
      ended: since(data.now - 7 * DAY, data.now + 1, 'completed_at'),
      endedPrev: since(data.now - 14 * DAY, data.now - 7 * DAY, 'completed_at'),
      peak,
      hasPrev: prev.length === 7,
    };
  }, [data, all, view]);

  const pinIdx = pin == null ? null : view.findIndex(d => d.day_ms === pin);
  const shownIdx = hover ?? (pinIdx != null && pinIdx >= 0 ? pinIdx : view.length - 1);
  const shown = view[shownIdx];

  const togglePin = useCallback((i: number) => {
    const d = view[i]?.day_ms;
    setPin(p => (p === d ? null : d ?? null));
  }, [view]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!view.length) return;
    const cur = pinIdx != null && pinIdx >= 0 ? pinIdx : view.length - 1;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setPin(view[Math.max(0, cur - 1)].day_ms); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setPin(view[Math.min(view.length - 1, cur + 1)].day_ms); }
    else if (e.key === 'Escape') setPin(null);
  };

  // ---- geometry ----
  const PAD_L = 40, PAD_R = 6, MAIN_H = 240, TOP = 10, GAP_Y = 14, STRIP_H = 72, X_H = 22;
  const W = Math.max(280, width);
  const plotW = W - PAD_L - PAD_R;
  const N = Math.max(1, view.length);
  const band = plotW / N;
  const barW = Math.max(1, band - (band >= 6 ? 2 : 1));
  const maxV = Math.max(1, ...view.map(d => Math.max(d.total, d.avg7 ?? 0)));
  const top = niceMax(maxV);
  const yMain = (v: number) => TOP + MAIN_H - (v / top) * MAIN_H;
  const ticks = top <= 4 ? Array.from({ length: top + 1 }, (_, i) => i) : [0, top / 4, top / 2, (3 * top) / 4, top];
  const stripTop = TOP + MAIN_H + GAP_Y;
  const stripMid = stripTop + STRIP_H / 2;
  const sMax = Math.max(1, ...view.map(d => Math.max(d.started.length, d.ended.length)));
  const sY = (v: number) => (v / sMax) * (STRIP_H / 2 - 2);
  const H = stripTop + STRIP_H + X_H;
  const xOf = (i: number) => PAD_L + i * band + (band - barW) / 2;
  const cx = (i: number) => PAD_L + i * band + band / 2;
  const r = Math.min(3, barW / 2);

  const avgPath = view
    .map((d, i) => (d.avg7 == null ? null : `${cx(i).toFixed(1)},${yMain(d.avg7).toFixed(1)}`))
    .reduce<string[]>((segs, p, i, arr) => {
      if (p == null) return segs;
      segs.push(`${i > 0 && arr[i - 1] != null ? 'L' : 'M'}${p}`);
      return segs;
    }, [])
    .join(' ');

  const roundTop = (x: number, y: number, w: number, h: number) => {
    const rr = Math.min(r, h);
    return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
  };

  const labelEvery = N <= 31 ? 7 : 14;

  return (
    <section className="ao-panel ga">
      <div className="ao-phead">
        <div>
          <h3 className="ao-phead__title">Active games</h3>
          <p className="ao-phead__hint">
            Games a real player spent at least a minute in, per UTC day, by how many players were there.
            Robots and test accounts are left out. Hover a day for its games; click to keep it.
          </p>
        </div>
        <div className="ao-phead__tools">
          <div className="ao-seg" role="group" aria-label="Range">
            {([[30, '30 days'], [90, '90 days'], [0, 'All']] as Array<[Range, string]>).map(([v, l]) => (
              <button key={l} className={`ao-seg__opt${range === v ? ' is-active' : ''}`} aria-pressed={range === v}
                      onClick={() => { setRange(v); setHover(null); }}>{l}</button>
            ))}
          </div>
          <button className={`ga-tbtn${table ? ' is-on' : ''}`} aria-pressed={table} onClick={() => setTable(t => !t)}>
            Table
          </button>
        </div>
      </div>

      {error && <div className="ao-none">{error}</div>}
      {!data && !error && <div className="ao-none">Loading game activity…</div>}

      {stats && (
        <div className="ga-stats">
          <Stat label="Active · last 24h" value={n(stats.live)} foot="running games with a player in them" />
          <Stat
            label="Average per day · 7 days"
            value={one(stats.avg)}
            foot={stats.hasPrev ? <Change cur={stats.avg} prev={stats.avgPrev} /> : 'not enough history yet'}
          />
          <Stat
            label={`Peak · ${range ? `${range} days` : 'all time'}`}
            value={stats.peak ? n(stats.peak.total) : '0'}
            foot={stats.peak?.total ? dayLong(stats.peak.day_ms) : '—'}
          />
          <Stat label="Players per game · 7 days" value={one(stats.ppg)}
                foot={stats.hasPrev ? <Change cur={stats.ppg} prev={stats.ppgPrev} /> : undefined} />
          <Stat label="Started · 7 days" value={n(stats.started)}
                foot={<Change cur={stats.started} prev={stats.startedPrev} />} />
          <Stat label="Ended · 7 days" value={n(stats.ended)}
                foot={<span className="ao-dim">{n(stats.endedPrev)} the week before</span>} />
        </div>
      )}

      {data && shown && (
        <>
          <div className="ga-legend" aria-hidden>
            {SIZES.map(s => <span key={s.key}><i className={`ga-sw ${s.cls}`} />{s.label}</span>)}
            <span><i className="ga-sw ga-sw--line" />7-day average</span>
            <span><i className="ga-sw ga-sw--start" />started</span>
            <span><i className="ga-sw ga-sw--end" />ended</span>
          </div>

          <div className="ao-readout ga-readout" aria-live="polite">
            <span className="ao-readout__day">{shown.today ? 'Today so far' : dayLong(shown.day_ms)}{pinIdx === shownIdx && hover == null && pin != null ? ' · kept' : ''}</span>
            <span><b>{n(shown.total)}</b> active</span>
            <span><b>{n(shown.big)}</b> with 4+</span>
            <span><b>{n(shown.mid)}</b> with 2–3</span>
            <span><b>{n(shown.solo)}</b> solo</span>
            <span><b>{shown.total ? one(shown.players / shown.total) : '—'}</b> players per game</span>
            <span><b>{shown.avg7 == null ? '—' : one(shown.avg7)}</b> 7-day avg</span>
            <span><b>{n(shown.started.length)}</b> started</span>
            <span><b>{n(shown.ended.length)}</b> ended</span>
          </div>

          <div
            ref={wrapRef}
            className="ga-plot"
            tabIndex={0}
            role="img"
            aria-label={`Active games per day over ${view.length} days, latest ${view[view.length - 1]?.total ?? 0}. Use the arrow keys to step through days.`}
            onKeyDown={onKey}
            onMouseLeave={() => setHover(null)}
          >
            {width > 0 && (
              <svg viewBox={`0 0 ${W} ${H}`} className="ga-svg" preserveAspectRatio="xMinYMin meet">
                {/* gridlines + y labels */}
                {ticks.map(t => (
                  <g key={t}>
                    <line x1={PAD_L} x2={W - PAD_R} y1={yMain(t)} y2={yMain(t)} className={t === 0 ? 'ga-axis' : 'ga-grid'} />
                    <text x={PAD_L - 8} y={yMain(t) + 4} className="ga-ylab" textAnchor="end">{Number.isInteger(t) ? t : one(t)}</text>
                  </g>
                ))}

                {/* the shown / kept day */}
                {shownIdx >= 0 && (
                  <rect x={PAD_L + shownIdx * band} y={TOP - 6} width={band} height={H - X_H - TOP + 6} className="ga-band" rx={3} />
                )}

                {/* stacked bars */}
                {view.map((d, i) => {
                  let y = yMain(0);
                  const segs: React.ReactNode[] = [];
                  const parts = SIZES.map(s => ({ ...s, v: d[s.key] })).filter(p => p.v > 0);
                  parts.forEach((p, k) => {
                    const h = (p.v / top) * MAIN_H;
                    const gap = k > 0 && h > 3 ? 2 : 0;
                    const segH = h - gap;
                    y -= h;
                    segs.push(k === parts.length - 1
                      ? <path key={p.key} d={roundTop(xOf(i), y, barW, segH)} className={`${p.cls}${d.today ? ' ga-today' : ''}`} />
                      : <rect key={p.key} x={xOf(i)} y={y} width={barW} height={segH} className={`${p.cls}${d.today ? ' ga-today' : ''}`} />);
                  });
                  return <g key={d.day_ms}>{segs}</g>;
                })}

                {/* 7-day average: a surface halo first, so it reads over the bars */}
                {avgPath && <path d={avgPath} className="ga-avg-halo" />}
                {avgPath && <path d={avgPath} className="ga-avg" />}
                {shown.avg7 != null && <circle cx={cx(shownIdx)} cy={yMain(shown.avg7)} r={3.5} className="ga-avg-dot" />}

                {/* started / ended strip */}
                <line x1={PAD_L} x2={W - PAD_R} y1={stripMid} y2={stripMid} className="ga-axis" />
                <text x={PAD_L - 8} y={stripTop + 10} className="ga-ylab" textAnchor="end">+{sMax}</text>
                <text x={PAD_L - 8} y={stripTop + STRIP_H - 2} className="ga-ylab" textAnchor="end">−{sMax}</text>
                {view.map((d, i) => (
                  <g key={`s${d.day_ms}`}>
                    {d.started.length > 0 && (
                      <rect x={xOf(i)} y={stripMid - sY(d.started.length) - 1} width={barW} height={sY(d.started.length)} rx={Math.min(2, barW / 2)} className="ga-start" />
                    )}
                    {d.ended.length > 0 && (
                      <rect x={xOf(i)} y={stripMid + 1} width={barW} height={sY(d.ended.length)} rx={Math.min(2, barW / 2)} className="ga-end" />
                    )}
                  </g>
                ))}

                {/* x labels, counted back from today */}
                {view.map((d, i) => {
                  const back = view.length - 1 - i;
                  if (back !== 0 && back % labelEvery !== 0) return null;
                  return (
                    <text key={`x${d.day_ms}`} x={cx(i)} y={H - 6} className="ga-xlab"
                          textAnchor={back === 0 ? 'end' : 'middle'}>
                      {back === 0 ? 'Today' : dayLabel(d.day_ms)}
                    </text>
                  );
                })}

                {/* hit targets: the whole column, bars and strip */}
                {view.map((d, i) => (
                  <rect key={`h${d.day_ms}`} x={PAD_L + i * band} y={0} width={band} height={H - X_H}
                        className="ga-hit"
                        onMouseEnter={() => setHover(i)}
                        onClick={() => togglePin(i)} />
                ))}
              </svg>
            )}
          </div>

          {/* ---- the day's games ---- */}
          <div className="ga-day">
            <div className="ga-day__head">
              <span className="ga-day__title">{shown.today ? 'Today so far' : dayLong(shown.day_ms)}</span>
              <span className="ao-dim">
                {pin != null && pinIdx === shownIdx && hover == null
                  ? 'Kept. Click the day again or press Esc to let go.'
                  : 'Click a day to keep it here.'}
              </span>
            </div>
            {shown.games.length === 0 && shown.started.length === 0 && shown.ended.length === 0 ? (
              <div className="ao-none">No game had a player in it this day.</div>
            ) : (
              <div className="ga-games">
                {shown.games.map(g => {
                  const meta = data.games[g.id];
                  const tags = [
                    shown.started.includes(g.id) ? 'started' : null,
                    shown.ended.includes(g.id) ? 'ended' : null,
                  ].filter(Boolean);
                  return (
                    <button key={g.id} className="ga-game" onClick={() => onOpen(g.id)} title="Open this game">
                      <span className={`ga-size ${g.players >= 4 ? 'ga-c-big' : g.players >= 2 ? 'ga-c-mid' : 'ga-c-solo'}`} aria-hidden />
                      <span className="ga-game__name">{meta?.name ?? g.id}</span>
                      <span className="ga-game__meta">
                        <b>{g.players}</b> {g.players === 1 ? 'player' : 'players'} · {hours(g.minutes)} · {n(g.actions)} actions
                      </span>
                      <span className="ga-game__tags">
                        {tags.map(t => <span key={t} className={`ga-tag ga-tag--${t}`}>{t}</span>)}
                        {meta && meta.status !== 'active' && <span className="ga-tag">{STATUS[meta.status] ?? meta.status}</span>}
                      </span>
                    </button>
                  );
                })}
                {/* Started or ended with nobody playing that day: still worth seeing. */}
                {[...shown.started, ...shown.ended]
                  .filter((id, i, arr) => arr.indexOf(id) === i && !shown.games.some(g => g.id === id))
                  .map(id => (
                    <button key={id} className="ga-game ga-game--quiet" onClick={() => onOpen(id)} title="Open this game">
                      <span className="ga-size" aria-hidden />
                      <span className="ga-game__name">{data.games[id]?.name ?? id}</span>
                      <span className="ga-game__meta">nobody played in it this day</span>
                      <span className="ga-game__tags">
                        {shown.started.includes(id) && <span className="ga-tag ga-tag--started">started</span>}
                        {shown.ended.includes(id) && <span className="ga-tag ga-tag--ended">{STATUS[data.games[id]?.status] === 'abandoned' ? 'abandoned' : 'ended'}</span>}
                      </span>
                    </button>
                  ))}
              </div>
            )}
          </div>

          {table && (
            <div className="ao-scroll ga-table">
              <table className="ao-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="num">Active</th>
                    <th className="num">4+</th>
                    <th className="num">2–3</th>
                    <th className="num">Solo</th>
                    <th className="num">7-day avg</th>
                    <th className="num">Players / game</th>
                    <th className="num">Started</th>
                    <th className="num">Ended</th>
                  </tr>
                </thead>
                <tbody>
                  {view.slice().reverse().map(d => (
                    <tr key={d.day_ms} className={pin === d.day_ms ? 'is-kept' : ''}>
                      <td>{d.today ? 'Today so far' : dayLong(d.day_ms)}</td>
                      <td className="num">{n(d.total)}</td>
                      <td className="num">{n(d.big)}</td>
                      <td className="num">{n(d.mid)}</td>
                      <td className="num">{n(d.solo)}</td>
                      <td className="num">{d.avg7 == null ? '—' : one(d.avg7)}</td>
                      <td className="num">{d.total ? one(d.players / d.total) : '—'}</td>
                      <td className="num">{n(d.started.length)}</td>
                      <td className="num">{n(d.ended.length)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
