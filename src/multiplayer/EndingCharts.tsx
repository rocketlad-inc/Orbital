// ============================================================================
// EndingCharts — the three "shape of the game" line charts, hand-rolled SVG.
//
// One chart per measure (worlds held, fleet size, treasury), one line per
// empire, every empire on the same axis. The rules it keeps:
//
//   * thin lines (2px; 3px for the viewer and the winner, drawn on top), a
//     recessive grid, a dot on every line's end;
//   * at most three direct end labels, nudged apart so no two touch, and a
//     legend always beneath for the rest;
//   * an empire that fell stops at its elimination tick; on the worlds chart a
//     cross marks the tick;
//   * hover, a tap (which pins) or the arrow keys read every empire's value at
//     a tick in a tooltip; Esc or a tap elsewhere lets go;
//   * "View as table" swaps the picture for the same numbers in a <table>;
//   * laid out in REAL pixels (the svg is measured), so text is 11-12px on a
//     phone as it is on a desktop instead of shrinking with a viewBox;
//   * a short line-draw when the chart scrolls into view, and nothing at all
//     under prefers-reduced-motion.
//
// The geometry and label placement live in endingModel.ts and are tested there.
// ============================================================================

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { EndingFaction, EndingPayload } from './endingTypes';
import {
  ChartGeom, Measure, chartGeom, chartLines, endLabels, linePath,
  maxOfLines, nearestIndex, sampleIndexes,
} from './endingModel';
import { fmtNumber, t } from '../i18n/core';
import { useI18n } from '../i18n/react';

/** Whether this browser may animate: reduced-motion off and an
 *  IntersectionObserver to start the draw when the chart is seen. */
