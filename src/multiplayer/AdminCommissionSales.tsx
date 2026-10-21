// ============================================================
// AdminCommissionSales — the Commission as a business (admin).
//
//   figures   sold, gross revenue, last 30 days against the 30 before,
//             median account age and hours played at purchase, how many
//             started checkouts became a sale
//   over time a running total, every sale a dot (hover for the buyer)
//   who buys  account age and hours played at the moment of buying
//   by hours  of everyone at each level of play, the share who hold it
//   each sale where it started, the buyer, still playing, using the goods
//
// Paid sales only: Stripe purchases and gift codes bought. Admin comps
// are left out of every number. Data: GET /api/admin/commission/sales.
// ============================================================

import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { apiFetch } from './api';
import './AdminCommissionSales.css';

const DAY = 86_400_000;

type Sale = {
  at: number; surface: string; name: string; age_ms: number; minutes_before: number;
  games_before: number; signup_source: string; active_7d: boolean; uses_goods: boolean;
};
type SalesData = {
  now: number;
  price_usd: number;
  sales: Sale[];
  gifts: Array<{ at: number; redeemed: boolean; voided: boolean }>;
  paid_30: number; paid_prev_30: number;
  checkouts_30: number; checkouts_prev_30: number;
  refunds: Array<{ at: number; kind: string }>;
  bands: Array<{ band: string; players: number; holders: number }>;
};

const nf = new Intl.NumberFormat();
const n = (v: number) => nf.format(v);
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const ageText = (ms: number) => {
  const d = ms / DAY;
  if (d < 1) return 'same day';
  return `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`;
};
const hoursText = (min: number) => (min < 60 ? `${Math.round(min)} min` : `${n(Math.round(min / 60))} h`);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const AGE_BUCKETS: Array<[string, number, number]> = [
  ['Same day', 0, 1], ['1–3 days', 1, 4], ['4–7 days', 4, 8], ['8–14 days', 8, 15],
  ['15–30 days', 15, 31], ['1–3 months', 31, 91], ['3 months +', 91, Infinity],
];
const HOUR_BUCKETS: Array<[string, number, number]> = [
  ['Under 1 h', 0, 1], ['1–10 h', 1, 10], ['10–25 h', 10, 25], ['25–50 h', 25, 50],
  ['50–100 h', 50, 100], ['100 h +', 100, Infinity],
];
const BAND_LABEL: Record<string, string> = {
  a: 'Under 3 h', b: '3–10 h', c: '10–20 h', d: '20–50 h', e: '50 h +',
};

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

function Stat({ label, value, foot }: { label: string; value: React.ReactNode; foot?: React.ReactNode }) {
  return (
    <div className="cs-stat">
      <span className="cs-stat__label">{label}</span>
      <span className="cs-stat__value">{value}</span>
      {foot && <span className="cs-stat__foot">{foot}</span>}
    </div>
  );
}

/** A running total of sales, one dot per sale. */
function RunningTotal({ points, now }: { points: Array<{ at: number; gift: boolean; tip: string }>; now: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(300, width), H = 220, L = 34, R = 14, T = 16, B = 26;
  if (!points.length) return <div ref={ref} className="ao-none">No sales yet.</div>;
  const start = Math.min(points[0].at, now - 30 * DAY) - DAY;
  const end = now;
  const top = Math.max(2, points.length);
  const x = (t: number) => L + ((t - start) / (end - start)) * (W - L - R);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  let d = `M${x(start).toFixed(1)},${y(0).toFixed(1)}`;
  points.forEach((p, i) => { d += ` H${x(p.at).toFixed(1)} V${y(i + 1).toFixed(1)}`; });
  d += ` H${x(end).toFixed(1)}`;
  const ticks = top <= 6 ? Array.from({ length: top + 1 }, (_, i) => i) : [0, Math.round(top / 2), top];
  // Month starts along the bottom, so the line can be read against dates.
  const months: number[] = [];
  const m0 = new Date(start); m0.setUTCDate(1); m0.setUTCHours(0, 0, 0, 0);
  for (let t = Date.UTC(m0.getUTCFullYear(), m0.getUTCMonth() + 1, 1); t < end; ) {
    months.push(t);
    const dt = new Date(t);
    t = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1);
  }
  return (
    <div ref={ref} className="cs-plot">
      {width > 0 && (
        <svg viewBox={`0 0 ${W} ${H}`} className="cs-svg" role="img" aria-label={`${points.length} Commissions sold to date`}>
          {ticks.map(t => (
            <g key={t}>
              <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 ? 'cs-axis' : 'cs-grid'} />
              <text x={L - 8} y={y(t) + 4} textAnchor="end" className="cs-tick">{t}</text>
            </g>
          ))}
          {months.map(t => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={T} y2={H - B} className="cs-grid" />
              <text x={x(t) + 4} y={H - 8} className="cs-tick">{new Date(t).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })}</text>
            </g>
          ))}
          <path d={d} className="cs-line" />
          {points.map((p, i) => (
            <circle key={i} cx={x(p.at)} cy={y(i + 1)} r={4.5} className={p.gift ? 'cs-dot cs-dot--gift' : 'cs-dot'}>
              <title>{p.tip}</title>
            </circle>
          ))}
        </svg>
      )}
    </div>
  );
}

