// ============================================================
// AdminTrafficTrends — link and ad traffic, per source, per day (admin).
//
// One line per source the viewer picks (six at most), for one step of
// the visit funnel: visitors, engaged, pressed Play, started sign-up,
// signed up, took a seat. "Share of visitors" divides that step by the
// same source's visitors that day, so a small link that converts well
// is not drowned out by a big one that doesn't. Days are UTC; today's
// segment is dashed because the day is not over.
//
// Colours follow the source, not its rank: a source keeps its colour
// for as long as it stays picked. The six hues were checked for
// colour-blind separation (OKLab dE >= 8 for every pair under deutan,
// protan and tritan simulation, on the dashboard's dark surface), and
// every line is also named at its end and in the hover card.
//
// Data: traffic.daily in the admin overview (worker/adminDashboard.js),
// the same funnel definitions as the traffic tables beside it.
// ============================================================

import React, { useLayoutEffect, useMemo, useState } from 'react';
import './AdminTrafficTrends.css';
import { isAiSource, AI_GROUP } from './aiSources';

const DAY = 86_400_000;

export type TrafficDay = {
  day_ms: number; source: string;
  visitors: number; engaged: number; pressed_play: number; started: number; signed_up: number; seated: number;
};

const METRICS = [
  { key: 'visitors', label: 'Visitors' },
  { key: 'engaged', label: 'Engaged' },
  { key: 'pressed_play', label: 'Pressed Play' },
  { key: 'started', label: 'Started sign-up' },
  { key: 'signed_up', label: 'Signed up' },
  { key: 'seated', label: 'Took a seat' },
] as const;
type MetricKey = typeof METRICS[number]['key'];
const RANGES = [7, 14, 30] as const;
/** Lines on the chart at once: one per colour (AdminTrafficTrends.css). */
const SLOTS = 6;
/** A day with fewer visitors than this from a source has no share: 1 of 1
 *  is "100%" and says nothing. */
const MIN_FOR_SHARE = 3;
const STORE = 'ao.trafficTrends.v1';

const SOURCE_NAME: Record<string, string> = {
  'reddit-ads': 'Reddit ads', reddit: 'Reddit, untagged', 'chatgpt.com': 'ChatGPT', google: 'Google search',
  bing: 'Bing', duckduckgo: 'DuckDuckGo', invite: 'Invite links', 'android-app': 'Android app',
  'discord-replay': 'Discord replay', 'discord-feed': 'Discord game feed', facebook: 'Facebook',
  [AI_GROUP]: 'AI assistants',
};
/** "r-space" → "r/space"; the commonest tags in words; anything else as is. */
export const sourceName = (s: string) => SOURCE_NAME[s] ?? (s.startsWith('r-') ? `r/${s.slice(2)}` : s);

const nf = new Intl.NumberFormat();
const dayLabel = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayLong = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

type Saved = { metric?: MetricKey; share?: boolean; range?: number; picked?: string[]; total?: boolean };
// Per-viewer convenience only: a private window or blocked storage just
// starts from the defaults.
function loadSaved(): Saved {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}') ?? {}; } catch { return {}; }
}
function save(s: Saved) {
  try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* storage off */ }
}

/** A step of 1, 2 or 5 x 10^n, about a quarter of the top value. */
function niceStep(max: number): number {
  const raw = Math.max(max, 1) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return Math.max(m * p, 1);
  return 10 * p;
}

/** A callback ref + its width (the plot mounts after the data). */
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

type Point = { v: number | null; n: number; of: number };
type Series = { source: string; slot: number; pts: Point[] };

/** Every AI assistant folded into one source per day (aiSources.js), so
 *  ChatGPT, Perplexity, Claude... read as one line. Each day's rows still
 *  add up to the same total. */
function foldAi(rows: TrafficDay[]): TrafficDay[] {
  const out: TrafficDay[] = [];
  const ai = new Map<number, TrafficDay>();
  for (const r of rows) {
    if (!isAiSource(r.source)) { out.push(r); continue; }
    const d = ai.get(r.day_ms);
    if (!d) { ai.set(r.day_ms, { ...r, source: AI_GROUP }); continue; }
    for (const m of METRICS) d[m.key] += r[m.key];
  }
  return [...out, ...ai.values()].sort((a, b) => a.day_ms - b.day_ms);
}