function canAnimate(): boolean {
  try {
    if (typeof IntersectionObserver === 'undefined') return false;
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { return false; }
}

/** Width of an element in CSS pixels, kept current. */
function useWidth(ref: React.RefObject<HTMLElement>, fallback: number): number {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => { const n = Math.round(el.getBoundingClientRect().width); if (n > 0) setW(n); };
    read();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

const compact = (v: number) => fmtNumber(v, { notation: 'compact', maximumFractionDigits: 1 });

/** "The Republic of X" -> "X": the end label has little room. */
const shortName = (name: string) => name.replace(/^(The|Republic of|Empire of) /i, '');

export interface EndingChartProps {
  data: EndingPayload;
  measure: Measure;
  title: string;
  sub: string;
  /** Accessible description of the picture, built by the page (translated). */
  aria: string;
  /** Mark each fall with a cross (the worlds chart). */
  crosses?: boolean;
  height?: number;
  className?: string;
}

export function EndingChart({ data, measure, title, sub, aria, crosses, height = 240, className }: EndingChartProps) {
  useI18n();
  const uid = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const w = useWidth(hostRef, 640);
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [spoken, setSpoken] = useState('');
  const [anim] = useState(canAnimate);
  const [seen, setSeen] = useState(false);

  const lines = useMemo(() => chartLines(data, measure), [data, measure]);
  const { ticks } = data.series;
  const narrow = w < 480;
  const padR = narrow ? 52 : Math.min(112, Math.max(70, Math.round(w * 0.17)));
  const geom = useMemo<ChartGeom>(
    () => chartGeom(w, height, ticks, maxOfLines(lines), { l: narrow ? 38 : 44, r: padR }),
    [w, height, ticks, lines, narrow, padR],
  );
  const labels = useMemo(() => endLabels(lines, geom), [lines, geom]);
  const byId = useMemo(() => new Map(data.factions.map(f => [f.id, f] as const)), [data.factions]);
  const legend = useMemo(() => [...data.factions].sort((a, b) => a.place - b.place), [data.factions]);
  const active = pinned ?? hover;

  // Start the line-draw once, when the chart first comes into view.
  useEffect(() => {
    if (!anim || seen) return;
    const el = hostRef.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, [anim, seen]);

  // A tap anywhere else lets a pinned tick go.
  useEffect(() => {
    if (pinned == null) return;
    const away = (e: PointerEvent) => {
      if (hostRef.current && !hostRef.current.contains(e.target as Node)) setPinned(null);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [pinned]);

  const indexAt = useCallback((e: React.PointerEvent<Element>): number | null => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    return nearestIndex(e.clientX - r.left, geom);
  }, [geom]);

  const speak = (i: number) => {
    const parts = [t('ending.chart.tooltipTick', { n: fmtNumber(ticks[i] ?? 0) })];
    for (const f of rowsAt(i)) parts.push(`${f.faction.name} ${fmtNumber(f.value)}`);
    setSpoken(parts.join(', '));
  };

  /** Every empire's value at index i, biggest first. */
  function rowsAt(i: number) {
    return lines
      .map(l => ({ faction: l.faction, value: i <= l.cut ? (l.values[i] ?? 0) : 0, gone: i > l.cut }))
      .sort((a, b) => b.value - a.value || a.faction.place - b.faction.place);
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = ticks.length;
    if (!n) return;
    const cur = active ?? n - 1;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (e.key === 'ArrowRight') next = Math.min(n - 1, cur + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape' && pinned != null) { setPinned(null); setSpoken(''); e.stopPropagation(); return; }
    if (next == null) return;
    e.preventDefault();
    setPinned(next);
    speak(next);
  };

  const yBase = geom.h - geom.padB;
  const xEnd = geom.w - geom.padR;
  const yTicks = [0, 1, 2, 3, 4].map(k => ({ v: (geom.top * k) / 4, y: geom.y((geom.top * k) / 4) }));
  const xTicks = ticks.length
    ? [ticks[0], Math.round((ticks[0] + ticks[ticks.length - 1]) / 2), ticks[ticks.length - 1]]
    : [];
  const labelChars = Math.max(0, Math.floor((geom.padR - 16) / 6.3));

  const tipRows = active != null ? rowsAt(active) : [];
  const tipOnLeft = active != null && geom.x(active) > geom.w * 0.55;

  const cols = sampleIndexes(ticks.length, narrow ? 4 : 6);
  const hostId = `${uid}-host`;

  const body = table ? (
    <div className="ep-tablewrap">
      <table className="ep-table">
        <caption className="ep-sr">{t('ending.chart.tableCaption', { title })}</caption>
        <thead>
          <tr>
            <th scope="col">{t('ending.col.empire')}</th>
            {cols.map(i => <th scope="col" key={i} className="ep-num">{t('ending.chart.tickShort', { n: fmtNumber(ticks[i]) })}</th>)}
            <th scope="col" className="ep-num">{t('ending.chart.peak')}</th>
          </tr>
        </thead>
        <tbody>
          {legend.map(f => {
            const line = lines.find(l => l.faction.id === f.id);
            return (
              <tr key={f.id} className={f.isMe ? 'is-me' : undefined}>
                <th scope="row">
                  <i className="ep-swatch" style={{ background: f.color }} aria-hidden />
                  {f.name}
                </th>
                {cols.map(i => (
                  <td key={i} className="ep-num">{fmtNumber(line && i <= line.cut ? (line.values[i] ?? 0) : 0)}</td>
                ))}
                <td className="ep-num">{fmtNumber(f.peak[measure])}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  ) : (
    <div
      className="ep-plot"
      tabIndex={0}
      role="group"
      aria-label={`${title}. ${t('ending.chart.hint')}`}
      onKeyDown={onKeyDown}
      onBlur={() => { setHover(null); }}
    >
      <svg
        className="ep-svg"
        width={geom.w}
        height={geom.h}
        viewBox={`0 0 ${geom.w} ${geom.h}`}
        role="img"
        aria-label={aria}
        onPointerMove={e => {
          const i = indexAt(e);
          if (i == null) return;
          if (e.pointerType === 'mouse') { if (pinned == null) setHover(i); }
          else if (e.buttons) setPinned(i);
        }}
        onPointerLeave={e => { if (e.pointerType === 'mouse') setHover(null); }}
        onPointerDown={e => {
          const i = indexAt(e);
          if (i == null) return;
          setPinned(p => (p === i ? null : i));
        }}
      >
        {yTicks.map(tk => (
          <g key={tk.v}>
            <line className="ep-grid" x1={geom.padL} x2={xEnd} y1={tk.y} y2={tk.y} />
            <text className="ep-axis" x={geom.padL - 8} y={tk.y + 4} textAnchor="end">{compact(tk.v)}</text>
          </g>
        ))}
        {xTicks.map((tick, i) => (
          <text
            key={i}
            className="ep-axis"
            x={geom.xOfTick(tick)}
            y={geom.h - 8}
            textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
          >{i === 0 ? t('ending.chart.axisStart', { n: fmtNumber(tick) }) : fmtNumber(tick)}</text>
        ))}

        <g className={anim ? (seen ? 'ep-lines is-drawn' : 'ep-lines is-pre') : 'ep-lines'}>
          {lines.map((l, k) => (
            <path
              key={l.faction.id}
              className="ep-line"
              pathLength={1}
              d={linePath(l, geom)}
              stroke={l.faction.color}
              strokeWidth={l.emphasis ? 3 : 2}
              opacity={l.emphasis ? 1 : 0.85}
              style={{ ['--i' as string]: k }}
              fill="none"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {lines.map(l => {
            const fell = l.faction.finalStatus === 'eliminated';
            if (crosses && fell && l.faction.eliminatedAtTick != null) return null;
            const i = l.cut;
            return (
              <circle
                key={l.faction.id}
                className="ep-dot"
                cx={geom.x(i)}
                cy={geom.y(l.values[i] ?? 0)}
                r={l.emphasis ? 4 : 3}
                fill={l.faction.color}
              />
            );
          })}
          {crosses && lines.map(l => {
            const f = l.faction;
            if (f.finalStatus !== 'eliminated' || f.eliminatedAtTick == null) return null;
            const cx = Math.min(xEnd, Math.max(geom.padL, geom.xOfTick(f.eliminatedAtTick)));
            const cy = yBase - 8;
            return (
              <g key={f.id} className="ep-cross" stroke={f.color} strokeWidth={2} strokeLinecap="round">
                <title>{t('ending.chart.fell', { name: f.name, n: fmtNumber(f.eliminatedAtTick) })}</title>
                <line x1={cx - 4} y1={cy - 4} x2={cx + 4} y2={cy + 4} />
                <line x1={cx - 4} y1={cy + 4} x2={cx + 4} y2={cy - 4} />
              </g>
            );
          })}
        </g>

        {labels.map(l => {
          const f = byId.get(l.factionId) as EndingFaction;
          const text = narrow || labelChars < 6
            ? compact(l.value)
            : `${clip(shortName(f.name), labelChars - compact(l.value).length - 1)} ${compact(l.value)}`;
          return (
            <text key={l.factionId} className="ep-endlabel" x={l.x + 10} y={l.ty} fill={f.color}>{text}</text>
          );
        })}

        {active != null && (
          <g className="ep-cursor" pointerEvents="none">
            <line x1={geom.x(active)} x2={geom.x(active)} y1={geom.padT} y2={yBase} />
            {lines.map(l => active <= l.cut ? (
              <circle key={l.faction.id} cx={geom.x(active)} cy={geom.y(l.values[active] ?? 0)} r={l.emphasis ? 4 : 3} fill={l.faction.color} stroke="#0d141d" strokeWidth={1.5} />
            ) : null)}
          </g>
        )}
      </svg>

      {active != null && (
        <div
          className={`ep-tip${tipOnLeft ? ' is-left' : ''}`}
          style={{ left: geom.x(active) }}
          role="presentation"
        >
          <div className="ep-tip__head">{t('ending.chart.tooltipTick', { n: fmtNumber(ticks[active] ?? 0) })}</div>
          {tipRows.map(r => (
            <div key={r.faction.id} className={`ep-tip__row${r.gone ? ' is-gone' : ''}${r.faction.isMe ? ' is-me' : ''}`}>
              <i className="ep-swatch" style={{ background: r.faction.color }} aria-hidden />
              <span className="ep-tip__name">{r.faction.name}</span>
              <span className="ep-num">{fmtNumber(r.value)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="ep-sr" role="status" aria-live="polite">{spoken}</div>
    </div>
  );

  return (
    <section className={`ep-panel ep-chart${className ? ` ${className}` : ''}`} aria-labelledby={`${uid}-h`}>
      <div className="ep-chart__head">
        <div className="ep-chart__titles">
          <h3 id={`${uid}-h`}>{title}</h3>
          <div className="ep-sub">{sub}</div>
        </div>
        <button
          type="button"
          className="ep-link"
          aria-pressed={table}
          aria-controls={hostId}
          onClick={() => { setTable(v => !v); setPinned(null); setHover(null); }}
        >{table ? t('ending.chart.viewChart') : t('ending.chart.viewTable')}</button>
      </div>
      <div ref={hostRef} id={hostId} className="ep-chart__host">{body}</div>
      <ul className="ep-legend" aria-label={t('ending.chart.legend')}>
        {legend.map(f => (
          <li key={f.id}>
            <i style={{ background: f.color }} aria-hidden />
            <span>{f.name}{f.isMe ? ` ${t('mp.provider.you')}` : ''}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function clip(s: string, max: number): string {
  if (max < 2) return '';
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