/** Small horizontal bars: a count per bucket, the busiest one in gold. */
function Buckets({ rows, unit, scale }: {
  rows: Array<{ label: string; n: number; detail?: string }>;
  unit: (v: number) => string;
  /** A fixed top for the bars (100 for percentages); else the largest row. */
  scale?: number;
}) {
  const top = Math.max(...rows.map(r => r.n));
  const max = scale ?? Math.max(1, top);
  return (
    <div className="cs-bars">
      {rows.map(r => (
        <div key={r.label} className="cs-bar">
          <span className="cs-bar__label">{r.label}</span>
          <span className="cs-bar__track">
            <span className={`cs-bar__fill${r.n === top && r.n > 0 ? ' is-top' : ''}`} style={{ width: `${(r.n / max) * 100}%` }} />
          </span>
          <span className="cs-bar__value">{r.n ? unit(r.n) : <span className="ao-dim">—</span>}{r.detail ? <span className="ao-dim"> {r.detail}</span> : null}</span>
        </div>
      ))}
    </div>
  );
}

export function CommissionSales({ surfaceLabel }: { surfaceLabel: Record<string, string> }) {
  const [data, setData] = useState<SalesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void apiFetch<SalesData>('/api/admin/commission/sales').then(res => {
      if (res.ok) setData(res.data); else setError(res.error?.message ?? 'Could not load sales');
    });
  }, []);

  const derived = useMemo(() => {
    if (!data) return null;
    const giftsSold = data.gifts.filter(g => !g.voided);
    const sold = data.sales.length + giftsSold.length;
    const points = [
      ...data.sales.map(s => ({ at: s.at, gift: false, tip: `${day(s.at)}: ${s.name} · ${surfaceLabel[s.surface] ?? s.surface} · ${ageText(s.age_ms)} in, ${hoursText(s.minutes_before)} played` })),
      ...giftsSold.map(g => ({ at: g.at, gift: true, tip: `${day(g.at)}: a gift Commission${g.redeemed ? ', redeemed' : ', not yet redeemed'}` })),
    ].sort((a, b) => a.at - b.at);
    const ages = data.sales.map(s => s.age_ms / DAY);
    const hours = data.sales.map(s => s.minutes_before / 60);
    const byAge = AGE_BUCKETS.map(([label, lo, hi]) => ({ label, n: ages.filter(a => a >= lo && a < hi).length }));
    const byHours = HOUR_BUCKETS.map(([label, lo, hi]) => ({ label, n: hours.filter(h => h >= lo && h < hi).length }));
    const bands = data.bands.map(b => ({
      label: BAND_LABEL[b.band] ?? b.band,
      n: b.players ? Math.round((b.holders / b.players) * 100) : 0,
      detail: `(${b.holders} of ${b.players})`,
    }));
    return {
      sold, giftsSold: giftsSold.length, points, byAge, byHours, bands,
      medAge: median(ages), medHours: median(hours),
      active: data.sales.filter(s => s.active_7d).length,
      using: data.sales.filter(s => s.uses_goods).length,
    };
  }, [data, surfaceLabel]);

  if (error) return <section className="ao-panel"><div className="ao-none">{error}</div></section>;
  if (!data || !derived) return <section className="ao-panel"><div className="ao-none">Loading sales…</div></section>;

  const change = data.paid_prev_30
    ? `${data.paid_30 >= data.paid_prev_30 ? '▲' : '▼'} ${Math.abs(Math.round(((data.paid_30 - data.paid_prev_30) / data.paid_prev_30) * 100))}% vs the 30 days before`
    : data.paid_30 ? 'none the 30 days before' : 'none in 60 days';
  const recentFirst = data.sales.slice().reverse();

  return (
    <section className="ao-panel cs">
      <div className="ao-phead">
        <div>
          <h3 className="ao-phead__title">Sales</h3>
          <p className="ao-phead__hint">
            Paid Commissions: bought through Stripe, and gift codes bought for someone else. Admin comps are left out.
            Hours played count whole days, including the day of the purchase.
          </p>
        </div>
      </div>

      <div className="cs-stats">
        <Stat label="Sold to date" value={n(derived.sold)} foot={derived.giftsSold ? `${n(derived.giftsSold)} as gifts` : 'no gifts yet'} />
        <Stat label="Gross revenue" value={`$${n(derived.sold * data.price_usd)}`} foot={`at $${data.price_usd} each, before Stripe fees`} />
        <Stat label="Last 30 days" value={n(data.paid_30)} foot={change} />
        <Stat label="Account age at purchase" value={derived.medAge == null ? '—' : ageText(derived.medAge * DAY)} foot="median, from signing up" />
        <Stat label="Hours played at purchase" value={derived.medHours == null ? '—' : hoursText(derived.medHours * 60)} foot="median" />
        <Stat
          label="Checkouts that paid · 30 days"
          value={data.checkouts_30 ? `${Math.round((data.paid_30 / data.checkouts_30) * 100)}%` : '—'}
          foot={`${n(data.paid_30)} of ${n(data.checkouts_30)} started`}
        />
      </div>

      <h4 className="cs-h">Sold over time</h4>
      <RunningTotal points={derived.points} now={data.now} />
      <p className="cs-note">
        Each dot is a sale; hover one for the buyer and where it started.
        {data.refunds.length ? ` ${n(data.refunds.length)} refunded (taken out of the total).` : ' No refunds recorded (refunds are logged from Oct 20 on).'}
      </p>

      <div className="cs-two">
        <div>
          <h4 className="cs-h">How long after signing up</h4>
          <Buckets rows={derived.byAge} unit={v => n(v)} />
        </div>
        <div>
          <h4 className="cs-h">Hours played before buying</h4>
          <Buckets rows={derived.byHours} unit={v => n(v)} />
        </div>
      </div>

      <h4 className="cs-h">Who holds it, by hours played</h4>
      <p className="cs-note">Of everyone who has played, the share at each level who hold a paid Commission.</p>
      <Buckets rows={derived.bands} unit={v => `${v}%`} scale={100} />

      <h4 className="cs-h">Every sale</h4>
      <p className="cs-note">
        {n(derived.active)} of {n(data.sales.length)} buyers played in the last 7 days; {n(derived.using)} use what they bought
        (a Commission ship line, emblem or colony style).
      </p>
      <div className="ao-scroll">
        <table className="ao-table">
          <thead>
            <tr>
              <th>Sold</th><th>Buyer</th><th>Started from</th>
              <th className="num">Account age</th><th className="num">Played</th><th className="num">Games joined</th>
              <th>Came from</th><th>Playing now</th><th>Uses the goods</th>
            </tr>
          </thead>
          <tbody>
            {recentFirst.map((s, i) => (
              <tr key={`${s.at}-${i}`}>
                <td>{day(s.at)}</td>
                <td>{s.name}</td>
                <td>{surfaceLabel[s.surface] ?? s.surface}</td>
                <td className="num">{ageText(s.age_ms)}</td>
                <td className="num">{hoursText(s.minutes_before)}</td>
                <td className="num">{n(s.games_before)}</td>
                <td>{s.signup_source}</td>
                <td>{s.active_7d ? 'Yes' : <span className="ao-dim">No</span>}</td>
                <td>{s.uses_goods ? 'Yes' : <span className="ao-dim">Not yet</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