export function TrafficTrends({ rows: raw, now }: { rows: TrafficDay[]; now: number }) {
  const rows = useMemo(() => foldAi(raw), [raw]);
  const saved = useMemo(loadSaved, []);
  const [metric, setMetric] = useState<MetricKey>(
    METRICS.some(m => m.key === saved.metric) ? saved.metric! : 'visitors');
  const [share, setShare] = useState(!!saved.share);
  const [range, setRange] = useState<number>(RANGES.includes(saved.range as 7) ? saved.range! : 14);
  const [showTotal, setShowTotal] = useState(!!saved.total);
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [full, setFull] = useState(false);
  const [plotRef, width] = useWidth<HTMLDivElement>();

  // Every source seen in the 30 days, busiest first: the chip order, and
  // the default pick.
  const allSources = useMemo(() => {
    const t = new Map<string, number>();
    for (const r of rows) t.set(r.source, (t.get(r.source) ?? 0) + r.visitors);
    return [...t.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  }, [rows]);

  // slots[i] = the source drawn in colour i, or null.
  const [slots, setSlots] = useState<(string | null)[]>(() => {
    const want = (saved.picked ?? allSources.slice(0, 5)).filter(s => allSources.includes(s)).slice(0, SLOTS);
    return Array.from({ length: SLOTS }, (_, i) => want[i] ?? null);
  });
  const picked = slots.filter((s): s is string => !!s);

  const persist = (p: Partial<Saved>) =>
    save({ metric, share, range, total: showTotal, picked, ...p });

  const shareOn = share && metric !== 'visitors';
  const today = Math.floor(now / DAY) * DAY;
  // No invented history: the axis starts where recording did, if later.
  const firstDay = rows.length ? Math.min(...rows.map(r => r.day_ms)) : today;
  const start = Math.max(today - (range - 1) * DAY, firstDay);
  const days = useMemo(() => {
    const out: number[] = [];
    for (let d = start; d <= today; d += DAY) out.push(d);
    return out;
  }, [start, today]);

  const cell = useMemo(() => {
    const m = new Map<string, TrafficDay>();
    for (const r of rows) m.set(`${r.source}|${r.day_ms}`, r);
    return m;
  }, [rows]);

  const point = (n: number, of: number): Point =>
    shareOn ? { v: of >= MIN_FOR_SHARE ? (n / of) * 100 : null, n, of } : { v: n, n, of };

  const series: Series[] = slots.flatMap((source, slot) => source ? [{
    source, slot,
    pts: days.map(d => {
      const r = cell.get(`${source}|${d}`);
      return point(r ? r[metric] : 0, r ? r.visitors : 0);
    }),
  }] : []);
  const total: Point[] = days.map(d => {
    let n = 0, of = 0;
    for (const r of rows) if (r.day_ms === d) { n += r[metric]; of += r.visitors; }
    return point(n, of);
  });

  // Range totals per source for the chips (always counts: a share summed
  // over days means nothing).
  const rangeTotal = (source: string) =>
    rows.reduce((s, r) => s + (r.source === source && r.day_ms >= start ? r[metric] : 0), 0);
  const chipSources = allSources.filter(s => rows.some(r => r.source === s && r.day_ms >= start) || picked.includes(s));

  const toggle = (s: string) => {
    const at = slots.indexOf(s);
    let next = [...slots];
    if (at >= 0) next[at] = null;
    else {
      const free = next.indexOf(null);
      if (free < 0) { setFull(true); return; }
      next[free] = s;
    }
    setFull(false);
    setSlots(next);
    persist({ picked: next.filter((x): x is string => !!x) });
  };
  const pickTop = () => {
    const next = Array.from({ length: SLOTS }, (_, i) => (i < 5 ? chipSources[i] ?? null : null));
    setSlots(next); setFull(false);
    persist({ picked: next.filter((x): x is string => !!x) });
  };
  const clear = () => {
    setSlots(Array.from({ length: SLOTS }, () => null)); setFull(false);
    persist({ picked: [] });
  };

  const mLabel = METRICS.find(m => m.key === metric)!.label;
  const fmt = (p: Point) =>
    p.v == null ? (shareOn ? `– (${nf.format(p.of)} visitor${p.of === 1 ? '' : 's'})` : '–')
      : shareOn ? `${Math.round(p.v)}% · ${nf.format(p.n)} of ${nf.format(p.of)}` : nf.format(p.v);

  // The best single day among the lines drawn: the headline.
  let best: { source: string; day: number; p: Point; v: number } | null = null;
  for (const s of series) {
    for (let i = 0; i < s.pts.length; i++) {
      const p = s.pts[i]!;
      if (p.v != null && p.v > 0 && (!best || p.v > best.v)) best = { source: s.source, day: days[i]!, p, v: p.v };
    }
  }

  // ---- geometry ----
  const narrow = width > 0 && width < 560;
  const H = 280, mt = 14, mb = 30, ml = 44, mr = narrow ? 14 : 128;
  const pw = Math.max(0, width - ml - mr), ph = H - mt - mb;
  const drawn = [...series.map(s => s.pts), ...(showTotal ? [total] : [])];
  const maxV = Math.max(0, ...drawn.flatMap(pts => pts.map(p => p.v ?? 0)));
  const step = shareOn ? (maxV > 50 ? 25 : niceStep(maxV)) : niceStep(maxV);
  const yMax = shareOn ? Math.min(100, Math.max(step, Math.ceil(maxV / step) * step)) : Math.max(step, Math.ceil(maxV / step) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= yMax + 1e-9; v += step) ticks.push(v);
  const last = days.length - 1;
  const x = (i: number) => ml + (last <= 0 ? pw / 2 : (i / last) * pw);
  const y = (v: number) => mt + ph - (v / yMax) * ph;

  /** Solid through yesterday, dashed into today; a missing share breaks the line. */
  const paths = (pts: Point[]) => {
    let solid = '', open = false;
    pts.forEach((p, i) => {
      if (i === last && last > 0) return;
      if (p.v == null) { open = false; return; }
      solid += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`;
      open = true;
    });
    const a = pts[last - 1], b = pts[last];
    const dashed = last > 0 && a?.v != null && b?.v != null
      ? `M${x(last - 1).toFixed(1)} ${y(a.v).toFixed(1)}L${x(last).toFixed(1)} ${y(b.v).toFixed(1)}` : '';
    return { solid, dashed };
  };

  // End labels: at each line's last value, pushed apart so none overlap.
  const ends = series.flatMap(s => {
    const at = [...s.pts.keys()].reverse().find(k => s.pts[k]!.v != null);
    return at == null ? [] : [{ s, y: y(s.pts[at]!.v!) }];
  }).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) {
    const prev = ends[k - 1]!, cur = ends[k]!;
    if (cur.y - prev.y < 15) cur.y = prev.y + 15;
  }
  // Then back up from the floor, moving only the labels that must move.
  for (let k = ends.length - 1; k >= 0; k--) {
    const below = k === ends.length - 1 ? mt + ph + 15 : ends[k + 1].y;
    ends[k].y = Math.min(ends[k].y, below - 15);
  }

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - box.left;
    setHover(Math.max(0, Math.min(last, Math.round(last <= 0 ? 0 : ((px - ml) / pw) * last))));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const at = hover ?? last;
    setHover(Math.max(0, Math.min(last, at + (e.key === 'ArrowLeft' ? -1 : 1))));
  };

  const hovered = hover != null ? days[hover] : undefined;
  const cardRows = hover == null ? [] : [
    ...series.map(s => ({ key: s.source, name: sourceName(s.source), slot: s.slot as number | null, p: s.pts[hover]! })),
    ...(showTotal ? [{ key: '__total', name: 'All sources', slot: null, p: total[hover]! }] : []),
  ].sort((a, b) => (b.p.v ?? -1) - (a.p.v ?? -1));
  // The card sits in the half of the plot away from the hovered day, so
  // it never covers the points being read.
  const cardLeft = hover == null ? 0 : x(hover) > ml + pw / 2 ? ml + 8 : ml + pw - 238;

  if (!rows.length) return null;

  return (
    <div className="tt">
      <div className="tt-head">
        <h4 className="tt-title">Per source, per day</h4>
        <span className="tt-best">
          {best ? <>Best day: <b>{dayLabel(best.day)}</b>, {sourceName(best.source)}, {fmt(best.p)}{shareOn ? '' : ` ${mLabel.toLowerCase()}`}</> : 'Pick a source below to draw its line.'}
        </span>
      </div>

      <div className="tt-controls" role="toolbar" aria-label="Chart options">
        <div className="tt-seg" role="radiogroup" aria-label="Funnel step">
          {METRICS.map(m => (
            <button key={m.key} type="button" role="radio" aria-checked={metric === m.key}
              className={metric === m.key ? 'is-on' : ''}
              onClick={() => { setMetric(m.key); persist({ metric: m.key }); }}>{m.label}</button>
          ))}
        </div>
        <div className="tt-seg" role="radiogroup" aria-label="Show as">
          <button type="button" role="radio" aria-checked={!shareOn} className={!shareOn ? 'is-on' : ''}
            onClick={() => { setShare(false); persist({ share: false }); }}>Count</button>
          <button type="button" role="radio" aria-checked={shareOn} className={shareOn ? 'is-on' : ''}
            disabled={metric === 'visitors'}
            title={metric === 'visitors' ? 'Pick a later step: visitors as a share of visitors is always 100%' : `${mLabel} as a share of that day's visitors from the same source`}
            onClick={() => { setShare(true); persist({ share: true }); }}>Share of visitors</button>
        </div>
        <div className="tt-seg" role="radiogroup" aria-label="Days shown">
          {RANGES.map(r => (
            <button key={r} type="button" role="radio" aria-checked={range === r} className={range === r ? 'is-on' : ''}
              onClick={() => { setRange(r); persist({ range: r }); }}>{r} days</button>
          ))}
        </div>
      </div>

      <div className="tt-chips" aria-label="Sources">
        {chipSources.map(s => {
          const slot = slots.indexOf(s);
          return (
            <button key={s} type="button" aria-pressed={slot >= 0} title={s}
              className={`tt-chip${slot >= 0 ? ' is-on' : ''}`} onClick={() => toggle(s)}>
              <i className="tt-sw" style={slot >= 0 ? { background: `var(--tt-${slot + 1})`, borderColor: `var(--tt-${slot + 1})` } : undefined} />
              {sourceName(s)}<span className="tt-chip__n">{nf.format(rangeTotal(s))}</span>
            </button>
          );
        })}
        <button type="button" aria-pressed={showTotal} className={`tt-chip tt-chip--total${showTotal ? ' is-on' : ''}`}
          onClick={() => { setShowTotal(!showTotal); persist({ total: !showTotal }); }}>
          <i className="tt-sw tt-sw--total" />All sources<span className="tt-chip__n">{nf.format(chipSources.reduce((a, s) => a + rangeTotal(s), 0))}</span>
        </button>
        <span className="tt-quick">
          <button type="button" className="tt-link" onClick={pickTop}>Top 5</button>
          <button type="button" className="tt-link" onClick={clear}>Clear</button>
        </span>
      </div>
      {full && <p className="tt-note" role="status">Six lines at most: turn one off first.</p>}

      <div className="tt-plot" ref={plotRef} tabIndex={0} onKeyDown={onKey} onBlur={() => setHover(null)}
        aria-label={`${mLabel}${shareOn ? ' as a share of visitors' : ''} per day by source. Arrow keys step through days.`}>
        {width > 0 && (
          <svg className="tt-svg" width={width} height={H} role="img"
            aria-label={`${mLabel}${shareOn ? ' share' : ''} per day, ${picked.map(sourceName).join(', ') || 'no sources picked'}`}>
            <g className="tt-grid">
              {ticks.map(t => (
                <g key={t}>
                  <line x1={ml} x2={ml + pw} y1={y(t)} y2={y(t)} />
                  <text x={ml - 8} y={y(t) + 4} textAnchor="end">{shareOn ? `${t}%` : nf.format(t)}</text>
                </g>
              ))}
            </g>
            <g className="tt-xaxis">
              {days.map((d, i) => {
                const every = days.length > 16 ? 5 : days.length > 8 ? 2 : 1;
                if (i !== last && (last - i) % every !== 0) return null;
                return <text key={d} x={x(i)} y={H - 8} textAnchor="middle">{i === last ? 'Today' : dayLabel(d)}</text>;
              })}
            </g>
            {hover != null && <line className="tt-cross" x1={x(hover)} x2={x(hover)} y1={mt} y2={mt + ph} />}
            {showTotal && (() => {
              const { solid, dashed } = paths(total);
              return <g className="tt-total"><path d={solid} /><path d={dashed} strokeDasharray="2 4" /></g>;
            })()}
            {series.map(s => {
              const { solid, dashed } = paths(s.pts);
              const c = `var(--tt-${s.slot + 1})`;
              return (
                <g key={s.source} className="tt-line" stroke={c}>
                  <path d={solid} />
                  <path d={dashed} strokeDasharray="5 5" />
                  {days.length <= 14 && s.pts.map((p, i) => p.v == null ? null : (
                    <circle key={i} cx={x(i)} cy={y(p.v)} r={hover === i ? 5 : 3.5} fill={c} className="tt-dot" />
                  ))}
                  {days.length > 14 && hover != null && s.pts[hover]?.v != null && (
                    <circle cx={x(hover)} cy={y(s.pts[hover]!.v!)} r={5} fill={c} className="tt-dot" />
                  )}
                </g>
              );
            })}
            {!narrow && ends.map(e => (
              <g key={e.s.source} className="tt-end">
                <circle cx={ml + pw + 12} cy={e.y} r={4} fill={`var(--tt-${e.s.slot + 1})`} />
                <text x={ml + pw + 21} y={e.y + 4}>{sourceName(e.s.source)}</text>
              </g>
            ))}
            <rect className="tt-hit" x={ml - 8} y={mt} width={pw + 16} height={ph}
              onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
          </svg>
        )}
        {hovered != null && (
          <div className="tt-card" style={{ left: Math.max(0, cardLeft) }}>
            <div className="tt-card__day">{dayLong(hovered)}{hover === last ? ' · so far' : ''}</div>
            <div className="tt-card__what">{mLabel}{shareOn ? ', share of visitors' : ''}</div>
            {cardRows.length === 0 ? <div className="tt-card__none">No sources picked</div> : cardRows.map(r => (
              <div key={r.key} className="tt-card__row">
                <i className={`tt-sw${r.slot == null ? ' tt-sw--total' : ''}`}
                  style={r.slot != null ? { background: `var(--tt-${r.slot + 1})`, borderColor: `var(--tt-${r.slot + 1})` } : undefined} />
                <span className="tt-card__name">{r.name}</span>
                <span className="tt-card__v">{fmt(r.p)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="tt-foot">
        <span>
          UTC days, from {dayLabel(firstDay)}, when recording began. Today is dashed: the day is not over.
          {shareOn && ` A share needs ${MIN_FOR_SHARE} or more visitors that day, so quiet days leave a gap.`}
        </span>
        <button type="button" className="tt-link" onClick={() => setAsTable(!asTable)}>
          {asTable ? 'Hide the numbers' : 'Show the numbers'}
        </button>
      </div>
      {asTable && (
        <div className="ao-scroll">
          <table className="ao-table tt-table">
            <thead>
              <tr><th>Day (UTC)</th>{series.map(s => <th key={s.source} className="num">{sourceName(s.source)}</th>)}
                {showTotal && <th className="num">All sources</th>}</tr>
            </thead>
            <tbody>
              {[...days.keys()].reverse().map(i => (
                <tr key={days[i]}>
                  <td>{dayLabel(days[i]!)}{i === last ? ' (so far)' : ''}</td>
                  {series.map(s => <td key={s.source} className="num">{fmt(s.pts[i]!)}</td>)}
                  {showTotal && <td className="num">{fmt(total[i]!)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
